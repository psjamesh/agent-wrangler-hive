import { actorFor } from './bead-model.js';
import { OPEN_REVIEW_STATES } from './review-state.js';
import { watchdogSettings } from './watchdog.js';

export const API_ROLES = Object.freeze({ work: 'worker', review: 'reviewer', helper: 'investigator' });
const FROM_STORED = Object.freeze({ worker: 'work', reviewer: 'review', investigator: 'helper' });

export function storedRole(role) {
  return API_ROLES[role] || role;
}

export function apiRole(role) {
  return FROM_STORED[role] || role;
}

const stamp = (value) => typeof value === 'number' && Number.isFinite(value) ? value : typeof value === 'string' ? Date.parse(value) || 0 : 0;

function liveSession(host, sessionId) {
  const s = host.sessions.get(sessionId);
  return Boolean(s && !s.archived && s.status !== 'exited');
}

export function holdsBead(rt, host, sessionId, beadId) {
  const bead = rt.snapshots.graph.beads[beadId];
  return Boolean(bead && bead.status !== 'closed' && bead.assignee === actorFor(sessionId) && liveSession(host, sessionId));
}

export function attachmentsFor(rt, host, beadId) {
  const doc = rt.metadata.read();
  const reviews = Object.values(doc.reviews || {}).filter((r) => r.workBeadId === beadId);
  const out = [];
  const seen = new Set();
  for (const list of Object.values(doc.bindings || {})) {
    for (const b of list) {
      if (b.beadId !== beadId || !['worker', 'reviewer', 'investigator'].includes(b.role)) continue;
      const s = host.sessions.get(b.sessionId);
      const live = b.active && liveSession(host, b.sessionId);
      const review = b.reviewId ? doc.reviews[b.reviewId] : null;
      if (b.active) seen.add(b.sessionId);
      out.push({
        session_id: b.sessionId, role: apiRole(b.role), launched_by: b.boundBy || null, started_at: b.at || null,
        ended_at: b.unboundAt || (live ? null : (s?.archivedAt || b.at || null)), live,
        agent: s?.agent || null, model: s?.model || null, effort: s?.effort || null,
        ...(review ? { review_id: review.id, review_state: review.state, round: reviews.slice(0, reviews.indexOf(review)).reduce((n, r) => n + (r.round || 1), review.round || 1), same_provider: review.policy?.sameProvider ?? null, override_reason: review.policy?.overrideReason || null } : {}),
      });
    }
  }
  const bead = rt.snapshots.graph?.beads?.[beadId];
  const holder = bead?.assignee?.startsWith('aw:') ? bead.assignee.slice(3) : null;
  if (holder && !seen.has(holder)) {
    const s = host.sessions.get(holder);
    out.push({ session_id: holder, role: 'work', launched_by: null, started_at: null, ended_at: null, live: liveSession(host, holder), agent: s?.agent || null, model: s?.model || null, effort: s?.effort || null });
  }
  return out;
}

export function deriveActivity(rt, host, cell, bead, now = Date.now()) {
  const atts = attachmentsFor(rt, host, bead.id);
  const doc = rt.metadata.read();
  const pendingVerdict = Object.values(doc.reviews || {}).some((r) => r.workBeadId === bead.id && r.verdict && OPEN_REVIEW_STATES.has(r.state));
  const liveReview = atts.some((a) => a.role === 'review' && a.live && OPEN_REVIEW_STATES.has(a.review_state));
  const inReview = liveReview || pendingVerdict;
  const working = atts.some((a) => a.role === 'work' && a.live && host.sessions.get(a.session_id)?.status === 'working');
  const claimed = Boolean(bead.assignee) && bead.status === 'in_progress';
  const threshold = watchdogSettings(cell).workerMinutes * 60000;
  const active = atts.filter((a) => a.live).some((a) => {
    const s = host.sessions.get(a.session_id);
    return s?.status === 'working' || now - stamp(s?.lastActivity) < threshold;
  });
  const idle = claimed && !inReview && !working && !active;
  return { state: inReview ? 'in_review' : working ? 'working' : idle ? 'idle' : null, in_review: inReview, working, idle };
}
