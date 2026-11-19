import { validateSchedule } from '../public/schedule.js';
import { nextRunAt } from './schedule-time.js';
import { newId } from './metadata-store.js';
import { requireQueen } from './access.js';
import { HiveError, withLocks, refuseSnapshot } from './ops.js';
import { appendScheduledInput, deliver, scheduleTopic } from './conversation.js';
import { removeAttachmentBatch } from './attachments.js';
import { assertCurrent, isCurrent, runtimeKey } from './lifetime.js';

const passes = new WeakMap();
const activeCell = cell => cell?.enabled && !cell.snapshot && !cell.retired;
const recordOf = (doc, id, cellId) => {
  const r = doc.routines?.[id];
  if (!r || r.id !== id || r.cellId !== cellId || !r.threadId) return null;
  try { validateSchedule(r); return r; } catch { return null; }
};

export function routineState(rt, record) {
  if (!recordOf(rt.metadata.read(), record?.id, record?.cellId)) return null;
  const message = (rt.metadata.read().conversation?.[record.cellId] || []).find(m => m.id === record.lastMessageId);
  return { ...record, lastRunAt: record.lastRunAt ?? null, lastOutcome: message?.delivery?.state ?? record.lastOutcome ?? null,
    lastMessageId: record.lastMessageId ?? null, nextRunAt: record.enabled ? record.nextRunAt ?? null : null };
}

export function schedulesForCell(rt, cellId) {
  return Object.keys(rt.metadata.read().routines || {}).map(id => recordOf(rt.metadata.read(), id, cellId))
    .filter(Boolean).map(r => routineState(rt, r));
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
  assertCurrent(rt, host);
  if (rt.metadata.error) throw new HiveError(rt.metadata.error, 'metadata-unavailable');
  const cell = authorize(rt, actor);
  const id = input.schedule_id;
  const action = input.action || (id ? 'update' : 'create');
  if (!['create', 'update', 'pause', 'resume', 'delete', 'run-now'].includes(action)) throw new HiveError('Unknown schedule action.');
  if (action === 'create' && id) throw new HiveError('Create takes a new schedule, without a schedule_id.');
  if (action !== 'create' && !id) throw new HiveError('Give the schedule_id.');
  return withLocks([`routines:${cell.id}`], async () => {
    assertCurrent(rt, host);
    authorize(rt, actor);
    const previous = id && recordOf(rt.metadata.read(), id, cell.id);
    if (action !== 'create' && !previous) throw new HiveError('Unknown schedule in this hive.');
    if (action === 'run-now') return fireRoutine(rt, host, cell.id, id, { manual: true });
    if (action === 'delete') {
      rt.metadata.mutate(d => { delete d.routines[id]; });
      rt.changed();
      return { schedule_id: id, deleted: true };
    }
    const config = checked({ ...previous, ...input.schedule, ...(action === 'pause' ? { enabled: false } : action === 'resume' ? { enabled: true } : {}) });
    const at = Date.now();
    const cadence = s => JSON.stringify([s.days, s.time, s.timeZone, s.enabled]);
    const keepNext = previous && cadence(config) === cadence(previous);
    const record = { ...previous, ...config, id: id || newId('sched'), cellId: cell.id,
      nextRunAt: keepNext ? previous.nextRunAt : config.enabled ? nextRunAt(config, at) : null };
    rt.metadata.mutate(d => {
      record.threadId = scheduleTopic(d, cell.id, record, at).id;
      d.routines[record.id] = record;
    });
    rt.changed();
    return { schedule_id: record.id, schedule: routineState(rt, record) };
  });
}

async function fireRoutine(rt, host, cellId, id, { manual = false, now = Date.now() } = {}) {
  if (!isCurrent(rt, host)) return null;
  const cell = rt.metadata.cell(cellId);
  const record = recordOf(rt.metadata.read(), id, cellId);
  if (!activeCell(cell) || !record || !manual && (!record.enabled || !Number.isFinite(record.nextRunAt) || record.nextRunAt > now)) return null;
  let message;
  const removed = [];
  rt.metadata.mutate(d => {
    if (!activeCell(d.cells[cellId])) return;
    const cur = d.routines[id];
    message = appendScheduledInput(rt, d, d.cells[cellId], cur, now, removed);
    d.routines[id] = { ...cur, nextRunAt: manual ? cur.nextRunAt : nextRunAt(cur, now), lastRunAt: now, lastOutcome: 'queued', lastMessageId: message.id };
  });
  rt.changed();
  if (!message) return null;
  await removeAttachmentBatch(rt, cellId, removed);
  await deliverQueued(rt, host, cellId, message.id);
  return { schedule_id: id, message_id: message.id, schedule: routineState(rt, rt.metadata.read().routines[id]) };
}

async function deliverQueued(rt, host, cellId, messageId) {
  const result = await deliver(rt, host, { cellId, messageId });
  if (!isCurrent(rt, host)) return;
  rt.metadata.mutate(d => {
    const message = d.conversation[cellId]?.find(m => m.id === messageId);
    const state = d.routines[message?.scheduled?.scheduleId];
    if (state?.lastMessageId === messageId) state.lastOutcome = result.state;
  });
}

export function runRoutines(rt, host, now = Date.now()) {
  if (!isCurrent(rt, host) || rt.metadata.error) return Promise.resolve();
  const key = runtimeKey(rt);
  if (passes.has(key)) return passes.get(key);
  const before = rt.metadata.version;
  const pass = (async () => {
    for (const cell of Object.values(rt.metadata.read().cells || {})) {
      if (!activeCell(cell)) continue;
      for (const record of schedulesForCell(rt, cell.id)) {
        try {
          if (record.enabled && Number.isFinite(record.nextRunAt) && record.nextRunAt <= now) await withLocks([`routines:${cell.id}`], () => fireRoutine(rt, host, cell.id, record.id, { now }));
        } catch (err) {
          rt.log(`hive: schedule ${record.id} could not fire: ${err.message}`);
        }
      }
      await withLocks([`routines:${cell.id}`], async () => {
        for (const m of rt.metadata.read().conversation[cell.id] || []) {
          if (!activeCell(rt.metadata.cell(cell.id))) break;
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
  })().catch(err => rt.log(`hive: schedule sweep failed: ${err.message}`)).finally(() => { passes.delete(key); if (rt.metadata.version !== before) rt.changed(); });
  passes.set(key, pass);
  return pass;
}
