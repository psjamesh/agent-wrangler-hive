import test from 'node:test';
import assert from 'node:assert/strict';
import client, { createUi, restoreScroll, captureFocus, restoreFocus, resolveLink } from './client.js';
import { parseHiveLink } from './deep-links.js';
import { requestCard, requestList } from './requests.js';
import { cellPanels } from './cell-view.js';
import { renderConversation, earliestWaiting, startTarget } from './conversation.js';

class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.attributes = {}; this.events = {}; this.dataset = {}; this.style = {}; this.classList = { add() {}, remove() {} }; this.value = ''; }
  setAttribute(key, value) { this.attributes[key] = value; if (key === 'checked') this.checked = true; if (key === 'data-focus-key') this.dataset.focusKey = value; }
  getAttribute(key) { return this.attributes[key] ?? null; }
  isEqualNode(other) {
    if (!(other instanceof Element) || this.tagName !== other.tagName || this.children.length !== other.children.length) return false;
    if (JSON.stringify(this.attributes) !== JSON.stringify(other.attributes) || JSON.stringify(this.dataset) !== JSON.stringify(other.dataset)) return false;
    return this.children.every((child, i) => child instanceof Element ? child.isEqualNode(other.children[i]) : child === other.children[i]);
  }
  focus() { document.activeElement = this; }
  addEventListener(key, fn) { (this.events[key] ||= []).push(fn); }
  removeEventListener(key, fn) { this.events[key] = (this.events[key] || []).filter(listener => listener !== fn); }
  get childNodes() { return this.children; }
  get firstChild() { return this.children[0] || null; }
  get lastChild() { return this.children.at(-1) || null; }
  get parentNode() { return this.parentElement || null; }
  removeChild(node) { this.children.splice(this.children.indexOf(node), 1); if (node instanceof Element) node.parentElement = null; return node; }
  fire(key, props = {}) { const event = { type: key, target: this, isTrusted: true, preventDefault() {}, ...props }; for (let el = this; el; el = el.parentElement) { for (const fn of el.events[key] || []) fn(event); el['on' + key]?.(event); } }
  append(...nodes) { for (const node of nodes) { if (node instanceof Element) { node.parentElement?.removeChild(node); node.parentElement = this; } this.children.push(node); } }
  replaceChildren(...nodes) { for (const child of [...this.children]) this.removeChild(child); this.append(...nodes); }
  insertBefore(node, before) { if (node === before) return; if (node instanceof Element) { node.parentElement?.removeChild(node); node.parentElement = this; } const i = this.children.indexOf(before); this.children.splice(i < 0 ? this.children.length : i, 0, node); }
  querySelectorAll(selector) { return descendants(this).slice(1).filter((el) => selector.startsWith('.') ? (el.attributes.class || '').split(' ').includes(selector.slice(1)) : el.tagName === selector); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  contains(node) { return descendants(this).includes(node); }
  get textContent() { return this.children.map((el) => el instanceof Element ? el.textContent : el).join(''); }
  set textContent(value) { this.children = [String(value)]; }
}
const descendants = (el) => [el, ...el.children.filter((el) => el instanceof Element).flatMap(descendants)];
function fixture(t, saved = {}) {
  const before = { document: globalThis.document, Node: globalThis.Node };
  globalThis.Node = Element;
  globalThis.document = { createElementNS: (_, tag) => new Element(tag), createElement: (tag) => new Element(tag), createTextNode: (text) => String(text), body: new Element('body') };
  t.after(() => Object.assign(globalThis, before));
  const values = new Map(Object.entries({ cell: 'cell_test', 'bead:cell_test': 'hive-one', ...saved }).map(([k, v]) => [k, JSON.stringify(v)]));
  const storage = { get: (k) => values.get(k), set: (k, v) => values.set(k, v), remove: (k) => values.delete(k) };
  let view;
  client.register({ api: { storage }, register(slot, contribution) { if (slot === 'view') view = contribution; } });
  const ui = createUi(), sent = [], replies = [], relationRequests = [];
  const ctx = { busy: () => false, send: (frame, opts) => { if (frame.type === 'hive-thread-relations') { relationRequests.push({ frame, opts }); return; } sent.push(frame); replies.push(opts); }, notice() {} };
  const cell = { id: 'cell_test', rootBeadId: 'hive-root', enabled: true, queenSessionId: 'queen', messages: [], threads: [] };
  const hive = { metaEpoch: 'test', beads: { 'hive-one': { id: 'hive-one', title: 'One' }, 'hive-two': { id: 'hive-two', title: 'Two' } } };
  let renderVersion = 0;
  const draw = () => { ctx.uiVersion = ++renderVersion; return renderConversation({ cell, hive, graph: { sessions: [] }, api: {}, ui, ctx }); };
  const send = (out) => { out.textarea.value = 'Hello queen'; out.textarea.fire('input'); out.composer.querySelector('.hive-btn-primary').fire('click'); return sent.at(-1); };
  return { ui, cell, hive, sent, replies, relationRequests, ctx, draw, send, storage, view };
}

test('new topics carry the selected bead as the selection and draft text change', (t) => {
  const f = fixture(t);
  let out = f.draw();
  assert.ok(out.composer.textContent.includes('About'));
  out.textarea.value = 'Unsent thought'; out.textarea.fire('input');
  f.ui.selectBead('hive-two'); out = f.draw();
  assert.equal(out.textarea.value, 'Unsent thought');
  assert.equal(f.send(out).newThread.beadId, 'hive-two');
});

test('a new topic sent with a bead selected carries it even if a re-render lands before send', (t) => {
  const f = fixture(t);
  const stale = f.draw();
  f.ui.selectBead('hive-two');
  f.draw();
  assert.equal(f.send(stale).newThread.beadId, 'hive-two');
});

test('new topics with nothing selected stay hive-wide', (t) => {
  const f = fixture(t);
  f.ui.selectBead('hive-root');
  const out = f.draw();
  assert.ok(out.composer.textContent.includes('Hive-wide'));
  assert.equal(f.send(out).newThread.beadId, null);
});

for (const inbox of [null, 'human', 'queen']) {
  test(`sending a new topic preserves the ${inbox || 'topics'} list and clears its saved draft`, (t) => {
    const f = fixture(t);
    f.cell.inbox = { human: { count: 0, ids: [], rev: 1 }, queen: { count: 0, ids: [], rev: 1 } };
    f.ui.setAllTopics(f.cell.id, true);
    f.ui.setInboxView(f.cell.id, inbox);
    const out = f.draw();
    const focusKey = out.focusKey;
    f.send(out);
    f.cell.threads = [{ id: thr, title: 'Hello queen', beadId: null, beads: [], count: 1, retained: 1, lastAt: 10 }];
    f.cell.messages = [{ id: 'h1', author: 'human', text: 'Hello queen', at: 10, n: 10, threadId: thr, response: { required: true, answers: [] } }];
    f.cell.inbox.queen = { count: 1, ids: ['h1'], rev: 2 };
    f.replies.at(-1).onReply({ ok: true, threadId: thr });
    assert.equal(f.ui.openThread(f.cell.id), null);
    assert.equal(f.ui.inboxView(f.cell.id), inbox);
    const after = f.draw();
    assert.equal(after.textarea.value, '');
    assert.equal(after.focusKey, focusKey);
    assert.equal(createUi().draftFor(`${f.cell.id}:new`), '');
    assert.ok(after.list.attributes.class.includes('hive-topics'));
    if (inbox !== 'human') assert.ok(after.list.textContent.includes('Hello queen'));
  });
}

test('a new-topic response preserves edits made while sending', (t) => {
  const f = fixture(t);
  const out = f.draw();
  f.send(out);
  out.textarea.value = 'Next thought'; out.textarea.fire('input');
  f.replies.at(-1).onReply({ ok: true, threadId: thr });
  assert.equal(f.ui.openThread(f.cell.id), null);
  assert.equal(f.draw().textarea.value, 'Next thought');
  assert.equal(createUi().draftFor(`${f.cell.id}:new`), 'Next thought');
});

test('sending a thread reply stays in that thread and clears only its saved draft', (t) => {
  const f = fixture(t);
  const thread = { id: thr, title: 'Topic', beadId: null, beads: [], count: 0, retained: 0 };
  f.cell.threads = [thread];
  f.ui.setAllTopics(f.cell.id, true);
  f.ui.setDraftFor(`${f.cell.id}:new`, 'Unsent topic');
  f.ui.openThreadFor(f.cell.id, thr, thread);
  const out = f.draw();
  assert.equal(f.send(out).threadId, thr);
  f.replies.at(-1).onReply({ ok: true, threadId: thr });
  assert.equal(f.ui.openThread(f.cell.id), thr);
  assert.equal(f.draw().focusKey, out.focusKey);
  assert.equal(f.draw().textarea.value, '');
  const reloaded = createUi();
  assert.equal(reloaded.draftFor(`${f.cell.id}:${thr}`), '');
  assert.equal(reloaded.draftFor(`${f.cell.id}:new`), 'Unsent topic');
});

test('an explicit About pin or Make hive-wide overrides the selection until sent', (t) => {
  const f = fixture(t);
  f.ui.setTopicAbout(f.cell.id, 'hive-one');
  f.ui.selectBead('hive-two'); let out = f.draw();
  assert.equal(f.send(out).newThread.beadId, 'hive-one');
  const clear = descendants(out.composer).find((el) => el.tagName === 'button' && el.textContent === 'Make hive-wide'); clear.fire('click');
  assert.equal(f.send(f.draw()).newThread.beadId, null);
  const key = `${f.cell.id}:new`; f.ui.setDraftFor(key, 'Saved'); f.ui.clearDraftIf(key, f.ui.draftRev(key));
  assert.equal(f.send(f.draw()).newThread.beadId, 'hive-two');
});

test('after Make hive-wide, About the selected bead re-attaches it', (t) => {
  const f = fixture(t);
  f.ui.setTopicAbout(f.cell.id, '');
  const out = f.draw();
  assert.ok(out.composer.textContent.includes('Hive-wide'));
  const back = descendants(out.composer).find((el) => el.tagName === 'button' && el.textContent === 'About "One"');
  assert.ok(back); back.fire('click');
  assert.equal(f.send(f.draw()).newThread.beadId, 'hive-one');
});

test('legacy automatic context is ignored while explicit saved topic context survives', (t) => {
  const automatic = fixture(t, { 'draft:cell_test:new': { text: 'Keep this text', about: 'hive-two', aboutAuto: true } });
  const out = automatic.draw(); assert.equal(out.textarea.value, 'Keep this text');
  assert.equal(automatic.send(out).newThread.beadId, 'hive-one');
  const explicit = fixture(t, { 'draft:cell_test:new': { text: 'Explicit draft', about: 'hive-one', aboutAuto: false } });
  assert.equal(explicit.send(explicit.draw()).newThread.beadId, 'hive-one');
});

function replyFixture(t) {
  const f = fixture(t);
  const thread = { id: 'thr_123456789abc', title: 'Topic', beadId: null, beads: [], count: 0, retained: 0 };
  f.cell.threads = [thread]; f.ui.setAllTopics(f.cell.id, true); f.ui.openThreadFor(f.cell.id, thread.id, thread);
  return { f, key: `${f.cell.id}:${thread.id}` };
}
const checkbox = (out) => descendants(out.composer).find((el) => el.attributes.type === 'checkbox');

test('a reply carries the selected bead by default and shows it', (t) => {
  const { f } = replyFixture(t);
  const out = f.draw();
  assert.notEqual(checkbox(out).attributes.checked, undefined);
  assert.ok(out.composer.textContent.includes('About "One"'));
  assert.equal(f.send(out).beadId, 'hive-one');
});

test('unticking the reply bead clears it for that bead only and sending resets it', (t) => {
  const { f, key } = replyFixture(t);
  let out = f.draw();
  const check = checkbox(out); check.checked = false; check.fire('change'); out = f.draw();
  assert.equal(f.send(out).beadId, null);
  f.ui.selectBead('hive-two'); out = f.draw();
  assert.equal(f.send(out).beadId, 'hive-two');
  f.ui.selectBead('hive-one');
  assert.equal(f.ui.attachFor(key, 'hive-one'), false);
  f.ui.clearDraftIf(key, f.ui.draftRev(key));
  assert.equal(f.ui.attachFor(key, 'hive-one'), true);
  assert.equal(createUi().attachFor(key, 'hive-one'), true);
});

test('with no bead selected a reply is not anchored', (t) => {
  const { f } = replyFixture(t);
  f.ui.selectBead(null);
  assert.equal(f.send(f.draw()).beadId, null);
});

test('the bead selected when sending wins over a stale render, and redraws keep it', (t) => {
  const { f } = replyFixture(t);
  const out = f.draw();
  f.ui.selectBead('hive-two');
  assert.equal(f.send(out).beadId, 'hive-two');
  f.draw(); f.draw();
  assert.equal(f.send(f.draw()).beadId, 'hive-two');
});

test('clicking and focusing the composer keeps the selected bead through a redraw', (t) => {
  const { f } = replyFixture(t);
  let out = f.draw();
  out.composer.fire('click'); out.textarea.focus(); out.textarea.fire('focus'); out.textarea.fire('mousedown');
  out = f.draw();
  assert.equal(f.ui.selectedBeadId(), 'hive-one');
  assert.equal(f.send(out).beadId, 'hive-one');
});

test('a new topic anchors the thread and the message to the selected bead through redraws and composer clicks', (t) => {
  const f = fixture(t);
  let out = f.draw();
  out.composer.fire('click'); out.textarea.focus();
  out = f.draw(); f.draw();
  const sent = f.send(out);
  assert.equal(sent.beadId, 'hive-one');
  assert.equal(sent.newThread.beadId, 'hive-one');
});

test('a new topic made hive-wide sends no bead on the message or the topic', (t) => {
  const f = fixture(t);
  f.ui.setTopicAbout(f.cell.id, '');
  const sent = f.send(f.draw());
  assert.equal(sent.beadId, null);
  assert.equal(sent.newThread.beadId, null);
});

const thr = 'thr_123456789abc';
const READ = { kind: 'read' };
const queen = (id, at, state = null, rev = state ? 1 : 0) => ({ id, author: 'session', text: id, at, threadId: thr, n: at, ack: { required: true, state, rev } });
function topicFixture(t, waiting, saved = { 'read:cell_test': { baseline: 0, threads: {} } }) {
  const f = fixture(t, saved);
  const m = (id, at) => queen(id, at, waiting.includes(id) ? null : READ);
  f.cell.threads = [{ id: thr, title: 'Topic', beadId: null, beads: [], count: 4, retained: 4, lastAt: 40, windowFrom: 'm1' }];
  f.cell.messages = [m('m1', 10), { id: 'h1', author: 'human', text: 'mine', at: 20, threadId: thr, n: 20 }, m('m2', 30), m('m3', 40)];
  f.ui.setAllTopics(f.cell.id, true);
  f.draw().list.querySelector('.hive-topic-btn').fire('click');
  return f;
}

