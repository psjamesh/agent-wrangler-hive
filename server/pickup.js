import crypto from 'node:crypto';
import path from 'node:path';
import { actorFor, descendantIds, GROUP_KINDS, normalizeIssue, openDescendants } from './bead-model.js';
import { requireBeadAccess, requireQueen, resolveCaller } from './access.js';
import { ADMISSION_LOCK, capacity, exportedGraph, RESERVED_LAUNCH_STATES } from './admission.js';
import { HiveError, ensureWritable, journaled, text, withLocks } from './ops.js';
import { assertCurrent, isCurrent } from './lifetime.js';
import { newId } from './metadata-store.js';
import { OPEN_REVIEW_STATES } from './review-state.js';
import { launchRate } from './launch-budget.js';
import { spawnWorker } from './workers.js';
import { safeDeliver } from './sessions.js';

const UNSETTLED = new Set(['pending', 'partial', 'uncertain']);
const ATTENTION = new Set(['uncertain', 'refused', 'abandoned', 'cancelled']);

export function briefDigest(bead, cellId) {
  return crypto.createHash('sha256').update(JSON.stringify([cellId, bead.parentId, bead.kind, bead.goal, bead.acceptance, bead.nextAction])).digest('hex');
}

export async function validatePickupProfile(rt, host, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HiveError('A readiness mark needs a launch profile: agent, model, effort and cwd.');
  const profile = {};
  for (const key of ['agent', 'model', 'cwd']) profile[key] = text(input[key], key, 4096, { required: true });
  if (!path.isAbsolute(profile.cwd)) throw new HiveError('The worker cwd must be an absolute folder.');
  if (input.effort === undefined || typeof input.effort !== 'string') throw new HiveError('Choose an effort, or an empty effort for a provider without effort control.');
  profile.effort = text(input.effort, 'effort', 120);
  profile.intent = text(input.intent, 'intent', 12000) || 'Own this bounded deliverable. Report results and questions to the current queen by Agent Wrangler mail.';
  if (input.worktree !== undefined) {
    const w = input.worktree;
    if (!w || typeof w !== 'object' || Array.isArray(w) || Object.keys(w).some(k => !['branch', 'folderName', 'auto', 'base'].includes(k)) || ['branch', 'folderName', 'base'].some(k => w[k] !== undefined && (typeof w[k] !== 'string' || w[k].length > 2000)) || (w.auto !== undefined && typeof w.auto !== 'boolean')) throw new HiveError('Invalid pickup worktree specification.');
    profile.worktree = structuredClone(w);
  }
  if (typeof host.agents?.list !== 'function') throw new HiveError('Worker profiles cannot be validated: agents:read is unavailable.', 'refused');
  const catalog = await host.agents.list();
  assertCurrent(rt, host);
  const agent = catalog.find(a => a.id === profile.agent && a.available === true);
  const model = agent?.models?.find(m => m.value === profile.model);
  if (!model || typeof model.resolved !== 'string' || !model.resolved) throw new HiveError('The worker provider/model is unavailable or its resolved identity is unknown.', 'refused');
  const efforts = model.efforts ?? (agent.efforts || []).map(e => e.value);
  if (efforts.length ? !efforts.includes(profile.effort) : profile.effort !== '') throw new HiveError('Choose an explicit supported effort for this model.', 'refused');
  profile.resolvedModel = model.resolved;
  return profile;
}

function receipt(rt, bead) {
  const r = rt.metadata.read().pickupReceipts?.[bead.id];
  return r?.token === bead.pickup?.armToken ? r : null;
}

export function pickupCell(rt, graph, beadId) {
  const roots = new Map(Object.values(rt.metadata.read().cells || {}).map(c => [c.rootBeadId, c]));
  const seen = new Set();
  for (let b = graph.beads[beadId]; b && !seen.has(b.id); b = graph.beads[b.parentId]) {
    if (roots.has(b.id)) return roots.get(b.id);
    seen.add(b.id);
  }
  return null;
}

export function pickupConsumed(doc, bead) {
  const token = bead.pickup?.armToken;
  return token && doc.pickupAttempts?.[token];
}

