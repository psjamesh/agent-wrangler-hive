export function frontPick(front, slot, builderAgent, agents) {
  return (front || []).filter(row => row.agent !== builderAgent
    && (slot.maxUsd === undefined || row.usd <= slot.maxUsd)
    && (slot.minQuality === undefined || row.quality >= slot.minQuality)
    && !/terra/i.test(`${row.agent} ${row.model}`)
    && agents?.some(agent => agent.id === row.agent && agent.available === true && agent.models?.some(model => model.value === row.model
      && !/terra/i.test(model.resolved || '')
      && supportsEffort(agent, model, row.effort))))
    .sort((a, b) => a.usd - b.usd || b.quality - a.quality || a.minutes - b.minutes)[0];
}

function supportsEffort(agent, model, effort) {
  const efforts = model.efforts ?? (agent.efforts || []).map(e => e.value);
  return efforts.length ? efforts.includes(effort) : effort === '';
}
