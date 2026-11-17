const ID_KEYS = new Set(['id', 'cellId', 'cellIds', 'hiveId', 'beadId', 'beadIds', 'threadId', 'messageId', 'messageIds', 'requestId', 'reviewId', 'taskId', 'sessionId', 'sessionIds', 'queenSessionId', 'rootBeadId', 'headId', 'launchId', 'opId', 'noticeId', 'replyTo', 'cell_id', 'hive_id', 'bead_id', 'thread_id', 'message_id', 'request_id', 'review_id', 'task_id', 'session_id']);
const CONTAINERS = new Set(['request', 'review', 'queen', 'messages', 'positions', 'position', 'profile', 'policy', 'settings', 'evidence', 'after', 'images', 'attachments', 'beads', 'links', 'target']);
const identifier = value => typeof value === 'string' && /^[\w.:-]{1,128}$/.test(value);

export function identifierPath(path) {
  if (typeof path !== 'string' || path.length > 200) return false;
  const keys = path.split('.');
  return ID_KEYS.has(keys.pop()) && keys.every(key => CONTAINERS.has(key) || /^\d{1,3}$/.test(key));
}

export function actionMetadata(action, requestId, args = {}) {
  const ids = {};
  function visit(value, path = '', depth = 0) {
    if (!value || typeof value !== 'object' || depth > 4) return;
    if (Array.isArray(value)) {
      value.slice(0, 100).forEach((item, index) => visit(item, `${path}.${index}`, depth + 1));
      return;
    }
    for (const [key, item] of Object.entries(value).slice(0, 100)) {
      const field = path ? `${path}.${key}` : key;
      if (ID_KEYS.has(key)) {
        if (identifier(item)) ids[field] = item;
        else if (Array.isArray(item)) ids[field] = item.filter(identifier).slice(0, 100);
      } else if (CONTAINERS.has(key) && item && typeof item === 'object') visit(item, field, depth + 1);
    }
  }
  visit(args);
  return { action: typeof action === 'string' && /^hive-[\w-]{1,100}$/.test(action) ? action : 'hive-unknown', requestId: identifier(requestId) ? requestId : null, ids };
}

export function errorRedactor(args) {
  const content = new Set();
  function visit(value, key = '') {
    if (typeof value === 'string' && value && !ID_KEYS.has(key)) content.add(value);
    else if (Array.isArray(value)) value.forEach(item => visit(item, key));
    else if (value && typeof value === 'object') Object.entries(value).forEach(([k, v]) => visit(v, k));
  }
  visit(args);
  const strings = [...content].sort((a, b) => b.length - a.length);
  return error => {
    let message = typeof error === 'string' ? error : error?.message || 'The action failed.';
    for (const value of strings) message = message.split(value).join('[redacted]');
    return message.slice(0, 1000);
  };
}