test('a topic opens at its earliest message awaiting acknowledgement, held here or named by the server', () => {
  const ackOf = (m) => m.ack;
  const msgs = [queen('m1', 10, READ), { id: 'h1', author: 'human', at: 20, n: 20 }, queen('m2', 30), queen('m3', 40)];
  assert.equal(earliestWaiting({}, msgs, ackOf)?.id, 'm2');
  assert.equal(earliestWaiting({ waitingFrom: { id: 'm0', n: 5, rev: 0 } }, msgs, ackOf)?.id, 'm0');
  assert.deepEqual(earliestWaiting({ waitingFrom: { id: 'm2', n: 30, rev: 0 } }, msgs, (m) => (m.id === 'm2' ? { required: true, state: READ, rev: 1 } : m.ack)), { after: 30 });
  assert.deepEqual(earliestWaiting({ waitingFrom: { id: 'm0', n: 5, rev: 0 } }, msgs, (m) => (m.id === 'm0' ? { required: true, state: READ, rev: 1 } : m.ack)), { after: 5 });
  assert.equal(earliestWaiting({ waitingFrom: { id: 'm9', n: 35, rev: 0 } }, msgs, (m) => (m.id === 'm9' ? { required: true, state: READ, rev: 1 } : m.ack))?.id, 'm2');
  assert.equal(earliestWaiting({}, [queen('m1', 10, READ)], ackOf), null);
});

test('opening a topic from the list marks the list to start at the earliest waiting message, or the newest when nothing waits', (t) => {
  assert.equal(topicFixture(t, ['m2', 'm3']).draw().list.dataset.startAt, 'm2');
  assert.equal(topicFixture(t, []).draw().list.dataset.startAt, '');
  const f = topicFixture(t, ['m2']);
  f.ui.followMessages(`${f.cell.id}:${thr}`);
  assert.equal('startAt' in f.draw().list.dataset, false);
});

for (const inbox of [false, true]) test(`opening from ${inbox ? 'Inbox' : 'Topics'} sets the unread target before navigation renders`, t => {
  const f = topicFixture(t, ['m2', 'm3']);
  laidOut(t, f.draw());
  f.ui.closeThread(f.cell.id);
  if (inbox) {
    f.cell.inbox = { human: { count: 2, ids: ['m2', 'm3'], rev: 1 }, queen: { count: 0, ids: [], rev: 1 } };
    f.ui.setInboxView(f.cell.id, 'human');
  }
  const open = f.ui.openThreadFor;
  let navigated;
  f.ui.openThreadFor = (...args) => { open.apply(f.ui, args); navigated = f.draw(); };
  f.draw().list.querySelector('.hive-topic-btn').fire('click');
  assert.equal(navigated.list.dataset.startAt, 'm2');
});

test('a topic-only deep link opens at its first waiting message', t => {
  const f = topicFixture(t, ['m2', 'm3']);
  laidOut(t, f.draw());
  f.ui.closeThread(f.cell.id);
  f.ui.openDeepLink({ cellId: f.cell.id, thread: f.cell.threads[0], messages: f.cell.messages, more: false, anchorN: 41 }, f.hive.metaEpoch);
  assert.equal(f.draw().list.dataset.startAt, 'm2');
});

for (const inbox of [false, true]) test(`an unprojected ${inbox ? 'queen Inbox' : 'read'} topic loads history even when synchronous restoration consumes its start`, t => {
  const f = fixture(t);
  const topic = { id: thr, title: 'Older topic', beads: [], count: 4, retained: 4, lastAt: 40 };
  f.ui.setAllTopics(f.cell.id, true);
  if (inbox) {
    f.cell.inbox = { human: { count: 0, ids: [], rev: 1 }, queen: { count: 51, ids: [], rev: 1, more: true } };
    f.ui.setInboxView(f.cell.id, 'queen');
    const message = { id: 'h1', author: 'human', text: 'Waiting for an answer', threadId: thr, n: 40, at: 40, response: { required: true, answers: [] } };
    f.ui.addInboxPage(f.cell.id, 'queen', f.hive.metaEpoch, '1', { ids: ['h1'], messages: [message], threads: [topic], more: false });
  } else f.ui.addOlderTopics(f.cell.id, f.hive.metaEpoch, [topic], false, null);
  const open = f.ui.openThreadFor;
  f.ui.openThreadFor = (...args) => { const token = open.apply(f.ui, args); laidOut(t, f.draw()); return token; };
  f.draw().list.querySelector('.hive-topic-btn').fire('click');
  assert.equal(f.sent.filter(x => x.type === 'hive-thread-history').length, 1);
  f.replies.at(-1).onReply({ ok: true, messages: range(1, 4), more: false, anchorN: 5 });
  assert.equal(f.draw().list.querySelectorAll('.hive-message').length, 4);
});

test('an explicit message link supersedes a pending unread target before late history arrives', t => {
  const f = gapTopic(t);
  const frame = { cellId: f.cell.id, thread: f.cell.threads[0], messages: range(61, 100), more: true, anchorN: 101 };
  f.ui.openDeepLink(frame, f.hive.metaEpoch);
  laidOut(t, f.draw());
  assert.equal(f.ui.startPending(`${f.cell.id}:${thr}`), true);
  const history = f.ask();
  f.ui.openDeepLink({ ...frame, messageId: 'q80' }, f.hive.metaEpoch);
  f.ui.linkedMessage(f.cell.id, thr).pending = false;
  history.onReply({ ok: true, messages: range(1, 60), more: false, anchorN: 61 });
  assert.equal('startAt' in f.draw().list.dataset, false);
});

for (const navigation of ['pane', 'bead', 'topic', 'inbox', 'cell']) test(`user ${navigation} navigation cancels pending unread positioning`, t => {
  const f = gapTopic(t);
  f.open();
  assert.equal(f.ui.startPending(`${f.cell.id}:${thr}`), true);
  if (navigation === 'pane') f.ui.setPane('details');
  if (navigation === 'bead') f.ui.selectBead('hive-two');
  if (navigation === 'topic') f.ui.closeThread(f.cell.id);
  if (navigation === 'inbox') f.ui.setInboxView(f.cell.id, 'human');
  if (navigation === 'cell') f.ui.closeCell();
  assert.equal(f.ui.startPending(`${f.cell.id}:${thr}`), false);
});

test('R5: a message undone elsewhere is where the topic opens, whatever this browser has viewed', (t) => {
  const f = topicFixture(t, [], { 'read:cell_test': { baseline: 0, threads: { [thr]: 40 } } });
  f.ui.closeThread(f.cell.id);
  f.cell.messages[0] = { ...f.cell.messages[0], ack: { required: true, state: null, rev: 2 } };
  f.draw().list.querySelector('.hive-topic-btn').fire('click');
  assert.equal(f.draw().list.dataset.startAt, 'm1');
});

test('R5: a browser that has viewed nothing opens a topic at the first waiting message, not the oldest unviewed one', (t) => {
  const f = topicFixture(t, ['m3'], {});
  assert.equal(f.draw().list.dataset.startAt, 'm3');
});

test('R5: undo here lowers where the topic next opens', (t) => {
  const f = topicFixture(t, ['m3']);
  f.ui.closeThread(f.cell.id);
  f.ui.noteAck(f.cell.id, 'm1', { required: true, state: null, rev: 2 });
  f.draw().list.querySelector('.hive-topic-btn').fire('click');
  assert.equal(f.draw().list.dataset.startAt, 'm1');
});

function inboxFixture(t) {
  const f = fixture(t);
  f.cell.threads = [{ id: thr, title: 'Topic', beadId: null, beads: [], count: 2, retained: 2, lastAt: 20, windowFrom: 'm1' }];
  f.cell.messages = [queen('m1', 10), queen('m2', 20)];
  f.cell.inbox = { human: { count: 2, ids: ['m1', 'm2'], rev: 1 }, queen: { count: 0, ids: [], rev: 1 } };
  f.ui.setAllTopics(f.cell.id, true);
  f.ui.setInboxView(f.cell.id, 'human');
  f.shown = () => descendants(f.draw().list).filter((el) => el.dataset.id).map((el) => el.dataset.id);
  return f;
}

function busyInbox(t) {
  const f = fixture(t);
  const other = 'thr_other0000000';
  const mine = (id, at, threadId = thr) => ({ id, author: 'human', text: id, at, threadId, n: at, response: { required: true, answers: [] } });
  f.cell.threads = [
    { id: thr, title: 'Topic', beadId: null, beads: [], count: 6, retained: 6, lastAt: 60, windowFrom: 'm1', waitingFrom: { id: 'm1', n: 10, rev: 0 } },
    { id: other, title: 'Other', beadId: null, beads: [], count: 1, retained: 1, lastAt: 70, windowFrom: 'm4', waitingFrom: { id: 'm4', n: 70, rev: 0 } },
  ];
  f.cell.messages = [queen('m1', 10), mine('h1', 20), queen('m2', 30), mine('h2', 40), queen('m3', 50), { ...queen('m4', 70), threadId: other }];
  f.cell.inbox = { human: { count: 4, ids: ['m1', 'm2', 'm3', 'm4'], rev: 1 }, queen: { count: 2, ids: ['h1', 'h2'], rev: 1 } };
  f.ui.setAllTopics(f.cell.id, true);
  f.rows = (kind) => {
    f.ui.setInboxView(f.cell.id, kind);
    return f.draw().list.children.filter((li) => li.dataset?.id).map((li) => ({ id: li.dataset.id, title: li.querySelector('.hive-topic-title').textContent, waiting: li.querySelector('.hive-unread').textContent }));
  };
  return f;
}

test('the Inbox lists a topic with several waiting messages once, with how many wait and the newest of them', (t) => {
  const f = busyInbox(t);
  assert.deepEqual(f.rows('human'), [{ id: 'm3', title: 'Topic', waiting: '3' }, { id: 'm4', title: 'Other', waiting: '1' }]);
  assert.deepEqual(f.rows('queen'), [{ id: 'h2', title: 'Topic', waiting: '2' }]);
});

function sameTopic(t, msgs, awaiting = null) {
  const f = fixture(t);
  f.cell.threads = [{ id: thr, title: 'Topic', beadId: null, beads: [], count: msgs.length, retained: msgs.length, lastAt: 100, windowFrom: msgs[0].id, waitingFrom: null, ...(awaiting ? { awaiting } : {}) }];
  f.cell.messages = msgs;
  f.ui.setAllTopics(f.cell.id, true);
  f.ui.setInboxView(f.cell.id, 'human');
  f.row = () => f.draw().list.children.find((li) => li.dataset?.id);
  return f;
}
const at = (id, n, when) => ({ ...queen(id, when), n });

test('V1: a topic\'s row is its newest message by topic order, whatever the timestamps or ids say', (t) => {
  for (const [first, second] of [[100, 100], [200, 100]]) {
    const f = sameTopic(t, [at('msg_ffffffffffff', 1, first), at('msg_000000000000', 2, second)]);
    f.cell.inbox = { human: { count: 2, ids: ['msg_ffffffffffff', 'msg_000000000000'], rev: 1 }, queen: { count: 0, ids: [], rev: 1 } };
    assert.equal(f.row().dataset.id, 'msg_000000000000');
    assert.equal(f.row().querySelector('.hive-unread').textContent, '2');
  }
});

test('V2: a topic\'s row counts and shows the whole topic as the server does, not only the messages loaded', (t) => {
  const waiting = Array.from({ length: 100 }, (_, i) => queen(`q${i + 1}`, i + 1));
  const f = sameTopic(t, waiting, { human: { count: 100, newest: { id: 'q100', n: 100 } }, queen: null });
  f.cell.inbox = { human: { count: 100, ids: waiting.slice(0, 50).map((m) => m.id), rev: 1, more: true, after: { id: 'q50', at: 50 } }, queen: { count: 0, ids: [], rev: 1 } };
  assert.equal(f.row().dataset.id, 'q100');
  assert.equal(f.row().querySelector('.hive-unread').textContent, '100');
  assert.match(f.row().textContent, /q100/);
  f.ui.noteAck(f.cell.id, 'q10', { required: true, state: READ, rev: 1 });
  assert.equal(f.row().querySelector('.hive-unread').textContent, '99');
});


test('opening a topic\'s Inbox row starts at its earliest waiting message', (t) => {
  const f = busyInbox(t);
  f.ui.setInboxView(f.cell.id, 'human');
  f.draw().list.children.find((li) => li.dataset?.id === 'm3').querySelector('.hive-topic-btn').fire('click');
  assert.equal(f.draw().list.dataset.startAt, 'm1');
});

test('reacting to a message advances the topic read mark to it and shows the earlier ones read', (t) => {
  const f = topicFixture(t, ['m1', 'm2', 'm3']);
  const react = descendants(f.draw().list).find((el) => el.tagName === 'button' && el.attributes['data-focus-key'] === 'ack:m2:approve');
  react.fire('click');
  assert.deepEqual(f.sent.at(-1), { type: 'hive-ack', cellId: f.cell.id, messageId: 'm2', rev: 0, kind: 'reaction', reaction: 'approve' });
  f.replies.at(-1).onReply({ ok: true, ack: { required: true, state: { kind: 'reaction', reaction: 'approve' }, rev: 1 }, marked: [{ messageId: 'm1', ack: { required: true, state: { kind: 'read' }, rev: 1 } }] });
  assert.equal(f.ui.readMarks(f.cell.id).threads[thr], 30);
  assert.equal(f.ui.ackOf(f.cell.id, f.cell.messages[0]).state.kind, 'read');
  assert.equal(f.ui.ackOf(f.cell.id, f.cell.messages[3]).state, null);
});

const q = (n) => ({ id: `q${n}`, author: 'session', text: `q${n}`, at: n, threadId: thr, n, ack: { required: true, state: n <= 50 ? READ : null, rev: n <= 50 ? 1 : 0 } });
const WAITING_51 = { id: 'q51', n: 51, rev: 0 };
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => q(a + i));

test('a topic with waiting messages in a gap before its window loads that gap before choosing where to start', (t) => {
  const f = fixture(t, { 'read:cell_test': { baseline: 0, threads: { [thr]: 50 } } });
  f.cell.threads = [{ id: thr, title: 'Topic', beadId: null, beads: [], count: 100, retained: 100, lastAt: 100, windowFrom: 'q61', waitingFrom: WAITING_51 }];
  f.cell.messages = [...range(1, 50), ...range(61, 100)];
  f.ui.setAllTopics(f.cell.id, true);
  f.draw().list.querySelector('.hive-topic-btn').fire('click');
  assert.equal('startAt' in f.draw().list.dataset, false);
  const asks = f.sent.filter((x) => x.type === 'hive-thread-history');
  assert.equal(asks.length, 1);
  assert.equal(asks[0].before, 'q61');
  f.draw();
  assert.equal(f.sent.filter((x) => x.type === 'hive-thread-history').length, 1);
  f.replies[f.sent.indexOf(asks[0])].onReply({ ok: true, threadId: thr, messages: range(1, 60), more: false, anchorN: 61 });
  assert.equal(f.draw().list.dataset.startAt, 'q51');
});

