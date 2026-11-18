import { safeDeliver } from './sessions.js';
import { runtimeKey, isCurrent } from './lifetime.js';
import { hiveLink } from '../public/deep-links.js';

const active = new WeakMap();
const missed = delivery => ['failed', 'uncertain'].includes(delivery?.state);
const excerpt = value => String(value || '').replace(/\s+/g, ' ').trim().slice(0, 160);
const noticeKey = cell => `${cell.queenSessionId}:${cell.queenGeneration || 0}`;

function queenRequest(doc, cell, request) {
  const card = doc.conversation?.[cell.id]?.find(m => m.id === request.messageId && m.requestId === request.id);
  return card ? card.role === 'queen' : Boolean(request.requesterSessionId && request.requesterSessionId === request.queenSessionId)
    || (cell.queens || []).some(q => q.sessionId === request.requesterSessionId && q.from <= request.createdAt && (q.to == null || request.createdAt <= q.to));
}

const outstandingAnswer = (doc, cell, r) => r.cellId === cell.id && r.state === 'answered' && r.answer?.author === 'human' && missed(r.delivery) && queenRequest(doc, cell, r);

export function acknowledgeRecoveredAnswers(doc, cell, { ids, threadId, sessionId, at }) {
  const acknowledged = [];
  for (const r of Object.values(doc.requests || {})) {
    if (r.cellId !== cell.id || !(ids?.includes(r.id) || ids?.includes(r.messageId) || (threadId && r.threadId === threadId))) continue;
    if (r.delivery?.confirmedByQueen?.sessionId === sessionId) { acknowledged.push(r.id); continue; }
    if (!outstandingAnswer(doc, cell, r)) continue;
    r.delivery = { ...r.delivery, state: 'delivered', confirmedByQueen: { sessionId, at } };
    r.revision = (r.revision || 0) + 1;
    r.updatedAt = at;
    acknowledged.push(r.id);
  }
  return acknowledged;
}

export function missedInput(doc, cell) {
  const topics = doc.threads?.[cell.id] || {};
  const key = noticeKey(cell);
  const messages = (doc.conversation?.[cell.id] || [])
    .filter(m => m.author === 'human' && !m.requestId && !m.acknowledgedAt && !m.response?.answers?.length && !m.response?.withdrawn && missed(m.delivery))
    .map(m => ({ message_id: m.id, thread_id: m.threadId, topic: topics[m.threadId]?.title || 'Earlier messages', excerpt: excerpt(m.text), delivery: m.delivery.state, notice: m.delivery.recoveryNotices?.[key], link: hiveLink(cell.id, m.threadId, m.id) }));
  const answers = Object.values(doc.requests || {})
    .filter(r => outstandingAnswer(doc, cell, r))
    .map(r => ({ request_id: r.id, request_message_id: r.messageId, requester_session_id: r.requesterSessionId, successor_owns_action: r.requesterSessionId !== cell.queenSessionId, answer: r.answer, thread_id: r.threadId, topic: r.title, excerpt: excerpt([(r.options || []).find(o => o.id === r.answer.optionId)?.label || r.answer.optionId, r.answer.text].filter(Boolean).join(': ')), delivery: r.delivery.state, notice: r.delivery.recoveryNotices?.[key], link: hiveLink(cell.id, r.threadId, r.messageId) }));
  return [...messages, ...answers];
}

function deliveryFor(doc, cellId, item) {
  return item.request_id ? doc.requests?.[item.request_id]?.delivery : doc.conversation?.[cellId]?.find(m => m.id === item.message_id)?.delivery;
}

export function notifyMissedInput(rt, host, sessionId, { confirmedDelivery = false } = {}) {
  if (!rt?.metadata || rt.metadata.error || !isCurrent(rt, host)) return Promise.resolve();
  const runtime = runtimeKey(rt);
  if (!active.has(runtime)) active.set(runtime, new Map());
  const sending = active.get(runtime);
  if (sending.has(sessionId)) {
    const pending = sending.get(sessionId);
    return confirmedDelivery ? pending.then(() => notifyMissedInput(rt, host, sessionId, { confirmedDelivery: true })) : pending;
  }
  const pending = Promise.resolve().then(() => sendMissedInput(rt, host, sessionId, confirmedDelivery))
    .catch(err => { rt.log?.(`hive: missed input recovery failed: ${err.message}`); })
    .finally(() => { sending.delete(sessionId); });
  sending.set(sessionId, pending);
  return pending;
}

async function sendMissedInput(rt, host, sessionId, confirmedDelivery) {
  if (!isCurrent(rt, host)) return;
  const doc = rt.metadata.read();
  const cells = Object.values(doc.cells || {}).filter(c => c.enabled && !c.snapshot && c.queenSessionId === sessionId);
  const items = cells.flatMap(cell => missedInput(doc, cell).filter(item => item.notice?.state !== 'delivered' && (confirmedDelivery || !['uncertain', 'pending'].includes(item.notice?.state))).map(item => ({ ...item, cellId: cell.id, key: noticeKey(cell) })));
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
    ...items.map(item => `- ${item.message_id || item.request_id}${item.request_id ? ` (requester ${item.requester_session_id}${item.successor_owns_action ? '; successor queen owns acting' : ''})` : ''} | ${excerpt(item.topic)} | ${item.excerpt} | ${item.link}`),
    'Read hive_context attention.missed_input for the outstanding items and full topics. Answer or acknowledge human messages. Request answers, including predecessor queen requests, are attributed in attention.missed_input; the current queen owns acting on them. Confirm receipt with hive_acknowledge_input using request_id or request_message_id, or publish a reply in that topic. Do not repeat completed actions.',
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
}

export async function notifyReachableQueens(rt, host) {
  if (!rt?.metadata || rt.metadata.error || !isCurrent(rt, host)) return;
  const queens = new Set(Object.values(rt.metadata.read().cells || {}).filter(c => c.enabled && !c.snapshot && c.queenSessionId).map(c => c.queenSessionId));
  for (const queen of queens) {
    if (!isCurrent(rt, host)) return;
    try {
      const session = host.sessions?.get?.(queen);
      if (session && !session.archived && !session.dormant && ['idle', 'working', 'busy'].includes(session.status)) await notifyMissedInput(rt, host, queen);
    } catch (err) {
      rt.log?.(`hive: missed input availability check failed: ${err.message}`);
    }
  }
}
