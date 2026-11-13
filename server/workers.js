import { safeDeliver } from './sessions.js';
import { prRepository } from './pr-labels.js';
import { availableSessionHref } from './session-links.js';
import { OPEN_REVIEW_STATES } from './review-state.js';
import { holdsBead } from './bead-sessions.js';
import { assertCurrent } from './lifetime.js';
import { newId } from './metadata-store.js';
import { actorFor, descendantIds, GROUP_KINDS } from './bead-model.js';
import { COORDINATING_ROLES, requireBeadAccess, requireCoordinator, resolveCaller } from './access.js';
import { HiveError, ensureWritable, text, withLock, claimBead, bindIfMissing } from './ops.js';
import { applyLaunchPolicy, launchRestriction } from './launch-policy.js';
import { ADMISSION_LOCK, capacity, checkAdmission, RESERVED_LAUNCH_STATES } from './admission.js';

const inFlight = new Set();
const RETIRED_LAUNCH_STATES = new Set(['archived', 'cancelled', 'abandoned', 'refused', 'review-ended']);

function launchOptions(input) {
  const out = { intent: text(input.intent, 'intent', 20000, { required: true }) };
  for (const field of ['cwd', 'agent', 'model', 'effort']) {
    const value = text(input[field], field, 2000);
    if (value) out[field] = value;
  }
  if (input.worktree !== undefined) {
    const value = input.worktree;
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((k) => !['branch', 'folderName', 'auto', 'base'].includes(k)) || ['branch', 'folderName', 'base'].some((k) => value[k] !== undefined && typeof value[k] !== 'string') || (value.auto !== undefined && typeof value.auto !== 'boolean')) throw new HiveError('worktree must be an object with branch, folderName, auto or base.');
    out.worktree = value;
  }
  if (input.auto_compact_tokens !== undefined) {
    if (!Number.isSafeInteger(input.auto_compact_tokens) || input.auto_compact_tokens <= 0) throw new HiveError('auto_compact_tokens must be a positive whole number.');
    out.autoCompactTokens = input.auto_compact_tokens;
  }
  return out;
}

export function coordinator(rt, host, actor, { attach = false, beadId = null } = {}) {
  assertCurrent(rt, host);
  const fresh = resolveCaller(rt, host, actor.sessionId, actor.cell.id);
  if (attach && beadId && !COORDINATING_ROLES.has(fresh.role) && holdsBead(rt, host, fresh.sessionId, beadId)) {
    ensureWritable(rt);
    return fresh;
  }
  requireCoordinator(fresh, attach ? 'attach a session to work it does not hold' : 'launch or reconcile workers');
  ensureWritable(rt);
  return fresh;
}

function reviewForLaunch(rt, launch, { sid, initial = false } = {}) {
  if (!launch.reviewId) return null;
  const r = rt.metadata.read().reviews[launch.reviewId];
  if (!r || r.id !== launch.reviewId || r.cellId !== launch.cellId || r.workBeadId !== launch.beadId || !OPEN_REVIEW_STATES.has(r.state)
    || (launch.id && r.launchId !== launch.id) || (!launch.id && r.reviewerSessionId)
    || (launch.id && initial && r.reviewerSessionId && r.reviewerSessionId !== sid)
    || (launch.id && !initial && (r.reviewerSessionId !== sid || r.state !== 'in_review'))) {
    throw new HiveError('This reviewer launch was cancelled, archived or replaced.', 'conflict');
  }
  return r;
}