test('R8: when the server still names a message settled here, the gap after it loads and the topic opens at the next waiting one', (t) => {
  const f = fixture(t, { 'read:cell_test': { baseline: 0, threads: { [thr]: 50 } } });
  f.cell.threads = [{ id: thr, title: 'Topic', beadId: null, beads: [], count: 100, retained: 100, lastAt: 100, windowFrom: 'q61', waitingFrom: { id: 'q1', n: 1, rev: 0 } }];
  const stale = (m) => ({ ...m, ack: { required: true, state: null, rev: 0 } });
  f.cell.messages = [...range(1, 50).map(stale), ...range(61, 100)];
  for (let n = 1; n <= 50; n++) f.ui.noteAck(f.cell.id, `q${n}`, { required: true, state: READ, rev: 1 });
  f.ui.setAllTopics(f.cell.id, true);
  f.draw().list.querySelector('.hive-topic-btn').fire('click');
  assert.equal('startAt' in f.draw().list.dataset, false);
  const asks = f.sent.filter((x) => x.type === 'hive-thread-history');
  assert.equal(asks.length, 1);
  assert.equal(asks[0].before, 'q61');
  f.replies[f.sent.indexOf(asks[0])].onReply({ ok: true, threadId: thr, messages: range(1, 60), more: false, anchorN: 61 });
  assert.equal(f.draw().list.dataset.startAt, 'q51');
});

function staleHistory(t, waitingFrom, before = () => {}) {
  const f = fixture(t);
  before(f);
  f.cell.threads = [{ id: thr, title: 'Topic', beadId: null, beads: [], count: 100, retained: 100, lastAt: 100, windowFrom: 'q61', waitingFrom }];
  f.cell.messages = range(61, 100);
  f.ui.addHistory(f.cell.id, thr, 'test', { messages: range(1, 60), more: false, anchorN: 61 }, null);
  f.ui.setAllTopics(f.cell.id, true);
  f.draw().list.querySelector('.hive-topic-btn').fire('click');
  return f;
}

test('R10: a newer server waitingFrom beats an older settled copy held here, where the topic opens and in its controls', (t) => {
  const f = staleHistory(t, { id: 'q1', n: 1, rev: 2 });
  const out = f.draw();
  assert.equal(out.list.dataset.startAt, 'q1');
  assert.ok(descendants(out.list).some((el) => el.attributes['data-focus-key'] === 'ack:q1:seen'));
});

test('R10: a settlement confirmed here beats an older server waitingFrom', (t) => {
  const f = staleHistory(t, { id: 'q1', n: 1, rev: 2 }, (g) => g.ui.noteAck(g.cell.id, 'q1', { required: true, state: READ, rev: 3 }));
  const out = f.draw();
  assert.equal(out.list.dataset.startAt, 'q51');
  assert.equal(descendants(out.list).find((el) => el.attributes['data-focus-key'] === 'ack:q1:seen').attributes['aria-pressed'], 'true');
});

// Lays a drawn topic list out as 100px rows in a 250px scrolling box and
// runs the client's scroll restoration and visibility tracking over it.
function laidOut(t, out) {
  const css = globalThis.CSS;
  globalThis.CSS = { escape: (x) => x };
  globalThis.document.visibilityState = 'visible';
  t.after(() => { globalThis.CSS = css; });
  const list = out.list;
  let top = 0;
  Object.assign(list.dataset, { scrollKey: out.scrollKey, scrollFollow: '' });
  Object.assign(list, { isConnected: true, clientWidth: 300, clientHeight: 250, scrollHeight: list.children.length * 100, getBoundingClientRect: () => ({ top: 0, bottom: 250 }) });
  Object.defineProperty(list, 'scrollTop', { configurable: true, get: () => top, set: (n) => { top = Math.max(0, Math.min(n, list.scrollHeight - list.clientHeight)); } });
  const nodes = new Map();
  list.children.forEach((item, i) => {
    if (!(item instanceof Element)) return;
    item.getBoundingClientRect = () => ({ top: i * 100 - top, bottom: (i + 1) * 100 - top });
    if (item.dataset.id) nodes.set(item.dataset.id, item);
  });
  list.querySelector = (sel) => nodes.get(sel.match(/data-id="([^"]+)"/)?.[1]) || null;
  restoreScroll({ querySelectorAll: () => [list] });
  return { list, top: () => top, atTop: (id) => nodes.get(id)?.getBoundingClientRect().top === 0 };
}

function gapTopic(t) {
  const f = fixture(t, { 'read:cell_test': { baseline: 0, threads: { [thr]: 50 } } });
  f.cell.threads = [{ id: thr, title: 'Topic', beadId: null, beads: [], count: 100, retained: 100, lastAt: 100, windowFrom: 'q61', waitingFrom: WAITING_51 }];
  f.cell.messages = [...range(1, 50), ...range(61, 100)];
  f.ui.setAllTopics(f.cell.id, true);
  f.open = () => { f.draw().list.querySelector('.hive-topic-btn').fire('click'); return f.draw(); };
  f.ask = () => f.replies[f.sent.findLastIndex((x) => x.type === 'hive-thread-history')];
  f.mark = () => f.ui.readMarks(f.cell.id).threads[thr];
  return f;
}

test('while the gap before an opened topic loads, the list neither follows the newest message nor reads it', (t) => {
  const f = gapTopic(t);
  const view = laidOut(t, f.open());
  assert.equal(view.top(), 0);
  view.list.hiveShown();
  assert.equal(f.mark(), 50);
  assert.equal(f.ui.startPending(`${f.cell.id}:${thr}`), true);
});

test('once the gap loads, the topic opens at its earliest waiting message without reading the rest', (t) => {
  const f = gapTopic(t);
  laidOut(t, f.open());
  f.ask().onReply({ ok: true, threadId: thr, messages: range(1, 60), more: false, anchorN: 61 });
  const view = laidOut(t, f.draw());
  assert.equal(view.atTop('q51'), true);
  assert.equal(f.mark(), 50);
  assert.equal(f.ui.startPending(`${f.cell.id}:${thr}`), false);
  view.list.scrollTop = view.list.scrollHeight;
  view.list.hiveShown();
  assert.equal(f.mark(), 50);
});

test('when the gap cannot load, the topic opens at the top of its newest run with earlier messages still offered and nothing read', (t) => {
  const f = gapTopic(t);
  laidOut(t, f.open());
  f.ask().onReply({ ok: false, error: 'offline' });
  const out = f.draw();
  assert.equal(out.list.dataset.startAt, 'q61');
  assert.ok(out.list.querySelectorAll('button').some((b) => b.textContent === 'Load earlier'));
  const view = laidOut(t, out);
  assert.equal(view.atTop('q61'), true);
  assert.equal(f.mark(), 50);
  assert.equal(f.sent.filter((x) => x.type === 'hive-thread-history').length, 1);
});

test('leaving a topic before its gap loads and opening it again still starts at the earliest waiting message', (t) => {
  const f = gapTopic(t);
  laidOut(t, f.open());
  f.ui.closeThread(f.cell.id);
  laidOut(t, f.open());
  assert.equal(f.mark(), 50);
  assert.equal(f.ui.startPending(`${f.cell.id}:${thr}`), true);
  f.ask().onReply({ ok: true, threadId: thr, messages: range(1, 60), more: false, anchorN: 61 });
  assert.equal(laidOut(t, f.draw()).atTop('q51'), true);
});

test('a failure from an earlier opening of a topic does not change where a later opening starts', (t) => {
  const f = gapTopic(t);
  laidOut(t, f.open());
  const first = f.ask();
  f.ui.closeThread(f.cell.id);
  laidOut(t, f.open());
  const second = f.ask();
  assert.notEqual(first, second);
  first.onReply({ ok: false, error: 'offline' });
  assert.equal('startAt' in f.draw().list.dataset, false);
  second.onReply({ ok: true, threadId: thr, messages: range(1, 60), more: false, anchorN: 61 });
  assert.equal(laidOut(t, f.draw()).atTop('q51'), true);
  assert.equal(f.mark(), 50);
});

test('a later opening whose own request fails still falls back after an earlier opening\'s request succeeds', (t) => {
  const f = gapTopic(t);
  laidOut(t, f.open());
  const first = f.ask();
  f.ui.closeThread(f.cell.id);
  laidOut(t, f.open());
  const second = f.ask();
  first.onReply({ ok: true, threadId: thr, messages: range(55, 60), more: true, anchorN: 61 });
  second.onReply({ ok: false, error: 'offline' });
  const out = f.draw();
  assert.equal(out.list.dataset.startAt, 'q55');
  assert.equal(laidOut(t, out).atTop('q55'), true);
  assert.equal(f.ui.startPending(`${f.cell.id}:${thr}`), false);
  assert.equal(f.mark(), 50);
});

test('the start is found in the newest unbroken run, loading back page by page', () => {
  const waiting = q(51);
  assert.deepEqual(startTarget({ window: [], page: null, from: null, retained: 100, waiting }), { before: null });
  assert.equal(startTarget({ window: [], page: { messages: range(61, 100), more: true, anchorN: 101 }, from: null, retained: 100, waiting }).before.id, 'q61');
  assert.deepEqual(startTarget({ window: [], page: { messages: range(1, 100), more: false, anchorN: 101 }, from: null, retained: 100, waiting }), { id: 'q51' });
  assert.deepEqual(startTarget({ window: range(45, 100), page: null, from: q(45), retained: 100, waiting }), { id: 'q51' });
  assert.deepEqual(startTarget({ window: range(61, 100), page: { messages: range(10, 20), more: true, anchorN: 21 }, from: q(61), retained: 100, waiting }).before.id, 'q61');
  assert.deepEqual(startTarget({ window: range(55, 100), page: null, from: q(55), retained: 46, waiting }), { id: 'q55' });
  assert.deepEqual(startTarget({ window: range(1, 100), page: null, from: q(1), retained: 100, waiting: null }), { id: '' });
  assert.deepEqual(startTarget({ window: [], page: null, from: null, retained: 0, waiting }), { id: '' });
});

test('R8: a start only known to come after a settled message is the first waiting one after it in an unbroken run', () => {
  const waiting = { after: 1 };
  const waits = (m) => !m.ack.state;
  assert.equal(startTarget({ window: range(61, 100), page: null, from: q(61), retained: 100, waiting, waits }).before.id, 'q61');
  assert.deepEqual(startTarget({ window: range(61, 100), page: { messages: range(1, 60), more: false, anchorN: 61 }, from: q(61), retained: 100, waiting, waits }), { id: 'q51' });
  assert.deepEqual(startTarget({ window: range(1, 50), page: null, from: q(1), retained: 50, waiting, waits }), { id: '' });
});

test('topics and messages omit copy controls while resolving a link opens history without acknowledging', (t) => {
  const f = fixture(t);
  const thread = { id: 'thr_target', title: 'An older topic', beadId: 'hive-two', beads: ['hive-two'], count: 1, retained: 1 };
  const m = { id: 'msg_target', threadId: thread.id, author: 'session', sessionId: 'queen', text: 'Target', n: 1, at: 100, ack: { required: true, rev: 0, state: null } };
  f.cell.threads = [thread];
  f.ui.setAllTopics(f.cell.id, true);
  const topics = f.draw();
  assert.equal(topics.list.querySelector('a'), null);
  f.ui.setPane('details'); f.ui.setDockOpen(false); f.ui.setInboxView(f.cell.id, 'human');
  const marks = JSON.stringify(f.ui.readMarks(f.cell.id));
  f.ui.openDeepLink({ cellId: f.cell.id, thread, messageId: m.id, messages: [m], more: false, anchorN: 2 }, f.hive.metaEpoch);
  assert.equal(f.ui.cellId(), f.cell.id);
  assert.equal(f.ui.openThread(f.cell.id), thread.id);
  assert.equal(f.ui.pane(), 'conversation');
  assert.equal(f.ui.dockOpen(), true);
  assert.equal(f.ui.inboxView(f.cell.id), null);
  assert.equal(f.ui.historyFor(f.cell.id, thread.id, f.hive.metaEpoch).messages[0].id, m.id);
  const out = f.draw();
  assert.equal(out.list.querySelector('a'), null);
  assert.equal(out.head.querySelector('a'), null);
  assert.ok(out.list.querySelector('.is-link-target'));
  out.list.hiveShown();
  assert.equal(JSON.stringify(f.ui.readMarks(f.cell.id)), marks);
  assert.equal(f.sent.length, 0);
  f.ui.openDeepLink({ cellId: f.cell.id, notice: 'Missing message' }, f.hive.metaEpoch);
  assert.equal(f.ui.openThread(f.cell.id), null);
  assert.equal(f.ui.linkedMessage(f.cell.id, thread.id), null);
  f.ui.openDeepLink({ cellId: null }, f.hive.metaEpoch);
  assert.equal(f.ui.cellId(), null);
});

test('delayed link replies and timeouts preserve navigation made after the lookup started', (t) => {
  const previousWindow = globalThis.window;
  t.after(() => { globalThis.window = previousWindow; });
  const link = '#view=ext:hive:overview&cell=cell_test&topic=thr_old&message=msg_old';
  for (const navigation of ['outside', 'board', 'cell', 'topic', 'close-topic', 'inbox', 'pane']) {
    for (const ok of [true, false]) {
      const f = fixture(t);
      const listeners = [];
      const win = {
        location: { hash: link },
        history: { replaceState(_state, _title, hash) { win.location.hash = hash; } },
        addEventListener(type, fn) { listeners.push({ type, fn }); },
        removeEventListener(type, fn) { const at = listeners.findIndex(x => x.type === type && x.fn === fn); if (at >= 0) listeners.splice(at, 1); },
        navigate(hash) { win.location.hash = hash; for (const x of [...listeners]) if (x.type === 'hashchange') x.fn(); },
      };
      globalThis.window = win;
      const sent = [];
      let reply;
      client.register({ api: { storage: f.storage, send: frame => sent.push(frame) }, register() {}, onMessage(fn) { reply = fn; } });
      resolveLink({ cells: { cell_test: f.cell } });
      assert.equal(sent.length, 1);
      if (navigation === 'outside') {
        win.navigate('#view=search');
        win.navigate('#view=ext:hive:overview');
      } else if (navigation === 'board') win.history.replaceState(null, '', '');
      else if (navigation === 'cell') f.ui.openCell('cell_new');
      else if (navigation === 'topic') f.ui.openThreadFor(f.cell.id, 'thr_new');
      else if (navigation === 'close-topic') f.ui.closeThread(f.cell.id);
      else if (navigation === 'inbox') f.ui.setInboxView(f.cell.id, 'human');
      else f.ui.setPane('details');
      const selection = { cell: f.ui.cellId(), thread: f.ui.openThread(f.cell.id), pane: f.ui.pane(), inbox: f.ui.inboxView(f.cell.id) };
      const hash = win.location.hash;
      reply({ op: 'hive-deep-link', requestId: sent[0].requestId, ok, cellId: f.cell.id, thread: { id: 'thr_old' }, messageId: 'msg_old', messages: [], anchorN: 1 });
      assert.deepEqual({ cell: f.ui.cellId(), thread: f.ui.openThread(f.cell.id), pane: f.ui.pane(), inbox: f.ui.inboxView(f.cell.id) }, selection, `${navigation}, ok=${ok}`);
      assert.equal(win.location.hash, hash);
      assert.equal(f.ui.linkedMessage(f.cell.id, 'thr_old'), null);
      resolveLink({ cells: { cell_test: f.cell } });
      assert.equal(sent.length, 1);
    }
  }
});

