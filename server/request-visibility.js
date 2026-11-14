import { isHumanRequest } from '../public/request-state.js';
export { isHumanRequest } from '../public/request-state.js';

export function maySeeRequest(r, viewer = { role: 'human' }) {
  return Boolean(r && (viewer.role === 'queen' || isHumanRequest(r) || (viewer.role !== 'human' && r.requesterSessionId === viewer.sessionId)));
}