function gateAuthority(rt, host, launchId, { sid, task, ext, initial }, expected = null) {
  assertCurrent(rt, host);
  const launch = rt.metadata.read().workerLaunches[launchId];
  const allowed = initial ? ['reserved', 'binding'] : ['binding', 'claimed', 'launched', 'archived', 'uncertain'];
  if (!launch || !allowed.includes(launch.state) || (launch.sessionId && launch.sessionId !== sid)) throw new HiveError('This worker launch is missing, abandoned, stale or belongs to a different session.');
  if (expected && ['id', 'cellId', 'taskId', 'beadId', 'requestedBy', 'role', 'reviewId'].some((key) => launch[key] !== expected[key])) throw new HiveError('The worker launch identity changed before startup.');
  if (task?.id !== launch.taskId || (ext?.beadId && ext.beadId !== launch.beadId)) throw new HiveError('This worker launch has a different task or bead.');
  if (host.sessions.get(sid)?.archived) throw new HiveError('Restore this archived worker before launching it.');
  const requester = initial ? coordinator(rt, host, { sessionId: launch.requestedBy, cell: { id: launch.cellId } }, { attach: launch.role !== 'worker', beadId: launch.beadId }) : resolveCaller(rt, host, sid, launch.cellId);
  ensureWritable(rt);
  reviewForLaunch(rt, launch, { sid, initial });
  return { launch, requester };
}

function heldOpenBead(rt, graph, sid, launch) {
  const mine = `aw:${sid}`;
  const launchBead = graph.beads[launch.beadId];
  if (launchBead && launchBead.status !== 'closed' && (!launchBead.assignee || launchBead.assignee === mine)) return null;
  const cell = rt.metadata.cell(launch.cellId);
  if (!cell?.rootBeadId) return null;
  const inCell = descendantIds(graph.beads, cell.rootBeadId);
  const held = [...inCell].filter((id) => id !== cell.rootBeadId && graph.beads[id]?.assignee === mine && graph.beads[id].status !== 'closed' && !GROUP_KINDS.has(graph.beads[id].kind)).sort();
  const bound = new Set((rt.metadata.read().bindings?.[launch.cellId] || []).filter((x) => x.active && x.sessionId === sid).map((x) => x.beadId));
  return held.find((id) => bound.has(id)) || held[0] || null;
}

function requireLaunchScope(actor, graph, beadId) {
  if (!descendantIds(graph.beads, actor.cell.rootBeadId).has(beadId) || beadId === actor.cell.rootBeadId) throw new HiveError('The worker bead moved outside this cell.', 'conflict');
}

function recordLaunchFailure(rt, launchId, error, dispatched = true) {
  return rt.metadata.mutate((d) => {
    const launch = d.workerLaunches[launchId];
    if (!launch) return null;
    const review = launch.reviewId && d.reviews[launch.reviewId];
    if (!RETIRED_LAUNCH_STATES.has(launch.state)) {
      if (review && !OPEN_REVIEW_STATES.has(review.state)) launch.state = review.state === 'cancelled' ? 'cancelled' : 'review-ended';
      else launch.state = dispatched ? 'uncertain' : 'refused';
    }
    launch.error = String(error.message).slice(0, 1000);
    launch.updatedAt = Date.now();
    return launch.state;
  });
}

export function workerBeforeDispatch({ sessionId, ext, host }) {
  if (!ext?.workerLaunchId) return false;
  const rt = host.stores.hive;
  (rt.workerDispatches ||= new Map()).set(sessionId, ext.workerLaunchId);
  rt.metadata.mutate((d) => {
    const l = d.workerLaunches[ext.workerLaunchId];
    if (!l || l.state !== 'reserved' || (l.sessionId && l.sessionId !== sessionId)) return;
    l.sessionId = sessionId;
    l.state = 'binding';
    l.updatedAt = Date.now();
  });
  return true;
}