export function consumePickup(doc, bead, fields = {}) {
  const token = bead.pickup?.armToken;
  if (!token || doc.pickupAttempts?.[token]) return;
  (doc.pickupAttempts ||= {})[token] = { token, cellId: bead.pickup.cellId, beadId: bead.id, at: Date.now(), ...fields };
}

export function managedPickupReceipt(rt, before, after) {
  if (!before?.pickup?.armed || !after) return;
  const r = receipt(rt, before);
  if (!r || r.nativeVersion !== before.updatedAt || before.pickup.armToken !== after.pickup?.armToken) return;
  rt.metadata.mutate(d => {
    d.pickupReceipts[before.id] = { ...r, nativeVersion: after.updatedAt, ...(briefDigest(before, before.pickup.cellId) !== briefDigest(after, before.pickup.cellId) ? { heldReason: 'The executable brief changed; deliberate rearm is required' } : {}) };
  });
}

export function structuralPickupReasons(rt, graph, bead, { launchId = null, ownOperationId = null } = {}) {
  if (!bead) return ['Bead is missing'];
  const reasons = [];
  if (bead.status !== 'open') reasons.push(`Work is ${bead.status}`);
  if (bead.assignee) reasons.push('Work is already assigned');
  if (GROUP_KINDS.has(bead.kind) || ['external', 'decision'].includes(bead.kind)) reasons.push('Only bounded work items can be picked up');
  if (!bead.goal.trim() || !bead.acceptance.trim()) reasons.push('Work needs a goal and acceptance criteria');
  if (bead.waitingFor || bead.isBlocked) reasons.push(bead.waitingFor || 'Native blocked state needs reconciliation');
  if (openDescendants(graph.beads, bead.id).length) reasons.push('Work has open descendants');
  for (const edge of graph.edges) if (edge.dependent === bead.id && edge.blocking && graph.beads[edge.prerequisite]?.status !== 'closed') reasons.push(`Waiting on prerequisite ${edge.prerequisite}`);
  const doc = rt.metadata.read();
  if (Object.values(doc.reviews || {}).some(r => r.workBeadId === bead.id && OPEN_REVIEW_STATES.has(r.state))) reasons.push('Work has an open review');
  if (Object.values(doc.operations || {}).some(o => o.id !== ownOperationId && UNSETTLED.has(o.state) && (o.beadIds?.includes(bead.id) || o.intent?.beadId === bead.id))) reasons.push('A Beads write or claim needs reconciliation');
  if (Object.values(doc.workerLaunches || {}).some(l => l.id !== launchId && l.beadId === bead.id && RESERVED_LAUNCH_STATES.has(l.state))) reasons.push('A worker launch needs reconciliation');
  return reasons;
}

function cellReasons(rt, host, cell) {
  if (!cell?.enabled || cell.snapshot || cell.retired) return ['Hive is disabled, retired or a snapshot'];
  if (cell.setup?.state !== 'ready' || !cell.rootBeadId) return ['Hive setup is incomplete'];
  const task = host?.tasks?.get?.(cell.taskId);
  if (!task || task.archived) return ['Task is missing or archived'];
  const queen = host?.sessions?.get?.(cell.queenSessionId);
  if (!queen || queen.archived || queen.status === 'exited') return ['Current queen is missing, archived or exited'];
  if (Object.values(rt.metadata.read().launches || {}).some(l => l.cellId === cell.id && ['pending', 'bound', 'uncertain'].includes(l.state))) return ['Queen transition needs reconciliation'];
  return [];
}

