import { needsHuman } from '../public/request-state.js';
import { sessionReference } from './session-links.js';
import { requestOptions, requireOptionsForChoices } from './request-options.js';
import { removeAttachmentBatch } from './attachments.js';
import { pruneConversation, audienceConversationDoc, preserveRequestAudience, preservePublicSequence } from './conversation.js';
import { isHumanRequest, maySeeRequest } from './request-visibility.js';
import { newId } from './metadata-store.js';
import { participation, requireBeadAccess } from './access.js';
import { isSessionId } from './bead-model.js';
import { HiveError } from './ops.js';
import { safeDeliver } from './sessions.js';
import { hiveLink } from '../public/deep-links.js';
export { needsHuman } from '../public/request-state.js';

export const OPEN_PER_SESSION = 20;
const OPEN_TOTAL = 1000;
const HISTORY_CAP = 500;
const deliveries = new WeakMap();
const values = rt => Object.values(rt.metadata.read().requests || {});
const fail = (message, code = 'invalid') => { throw new HiveError(message, code); };
const bounded = (v, name, max, required = false) => {
  if (v === undefined && !required) return '';
  if (typeof v !== 'string' || (required && !v.trim()) || v.length > max) fail(`${name} must be ${required ? 'nonempty ' : ''}text of at most ${max} characters.`);
  return v.trim();
};
function ready(rt) {
  rt.metadata.lifetime?.assertCurrent();
  if (rt.metadata.error) fail(rt.metadata.error, 'metadata-unavailable');
}
function session(host, id) {
  try { return host.sessions.get(id); }
  catch { fail('Hive could not establish session availability.', 'metadata-unavailable'); }
}
function caller(rt, host, id) {
  ready(rt);
  if (!isSessionId(id)) fail('This request has no session identity.', 'access');
  const s = session(host, id);
  if (!s || s.archived) fail('Missing or archived sessions cannot use native requests.', 'access');
  return s;
}
function member(rt, host, id, cellId) {
  caller(rt, host, id);
  try { host.tasks.forSession(id); }
  catch { fail('Hive membership is unavailable.', 'metadata-unavailable'); }
  const mine = participation(rt, host, id);
  const p = cellId ? mine.find(p => p.cell.id === cellId) : mine.length === 1 ? mine[0] : null;
  if (!p && mine.length > 1 && !cellId) fail(`Several Hive cells are available (${mine.map(p => p.cell.id).join(', ')}); pass cell_id.`, 'access');
  if (!p) fail('This session is not in that active Hive cell. Use the standard request_human_input tool if available. Ask your launcher or queen to check your task assignment or binding.', 'access');
  return { ...p, sessionId: id, cells: mine };
}
function get(rt, id) {
  ready(rt);
  if (typeof id !== 'string' || !/^hreq_[0-9a-f]{12}$/.test(id)) fail('Unknown or unavailable Hive request.');
  const r = rt.metadata.read().requests?.[id];
  if (!r || r.id !== id) fail('Unknown or unavailable Hive request.');
  return r;
}
const link = r => hiveLink(r.cellId, r.threadId, r.messageId);
const present = r => ({ ...r, link: link(r), next_step: r.state === 'open' ? `${r.audience === 'queen' ? `Queued with queen ${r.queenSessionId}; the human has not been asked.` : 'The human has been asked.'} ${r.blocking ? 'End this turn and recover the answer with hive_list_my_requests or its delivery notice.' : 'Continue independent work and recover with hive_list_my_requests.'}` : 'Recover the attributed answer or resolution with hive_list_my_requests.' });
function prune(d) {
  const closed = Object.values(d.requests).filter(r => r.state === 'resolved' || (r.state === 'answered' && r.delivery?.state === 'delivered')).sort((a, b) => b.updatedAt - a.updatedAt || b.id.localeCompare(a.id));
  for (const r of closed.slice(HISTORY_CAP)) {
    preserveRequestAudience(d, r);
    delete d.requests[r.id];
  }
}
function update(rt, id, fn) {
  let out;
  rt.metadata.mutate(d => {
    const r = d.requests[id];
    fn(r, d);
    r.updatedAt = Date.now();
    r.revision++;
    prune(d);
    out = structuredClone(r);
  });
  rt.changed();
  return out;
}
function expected(r, args) {
  if (r.state !== 'open') fail('This request is already answered or closed.', 'conflict');
  if (args.revision !== r.revision || args.route_revision !== r.routeRevision) fail('The request or route changed; review its current revision before submitting.', 'conflict');
}
function queenRoute(host, cell) {
  if (!cell?.queenSessionId) return null;
  const q = session(host, cell.queenSessionId);
  return q && !q.archived ? cell.queenSessionId : null;
}
export function reconcileRequests(rt, host, { now = Date.now(), startup = false, requestId = null } = {}) {
  ready(rt);
  for (const r of requestId ? [get(rt, requestId)] : values(rt)) {
    if (r.state === 'open') {
      let requester;
      try { requester = session(host, r.requesterSessionId); } catch { continue; }
      if (!requester || requester.archived) {
        update(rt, r.id, x => { x.state = 'resolved'; x.closedAt = now; x.resolution = { reason: requester ? 'requester-archived' : 'requester-missing', by: 'hive', at: now }; });
        continue;
      }
    }
    if (r.state === 'open' && r.expiresAt && r.expiresAt <= now) {
      update(rt, r.id, x => { x.state = 'resolved'; x.closedAt = now; x.resolution = { reason: 'expired', by: 'hive', at: now }; x.resolutionDelivery = { state: 'pending', attempts: [] }; });
      continue;
    }
    if (r.state === 'open' && r.audience === 'queen') {
      const cell = rt.metadata.cell(r.cellId);
      if (!cell || cell.snapshot || !cell.enabled) {
        if (r.warning !== 'Hive is unavailable; queen routing is paused') update(rt, r.id, x => { x.warning = 'Hive is unavailable; queen routing is paused'; });
      } else {
        let target;
        try { target = queenRoute(host, cell); } catch { continue; }
        if (target !== r.queenSessionId || (cell.queenGeneration || 0) !== r.queenGeneration) update(rt, r.id, x => {
          x.queenSessionId = target; x.queenGeneration = cell.queenGeneration || 0; x.routeRevision++;
          x.audience = target ? 'queen' : 'human'; x.routeReason = target ? null : 'no-queen';
          x.warning = target ? null : 'No queen in this hive'; x.queenNotification = { state: 'pending', attempts: [] };
        });
      }
    }
    if (startup) for (const field of ['delivery', 'queenNotification', 'resolutionDelivery']) {
      const current = get(rt, r.id);
      if (current[field]?.state === 'pending' && current[field].attempts?.length) update(rt, r.id, x => { x[field].state = 'uncertain'; x[field].error = 'Interrupted delivery; check receipt before retrying.'; });
    }
  }
}
export async function createRequest(rt, host, id, args) {
  const actor = member(rt, host, id, args.cell_id);
  reconcileRequests(rt, host);
  const title = bounded(args.title, 'title', 200, true), body = bounded(args.body, 'body', 20000, true);
  const kind = args.kind || 'question';
  if (!['question', 'decision', 'approval', 'manual-action'].includes(kind)) fail('Unknown request kind.');
  const options = requestOptions(args.options);
  if (args.allow_free_text !== undefined && typeof args.allow_free_text !== 'boolean') fail('allow_free_text must be a boolean.');
  const key = bounded(args.dedupe_key, 'dedupe_key', 120);
  const old = key && values(rt).find(r => r.cellId === actor.cell.id && r.requesterSessionId === id && r.dedupeKey === key && r.state === 'open');
  const sessionLink = sessionReference(host, args) || old?.sessionLink;
  requireOptionsForChoices({ kind: args.kind || old?.kind || 'question', body }, options);
  if (old) {
    if ((args.bead_id && args.bead_id !== old.beadId) || (args.thread_id && args.thread_id !== old.threadId)) fail('A dedupe update cannot move request context.');
    const nextKind = args.kind || old.kind;
    const expiresAt = args.expires_at === undefined ? old.expiresAt : args.expires_at;
    if (expiresAt && (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now())) fail('expires_at must be a future timestamp in milliseconds.');
    if (JSON.stringify(sessionLink) === JSON.stringify(old.sessionLink) && title === old.title && body === old.body && nextKind === old.kind && (args.blocking === undefined || args.blocking === old.blocking) && expiresAt === old.expiresAt && JSON.stringify(options) === JSON.stringify(old.options || [])) return present(old);
    update(rt, old.id, x => {
      if (sessionLink) x.sessionLink = sessionLink;
      x.title = title; x.body = body; x.kind = nextKind; x.expiresAt = expiresAt; x.options = options; x.allowFreeText = true;
      if (args.blocking !== undefined) x.blocking = args.blocking === true;
      x.contentRevision++;
      if (x.audience === 'queen') x.queenNotification = { state: 'pending', attempts: [] };
    });
    await notifyQueen(rt, host, old.id);
    return present(get(rt, old.id));
  }
  const open = values(rt).filter(r => r.state === 'open' || (r.state === 'answered' && r.delivery?.state !== 'delivered'));
  if (open.filter(r => r.requesterSessionId === id).length >= OPEN_PER_SESSION || open.length >= OPEN_TOTAL) fail('Native request limit reached. Settle existing requests before creating more.', 'refused');
  if (args.expires_at !== undefined && (!Number.isSafeInteger(args.expires_at) || args.expires_at <= Date.now())) fail('expires_at must be a future timestamp in milliseconds.');
  let bead = null;
  if (args.bead_id) {
    const access = requireBeadAccess(rt, actor, args.bead_id);
    if (access.cell.id !== actor.cell.id) fail('The bead belongs to another hive.');
    bead = access.bead;
  }
  const topic = args.thread_id ? audienceConversationDoc(rt.metadata.read(), actor.cell.id, actor).threads[actor.cell.id]?.[args.thread_id] : null;
  if (args.thread_id && (!topic || topic.id !== args.thread_id || !/^thr_[0-9a-f]{12}$/.test(args.thread_id))) fail('Unknown topic in this hive.');
  if (bead && topic?.beadId && topic.beadId !== bead.id) fail('Topic and bead context disagree.');
  const q = queenRoute(host, actor.cell);
  const at = Date.now(), rid = newId('hreq'), mid = newId('msg'), tid = topic?.id || newId('thr');
  const r = {
    id: rid, cellId: actor.cell.id, requesterSessionId: id, ...(sessionLink ? { sessionLink } : {}), title, body, kind, options, allowFreeText: true, blocking: args.blocking === true, dedupeKey: key || null,
    beadId: bead?.id || topic?.beadId || null, threadId: tid, messageId: mid, createdAt: at, updatedAt: at, expiresAt: args.expires_at || null,
    state: 'open', audience: !q || q === id ? 'human' : 'queen', routeReason: q ? null : 'no-queen', warning: q ? null : 'No queen in this hive',
    queenSessionId: q, queenGeneration: actor.cell.queenGeneration || 0, routeRevision: 1, contentRevision: 1, revision: 1, answer: null,
    queenNotification: { state: 'pending', attempts: [] }, delivery: null,
  };
  let removed = [];
  rt.metadata.mutate(d => {
    d.requests[rid] = r;
    d.threads[r.cellId] ||= {};
    const t = topic ? d.threads[r.cellId][tid] : (d.threads[r.cellId][tid] = { id: tid, cellId: r.cellId, title, titleBy: id, beadId: r.beadId, createdAt: at, createdBy: id, count: 0, origin: 'request', requestId: rid });
    preservePublicSequence(d, r.cellId, t);
    t.hasRequests = true;
    t.count++; t.lastAt = at; t.lastMessageId = mid;
    (d.conversation[r.cellId] ||= []).push({ id: mid, cellId: r.cellId, author: 'session', role: actor.role, sessionId: id, requestId: rid, text: title, at, threadId: tid, beadId: r.beadId, context: r.beadId ? { beadId: r.beadId, title: bead?.title || null } : null, n: t.count });
    prune(d);
    removed = pruneConversation(d, r.cellId);
  });
  rt.changed();
  await removeAttachmentBatch(rt, r.cellId, removed);
  ready(rt);
  if (r.audience === 'queen') await notifyQueen(rt, host, rid);
  return present(get(rt, rid));
}
async function send(rt, host, id, field, target, body) {
  if (!deliveries.has(rt)) deliveries.set(rt, new Set());
  const active = deliveries.get(rt), key = `${id}:${field}`;
  if (active.has(key)) fail('A delivery is already in progress.', 'busy');
  active.add(key);
  try { return await sendOnce(rt, host, id, field, target, body); }
  finally { active.delete(key); }
}
async function sendOnce(rt, host, id, field, target, body) {
  const r = get(rt, id), routeRevision = r.routeRevision;
  const prior = r[field];
  if (prior?.state === 'delivered') return r;
  const attemptId = newId('attempt');
  update(rt, id, x => { x[field] = { state: 'pending', attempts: [...(x[field]?.attempts || []), { id: attemptId, at: Date.now(), sessionId: target }].slice(-10) }; });
  const outcome = await safeDeliver(host, target, body, rt);
  ready(rt);
  if (get(rt, id).routeRevision !== routeRevision || get(rt, id)[field]?.attempts?.at(-1)?.id !== attemptId) return get(rt, id);
  return update(rt, id, x => { x[field] = { ...x[field], ...outcome }; });
}
export async function notifyQueen(rt, host, id) {
  reconcileRequests(rt, host, { requestId: id });
  const r = get(rt, id);
  if (r.state !== 'open' || r.audience !== 'queen' || r.queenNotification.state !== 'pending' || r.queenNotification.attempts.length) return r;
  return send(rt, host, id, 'queenNotification', r.queenSessionId, `[Hive request ${r.id}] ${r.title}\n${r.body}${(r.options || []).map(o => `\n- ${o.id}: ${o.label}${o.description ? ` — ${o.description}` : ''}`).join('')}\n${link(r)}\nCall hive_context. Answer within your authority with hive_answer_request or forward this same id with hive_forward_request; do not create a second standard request.`);
}
function queenRequest(rt, host, callerId, args) {
  caller(rt, host, callerId);
  reconcileRequests(rt, host);
  const r = get(rt, args.request_id), actor = member(rt, host, callerId, r.cellId);
  if (actor.role !== 'queen' || r.audience !== 'queen' || r.queenSessionId !== callerId || (actor.cell.queenGeneration || 0) !== r.queenGeneration) fail('Only the current queen may answer or forward its queen-stage request.', 'access');
  expected(r, args);
  return r;
}
export async function forwardRequest(rt, host, id, args) {
  const note = bounded(args.recommendation, 'recommendation', 4000);
  const previous = get(rt, args.request_id);
  if (previous.state === 'open' && previous.audience === 'human' && previous.forwarded?.by === id && previous.forwarded.fromRevision === args.revision && previous.forwarded.fromRouteRevision === args.route_revision && previous.forwarded.recommendation === note) {
    const actor = member(rt, host, id, previous.cellId);
    if (actor.role === 'queen' && (actor.cell.queenGeneration || 0) === previous.queenGeneration) return previous;
  }
  const r = queenRequest(rt, host, id, args);
  return update(rt, r.id, x => { x.audience = 'human'; x.requesterSessionLink = { sessionId: x.requesterSessionId, label: 'Open requester session' }; x.routeRevision++; x.forwarded = { by: id, at: Date.now(), recommendation: note, fromRevision: r.revision, fromRouteRevision: r.routeRevision }; });
}
async function answer(rt, host, r, args, author, sessionId = null) {
  const optionId = args.option_id === undefined || args.option_id === null || args.option_id === '' ? null : args.option_id;
  if (optionId !== null && (typeof optionId !== 'string' || !(r.options || []).some(o => o.id === optionId))) fail('Choose one of this request’s options.');
  const text = bounded(args.text, 'answer', (r.options?.length || optionId) ? 4000 : 20000) || null;
  if (!optionId && !text) fail(r.options?.length ? 'Choose an option or write an answer.' : 'The answer needs some text.');
  const saved = update(rt, r.id, x => {
    x.state = 'answered'; x.closedAt = Date.now(); x.receipt = args.receipt || null;
    x.answer = { optionId, text, author, sessionId, at: Date.now(), contentRevision: x.contentRevision, inputRevision: r.revision, inputRouteRevision: r.routeRevision };
    x.delivery = { state: 'pending', attempts: [] };
  });
  return deliverAnswer(rt, host, saved);
}
async function deliverAnswer(rt, host, r) {
  const target = session(host, r.requesterSessionId);
  if (!target || target.archived) return update(rt, r.id, x => { x.delivery.state = 'failed'; x.delivery.error = 'Requester is missing or archived. The answer remains available in Hive.'; });
  return send(rt, host, r.id, 'delivery', r.requesterSessionId, `[Hive request ${r.id}: answered by ${r.answer.author}] ${r.title}\n${r.answer.optionId ? `Choice: ${(r.options || []).find(o => o.id === r.answer.optionId)?.label || r.answer.optionId} (${r.answer.optionId})${r.answer.text ? `\nNote: ${r.answer.text}` : ''}` : r.answer.text}\n${link(r)}\nThis is an attributed ${r.answer.author} answer.`);
}
export async function answerRequest(rt, host, id, args) {
  const previous = get(rt, args.request_id);
  if (previous.state === 'answered' && previous.answer?.author === 'queen' && previous.answer.sessionId === id && previous.answer.inputRevision === args.revision && previous.answer.inputRouteRevision === args.route_revision && (previous.answer.text || null) === (args.text?.trim() || null) && (previous.answer.optionId || null) === (args.option_id || null)) {
    const actor = member(rt, host, id, previous.cellId);
    if (actor.role === 'queen' && (actor.cell.queenGeneration || 0) === previous.queenGeneration) return previous;
  }
  return answer(rt, host, queenRequest(rt, host, id, args), args, 'queen', id);
}
function humanGet(rt, host, id) {
  ready(rt); reconcileRequests(rt, host);
  const r = get(rt, id);
  if (!maySeeRequest(r)) fail('Unknown or unavailable Hive request.');
  return r;
}
function humanRequest(rt, host, args) {
  const r = humanGet(rt, host, args.request_id);
  expected(r, args);
  return r;
}
export async function humanAnswer(rt, host, args) {
  bounded(args.receipt, 'receipt', 80, true);
  const r = humanGet(rt, host, args.request_id);
  if (r.receipt === args.receipt && r.answer?.author === 'human' && (r.answer.text || null) === (args.text?.trim() || null) && (r.answer.optionId || null) === (args.option_id || null) && r.answer.inputRevision === args.revision && r.answer.inputRouteRevision === args.route_revision) return r;
  return answer(rt, host, humanRequest(rt, host, args), args, 'human');
}
export async function dismissRequest(rt, host, args) {
  bounded(args.receipt, 'receipt', 80, true);
  const old = humanGet(rt, host, args.request_id);
  if (old.receipt === args.receipt && old.resolution?.reason === 'dismissed') return old;
  const r = humanRequest(rt, host, args);
  update(rt, r.id, x => { x.state = 'resolved'; x.closedAt = Date.now(); x.receipt = args.receipt; x.resolution = { reason: 'dismissed', by: 'human', at: Date.now() }; x.resolutionDelivery = { state: 'pending', attempts: [] }; });
  return notifyResolution(rt, host, r.id);
}
export function listMine(rt, host, id, cellId) {
  caller(rt, host, id); reconcileRequests(rt, host);
  return values(rt).filter(r => r.requesterSessionId === id && (!cellId || r.cellId === cellId)).sort((a, b) => b.createdAt - a.createdAt).slice(0, HISTORY_CAP + OPEN_PER_SESSION).map(r => ({ ...r, link: link(r) }));
}
export async function withdrawRequest(rt, host, id, args) {
  caller(rt, host, id);
  const r = get(rt, args.request_id);
  if (r.requesterSessionId !== id) fail('Only the original requester can withdraw its own request.', 'access');
  if (r.state === 'resolved') return r;
  const reason = bounded(args.reason, 'reason', 2000);
  return update(rt, r.id, x => { x.state = 'resolved'; x.closedAt = Date.now(); x.resolution = { reason: 'withdrawn', by: id, note: reason, at: Date.now() }; });
}
export async function retryDelivery(rt, host, args) {
  const r = humanGet(rt, host, args.request_id);
  if (r.state !== 'answered' || !r.answer || args.revision !== r.revision || args.route_revision !== r.routeRevision) fail('Review the current answered request before retrying.', 'conflict');
  if (r.delivery.state === 'delivered') return r;
  if (['uncertain', 'pending'].includes(r.delivery.state) && !args.confirm_uncertain) fail('Check receipt first; explicitly confirm retry of an uncertain delivery.', 'uncertain');
  return deliverAnswer(rt, host, r);
}
export function requestContext(rt, actor, { bead_id } = {}) {
  const all = values(rt).filter(r => r.cellId === actor.cell.id && (!bead_id || r.beadId === bead_id || rt.metadata.read().threads?.[actor.cell.id]?.[r.threadId]?.beadId === bead_id));
  const queued = actor.role === 'queen' ? all.filter(r => r.state === 'open' && r.audience === 'queen') : [];
  return { my_requests: all.filter(r => r.requesterSessionId === actor.sessionId).slice(-50).map(r => ({ ...r, link: link(r) })), ...(actor.role === 'queen' ? { input_requests: queued.slice(0, 50).map(r => ({ ...r, link: link(r) })), input_requests_total: queued.length, recent_input_requests: all.filter(r => r.state !== 'open' || r.audience !== 'queen').slice(-50).map(r => ({ ...r, link: link(r) })) } : {}) };
}

export async function notifyResolution(rt, host, id) {
  const r = get(rt, id);
  if (r.state !== 'resolved' || r.resolutionDelivery?.state !== 'pending' || r.resolutionDelivery.attempts.length) return r;
  const target = session(host, r.requesterSessionId);
  if (!target || target.archived) return update(rt, id, x => { x.resolutionDelivery.state = 'failed'; x.resolutionDelivery.error = 'Requester unavailable; recover the resolution in Hive.'; });
  return send(rt, host, id, 'resolutionDelivery', r.requesterSessionId, `[Hive request ${r.id}: ${r.resolution.reason}] ${r.title}\nClosed without an answer; no approval was given.\n${link(r)}`);
}
