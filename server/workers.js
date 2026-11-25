import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { hostApiAtLeast } from './host-api.js';
import { activeWorkerRestores } from './worker-restores.js';
import { assertAllowedModel } from './review-policy.js';
import { safeDeliver } from './sessions.js';
import { prRepository } from './pr-labels.js';
import { availableSessionHref } from './session-links.js';
import { assertPickupAuthorization, assertPickupClaimed, consumePickup, catalogHold, pickupReadUnavailable, retryUnsubmittedPickup } from './pickup.js';
import { reservePickupStart } from './launch-budget.js';
import { OPEN_REVIEW_STATES } from './review-state.js';
import { liveClaimant } from './tracking.js';
import { holdsBead } from './bead-sessions.js';
import { assertCurrent } from './lifetime.js';
import { newId } from './metadata-store.js';
import { actorFor, descendantIds, GROUP_KINDS, isSessionId } from './bead-model.js';
import { requireNonHelper, COORDINATING_ROLES, requireBeadAccess, requireCoordinator, resolveCaller, waitForHierarchy, notePendingParticipant } from './access.js';
import { HiveError, ensureWritable, ensureStoreWritable, waitForWritable, text, withLock, withLocks, claimBead, bindIfMissing } from './ops.js';
import { applyLaunchPolicy, launchRestriction } from './launch-policy.js';
import { ADMISSION_LOCK, capacity, checkAdmission, exportedGraph, RESERVED_LAUNCH_STATES, RETIRED_LAUNCH_STATES } from './admission.js';

const runFile = promisify(execFile);

async function defaultWorkerWorktree(opts, role) {
  if (role !== 'worker' || opts.worktree !== undefined || !opts.cwd) return;
  const cwd = opts.cwd === '~' ? os.homedir() : opts.cwd.startsWith('~/') ? path.join(os.homedir(), opts.cwd.slice(2)) : path.resolve(opts.cwd);
  try {
    const { stdout } = await runFile('git', ['-C', cwd, 'rev-parse', '--is-inside-work-tree'], { timeout: 10000, encoding: 'utf8' });
    if (stdout.trim() === 'true') {
      opts.cwd = cwd;
      opts.worktree = { auto: true };
    }
  } catch {}
}

const inFlight = new Set();
export function workerLaunchInFlight(id) { return inFlight.has(id); }