export function pickupState(rt, host, cell, bead, graph = rt.snapshots.graph, { launchId = null, ownOperationId = null, now = Date.now(), checkVersion = true, rates = true } = {}) {
  const mark = bead?.pickup;
  if (!mark?.armed) return { ...mark, armed: false, eligible: false, state: 'unmarked', reason: 'Not marked ready for pickup' };
  const attempt = pickupConsumed(rt.metadata.read(), bead);
  const launch = attempt?.launchId && rt.metadata.read().workerLaunches?.[attempt.launchId];
  const base = { ...mark, nativeVersion: receipt(rt, bead)?.nativeVersion, eligible: false, launchId: launch?.id };
  if (attempt && attempt.launchId !== launchId) return { ...base, state: launch && ['reserved', 'binding', 'claimed'].includes(launch.state) ? 'starting' : launch && ATTENTION.has(launch.state) ? 'attention' : 'consumed', reason: launch?.error || (launch?.state === 'launched' ? 'Worker launched; readiness was consumed' : 'Readiness was consumed; deliberate rearm is required') };
  const reasons = cellReasons(rt, host, cell);
  if (receipt(rt, bead)?.heldReason) reasons.push(receipt(rt, bead).heldReason);
  if (rt.snapshots.current?.error || rt.snapshots.hierarchyCurrent === false) reasons.push('Current Beads hierarchy is incomplete');
  if (cell && (!descendantIds(graph.beads, cell.rootBeadId).has(bead.id) || bead.id === cell.rootBeadId || mark.cellId !== cell.id || pickupCell(rt, graph, bead.id)?.id !== cell.id)) reasons.push('Bead moved outside its authorized hive');
  if (typeof mark.armToken !== 'string' || !mark.profile || typeof mark.profileRevision !== 'string') reasons.push('Readiness record or worker profile is invalid');
  if (mark.briefDigest !== briefDigest(bead, cell?.id)) reasons.push('The executable brief changed; rearm after review');
  if (checkVersion && (!receipt(rt, bead)?.nativeVersion || receipt(rt, bead).nativeVersion !== bead.updatedAt)) reasons.push('Native version changed or arming receipt is unconfirmed; reconcile and rearm');
  reasons.push(...structuralPickupReasons(rt, graph, bead, { launchId, ownOperationId }));
  if (!launchId) {
    const usage = capacity(rt, graph);
    if (usage.limit && usage.available === 0) reasons.push('Waiting for global work capacity');
    if (rates) {
      const rate = launchRate(rt.metadata.read(), cell?.id, now);
      if (rate.reason) reasons.push(rate.reason);
    }
  }
  return { ...base, eligible: !reasons.length, state: reasons.length ? 'queued' : 'ready', reason: reasons[0] || 'Ready for pickup', reasons };
}

export function assertPickupAuthorization(rt, host, launch, graph, { ownOperationId = null, checkVersion = true } = {}) {
  const cell = rt.metadata.cell(launch.cellId);
  if (!cell || cell.queenSessionId !== launch.authorizedBy || (cell.queenGeneration || 0) !== launch.queenGeneration) throw new HiveError('Pickup queen authority changed.', 'refused');
  const bead = graph.beads[launch.beadId];
  if (bead?.pickup?.armToken !== launch.armToken || bead.pickup.profileRevision !== launch.profileRevision) throw new HiveError('Pickup readiness or profile changed.', 'refused');
  const state = pickupState(rt, host, cell, bead, graph, { launchId: launch.id, ownOperationId, checkVersion, rates: false });
  if (!state.eligible) throw new HiveError(state.reason, 'refused');
}

