import { beadReferences } from '../public/bead-references.js';
import { hiveLink } from '../public/deep-links.js';
import { createHash } from 'node:crypto';
import { maySeeRequest } from './request-visibility.js';
import { adoptAttachments, removeAttachments, removeAttachmentBatch, attachmentsInbox, messageDir } from './attachments.js';
import { newId } from './metadata-store.js';
import { isBeadId } from './bead-model.js';
import { requireBeadAccess, requireQueen, requireCoordinator, cellOfBead, resolveCaller } from './access.js';
import { HiveError, text, refuseSnapshot } from './ops.js';
import { safeDeliver } from './sessions.js';

const MESSAGE_MAX = 20000;
const CELL_MESSAGE_CAP = 2000;
const QUOTE_LIMIT = 160;
const THREAD_TITLE_MAX = 120;
const AUTO_TITLE = 80;
const CELL_THREAD_CAP = 1000;
const HISTORY_MAX = 100;
const CONTEXT_THREADS = 30;
const EARLIER_TITLE = 'Earlier messages';
const TITLE_ONLY_NEW = 'thread_title only names a new topic; use hive_update_thread to rename one.';
const ANSWERS_MAX = 20;
export const INBOX_PAGE = 50;
const INBOX_PAGE_MAX = 100;
export const INBOX_BACKLOG = 100;
export const ACK_EMOJI = ['👍', '✅', '👀', '❤️', '🙏'];
const HUMAN = 'aw:human';
const inFlight = new Set();

// The inbox's two obligations. A human message waits for a visible queen
// answer linked to it; a queen message waits for the human to mark it read,
// react to it or reply to it. Receipt (acknowledgedAt) is separate.
export const awaitingQueen = (m) => m.author === 'human' && Boolean(m.response?.required) && !m.response.answers?.length && !m.response.withdrawn;
export const awaitingHuman = (m) => m.author === 'session' && !m.requestId && Boolean(m.ack?.required) && !m.ack.state;
export const outstanding = (m) => awaitingQueen(m) || awaitingHuman(m);

const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