async function notifyClosedBeadWake(rt, host, launchId, sid, beadId) {
  assertCurrent(rt, host);
  const launch = rt.metadata.read().workerLaunches[launchId];
  const cell = rt.metadata.cell(launch.cellId);
  const queen = cell?.queenSessionId;
  if (!cell?.enabled || cell.snapshot || !queen || queen === sid || !host.sessions.get(queen) || host.sessions.get(queen).archived) return;
  const urls = [...new Set((host.links?.get?.(sid) || []).filter(link => link.type === 'pr' && prRepository(link.url)).map(link => link.url))].sort();
  if (!urls.length) return;
  const key = JSON.stringify([queen, cell.queenGeneration || 0, beadId, urls]);
  if (launch.closedBeadWakeNotices?.[key]) return;
  rt.metadata.mutate(d => {
    const rec = d.workerLaunches[launchId];
    (rec.closedBeadWakeNotices ||= {})[key] = { state: 'sending', at: Date.now() };
  });
  const href = availableSessionHref(host, sid);
  const result = await safeDeliver(host, queen, `[Hive] Refused wake for session ${sid}: bead ${beadId} is closed. Linked PRs: ${urls.join(', ')}. Relink the PR to its current owner or remove the stale session link. ${href ? `[Open session](${href})` : ''}`, rt);
  assertCurrent(rt, host);
  rt.metadata.mutate(d => { Object.assign(d.workerLaunches[launchId].closedBeadWakeNotices[key], result, { finishedAt: Date.now() }); });
}

export async function workerLaunchContext({ sid, task, ext, reason, host }) {
  if (['assign', 'adopt'].includes(reason)) return;
  const rt = host?.stores?.hive;
  const doc = rt?.metadata.read();
  const launchId = ext?.workerLaunchId || rt?.workerDispatches?.get(sid)
    || Object.values(doc?.workerLaunches || {}).find((l) => l.sessionId === sid)?.id
    || Object.values(doc?.bindings || {}).flat().find((b) => b.sessionId === sid && b.workerLaunchId)?.workerLaunchId;
  if (!launchId) return;
  return withLock(`worker-launch:${launchId}`, async () => {
    let reserved = false;
    let held = null;
    let target = null;
    let closedTarget = false;
    try {
      if (!rt) throw new HiveError('Hive is unavailable for this worker launch.');
      const initial = ['dispatch', 'spawn'].includes(reason);
      let actor;
      let launch;
      await withLock(ADMISSION_LOCK, async () => {
        const context = { sid, task, ext, initial };
        let current = gateAuthority(rt, host, launchId, context);
        await rt.snapshots.refresh();
        if (rt.snapshots.current.error) throw new HiveError('Current worker ownership could not be read.');
        current = gateAuthority(rt, host, launchId, context, current.launch);
        const graph = await rt.beads.loadSnapshot({ all: true });
        current = gateAuthority(rt, host, launchId, context, current.launch);
        const { launch: l, requester } = current;
        held = initial || l.role !== 'worker' ? null : heldOpenBead(rt, graph, sid, l);
        target = held || l.beadId;
        closedTarget = !initial && graph.beads[target]?.status === 'closed';
        try {
          const access = requireBeadAccess(rt, requester, target);
          if (access.cell.id !== l.cellId) throw new HiveError('The worker bead moved to another cell.');
          requireLaunchScope(requester, graph, target);
          checkAdmission(rt, graph, target, { sessionId: sid, launchId, review: l.role !== 'worker' });
        } catch (err) {
          if (held) throw new HiveError(`${String(err.message).replace(/\.?$/, ".")} This worker holds an open claim on ${held}; the queen should release it or hand it over.`, err.code);
          throw err;
        }
        actor = { ...requester, sessionId: sid, role: 'worker', cells: [{ cell: requester.cell, role: 'worker' }] };
        launch = l;
        rt.metadata.mutate((d) => {
          const rec = d.workerLaunches[launchId];
          Object.assign(rec, { sessionId: sid, state: 'binding', claimStarted: true, updatedAt: Date.now() });
        });
        reserved = true;
      });
      if (launch.role === 'worker') await claimBead(rt, actor, { bead_id: target }, { launchId: held ? null : launchId, validate: (context) => {
        if (initial) coordinator(rt, host, { sessionId: launch.requestedBy, cell: { id: launch.cellId } }, { attach: launch.role !== 'worker', beadId: launch.beadId });
        else resolveCaller(rt, host, sid, launch.cellId);
        if (host.sessions.get(sid)?.archived) throw new HiveError('The worker was archived before claiming.');
        if (held) {
          const fresh = context?.issues?.find((i) => i.id === held);
          if (!fresh || fresh.status === 'closed' || fresh.assignee !== `aw:${sid}`) throw new HiveError(`Bead ${held} is no longer held by this worker.`, 'conflict');
        }
      } });
      gateAuthority(rt, host, launchId, { sid, task, ext, initial }, launch);
      rt.metadata.mutate((d) => {
        const rec = d.workerLaunches[launchId];
        if (rec.state !== 'binding' || rec.sessionId !== sid || host.sessions.get(sid)?.archived) throw new HiveError('The worker launch was archived or changed before startup.');
        if (launch.reviewId) {
          const r = d.reviews[launch.reviewId];
          if (!r || !OPEN_REVIEW_STATES.has(r.state) || r.launchId !== launchId || (!initial && r.reviewerSessionId !== sid)) throw new HiveError('The review ended or its reviewer changed before startup.');
          Object.assign(r, { state: 'in_review', reviewerSessionId: sid, startedAt: r.startedAt || Date.now(), updatedAt: Date.now(), waitingFor: '' });
        }
        const list = d.bindings[launch.cellId] || (d.bindings[launch.cellId] = []);
        const binding = list.find((b) => b.active && b.sessionId === sid && b.beadId === target);
        if (binding) Object.assign(binding, { role: launch.role, workerLaunchId: launchId, ...(launch.reviewId ? { reviewId: launch.reviewId } : {}) });
        else list.push({ id: newId('bind'), sessionId: sid, beadId: target, role: launch.role, workerLaunchId: launchId, ...(launch.reviewId ? { reviewId: launch.reviewId } : {}), boundBy: actorFor(launch.requestedBy), active: true, at: Date.now() });
        rec.state = initial ? 'claimed' : 'launched';
        rec.updatedAt = Date.now();
      });
      rt.changed();
    } catch (err) {
      if (reserved) {
        try { recordLaunchFailure(rt, launchId, err); }
        catch (recordError) { rt.log(`hive: could not record refused relaunch: ${recordError.message}`); }
      }
      if (closedTarget) {
        try { await notifyClosedBeadWake(rt, host, launchId, sid, target); }
        catch (noticeError) { rt.log(`hive: could not notify queen of refused wake: ${noticeError.message}`); }
      }
      return { refuse: `Hive refused worker startup: ${err.message}` };
    }
  });
}

