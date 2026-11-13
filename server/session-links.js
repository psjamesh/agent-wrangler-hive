import { HiveError } from './ops.js';
import { isSessionId } from './bead-model.js';

export function sessionReference(host, { session_id, session_label }) {
  if (session_id === undefined) {
    if (session_label !== undefined) throw new HiveError('session_label requires session_id.');
    return undefined;
  }
  if (!isSessionId(session_id)) throw new HiveError('session_id must be a full board session id.');
  if (session_label !== undefined && (typeof session_label !== 'string' || !session_label.trim() || session_label.length > 200)) throw new HiveError('session_label must be nonempty text of at most 200 characters.');
  if (!host?.sessions?.get(session_id)) throw new HiveError('Unknown session on the board.');
  return { sessionId: session_id, label: session_label?.trim() || 'Open session' };
}

export function availableSessionHref(host, id) {
  if (!id) return null;
  try {
    const session = host.sessions.get(id);
    return session && !session.archived ? `#session=${encodeURIComponent(id)}` : null;
  } catch { return null; }
}
