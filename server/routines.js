import { validateSchedule } from '../public/schedule.js';
import { nextRunAt } from './schedule-time.js';
import { actorFor, normalizeIssue, descendantIds } from './bead-model.js';
import { newId } from './metadata-store.js';
import { requireQueen, requireBeadAccess } from './access.js';
import { HiveError, waitForWritable, withLocks, journaled, refuseSnapshot, UNSETTLED } from './ops.js';
import { appendScheduledInput, deliver } from './conversation.js';
import { removeAttachmentBatch } from './attachments.js';
import { isCurrent, runtimeKey } from './lifetime.js';

const passes = new WeakMap();
const activeCell = cell => cell?.enabled && !cell.snapshot && !cell.retired;

export function routineState(rt, bead) {
  if (!bead || bead.kind !== 'routine' || !bead.schedule) return null;
  const saved = rt.metadata.read().routines?.[bead.id] || {};
  const schedule = bead.schedule;
  const message = (rt.metadata.read().conversation?.[saved.cellId] || []).find(m => m.id === saved.lastMessageId);
  return { ...schedule, lastRunAt: saved.lastRunAt ?? null, lastOutcome: message?.delivery?.state ?? saved.lastOutcome ?? null, lastMessageId: saved.lastMessageId ?? null,
    nextRunAt: bead.status === 'closed' || !schedule.enabled ? null : saved.revision === schedule.revision ? saved.nextRunAt : schedule.nextRunAt,
    enabled: bead.status !== 'closed' && schedule.enabled };
}

function checked(input) {
  try { return validateSchedule(input); } catch (err) { throw new HiveError(err.message); }
}

function authorize(rt, actor) {
  const cell = rt.metadata.cell(actor.cell?.id);
  if (!cell) throw new HiveError('Unknown hive.');
  refuseSnapshot(cell);
  if (!activeCell(cell)) throw new HiveError('Turn this hive on before changing its schedules.');
  if (actor.role !== 'human') requireQueen({ role: actor.sessionId === cell.queenSessionId ? actor.role : null }, 'manage schedules');
  return cell;
}

export async function setRoutine(rt, host, actor, input) {
  actor = await waitForWritable(rt, actor);
  if (actor.role === 'human') actor = { ...actor, cells: [{ cell: actor.cell, role: 'human' }] };
  const cell = authorize(rt, actor);
  const action = input.action || (input.bead_id ? 'update' : 'create');
  if (!['create', 'update', 'pause', 'resume', 'end', 'run-now'].includes(action)) throw new HiveError('Unknown schedule action.');
  if (action === 'create' && input.bead_id) throw new HiveError('Create takes a new schedule, without a bead_id. Use update to edit a routine.');
  if (action !== 'create' && !input.bead_id) throw new HiveError('Give the routine bead_id.');
  return withLocks([`routines:${cell.id}`, ...(input.bead_id ? [`bead:${input.bead_id}`] : [])], async () => {
    await rt.snapshots.refresh();
    authorize(rt, actor);
    const graph = rt.snapshots.graph;
    let bead = input.bead_id && graph.beads[input.bead_id];
    if (action !== 'create') {
      const access = requireBeadAccess(rt, actor, input.bead_id);
      if (access.cell.id !== cell.id || bead?.kind !== 'routine') throw new HiveError('That item is not a routine in this hive.');
      if (bead.status === 'closed') throw new HiveError('This schedule has ended. Create a new routine to schedule it again.');
    }
    if (action === 'run-now') return fireRoutine(rt, host, cell.id, bead.id, { manual: true });
    if (action === 'end') {
      const out = await journaled(rt, { kind: 'finish', cellId: cell.id, actor: actorFor(actor.sessionId), summary: `End schedule ${bead.title}`, beadIds: [bead.id], intent: { beadId: bead.id, outcome: 'done' } }, async (opId, phase) => {
        await rt.beads.close(bead.id, 'done: Schedule ended', actorFor(actor.sessionId));
        phase.applied = true;
      });
      await rt.snapshots.refresh();
      return { bead_id: bead.id, ended: true, op_id: out.opId };
    }
    const config = checked({ ...(bead?.schedule || {}), ...(input.schedule || {}), ...(action === 'pause' ? { enabled: false } : action === 'resume' ? { enabled: true } : {}) });
    if (bead && (action === 'pause' && !bead.schedule.enabled || action === 'resume' && bead.schedule.enabled)) return { bead_id: bead.id, schedule: routineState(rt, bead) };
    const at = Date.now();
    const cadence = s => JSON.stringify([s.days, s.time, s.timeZone, s.enabled]);
    const keepNext = bead && cadence(config) === cadence(bead.schedule);
    const schedule = { ...config, revision: newId('sched'), nextRunAt: keepNext ? routineState(rt, bead).nextRunAt : config.enabled ? nextRunAt(config, at) : null };
    if (action === 'create') {
      if (Object.values(rt.metadata.read().operations).some(op => op.cellId === cell.id && op.intent?.routine && UNSETTLED.has(op.state))) throw new HiveError('A schedule creation is unsettled. Reconcile it before creating another.', 'conflict');
      if (!cell.rootBeadId) throw new HiveError('This hive needs its root goal first.');
      const scope = descendantIds(graph.beads, cell.rootBeadId);
      const cluster = [...scope].map(id => graph.beads[id]).find(b => b?.system === 'schedules');
      if (cluster?.status === 'closed') throw new HiveError('Reopen the Schedules cluster before adding another schedule.');
      const nodes = cluster ? [] : [{ key: 'schedules', title: 'Schedules', kind: 'workstream', system: 'schedules', issueType: 'epic', parentId: cell.rootBeadId, cellId: cell.id }];
      nodes.push({ key: 'routine', title: config.name, kind: 'routine', schedule, issueType: 'task', ...(cluster ? { parentId: cluster.id } : { parentKey: 'schedules' }), cellId: cell.id });
      const out = await journaled(rt, { kind: 'create-beads', cellId: cell.id, actor: actorFor(actor.sessionId), summary: `Create schedule ${config.name}`, beadIds: [cluster?.id || cell.rootBeadId], intent: { routine: true } }, async (opId, phase) => {
        const { ids } = await rt.beads.createMany({ nodes }, actorFor(actor.sessionId), opId);
        phase.applied = true;
        return { ids, journal: { ids } };
      });
      await rt.snapshots.refresh();
      bead = rt.snapshots.graph.beads[out.ids.routine];
      return { bead_id: out.ids.routine, cluster_id: cluster?.id || out.ids.schedules, schedule: routineState(rt, bead), op_id: out.opId };
    }
    const out = await journaled(rt, { kind: 'update-bead', cellId: cell.id, actor: actorFor(actor.sessionId), summary: `Update schedule ${config.name}`, beadIds: [bead.id], intent: { beadId: bead.id, fields: ['schedule', 'title'] } }, async (opId, phase) => {
      await rt.beads.update(bead.id, { title: config.name, schedule }, actorFor(actor.sessionId));
      phase.applied = true;
    });
    await rt.snapshots.refresh();
    return { bead_id: bead.id, schedule: routineState(rt, rt.snapshots.graph.beads[bead.id]), op_id: out.opId };
  });
}