test('reload URLs restore the topic, bead and tab without a new message highlight or read write', t => {
  const f = fixture(t);
  const previousWindow = globalThis.window;
  const previousStorage = globalThis.sessionStorage;
  t.after(() => { globalThis.window = previousWindow; globalThis.sessionStorage = previousStorage; });
  const values = new Map();
  globalThis.sessionStorage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) };
  globalThis.window = { location: { hash: '#view=ext:hive:overview' }, history: { replaceState(_state, _title, hash) { window.location.hash = hash; } } };
  const thread = { id: 'thr_restore', title: 'Restore me', count: 1, retained: 1, beads: [] };
  f.cell.threads = [thread];
  f.ui.openCell(f.cell.id);
  f.ui.openThreadFor(f.cell.id, thread.id, thread);
  f.ui.selectBead('hive-two');
  f.ui.setPane('details');
  const target = parseHiveLink(window.location.hash);
  assert.equal(target.threadId, thread.id);
  assert.equal(target.beadId, 'hive-two');
  assert.equal(target.pane, 'details');
  const restored = createUi();
  const marks = JSON.stringify(restored.readMarks(f.cell.id));
  restored.openDeepLink({ ...target, thread, messageId: 'msg_anchor', messages: [], anchorN: 2 }, f.hive.metaEpoch, { restore: true });
  assert.equal(restored.cellId(), f.cell.id);
  assert.equal(restored.openThread(f.cell.id), thread.id);
  assert.equal(restored.selectedBeadId(), 'hive-two');
  assert.equal(restored.pane(), 'details');
  assert.equal(restored.linkedMessage(f.cell.id, thread.id), null);
  assert.equal(JSON.stringify(restored.readMarks(f.cell.id)), marks);
  assert.equal(f.sent.length, 0);
});

test('reload lookup requests the saved older scroll anchor so it can be restored outside the recent window', t => {
  const f = fixture(t);
  const previousWindow = globalThis.window;
  const previousStorage = globalThis.sessionStorage;
  t.after(() => { globalThis.window = previousWindow; globalThis.sessionStorage = previousStorage; });
  const hash = '#view=ext:hive:overview&cell=cell_test&topic=thr_old&message=msg_original';
  const values = new Map([['hive:view:scroll', JSON.stringify({ hash, scroll: [['messages:cell_test:thr_old', { left: 0, top: 400, anchor: { id: 'msg_old', offset: -10 } }]], follow: [['messages:cell_test:thr_old', false]] })]]);
  globalThis.sessionStorage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) };
  globalThis.window = { location: { hash }, history: { replaceState(_state, _title, hash) { window.location.hash = hash; } }, addEventListener() {}, removeEventListener() {} };
  const sent = [];
  let reply;
  client.register({ api: { storage: f.storage, send: frame => sent.push(frame) }, register() {}, onMessage(fn) { reply = fn; } });
  resolveLink({ cells: { cell_test: f.cell } });
  assert.equal(sent[0].messageId, 'msg_old');
  assert.equal(sent[0].restore, true);
  f.ui.openCell('cell_new');
  reply({ op: 'hive-deep-link', requestId: sent[0].requestId, ok: false });
  assert.equal(f.ui.cellId(), 'cell_new');
});

test('the actual delayed reply applies the newest of two queued deep links', t => {
  const f = fixture(t);
  const previousWindow = globalThis.window;
  t.after(() => { globalThis.window = previousWindow; });
  const listeners = [], queue = [];
  const win = {
    location: { hash: '#view=search', replace(hash) { win.queue(hash); } },
    history: { replaceState(_state, _title, hash) { win.location.hash = hash; } },
    addEventListener(type, fn, capture) { listeners.push({ type, fn, capture }); },
    removeEventListener(type, fn) { const at = listeners.findIndex(x => x.type === type && x.fn === fn); if (at >= 0) listeners.splice(at, 1); },
    queue(hash) { const oldURL = `https://board.test/${win.location.hash}`; win.location.hash = hash; for (const x of [...listeners].filter(x => x.type === 'popstate')) x.fn({}); queue.push({ oldURL, newURL: `https://board.test/${hash}`, stopped: false, stopImmediatePropagation() { this.stopped = true; } }); },
    flush() {
      while (queue.length) {
        const event = queue.shift();
        for (const x of [...listeners].filter(x => x.type === 'hashchange')) {
          x.fn(event);
          if (event.stopped) break;
        }
      }
    },
  };
  globalThis.window = win;
  const sent = [];
  let reply, view;
  client.register({ api: { storage: f.storage, send: frame => sent.push(frame) }, register(type, entry) { if (type === 'view') view = entry; }, onMessage(fn) { reply = fn; } });
  const hive = { cells: { cell_new: { ...f.cell, id: 'cell_new' } }, metaEpoch: f.hive.metaEpoch };
  view.update(null, null, { hive });
  win.queue('#view=ext:hive:overview&cell=cell_old&topic=thr_old&message=msg_old');
  const newest = '#view=ext:hive:overview&cell=cell_new&topic=thr_new&message=msg_new';
  win.queue(newest);
  win.flush();
  resolveLink(hive);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].messageId, 'msg_new');
  reply({ op: 'hive-deep-link', requestId: sent[0].requestId, ok: true, cellId: 'cell_new', thread: { id: 'thr_new' }, messageId: 'msg_new', messages: [], anchorN: 1 });
  assert.equal(f.ui.cellId(), 'cell_new');
  assert.equal(win.location.hash, newest);
  assert.equal(f.ui.linkedMessage('cell_new', 'thr_new').messageId, 'msg_new');
});

test('restored visible messages auto-read after positioning settles without user interaction', t => {
  const f = autoReadFixture(t, [{ top: 10, bottom: 80 }]);
  assert.equal(f.sent.length, 0);
  f.settle();
  assert.deepEqual(f.sent.map(x => x.type), ['hive-auto-read']);
  assert.deepEqual(f.sent[0].messages, [{ messageId: 'auto_0', rev: 0 }]);
});

test('a reload restore of a topic waiting on the human reads and settles nothing, and thread acknowledgement still works after it', t => {
  const f = fixture(t);
  const previousCSS = globalThis.CSS;
  t.after(() => { globalThis.CSS = previousCSS; });
  globalThis.CSS = { escape: value => value };
  document.visibilityState = 'visible';
  f.storage.set('read:cell_test', JSON.stringify({ baseline: 0, threads: {} }));
  const thread = { id: thr, title: 'Topic', beadId: null, beads: [], count: 2, retained: 2, lastAt: 20, windowFrom: 'm1', waitingFrom: { id: 'm1', n: 10, rev: 0 } };
  const msgs = [queen('m1', 10), queen('m2', 20)];
  f.cell.threads = [thread]; f.cell.messages = msgs;
  f.cell.inbox = { human: { count: 2, ids: ['m1', 'm2'], rev: 1 }, queen: { count: 0, ids: [], rev: 1 } };
  f.ui.openDeepLink({ cellId: f.cell.id, thread, messages: msgs, anchorN: 21 }, f.hive.metaEpoch, { restore: true });
  const out = f.draw();
  const item = out.list.children.find(el => el.dataset?.id === 'm2');
  Object.assign(out.list, { isConnected: true, clientWidth: 300, scrollHeight: 100, clientHeight: 100, scrollTop: 0, getBoundingClientRect: () => ({ top: 0, bottom: 100 }), querySelector: () => item });
  item.getBoundingClientRect = () => ({ top: 10, bottom: 80 });
  const before = JSON.stringify(f.ui.readMarks(f.cell.id));
  out.list.hiveShown();
  out.list.fire('scroll');
  assert.equal(JSON.stringify(f.ui.readMarks(f.cell.id)), before);
  assert.equal(f.sent.length, 0);
  assert.equal(f.ui.ackOf(f.cell.id, msgs[0]).state, null);
  f.ui.closeThread(f.cell.id);
  f.ui.setInboxView(f.cell.id, 'human');
  const shown = () => descendants(f.draw().list).filter((el) => el.dataset.id).map((el) => el.dataset.id);
  assert.deepEqual(shown(), ['m2']);
  f.draw().list.querySelector('.hive-topic-btn').fire('click');
  descendants(f.draw().list).find((el) => el.attributes['data-focus-key'] === 'ack:m2:approve').fire('click');
  f.replies.at(-1).onReply({ ok: true, ack: { required: true, state: { kind: 'reaction', reaction: 'approve' }, rev: 1 }, marked: [{ messageId: 'm1', ack: { required: true, state: READ, rev: 1 } }], inboxRev: 2 });
  descendants(f.draw().list).find((el) => el.attributes['data-focus-key'] === 'ack:m2:approve').fire('click');
  assert.deepEqual(f.sent.at(-1), { type: 'hive-ack-undo', cellId: f.cell.id, messageId: 'm2', rev: 1 });
  f.replies.at(-1).onReply({ ok: true, ack: { required: true, state: null, rev: 2 }, inboxRev: 3 });
  f.ui.closeThread(f.cell.id);
  assert.deepEqual(shown(), ['m2']);
  assert.equal(f.ui.inboxView(f.cell.id), 'human');
});

test('a fresh message click after loading plain Hive honors its target instead of saved scroll', t => {
  const f = fixture(t);
  const previousWindow = globalThis.window;
  const previousStorage = globalThis.sessionStorage;
  t.after(() => { globalThis.window = previousWindow; globalThis.sessionStorage = previousStorage; });
  const hash = '#view=ext:hive:overview';
  const values = new Map([['hive:view:scroll', JSON.stringify({ hash, scroll: [['messages:cell_test:thr_old', { left: 0, top: 400, anchor: { id: 'msg_saved', offset: -10 } }]], follow: [['messages:cell_test:thr_old', false]] })]]);
  globalThis.sessionStorage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) };
  const listeners = [];
  const win = {
    location: { hash }, history: { replaceState(_state, _title, hash) { win.location.hash = hash; } },
    addEventListener(type, fn) { if (type === 'hashchange') listeners.push(fn); },
    removeEventListener(type, fn) { const at = listeners.indexOf(fn); if (at >= 0) listeners.splice(at, 1); },
  };
  globalThis.window = win;
  const sent = [];
  let reply;
  client.register({ api: { storage: f.storage, send: frame => sent.push(frame) }, register() {}, onMessage(fn) { reply = fn; } });
  win.location.hash = '#view=ext:hive:overview&cell=cell_test&topic=thr_old&message=msg_original';
  for (const fn of listeners) fn();
  resolveLink({ cells: { cell_test: f.cell } });
  f.ui.openCell('cell_new');
  reply({ op: 'hive-deep-link', requestId: sent[0].requestId, ok: false });
  assert.equal(sent[0].messageId, 'msg_original');
  assert.equal(sent[0].restore, false);
});

function autoReadFixture(t, rectangles = [{ top: 10, bottom: 80 }]) {
  const f = fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const before = { CSS: globalThis.CSS, getComputedStyle: globalThis.getComputedStyle, requestAnimationFrame: globalThis.requestAnimationFrame };
  t.after(() => Object.assign(globalThis, before));
  globalThis.CSS = { escape: value => value };
  globalThis.getComputedStyle = () => ({ overflowY: 'visible' });
  const frames = [];
  globalThis.requestAnimationFrame = callback => frames.push(callback);
  document.visibilityState = 'visible';
  document.hasFocus = () => true;
  const thread = { id: 'thr_auto', title: 'Auto-read', count: rectangles.length, retained: rectangles.length, beads: [] };
  f.cell.threads = [thread];
  f.cell.messages = rectangles.map((r, i) => ({ ...queen(`auto_${i}`, i + 1), threadId: thread.id }));
  f.ui.followMessages(`${f.cell.id}:${thread.id}`);
  f.ui.openDeepLink({ cellId: f.cell.id, thread, messages: f.cell.messages, anchorN: rectangles.length + 1 }, f.hive.metaEpoch, { restore: true });
  let out;
  const draw = () => {
    if (out) out.list.isConnected = false;
    out = f.draw();
    const list = out.list;
    Object.assign(list.dataset, { scrollKey: out.scrollKey, scrollFollow: '' });
    Object.assign(list, { isConnected: true, clientWidth: 300, clientHeight: 100, scrollHeight: 1000, scrollTop: 0, getBoundingClientRect: () => ({ top: 0, bottom: 100 }) });
    const nodes = new Map();
    list.children.filter(e => e.dataset?.id).forEach((item, i) => {
      item.getBoundingClientRect = () => ({ width: 300, ...rectangles[i] });
      nodes.set(item.dataset.id, item);
    });
    const query = list.querySelector.bind(list);
    list.querySelector = selector => selector.includes('data-id=') ? nodes.get(selector.match(/data-id="([^"]+)"/)?.[1]) || null : query(selector);
    restoreScroll({ querySelectorAll: () => [list] });
    return out;
  };
  const paint = () => { for (let i = 0; i < 4; i++) for (const frame of frames.splice(0)) frame(); };
  const settle = () => { paint(); t.mock.timers.tick(150); };
  const sample = () => { out.list.hiveShown(); settle(); };
  draw();
  return { ...f, thread, rectangles, paint, draw: () => draw(), current: () => out, settle, sample };
}

test('auto-read combines both edges seen at different times for a tall message', t => {
  const f = autoReadFixture(t, [{ top: 10, bottom: 350 }]);
  f.settle();
  assert.equal(f.sent.length, 0);
  f.rectangles[0] = { top: -250, bottom: 90 };
  f.sample();
  assert.deepEqual(f.sent[0]?.messages, [{ messageId: 'auto_0', rev: 0 }]);
});

test('fractional scroll rounding at the viewport edge does not lose a tall message top', t => {
  const f = autoReadFixture(t, [{ top: -0.1, bottom: 350 }]);
  f.settle();
  f.rectangles[0] = { top: -250, bottom: 90 };
  f.sample();
  assert.deepEqual(f.sent[0]?.messages, [{ messageId: 'auto_0', rev: 0 }]);
});

test('a deep-linked later message cannot auto-read earlier unseen messages or a bottom without its top', t => {
  const f = autoReadFixture(t, [{ top: -500, bottom: -300 }, { top: -100, bottom: 80 }]);
  f.settle();
  assert.equal(f.sent.length, 0);
  f.rectangles[1] = { top: 10, bottom: 190 };
  f.sample();
  assert.deepEqual(f.sent[0]?.messages, [{ messageId: 'auto_1', rev: 0 }]);
});

test('auto-read coalesces scroll samples and visible messages into one request', t => {
  const f = autoReadFixture(t, [{ top: 5, bottom: 35 }, { top: 45, bottom: 85 }]);
  for (let i = 0; i < 20; i++) f.current().list.fire('scroll');
  f.settle();
  assert.equal(f.sent.length, 1);
  assert.deepEqual(f.sent[0].messages, [{ messageId: 'auto_0', rev: 0 }, { messageId: 'auto_1', rev: 0 }]);
  f.sample();
  assert.equal(f.sent.length, 1);
});