function launchOptions(input) {
  const out = { intent: text(input.intent, 'intent', 20000, { required: true }) };
  for (const field of ['cwd', 'agent', 'model', 'effort']) {
    const value = text(input[field], field, 2000);
    if (value) out[field] = value;
  }
  if (input.codex_approval !== undefined && !['on-request', 'never'].includes(input.codex_approval)) throw new HiveError('codex_approval must be on-request or never.');
  if (out.agent === 'codex' && input.codex_approval !== undefined) out.approvalPolicy = input.codex_approval;
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

function coordinatorAuthority(rt, host, actor, { attach = false, beadId = null } = {}) {
  assertCurrent(rt, host);
  ensureStoreWritable(rt);
  const fresh = resolveCaller(rt, host, actor.sessionId, actor.cell.id);
  requireNonHelper(rt, fresh, 'launch or reconcile sessions');
  if (attach && beadId && !COORDINATING_ROLES.has(fresh.role) && holdsBead(rt, host, fresh.sessionId, beadId)) {
    return fresh;
  }
  requireCoordinator(fresh, attach ? 'attach a session to work it does not hold' : 'launch or reconcile workers');
  return fresh;
}

export function coordinator(rt, host, actor, options) {
  const fresh = coordinatorAuthority(rt, host, actor, options);
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

function gateAuthority(rt, host, launchId, { sid, task, ext, initial, restoring }, expected = null) {
  assertCurrent(rt, host);
  const launch = rt.metadata.read().workerLaunches[launchId];
  const allowed = initial ? ['reserved', 'binding'] : ['binding', 'claimed', 'launched', 'archived', 'uncertain'];
  if (!launch || !allowed.includes(launch.state) || (launch.sessionId && launch.sessionId !== sid)) throw new HiveError('This worker launch is missing, abandoned, stale or belongs to a different session.');
  if (expected && ['id', 'cellId', 'taskId', 'beadId', 'requestedBy', 'role', 'reviewId'].some((key) => launch[key] !== expected[key])) throw new HiveError('The worker launch identity changed before startup.');
  if (task?.id !== launch.taskId || (ext?.beadId && ext.beadId !== launch.beadId)) throw new HiveError('This worker launch has a different task or cell.');
  if (host.sessions.get(sid)?.archived && !restoring) {
    const holder = rt.snapshots.graph.beads[launch.beadId]?.assignee || 'none';
    throw new HiveError(`Archived Hive worker ${sid} cannot be restored safely. Manual restore requires Agent Wrangler host API >=1.95.0 and an explicit restore; scheduled resumes remain refused. Cell ${launch.beadId}; last known claim holder: ${holder}. The queen should check hive_context and, if the claim is stale, release it with hive_release_bead (bead_id: ${launch.beadId}, force: true, and a reason). Then launch a fresh worker with hive_spawn_worker on open, unclaimed work.`);
  }
  const requester = initial ? coordinatorAuthority(rt, host, { sessionId: launch.requestedBy, cell: { id: launch.cellId } }, { attach: launch.role !== 'worker', beadId: launch.beadId }) : resolveCaller(rt, host, sid, launch.cellId);
  ensureStoreWritable(rt);
  reviewForLaunch(rt, launch, { sid, initial });
  if (initial && launch.source === 'automatic') {
    const cell = rt.metadata.cell(launch.cellId);
    if (cell?.queenSessionId !== launch.authorizedBy || (cell.queenGeneration || 0) !== launch.queenGeneration) throw new HiveError('Pickup queen authority changed.');
  }
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

function requireHelperHolder(host, graph, beadId) {
  const owner = graph.beads[beadId]?.assignee;
  if (!owner?.startsWith('aw:') || !liveClaimant(host, owner.slice(3))) throw new HiveError('A helper requires a live claim holder on its cell.', 'refused');
}

function requireLaunchScope(actor, graph, beadId) {
  if (!descendantIds(graph.beads, actor.cell.rootBeadId).has(beadId) || beadId === actor.cell.rootBeadId) throw new HiveError('The worker cell moved outside this hive.', 'conflict');
}

function recordLaunchFailure(rt, launchId, error, dispatched = true) {
  return rt.metadata.mutate((d) => {
    const launch = d.workerLaunches[launchId];
    if (!launch) return null;
    const review = launch.reviewId && d.reviews[launch.reviewId];
    if (!RETIRED_LAUNCH_STATES.has(launch.state)) {
      if (review && !OPEN_REVIEW_STATES.has(review.state)) launch.state = review.state === 'cancelled' ? 'cancelled' : 'review-ended';
      else if (error.hierarchyBusy || launch.refusalReason === 'hierarchy-busy' && launch.claimApplied) launch.state = launch.claimApplied ? 'claimed' : 'refused';
      else launch.state = dispatched ? 'uncertain' : 'refused';
    }
    if (!dispatched && launch.source === 'automatic' && d.pickupRates?.starts) d.pickupRates.starts = d.pickupRates.starts.filter(s => s.launchId !== launchId);
    launch.error = String(error.message).slice(0, 1000);
    if (error.hierarchyBusy) launch.refusalReason = 'hierarchy-busy';
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
  const l = rt.metadata.read().workerLaunches[ext.workerLaunchId];
  const cell = l && rt.metadata.cell(l.cellId);
  if (isSessionId(sessionId) && l?.sessionId === sessionId && l.state === 'binding' && cell?.enabled && !cell.snapshot && cell.taskId === l.taskId) {
    notePendingParticipant(rt, sessionId, { cellId: cell.id, taskId: l.taskId, spawnedBy: null, launchId: l.id });
  }
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
    let claimApplied = false;
    let restoreReserved = false;
    let held = null;
    let target = null;
    let closedTarget = false;
    try {
      if (!rt) throw new HiveError('Hive is unavailable for this worker launch.');
      const initial = ['dispatch', 'spawn'].includes(reason);
      const restoring = reason === 'restore' && hostApiAtLeast(host, 1, 95) && rt.metadata.read().workerLaunches[launchId]?.role === 'worker';
      let actor;
      let launch;
      await withLock(ADMISSION_LOCK, async () => {
        const context = { sid, task, ext, initial, restoring };
        const expected = rt.metadata.read().workerLaunches[launchId];
        const graph = await waitForHierarchy(rt, { refresh: true, read: () => rt.beads.loadSnapshot({ all: true }) });
        const current = gateAuthority(rt, host, launchId, context, expected);
        const { launch: l, requester } = current;
        if (initial && l.source === 'automatic') assertPickupAuthorization(rt, host, l, graph);
        held = initial || l.role !== 'worker' ? null : heldOpenBead(rt, graph, sid, l);
        target = held || l.beadId;
        closedTarget = !initial && graph.beads[target]?.status === 'closed';
        try {
          const access = requireBeadAccess(rt, requester, target);
          if (access.cell.id !== l.cellId) throw new HiveError('The worker cell moved to another hive.');
          requireLaunchScope(requester, graph, target);
          if (initial && l.role === 'investigator') requireHelperHolder(host, graph, target);
          checkAdmission(rt, graph, target, { sessionId: sid, launchId, review: l.role !== 'worker', revalidateCapacity: restoring });
        } catch (err) {
          if (held) throw new HiveError(`${String(err.message).replace(/\.?$/, ".")} This worker holds an open claim on ${held}; the queen should release it or hand it over.`, err.code);
          throw err;
        }
        actor = { ...requester, sessionId: sid, role: 'worker', cells: [{ cell: requester.cell, role: 'worker' }] };
        launch = l;
        rt.metadata.mutate((d) => {
          const rec = d.workerLaunches[launchId];
          Object.assign(rec, { sessionId: sid, state: 'binding', claimStarted: l.role === 'worker', claimApplied: false, updatedAt: Date.now() });
          delete rec.refusalReason;
        });
        if (restoring) {
          activeWorkerRestores(rt).set(sid, { beadId: target, cellId: launch.cellId, at: Date.now() });
          restoreReserved = true;
        }
        reserved = true;
      });
      if (launch.role === 'worker') {
        await claimBead(rt, actor, { bead_id: target }, { launchId: held ? null : launchId, revalidateCapacity: restoring, validate: (context) => {
          if (initial && launch.source === 'automatic') assertPickupAuthorization(rt, host, launch, exportedGraph(context), { ownOperationId: context.pickupOperationId, checkHierarchy: false });
          if (initial) {
            const requester = coordinatorAuthority(rt, host, { sessionId: launch.requestedBy, cell: { id: launch.cellId } });
            requireLaunchScope(requester, exportedGraph(context), target);
          }
          else resolveCaller(rt, host, sid, launch.cellId);
          if (host.sessions.get(sid)?.archived && !restoring) throw new HiveError('The worker was archived before claiming.');
          if (held) {
            const fresh = context?.issues?.find((i) => i.id === held);
            if (!fresh || fresh.status === 'closed' || fresh.assignee !== `aw:${sid}`) throw new HiveError(`Cell ${held} is no longer held by this worker.`, 'conflict');
          }
        } });
        claimApplied = true;
        rt.metadata.mutate(d => { d.workerLaunches[launchId].claimApplied = true; });
      }
      if (initial && launch.source === 'automatic') {
        assertCurrent(rt, host);
        const claimedGraph = await waitForHierarchy(rt, { read: () => rt.beads.loadSnapshot({ all: true }) });
        assertPickupClaimed(rt, host, launch, claimedGraph, sid);
      }
      await waitForWritable(rt);
      const fresh = gateAuthority(rt, host, launchId, { sid, task, ext, initial, restoring }, launch);
      const access = requireBeadAccess(rt, fresh.requester, target);
      if (access.cell.id !== launch.cellId) throw new HiveError('The worker cell moved to another hive.');
      requireLaunchScope(fresh.requester, rt.snapshots.graph, target);
      rt.metadata.mutate((d) => {
        const rec = d.workerLaunches[launchId];
        if (rec.state !== 'binding' || rec.sessionId !== sid || (host.sessions.get(sid)?.archived && !restoring)) throw new HiveError('The worker launch was archived or changed before startup.');
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
        rec.boundAt ||= Date.now();
        rec.updatedAt = Date.now();
      });
      rt.changed();
    } catch (err) {
      if (claimApplied) {
        err.message = err.hierarchyBusy
          ? `Bead ${target} is already claimed by session ${sid}. The hierarchy refresh timed out. Resume this session in about 1 second or reconcile launch ${launchId}; do not spawn a replacement.`
          : String(err.message).replace('Nothing was changed.', 'The startup claim was already applied.');
      }
      if (restoreReserved) rt.workerRestores.delete(sid);
      if (err.hierarchyBusy && !reserved && ['dispatch', 'spawn'].includes(reason)) {
        recordLaunchFailure(rt, launchId, err, false);
        rt.changed();
      }
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

export async function spawnWorker(rt, host, actor, input, { reviewId = null, role = reviewId ? 'reviewer' : 'worker', pickup = null, now = Date.now } = {}) {
  if (!['worker', 'reviewer', 'investigator'].includes(role)) throw new HiveError('Unknown worker launch role.');
  const opts = launchOptions(input);
  const launchId = newId('worker');
  const as = { attach: role !== 'worker', beadId: input.bead_id };
  const attach = role !== 'worker';
  try { await waitForWritable(rt); }
  catch (err) { if (pickup && (err.hierarchyBusy || rt.snapshots.current?.error)) throw pickupReadUnavailable(err.message); throw err; }
  actor = coordinator(rt, host, actor, as);
  await defaultWorkerWorktree(opts, role);
  assertCurrent(rt, host);
  assertAllowedModel(opts);
  let catalog;
  try { catalog = await host.agents?.list?.(); }
  catch {
    assertCurrent(rt, host);
    if (pickup) throw catalogHold('Worker model catalog could not be read.');
  }
  assertCurrent(rt, host);
  if (pickup && !Array.isArray(catalog)) throw catalogHold('Worker model catalog is unavailable.');
  const provider = Array.isArray(catalog) ? catalog.find(a => a.id === (opts.agent || 'claude')) : null;
  const model = provider?.models?.find(m => opts.model ? m.value === opts.model : m.default);
  assertAllowedModel({ ...opts, resolvedModel: model?.resolved });
  if (pickup) {
    if (!provider?.available || !model || typeof model.resolved !== 'string' || !model.resolved) throw catalogHold('Worker model resolution cannot be checked in the current catalog.', 'model-unavailable');
    if (model.resolved !== input.resolvedModel) throw new HiveError('Worker model resolution changed; reconcile and rearm.', 'refused');
  }
  await withLocks([ADMISSION_LOCK, `bead:${input.bead_id}`], async () => {
    let graph;
    try { graph = await waitForHierarchy(rt, { refresh: true, read: () => rt.beads.loadSnapshot({ all: true }) }); }
    catch (err) { if (pickup && (err.hierarchyBusy || rt.snapshots.current?.error)) throw pickupReadUnavailable(err.message); throw err; }
    actor = coordinator(rt, host, actor, as);
    const { bead, cell } = requireBeadAccess(rt, actor, input.bead_id);
    if (cell.id !== actor.cell.id || bead.id === cell.rootBeadId) throw new HiveError('Launch a worker for a cell in this hive, below its goal.');
    requireLaunchScope(actor, graph, bead.id);
    if (role === 'investigator') requireHelperHolder(host, graph, bead.id);
    reviewForLaunch(rt, { reviewId, beadId: bead.id, cellId: cell.id });
    checkAdmission(rt, graph, bead.id, { sessionId: null, review: attach });
    const automatic = pickup ? { ...pickup, source: 'automatic', profile: structuredClone(graph.beads[bead.id].pickup.profile), briefDigest: graph.beads[bead.id].pickup.briefDigest } : {};
    if (pickup) {
      assertPickupAuthorization(rt, host, { ...automatic, id: launchId, cellId: cell.id, beadId: bead.id }, graph);
      if (now() - pickup.observedAt > 60000) throw pickupReadUnavailable('Pickup profile observation is stale.');
    }
    rt.metadata.mutate((d) => {
      if (pickup) reservePickupStart(d, cell.id, launchId, now());
      consumePickup(d, graph.beads[bead.id], { launchId, source: pickup ? 'automatic' : 'manual' });
      d.workerLaunches[launchId] = { id: launchId, cellId: cell.id, taskId: cell.taskId, beadId: bead.id, requestedBy: actor.sessionId, ...automatic, role, reviewId, sessionId: null, state: 'reserved', startupPhase: 'reserved', restriction: launchRestriction(opts.agent), createdAt: Date.now(), updatedAt: Date.now() };
      if (reviewId) d.reviews[reviewId].launchId = launchId;
    });
  });
  rt.changed();
  inFlight.add(launchId);
  let dispatched = false;
  try {
    await waitForWritable(rt);
    const l = rt.metadata.read().workerLaunches[launchId];
    actor = coordinator(rt, host, actor, as);
    if (l.state !== 'reserved') throw new HiveError('This launch was cancelled or changed before dispatch.', 'conflict');
    reviewForLaunch(rt, l, { initial: true });
    if (pickup) {
      const fresh = await rt.beads.loadSnapshot({ all: true });
      assertPickupAuthorization(rt, host, l, fresh);
    }
    assertCurrent(rt, host);
    rt.metadata.mutate(d => {
      const current = d.workerLaunches[launchId];
      if (current?.state !== 'reserved' || pickup && (d.pickupAttempts?.[current.armToken]?.launchId !== launchId || d.pickupAttempts[current.armToken].retryPending)) throw new HiveError('This launch was cancelled or changed before submission.', 'conflict');
      Object.assign(current, { submittedAt: now(), startupPhase: 'submitted' });
    });
    const baseIntent = l.reviewId ? `You are the reviewer of Hive cell ${l.beadId} in Hive ${l.cellId}; its builder keeps the claim. Your reviewer binding is made before your first action. Report to session ${l.requestedBy} by Agent Wrangler mail.\n\n${opts.intent}` : l.role === 'investigator' ? `You are a helper on Hive cell ${l.beadId} in Hive ${l.cellId}; its builder keeps the claim. Your helper binding is made before your first action. You cannot claim cells, launch sessions or give review verdicts. Report results to session ${l.requestedBy} by Agent Wrangler mail.\n\n${opts.intent}` : `You own Hive cell ${l.beadId} in Hive ${l.cellId}. Its claim and binding are made before your first action. Use hive_context and the hive-worker skill. Report to queen/coordinator session ${l.requestedBy} by Agent Wrangler mail.\n\n${opts.intent}`;
    const delegation = 'Delegate only through Hive (hive_spawn_worker where your role allows it, or ask the queen); do not use spawn_session, spawn_workflow or schedule_session; they leave the session untracked. ';
    const intent = `${baseIntent}\n\nUse the hive-worker skill. Start with hive_context({ scope: "bead", bead_id: "${l.beadId}", hive_id: "${l.cellId}" }) for your bounded work context.\n\nHive task: ${l.taskId}. A Hive is the top-level task; a cluster is stored as kind workstream; a cell is one work item addressed by bead_id. Prefer hive_id for the Hive; cell_id remains an alias and both must agree if supplied. Stored cell_ ids and tool names are unchanged. When the human must act in a specific session, pass its full session_id and optional session_label to hive_request_input or hive_publish for a one-click board link. For decisions or actions use Hive's input tool hive_request_input; do not also call request_human_input. Worker/reviewer/helper requests go to this hive's queen and remain out of human views until forwarded; human step-in is not supported. Recover with hive_list_my_requests and withdraw with hive_withdraw_request when answered elsewhere. ${delegation}Launch helpers into this same resolved task; ancestry alone does not enroll them. Missing native tools require a membership check or refreshed agent terminal.`;
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
    let retryScheduled = false;
    try {
      state = recordLaunchFailure(rt, launchId, err, dispatched);
      if (!dispatched && pickup && err.pickupRetryable) retryScheduled = rt.metadata.mutate(d => retryUnsubmittedPickup(d, d.workerLaunches[launchId], rt.snapshots.graph.beads[input.bead_id], err.message));
    }
    catch (recordError) { rt.log(`hive: could not record worker launch failure: ${recordError.message}`); }
    rt.changed();
    if (retryScheduled) throw Object.assign(new HiveError(err.message, 'busy'), { pickupRetryScheduled: true });
    if (state === 'claimed' && rt.metadata.read().workerLaunches[launchId]?.refusalReason === 'hierarchy-busy') throw new HiveError(err.message, 'busy');
    if (RETIRED_LAUNCH_STATES.has(state)) throw Object.assign(new HiveError(`Worker launch ${launchId} is ${state}: ${err.message}`, 'refused'), { hierarchyBusy: rt.metadata.read().workerLaunches[launchId]?.refusalReason === 'hierarchy-busy' });
    if (!dispatched) throw new HiveError(`Worker launch ${launchId} did not dispatch: ${err.message}`, err.code || 'refused');
    throw new HiveError(`Worker launch ${launchId} is uncertain: ${err.message}. Do not spawn again; reconcile this launch first.`, 'uncertain');
  } finally { inFlight.delete(launchId); }
}

export async function reconcileWorkerLaunch(rt, host, actor, { launch_id, abandon = false, reason }) {
  return withLock(ADMISSION_LOCK, async () => {
    actor = coordinator(rt, host, actor);
    const l = rt.metadata.read().workerLaunches[launch_id];
    if (!l || l.cellId !== actor.cell.id) throw new HiveError('Unknown worker launch in this hive.');
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
