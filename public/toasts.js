const SEVERITIES = new Set(['success', 'info', 'warning', 'error']);
const REPEAT_MS = 1000;

export function toastSeverity(opts) {
  if (SEVERITIES.has(opts?.severity)) return opts.severity;
  return opts?.brief ? 'info' : 'warning';
}

export function createToaster(getApi, now = () => Date.now()) {
  const recent = new Map();
  return function toast(text, opts = {}) {
    const severity = toastSeverity(opts);
    const key = `${severity}:${text}`;
    const at = now();
    if (at - (recent.get(key) ?? -Infinity) < REPEAT_MS) return true;
    const show = getApi()?.ui?.toast;
    if (typeof show !== 'function') return false;
    const shown = show({ severity, text, ...(opts.detail ? { detail: opts.detail } : {}), ...(opts.actions ? { actions: opts.actions } : {}) }) === true;
    if (shown) {
      recent.set(key, at);
      for (const [k, t] of recent) if (at - t >= REPEAT_MS) recent.delete(k);
    }
    return shown;
  };
}

export function restoreNoticeText(n, placed) {
  return `${n.by === 'hive' || n.by === undefined
    ? `Hive reopened ${n.title || n.headId} (${n.headId})${n.reopened?.length > 1 ? `, with ${n.reopened.filter((r) => r !== n.headId).join(', ')} around it,` : ''} because ${(n.triggers || []).join(', ')}${n.more ? ` and ${n.more} more` : ''} under it ${(n.triggers || []).length + (n.more || 0) === 1 ? 'is' : 'are'} not finished.`
    : `${n.title || n.headId} (${n.headId}) was reopened.`} ${placed || ''}`.trim();
}

export function announceRestoreNotices(seen, hive, toast, send, visible = true) {
  const present = new Set(), pending = [];
  for (const cell of Object.values(hive?.cells || {})) {
    for (const n of cell.restoreNotices || []) {
      const key = JSON.stringify([cell.id, n.id]);
      present.add(key);
      if (!seen.has(key)) pending.push({ key, cell, n });
    }
  }
  for (const key of seen) if (!present.has(key)) seen.delete(key);
  if (!visible || !pending.length) return;
  const texts = pending.map(({ n }) => restoreNoticeText(n, RESTORE_PLACED[n.placed]));
  const opts = pending.length === 1
    ? { severity: 'warning' }
    : { severity: 'warning', detail: texts.join('\n\n') };
  const text = pending.length === 1 ? texts[0] : `Hive reopened ${pending.length} workstreams: ${pending.map(({ n }) => n.headId).join(', ')}.`;
  if (!toast(text, opts)) return;
  for (const { key, cell, n } of pending) {
    seen.add(key);
    send({ type: 'hive-restore-notice-dismiss', cellId: cell.id, noticeId: n.id });
  }
}

const RESTORE_PLACED = {
  restored: 'It is back in its former shape, where it was or at the nearest free spot.',
};