for (const guard of ['hidden document', 'unfocused document', 'hidden panel', 'disconnected panel', 'pending reveal', 'pending first unread']) test(`auto-read waits for ${guard}`, t => {
  const f = autoReadFixture(t);
  if (guard === 'hidden document') document.visibilityState = 'hidden';
  if (guard === 'unfocused document') document.hasFocus = () => false;
  if (guard === 'hidden panel') f.current().list.clientWidth = 0;
  if (guard === 'disconnected panel') f.current().list.isConnected = false;
  if (guard === 'pending reveal') f.ui.linkedMessage = () => ({ pending: true });
  if (guard === 'pending first unread') f.ui.openAtWaiting(`${f.cell.id}:${f.thread.id}`);
  f.settle();
  assert.equal(f.sent.length, 0);
});

test('a batch is discarded if focus is lost before it saves', t => {
  const f = autoReadFixture(t);
  f.paint();
  document.hasFocus = () => false;
  t.mock.timers.runAll();
  assert.equal(f.sent.length, 0);
  document.hasFocus = () => true;
  f.sample();
  assert.equal(f.sent.length, 1);
});

test('Undo stays unread through scrolling until the topic is reopened', t => {
  const f = autoReadFixture(t);
  f.settle();
  assert.equal(f.sent.length, 1);
  f.replies[0].onReply({ ok: true, acks: [{ messageId: 'auto_0', ack: { required: true, state: READ, rev: 1 } }] });
  f.ui.noteAck(f.cell.id, 'auto_0', { required: true, state: null, rev: 2 });
  f.draw(); f.settle();
  assert.equal(f.sent.length, 1);
  assert.equal(f.ui.ackOf(f.cell.id, f.cell.messages[0]).state, null);
  f.rectangles[0] = { top: -100, bottom: -10 }; f.sample();
  f.rectangles[0] = { top: 10, bottom: 80 }; f.sample();
  assert.equal(f.sent.length, 1);
  f.ui.closeThread(f.cell.id);
  f.ui.openThreadFor(f.cell.id, f.thread.id, f.thread);
  f.draw(); f.settle();
  assert.equal(f.sent.length, 2);
  assert.deepEqual(f.sent[1].messages, [{ messageId: 'auto_0', rev: 2 }]);
});

test('Read toggles unread without auto-reading again after a conversation refresh', t => {
  const f = autoReadFixture(t);
  f.settle();
  f.replies[0].onReply({ ok: true, acks: [{ messageId: 'auto_0', ack: { required: true, state: READ, rev: 1 } }] });
  const out = f.draw();
  const read = out.list.querySelectorAll('button').find(b => b.attributes['aria-label'] === 'Read');
  read.fire('click');
  assert.deepEqual(f.sent[1], { type: 'hive-ack-undo', cellId: f.cell.id, messageId: 'auto_0', rev: 1 });
  f.replies[1].onReply({ ok: true, ack: { required: true, state: null, rev: 2 } });
  f.cell.conversationRevision = 'new-request-revision';
  f.draw(); f.settle();
  assert.equal(f.sent.length, 2);
  assert.equal(f.ui.ackOf(f.cell.id, f.cell.messages[0]).state, null);
  f.ui.openDeepLink({ cellId: f.cell.id, thread: f.thread, messages: f.cell.messages, anchorN: 2, conversationRevision: f.cell.conversationRevision }, f.hive.metaEpoch);
  f.draw(); f.settle();
  assert.deepEqual(f.sent[2]?.messages, [{ messageId: 'auto_0', rev: 2 }]);
});

test('selecting an unread message again makes it eligible for auto-read', t => {
  const f = autoReadFixture(t);
  f.settle();
  f.replies[0].onReply({ ok: true, acks: [{ messageId: 'auto_0', ack: { required: true, state: READ, rev: 1 } }] });
  f.ui.selectConversationMessage(f.cell.id, f.thread.id, 'auto_0');
  f.ui.noteAck(f.cell.id, 'auto_0', { required: true, state: null, rev: 2 });
  f.draw(); f.settle();
  assert.equal(f.sent.length, 1);
  f.current().list.children.find(el => el.dataset?.id === 'auto_0').fire('click');
  f.sample();
  assert.deepEqual(f.sent[1]?.messages, [{ messageId: 'auto_0', rev: 2 }]);
});

test('tabbing through reaction controls preserves unread until the message itself receives focus', t => {
  const f = autoReadFixture(t);
  f.settle();
  f.replies[0].onReply({ ok: true, acks: [{ messageId: 'auto_0', ack: { required: true, state: READ, rev: 1 } }] });
  f.draw().list.querySelectorAll('button').find(b => b.attributes['aria-label'] === 'Read').fire('click');
  f.replies[1].onReply({ ok: true, ack: { required: true, state: null, rev: 2 } });
  const out = f.draw();
  const item = out.list.children.find(el => el.dataset?.id === 'auto_0');
  for (const label of ['Read', 'Yes', 'No']) {
    item.querySelectorAll('button').find(b => b.attributes['aria-label'] === label).fire('focusin');
    f.sample();
    assert.equal(f.sent.length, 2, label);
    assert.equal(f.ui.ackOf(f.cell.id, f.cell.messages[0]).state, null);
  }
  item.fire('focusin');
  f.sample();
  assert.deepEqual(f.sent[2]?.messages, [{ messageId: 'auto_0', rev: 2 }]);
});

test('observed edges survive a graph redraw while the batch is pending', t => {
  const f = autoReadFixture(t, [{ top: 10, bottom: 300 }]);
  f.settle();
  f.draw(); f.settle();
  f.rectangles[0] = { top: -200, bottom: 90 }; f.sample();
  assert.equal(f.sent.length, 1);
});

test('messages without acknowledgement controls also wait for both focused edges', t => {
  const f = autoReadFixture(t, [{ top: 10, bottom: 300 }]);
  f.cell.messages[0].ack = null;
  f.storage.set('read:cell_test', JSON.stringify({ baseline: 0, threads: {} }));
  f.draw(); f.settle();
  assert.equal(f.ui.readMarks(f.cell.id).threads[f.thread.id], undefined);
  f.rectangles[0] = { top: -200, bottom: 90 }; f.sample();
  assert.equal(f.ui.readMarks(f.cell.id).messages?.auto_0, 1);
  assert.equal(f.sent.length, 0);
});

test('legacy local read marks cannot advance unfocused or when only a bottom was seen', t => {
  const f = autoReadFixture(t, [{ top: -100, bottom: 80 }]);
  f.cell.messages[0].ack = null;
  f.storage.set('read:cell_test', JSON.stringify({ baseline: 0, threads: {} }));
  f.draw();
  f.current().list.scrollHeight = 100;
  document.hasFocus = () => false;
  f.sample();
  assert.equal(f.ui.readMarks(f.cell.id).threads[f.thread.id], undefined);
  document.hasFocus = () => true;
  f.sample();
  assert.equal(f.ui.readMarks(f.cell.id).threads[f.thread.id], undefined);
});

test('worker updates have no unread badge even when earlier updates were not seen', t => {
  const f = autoReadFixture(t, [{ top: -500, bottom: -300 }, { top: 10, bottom: 80 }]);
  for (const m of f.cell.messages) m.ack = null;
  f.storage.set('read:cell_test', JSON.stringify({ baseline: 0, threads: {} }));
  f.draw(); f.settle();
  f.ui.closeThread(f.cell.id);
  assert.equal(f.draw().list.querySelector('.hive-unread'), null);
  assert.equal(f.ui.readMarks(f.cell.id).messages?.auto_0, undefined);
  assert.equal(f.ui.readMarks(f.cell.id).messages?.auto_1, 2);
});

test('a delayed auto-read reply cannot overwrite a newer reaction', t => {
  const f = autoReadFixture(t);
  f.settle();
  assert.equal(f.sent[0]?.type, 'hive-auto-read');
  f.ui.noteAck(f.cell.id, 'auto_0', { required: true, state: { kind: 'reaction', reaction: 'approve' }, rev: 2 });
  f.replies[0].onReply({ ok: true, acks: [{ messageId: 'auto_0', ack: { required: true, state: READ, rev: 1 } }] });
  assert.equal(f.ui.ackOf(f.cell.id, f.cell.messages[0]).state.kind, 'reaction');
});

test('the topic unread count keeps unseen messages and removes only confirmed auto-reads', t => {
  const f = autoReadFixture(t, [{ top: -500, bottom: -300 }, { top: 10, bottom: 80 }]);
  f.settle();
  f.replies[0].onReply({ ok: true, acks: [{ messageId: 'auto_1', ack: { required: true, state: READ, rev: 1 } }] });
  f.ui.closeThread(f.cell.id);
  assert.equal(f.draw().list.querySelector('.hive-unread')?.textContent, '1');
});

test('an unavailable deep-link reply clears the prior selection and preserves the overview route', t => {
  const f = fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const previousWindow = globalThis.window;
  t.after(() => { globalThis.window = previousWindow; });
  const win = {
    location: { hash: '#view=ext:hive:overview&cell=cell_missing' },
    history: { replaceState(_state, _title, hash) { win.location.hash = hash; } },
    addEventListener() {}, removeEventListener() {},
  };
  globalThis.window = win;
  const sent = [];
  let reply, view;
  client.register({ api: { storage: f.storage, send: frame => sent.push(frame) }, register(type, entry) { if (type === 'view') view = entry; }, onMessage(fn) { reply = fn; } });
  const hive = { cells: { cell_test: f.cell }, metaEpoch: f.hive.metaEpoch };
  view.update(null, null, { hive });
  resolveLink(hive);
  reply({ op: 'hive-deep-link', requestId: sent[0].requestId, ok: true, cellId: null, notice: 'That hive is unavailable. Showing all hives.' });
  assert.equal(f.ui.cellId(), null);
  assert.equal(win.location.hash, '#view=ext:hive:overview');
});

test('panel focus targets remain stable across cell rerenders', t => {
  const f = fixture(t);
  Object.assign(f.hive, { cells: { [f.cell.id]: f.cell }, operations: [], launches: [] });
  f.hive.beads[f.cell.rootBeadId] = { id: f.cell.rootBeadId, title: 'Root', status: 'open' };
  f.cell.bindings = [];
  f.ui.selectBead(null);
  const ctx = { hive: f.hive, graph: { sessions: [] }, ui: f.ui, api: {}, notices: [], busy: () => false, send() {}, notice() {} };
  for (let i = 0; i < 2; i++) {
    const { dock } = cellPanels(ctx, f.cell);
    for (const pane of ['conversation', 'details']) {
      const panel = dock.querySelector(`.hive-${pane}`);
      assert.equal(panel.dataset.focusKey, `panel:${pane}`);
      assert.equal(panel.attributes.tabindex, '-1');
    }
  }
});

test('Inbox rows have no reaction controls; threads keep exactly Read, Yes and No', (t) => {
  const f = inboxFixture(t);
  let out = f.draw();
  assert.equal(out.list.querySelector('.hive-ack'), null);
  assert.equal(out.toast, null);
  assert.equal(f.sent.length, 0);
  out.list.querySelector('.hive-topic-btn').fire('click');
  out = f.draw();
  const controls = descendants(out.list);
  assert.ok(controls.find(el => el.attributes['data-focus-key'] === 'ack:m2:seen'));
  assert.equal(out.list.querySelectorAll('.hive-ack-glyph').length, 6);
  controls.find(el => el.attributes['data-focus-key'] === 'ack:m2:approve').fire('click');
  f.replies.at(-1).onReply({ ok: true, ack: { required: true, state: { kind: 'reaction', reaction: 'approve' }, rev: 1 }, marked: [] });
  assert.ok(descendants(f.draw().list).find(el => el.attributes['data-focus-key'] === 'ack:m2:approve'));
  f.ui.closeThread(f.cell.id);
  out = f.draw();
  assert.equal(out.list.querySelector('.hive-ack'), null);
  assert.equal(out.toast, null);
});

test('Inbox state exposes no obsolete Undo restore API', t => {
  const f = inboxFixture(t);
  assert.equal(f.ui.restoreToInbox, undefined);
  assert.equal(f.ui.restoredToInbox, undefined);
});

test('messages without controls omit the footer in disabled and snapshot hives', t => {
  for (const state of [{ enabled: false }, { enabled: true, snapshot: {} }]) {
    const f = fixture(t);
    Object.assign(f.cell, state);
    f.cell.threads = [{ id: thr, title: 'Topic', beads: [], count: 1, retained: 1 }];
    f.cell.messages = [{ id: 'human', threadId: thr, author: 'human', text: 'Saved message', at: 1 }];
    f.ui.setAllTopics(f.cell.id, true);
    f.ui.openThreadFor(f.cell.id, thr, f.cell.threads[0]);
    assert.equal(f.draw().list.querySelector('.hive-message-foot'), null);
  }
});

test('Inbox follows server membership after a thread acknowledgement and Undo', t => {
  const f = inboxFixture(t);
  f.draw().list.querySelector('.hive-topic-btn').fire('click');
  descendants(f.draw().list).find(el => el.attributes['data-focus-key'] === 'ack:m2:approve').fire('click');
  f.replies.at(-1).onReply({ ok: true, ack: { required: true, state: { kind: 'reaction', reaction: 'approve' }, rev: 1 }, marked: [{ messageId: 'm1', ack: { required: true, state: READ, rev: 1 } }] });
  descendants(f.draw().list).find(el => el.attributes['data-focus-key'] === 'ack:m2:approve').fire('click');
  f.replies.at(-1).onReply({ ok: true, ack: { required: true, state: null, rev: 2 } });
  f.ui.closeThread(f.cell.id);
  f.cell.inbox.human = { count: 0, ids: [], rev: 2 };
  assert.deepEqual(f.shown(), []);
  f.cell.inbox.human = { count: 1, ids: ['m2'], rev: 3 };
  assert.deepEqual(f.shown(), ['m2']);
  assert.equal(f.draw().list.querySelector('.hive-unread').textContent, '1');
});

for (const recovery of ['sample', 'reopen']) test(`failed auto-read is re-armed for a later ${recovery} without a retry loop`, t => {
  const f = autoReadFixture(t);
  f.settle();
  f.replies[0].onReply({ ok: false, error: 'Request timed out' });
  f.sample();
  assert.equal(f.sent.length, 1);
  t.mock.timers.tick(1000);
  assert.equal(f.sent.length, 1);
  if (recovery === 'reopen') {
    f.ui.closeThread(f.cell.id);
    f.ui.openThreadFor(f.cell.id, f.thread.id, f.thread);
    f.draw(); f.settle();
  } else f.sample();
  assert.deepEqual(f.sent[1]?.messages, [{ messageId: 'auto_0', rev: 0 }]);
});

for (const acknowledged of [true, false]) test(`a fully auto-read ${acknowledged ? 'queen' : 'worker'} topic has no unread badge with a real server summary`, async t => {
  const { threadSummary, threadIndex } = await import('../server/conversation.js');
  const f = autoReadFixture(t);
  if (!acknowledged) f.cell.messages[0].ack = null;
  f.storage.set('read:cell_test', JSON.stringify({ baseline: 0, threads: {} }));
  f.cell.threads = [threadSummary(f.thread, threadIndex(f.cell.messages).get(f.thread.id))];
  f.draw(); f.settle();
  if (acknowledged) f.replies[0].onReply({ ok: true, acks: [{ messageId: 'auto_0', ack: { required: true, state: READ, rev: 1 } }] });
  f.ui.closeThread(f.cell.id);
  assert.equal(f.draw().list.querySelector('.hive-unread'), null);
});