function clip(s, n) {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

// Outstanding messages, and the messages each one replies to or answers,
// are never pruned; a cell can then hold more than the cap until they are
// settled. A pruned message that carried an obligation leaves a compact
// record of how it was settled, and by whom, in the cell's ledger, which is
// never trimmed.

export function linkedTargets(m) {
  return [m.replyTo, ...(Array.isArray(m.answers) ? m.answers : [])].filter(Boolean);
}

function settlement(m) {
  const attachmentCount = m.attachments?.length || 0;
  if (m.author === 'human' && m.response?.withdrawn && !m.response.answers?.length) return [{ id: m.id, attachmentCount, kind: 'withdrawn', at: m.at, by: m.response.withdrawn.by, withdrawnAt: m.response.withdrawn.at }];
  if (m.author === 'human' && m.response) return (m.response.answers || []).map((a) => ({ id: m.id, attachmentCount, kind: 'response', at: m.at, answerMessageId: a.messageId, sessionId: a.sessionId ?? null, answeredAt: a.at }));
  if (m.author === 'session' && m.ack?.required) return [{ id: m.id, attachmentCount, kind: 'ack', at: m.at, sessionId: m.sessionId, role: m.role, state: m.ack.state, ...(m.answers?.length ? { answers: m.answers } : {}) }];
  return [];
}

function prune(d, cellId, list, removed) {
  if (list.length <= CELL_MESSAGE_CAP) return;
  const scopeOf = requestScopes(d, cellId);
  for (const m of list) if (!m.requestId && !Object.hasOwn(m, 'requestScopeId')) {
    const scope = scopeOf(m);
    if (scope || d.threads[cellId]?.[m.threadId]?.origin === 'request') m.requestScopeId = scope;
  }
  const visible = new Set(humanConversationDoc(d, cellId).conversation[cellId].map(m => m.id));
  const quoted = new Set();
  for (const m of list) if (outstanding(m)) for (const id of linkedTargets(m)) quoted.add(id);
  const gone = [];
  let excess = list.length - CELL_MESSAGE_CAP;
  for (let i = 0; i < list.length && excess > 0;) {
    const m = list[i];
    const r = m.requestId && d.requests?.[m.requestId];
    const heldRequest = r && (r.state === 'open' || (r.state === 'answered' && r.delivery?.state !== 'delivered'));
    const settled = !heldRequest && (m.author !== 'human' || m.acknowledgedAt || m.response?.withdrawn) && !outstanding(m) && !quoted.has(m.id);
    if (settled) {
      const topic = d.threads[cellId]?.[m.threadId];
      if (topic && visible.has(m.id)) {
        topic.humanSequenceBase = publicSequenceBase(d, cellId, topic) + 1;
        topic.humanPruneRevision = (topic.humanPruneRevision || 0) + 1;
      }
      const rec = settlement(m);
      for (const record of rec) gone.push(record);
      removed.push(m.id);
      list.splice(i, 1);
      excess -= 1;
    } else {
      i += 1;
    }
  }
  if (gone.length) {
    const box = inboxOf(d, cellId);
    if (!Array.isArray(box.ledger)) box.ledger = [];
    for (const record of gone) box.ledger.push(record);
  }
}

// Bumped by every write that can change which messages are outstanding, so
// a reader can tell any two inbox states apart.
function bumpInbox(d, cellId) {
  const box = inboxOf(d, cellId);
  box.rev = (Number.isInteger(box.rev) ? box.rev : 0) + 1;
}

export function inboxRev(doc, cellId) {
  const rev = doc.inbox?.[cellId]?.rev;
  return Number.isInteger(rev) ? rev : 0;
}

function messagesOf(d, cellId) {
  return d.conversation[cellId] || (d.conversation[cellId] = []);
}

function inboxOf(d, cellId) {
  if (!d.inbox || typeof d.inbox !== 'object') d.inbox = {};
  if (!Object.hasOwn(d.inbox, cellId) || !d.inbox[cellId] || typeof d.inbox[cellId] !== 'object') d.inbox[cellId] = { enabledAt: Date.now() };
  return d.inbox[cellId];
}

// Starts the inbox for a cell once. Each human message kept from before
// gets its response requirement, answered only by a kept queen message that
// replied to it or listed it; a receipt alone answers nothing. Queen
// messages from before stay ordinary history. Idempotent.
export function inboxCell(d, cellId) {
  inboxOf(d, cellId);
  const list = d.conversation[cellId] || [];
  if (!list.some((m) => m.author === 'human' && !m.response)) return;
  const answered = new Map();
  for (const m of list) {
    if (m.author !== 'session' || m.role !== 'queen') continue;
    for (const id of new Set([m.replyTo, ...(Array.isArray(m.answers) ? m.answers : [])])) {
      if (!id) continue;
      if (!answered.has(id)) answered.set(id, []);
      answered.get(id).push({ messageId: m.id, sessionId: m.sessionId, at: m.at });
    }
  }
  for (const m of list) if (m.author === 'human' && !m.response) m.response = { required: true, answers: answered.get(m.id) || [] };
  bumpInbox(d, cellId);
}

const needsInbox = (doc, cellId) => !(doc.inbox && Object.hasOwn(doc.inbox, cellId)) || (doc.conversation[cellId] || []).some((m) => m.author === 'human' && !m.response);

// The item a message is about, kept with the title it had, so a context that
// is later removed or moved is still named. Messages from before carry only
// their bead id.
function contextFor(rt, beadId) {
  if (!beadId) return null;
  return { beadId, title: rt.snapshots.graph.beads[beadId]?.title || null };
}

// A message is about its own item, else whatever the message it replies to
// was about (hive-wide included), else its topic's item; with none of those
// it is hive-wide.
function contextAt(rt, beadId, target, thread) {
  if (beadId) return contextFor(rt, beadId);
  if (target) return contextOf(target);
  return contextFor(rt, thread.beadId);
}

export function contextOf(m) {
  if (m.context !== undefined) return m.context;
  return m.beadId ? { beadId: m.beadId, title: null } : null;
}

function threadsOf(d, cellId) {
  if (!d.threads || typeof d.threads !== 'object') d.threads = {};
  if (!Object.hasOwn(d.threads, cellId) || !d.threads[cellId] || typeof d.threads[cellId] !== 'object') d.threads[cellId] = {};
  return d.threads[cellId];
}

export function threadRecords(doc, cellId) {
  const all = doc.threads;
  return all && typeof all === 'object' && Object.hasOwn(all, cellId) && all[cellId] && typeof all[cellId] === 'object' ? all[cellId] : {};
}

const THREAD_ID = /^thr_[0-9a-f]{12}$/;

export function ownThreads(threads) {
  return Object.keys(threads).map((id) => threadIn(threads, id)).filter(Boolean);
}

// A topic is only ever a record stored under its own id: never an inherited
// property, and never a record filed under another id.
export function threadIn(threads, id) {
  if (typeof id !== 'string' || !THREAD_ID.test(id) || !Object.hasOwn(threads, id)) return null;
  const t = threads[id];
  return t && typeof t === 'object' && t.id === id ? t : null;
}

export function autoTitle(body) {
  const line = String(body).split('\n').map((l) => l.replace(/^[\s#>*_`-]+/, '').replace(/[*_`]+/g, '').trim()).find(Boolean) || 'Message';
  return clip(line.replace(/\s+/g, ' '), AUTO_TITLE);
}

function makeThread(d, cellId, { title, titleBy, beadId, by, origin, at }) {
  const id = newId('thr');
  threadsOf(d, cellId)[id] = {
    id, cellId, title, titleBy, beadId: beadId || null, createdAt: at, createdBy: by,
    lastAt: at, lastMessageId: null, count: 0, earlierRemoved: false, origin,
  };
  return threadsOf(d, cellId)[id];
}

// `n` is the message's place in its topic, in the order messages were added.
// It never changes, so a browser can order and join pages without guessing.
function touch(thread, m) {
  thread.count = (thread.count || 0) + 1;
  m.n = thread.count;
  if (!thread.lastMessageId || m.at >= thread.lastAt) {
    thread.lastAt = m.at;
    thread.lastMessageId = m.id;
  }
}

// Gives every message without a topic one, using only explicit reply links:
// a reply chain becomes a topic, and every other message goes into the
// cell's single "Earlier messages" topic. Idempotent; only adds threadId and
// thread records, never changes a message otherwise.
export function threadCell(d, cellId) {
  const list = d.conversation[cellId] || [];
  numberThreads(d, cellId);
  if (!list.some((m) => !m.threadId)) return false;
  const threads = threadsOf(d, cellId);
  const byId = new Map(list.map((m) => [m.id, m]));
  const rootOf = (m) => {
    const seen = new Set([m.id]);
    let cur = m;
    while (!cur.threadId && cur.replyTo && byId.has(cur.replyTo) && !seen.has(cur.replyTo)) {
      cur = byId.get(cur.replyTo);
      seen.add(cur.id);
    }
    return cur;
  };
  // Every topic is decided first, then messages join in stored order, so
  // each topic's `n` follows the order its messages were stored in.
  const into = new Map();
  const groups = new Map();
  for (const m of list) {
    if (m.threadId) continue;
    const root = rootOf(m);
    const t = root.threadId ? threadIn(threads, root.threadId) : null;
    if (t) into.set(m, t);
    else {
      if (!groups.has(root.id)) groups.set(root.id, []);
      groups.get(root.id).push(m);
    }
  }
  let earlier = ownThreads(threads).find((t) => t.origin === 'legacy-unthreaded') || null;
  for (const group of groups.values()) {
    const first = group[0];
    let t;
    if (group.length > 1) {
      t = makeThread(d, cellId, { title: autoTitle(first.text), titleBy: 'hive', beadId: first.beadId, by: 'hive', origin: 'legacy-reply-chain', at: first.at });
    } else {
      earlier = earlier || makeThread(d, cellId, { title: EARLIER_TITLE, titleBy: 'hive', beadId: null, by: 'hive', origin: 'legacy-unthreaded', at: first.at });
      t = earlier;
    }
    for (const m of group) into.set(m, t);
  }
  for (const m of list) {
    const t = into.get(m);
    if (!t) continue;
    m.threadId = t.id;
    touch(t, m);
    if (m.replyTo && !byId.has(m.replyTo)) t.earlierRemoved = true;
  }
  return true;
}

// Gives `n` to topic messages kept from before it existed: each such topic
// is numbered in stored order, after the messages it no longer keeps.
function numberThreads(d, cellId) {
  const list = d.conversation[cellId] || [];
  const threads = threadsOf(d, cellId);
  const stale = new Set(list.filter((m) => m.threadId && !Number.isInteger(m.n)).map((m) => m.threadId));
  for (const threadId of stale) {
    const mine = list.filter((m) => m.threadId === threadId);
    const t = threadIn(threads, threadId);
    const base = Math.max(0, (t?.count || 0) - mine.length);
    mine.forEach((m, i) => { m.n = base + i + 1; });
    if (t) t.count = Math.max(t.count || 0, base + mine.length);
  }
}

const unnumbered = (list) => list.some((m) => !m.threadId || !Number.isInteger(m.n));

export function threadAllCells(rt) {
  if (rt.metadata.error) return false;
  const doc = rt.metadata.read();
  const pending = Object.keys(doc.conversation || {}).filter((cellId) => unnumbered(doc.conversation[cellId] || []) || needsInbox(doc, cellId));
  if (!pending.length) return false;
  rt.metadata.mutate((d) => {
    for (const cellId of pending) {
      threadCell(d, cellId);
      inboxCell(d, cellId);
    }
  });
  return true;
}

function pruneThreads(d, cellId) {
  const threads = threadsOf(d, cellId);
  const ids = Object.keys(threads);
  if (ids.length <= CELL_THREAD_CAP) return;
  const live = new Set((d.conversation[cellId] || []).map((m) => m.threadId));
  const empty = ids.filter((id) => !live.has(id)).sort((a, b) => (threads[a]?.lastAt || 0) - (threads[b]?.lastAt || 0));
  for (const id of empty.slice(0, ids.length - CELL_THREAD_CAP)) delete threads[id];
}

function threadRef(threadId) {
  if (threadId === undefined || threadId === null || threadId === '') return null;
  if (typeof threadId !== 'string' || !THREAD_ID.test(threadId)) throw new HiveError('thread_id must be a topic id (thr_…).');
  return threadId;
}

// The topic a new message joins: a reply's own topic, the named one, or
// none (the caller then starts one). Runs inside the caller's write.
function joinThread(d, cellId, { replyTo, threadId }) {
  const threads = threadsOf(d, cellId);
  if (replyTo) {
    const target = messagesOf(d, cellId).find((m) => m.id === replyTo);
    const t = target && threadIn(threads, target.threadId);
    if (!t) throw new HiveError(`Unknown message ${replyTo} in this cell.`);
    if (threadId && threadId !== t.id) throw new HiveError('That reply belongs to another topic.');
    return t;
  }
  if (threadId) {
    const t = threadIn(threads, threadId);
    if (!t) throw new HiveError(`Unknown topic ${threadId} in this cell.`);
    return t;
  }
  return null;
}

function retained(list, threadId) {
  let n = 0;
  for (const m of list) if (m.threadId === threadId) n += 1;
  return n;
}

export const THREAD_PAGE = 200;
const PREVIEW = 140;

// Per topic, from every retained message: how many are kept, the items they
// name, the newest one and the earliest still awaiting the human's
// acknowledgement. Scope matching uses these complete sets, not the window of
// messages a browser holds.
export { isHumanRequest } from './request-visibility.js';

function requestScopes(doc, cellId) {
  const messages = new Map((doc.conversation[cellId] || []).map(m => [m.id, m]));
  const byMessage = new Map(), byThread = new Map(), cache = new Map();
  for (const r of Object.values(doc.requests || {})) if (r.cellId === cellId) {
    byMessage.set(r.messageId, r);
    if (!byThread.has(r.threadId)) byThread.set(r.threadId, []);
    byThread.get(r.threadId).push(r);
  }
  const topics = threadRecords(doc, cellId);
  return (message, publishing = false) => {
    const path = new Set();
    let current = message, scope = null;
    while (current) {
      if (current.author === 'human') { scope = null; break; }
      if (cache.has(current.id)) { scope = cache.get(current.id); break; }
      if (path.has(current.id)) { scope = 'unavailable'; break; }
      path.add(current.id);
      if (current.requestId) { scope = current.requestId; break; }
      if (Object.hasOwn(current, 'requestScopeId')) { scope = current.requestScopeId; break; }
      const parent = messages.get(current.replyTo);
      if (parent) { current = parent; continue; }
      if (byMessage.has(current.replyTo)) { scope = byMessage.get(current.replyTo).id; break; }
      const topic = threadIn(topics, current.threadId);
      if (topic?.origin === 'request') {
        const requests = byThread.get(topic.id) || [];
        scope = current.replyTo ? 'unavailable' : publishing && current === message && (topic.publicHistory || requests.some(r => maySeeRequest(r))) ? null : topic.requestId || requests[0]?.id || 'unavailable';
      }
      break;
    }
    for (const id of path) cache.set(id, scope);
    return scope;
  };
}

function publicSequenceBase(doc, cellId, topic) {
  if (!topic) return 0;
  if (Number.isInteger(topic.humanSequenceBase)) return topic.humanSequenceBase;
  if (topic.hasRequests || topic.origin === 'request') return 0;
  const first = (doc.conversation[cellId] || []).find(m => m.threadId === topic.id);
  return Math.max(0, (first?.n || 1) - 1);
}

export function preservePublicSequence(doc, cellId, topic) {
  topic.humanSequenceBase = publicSequenceBase(doc, cellId, topic);
}

export function audienceConversationDoc(doc, cellId, viewer = { role: 'human' }) {
  const requests = Object.fromEntries(Object.entries(doc.requests || {}).filter(([, r]) => r.cellId === cellId && maySeeRequest(r, viewer)));
  const raw = doc.conversation[cellId] || [];
  const visibleTopics = new Set([...Object.values(requests).map(r => r.threadId), ...raw.filter(m => m.author === 'human').map(m => m.threadId)]);
  const records = threadRecords(doc, cellId);
  const hiddenTopics = new Set(ownThreads(records).filter(t => t.origin === 'request' && !t.publicHistory && !visibleTopics.has(t.id)).map(t => t.id));
  const scopeOf = requestScopes(doc, cellId);
  const list = raw.filter(m => {
    const scope = scopeOf(m);
    return !hiddenTopics.has(m.threadId) && (!scope || maySeeRequest(doc.requests?.[scope], viewer));
  }).map(m => ({ ...m, ...(m.requestId ? { text: requests[m.requestId].title } : {}) }));
  const visibleIds = new Set(list.map(m => m.id));
  const numbers = new Map();
  for (const m of list) {
    if (m.requestId) delete m.ack;
    const n = (numbers.get(m.threadId) ?? publicSequenceBase(doc, cellId, records[m.threadId])) + 1;
    numbers.set(m.threadId, n); m.n = n;
    if (m.replyTo && !visibleIds.has(m.replyTo)) delete m.replyTo;
    if (m.answers) m.answers = m.answers.filter(id => visibleIds.has(id));
    if (m.response?.answers) m.response = { ...m.response, answers: m.response.answers.filter(a => visibleIds.has(a.messageId)) };
    delete m.requestScopeId;
  }
  const threads = Object.fromEntries(ownThreads(records).filter(t => !hiddenTopics.has(t.id)).map(t => {
    const first = Object.values(requests).find(r => r.threadId === t.id);
    const mine = list.filter(m => m.threadId === t.id);
    const titleRequest = doc.requests?.[t.titleScopeId];
    const named = Object.hasOwn(t, 'titleScopeId') && (t.titleScopeId === null || (maySeeRequest(titleRequest, viewer) && titleRequest.contentRevision === t.titleScopeRevision));
    return [t.id, { ...t, ...(t.origin === 'request' && t.titleBy !== 'human' && !named ? { title: first?.title || t.publicRequestTitle || 'Request', titleBy: first?.requesterSessionId || 'hive' } : {}), count: publicSequenceBase(doc, cellId, t) + mine.length, earlierRemoved: Boolean(t.earlierRemoved), createdAt: t.origin === 'request' ? mine[0]?.at || first?.createdAt || 0 : t.createdAt, lastAt: mine.at(-1)?.at || first?.createdAt || 0, lastMessageId: mine.at(-1)?.id || null }];
  }));
  const revision = [Object.values(requests).map(r => [r.id, r.contentRevision]).sort(), Object.values(threads).map(t => [t.id, t.humanPruneRevision || 0]).sort()];
  const inboxRevision = list.filter(m => m.ack?.required || m.response?.required).map(m => [m.id, m.ack || null, m.response || null]);
  const inbox = { enabledAt: list[0]?.at || null, rev: Number.parseInt(createHash('sha256').update(JSON.stringify(inboxRevision)).digest('hex').slice(0, 12), 16) };
  return { ...doc, requests, conversationRevision: createHash('sha256').update(JSON.stringify(revision)).digest('hex').slice(0, 20), conversation: { ...doc.conversation, [cellId]: list }, threads: { ...doc.threads, [cellId]: threads }, inbox: { ...doc.inbox, [cellId]: inbox } };
}

export const humanConversationDoc = (doc, cellId) => audienceConversationDoc(doc, cellId);

export function preserveRequestAudience(doc, request) {
  const topic = doc.threads[request.cellId]?.[request.threadId];
  if (!topic) return;
  topic.hasRequests = true;
  if (topic.origin === 'request' && !topic.requestId) topic.requestId = Object.values(doc.requests).find(r => r.cellId === request.cellId && r.threadId === topic.id)?.id;
  const publicRequest = maySeeRequest(request);
  if (publicRequest) { topic.publicHistory = true; topic.publicRequestTitle = request.title; }
  const scopeOf = requestScopes(doc, request.cellId);
  for (const m of doc.conversation[request.cellId] || []) if (!m.requestId && scopeOf(m) === request.id) m.requestScopeId = publicRequest ? null : request.id;
}

function requireAudienceTarget(doc, cellId, threadId, messageId, viewer) {
  if (!threadId && !messageId) return;
  const visible = audienceConversationDoc(doc, cellId, viewer);
  if ((threadId && !threadIn(threadRecords(visible, cellId), threadId)) || (messageId && !(visible.conversation[cellId] || []).some(m => m.id === messageId))) throw new HiveError('That topic or message is unavailable.');
}

export const requireHumanTarget = (doc, cellId, threadId, messageId) => requireAudienceTarget(doc, cellId, threadId, messageId);

export function threadIndex(list, { references = false } = {}) {
  const out = new Map();
  for (const m of list) {
    if (!m.threadId) continue;
    let e = out.get(m.threadId);
    if (!e) out.set(m.threadId, (e = { retained: 0, beads: new Set(), references: references ? new Set() : null, last: null, waiting: null, awaiting: { human: null, queen: null } }));
    e.retained += 1;
    if (m.beadId) e.beads.add(m.beadId);
    for (const id of m.relatedBeadIds || []) e.beads.add(id);
    if (references) for (const id of beadReferences(m.text)) e.references.add(id);
    if (!e.waiting && awaitingHuman(m)) e.waiting = m;
    const kind = awaitingHuman(m) ? 'human' : awaitingQueen(m) ? 'queen' : null;
    if (kind) e.awaiting[kind] = { count: (e.awaiting[kind]?.count || 0) + 1, newest: m };
    e.last = m;
  }
  return out;
}

export function threadRelations(t, e) {
  return {
    beadId: t.beadId || null,
    beads: e ? [...e.beads] : [],
    ...(e?.references ? { references: [...e.references] } : {}),
  };
}

export function threadSummary(t, e) {
  const last = e?.last || null;
  return {
    id: t.id,
    title: t.title,
    titleBy: t.titleBy,
    ...threadRelations(t, e),
    origin: t.origin,
    createdAt: t.createdAt,
    lastAt: t.lastAt,
    count: t.count || 0,
    retained: e?.retained || 0,
    earlierRemoved: Boolean(t.earlierRemoved) || (e?.retained || 0) < (t.count || 0),
    waitingFrom: e?.waiting ? { id: e.waiting.id, n: e.waiting.n ?? null, rev: e.waiting.ack.rev } : null,
    awaiting: Object.fromEntries(['human', 'queen'].map((k) => [k, e?.awaiting[k] ? { count: e.awaiting[k].count, newest: { id: e.awaiting[k].newest.id, n: e.awaiting[k].newest.n ?? null } } : null])),
    preview: last ? { id: last.id, ack: last.ack || null, author: last.author, sessionId: last.sessionId || null, text: clip(oneLine(last.text), PREVIEW), at: last.at } : null,
  };
}

export const byRecent = (a, b) => (b.lastAt || 0) - (a.lastAt || 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function findMessage(rt, cellId, messageId) {
  return (rt.metadata.read().conversation[cellId] || []).find((m) => m.id === messageId) || null;
}

function beadRef(rt, cellId, beadId, actor) {
  if (beadId === undefined || beadId === null || beadId === '') return null;
  if (!isBeadId(beadId)) throw new HiveError('bead_id must be a bead id.');
  if (actor) {
    const { cell } = requireBeadAccess(rt, actor, beadId);
    if (cell.id !== cellId) throw new HiveError(`Bead ${beadId} is in another cell.`);
  } else {
    if (!rt.snapshots.graph.beads[beadId]) throw new HiveError(`Unknown bead ${beadId}.`);
    if (cellOfBead(rt, beadId)?.id !== cellId) throw new HiveError('That item is no longer in this hive. Choose another item, or make the topic hive-wide.');
  }
  return beadId;
}

// Human messages a queen message answers, besides its reply_to.
function answersRef(rt, cellId, answers) {
  if (answers === undefined || answers === null) return [];
  if (!Array.isArray(answers) || answers.length > ANSWERS_MAX) throw new HiveError(`answers must be a list of at most ${ANSWERS_MAX} human message ids.`);
  const list = rt.metadata.read().conversation[cellId] || [];
  for (const id of answers) {
    if (typeof id !== 'string' || !list.some((m) => m.id === id && m.author === 'human')) throw new HiveError(`answers: ${id} is not a human message in this cell.`);
  }
  return [...new Set(answers)];
}

function replyRef(rt, cellId, replyTo) {
  if (replyTo === undefined || replyTo === null || replyTo === '') return null;
  if (typeof replyTo !== 'string' || !findMessage(rt, cellId, replyTo)) throw new HiveError(`Unknown message ${replyTo} in this cell.`);
  return replyTo;
}

// A deliberate message from a participant: never a transcript mirror.
// With neither reply_to nor thread_id it starts a topic, titled thread_title
// or, for callers that predate topics, from the message's first line.
// Only the queen answers human messages: its reply to one, and every message
// it lists in answers, is answered and received in the same write. Each
// queen message then waits for the human to acknowledge it.
const messageWrites = new WeakMap();
function messageWrite(rt, cellId, run) {
  if (!messageWrites.has(rt)) messageWrites.set(rt, new Map());
  const queues = messageWrites.get(rt), prior = queues.get(cellId) || Promise.resolve();
  const next = prior.catch(() => {}).then(run);
  queues.set(cellId, next);
  next.finally(() => { if (queues.get(cellId) === next) queues.delete(cellId); }).catch(() => {});
  return next;
}
export function publish(rt, actor, args, host = rt.host) {
  const { sessionId, cell: { id: cellId } } = actor;
  return messageWrite(rt, cellId, () => publishMessage(rt, host, resolveCaller(rt, host, sessionId, cellId), args));
}

const HIVE_TERMS = new Set(['hive-queen', 'hive-worker', 'hive-wide', 'hive-docs', 'hive-cell', 'hive-core', 'hive-mind', 'hive-name', 'hive-api']);

function publishedBeadMentions(rt, body) {
  const beads = rt.snapshots.graph.beads;
  const ids = beadReferences(body).filter(id => Object.hasOwn(beads, id) || (!HIVE_TERMS.has(id) && /^hive-[a-z0-9]{3,}(?:\.[0-9]+)*$/.test(id)));
  const unknown = ids.filter(id => !Object.hasOwn(beads, id));
  if (unknown.length) throw new HiveError(`Unknown bead ids: ${unknown.join(', ')}. Create beads and wait for their returned ids before publishing; call hive_context for current ids. If this isn't a bead id, wrap it in backticks.`);
  return ids;
}

async function publishMessage(rt, host, actor, { text: body, bead_id, reply_to, thread_id, thread_title, answers, attachments }) {
  if (rt.metadata.error) throw new HiveError(rt.metadata.error, 'metadata-unavailable');
  const cell = actor.cell;
  const clean = text(body, 'text', MESSAGE_MAX, { required: true });
  publishedBeadMentions(rt, clean);
  const beadId = beadRef(rt, cell.id, bead_id, actor);
  const replyTo = replyRef(rt, cell.id, reply_to);
  const threadId = threadRef(thread_id);
  requireAudienceTarget(rt.metadata.read(), cell.id, threadId, replyTo, actor);
  const title = thread_title === '' ? undefined : text(thread_title, 'thread_title', THREAD_TITLE_MAX);
  if (title && (replyTo || threadId)) throw new HiveError(TITLE_ONLY_NEW);
  const listed = answersRef(rt, cell.id, answers);
  let queen = actor.role === 'queen';
  if (listed.length && !queen) throw new HiveError('Only the queen answers the human\'s messages. Tell the queen what you found so it can answer.');
  const id = newId('msg');
  if (attachments?.length) requireQueen(actor, 'attach images');
  const kept = await adoptAttachments(rt, cell.id, id, attachments);
  const removed = [];
  const at = Date.now();
  let acknowledged = false;
  let topic = null;
  const answered = [];
  try {
    actor = resolveCaller(rt, host, actor.sessionId, cell.id);
    queen = actor.role === 'queen';
    if (kept.length || listed.length) requireQueen(actor, 'attach images or answer human messages');
    beadRef(rt, cell.id, bead_id, actor); replyRef(rt, cell.id, reply_to); answersRef(rt, cell.id, answers);
    requireAudienceTarget(rt.metadata.read(), cell.id, threadId, replyTo, actor);
    const mentions = publishedBeadMentions(rt, clean);
    rt.metadata.mutate((d) => {
      threadCell(d, cell.id);
      inboxCell(d, cell.id);
      const list = messagesOf(d, cell.id);
      const target = replyTo ? list.find((x) => x.id === replyTo) : null;
      const t = joinThread(d, cell.id, { replyTo, threadId })
        || makeThread(d, cell.id, { title: title || autoTitle(clean), titleBy: title ? actor.sessionId : 'hive', beadId, by: actor.sessionId, origin: 'new', at });
      const m = { id, cellId: cell.id, author: 'session', sessionId: actor.sessionId, role: actor.role, text: clean, attachments: kept, beadId, replyTo, threadId: t.id, at, context: contextAt(rt, beadId, target, t) };
      const related = mentions.filter(id => id !== beadId && id !== t.beadId);
      if (related.length) m.relatedBeadIds = related;
      const scope = requestScopes(d, cell.id)(m, true);
      if (scope || t.origin === 'request') m.requestScopeId = scope;
      if (queen) {
        const links = new Set(listed);
        if (target?.author === 'human') links.add(target.id);
        if (links.size && scope && !maySeeRequest(d.requests?.[scope])) throw new HiveError('Private discussion cannot answer human messages. Post a separate visible answer.');
        for (const hid of links) {
          const h = list.find((x) => x.id === hid && x.author === 'human');
          if (!h) continue;
          h.response ||= { required: true, answers: [] };
          if (!h.response.answers.some((a) => a.messageId === id)) h.response.answers.push({ messageId: id, sessionId: actor.sessionId, at });
          if (!h.acknowledgedAt) {
            h.acknowledgedAt = at;
            h.acknowledgedBy = actor.sessionId;
            if (hid === replyTo) acknowledged = true;
          }
          answered.push(hid);
        }
        if (answered.length) m.answers = answered;
        m.ack = { required: true, rev: 0, state: null };
      }
      list.push(m);
      touch(t, m);
      topic = t.id;
      if (queen) bumpInbox(d, cell.id);
      prune(d, cell.id, list, removed);
      pruneThreads(d, cell.id);
    });
  } catch (err) { await removeAttachments(rt, cell.id, id); throw err; }
  await removeAttachmentBatch(rt, cell.id, removed);
  rt.changed();
  const link = hiveLink(cell.id, topic, id);
  return { message_id: id, cell_id: cell.id, thread_id: topic, link, next_step: `If you raise a Needs You request about this message, include [Open Hive message](${link}) in its body.`, acknowledged_reply_target: acknowledged, answered };
}

export function acknowledgeInput(rt, actor, { message_ids }) {
  if (rt.metadata.error) throw new HiveError(rt.metadata.error, 'metadata-unavailable');
  requireQueen(actor, 'acknowledge human input');
  if (!Array.isArray(message_ids) || !message_ids.length) throw new HiveError('message_ids is required.');
  const cell = actor.cell;
  const at = Date.now();
  const done = [];
  const unknown = [];
  const waiting = [];
  rt.metadata.mutate((d) => {
    const list = messagesOf(d, cell.id);
    for (const mid of message_ids.slice(0, 100)) {
      const m = list.find((x) => x.id === mid && x.author === 'human');
      if (!m) { unknown.push(mid); continue; }
      if (!m.acknowledgedAt) {
        m.acknowledgedAt = at;
        m.acknowledgedBy = actor.sessionId;
      }
      done.push(mid);
      if (awaitingQueen(m)) waiting.push(mid);
    }
  });
  rt.changed();
  return { acknowledged: done, unknown, still_awaiting_response: waiting };
}


// What the queen's terminal receives: a topic line, the one id to reply to
// or acknowledge, who an answer is to when it is one, then the human's text
// exactly as written. How to act on it is in the hive-queen skill.
export function deliveryText({ cell, taskName, message, bead, target, thread, attachmentDir }) {
  const topic = [oneLine(taskName), bead ? oneLine(bead.title) : ''].filter(Boolean).join(' › ');
  const lines = [`[Hive] ${topic || 'Message from the human'}`, `reply_to: ${message.id}`];
  const aboutId = message.beadId || contextOf(message)?.beadId;
  if (aboutId) lines.push(`bead_id: ${aboutId}`);
  if (thread) lines.push(`topic: ${clip(oneLine(thread.title), THREAD_TITLE_MAX)} (${thread.id})`);
  if (target) {
    let who = 'an earlier human message';
    if (target.author === 'session') who = target.sessionId === cell.queenSessionId ? 'your message' : `session ${target.sessionId}`;
    lines.push(`Re ${who}: "${clip(oneLine(target.text), QUOTE_LIMIT)}"`);
  }
  lines.push('', message.text);
  for (const a of message.attachments || []) lines.push(`Image: ${a.alt} (${attachmentDir}/${a.file})`);
  return lines.join('\n');
}

// Reading the conversation and settling what the human owes stay open in a
// hive that is turned off; sending to its queen does not.
function readableCell(rt, cellId) {
  if (rt.metadata.error) throw new HiveError(rt.metadata.error, 'metadata-unavailable');
  const cell = rt.metadata.cell(cellId);
  if (!cell) throw new HiveError(`Unknown cell ${cellId}.`);
  refuseSnapshot(cell);
  return cell;
}

function humanCell(rt, cellId) {
  const cell = readableCell(rt, cellId);
  if (!cell.enabled) throw new HiveError('This cell is turned off.');
  return cell;
}

// A message that is neither a reply nor sent in a topic starts a topic,
// named from its first line unless an older page sent a title. newThread
// carries what the topic is about; a page older than topics sends none, and
// its message's own item is used. A reply settles the queen message it
// answers only at the acknowledgement revision the human saw (ackRev): a
// reply sent before a later read, reaction or undo is still stored and still
// waits for its own answer, but leaves that newer choice alone. A page that
// sends no ackRev predates acknowledgements and settles nothing. A message
// sent into an existing topic also marks read every queen message there up
// to the newest one the page showed (readThrough), in the same save, so one
// that arrives later still waits. A readThrough from another topic, or no
// longer kept, marks nothing.
export const recordHumanInput = (rt, args) => messageWrite(rt, args.cellId, () => recordHumanMessage(rt, args));

export function recordHumanReaction(rt, { cellId, messageId, reaction, rev }) {
  if (!['approve', 'decline'].includes(reaction)) return Promise.reject(new HiveError('Choose Yes or No.'));
  return messageWrite(rt, cellId, () => {
    humanCell(rt, cellId);
    requireHumanTarget(rt.metadata.read(), cellId, null, messageId);
    return recordHumanMessage(rt, {
      cellId, replyTo: messageId, ackRev: rev, readThrough: messageId, reaction,
      text: reaction === 'approve' ? 'Yes' : 'No',
    });
  });
}

async function recordHumanMessage(rt, { cellId, text: body, beadId, replyTo, threadId, newThread, ackRev = null, readThrough = null, images, reaction = null }) {
  let cell = humanCell(rt, cellId);
  const clean = text(body, 'text', MESSAGE_MAX, { required: true });
  const bead = beadRef(rt, cellId, beadId, null);
  const reply = replyRef(rt, cellId, replyTo);
  const topicId = threadRef(threadId);
  requireHumanTarget(rt.metadata.read(), cellId, topicId, reply);
  let fresh = null;
  if (newThread && (reply || topicId)) throw new HiveError('A new topic cannot also be a reply.');
  if (!reply && !topicId) {
    const title = newThread?.title ? text(newThread.title, 'title', THREAD_TITLE_MAX) : '';
    const about = newThread ? beadRef(rt, cellId, newThread.beadId, null) || bead : bead;
    fresh = { title: title || autoTitle(clean), titleBy: title ? 'human' : 'hive', beadId: about };
  }
  const id = newId('msg');
  const kept = await adoptAttachments(rt, cellId, id, images, { client: true });
  const removed = [];
  let settled = null;
  let markedRead = 0;
  let reactionResult = null;
  try {
    cell = humanCell(rt, cellId);
    requireHumanTarget(rt.metadata.read(), cellId, topicId, reply);
    beadRef(rt, cellId, beadId, null); replyRef(rt, cellId, replyTo);
    if (fresh?.beadId) beadRef(rt, cellId, fresh.beadId, null);
    rt.metadata.mutate((d) => {
      threadCell(d, cellId);
      inboxCell(d, cellId);
      const list = messagesOf(d, cellId);
      const visible = new Set(humanConversationDoc(d, cellId).conversation[cellId].map(m => m.id));
      const at = Date.now();
      const t = fresh
        ? makeThread(d, cellId, { ...fresh, by: 'human', origin: 'new', at })
        : joinThread(d, cellId, { replyTo: reply, threadId: topicId });
      const target = reply ? list.find((x) => x.id === reply) : null;
      if (reaction) {
        if (target?.author !== 'session' || target.role !== 'queen' || !target.ack?.required) throw new HiveError('Only queen messages can receive Yes or No.');
        if (target.ack.state?.reaction === reaction && target.ack.state.replyId) {
          reactionResult = { messageId: target.id, threadId: t.id, ack: target.ack, marked: [], inboxRev: inboxRev(humanConversationDoc(d, cellId), cellId), reactionMessageId: target.ack.state.replyId, created: false };
          return;
        }
        if (!currentAck(target, ackRev, 'reaction')) throw new HiveError('This message changed since you saw it. Look again, then try once more.', 'stale');
      }
      const m = {
        id, cellId, author: 'human', requestScopeId: null, sessionId: null, text: clean, attachments: kept, beadId: bead, replyTo: reply, threadId: t.id, at,
        delivery: { state: cell.queenSessionId ? 'pending' : 'no-queen', sessionId: cell.queenSessionId || null, attempts: [] },
        acknowledgedAt: null,
        acknowledgedBy: null,
        response: { required: true, answers: [] },
        context: contextAt(rt, bead, target, t),
        ...(reaction ? { reaction } : {}),
      };
      if (reaction) {
        target.ack.state = { kind: 'reaction', reaction, by: HUMAN, at, replyId: id };
        target.ack.rev += 1;
        settled = true;
      } else if (target && awaitingHuman(target)) {
        settled = Number.isInteger(ackRev) && ackRev === target.ack.rev;
        if (settled) {
          target.ack.state = { kind: 'reply', by: HUMAN, at, replyId: id };
          target.ack.rev += 1;
        }
      }
      const anchor = fresh || !readThrough || !visible.has(readThrough) ? -1 : list.findIndex((x) => x.id === readThrough);
      const bound = anchor >= 0 && list[anchor].threadId === t.id ? anchor : -1;
      const marked = [];
      for (let i = 0; i <= bound; i += 1) {
        const x = list[i];
        if (!visible.has(x.id) || x.threadId !== t.id || !awaitingHuman(x) || (x === target && settled === false)) continue;
        x.ack.state = { kind: 'read', by: HUMAN, at };
        x.ack.rev += 1;
        markedRead += 1;
        marked.push({ messageId: x.id, ack: x.ack });
      }
      list.push(m);
      touch(t, m);
      bumpInbox(d, cellId);
      prune(d, cellId, list, removed);
      pruneThreads(d, cellId);
      if (reaction) reactionResult = { messageId: target.id, threadId: t.id, ack: target.ack, marked, inboxRev: inboxRev(humanConversationDoc(d, cellId), cellId), reactionMessageId: id, created: true };
    });
  } catch (err) { await removeAttachments(rt, cellId, id); throw err; }
  await removeAttachmentBatch(rt, cellId, removed);
  return reactionResult || { ...findMessage(rt, cellId, id), ackSettled: settled, markedRead };
}

// The human marks a queen message read or reacts to it. Repeating a choice
// changes nothing. An explicit read or reaction can supersede the automatic
// read immediately after the revision shown; other stale changes are refused.
// Reading a message reads the topic up to it: every earlier queen message in
// the topic still waiting for the human is marked read in the same save, and
// listed in `marked`, only for the current or immediately preceding automatic
// revision. A late repeat cannot undo a newer Undo. Neither is delivered to the queen.
export function acknowledgeMessage(rt, { cellId, messageId, kind, emoji, rev }) {
  readableCell(rt, cellId);
  if (kind !== 'read' && kind !== 'reaction') throw new HiveError('Mark the message read, or react to it.');
  if (kind === 'reaction' && !ACK_EMOJI.includes(emoji)) throw new HiveError('Choose one of the offered reactions.');
  return changeAck(rt, cellId, messageId, rev, (state) => {
    if (state?.kind === kind && (state.emoji || null) === (kind === 'reaction' ? emoji : null) && !(kind === 'read' && state.automatic)) return state;
    return kind === 'reaction' ? { kind, emoji, by: HUMAN, at: Date.now() } : { kind, by: HUMAN, at: Date.now() };
  }, true);
}

export function autoReadMessages(rt, { cellId, messages }) {
  readableCell(rt, cellId);
  if (!Array.isArray(messages) || !messages.length || messages.length > 100 || messages.some(m => !m || typeof m.messageId !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(m.messageId) || !Number.isInteger(m.rev) || m.rev < 0)) throw new HiveError('Send at most 100 message ids with their acknowledgement revisions.');
  const wanted = new Map(messages.map(m => [m.messageId, m.rev]));
  let out;
  rt.metadata.mutate(d => {
    for (const m of messages) requireHumanTarget(d, cellId, null, m.messageId);
    const acks = [];
    let changed = false;
    for (const m of messagesOf(d, cellId)) {
      if (!wanted.has(m.id) || m.author !== 'session' || !m.ack?.required) continue;
      if (!m.ack.state && m.ack.rev === wanted.get(m.id)) {
        m.ack.state = { kind: 'read', automatic: true, by: HUMAN, at: Date.now() };
        m.ack.rev += 1;
        changed = true;
      }
      acks.push({ messageId: m.id, ack: m.ack });
    }
    if (changed) bumpInbox(d, cellId);
    out = { acks, inboxRev: inboxRev(humanConversationDoc(d, cellId), cellId) };
  });
  return out;
}

// The human takes one of their own messages out of Waiting for queen
// without asking the queen to reply. A message the queen has already
// answered has nothing left to withdraw. Repeating either change does
// nothing; Undo of a message answered since leaves it answered.
function changeWithdrawal(rt, cellId, messageId, withdraw) {
  readableCell(rt, cellId);
  let out;
  rt.metadata.mutate((d) => {
    const m = messagesOf(d, cellId).find((x) => x.id === messageId);
    if (!m || m.author !== 'human' || !m.response?.required) throw new HiveError('That is not one of your own messages.');
    if (withdraw && m.response.answers?.length) throw new HiveError('The queen has already answered that message.');
    if (withdraw !== Boolean(m.response.withdrawn)) {
      if (withdraw) m.response.withdrawn = { by: HUMAN, at: Date.now() };
      else delete m.response.withdrawn;
      bumpInbox(d, cellId);
    }
    out = { messageId, threadId: m.threadId, response: m.response, inboxRev: inboxRev(humanConversationDoc(d, cellId), cellId) };
  });
  return out;
}

export const withdrawMessage = (rt, { cellId, messageId }) => changeWithdrawal(rt, cellId, messageId, true);
export const undoWithdraw = (rt, { cellId, messageId }) => changeWithdrawal(rt, cellId, messageId, false);

// Puts a queen message back in the inbox. A reply that settled it stays,
// with its own wait for an answer. Earlier messages read along with it stay
// read.
export function undoAcknowledge(rt, { cellId, messageId, rev }) {
  readableCell(rt, cellId);
  return changeAck(rt, cellId, messageId, rev, () => null);
}

function currentAck(m, rev, kind) {
  return rev === m.ack.rev || (Number.isInteger(rev) && m.ack.state?.kind === 'read' && m.ack.state.automatic === true && rev + 1 === m.ack.rev && ['read', 'reaction'].includes(kind));
}

function changeAck(rt, cellId, messageId, rev, next, through = false) {
  let out;
  rt.metadata.mutate((d) => {
    requireHumanTarget(d, cellId, null, messageId);
    const visible = new Set(humanConversationDoc(d, cellId).conversation[cellId].map(m => m.id));
    const list = messagesOf(d, cellId);
    const at = list.findIndex((x) => x.id === messageId);
    const m = list[at];
    if (!m || m.author !== 'session' || !m.ack?.required) throw new HiveError('That message does not wait for you.');
    const want = next(m.ack.state);
    const current = currentAck(m, rev, want?.kind);
    let changed = false;
    if (want !== m.ack.state) {
      if (!current) throw new HiveError('This message changed since you saw it. Look again, then try once more.', 'stale');
      m.ack.state = want;
      m.ack.rev += 1;
      changed = true;
    }
    const marked = [];
    if (through && current && m.ack.state) {
      const now = Date.now();
      for (const x of list.slice(0, at)) {
        if (!visible.has(x.id) || x.threadId !== m.threadId || !awaitingHuman(x)) continue;
        x.ack.state = { kind: 'read', by: HUMAN, at: now };
        x.ack.rev += 1;
        marked.push({ messageId: x.id, ack: x.ack });
      }
    }
    if (changed || marked.length) bumpInbox(d, cellId);
    out = { messageId, threadId: m.threadId, ack: m.ack, marked, inboxRev: inboxRev(humanConversationDoc(d, cellId), cellId) };
  });
  return out;
}

// Outstanding messages of one kind, oldest first, paged by their own cursor
// rather than by topic: 'human' waits for the human, 'queen' for the queen.
export function inboxSlice(doc, cellId, awaiting, { after = null, limit = INBOX_PAGE } = {}) {
  const list = doc.conversation[cellId] || [];
  const all = list.filter(awaiting === 'queen' ? awaitingQueen : awaitingHuman);
  let start = 0;
  if (after) {
    const i = all.findIndex((m) => m.id === after.id);
    if (i >= 0) start = i + 1;
    else {
      const at = list.findIndex((m) => m.id === after.id);
      const pos = new Map(list.map((m, n) => [m.id, n]));
      start = at >= 0 ? all.findIndex((m) => pos.get(m.id) > at) : all.findIndex((m) => m.at >= after.at);
    }
    if (start < 0) start = all.length;
  }
  const n = Math.min(INBOX_PAGE_MAX, Math.max(1, Number.isInteger(limit) ? limit : INBOX_PAGE));
  const page = all.slice(start, start + n);
  const last = page.at(-1);
  return {
    awaiting, count: all.length, rev: inboxRev(doc, cellId), ids: page.map((m) => m.id), more: start + n < all.length, after: last ? { id: last.id, at: last.at } : after,
    ...(awaiting === 'human' ? { acknowledgements: Object.fromEntries(list.filter(m => m.author === 'session' && m.ack?.required).map(m => [m.id, { rev: m.ack.rev, waiting: awaitingHuman(m), threadId: m.threadId }])) } : {}),
  };
}

// A later page of the inbox, with the messages themselves, the newest
// waiting message of each of their topics, the message each one replies to
// and their topics.
export function inboxPage(rt, { cellId, awaiting, after, limit }) {
  readableCell(rt, cellId);
  if (awaiting !== 'human' && awaiting !== 'queen') throw new HiveError('Unknown inbox.');
  const doc = humanConversationDoc(rt.metadata.read(), cellId);
  const slice = inboxSlice(doc, cellId, awaiting, { after, limit });
  const list = doc.conversation[cellId] || [];
  const byId = new Map(list.map((m) => [m.id, m]));
  const index = threadIndex(list);
  const keep = new Set();
  const ids = [...slice.ids, ...slice.ids.map((id) => index.get(byId.get(id)?.threadId)?.awaiting[awaiting]?.newest.id)];
  for (const id of ids) {
    if (!byId.has(id)) continue;
    keep.add(id);
    for (const to of linkedTargets(byId.get(id))) if (byId.has(to)) keep.add(to);
  }
  const messages = list.filter((m) => keep.has(m.id));
  const records = threadRecords(doc, cellId);
  const threads = [];
  for (const tid of new Set(messages.map((m) => m.threadId))) {
    const t = threadIn(records, tid);
    if (t) threads.push(threadSummary(t, index.get(tid)));
  }
  return { ...slice, messages, threads, conversationRevision: doc.conversationRevision };
}

export function renameThread(rt, { cellId, threadId, title }) {
  rt.metadata.lifetime?.assertCurrent();
  humanCell(rt, cellId);
  requireHumanTarget(rt.metadata.read(), cellId, threadId);
  const clean = text(title, 'title', THREAD_TITLE_MAX, { required: true });
  const id = threadRef(threadId);
  rt.metadata.mutate((d) => {
    const t = id && threadIn(threadsOf(d, cellId), id);
    if (!t) throw new HiveError('Unknown topic in this cell.');
    t.title = clean;
    t.titleBy = 'human';
  });
  return { threadId: id, title: clean };
}

export function topicRelations(rt, { cellId, threadId }) {
  readableCell(rt, cellId);
  const doc = humanConversationDoc(rt.metadata.read(), cellId);
  const t = threadIn(threadRecords(doc, cellId), threadId);
  if (!t) throw new HiveError('Unknown topic in this cell.');
  const mine = (doc.conversation[cellId] || []).filter(m => m.threadId === threadId);
  return { threadId, relations: threadRelations(t, threadIndex(mine, { references: true }).get(threadId) || { beads: new Set(), references: new Set() }), conversationRevision: doc.conversationRevision };
}

// Retained messages of one topic, newest page first, or those older than
// `before` for Load earlier. Reads only.
export function threadHistory(rt, { cellId, threadId, before, limit }) {
  readableCell(rt, cellId);
  const doc = humanConversationDoc(rt.metadata.read(), cellId);
  const t = threadIn(threadRecords(doc, cellId), threadId);
  if (!t) throw new HiveError('Unknown topic in this cell.');
  const mine = (doc.conversation[cellId] || []).filter((m) => m.threadId === threadId);
  const end = before ? mine.findIndex((m) => m.id === before) : mine.length;
  if (end < 0) throw new HiveError('That message is no longer kept.');
  const n = Math.min(HISTORY_MAX, Math.max(1, Number.isInteger(limit) ? limit : 40));
  const start = Math.max(0, end - n);
  return {
    threadId,
    messages: mine.slice(start, end),
    more: start > 0,
    anchorN: before ? mine[end].n : (mine.at(-1)?.n || t.count || 0) + 1,
    earlierRemoved: Boolean(t.earlierRemoved) || mine.length < (t.count || 0),
    conversationRevision: doc.conversationRevision,
  };
}

// Topics older than a cursor, for All topics beyond the newest page. Reads
// only. The cursor is the last summary of the previous page.
export function threadList(rt, { cellId, after, limit }) {
  readableCell(rt, cellId);
  const doc = humanConversationDoc(rt.metadata.read(), cellId);
  const index = threadIndex(doc.conversation[cellId] || []);
  const all = ownThreads(threadRecords(doc, cellId)).sort(byRecent);
  let start = 0;
  if (after) {
    const i = all.findIndex((t) => t.id === after.id);
    start = i >= 0 ? i + 1 : all.findIndex((t) => byRecent(t, { id: after.id, lastAt: after.lastAt }) > 0);
    if (start < 0) start = all.length;
  }
  const n = Math.min(THREAD_PAGE, Math.max(1, Number.isInteger(limit) ? limit : THREAD_PAGE));
  const page = all.slice(start, start + n);
  const last = page.at(-1);
  return {
    threads: page.map((t) => threadSummary(t, index.get(t.id))),
    more: start + n < all.length,
    after: last ? { id: last.id, lastAt: last.lastAt } : after || null,
    conversationRevision: doc.conversationRevision,
  };
}

// Queen or coordinator: retitle a topic or move it to another item. A topic
// the human named keeps its name; hive-wide topics are the queen's.
export function updateThread(rt, actor, { thread_id, title, bead_id }) {
  if (rt.metadata.error) throw new HiveError(rt.metadata.error, 'metadata-unavailable');
  requireCoordinator(actor, 'retitle or move a topic');
  const cell = actor.cell;
  const id = threadRef(thread_id);
  requireAudienceTarget(rt.metadata.read(), cell.id, id, null, actor);
  const t = id && threadIn(threadRecords(rt.metadata.read(), cell.id), id);
  if (!t) throw new HiveError(`Unknown topic ${thread_id} in this cell.`);
  if (title === undefined && bead_id === undefined) throw new HiveError('Give a title or a bead_id.');
  const clean = title === undefined ? undefined : text(title, 'title', THREAD_TITLE_MAX, { required: true });
  if (clean !== undefined && t.titleBy === 'human') throw new HiveError('The human named this topic. Ask them if it should be renamed.');
  let anchor;
  if (bead_id !== undefined) anchor = bead_id === '' ? null : beadRef(rt, cell.id, bead_id, actor);
  if (actor.role !== 'queen') {
    if (!t.beadId || anchor === null) throw new HiveError('Only the queen can change a hive-wide topic or make a topic hive-wide.');
    requireBeadAccess(rt, actor, t.beadId);
  }
  let out;
  rt.metadata.mutate((d) => {
    const cur = threadIn(threadsOf(d, cell.id), id);
    if (!cur) throw new HiveError(`Unknown topic ${thread_id} in this cell.`);
    if (clean !== undefined) {
      if (cur.titleBy === 'human') throw new HiveError('The human named this topic. Ask them if it should be renamed.');
      cur.title = clean;
      cur.titleBy = actor.sessionId;
      if (cur.origin === 'request') {
        const visible = humanConversationDoc(d, cell.id).threads[cell.id][id];
        const scope = Object.values(d.requests || {}).find(r => r.threadId === id && r.cellId === cell.id && maySeeRequest(r, actor));
        cur.titleScopeId = visible ? null : scope?.id || 'unavailable';
        cur.titleScopeRevision = scope?.contentRevision || null;
      }
    }
    if (anchor !== undefined) cur.beadId = anchor;
    out = { thread_id: cur.id, title: audienceConversationDoc(d, cell.id, actor).threads[cell.id][id].title, bead_id: cur.beadId };
  });
  rt.changed();
  return out;
}

// Persist the attempt, deliver once, record what the host actually said. A
// message is marked delivered only on the host's word, and an uncertain or
// in-flight attempt is never repeated automatically.
export async function deliver(rt, host, { cellId, messageId, force = false }) {
  requireHumanTarget(rt.metadata.read(), cellId, null, messageId);
  const key = `${cellId}\u0000${messageId}`;
  if (inFlight.has(key)) return { message_id: messageId, state: 'pending', inFlight: true };
  inFlight.add(key);
  try {
    const cell = rt.metadata.cell(cellId);
    const msg = findMessage(rt, cellId, messageId);
    if (!cell || !msg || msg.author !== 'human') throw new HiveError('Unknown human message.');
    refuseSnapshot(cell);
    if (msg.acknowledgedAt) return { message_id: messageId, state: 'acknowledged' };
    if (msg.response?.withdrawn && !msg.response.answers?.length) return { message_id: messageId, state: 'withdrawn' };
    if (!cell.enabled) throw new HiveError('This hive is off. Turn it on to send to its queen.');
    const state = msg.delivery?.state;
    if (state === 'delivered' && !force) return { message_id: messageId, state };
    if (state === 'uncertain' && !force) throw new HiveError('The last delivery attempt has an unknown outcome. Check with the queen, then mark it received or explicitly send it again.');
    if (state === 'pending' && msg.delivery.attempts.length && !force) throw new HiveError('A delivery attempt is still unresolved. Mark it received or explicitly send it again.');
    if (!cell.queenSessionId) {
      rt.metadata.mutate((d) => {
        const m = messagesOf(d, cellId).find((x) => x.id === messageId);
        m.delivery = { ...m.delivery, state: 'no-queen', sessionId: null };
      });
      return { message_id: messageId, state: 'no-queen' };
    }
    const attemptId = newId('try');
    const target = cell.queenSessionId;
    rt.metadata.mutate((d) => {
      const m = messagesOf(d, cellId).find((x) => x.id === messageId);
      m.delivery = { ...m.delivery, state: 'pending', sessionId: target };
      m.delivery.attempts = [...(m.delivery.attempts || []), { id: attemptId, sessionId: target, at: Date.now(), state: 'pending' }].slice(-10);
    });
    rt.changed();
    const taskName = host.tasks.get(cell.taskId)?.name || cell.taskId;
    const aboutId = msg.beadId || contextOf(msg)?.beadId;
    const bead = aboutId ? rt.snapshots.graph.beads[aboutId] || null : null;
    const replyTarget = msg.replyTo ? findMessage(rt, cellId, msg.replyTo) : null;
    const thread = threadIn(threadRecords(rt.metadata.read(), cellId), msg.threadId);
    const outcome = await safeDeliver(host, target, deliveryText({ cell, taskName, message: msg, bead, target: replyTarget, thread, attachmentDir: msg.attachments?.length ? messageDir(rt, cellId, messageId) : null }), rt);
    rt.metadata.mutate((d) => {
      const m = messagesOf(d, cellId).find((x) => x.id === messageId);
      if (!m) return;
      const attempt = m.delivery.attempts.find((a) => a.id === attemptId);
      if (attempt) Object.assign(attempt, outcome, { finishedAt: Date.now() });
      const latest = m.delivery.attempts.at(-1);
      if (latest?.id === attemptId) m.delivery = { ...m.delivery, state: outcome.state, error: outcome.error, sessionId: target };
    });
    return { message_id: messageId, state: outcome.state, error: outcome.error };
  } finally {
    inFlight.delete(key);
    rt.changed();
  }
}

export function markReceived(rt, { cellId, messageId }) {
  requireHumanTarget(rt.metadata.read(), cellId, null, messageId);
  const msg = findMessage(rt, cellId, messageId);
  if (!msg || msg.author !== 'human') throw new HiveError('Unknown human message.');
  rt.metadata.mutate((d) => {
    const m = messagesOf(d, cellId).find((x) => x.id === messageId);
    m.delivery = { ...m.delivery, state: 'delivered', confirmedByHuman: Date.now() };
  });
  return { message_id: messageId, state: 'delivered' };
}

export async function cellContextConversation(rt, host, actor, { recent = 20, bead_id } = {}, render = out => out) {
  const inbox = actor.role === 'queen' && !bead_id ? await attachmentsInbox(rt, actor.cell.id) : undefined;
  actor = resolveCaller(rt, host, actor.sessionId, actor.cell.id);
  const doc = audienceConversationDoc(rt.metadata.read(), actor.cell.id, actor);
  const visibleThreads = threadRecords(doc, actor.cell.id);
  const anchoredIds = new Set(ownThreads(visibleThreads).filter(t => t.beadId === bead_id).map(t => t.id));
  const list = (doc.conversation[actor.cell.id] || []).filter(m => !bead_id || anchoredIds.has(m.threadId) || m.beadId === bead_id || contextOf(m)?.beadId === bead_id || m.relatedBeadIds?.includes(bead_id));
  const threadIds = new Set([...anchoredIds, ...list.map(m => m.threadId)]);
  const threads = bead_id ? Object.fromEntries(Object.entries(visibleThreads).filter(([id]) => threadIds.has(id))) : visibleThreads;
  const shape = (m) => ({
    message_id: m.id,
    link: hiveLink(actor.cell.id, m.threadId, m.id),
    from: m.author === 'human' ? 'human' : m.sessionId,
    role: m.role,
    text: m.text,
    reaction: m.reaction || undefined,
    attachments: m.attachments?.length ? m.attachments.map((a) => ({ ...a, file_path: `${messageDir(rt, actor.cell.id, m.id)}/${a.file}` })) : undefined,
    bead_id: m.beadId || undefined,
    about: contextOf(m)?.beadId || undefined,
    reply_to: m.replyTo || undefined,
    thread_id: m.threadId || undefined,
    answers: m.answers?.length ? m.answers : undefined,
    awaiting_answer: m.author === 'human' && m.response?.required ? awaitingQueen(m) : undefined,
    withdrawn_by_human: m.author === 'human' && m.response?.withdrawn && !m.response.answers?.length ? true : undefined,
    human_acknowledged: m.ack?.required ? (m.ack.state ? (m.ack.state.kind === 'read' ? 'seen' : m.ack.state.reaction || m.ack.state.kind) + (m.ack.state.emoji ? ` ${m.ack.state.emoji}` : '') : false) : undefined,
    at: new Date(m.at).toISOString(),
  });
  const out = {
    ...(actor.role === 'queen' && !bead_id ? { attachments_inbox: inbox } : {}),
    conversation: list.slice(-recent).map(shape),
    threads: ownThreads(threads)
      .sort(byRecent)
      .slice(0, CONTEXT_THREADS)
      .map((t) => {
        const kept = retained(list, t.id);
        return { thread_id: t.id, link: hiveLink(actor.cell.id, t.id), title: t.title, bead_id: t.beadId || undefined, last_at: new Date(t.lastAt).toISOString(), message_count: kept, earlier_removed: Boolean(t.earlierRemoved) || kept < (t.count || 0) };
      }),
  };
  if (actor.role === 'queen') {
    out.unacknowledged_input = list.filter((m) => m.author === 'human' && !m.acknowledgedAt).slice(-50)
      .map((m) => ({ ...shape(m), thread_title: threadIn(threads, m.threadId)?.title, delivery: m.delivery?.state }));
    const waiting = list.filter(awaitingQueen);
    out.awaiting_response = waiting.slice(0, 50).map((m) => ({ ...shape(m), thread_title: threadIn(threads, m.threadId)?.title }));
    out.awaiting_response_total = waiting.length;
    out.withdrawn_by_human = list.filter((m) => m.author === 'human' && m.response?.withdrawn && !m.response.answers?.length).slice(-50).map((m) => ({ ...shape(m), thread_title: threadIn(threads, m.threadId)?.title }));
    out.awaiting_human_acknowledgement = list.filter(awaitingHuman).length;
  }
  return render(out, actor);
}

export function resolveDeepLink(rt, { cellId, threadId, messageId, restore = false }) {
  try { readableCell(rt, cellId); }
  catch { return { cellId: null, notice: 'That hive is unavailable. Showing all hives.' }; }
  const fallback = { cellId, notice: 'That topic or message is unavailable. Showing the hive.' };
  if (!threadId && !messageId) return { cellId };
  try {
    const doc = humanConversationDoc(rt.metadata.read(), cellId);
    const request = messageId && Object.values(rt.metadata.read().requests || {}).find(r => r.cellId === cellId && r.messageId === messageId);
    if (request && !maySeeRequest(request)) return fallback;
    if (messageId && (rt.metadata.read().conversation[cellId] || []).some(m => m.id === messageId) && !doc.conversation[cellId].some(m => m.id === messageId)) return fallback;
    const t = threadIn(threadRecords(doc, cellId), threadId);
    if (!t) return fallback;
    const mine = (doc.conversation[cellId] || []).filter(m => m.threadId === threadId);
    const targetAt = messageId ? mine.findIndex(m => m.id === messageId) : mine.length - 1;
    if (messageId && targetAt < 0 && !restore) return fallback;
    const at = targetAt < 0 ? mine.length - 1 : targetAt;
    const end = Math.min(mine.length, at + 21);
    const start = Math.max(0, end - 40);
    return {
      cellId, thread: threadSummary(t, threadIndex(mine).get(threadId)), messageId: targetAt >= 0 ? messageId || null : null,
      messages: mine.slice(start, end), more: start > 0,
      anchorN: mine[end]?.n ?? (mine.at(-1)?.n || t.count || 0) + 1,
      conversationRevision: doc.conversationRevision,
    };
  } catch { return fallback; }
}

export function pruneConversation(doc, cellId) {
  const removed = [];
  prune(doc, cellId, doc.conversation[cellId] || [], removed);
  pruneThreads(doc, cellId);
  return removed;
}
