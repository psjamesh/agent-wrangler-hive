export const OPEN_REVIEW_STATES = new Set(['requested', 'in_review']);

export function openReview(rt, beadId) {
  return Object.values(rt.metadata.read().reviews || {}).find((r) => r.workBeadId === beadId && OPEN_REVIEW_STATES.has(r.state));
}

export function reviewFields(rt, beadId) {
  const records = Object.values(rt.metadata.read().reviews || {}).filter((r) => r.workBeadId === beadId);
  const review = openReview(rt, beadId) || records.at(-1);
  if (!review) return {};
  const session = review.reviewerSessionId ? rt.host?.sessions?.get?.(review.reviewerSessionId) : null;
  const active = OPEN_REVIEW_STATES.has(review.state);
  return { review, reviewState: active && (!session || session.archived || session.status === 'exited') ? 'requested' : review.state, reviewWorking: active && !session?.archived && session?.status === 'working' };
}
