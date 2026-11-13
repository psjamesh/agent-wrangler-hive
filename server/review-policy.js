import { HiveError } from './ops.js';

export const REVIEW_POLICY_DEFAULTS = Object.freeze({
  primary: Object.freeze({ agent: 'claude', model: 'opus', effort: 'medium' }),
  secondary: Object.freeze({ agent: 'codex', model: 'gpt-6.1-sol', effort: 'medium' }),
});

const FIELDS = ['agent', 'model', 'effort'];
const BANNED_MODEL = /terra/i;

function config(value, fallback) {
  return Object.fromEntries(FIELDS.map((f) => [f, typeof value?.[f] === 'string' && value[f].trim() ? value[f].trim() : fallback[f]]));
}

export function reviewPolicy(cell) {
  return { primary: config(cell?.reviewPolicy?.primary, REVIEW_POLICY_DEFAULTS.primary), secondary: config(cell?.reviewPolicy?.secondary, REVIEW_POLICY_DEFAULTS.secondary) };
}

export function assertAllowedReviewer(config, slot = 'review') {
  if (BANNED_MODEL.test(config.model || '') || BANNED_MODEL.test(config.agent || '')) throw new HiveError(`The ${slot} reviewer cannot use a Terra model; it is not allowed for reviews.`, 'refused');
}

export function setReviewPolicy(rt, { cellId, policy }) {
  const cell = rt.metadata.cell(cellId);
  if (!cell) throw new HiveError('Unknown hive.');
  if (cell.snapshot) throw new HiveError('This hive is a captured snapshot and is read only.');
  if (!policy || typeof policy !== 'object' || Array.isArray(policy) || Object.keys(policy).some((k) => !['primary', 'secondary'].includes(k)) || !Object.keys(policy).length) {
    throw new HiveError('Review policy needs primary and/or secondary, each with agent, model and effort.');
  }
  const next = reviewPolicy(cell);
  for (const [slot, value] of Object.entries(policy)) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((k) => !FIELDS.includes(k))
      || FIELDS.some((f) => typeof value[f] !== 'string' || !value[f].trim() || value[f].length > 120)) {
      throw new HiveError(`The ${slot} reviewer needs an agent, model and effort.`);
    }
    assertAllowedReviewer(value, slot);
    next[slot] = config(value, REVIEW_POLICY_DEFAULTS[slot]);
  }
  rt.metadata.mutate((d) => { d.cells[cellId].reviewPolicy = next; });
  return { cellId, policy: next };
}

export function chooseReviewer(cell, builderAgent) {
  const policy = reviewPolicy(cell);
  if (!builderAgent) return { config: policy.primary, sameProvider: false, unknownBuilder: true };
  const differing = [policy.primary, policy.secondary].find((c) => c.agent !== builderAgent);
  return differing ? { config: differing, sameProvider: false } : { config: policy.primary, sameProvider: true };
}
