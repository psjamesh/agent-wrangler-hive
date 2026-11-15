export function frontPick(front, slot, builderAgent, agents) {
  return (front || []).filter(row => row.agent !== builderAgent
    && (slot.maxUsd === undefined || row.usd <= slot.maxUsd)
    && row.quality >= qualityFloor(slot)
    && !/terra/i.test(`${row.agent} ${row.model}`)
    && agents?.some(agent => agent.id === row.agent && agent.available === true && agent.models?.some(model => model.value === row.model
      && !/terra/i.test(model.resolved || '')
      && supportsEffort(agent, model, row.effort))))
    .sort((a, b) => (slot.tier === 'strongest' ? b.quality - a.quality || a.usd - b.usd : a.usd - b.usd || b.quality - a.quality) || a.minutes - b.minutes)[0];
}

function supportsEffort(agent, model, effort) {
  const efforts = model.efforts ?? (agent.efforts || []).map(e => e.value);
  return efforts.length ? efforts.includes(effort) : effort === '';
}

export function reviewerSlot(policy, builderAgent) {
  return (builderAgent && ['primary', 'secondary'].find(slot => policy[slot].agent !== builderAgent)) || 'primary';
}

export function qualityFloor(slot) {
  return slot.tier === 'strongest' ? 0 : slot.tier === 'cheapest' ? slot.minQuality ?? 55 : 55;
}

export const FRONT_LIMITATION = 'The host returns a global model front. Settings dominated by the builder’s provider or by Terra can be missing, even when they meet this tier.';
export const TIER_FALLBACK_WARNING = 'Using configured fallback or installed host defaults; the selected tier is not guaranteed.';
