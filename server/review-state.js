export const OPEN_REVIEW_STATES = new Set(['requested', 'in_review']);

const SHA = /^[a-f0-9]{40}$/i;
const COMMIT = /^[a-f0-9]{7,40}$/i;
const stamp = value => typeof value === 'number' && Number.isFinite(value) ? value : typeof value === 'string' ? Date.parse(value) || 0 : 0;

export function openReview(rt, beadId) {
  return Object.values(rt.metadata.read().reviews || {}).find((r) => r.workBeadId === beadId && OPEN_REVIEW_STATES.has(r.state));
}

export function staleApproval(doc, review) {
  if (review?.state !== 'approved' || review.verdict?.value !== 'approved' || typeof review.commit !== 'string' || !COMMIT.test(review.commit)) return null;
  const approved = review.commit.toLowerCase();
  const approvedAt = stamp(review.verdict.at);
  const heads = Object.values(doc.prLabels || {})
    .filter(pr => pr?.state === 'OPEN' && SHA.test(pr.headSha || '')
      && (!approvedAt || !pr.stateCheckedAt || stamp(pr.stateCheckedAt) >= approvedAt)
      && (pr.associations?.some(a => a.beadId === review.workBeadId && (!review.cellId || !a.cellId || a.cellId === review.cellId))
        || (!pr.associations && pr.beadIds?.includes(review.workBeadId))));
  const moved = heads.filter(pr => !pr.headSha.toLowerCase().startsWith(approved)).map(pr => {
    const head = pr.headSha.toLowerCase();
    return { url: pr.url, head, text: `approved at ${approved.slice(0, 7)}; head now ${head.slice(0, 7)}, re-review needed` };
  });
  return moved.length ? { ...moved[0], approved, prs: moved } : null;
}

function currentReview(doc, beadId) {
  const records = Object.values(doc.reviews || {}).filter((r) => r.workBeadId === beadId);
  return records.find(r => OPEN_REVIEW_STATES.has(r.state)) || records.at(-1);
}

export const beadApprovalStale = (doc, beadId) => staleApproval(doc, currentReview(doc, beadId));

export function reviewFields(rt, beadId) {
  const doc = rt.metadata.read();
  const review = currentReview(doc, beadId);
  if (!review) return {};
  const session = review.reviewerSessionId ? rt.host?.sessions?.get?.(review.reviewerSessionId) : null;
  const active = OPEN_REVIEW_STATES.has(review.state);
  const stale = staleApproval(doc, review);
  return { review, reviewState: stale ? 'stale' : active && (!session || session.archived || session.status === 'exited') ? 'requested' : review.state, ...(stale ? { reviewStale: stale } : {}), reviewWorking: active && !session?.archived && session?.status === 'working' };
}
