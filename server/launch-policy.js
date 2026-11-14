export const DEFAULT_AGENT = 'claude';

export function resolveAgent(agent) {
  const value = typeof agent === 'string' ? agent.trim().toLowerCase() : '';
  return value || DEFAULT_AGENT;
}

export function launchRestriction() {
  return 'unrestricted';
}

export function applyLaunchPolicy(options = {}) {
  const { disallowedTools: _ignored, ...rest } = options;
  return rest;
}