test('confirmed auto-read keeps direct reactions available without Undo', t => {
  const f = autoReadFixture(t);
  f.settle();
  f.replies[0].onReply({ ok: true, acks: [{ messageId: 'auto_0', ack: { required: true, state: { kind: 'read', automatic: true }, rev: 1 } }] });
  const button = descendants(f.draw().list).find(el => el.dataset.focusKey === 'ack:auto_0:approve');
  assert.ok(button, 'a read message retains its direct reaction control');
  button.fire('click');
  assert.deepEqual(f.sent[1], { type: 'hive-ack', cellId: f.cell.id, messageId: 'auto_0', rev: 1, kind: 'reaction', reaction: 'approve' });
});

test('a reaction clicked during auto-read stays confirmed when the older read reply arrives', t => {
  const f = autoReadFixture(t);
  f.settle();
  descendants(f.current().list).find(el => el.dataset.focusKey === 'ack:auto_0:approve').fire('click');
  assert.equal(f.sent[1].rev, 0);
  f.replies[1].onReply({ ok: true, ack: { required: true, state: { kind: 'reaction', reaction: 'approve' }, rev: 2 } });
  f.replies[0].onReply({ ok: true, acks: [{ messageId: 'auto_0', ack: { required: true, state: { kind: 'read', automatic: true }, rev: 1 } }] });
  assert.equal(f.ui.ackOf(f.cell.id, f.cell.messages[0]).state.kind, 'reaction');
});

test('an auto-read queen preview stays read when its message leaves the projected window', async t => {
  const { threadSummary, threadIndex } = await import('../server/conversation.js');
  const f = autoReadFixture(t);
  f.storage.set('read:cell_test', JSON.stringify({ baseline: 0, threads: {} }));
  f.settle();
  const ack = { required: true, state: { kind: 'read', automatic: true }, rev: 1 };
  f.replies[0].onReply({ ok: true, acks: [{ messageId: 'auto_0', ack }] });
  const serverMessages = [{ ...f.cell.messages[0], ack }];
  f.cell.threads = [threadSummary(f.thread, threadIndex(serverMessages).get(f.thread.id))];
  f.ui.closeThread(f.cell.id);
  f.cell.messages = [];
  assert.equal(f.draw().list.querySelector('.hive-unread'), null);
});

for (const state of [{ kind: 'read', automatic: true }, { kind: 'reaction', reaction: 'approve' }, { kind: 'reply', replyId: 'human_reply' }]) test(`a fresh UI has no unread badge for an unprojected ${state.kind} queen message`, async t => {
  const { threadSummary, threadIndex } = await import('../server/conversation.js');
  const f = fixture(t, { 'read:cell_test': { baseline: 0, threads: {} } });
  const message = queen('saved_queen', 100, state, 1);
  const topic = { id: thr, title: 'Saved topic', count: 1, lastAt: 100 };
  f.cell.threads = [threadSummary(topic, threadIndex([message]).get(thr))];
  f.ui.setAllTopics(f.cell.id, true);
  assert.equal(f.cell.messages.length, 0);
  assert.equal(f.ui.ackOf(f.cell.id, { id: message.id }), null, 'no acknowledgement is cached in the fresh UI');
  assert.equal(f.draw().list.querySelector('.hive-unread'), null);
});


test('topic relations include anchors, published beads and mentions only within this cell', async (t) => {
  const { relatedBeads } = await import('./conversation.js');
  const f = fixture(t);
  f.hive.beads['hive-root'] = { id: 'hive-root' };
  f.hive.beads['hive-one'].parentId = 'hive-root';
  f.hive.beads['hive-two'].parentId = 'hive-root';
  f.hive.beads['hive-other'] = { id: 'hive-other', parentId: 'elsewhere' };
  const topic = { beadId: 'hive-one', beads: ['hive-two'], references: ['hive-other', 'hive-two', 'hive-missing'] };
  assert.deepEqual([...relatedBeads(f.hive, f.cell, topic, [])], ['hive-one', 'hive-two']);
  assert.deepEqual([...relatedBeads(f.hive, f.cell, {}, [{ beadId: 'hive-one', text: 'See (hive-two), hive-other, hive-missing and nothive-root.' }])], ['hive-one', 'hive-two']);
});

test('topic projection retains references from messages outside the browser window', async () => {
  const { threadSummary, threadIndex } = await import('../server/conversation.js');
  const msgs = [{ id: 'old', threadId: 'topic', text: 'See hive-one and hive-two.', at: 1 }, { id: 'new', threadId: 'topic', text: 'Updated', at: 2 }];
  assert.deepEqual(threadSummary({ id: 'topic' }, threadIndex(msgs, { references: true }).get('topic')).references, ['hive-one', 'hive-two']);
});

test('message selection narrows relations and Escape or the topic header restores the union', (t) => {
  const f = fixture(t);
  f.hive.beads['hive-root'] = { id: 'hive-root' };
  for (const id of ['hive-one', 'hive-two']) f.hive.beads[id].parentId = 'hive-root';
  f.cell.threads = [{ id: 'topic', title: 'Work', beads: ['hive-one', 'hive-two'], retained: 2 }];
  f.cell.messages = [{ id: 'first', threadId: 'topic', author: 'human', text: 'hive-one', at: 1 }, { id: 'second', threadId: 'topic', author: 'human', text: 'hive-two', at: 2 }];
  f.ui.setAllTopics(f.cell.id, true);
  f.ui.openThreadFor(f.cell.id, 'topic');
  let out = f.draw();
  assert.deepEqual([...out.related.ids], ['hive-one', 'hive-two']);
  out.list.querySelector('.hive-message').fire('focusin');
  out = f.draw();
  assert.deepEqual([...out.related.ids], ['hive-one']);
  assert.match(out.list.querySelector('.hive-message').attributes.class, /is-conversation-selected/);
  out.list.querySelector('.hive-message').fire('keydown', { key: 'Escape' });
  out = f.draw();
  assert.deepEqual([...out.related.ids], ['hive-one', 'hive-two']);
  out.list.querySelectorAll('.hive-message')[1].fire('click');
  assert.deepEqual([...f.draw().related.ids], ['hive-two']);
  f.draw().head.fire('click');
  assert.deepEqual([...f.draw().related.ids], ['hive-one', 'hive-two']);
  f.ui.closeThread(f.cell.id);
  assert.equal(f.draw().related, undefined);
});


test('deep links select their message while scroll and restored focus keep that selection', (t) => {
  const f = fixture(t);
  f.hive.beads['hive-root'] = { id: 'hive-root' };
  for (const id of ['hive-one', 'hive-two']) f.hive.beads[id].parentId = 'hive-root';
  const thread = { id: 'topic', title: 'Work', beadId: 'hive-one', beads: ['hive-two'], retained: 2 };
  const messages = [{ id: 'first', threadId: 'topic', author: 'human', text: 'Unrelated', at: 1 }, { id: 'second', threadId: 'topic', author: 'human', text: 'hive-two', at: 2 }];
  f.cell.threads = [thread];
  f.ui.openDeepLink({ cellId: f.cell.id, thread, messageId: 'first', messages, more: false, anchorN: 3 }, f.hive.metaEpoch);
  let out = f.draw();
  assert.deepEqual([...out.related.ids], ['hive-one']);
  out.list.fire('scroll');
  f.ui.restoringFocus = () => true;
  out.list.querySelectorAll('.hive-message')[1].fire('focusin');
  assert.equal(f.ui.conversationMessage(f.cell.id, thread.id), 'first');
  f.ui.restoringFocus = () => false;
  const second = out.list.querySelectorAll('.hive-message')[1];
  second.fire('pointerdown');
  second.fire('focusin');
  assert.equal(f.ui.conversationMessage(f.cell.id, thread.id), 'first');
  second.fire('pointerup'); second.fire('click');
  assert.deepEqual([...f.draw().related.ids], ['hive-one', 'hive-two']);
  assert.equal(f.ui.selectedBeadId(), 'hive-one');
});

test('bead references do not match fragments of larger identifiers', async () => {
  const { beadReferences } = await import('./bead-references.js');
  assert.deepEqual(beadReferences('other-hive-one prefix_hive-two (hive-three), hive-four. hive-five.child hive-three'), ['hive-three', 'hive-four', 'hive-five.child']);
});

test('Escape widens a message selection from the map or conversation panel', (t) => {
  const f = fixture(t);
  f.hive.beads['hive-root'] = { id: 'hive-root', kind: 'goal' };
  Object.assign(f.hive, { cells: { [f.cell.id]: f.cell }, operations: [], launches: [], edges: [] });
  f.cell.bindings = [];
  f.ui.selectBead(null);
  f.cell.threads = [{ id: 'topic', title: 'Work', retained: 0 }];
  f.ui.openThreadFor(f.cell.id, 'topic');
  f.ui.selectConversationMessage(f.cell.id, 'topic', 'message');
  f.ui.setAllTopics(f.cell.id, true);
  const panels = cellPanels({ hive: f.hive, graph: { sessions: [] }, ui: f.ui, busy: () => false, send() {}, api: {}, notices: [] }, f.cell);
  panels.onKeyDown({ key: 'Escape' });
  assert.equal(f.ui.conversationMessage(f.cell.id, 'topic'), null);
});


function relationsFixture(t) {
  const f = fixture(t);
  f.hive.beads['hive-root'] = { id: 'hive-root' };
  for (const id of ['hive-one', 'hive-two']) f.hive.beads[id].parentId = 'hive-root';
  f.cell.threads = [{ id: 'topic', title: 'Work', retained: 1, count: 2, references: ['hive-two'] }];
  f.cell.messages = [{ id: 'new', n: 2, threadId: 'topic', author: 'human', text: 'hive-two', at: 2 }];
  f.ui.setAllTopics(f.cell.id, true);
  f.ui.openThreadFor(f.cell.id, 'topic');
  return f;
}

test('references from pruned cached history must leave the topic union', (t) => {
  const f = relationsFixture(t);
  f.ui.addHistory(f.cell.id, 'topic', f.hive.metaEpoch, {
    messages: [{ id: 'old', n: 1, threadId: 'topic', author: 'human', text: 'hive-one', at: 1 }],
    more: false, anchorN: 2,
  }, 2);
  assert.deepEqual([...f.draw().related.ids], ['hive-two']);
});

test('keyboard entry at Reply keeps focus connected after message selection redraw', (t) => {
  const f = relationsFixture(t);
  const previousCSS = globalThis.CSS;
  t.after(() => { globalThis.CSS = previousCSS; });
  globalThis.CSS = { escape: value => value };
  const root = document.createElement('div');
  root.querySelector = selector => descendants(root).find(el => el.dataset.focusKey === selector.match(/data-focus-key="([^"]+)"/)?.[1]) || null;
  let out = f.draw(); root.append(out.list);
  const select = f.ui.selectConversationMessage.bind(f.ui);
  f.ui.selectConversationMessage = (...args) => {
    select(...args);
    const focus = captureFocus(root);
    out = f.draw(); root.replaceChildren(out.list);
    restoreFocus(root, focus);
  };
  f.cell.messages[0].beadId = 'hive-two';
  f.cell.messages[0].delivery = { state: 'failed' };
  for (const label of ['Reply', 'Two', 'Send to queen']) {
    select(f.cell.id, 'topic', null);
    out = f.draw(); root.replaceChildren(out.list);
    const control = out.list.querySelectorAll('button').find(b => b.textContent === label);
    control.focus(); control.fire('focusin');
    assert.equal(root.contains(document.activeElement), true, label);
    assert.equal(document.activeElement.textContent, label);
  }
});

test('extraction must reject suffix fragments as it rejects prefix fragments', async () => {
  const { beadReferences } = await import('./bead-references.js');
  assert.deepEqual(beadReferences('hive-one-OTHER hive-two.child_name `hive-one-OTHER` \n```\nhive-two.child_name\n```'), []);
  assert.deepEqual(beadReferences('hive-one. hive-two, (hive-three) hive-four.child'), ['hive-one', 'hive-two', 'hive-three', 'hive-four.child']);
});


test('an empty server reference projection excludes cached published beads and text', async (t) => {
  const { relatedBeads } = await import('./conversation.js');
  const f = relationsFixture(t);
  const cached = [{ id: 'old', beadId: 'hive-one', text: 'hive-two' }];
  assert.deepEqual([...relatedBeads(f.hive, f.cell, { references: [] }, cached)], []);
  assert.deepEqual([...relatedBeads(f.hive, f.cell, { beadId: 'hive-two', references: [] }, cached)], ['hive-two']);
  assert.deepEqual([...relatedBeads(f.hive, f.cell, { references: [] }, cached, 'old')], ['hive-one', 'hive-two']);
  assert.deepEqual([...relatedBeads(f.hive, f.cell, {}, cached)], ['hive-one', 'hive-two']);
});

test('an older open topic uses the current relation projection instead of its cached summary', t => {
  const f = relationsFixture(t);
  const cached = { ...f.cell.threads[0], references: ['hive-one'] };
  f.ui.openThreadFor(f.cell.id, 'topic', cached);
  f.cell.threads = [];
  f.cell.messages = [];
  f.cell.topicRelations = { topic: { beadId: null, beads: [], references: ['hive-two'] } };
  assert.deepEqual([...f.draw().related.ids], ['hive-two']);
  f.cell.topicRelations = {};
  assert.deepEqual([...f.draw().related.ids], []);
});

test('hex reactions expose labels, selected state and legacy reactions read-only', t => {
  const f = topicFixture(t, ['m1', 'm2', 'm3']);
  f.cell.messages.find(m => m.id === 'm2').ack = { required: true, state: { kind: 'reaction', emoji: '👍' }, rev: 1 };
  const bar = descendants(f.draw().list).find(el => el.dataset.id === 'm2').querySelector('.hive-ack');
  const buttons = bar.querySelectorAll('button');
  assert.deepEqual(buttons.map(b => b.attributes['aria-label']), ['Read', 'Yes', 'No']);
  for (const b of buttons) {
    assert.equal(b.attributes.title, b.attributes['aria-label']);
    assert.equal(b.attributes.type, 'button');
    assert.ok(b.querySelector('svg'));
    assert.equal(b.querySelector('svg').attributes['aria-hidden'], 'true');
  }
  assert.ok(bar.textContent.includes('You reacted 👍'));
  assert.equal(buttons.some(b => b.attributes['aria-label'].includes('👍')), false);
  buttons[2].fire('click');
  assert.equal(f.sent.at(-1).reaction, 'decline');
  f.replies.at(-1).onReply({ ok: true, ack: { required: true, state: { kind: 'reaction', reaction: 'decline' }, rev: 2 } });
  assert.equal(descendants(f.draw().list).find(el => el.dataset.id === 'm2').querySelectorAll('button').find(b => b.attributes['aria-label'] === 'No').attributes['aria-pressed'], 'true');
});

for (const [state, label] of [[{ kind: 'read' }, 'Read'], [{ kind: 'reaction', reaction: 'approve' }, 'Yes'], [{ kind: 'reaction', reaction: 'decline' }, 'No']]) test(`stored ${label} state selects exactly its matching control`, t => {
  const f = topicFixture(t, ['m1', 'm2']);
  f.cell.messages.find(m => m.id === 'm2').ack = { required: true, state, rev: 2 };
  const bar = descendants(f.draw().list).find(el => el.dataset.id === 'm2').querySelector('.hive-ack');
  assert.deepEqual(bar.querySelectorAll('button').filter(b => b.attributes['aria-pressed'] === 'true').map(b => b.attributes['aria-label']), [label]);
});

