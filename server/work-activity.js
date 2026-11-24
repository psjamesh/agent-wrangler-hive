import { eligibleWorkCell, RESERVED_LAUNCH_STATES } from './admission.js';
import { OPEN_REVIEW_STATES } from './review-state.js';
import { activeWorkerRestores } from './worker-restores.js';
import { workingNow } from './tracking.js';

export function sessionActivity(host, sessionId) {
  const session = sessionId ? host?.sessions?.get?.(sessionId) : null;
  if (!session) return 'missing';
  if (session.archived) return 'archived';
  if (session.exitOutput || session.status === 'exited') return 'exited';
  if (session.dormant) return 'dormant';
  return session.status || 'unknown';
}

export const trackedHelperBinding = b => Boolean(b.autoEnrolled || b.helper || b.role === 'helper' || (b.role === 'investigator' && b.workerLaunchId));

export function workReservations(rt, graph, now = Date.now()) {
  const doc = rt.metadata.read();
  const records = [];
  const add = (beadId, source, sessionId, record, cellId) => {
    const cell = eligibleWorkCell(rt, graph, beadId);
    if (cell && (!cellId || cell.id === cellId)) records.push({ beadId, cellId: cell.id, source, sessionId: sessionId || null, recordId: record.id || null, at: record.at || record.createdAt || null });
  };
  for (const r of Object.values(doc.reviews || {})) if (OPEN_REVIEW_STATES.has(r.state)) add(r.workBeadId, 'review', r.reviewerSessionId, r, r.cellId);
  for (const l of Object.values(doc.workerLaunches || {})) if (RESERVED_LAUNCH_STATES.has(l.state)) add(l.beadId, 'launch', l.sessionId, l, l.cellId);
  for (const op of Object.values(doc.operations || {})) if (op.kind === 'claim' && ['pending', 'uncertain', 'partial'].includes(op.state)) add(op.intent?.beadId, 'claim-pending', op.intent?.assignee?.startsWith('aw:') ? op.intent.assignee.slice(3) : null, op, op.cellId);
  for (const [cellId, list] of Object.entries(doc.bindings || {})) for (const b of list) {
    if (b.active && trackedHelperBinding(b)) add(b.beadId, 'helper', b.sessionId, b, cellId);
  }
  for (const a of rt.spawnAdmissions?.values() || []) if (now - a.at < 10 * 60 * 1000) add(a.beadId, 'launch', null, a, a.cellId);
  for (const [sid, r] of activeWorkerRestores(rt, now)) add(r.beadId, 'restore', sid, r, r.cellId);
  return records;
}

export function workActivity(rt, graph, slots) {
  const occupied = new Set([...slots.claimed, ...slots.reserved]);
  const items = new Map();
  const item = id => {
    const cell = eligibleWorkCell(rt, graph, id);
    if (!cell) return null;
    if (!items.has(id)) items.set(id, { beadId: id, cellId: cell.id, occupiesCapacity: occupied.has(id), sources: [], participants: [], working: false, reconciliationNeeded: false, waitingFor: graph.beads[id].waitingFor || '' });
    return items.get(id);
  };
  const add = (id, source, sid, actualWork) => {
    const row = item(id);
    if (!row) return;
    if (!row.sources.includes(source)) row.sources.push(source);
    const state = sessionActivity(rt.host, sid);
    if (!row.participants.some(p => p.sessionId === (sid || null) && p.source === source)) row.participants.push({ sessionId: sid || null, source, state });
    row.working ||= actualWork && workingNow(rt.host, sid);
    row.reconciliationNeeded ||= ['missing', 'unknown', 'archived', 'exited', 'error', 'errored'].includes(state);
  };
  for (const id of occupied) item(id);
  for (const id of slots.claimed) add(id, 'claim', graph.beads[id]?.ownerSessionId, true);
  for (const r of workReservations(rt, graph)) add(r.beadId, r.source, r.sessionId, ['review', 'helper'].includes(r.source));
  for (const row of items.values()) {
    row.state = row.working ? 'working' : row.reconciliationNeeded ? 'reconciliation' : 'held';
    row.reason = [row.working ? 'Working now' : 'Held, not working', row.waitingFor, row.reconciliationNeeded ? 'Queen reconciliation needed' : ''].filter(Boolean).join('; ');
  }
  return [...items.values()];
}
