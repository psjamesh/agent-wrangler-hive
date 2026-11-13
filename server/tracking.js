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