test('clearing a reaction restores focus to an existing Read fallback', t => {
  const f = fixture(t), before = globalThis.CSS;
  t.after(() => { globalThis.CSS = before; });
  globalThis.CSS = { escape: value => value };
  f.ui.noteAck(f.cell.id, 'm2', { required: true, state: null, rev: 2 });
  const read = new Element('button');
  restoreFocus({ querySelector: selector => selector === '[data-focus-key="ack:m2:seen"]' ? read : null }, { focusKey: 'missing' });
  assert.equal(document.activeElement, read);
});

test('selected Yes toggles off silently and leaves its durable reply visible', t => {
  const f = topicFixture(t, ['m1', 'm2', 'm3']);
  const source = f.cell.messages.find(m => m.id === 'm2');
  source.ack = { required: true, state: { kind: 'reaction', reaction: 'approve', replyId: 'signal' }, rev: 1 };
  f.cell.messages.push({ id: 'signal', author: 'human', reaction: 'approve', text: 'Approved', at: 40, threadId: source.threadId, replyTo: 'm2', response: { required: true, answers: [] }, delivery: { state: 'delivered' } });
  const out = f.draw();
  const signal = out.list.children.find(el => el.dataset.id === 'signal');
  const link = signal.querySelector('.hive-reaction-reply');
  assert.equal(link.textContent, 'Yes');
  assert.equal(link.attributes.href, `#view=ext:hive:overview&cell=${f.cell.id}&topic=${source.threadId}&message=m2`);
  assert.ok(link.querySelector('svg'));
  assert.equal(signal.querySelector('.hive-ack'), null);
  assert.equal(signal.querySelector('.hive-quote'), null);
  assert.ok(signal.textContent.includes("Waiting for the queen's answer"));
  descendants(out.list).find(el => el.attributes['data-focus-key'] === 'ack:m2:approve').fire('click');
  assert.deepEqual(f.sent.at(-1), { type: 'hive-ack-undo', cellId: f.cell.id, messageId: 'm2', rev: 1 });
  f.replies.at(-1).onReply({ ok: true, ack: { required: true, state: null, rev: 2 } });
  assert.ok(f.draw().list.children.find(el => el.dataset.id === 'signal'));
});

function nativeFixture(t, audience = 'human') {
  const f = fixture(t), id = 'hreq_123456789abc';
  f.cell.inbox = { human: { count: 0, ids: [] }, queen: { count: 0, ids: [] } };
  f.cell.requests = { [id]: { id, title: 'API decision', body: 'Keep compatibility?', state: 'open', audience, revision: 3, routeRevision: 2, createdAt: 1, requesterSessionId: 'worker', messageId: 'native-message', threadId: thr } };
  f.cell.requestCounts = { human: audience === 'human' ? 1 : 0, queen: audience === 'queen' ? 1 : 0 };
  f.cell.threads = [{ id: thr, title: 'API decision', beads: [], count: 1, retained: 1, lastAt: 1 }];
  f.cell.messages = [{ id: 'native-message', requestId: id, author: 'session', text: 'API decision', at: 1, n: 1, threadId: thr }];
  f.ui.setAllTopics(f.cell.id, true);
  return { ...f, id };
}
test('Needs you count uses the inbox badge and disappears at zero', t => {
  const f = nativeFixture(t);
  const needsFilter = () => descendants(f.draw().head).find(el => el.tagName === 'button' && el.textContent.startsWith('Needs you'));
  assert.equal(needsFilter().querySelector('.hive-inbox-count').textContent, '1');
  f.cell.requestCounts.human = 0;
  assert.equal(needsFilter().querySelector('.hive-inbox-count'), null);
});
test('Needs you filter shows canonical request with a dedicated answer and preserves draft on revision change', t => {
  const f = nativeFixture(t);
  const filter = descendants(f.draw().head).find(el => el.tagName === 'button' && el.textContent.startsWith('Needs you'));
  assert.ok(filter); filter.fire('click');
  let out = f.draw();
  assert.match(out.list.textContent, /Keep compatibility/);
  const text = out.list.querySelector('textarea');
  assert.ok(text); text.value = 'Keep the API'; text.fire('input');
  f.cell.requests[f.id].routeRevision++;
  out = f.draw();
  assert.equal(out.list.querySelector('textarea').value, 'Keep the API');
  assert.match(out.list.textContent, /changed/);
  const review = descendants(out.list).find(el => el.tagName === 'button' && el.textContent === 'Review current request'); review.fire('click');
  out = f.draw();
  descendants(out.list).find(el => el.tagName === 'button' && el.textContent === 'Answer request').fire('click');
  assert.equal(f.sent.at(-1).type, 'hive-request-answer');
  assert.equal(f.sent.at(-1).request_id, f.id);
  assert.equal(f.sent.at(-1).text, 'Keep the API');
});
test('Waiting for queen contains only human messages, never native worker requests', t => {
  const f = nativeFixture(t, 'queen');
  f.ui.setInboxView(f.cell.id, 'queen');
  const out = f.draw();
  assert.doesNotMatch(out.list.textContent, /Worker request|API decision/);
  assert.equal(out.list.querySelector('textarea'), null);
});

test('request filters keep selection scope with an explicit show-all escape and full-cell counts', t => {
  const f = nativeFixture(t);
  f.ui.setAllTopics(f.cell.id, false);
  f.cell.requests[f.id].beadId = 'hive-two';
  f.ui.setInboxView(f.cell.id, 'needs');
  let out = f.draw();
  assert.doesNotMatch(out.list.textContent, /Keep compatibility/);
  const all = descendants(out.list).find(el => el.tagName === 'button' && /Show all in this hive/.test(el.textContent));
  assert.ok(all); all.fire('click');
  out = f.draw();
  assert.match(out.list.textContent, /Keep compatibility/);
});

test('rail badge uses host-supported numeric counts even when request metadata is unavailable', t => {
  const f = fixture(t);
  assert.equal(f.view.badge({ hive: { requestCount: 3 } }), 3);
  assert.equal(f.view.badge({ hive: { metadataError: 'Corrupt metadata' } }), 0);
});

test('visibility changes discard old numbered pages and late responses while preserving answer drafts', t => {
  const f = nativeFixture(t);
  f.cell.conversationRevision = 'visible-one';
  f.draw();
  const epoch = `${f.hive.metaEpoch}:visible-one`;
  f.ui.addHistory(f.cell.id, thr, epoch, { messages: [{ id: 'old-page', threadId: thr, n: 1, text: 'Prior question' }], anchorN: 2, more: false, conversationRevision: 'visible-one' });
  f.ui.setDraftFor(`request:${f.id}`, 'Preserved draft');
  assert.ok(f.ui.historyFor(f.cell.id, thr, epoch));
  f.cell.conversationRevision = 'visible-two';
  f.draw();
  assert.equal(f.ui.historyFor(f.cell.id, thr, epoch), null);
  f.ui.addHistory(f.cell.id, thr, epoch, { messages: [{ id: 'late-page', n: 1 }], anchorN: 2, conversationRevision: 'visible-one' });
  assert.equal(f.ui.historyFor(f.cell.id, thr, epoch), null);
  assert.equal(f.ui.draftFor(`request:${f.id}`), 'Preserved draft');
});

test('a deep-link response from an older audience view is refreshed before opening', t => {
  const f = fixture(t), previousWindow = globalThis.window;
  t.after(() => { globalThis.window = previousWindow; });
  const listeners = [], win = {
    location: { hash: '#view=ext:hive:overview' },
    history: { replaceState(_state, _title, hash) { win.location.hash = hash; } },
    addEventListener(type, fn) { if (type === 'hashchange') listeners.push(fn); }, removeEventListener() {},
  };
  globalThis.window = win;
  const sent = [];
  let reply, view;
  client.register({ api: { storage: f.storage, send: frame => sent.push(frame) }, register(type, entry) { if (type === 'view') view = entry; }, onMessage(fn) { reply = fn; } });
  f.cell.conversationRevision = 'current';
  const hive = { cells: { [f.cell.id]: f.cell }, metaEpoch: f.hive.metaEpoch };
  view.update(null, null, { hive });
  win.location.hash = `#view=ext:hive:overview&cell=${f.cell.id}&topic=${thr}&message=msg_target`;
  for (const fn of listeners) fn();
  resolveLink(hive);
  const frame = { op: 'hive-deep-link', requestId: sent[0].requestId, ok: true, cellId: f.cell.id, thread: { id: thr }, messageId: 'msg_target', messages: [], anchorN: 1 };
  reply({ ...frame, conversationRevision: 'obsolete' });
  assert.equal(sent.length, 2);
  reply({ ...frame, requestId: sent[1].requestId, conversationRevision: 'current' });
  assert.equal(f.ui.linkedMessage(f.cell.id, thr).messageId, 'msg_target');
});

for (const action of ['answer', 'dismiss']) for (const list of [false, true]) test(`request ${action} retains focus on ${list ? 'Needs you list' : 'settled card'}`, t => {
  const f = fixture(t), originalCSS = globalThis.CSS;
  globalThis.CSS = { escape: value => value };
  t.after(() => { globalThis.CSS = originalCSS; });
  const r = { id: 'hreq_focus', title: 'Decision', body: 'Choose', audience: 'human', state: 'open', revision: 1, routeRevision: 1 };
  f.cell.requests = { [r.id]: r };
  let reply;
  const ctx = { busy: () => false, notice() {}, send: (_frame, callbacks) => { reply = callbacks.onReply; } };
  const draw = () => {
    const root = list ? requestList({ cell: f.cell, kind: 'needs', ui: f.ui, ctx }) : requestCard(r, { cell: f.cell, ui: f.ui, ctx });
    for (const el of descendants(root)) el.disabled = Object.hasOwn(el.attributes, 'disabled');
    root.querySelector = selector => descendants(root).find(el => el.dataset.focusKey === selector.match(/data-focus-key="([^"]+)"/)?.[1]) || null;
    return root;
  };
  f.ui.setDraftFor(`request:${r.id}`, 'Proceed');
  const before = draw(), button = descendants(before).find(el => el.tagName === 'button' && el.textContent === (action === 'answer' ? 'Answer request' : 'Dismiss request'));
  button.focus();
  const focus = captureFocus(before);
  button.fire('click');
  const pending = draw();
  restoreFocus(pending, focus);
  assert.equal(document.activeElement.tagName, 'article');
  const pendingFocus = captureFocus(pending);
  reply({ ok: true });
  Object.assign(r, { state: action === 'answer' ? 'answered' : 'dismissed', delivery: { state: 'delivered' } });
  const after = draw();
  restoreFocus(after, pendingFocus);
  assert.equal(document.activeElement, after);
  assert.equal(after.attributes.tabindex, '-1');
});

test('request option buttons answer once with optional note and preserve drafts on stale rejection', t => {
  const f = fixture(t), r = { id: 'hreq_123456789abc', title: 'API?', body: 'Choose', state: 'open', audience: 'human', revision: 1, routeRevision: 1, contentRevision: 1, options: [{ id: 'keep', label: 'Keep (Recommended)', description: 'Compatibility' }, { id: 'replace', label: 'Replace' }] };
  const draw = request => requestCard(request, { cell: f.cell, graph: {}, api: {}, ui: f.ui, ctx: { busy: () => false, send: (frame, opts) => { f.sent.push(frame); f.replies.push(opts); }, notice() {} } });
  let card = draw(r);
  assert.match(card.textContent, /1Keep \(Recommended\)Compatibility2Replace/);
  const ta = card.querySelector('textarea');
  assert.equal(ta.attributes.maxlength, '4000');
  assert.match(card.textContent, /Your answer, or a note with your choice/);
  ta.value = 'after lunch'; ta.fire('input');
  card.querySelector('.hive-request-option').fire('click');
  card.querySelector('.hive-request-option').fire('click');
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].option_id, 'keep');
  assert.equal(f.sent[0].text, 'after lunch');
  f.replies[0].onReply({ ok: false, code: 'conflict' });
  card = draw({ ...r, revision: 2, contentRevision: 2 });
  assert.equal(card.querySelector('textarea').value, 'after lunch');
  assert.ok(card.querySelector('.hive-request-option').attributes.disabled !== undefined);
  assert.match(card.textContent, /draft is kept/);
  descendants(card).find(el => el.tagName === 'button' && el.textContent === 'Review current request').fire('click');
  card = draw({ ...r, revision: 2, contentRevision: 2 });
  card.querySelector('.hive-request-option').fire('click');
  assert.equal(f.sent.at(-1).revision, 2);
  f.replies.at(-1).onReply({ ok: true });
  assert.equal(f.ui.draftFor(`request:${r.id}`), '');
});

test('refreshing message relations preserves message nodes and selects from current state', (t) => {
  const f = relationsFixture(t);
  f.cell.messages.unshift({ id: 'older', n: 1, threadId: 'topic', author: 'human', text: 'hive-one', at: 1 });
  const out = f.draw();
  const messages = out.list.querySelectorAll('.hive-message');
  const selected = new Set();
  for (const message of messages) message.classList.toggle = (name, on) => { if (name === 'is-conversation-selected') on ? selected.add(message.dataset.id) : selected.delete(message.dataset.id); };
  f.ui.selectConversationMessage(f.cell.id, 'topic', 'older');
  out.related.refresh();
  assert.deepEqual([...out.related.ids], ['hive-one']);
  assert.deepEqual([...selected], ['older']);
  f.ui.selectConversationMessage(f.cell.id, 'topic', 'new');
  out.related.refresh();
  assert.deepEqual([...out.related.ids], ['hive-two']);
  assert.deepEqual([...selected], ['new']);
  f.ui.selectConversationMessage(f.cell.id, 'topic', null);
  out.related.refresh();
  assert.deepEqual([...out.related.ids], ['hive-two']);
  assert.equal(selected.size, 0);
  assert.deepEqual(out.list.querySelectorAll('.hive-message'), messages);
});


test('only the open topic loads relations, once per metadata version, and late replies are discarded', t => {
  const f = relationsFixture(t);
  f.hive.metaVersion = 1;
  f.draw(); f.draw();
  assert.equal(f.relationRequests.length, 1);
  const first = f.relationRequests[0];
  assert.equal(first.frame.threadId, 'topic');
  first.opts.onReply({ ok: true, relations: { references: ['hive-one'] } });
  assert.deepEqual([...f.draw().related.ids], ['hive-one']);
  f.hive.metaVersion = 2;
  f.draw();
  assert.equal(f.relationRequests.length, 2);
  first.opts.onReply({ ok: true, relations: { references: ['hive-one'] } });
  f.relationRequests[1].opts.onReply({ ok: true, relations: { references: [] } });
  assert.deepEqual([...f.draw().related.ids], []);
  f.ui.closeThread(f.cell.id);
  f.draw();
  assert.equal(f.relationRequests.length, 2);
  f.relationRequests[1].opts.onReply({ ok: true, relations: { references: ['hive-one'] } });
  f.ui.openThreadFor(f.cell.id, 'topic');
  assert.deepEqual([...f.draw().related.ids], ['hive-two']);
  assert.equal(f.relationRequests.length, 3);
});

