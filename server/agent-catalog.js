import { readReviewerFront } from './reviewer-front.js';
import { HiveError } from './ops.js';
import { isCurrent, runtimeKey } from './lifetime.js';

const catalogs = new WeakMap();
const REFRESH_MS = 60000;

export async function readAgentCatalog(host) {
  if (typeof host?.agents?.list !== 'function') throw new HiveError('The installed agents list is unavailable (agents:read).', 'refused');
  try {
    const agents = await host.agents.list();
    if (!Array.isArray(agents)) throw new Error('Invalid agents list');
    return agents;
  } catch {
    throw new HiveError('The installed agents list could not be read. Try again before saving reviewers.', 'refused');
  }
}

export function agentCatalogForGraph(rt, host) {
  let state = catalogs.get(runtimeKey(rt));
  if (!state) {
    state = { value: { agents: null, agentsError: '' }, pending: null, checkedAt: 0 };
    catalogs.set(runtimeKey(rt), state);
  }
  if (!state.pending && Date.now() - state.checkedAt >= REFRESH_MS && isCurrent(rt, host)) {
    state.pending = readAgentCatalog(host).then(agents => ({ agents, agentsError: '' }), error => ({ agents: null, agentsError: error.message })).then(async catalog => ({ ...catalog, reviewerFront: await readReviewerFront(host, { agents: catalog.agents }) })).then(value => {
      if (!isCurrent(rt, host)) return;
      const changed = JSON.stringify(value) !== JSON.stringify(state.value);
      state.value = value;
      state.checkedAt = Date.now();
      if (changed) rt.changed();
    }).finally(() => { state.pending = null; }).catch(error => rt.log?.(`hive: agent catalogue refresh failed: ${error.message}`));
  }
  return state.value;
}
