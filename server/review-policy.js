import { frontForBuilder, frontPick, reviewerSlot, qualityFloor, FRONT_LIMITATION, TIER_FALLBACK_WARNING } from '../public/reviewer-front.js';
import { readAgentCatalog } from './agent-catalog.js';
import { assertCurrent } from './lifetime.js';
import { HiveError } from './ops.js';

export const REVIEW_POLICY_DEFAULTS = Object.freeze({
  primary: Object.freeze({ agent: 'claude', model: 'opus', effort: 'medium' }),
  secondary: Object.freeze({ agent: 'codex', model: 'gpt-6.1-sol', effort: 'medium' }),
});

const FIELDS = ['agent', 'model', 'effort'];
const BANNED_MODEL = /terra/i;

function config(value, fallback) {
  return Object.fromEntries(FIELDS.map((f) => [f, typeof value?.[f] === 'string' && (f === 'effort' || value[f].trim()) ? value[f].trim() : fallback[f]]));
}

export function reviewPolicy(cell) {
  return Object.fromEntries(Object.entries(REVIEW_POLICY_DEFAULTS).map(([slot, fallback]) => {
    const value = cell?.reviewPolicy?.[slot];
    return [slot, { ...config(value, fallback), ...(!value || value.mode === 'automatic' ? { mode: 'automatic', tier: value?.tier || 'balanced', minQuality: 55, ...Object.fromEntries(['minQuality', 'maxUsd'].filter(k => value?.[k] !== undefined).map(k => [k, value[k]])) } : {}) }];
  }));
}

export function assertAllowedModel(config, label = 'worker') {
  if (['agent', 'model', 'resolvedModel'].some(key => BANNED_MODEL.test(config[key] || ''))) throw new HiveError(`The ${label} cannot use a Terra model.`, 'refused');
}

export function assertAllowedReviewer(config, slot = 'review') {
  assertAllowedModel(config, `${slot} reviewer`);
}

export async function setReviewPolicy(rt, { cellId, policy }, host = rt.host) {
  const cell = rt.metadata.cell(cellId);
  if (!cell) throw new HiveError('Unknown hive.');
  if (cell.snapshot) throw new HiveError('This hive is a captured snapshot and is read only.');
  if (!policy || typeof policy !== 'object' || Array.isArray(policy) || Object.keys(policy).some((k) => !['primary', 'secondary'].includes(k)) || !Object.keys(policy).length) {
    throw new HiveError('Review policy needs primary and/or secondary, each with agent, model and effort.');
  }
  const updates = {};
  for (const [slot, value] of Object.entries(policy)) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((k) => ![...FIELDS, 'mode', 'tier', 'minQuality', 'maxUsd'].includes(k)) || (value.mode !== undefined && !['pinned', 'automatic'].includes(value.mode))
      || FIELDS.some((f) => typeof value[f] !== 'string' || (f !== 'effort' && !value[f].trim()) || value[f].length > 120)) {
      throw new HiveError(`The ${slot} reviewer needs an agent, model and effort.`);
    }
    if (value.tier !== undefined && !['balanced', 'strongest', 'cheapest'].includes(value.tier)) throw new HiveError('Unknown reviewer tier.');
    if ((value.minQuality !== undefined && (!Number.isFinite(value.minQuality) || value.minQuality < 0 || value.minQuality > 100)) || (value.maxUsd !== undefined && (!Number.isFinite(value.maxUsd) || value.maxUsd <= 0))) throw new HiveError('Reviewer quality must be 0–100 and cost cap must be positive.');
    assertAllowedReviewer(value, slot);
    updates[slot] = { ...config(value, REVIEW_POLICY_DEFAULTS[slot]), ...(value.mode === 'automatic' ? { mode: 'automatic', tier: value.tier || 'balanced', minQuality: value.minQuality ?? 55, ...(value.maxUsd !== undefined ? { maxUsd: value.maxUsd } : {}) } : {}) };
  }
  const agents = await readAgentCatalog(host);
  assertCurrent(rt, host);
  const current = rt.metadata.cell(cellId);
  if (!current || current.snapshot) throw new HiveError('This hive is no longer writable.', 'refused');
  const next = { ...reviewPolicy(current), ...updates };
  for (const [slot, value] of Object.entries(next)) {
    if (value.mode === 'automatic') continue;
    const agent = agents.find(a => a.id === value.agent);
    if (!agent) throw new HiveError(`The ${slot} reviewer agent is not installed.`, 'refused');
    if (agent.available !== true) throw new HiveError(`The ${slot} reviewer agent is unavailable: ${agent.reason || 'CLI not installed or unavailable'}.`, 'refused');
    const model = agent.models?.find(m => m.value === value.model);
    if (!model) throw new HiveError(`The ${slot} reviewer model is not installed for ${agent.label || agent.id}.`, 'refused');
    assertAllowedReviewer({ ...value, resolvedModel: model.resolved }, slot);
    const efforts = model.efforts ?? (agent.efforts || []).map(e => e.value);
    if (efforts.length ? !efforts.includes(value.effort) : value.effort !== '') throw new HiveError(`The ${slot} reviewer effort is not supported by this model.`, 'refused');
  }
  rt.metadata.mutate((d) => { d.cells[cellId].reviewPolicy = Object.fromEntries(Object.entries(next).map(([slot, value]) => [slot, { mode: 'pinned', ...value }])); });
  return { cellId, policy: next };
}