async function fireRoutine(rt, host, cellId, beadId, { manual = false, now = Date.now() } = {}) {
  const raw = await rt.beads.show(beadId);
  if (!raw || !isCurrent(rt, host)) return null;
  const bead = normalizeIssue(raw);
  const cell = rt.metadata.cell(cellId);
  if (!activeCell(cell) || bead.status === 'closed' || bead.kind !== 'routine' || !descendantIds(rt.snapshots.graph.beads, cell.rootBeadId).has(beadId)) return null;
  const state = routineState(rt, bead);
  if (!state || !manual && (!state.enabled || !Number.isFinite(state.nextRunAt) || state.nextRunAt > now)) return null;
  let message;
  const removed = [];
  rt.metadata.mutate(d => {
    const cur = d.cells[cellId];
    if (!activeCell(cur)) return;
    message = appendScheduledInput(rt, d, cur, bead, bead.schedule, now, removed);
    const previous = d.routines[beadId] || {};
    d.routines[beadId] = { ...previous, cellId, revision: bead.schedule.revision, nextRunAt: manual ? state.nextRunAt : nextRunAt(bead.schedule, now), lastRunAt: now, lastOutcome: 'queued', lastMessageId: message.id };
  });
  rt.changed();
  if (!message) return null;
  await removeAttachmentBatch(rt, cellId, removed);
  await deliverQueued(rt, host, cellId, message.id);
  return { bead_id: beadId, message_id: message.id, schedule: routineState(rt, bead) };
}

async function deliverQueued(rt, host, cellId, messageId) {
  const result = await deliver(rt, host, { cellId, messageId });
  if (!isCurrent(rt, host)) return;
  rt.metadata.mutate(d => {
    const message = d.conversation[cellId]?.find(m => m.id === messageId);
    const state = d.routines[message?.scheduled?.routineId];
    if (state?.lastMessageId === messageId) state.lastOutcome = result.state;
  });
}

export function runRoutines(rt, host, now = Date.now()) {
  if (!isCurrent(rt, host) || rt.metadata.error || rt.beads.status.state !== 'ready' || !rt.snapshots.hierarchyCurrent) return Promise.resolve();
  const key = runtimeKey(rt);
  if (passes.has(key)) return passes.get(key);
  const before = rt.metadata.version;
  const pass = (async () => {
    for (const cell of rt.metadata.cells()) {
      if (!activeCell(cell)) continue;
      const scope = descendantIds(rt.snapshots.graph.beads, cell.rootBeadId);
      for (const id of scope) {
        const bead = rt.snapshots.graph.beads[id];
        if (bead?.kind !== 'routine' || bead.status === 'closed') continue;
        try {
          const state = routineState(rt, bead);
          if (state?.enabled && state.nextRunAt <= now) await withLocks([`routines:${cell.id}`, `bead:${id}`], () => fireRoutine(rt, host, cell.id, id, { now }));
        } catch (err) {
          rt.log(`hive: routine ${id} could not fire: ${err.message}`);
        }
      }
      await withLocks([`routines:${cell.id}`], async () => {
        for (const m of rt.metadata.read().conversation[cell.id] || []) {
          if (!m.scheduled || m.acknowledgedAt || m.response?.answers?.length || m.response?.withdrawn) continue;
          try {
            if (m.delivery?.state === 'pending' && m.delivery.attempts?.length) {
              if (m.delivery.attempts.at(-1).runtimeEpoch === rt.metadata.epoch) continue;
              rt.metadata.mutate(d => {
                const cur = d.conversation[cell.id].find(x => x.id === m.id);
                cur.delivery = { ...cur.delivery, state: 'uncertain', error: 'Hive stopped before recording the scheduled message delivery outcome.' };
              });
            } else if (['pending', 'no-queen'].includes(m.delivery?.state) && rt.metadata.cell(cell.id)?.queenSessionId) {
              await deliverQueued(rt, host, cell.id, m.id);
            }
          } catch (err) {
            rt.log(`hive: scheduled message ${m.id} could not be recovered: ${err.message}`);
          }
        }
      });
    }
  })().catch(err => rt.log(`hive: routine sweep failed: ${err.message}`)).finally(() => { passes.delete(key); if (rt.metadata.version !== before) rt.changed(); });
  passes.set(key, pass);
  return pass;
}
