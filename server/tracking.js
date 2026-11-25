import { activeWorkerRestores } from './worker-restores.js';
import { OPEN_REVIEW_STATES } from './review-state.js';
import { GROUP_KINDS } from './bead-model.js';
import { RETIRED_LAUNCH_STATES } from './admission.js';

export function liveClaimant(host, sessionId) {
  const session = sessionId ? host?.sessions?.get?.(sessionId) : null;
  return Boolean(session && !session.archived && session.status !== 'exited');
}

export function workingNow(host, sessionId) {
  const session = sessionId ? host?.sessions?.get?.(sessionId) : null;
  return Boolean(session && !session.archived && !session.dormant && !session.exitOutput && session.status === 'working');
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
  const doc = rt.metadata.read();
  const ids = new Set([
    ...Object.values(rt.snapshots.current.graph.beads).map(b => b.ownerSessionId),
    ...Object.values(doc.bindings || {}).flat().filter(b => b.active).map(b => b.sessionId),
    ...Object.values(doc.workerLaunches || {}).map(l => l.sessionId),
    ...Object.values(doc.reviews || {}).map(r => r.reviewerSessionId),
    ...Object.values(doc.operations || {}).filter(o => o.kind === 'claim').map(o => o.intent?.assignee?.slice(3)),
    ...activeWorkerRestores(rt).keys(),
  ].filter(Boolean));
  return JSON.stringify([
    [...ids].sort().map(id => { const s = rt.host?.sessions?.get?.(id); return [id, Boolean(s), s?.status, s?.archived, s?.dormant, Boolean(s?.exitOutput)]; }),
    [...(rt.spawnAdmissions || [])], [...activeWorkerRestores(rt)],
  ]);
}

export function hasLiveTerminal(session) {
  return Boolean(session && !session.archived && !session.dormant && session.managed !== false && !['exited', 'dormant'].includes(session.status));
}

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
    if (governed.has(s.sessionId)) continue;
    const origin = fromParticipant(s);
    if (!origin) continue;
    out.push({ session_id: s.sessionId, spawned_by: s.spawnedBy, origin_session_id: origin, task_id: s.taskId || null, in_cell_task: s.taskId === cell.taskId, status: s.status, live: hasLiveTerminal(s), note: 'Started by a cell participant outside Hive; it holds no claim, review or binding. Reconcile it: bind it to a bead, or leave it deliberately untracked. Hive does not claim it for anyone.' });
  }
  return out;
}

export const LAUNCH_GRACE_MS = 2 * 60000;

const stampOf = value => typeof value === 'number' && Number.isFinite(value) ? value : typeof value === 'string' ? Date.parse(value) || 0 : 0;

export function startingSession(rt, sessionId, now = Date.now()) {
  if (!sessionId) return false;
  const doc = rt.metadata.read();
  const starts = [];
  const launches = doc.workerLaunches || {};
  const retired = (id) => RETIRED_LAUNCH_STATES.has(launches[id]?.state);
  for (const l of Object.values(launches)) if (l.sessionId === sessionId && !retired(l.id)) starts.push(l.submittedAt, l.createdAt);
  for (const r of Object.values(doc.reviews || {})) if (r.reviewerSessionId === sessionId && OPEN_REVIEW_STATES.has(r.state) && !(r.launchId && retired(r.launchId))) starts.push(r.startedAt);
  for (const list of Object.values(doc.bindings || {})) for (const b of list) if (b.active && b.sessionId === sessionId && (b.workerLaunchId || b.reviewId) && !(b.workerLaunchId && retired(b.workerLaunchId))) starts.push(b.at);
  return starts.some(at => { const t = stampOf(at); return t > 0 && t <= now && now - t < LAUNCH_GRACE_MS; });
}

export function reconcileInactiveBindings(rt, host, now = Date.now()) {
  if (!host?.sessions?.get || rt.metadata.error) return;
  const eligible = (cell) => cell?.enabled && !cell.snapshot;
  const reason = (b) => {
    const session = host.sessions.get(b.sessionId);
    if (session) return session.archived ? 'Session archived' : null;
    return startingSession(rt, b.sessionId, now) ? null : 'Session missing';
  };
  const stale = (b) => b.active && reason(b);
  const doc = rt.metadata.read();
  const cells = Object.keys(doc.bindings || {}).filter(id => eligible(doc.cells[id]) && doc.bindings[id].some(stale));
  if (!cells.length) return;
  rt.metadata.mutate(d => {
    for (const id of cells) for (const b of d.bindings[id] || []) {
      const because = b.active && reason(b);
      if (because) {
        b.active = false;
        b.unboundAt = now;
        b.unboundBy = 'aw:hive-recovery';
        b.unboundBecause = because;
      }
    }
  });
}
