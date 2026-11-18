import { safeDeliver } from './sessions.js';
import { runtimeKey, isCurrent } from './lifetime.js';
import { hiveLink } from '../public/deep-links.js';

const active = new WeakMap();
const missed = delivery => ['failed', 'uncertain'].includes(delivery?.state);
const excerpt = value => String(value || '').replace(/\s+/g, ' ').trim().slice(0, 160);
const noticeKey = cell => `${cell.queenSessionId}:${cell.queenGeneration || 0}`;

export function missedInput(doc, cell) {
  const topics = doc.threads?.[cell.id] || {};
  const key = noticeKey(cell);
  const messages = (doc.conversation?.[cell.id] || [])
    .filter(m => m.author === 'human' && !m.requestId && !m.acknowledgedAt && !m.response?.answers?.length && !m.response?.withdrawn && missed(m.delivery))
    .map(m => ({ message_id: m.id, thread_id: m.threadId, topic: topics[m.threadId]?.title || 'Earlier messages', excerpt: excerpt(m.text), delivery: m.delivery.state, notice: m.delivery.recoveryNotices?.[key], link: hiveLink(cell.id, m.threadId, m.id) }));
  const answers = Object.values(doc.requests || {})
    .filter(r => r.cellId === cell.id && r.state === 'answered' && r.answer?.author === 'human' && r.requesterSessionId === cell.queenSessionId && missed(r.delivery))
    .map(r => ({ request_id: r.id, thread_id: r.threadId, topic: r.title, excerpt: excerpt([(r.options || []).find(o => o.id === r.answer.optionId)?.label || r.answer.optionId, r.answer.text].filter(Boolean).join(': ')), delivery: r.delivery.state, notice: r.delivery.recoveryNotices?.[key], link: hiveLink(cell.id, r.threadId, r.messageId) }));
  return [...messages, ...answers];
}

function deliveryFor(doc, cellId, item) {
  return item.request_id ? doc.requests?.[item.request_id]?.delivery : doc.conversation?.[cellId]?.find(m => m.id === item.message_id)?.delivery;
}

export async function notifyMissedInput(rt, host, sessionId) {
  if (!rt || rt.metadata.error || !isCurrent(rt, host)) return;
  const runtime = runtimeKey(rt);
  if (!active.has(runtime)) active.set(runtime, new Set());
  const sending = active.get(runtime);
  if (sending.has(sessionId)) return;
  sending.add(sessionId);
  try {
    const doc = rt.metadata.read();
    const cells = Object.values(doc.cells || {}).filter(c => c.enabled && !c.snapshot && c.queenSessionId === sessionId);
    const items = cells.flatMap(cell => missedInput(doc, cell).filter(item => item.notice?.state !== 'delivered').map(item => ({ ...item, cellId: cell.id, key: noticeKey(cell) })));
    if (!items.length) return;
    const recipient = host.sessions?.get?.(sessionId);
    if (!recipient || recipient.archived || typeof host.deliver !== 'function') return;
    const at = Date.now();
    rt.metadata.mutate(d => {
      for (const item of items) {
        const delivery = deliveryFor(d, item.cellId, item);
        (delivery.recoveryNotices ||= {})[item.key] = { state: 'pending', at };
      }
    });
    const body = [
      `[Hive] Recover human input after a delivery outage: ${items.length} item(s).`,
      'These messages or human request answers had failed or uncertain delivery. The original attempts have not been repeated; some input may already have reached you.',
      ...items.map(item => `- ${item.message_id || item.request_id} | ${excerpt(item.topic)} | ${item.excerpt} | ${item.link}`),
      'Read hive_context attention.missed_input for the outstanding items and full topics. Answer or acknowledge human messages; recover attributed request answers with hive_list_my_requests. Do not repeat completed actions.',
    ].join('\n');
    const outcome = await safeDeliver(host, sessionId, body, rt);
    if (!isCurrent(rt, host)) return;
    rt.metadata.mutate(d => {
      for (const item of items) {
        const receipt = deliveryFor(d, item.cellId, item)?.recoveryNotices?.[item.key];
        if (receipt?.at === at) Object.assign(receipt, outcome, { finishedAt: Date.now() });
      }
    });
    rt.changed();
    return outcome;
  } catch (err) {
    rt.log?.(`hive: missed input recovery failed: ${err.message}`);
  } finally {
    sending.delete(sessionId);
  }
}