export async function spawnWorker(rt, host, actor, input, { reviewId = null, role = reviewId ? 'reviewer' : 'worker' } = {}) {
  if (role === 'investigator') throw new HiveError('A helper needs its own bead: create an investigation bead and launch it with hive_spawn_worker (role work). Helpers cannot share a builder\'s bead or slot.', 'refused');
  const opts = launchOptions(input);
  const launchId = newId('worker');
  const as = { attach: role !== 'worker', beadId: input.bead_id };
  const attach = role !== 'worker';
  await withLock(ADMISSION_LOCK, async () => {
    if (attach) await rt.snapshots.refresh();
    actor = coordinator(rt, host, actor, as);
    await rt.snapshots.refresh();
    if (rt.snapshots.current.error) throw new HiveError('Cannot confirm current bead ownership or capacity.', 'refused');
    const graph = await rt.beads.loadSnapshot({ all: true });
    actor = coordinator(rt, host, actor, as);
    const { bead, cell } = requireBeadAccess(rt, actor, input.bead_id);
    if (cell.id !== actor.cell.id || bead.id === cell.rootBeadId) throw new HiveError('Launch a worker for a bead in this cell, below its goal.');
    requireLaunchScope(actor, graph, bead.id);
    reviewForLaunch(rt, { reviewId, beadId: bead.id, cellId: cell.id });
    checkAdmission(rt, graph, bead.id, { sessionId: null, review: attach });
    rt.metadata.mutate((d) => {
      d.workerLaunches[launchId] = { id: launchId, cellId: cell.id, taskId: cell.taskId, beadId: bead.id, requestedBy: actor.sessionId, role, reviewId, sessionId: null, state: 'reserved', restriction: launchRestriction(opts.agent), createdAt: Date.now(), updatedAt: Date.now() };
      if (reviewId) d.reviews[reviewId].launchId = launchId;
    });
  });
  rt.changed();
  inFlight.add(launchId);
  let dispatched = false;
  try {
    const l = rt.metadata.read().workerLaunches[launchId];
    actor = coordinator(rt, host, actor, as);
    if (l.state !== 'reserved') throw new HiveError('This launch was cancelled or changed before dispatch.', 'conflict');
    reviewForLaunch(rt, l, { initial: true });
    const baseIntent = l.reviewId ? `You are the reviewer of Hive bead ${l.beadId} in cell ${l.cellId}; its builder keeps the claim. Your reviewer binding is made before your first action. Report to session ${l.requestedBy} by Agent Wrangler mail.\n\n${opts.intent}` : `You own Hive bead ${l.beadId} in cell ${l.cellId}. Its claim and binding are made before your first action. Use hive_context and the hive-worker skill. Report to queen/coordinator session ${l.requestedBy} by Agent Wrangler mail.\n\n${opts.intent}`;
    const delegation = launchRestriction(opts.agent) === 'denied' ? 'Delegate only through Hive: spawn_session, spawn_workflow, schedule_session and update_schedule are denied to you; use hive_spawn_worker where your role allows it, or ask the queen. ' : 'Delegate only through Hive (hive_spawn_worker where your role allows it, or ask the queen); do not use spawn_session, spawn_workflow or schedule_session, which Hive cannot restrict for this provider and which leave the session untracked. ';
    const intent = `${baseIntent}\n\nUse the hive-worker skill. Start with hive_context({ scope: "bead", bead_id: "${l.beadId}", cell_id: "${l.cellId}" }) for your bounded work context.\n\nHive task: ${l.taskId}. When the human must act in a specific session, pass its full session_id and optional session_label to hive_request_input or hive_publish for a one-click board link. For decisions or actions use Hive's input tool hive_request_input; do not also call request_human_input. Worker/reviewer requests go to this hive's queen and remain out of human views until forwarded; human step-in is not supported. Recover with hive_list_my_requests and withdraw with hive_withdraw_request when answered elsewhere. ${delegation}Launch helpers into this same resolved task; ancestry alone does not enroll them. Missing native tools require a membership check or refreshed agent terminal.`;
    dispatched = true;
    assertCurrent(rt, host);
    const result = await host.sessions.spawn(applyLaunchPolicy({ ...opts, intent, parentSession: actor.sessionId, taskId: l.taskId, ext: { hive: { workerLaunchId: launchId, beadId: l.beadId, ...(l.reviewId ? { reviewId: l.reviewId } : {}) } } }));
    const rec = rt.metadata.read().workerLaunches[launchId];
    if (['archived', 'cancelled'].includes(rec.state) && rec.sessionId === result?.sessionId) return { launch_id: launchId, bead_id: l.beadId, session_id: result.sessionId, state: rec.state, capacity: capacity(rt) };
    if (!['claimed', 'launched'].includes(rec.state) || rec.sessionId !== result?.sessionId) throw new HiveError('Worker startup returned without a confirmed launch claim.');
    await rt.snapshots.refresh();
    rt.metadata.mutate((d) => {
      const current = d.workerLaunches[launchId];
      if (['archived', 'cancelled'].includes(current.state) && current.sessionId === result?.sessionId) return;
      if (!['claimed', 'launched'].includes(current.state) || current.sessionId !== result?.sessionId) throw new HiveError('The worker launch changed before confirmation.');
      current.state = 'launched'; current.updatedAt = Date.now();
    });
    if (['archived', 'cancelled'].includes(rt.metadata.read().workerLaunches[launchId].state)) return { launch_id: launchId, bead_id: l.beadId, session_id: result.sessionId, state: rt.metadata.read().workerLaunches[launchId].state, capacity: capacity(rt) };
    rt.changed();
    return { launch_id: launchId, bead_id: l.beadId, session_id: result.sessionId, capacity: capacity(rt) };
  } catch (err) {
    let state;
    try { state = recordLaunchFailure(rt, launchId, err, dispatched); }
    catch (recordError) { rt.log(`hive: could not record worker launch failure: ${recordError.message}`); }
    rt.changed();
    if (RETIRED_LAUNCH_STATES.has(state)) throw new HiveError(`Worker launch ${launchId} is ${state}: ${err.message}`, 'refused');
    if (!dispatched) throw new HiveError(`Worker launch ${launchId} did not dispatch: ${err.message}`, err.code || 'refused');
    throw new HiveError(`Worker launch ${launchId} is uncertain: ${err.message}. Do not spawn again; reconcile this launch first.`, 'uncertain');
  } finally { inFlight.delete(launchId); }
}

