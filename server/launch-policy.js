export const CLAUDE_SPAWN_DENIES = Object.freeze([
  'mcp__agent-wrangler__spawn_session',
  'mcp__agent-wrangler__spawn_workflow',
  'mcp__agent-wrangler__schedule_session',
  'mcp__agent-wrangler__update_schedule',
]);

export const DEFAULT_AGENT = 'claude';

export function resolveAgent(agent) {
  const value = typeof agent === 'string' ? agent.trim().toLowerCase() : '';
  return value || DEFAULT_AGENT;
}

export function spawnToolsDenied(agent) {
  return resolveAgent(agent) === DEFAULT_AGENT;
}

export function launchRestriction(agent) {
  return spawnToolsDenied(agent) ? 'denied' : 'unrestricted';
}

export function applyLaunchPolicy(options = {}) {
  const { disallowedTools: _ignored, ...rest } = options;
  return spawnToolsDenied(rest.agent) ? { ...rest, disallowedTools: [...CLAUDE_SPAWN_DENIES] } : rest;
}