test('a missing root removes the open conversation read listeners without throwing', t => {
  const f = topicFixture(t, ['m2']);
  Object.assign(f.hive, { cells: { [f.cell.id]: f.cell }, operations: [], launches: [] });
  f.hive.beads[f.cell.rootBeadId] = { id: f.cell.rootBeadId, title: 'Root', status: 'open' };
  f.cell.bindings = [];
  f.ui.selectBead(null);
  const ctx = { hive: f.hive, graph: { sessions: [] }, ui: f.ui, api: {}, notices: [], busy: () => false, send() {}, notice() {} };
  const panel = cellPanels(ctx, f.cell).dock.querySelector('.hive-conversation');
  assert.equal(panel.events.focusin.length, 1);
  delete f.hive.beads[f.cell.rootBeadId];
  assert.equal(cellPanels(ctx, f.cell).dock, null);
  assert.equal(panel.events.focusin.length, 0);
  assert.equal(panel.events.wheel.length, 0);
});

test('the conversation renderer accepts transport-only ctx without an explicit UI cache version', t => {
  const f = fixture(t);
  const args = { cell: f.cell, hive: f.hive, graph: { sessions: [] }, api: {}, ui: f.ui, ctx: f.ctx };
  const first = renderConversation(args);
  f.ui.setTopicAbout(f.cell.id, 'hive-two');
  const next = renderConversation(args);
  assert.notEqual(first, next);
  assert.ok(next.composer.textContent.includes('Two'));
});

for (const source of ['manual', 'auto-read']) test(`${source} callbacks keep counts aligned through read and Undo snapshots`, async t => {
  const { humanConversationDoc, inboxSlice, threadSummary, threadIndex } = await import('../server/conversation.js');
  const f = autoReadFixture(t);
  const original = f.cell.messages[0];
  const other = { ...queen('other', 2), threadId: 'thr_other' };
  const summary = m => threadSummary({ id: m.threadId, title: m.id, count: 1 }, threadIndex([m]).get(m.threadId));
  const pending = summary(original), otherTopic = summary(other);
  const inbox = messages => inboxSlice(humanConversationDoc({ conversation: { [f.cell.id]: messages }, threads: { [f.cell.id]: { [original.threadId]: pending, [other.threadId]: otherTopic } } }, f.cell.id), f.cell.id, 'human');
  f.cell.messages.push(other);
  f.cell.threads = [pending, otherTopic];
  f.cell.inbox = { human: inbox([original, other]), queen: { count: 0, ids: [], rev: 0 } };
  f.ui.addOlderTopics(f.cell.id, f.hive.metaEpoch, [pending], false, null);
  f.draw();
  if (source === 'auto-read') f.settle();
  else descendants(f.current().list).find(el => el.dataset.focusKey === 'ack:auto_0:seen').fire('click');
  const ack = { required: true, state: READ, rev: 1 };
  f.replies.at(-1).onReply({ ok: true, ack, acks: [{ messageId: 'auto_0', ack }], inboxRev: inbox([{ ...original, ack }, other]).rev });
  const hideOlder = () => {
    f.cell.messages = [other]; f.cell.threads = [otherTopic];
    f.ui.closeThread(f.cell.id); f.ui.setAllTopics(f.cell.id, true);
  };
  const count = () => Number(descendants(f.draw().head).find(el => el.dataset.focusKey === `inbox:${f.cell.id}:human`).querySelector('.hive-inbox-count').textContent);
  hideOlder();
  assert.equal(count(), 1);
  f.cell.inbox.human = inbox([original, { ...other, ack: { required: true, state: null, rev: 2 } }]);
  assert.equal(count(), 1);
  f.cell.inbox.human = inbox([{ ...original, ack }, other]);
  assert.equal(count(), 1);
  const approved = { required: true, state: { kind: 'reaction', reaction: 'approve' }, rev: 1 };
  const settled = summary({ ...original, ack: approved });
  f.ui.addOlderTopics(f.cell.id, f.hive.metaEpoch, [settled], false, null);
  f.cell.messages = [{ ...original, ack: approved }, other]; f.cell.threads = [settled, otherTopic];
  f.ui.openThreadFor(f.cell.id, settled.id, settled);
  descendants(f.draw().list).find(el => el.dataset.focusKey === 'ack:auto_0:approve').fire('click');
  f.replies.at(-1).onReply({ ok: true, ack: { required: true, state: null, rev: 2 }, inboxRev: inbox([{ ...original, ack: { required: true, state: null, rev: 2 } }, other]).rev });
  hideOlder();
  assert.equal(count(), 2);
  f.cell.inbox.human = inbox([{ ...original, ack }, { ...other, ack: { required: true, state: null, rev: 4 } }]);
  assert.equal(count(), 2);
  f.cell.inbox.human = inbox([{ ...original, ack: { required: true, state: null, rev: 2 } }, other]);
  assert.equal(count(), 2);
});

test('message arrivals retain the connected list and unchanged rows during scrolling', t => {
  const f = fixture(t);
  f.cell.messages = Array.from({ length: 12 }, (_, i) => ({ id: `scroll_${i}`, author: 'human', text: `Message ${i}`, at: 1 }));
  delete f.cell.threads;
  const first = f.draw();
  document.body.append(first.list);
  const row = first.list.children[3];
  first.list.scrollTop = 450;
  first.list.fire('wheel', { deltaY: -30 });
  f.cell.messages.push({ id: 'arrival', author: 'human', text: 'New message', at: 1 });
  const next = f.draw();
  assert.equal(next.list, first.list, 'the scroller must remain connected during a message update');
  assert.equal(next.list.parentElement, document.body);
  assert.equal(next.list.children[3], row, 'unchanged message rows stay connected');
  assert.equal(next.list.scrollTop, 450);
  assert.ok(next.list.textContent.includes('New message'));
});

test('topic updates retain unchanged rows but replace revised acknowledgement handlers', t => {
  const f = fixture(t);
  f.cell.threads = [{ id: thr, title: 'Scrolling topic', count: 2, retained: 2, beads: [] }];
  f.cell.messages = [
    { id: 'first', n: 1, threadId: thr, author: 'human', text: 'First', at: 1 },
    { id: 'queen', n: 2, threadId: thr, author: 'session', text: 'Question', at: 2, ack: { required: true, rev: 1, state: null } },
  ];
  f.ui.setAllTopics(f.cell.id, true);
  f.ui.openThreadFor(f.cell.id, thr, f.cell.threads[0]);
  const first = f.draw();
  const row = first.list.children.find(el => el.dataset.id === 'first');
  const queen = first.list.children.find(el => el.dataset.id === 'queen');
  f.cell.messages[1] = { ...f.cell.messages[1], ack: { required: true, rev: 2, state: null } };
  const next = f.draw();
  assert.equal(next.list, first.list);
  assert.equal(next.list.children.find(el => el.dataset.id === 'first'), row);
  const revised = next.list.children.find(el => el.dataset.id === 'queen');
  assert.notEqual(revised, queen);
  revised.querySelectorAll('button').find(b => b.dataset.focusKey === 'ack:queen:seen').fire('click');
  assert.equal(f.sent.at(-1).rev, 2);
});

test('a hive-wide topic with 35 related beads keeps three chips and expands without replacing messages', async t => {
  const f = fixture(t);
  const { renderRelatedBeads } = await import('./conversation.js');
  const related = { ids: new Set(Array.from({ length: 35 }, (_, i) => `hive-${i}`)), el: document.createElement('div') };
  const located = [];
  const chip = id => {
    const el = document.createElement('button');
    el.textContent = id;
    el.addEventListener('click', () => located.push(id));
    return el;
  };
  const topic = { id: 'wide', title: 'Hive-wide', retained: 1 };
  f.cell.threads = [topic];
  f.cell.messages = [{ id: 'message', threadId: topic.id, author: 'human', text: 'Readable message', at: 1 }];
  f.ui.setAllTopics(f.cell.id, true);
  f.ui.openThreadFor(f.cell.id, topic.id);
  const out = f.draw(), message = out.list.firstChild;
  out.list.scrollTop = 150;
  renderRelatedBeads(related, chip);
  const row = related.el.querySelector('.hive-related-summary');
  const panel = related.el.querySelector('.hive-related-overflow');
  const toggle = related.el.querySelector('.hive-related-toggle');
  assert.equal(row.querySelectorAll('button').length, 4);
  assert.equal(toggle.textContent, '+32 more');
  assert.equal(toggle.attributes['aria-expanded'], 'false');
  assert.equal(panel.hidden, true);
  toggle.fire('click', { stopPropagation() {} });
  assert.equal(toggle.attributes['aria-expanded'], 'true');
  assert.equal(panel.hidden, false);
  assert.equal(panel.querySelectorAll('button').length, 32);
  panel.querySelectorAll('button').at(-1).fire('click', { stopPropagation() {} });
  assert.deepEqual(located, ['hive-34']);
  panel.fire('keydown', { key: 'Escape', stopPropagation() {} });
  assert.equal(panel.hidden, true);
  assert.equal(document.activeElement, toggle);
  toggle.fire('click', { stopPropagation() {} });
  toggle.fire('click', { stopPropagation() {} });
  assert.equal(panel.hidden, true);
  assert.equal(out.list.firstChild, message);
  assert.equal(out.list.scrollTop, 150);
  assert.match(message.textContent, /Readable message/);
  related.ids = new Set(['hive-1', 'hive-2']);
  renderRelatedBeads(related, chip);
  assert.equal(related.el.querySelector('.hive-related-toggle'), null);
  assert.equal(related.el.querySelectorAll('button').length, 2);
});

for (const count of [0, 1, 3]) test(`related beads keep the existing short display for ${count} beads`, async t => {
  fixture(t);
  const { renderRelatedBeads } = await import('./conversation.js');
  const related = { ids: new Set(Array.from({ length: count }, (_, i) => `hive-${i}`)), el: document.createElement('div') };
  renderRelatedBeads(related, id => { const chip = document.createElement('button'); chip.textContent = id; return chip; });
  assert.equal(related.el.querySelector('.hive-related-toggle'), null);
  assert.equal(related.el.querySelectorAll('button').length, count);
  if (!count) assert.match(related.el.textContent, /No related beads/);
});

test('related-bead redraw closes the disclosure and keeps keyboard focus usable', async t => {
  fixture(t);
  const { renderRelatedBeads } = await import('./conversation.js');
  const related = { ids: new Set(['one', 'two', 'three', 'four']), el: document.createElement('div') };
  const chip = id => { const el = document.createElement('button'); el.textContent = id; return el; };
  renderRelatedBeads(related, chip);
  let toggle = related.el.querySelector('.hive-related-toggle');
  toggle.fire('click', { stopPropagation() {} });
  assert.equal(document.activeElement, toggle);
  related.el.querySelector('.hive-related-overflow').querySelector('button').focus();
  renderRelatedBeads(related, chip);
  toggle = related.el.querySelector('.hive-related-toggle');
  assert.equal(related.el.querySelector('.hive-related-overflow').hidden, true);
  assert.equal(document.activeElement, toggle);
  let stopped = false;
  related.el.querySelector('.hive-related-disclosure').fire('click', { stopPropagation() { stopped = true; } });
  assert.equal(stopped, true);
});

const withdrawBtn = (root, label) => root.querySelectorAll('button').filter((b) => b.textContent === label);

test('Waiting for queen offers Withdraw on each row, sends it, and offers Undo for the withdrawn message', (t) => {
  const f = busyInbox(t);
  f.ui.setInboxView(f.cell.id, 'queen');
  let out = f.draw();
  const [row] = withdrawBtn(out.list, 'Withdraw');
  row.fire('click');
  assert.deepEqual(f.sent.at(-1), { type: 'hive-withdraw', cellId: f.cell.id, messageId: 'h2' });
  f.cell.messages = f.cell.messages.map((m) => (m.id === 'h2' ? { ...m, response: { required: true, answers: [], withdrawn: { by: 'aw:human', at: 1 } } } : m));
  f.cell.inbox.queen = { count: 1, ids: ['h1'], rev: 2 };
  f.replies.at(-1).onReply({ ok: true });
  out = f.draw();
  const [undo] = withdrawBtn(out.list, 'Undo');
  assert.ok(undo);
  assert.ok(out.list.textContent.includes('Withdrawn: h2'));
  undo.fire('click');
  assert.deepEqual(f.sent.at(-1), { type: 'hive-withdraw-undo', cellId: f.cell.id, messageId: 'h2' });
  f.replies.at(-1).onReply({ ok: true });
  assert.equal(withdrawBtn(f.draw().list, 'Undo').length, 0);
});

test('a message waiting for the queen has Withdraw in the conversation; withdrawn it shows a muted state with Undo', (t) => {
  const f = busyInbox(t);
  f.ui.setInboxView(f.cell.id, null);
  f.ui.openThreadFor(f.cell.id, thr, f.cell.threads[0]);
  const open = () => { f.cell.inbox.queen = { count: 2, ids: ['h1', 'h2'], rev: 1 }; return f.draw(); };
  let out = open();
  const inTopic = out.list.querySelectorAll('li').filter((li) => li.dataset?.id === 'h1');
  assert.equal(inTopic.length, 1);
  assert.equal(withdrawBtn(inTopic[0], 'Withdraw').length, 1);
  f.cell.messages = f.cell.messages.map((m) => (m.id === 'h1' ? { ...m, response: { required: true, answers: [], withdrawn: { by: 'aw:human', at: 1 } } } : m));
  out = open();
  const after = out.list.querySelectorAll('li').find((li) => li.dataset?.id === 'h1');
  assert.ok(after.textContent.includes('Withdrawn'));
  assert.equal(withdrawBtn(after, 'Undo').length, 1);
  assert.equal(withdrawBtn(after, 'Withdraw').length, 0);
});

test('a withdrawn message offers no Send to queen or Send again, and the list\'s Undo line goes once it is not withdrawn', (t) => {
  const f = busyInbox(t);
  const mark = (state) => { f.cell.messages = f.cell.messages.map((m) => (m.id === 'h2' ? { ...m, delivery: { state, attempts: [{ at: 1 }] }, response: { required: true, answers: [], ...(state === 'failed' || state === 'uncertain' ? { withdrawn: { by: 'aw:human', at: 1 } } : {}) } } : m)); };
  f.ui.openThreadFor(f.cell.id, thr, f.cell.threads[0]);
  for (const state of ['failed', 'uncertain']) {
    mark(state);
    const li = f.draw().list.querySelectorAll('li').find((x) => x.dataset?.id === 'h2');
    for (const label of ['Send to queen', 'Queen has it', 'Send again…']) assert.equal(withdrawBtn(li, label).length, 0, `${state} ${label}`);
    assert.equal(withdrawBtn(li, 'Undo').length, 1);
  }
  f.ui.setInboxView(f.cell.id, 'queen');
  f.ui.setForm(`withdrawn:${f.cell.id}`, { id: 'h2', text: 'h2' });
  f.cell.messages = f.cell.messages.map((m) => (m.id === 'h2' ? { ...m, response: { required: true, answers: [] } } : m));
  assert.ok(!f.draw().list.textContent.includes('Withdrawn: h2'));
});
