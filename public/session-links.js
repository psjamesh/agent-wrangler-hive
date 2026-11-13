const SESSION_HASH = /^#session=([^&]+)$/;

export function sessionLinkId(href) {
  const m = SESSION_HASH.exec(String(href || ''));
  if (!m) return null;
  try { return decodeURIComponent(m[1]); } catch { return null; }
}

export function sessionLinkProblem(sessions, history, id) {
  if (!Array.isArray(sessions)) return null;
  if (sessions.some((x) => x.sessionId === id)) return null;
  if (Array.isArray(history) && history.some((x) => x.sessionId === id)) return 'That session is archived.';
  return 'That session is not on the board.';
}

const BARE = /(?<![\w/#&?=.-])#session=([A-Za-z0-9_-]+)/g;

export function bareSessionLinks(text) {
  return [...String(text || '').matchAll(BARE)].map((m) => ({ index: m.index, text: m[0], id: m[1] }));
}