export async function reconcileWorkerLaunch(rt, host, actor, { launch_id, abandon = false, reason }) {
  return withLock(ADMISSION_LOCK, async () => {
    actor = coordinator(rt, host, actor);
    const l = rt.metadata.read().workerLaunches[launch_id];
    if (!l || l.cellId !== actor.cell.id) throw new HiveError('Unknown worker launch in this cell.');
    if (inFlight.has(l.id)) throw new HiveError('This worker launch is still in progress.', 'busy');
    if (!RESERVED_LAUNCH_STATES.has(l.state)) return { launch_id: l.id, state: l.state };
    const session = l.sessionId ? host.sessions.get(l.sessionId) : null;
    const bead = await rt.beads.show(l.beadId);
    const currentLaunch = rt.metadata.read().workerLaunches[l.id];
    if (!RESERVED_LAUNCH_STATES.has(currentLaunch.state)) return { launch_id: l.id, state: currentLaunch.state };
    const review = l.reviewId && rt.metadata.read().reviews[l.reviewId];
    if (session && !session.archived && (l.reviewId ? review?.launchId === l.id && review.reviewerSessionId === l.sessionId : l.role !== 'worker' || bead?.assignee === actorFor(l.sessionId))) {
      bindIfMissing(rt, l.cellId, l.sessionId, l.beadId, l.role, actorFor(l.requestedBy));
      rt.metadata.mutate((d) => {
        const binding = (d.bindings[l.cellId] || []).find((b) => b.active && b.sessionId === l.sessionId && b.beadId === l.beadId);
        if (!binding) throw new HiveError('The worker binding could not be confirmed.');
        Object.assign(binding, { workerLaunchId: l.id, role: l.role, ...(l.reviewId ? { reviewId: l.reviewId } : {}) });
        d.workerLaunches[l.id].state = 'launched'; d.workerLaunches[l.id].updatedAt = Date.now();
      });
      rt.changed();
      return { launch_id: l.id, state: 'launched', session_id: l.sessionId };
    }
    if (!abandon) return { launch_id: l.id, state: 'uncertain', message: 'Confirm that no worker is starting; release any surviving claim before abandoning this launch.' };
    const note = text(reason, 'reason', 2000, { required: true });
    if (session && !session.archived) throw new HiveError('The launch has a live session; reconcile its claim first.');
    if (l.role === 'worker' && l.sessionId && bead?.assignee === actorFor(l.sessionId)) throw new HiveError('Release the surviving worker claim before abandoning its launch.');
    rt.metadata.mutate((d) => { Object.assign(d.workerLaunches[l.id], { state: 'abandoned', reason: note, updatedAt: Date.now() }); });
    rt.changed();
    return { launch_id: l.id, state: 'abandoned' };
  });
}
