const group = t => t.needsCount > 0 ? 0 : t.unreadCount > 0 ? 1 : 2;

export const compareTopics = (a, b) => group(a) - group(b)
  || (a.lastAt || 0) - (b.lastAt || 0)
  || a.id.localeCompare(b.id);