export async function setPickup(rt, host, actor, input) {
  ensureWritable(rt);
  const human = actor.sessionId === null;
  if (!human) requireQueen(resolveCaller(rt, host, actor.sessionId, actor.cell.id), 'mark work ready for pickup');
  const { cell } = requireBeadAccess(rt, actor, input.bead_id);
  if (typeof input.ready !== 'boolean') throw new HiveError('ready must be true or false.');
  const candidateProfile = input.profile || rt.snapshots.graph.beads[input.bead_id]?.pickup?.profile;
  const profile = input.ready ? await validatePickupProfile(rt, host, candidateProfile) : null;
  assertCurrent(rt, host);
  return withLocks([ADMISSION_LOCK, `bead:${input.bead_id}`], async () => {
    ensureWritable(rt);
    if (!human) requireQueen(resolveCaller(rt, host, actor.sessionId, cell.id), 'mark work ready for pickup');
    const graph = await rt.beads.loadSnapshot({ all: true });
    assertCurrent(rt, host);
    const bead = graph.beads[input.bead_id];
    if (!bead || !descendantIds(graph.beads, cell.rootBeadId).has(bead.id) || bead.id === cell.rootBeadId) throw new HiveError('Mark a work bead below this hive goal.');
    const previous = bead.pickup;
    if (input.ready && previous?.armed && !input.rearm && !pickupConsumed(rt.metadata.read(), bead) && receipt(rt, bead)?.nativeVersion === bead.updatedAt && !receipt(rt, bead)?.heldReason && previous.briefDigest === briefDigest(bead, cell.id) && (!profile || JSON.stringify(profile) === JSON.stringify(previous.profile))) return { bead_id: bead.id, pickup: { ...previous, nativeVersion: bead.updatedAt } };
    if (input.ready && previous?.armToken) {
      if (!input.rearm || input.expected_token !== previous.armToken || !text(input.reason, 'reason', 2000)) throw new HiveError('Rearm needs rearm: true, the expected_token and a reason.', 'conflict');
      const old = pickupConsumed(rt.metadata.read(), bead);
      const launch = old?.launchId && rt.metadata.read().workerLaunches[old.launchId];
      if (bead.assignee || launch && (RESERVED_LAUNCH_STATES.has(launch.state) || host.sessions.get(launch.sessionId) && !host.sessions.get(launch.sessionId).archived)) throw new HiveError('Reconcile the previous launch/session and claim before rearming.', 'conflict');
    }
    if (input.ready && (GROUP_KINDS.has(bead.kind) || ['external', 'decision'].includes(bead.kind) || !bead.goal.trim() || !bead.acceptance.trim() || bead.status === 'closed')) throw new HiveError('Readiness needs an open bounded work item with goal and acceptance.');
    const selected = profile || previous?.profile;
    if (input.ready && !selected) throw new HiveError('A readiness mark needs a valid launch profile.');
    const mark = input.ready ? { armed: true, armToken: newId('arm'), armedBy: actorFor(actor.sessionId), armedAt: Date.now(), cellId: cell.id, profileRevision: newId('profile'), profile: selected, briefDigest: briefDigest(bead, cell.id) } : { ...previous, armed: false };
    const out = await journaled(rt, { kind: 'set-pickup', cellId: cell.id, actor: actorFor(actor.sessionId), summary: `${input.ready ? 'Arm' : 'Disarm'} pickup ${bead.id}`, beadIds: [bead.id], intent: { beadId: bead.id, pickup: mark } }, async (opId, phase) => {
      phase.attempted = true;
      const raw = await rt.beads.update(bead.id, { pickup: mark }, actorFor(actor.sessionId), context => {
        assertCurrent(rt, host);
        if (!human) requireQueen(resolveCaller(rt, host, actor.sessionId, cell.id), 'mark work ready for pickup');
        const fresh = exportedGraph(context).beads[bead.id];
        if (!fresh || fresh.updatedAt !== bead.updatedAt || briefDigest(fresh, cell.id) !== mark.briefDigest && input.ready) throw new HiveError('Work changed while marking readiness; reread before trying again.', 'conflict');
        return { assignee: fresh.assignee || '', status: fresh.status };
      });
      phase.applied = true;
      const saved = raw && normalizeIssue(raw);
      if (!saved?.updatedAt || saved.pickup?.armToken !== mark.armToken) throw new HiveError('Arming native-version receipt is unconfirmed; do not repeat this write.', 'uncertain');
      rt.metadata.mutate(d => { (d.pickupReceipts ||= {})[bead.id] = { token: mark.armToken, nativeVersion: saved.updatedAt, opId }; });
      return {};
    });
    await rt.snapshots.refresh();
    rt.pickup?.schedule();
    return { op_id: out.opId, bead_id: bead.id, pickup: { ...mark, nativeVersion: receipt(rt, { id: bead.id, pickup: mark })?.nativeVersion } };
  });
}

