export const isHumanRequest = r => Boolean(r && (r.audience === 'human' || (r.audience === 'route-repair' && (r.forwarded || r.routeReason === 'no-queen'))));

export function maySeeRequest(r, viewer = { role: 'human' }) {
  return Boolean(r && (viewer.role === 'queen' || isHumanRequest(r) || (viewer.role !== 'human' && r.requesterSessionId === viewer.sessionId)));
}