export function chooseReviewer(cell, builderAgent, agents, frontResult) {
  frontResult = frontForBuilder(frontResult, builderAgent);
  const policy = reviewPolicy(cell);
  const pinned = policy[reviewerSlot(policy, builderAgent)];
  const pinnedConfig = config(pinned, REVIEW_POLICY_DEFAULTS.primary);
  let selection;
  const scope = frontResult?.scope || 'global-front';
  const limitation = scope === 'global-front' ? FRONT_LIMITATION : undefined;
  if (pinned.mode === 'automatic') {
    const pick = builderAgent && frontPick(frontResult?.front, pinned, builderAgent, agents);
    if (pick) return { config: config(pick, pinnedConfig), sameProvider: false, ...(!builderAgent ? { unknownBuilder: true } : {}), selection: { mode: 'automatic', scope, limitation, reason: `${pinned.tier === 'strongest' ? 'Highest-quality' : 'Cheapest'} installed model on the host front meeting the tier and differing from the builder.`, tier: { name: pinned.tier, minQuality: qualityFloor(pinned), maxUsd: pinned.maxUsd }, pick, read: frontResult.read } };
    selection = { mode: 'automatic', scope, limitation, warning: TIER_FALLBACK_WARNING, tier: { name: pinned.tier, minQuality: qualityFloor(pinned), maxUsd: pinned.maxUsd }, reason: !builderAgent ? 'Builder provider unknown; using configured policy.' : frontResult?.error || `No eligible different-provider row meets this tier on the ${scope === 'eligible-front' ? 'eligible host front.' : 'global host front. Settings dominated by the builder provider or Terra may be absent.'} Using configured fallback; tier is not guaranteed.` };
  }
  const chosen = { ...(selection ? { selection } : {}), config: pinnedConfig, sameProvider: Boolean(builderAgent && pinned.agent === builderAgent), ...(!builderAgent ? { unknownBuilder: true } : {}) };
  if (!agents || installedReviewer(agents, pinnedConfig)) return chosen;
  const candidates = agents.filter(a => a.available === true).flatMap(agent => {
    const models = [...(agent.models || [])].sort((a, b) => Number(Boolean(b.default)) - Number(Boolean(a.default)));
    return models.map(model => {
      const efforts = model.efforts ?? (agent.efforts || []).map(e => e.value);
      return { agent: agent.id, model: model.value, effort: efforts.includes(model.autoEffort) ? model.autoEffort : efforts[0] || '' };
    }).filter(value => installedReviewer(agents, value));
  });
  const fallback = candidates.find(c => c.agent !== builderAgent) || candidates[0];
  if (!fallback) throw new HiveError('No installed reviewer model is available for Automatic fallback.', 'refused');
  return { ...chosen, config: fallback, sameProvider: Boolean(builderAgent && fallback.agent === builderAgent), fallback: { reason: 'Pinned reviewer no longer available; using Automatic host defaults.', pinned: pinnedConfig } };
}

export function installedReviewer(agents, value) {
  const agent = agents.find(a => a.id === value.agent && a.available === true);
  const model = agent?.models?.find(m => m.value === value.model);
  if (!model) return false;
  const efforts = model.efforts ?? (agent.efforts || []).map(e => e.value);
  if (efforts.length ? !efforts.includes(value.effort) : value.effort !== '') return false;
  try { assertAllowedReviewer({ ...value, resolvedModel: model.resolved }); return true; }
  catch { return false; }
}
