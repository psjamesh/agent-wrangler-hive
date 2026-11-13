import { HiveError, LIMITS, text, UNSETTLED, isRunning } from './ops.js';
import { OUTCOMES, HUMAN_ACTOR, descendantIds } from './bead-model.js';
import { nearestFree, inRange } from '../public/hex-search.js';
import { sessionSummary } from './sessions.js';

const RETIRE_OUTCOMES = OUTCOMES.filter((o) => o !== 'duplicate');
const SESSION_CAP = 60;

export const isRetired = (cell) => Boolean(cell?.retired);

function liveCell(rt, cellId) {
  const cell = rt.metadata.cell(cellId);
  if (!cell) throw new HiveError(`Unknown cell ${cellId}.`);
  if (rt.metadata.error) throw new HiveError(rt.metadata.error, 'metadata-unavailable');
  return cell;
}

function liveSessions(rt, host, cell) {
  const doc = rt.metadata.read();
  const bindings = (doc.bindings[cell.id] || []).filter((b) => b.active);
  const ids = new Set([cell.queenSessionId, ...bindings.map((b) => b.sessionId)].filter(Boolean));
  for (const s of host.sessions.forTask(cell.taskId)) ids.add(s.sessionId);
  return [...ids].map((id) => ({ ...sessionSummary(host, id), role: id === cell.queenSessionId ? 'queen' : bindings.find((b) => b.sessionId === id)?.role || 'task member' }))
    .filter((s) => s.known && !s.archived).slice(0, SESSION_CAP);
}

export function checkRetire(rt, host, { cellId }) {
  const cell = liveCell(rt, cellId);
  const doc = rt.metadata.read();
  const beads = rt.snapshots.graph?.beads || {};
  const ids = cell.rootBeadId && beads[cell.rootBeadId] ? [...descendantIds(beads, cell.rootBeadId)].filter((id) => id !== cell.rootBeadId) : [];
  const open = ids.filter((id) => beads[id].status !== 'closed');
  const claims = open.filter((id) => beads[id].assignee);
  const unsettled = Object.values(doc.operations).filter((op) => op.cellId === cell.id && (UNSETTLED.has(op.state) || isRunning(op.id)));
  const problems = [];
  if (!rt.snapshots.hierarchyCurrent) problems.push('Hive has not finished reading this hive\'s work, so it cannot tell what is still open.');
  if (open.length) problems.push(`${open.length} item(s) are not finished (${open.slice(0, 5).join(', ')}${open.length > 5 ? ', …' : ''}).`);
  if (claims.length) problems.push(`${claims.length} item(s) are still claimed (${claims.slice(0, 5).join(', ')}${claims.length > 5 ? ', …' : ''}).`);
  if (unsettled.length) problems.push(`${unsettled.length} Hive write(s) in this hive are not settled yet.`);
  return {
    cellId: cell.id,
    retired: isRetired(cell),
    problems,
    openBeads: open.slice(0, 20).map((id) => ({ id, title: beads[id].title, assignee: beads[id].assignee || null })),
    openCount: open.length,
    claimCount: claims.length,
    unsettledCount: unsettled.length,
    sessions: liveSessions(rt, host, cell),
  };
}

export async function retireCell(rt, host, { cellId, outcome, summary, override = false, archiveSessions = false, sessionIds = null }) {
  const cell = liveCell(rt, cellId);
  if (isRetired(cell)) throw new HiveError('This hive is already retired.', 'stale');
  if (!RETIRE_OUTCOMES.includes(outcome)) throw new HiveError(`outcome must be one of ${RETIRE_OUTCOMES.join(', ')}.`);
  const cleanSummary = text(summary, 'summary', LIMITS.short, { required: true });
  const check = checkRetire(rt, host, { cellId });
  if (check.problems.length && override !== true) throw new HiveError(`This hive was not retired. ${check.problems.join(' ')}`, 'refused');
  const shown = Array.isArray(sessionIds) ? new Set(sessionIds) : null;
  const toArchive = archiveSessions === true ? check.sessions.filter((s) => !shown || shown.has(s.session_id)) : [];
  rt.metadata.mutate((d) => {
    const c = d.cells[cellId];
    c.enabled = false;
    c.retired = { outcome, summary: cleanSummary, at: Date.now(), by: HUMAN_ACTOR, position: { q: c.position?.q ?? 0, r: c.position?.r ?? 0 }, overridden: check.problems.length > 0 };
    c.updatedAt = Date.now();
  });
  const archived = [];
  const failed = [];
  for (const s of toArchive) {
    try {
      await host.sessions.archive(s.session_id, { cascade: false });
      archived.push(s.session_id);
    } catch (err) {
      failed.push({ sessionId: s.session_id, name: s.name, error: String(err?.message || err).slice(0, 200) });
    }
  }
  return { cellId, retired: true, archived, archiveFailed: failed };
}

export function reopenCell(rt, { cellId, reason }) {
  const cell = liveCell(rt, cellId);
  if (!isRetired(cell)) throw new HiveError('This hive is not retired.', 'stale');
  const cleanReason = text(reason, 'reason', LIMITS.short, { required: true });
  let position;
  rt.metadata.mutate((d) => {
    const c = d.cells[cellId];
    const old = c.retired.position || c.position || { q: 0, r: 0 };
    const taken = Object.values(d.cells).filter((o) => o.id !== cellId && !o.retired && o.position).map((o) => ({ q: o.position.q, r: o.position.r }));
    const shift = nearestFree([old], taken) || { q: 0, r: 0 };
    position = { q: old.q + shift.q, r: old.r + shift.r };
    if (!inRange(position)) throw new HiveError('There is no free place for this hive on the map.', 'no-room');
    c.position = position;
    c.enabled = true;
    c.reopened = { reason: cleanReason, at: Date.now(), by: HUMAN_ACTOR, was: c.retired };
    delete c.retired;
    c.updatedAt = Date.now();
  });
  return { cellId, reopened: true, position };
}
