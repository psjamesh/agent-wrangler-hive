import { OPEN_REVIEW_STATES } from './review-state.js';
import { GROUP_KINDS } from './bead-model.js';

export function liveClaimant(host, sessionId) {
  const session = sessionId ? host?.sessions?.get?.(sessionId) : null;
  return Boolean(session && !session.archived && session.status !== 'exited');
}

export function sleepingReason(session) {
  if (!session || session.archived || session.status === 'exited') return null;
  if (session.dormant === true) return 'dormant';
  return null;
}

export function isUntracked(host, graph, bead) {
  return bead.status === 'in_progress' && bead.kind !== 'external' && !GROUP_KINDS.has(bead.kind)
    && !liveClaimant(host, bead.ownerSessionId) && !OPEN_REVIEW_STATES.has(bead.reviewState)
    && !graph.edges.some((e) => e.blocking && e.dependent === bead.id && graph.beads[e.prerequisite] && graph.beads[e.prerequisite].status !== 'closed');
}

export function trackingKey(rt) {
  return Object.values(rt.snapshots.current.graph.beads).filter((b) => b.ownerSessionId)
    .map((b) => `${b.ownerSessionId}:${liveClaimant(rt.host, b.ownerSessionId)}`).join('|')
    + Object.values(rt.metadata.read().reviews || {}).map((r) => { const s = rt.host?.sessions?.get?.(r.reviewerSessionId); return `|${r.id}:${s?.status}:${s?.archived}`; }).join('');
}

const GONE = (s) => !s || s.archived || s.status === 'exited';

export function ungovernedDescendants(rt, host, cell, openBeads = []) {
  if (typeof host?.sessions?.list !== 'function') return [];
  const doc = rt.metadata.read();
  const governed = new Set([cell.queenSessionId]);
  for (const l of [...Object.values(doc.workerLaunches || {}), ...Object.values(doc.launches || {})]) if (l.sessionId) governed.add(l.sessionId);
  for (const b of doc.bindings?.[cell.id] || []) if (b.active) governed.add(b.sessionId);
  for (const r of Object.values(doc.reviews || {})) if (r.reviewerSessionId) governed.add(r.reviewerSessionId);
  for (const b of openBeads) if (b.ownerSessionId) governed.add(b.ownerSessionId);
  const members = new Set([cell.queenSessionId, ...(doc.bindings?.[cell.id] || []).filter((b) => b.active).map((b) => b.sessionId), ...host.sessions.forTask(cell.taskId).map((s) => s.sessionId)]);
  const all = host.sessions.list();
  const byId = new Map(all.map((s) => [s.sessionId, s]));
  const fromParticipant = (s) => {
    const seen = new Set([s.sessionId]);
    for (let p = s.spawnedBy; p && !seen.has(p); p = byId.get(p)?.spawnedBy) {
      if (members.has(p)) return p;
      seen.add(p);
    }
    return null;
  };
  const out = [];
  for (const s of all) {
    if (governed.has(s.sessionId) || GONE(s)) continue;
    const origin = fromParticipant(s);
    if (!origin) continue;
    out.push({ session_id: s.sessionId, spawned_by: s.spawnedBy, origin_session_id: origin, task_id: s.taskId || null, in_cell_task: s.taskId === cell.taskId, status: s.status, note: 'Started by a cell participant outside Hive; it holds no claim, review or binding. Reconcile it: bind it to a bead, or leave it deliberately untracked. Hive does not claim it for anyone.' });
  }
  return out;
}
