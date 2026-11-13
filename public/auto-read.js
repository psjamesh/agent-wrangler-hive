import { visibleBand } from './dom.js';

export const afterFrame = callback => (globalThis.requestAnimationFrame || (fn => setTimeout(fn, 16)))(callback);

export function createReadTracker(ui, cellId, threadId) {
  const edges = new Map();
  const pending = new Map();
  const held = new Set();
  let active, frame = false, timer = null, sending = false;
  const available = () => active?.list.isConnected && active.list.clientWidth > 0 && document.visibilityState === 'visible' && document.hasFocus?.() === true && ui.cellId() === cellId && ui.openThread(cellId) === threadId;
  const ready = () => available() && active.list.hiveReadReady && !active.list.hivePending && !ui.startPending(`${cellId}:${threadId}`) && !ui.linkedMessage?.(cellId, threadId)?.pending;
  const discard = () => {
    for (const id of pending.keys()) edges.delete(id);
    pending.clear();
  };
  const later = () => {
    if (!timer && pending.size && !sending) timer = setTimeout(flush, 120);
  };
  function flush() {
    timer = null;
    if (!available()) { discard(); return; }
    if (!ready()) return;
    if (active.ctx.busy('hive-ack') || active.ctx.busy('hive-ack-undo')) { later(); return; }
    const messages = [];
    for (const [id, observed] of pending) {
      const ack = ui.ackOf(cellId, observed);
      pending.delete(id);
      if (ack?.required && !ack.state && ack.rev === observed.ack.rev && !held.has(id)) messages.push({ messageId: id, rev: ack.rev });
      if (messages.length === 100) break;
    }
    if (!messages.length) { later(); return; }
    sending = true;
    active.ctx.send({ type: 'hive-auto-read', cellId, messages }, {
      quiet: true,
      onReply(reply) {
        sending = false;
        if (reply.ok) {
          if (reply.acks?.length) ui.noteReadBatch(cellId, reply.acks);
        } else {
          for (const m of messages) {
            const seen = edges.get(m.messageId);
            if (seen?.rev !== m.rev) continue;
            seen.queued = false;
            seen.failures = (seen.failures || 0) + 1;
            seen.retryAt = Date.now() + Math.min(30000, 1000 * 2 ** Math.min(seen.failures - 1, 5));
          }
          active.ctx.notice(reply.error || 'Could not mark the messages read.', { severity: 'error' });
        }
        later();
      },
    });
  }
  const sample = () => {
    frame = false;
    if (!available()) { discard(); return; }
    if (!ready()) return;
    const band = visibleBand(active.list);
    if (band.bottom <= band.top) { discard(); return; }
    const inside = edge => edge >= band.top - 0.5 && edge <= band.bottom + 0.5;
    for (const m of active.messages) {
      const item = active.list.querySelector(`[data-id="${CSS.escape(m.id)}"]`);
      const rect = item?.getBoundingClientRect();
      if (!rect) continue;
      if (rect.bottom < band.top || rect.top > band.bottom) {
        held.delete(m.id);
        continue;
      }
      if (held.has(m.id)) continue;
      const ack = ui.ackOf(cellId, m);
      if (m.author === 'human' || ack?.state) continue;
      const rev = ack?.rev ?? null;
      const seen = edges.get(m.id)?.rev === rev ? edges.get(m.id) : { rev, top: false, bottom: false, queued: false };
      seen.top ||= inside(rect.top);
      seen.bottom ||= inside(rect.bottom);
      edges.set(m.id, seen);
      if (seen.top && seen.bottom && !seen.queued && !(seen.retryAt > Date.now())) {
        seen.queued = true;
        if (ack?.required) pending.set(m.id, { ...m, ack });
        else ui.markMessageRead(cellId, m.id, m.at);
      }
    }
    later();
  };
  return {
    attach(list, messages, ctx) { active = { list, messages, ctx }; },
    shown() { if (!frame) { frame = true; afterFrame(sample); } },
    undo(messageId) {
      edges.delete(messageId);
      pending.delete(messageId);
      held.add(messageId);
    },
  };
}