async function notifyAttempts(rt, host) {
  for (const attempt of Object.values(rt.metadata.read().pickupAttempts || {})) {
    assertCurrent(rt, host);
    const launch = rt.metadata.read().workerLaunches[attempt.launchId];
    if (!launch || !ATTENTION.has(launch.state) || attempt.notice) continue;
    const queen = rt.metadata.cell(attempt.cellId)?.queenSessionId;
    if (!queen || !host.sessions.get(queen) || host.sessions.get(queen).archived) continue;
    rt.metadata.mutate(d => { d.pickupAttempts[attempt.token].notice = { state: 'sending', queen }; });
    const result = await safeDeliver(host, queen, `[Hive] Pickup needs attention on ${attempt.beadId}, launch ${launch.id}: ${launch.error || launch.state}. Inspect hive_context and hive_reconcile_worker. Never retry automatically; reconcile before deliberately rearming.`, rt);
    assertCurrent(rt, host);
    rt.metadata.mutate(d => { d.pickupAttempts[attempt.token].notice.state = result.state; });
  }
}

export function createPickupDispatcher({ runtime: rt, host, now = Date.now }) {
  let running = null, timer = null, stopped = false;
  const active = () => !stopped && isCurrent(rt, host);
  async function pass() {
    if (!active() || rt.metadata.error || rt.beads.status.state !== 'ready') return;
    await rt.snapshots.refresh();
    if (!active() || rt.snapshots.current.error || rt.snapshots.hierarchyCurrent === false) return;
    await notifyAttempts(rt, host);
    const cells = rt.metadata.cells().sort((a, b) => a.id.localeCompare(b.id));
    const cursor = rt.metadata.read().pickupRates?.cursor;
    const index = cells.findIndex(c => c.id === cursor);
    const ordered = [...cells.slice(index + 1), ...cells.slice(0, index + 1)];
    let starts = 0;
    for (const candidate of ordered) {
      if (!active() || starts >= 2) return;
      const graph = await rt.beads.loadSnapshot({ all: true });
      if (!active()) return;
      const cell = rt.metadata.cell(candidate.id);
      if (cellReasons(rt, host, cell).length) continue;
      const beads = [...descendantIds(graph.beads, cell.rootBeadId)].map(id => graph.beads[id]).filter(b => b && pickupState(rt, host, cell, b, graph, { now: now() }).eligible)
        .sort((a, b) => (a.priority ?? 9) - (b.priority ?? 9) || a.pickup.armedAt - b.pickup.armedAt || a.id.localeCompare(b.id));
      const bead = beads[0];
      if (!bead) continue;
      const authorization = { armToken: bead.pickup.armToken, profileRevision: bead.pickup.profileRevision, authorizedBy: cell.queenSessionId, queenGeneration: cell.queenGeneration || 0, observedAt: now() };
      try {
        const profile = await validatePickupProfile(rt, host, bead.pickup.profile);
        if (!active()) return;
        if (JSON.stringify(profile) !== JSON.stringify(bead.pickup.profile)) throw new HiveError('Worker model resolution changed; reconcile and rearm.', 'refused');
        const actor = resolveCaller(rt, host, cell.queenSessionId, cell.id);
        await spawnWorker(rt, host, actor, { bead_id: bead.id, ...profile }, { pickup: authorization, now });
        starts += 1;
      } catch (err) {
        if (!active()) return;
        rt.log(`hive: automatic pickup ${bead.id}: ${err.message}`);
        if (err.code !== 'busy') {
          rt.metadata.mutate(d => {
            if (!d.pickupAttempts?.[bead.pickup.armToken]) {
              const id = newId('worker');
              d.workerLaunches[id] = { id, cellId: cell.id, beadId: bead.id, state: 'refused', error: err.message, source: 'automatic' };
              consumePickup(d, bead, { launchId: id, source: 'automatic' });
            }
          });
        }
      }
    }
    if (active()) { await notifyAttempts(rt, host); rt.changed(); }
  }
  const dispatcher = {
    run() {
      if (!active()) return Promise.resolve();
      if (running) return running;
      running = pass().catch(err => { if (active()) rt.log(`hive: pickup pass failed: ${err.message}`); }).finally(() => { running = null; });
      return running;
    },
    schedule() {
      if (!active() || timer) return;
      timer = setTimeout(() => { timer = null; dispatcher.run(); }, 20);
      timer.unref?.();
    },
    stop() { stopped = true; clearTimeout(timer); timer = null; },
  };
  return dispatcher;
}
