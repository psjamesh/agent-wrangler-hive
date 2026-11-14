import test from 'node:test';
import assert from 'node:assert/strict';
import client, { createUi } from '../public/client.js';
import { renderConversation } from '../public/conversation.js';
import { conversationEpoch } from '../public/view-state.js';
import { projectForGraph } from '../server/projection.js';
import { humanConversationDoc, inboxSlice, inboxPage, threadHistory, resolveDeepLink, threadIndex, threadSummary } from '../server/conversation.js';

class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.attributes = {}; this.dataset = {}; this.style = {}; this.value = ''; }
  get childNodes() { return this.children; }
  get lastChild() { return this.children.at(-1); }
  removeChild(node) { this.children.splice(this.children.indexOf(node), 1); return node; }
  setAttribute(key, value) { this.attributes[key] = value; }
  addEventListener() {}
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  insertBefore(node, before) { const old = this.children.indexOf(node); if (old >= 0) this.children.splice(old, 1); const i = this.children.indexOf(before); this.children.splice(i < 0 ? this.children.length : i, 0, node); }
  querySelectorAll(selector) { return this.children.filter(x => x instanceof Element).flatMap(x => [...((x.attributes.class || '').split(' ').includes(selector.slice(1)) ? [x] : []), ...x.querySelectorAll(selector)]); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  get textContent() { return this.children.map(x => x instanceof Element ? x.textContent : x).join(''); }
  set textContent(value) { this.children = [String(value)]; }
}

function fixture(t, messages) {
  const before = { document: globalThis.document, Node: globalThis.Node };
  globalThis.Node = Element;
  globalThis.document = { createElement: tag => new Element(tag), createTextNode: String, body: new Element('body') };
  t.after(() => Object.assign(globalThis, before));
  const values = new Map([['read:cell_test', JSON.stringify({ baseline: 0, threads: {} })]]);
  client.register({ api: { storage: { get: k => values.get(k), set: (k, v) => values.set(k, v), remove: k => values.delete(k) } }, register() {} });
  const ui = createUi();
  const cell = { id: 'cell_test', enabled: true, rootBeadId: 'hive-root', queenSessionId: 'queen', messages, requestCounts: { human: 2 } };
  const doc = { conversation: { [cell.id]: messages }, inbox: {} };
  const index = threadIndex(messages);
  cell.threads = [...index.keys()].map(id => threadSummary({ id, title: id, count: messages.filter(m => m.threadId === id).length }, index.get(id)));
  cell.inbox = { human: snapshot(messages), queen: inboxSlice(doc, cell.id, 'queen') };
  const hive = { metaEpoch: 'test', beads: {} };
  ui.setAllTopics(cell.id, true);
  const draw = view => {
    ui.setInboxView(cell.id, view);
    return renderConversation({ cell, hive, ui, graph: { sessions: [] }, api: {}, ctx: { busy: () => false, send() {}, notice() {} } });
  };
  const counts = view => {
    const out = draw(view);
    return { messages: Number(out.head.querySelector('.hive-inbox-totals').textContent.match(/(\d+) messages?/)[1]), badges: out.list.querySelectorAll('.hive-unread').map(x => Number(x.textContent)) };
  };
  return { cell, hive, ui, counts, draw, refresh: messages => { cell.inbox = { ...cell.inbox, human: snapshot(messages) }; } };
}

const inboxChips = counts => ({ ...counts, badges: counts.badges.filter(n => n > 1) });

const queen = (id, threadId = 'topic') => ({ id, threadId, author: 'session', sessionId: 'queen', role: 'queen', text: id, at: 100, n: 1, ack: { required: true, state: null, rev: 0 } });
const worker = (id, threadId = 'worker-topic') => ({ id, threadId, author: 'session', sessionId: 'worker', role: 'worker', text: id, at: 200, n: 2 });
const read = { required: true, state: { kind: 'read' }, rev: 1 };

for (const window of ['messages', 'previews']) test(`Inbox and topic badges count only queen obligations with ${window}`, t => {
  const f = fixture(t, [queen('q'), ...Array.from({ length: 5 }, (_, i) => worker(`w${i}`, `worker-topic-${i}`))]);
  if (window === 'previews') f.cell.messages = [f.cell.messages[0]];
  assert.deepEqual(f.counts(null), { messages: 1, badges: [1] });
  assert.deepEqual(f.counts('human'), inboxChips({ messages: 1, badges: [1] }));
});

for (const state of [{ kind: 'read' }, { kind: 'reaction', emoji: '👍' }, { kind: 'reply', replyId: 'human-reply' }]) test(`confirmed ${state.kind} and Undo update Inbox totals, rows and topic badges together`, t => {
  const f = fixture(t, [queen('q1'), { ...queen('q2'), n: 2 }, worker('w', 'topic')]);
  const check = n => {
    const expected = { messages: n, badges: n ? [n] : [] };
    assert.deepEqual(f.counts(null), expected);
    assert.deepEqual(f.counts('human'), inboxChips(expected));
  };
  check(2);
  f.ui.noteAck(f.cell.id, 'q1', { ...read, state });
  check(1);
  f.ui.noteAck(f.cell.id, 'q2', { ...read, state });
  check(0);
  f.ui.noteAck(f.cell.id, 'q2', { required: true, state: null, rev: 2 });
  check(1);
  for (const m of f.cell.messages) if (m.ack) m.ack = f.ui.ackOf(f.cell.id, m);
  f.refresh(f.cell.messages);
  const index = threadIndex(f.cell.messages);
  f.cell.threads = f.cell.threads.map(t => threadSummary(t, index.get(t.id)));
  check(1);
});

test('an acknowledged unprojected queen preview cannot keep an unread badge', t => {
  const f = fixture(t, [queen('q')]);
  f.cell.messages = [];
  f.ui.noteAck(f.cell.id, 'q', read);
  assert.deepEqual(f.counts(null), { messages: 0, badges: [] });
});

test('acknowledging a later Inbox page updates the matching topic badge', t => {
  const q1 = queen('q1'), q2 = { ...queen('q2'), n: 2 }, w = worker('w', 'topic');
  const f = fixture(t, [q1, q2, w]);
  f.cell.messages = [q1, w];
  f.cell.inbox.human = { ...f.cell.inbox.human, ids: ['q1'], more: true, after: { id: 'q1', at: 100 } };
  f.ui.addInboxPage(f.cell.id, 'human', 'test', String(f.cell.inbox.human.rev), { ids: ['q2'], messages: [q2], threads: f.cell.threads, more: false });
  f.ui.noteAck(f.cell.id, 'q2', read);
  assert.deepEqual(f.counts(null), { messages: 1, badges: [1] });
  assert.deepEqual(f.counts('human'), inboxChips({ messages: 1, badges: [1] }));
  f.refresh([q1, { ...q2, ack: read }, w]);
  f.cell.threads[0].awaiting.human.count = 1;
  assert.deepEqual(f.counts(null), { messages: 1, badges: [1] });
  assert.deepEqual(f.counts('human'), inboxChips({ messages: 1, badges: [1] }));
});

for (const window of ['messages', 'previews']) test(`Undo after a refreshed settlement restores an Inbox row from ${window}`, t => {
  const q = { ...queen('q'), ack: read };
  const f = fixture(t, [q]);
  if (window === 'previews') f.cell.messages = [];
  assert.deepEqual(f.counts('human'), inboxChips({ messages: 0, badges: [] }));
  f.ui.noteAck(f.cell.id, 'q', { required: true, state: null, rev: 2 });
  assert.deepEqual(f.counts('human'), inboxChips({ messages: 1, badges: [1] }));
  assert.deepEqual(f.counts(null), { messages: 1, badges: [1] });
});

test('settling an older-topic preview updates the header with the badge', t => {
  const first = Array.from({ length: 50 }, (_, i) => ({ ...queen(`first${i}`, 'main'), at: i + 1, n: i + 1 }));
  const q = { ...queen('q', 'older'), at: 1000 };
  const f = fixture(t, [...first, q]);
  const older = f.cell.threads.find(x => x.id === 'older');
  f.ui.addOlderTopics(f.cell.id, 'test', [older], false, null);
  f.cell.threads = f.cell.threads.filter(x => x.id !== 'older');
  f.cell.messages = first;
  assert.equal(f.cell.inbox.human.ids.length, 50);
  assert.equal(f.cell.inbox.human.ids.includes('q'), false);
  assert.equal(f.counts(null).messages, 51);
  f.ui.noteAck(f.cell.id, 'q', read);
  const got = f.counts(null);
  assert.equal(got.badges.reduce((a, b) => a + b, 0), 50);
  assert.equal(got.messages, 50);
  f.refresh([...first, { ...q, ack: read }]);
  assert.equal(f.counts(null).messages, 50);
  f.ui.noteAck(f.cell.id, 'q', { required: true, state: null, rev: 2 });
  assert.equal(f.counts(null).messages, 51);
  assert.equal(f.counts(null).badges.reduce((a, b) => a + b, 0), 51);
  assert.ok(f.draw('human').list.children.some(li => li.dataset?.id === 'q'));
  f.refresh([...first, { ...q, ack: { required: true, state: null, rev: 2 } }]);
  assert.equal(f.counts(null).messages, 51);
  assert.equal(f.counts(null).badges.reduce((a, b) => a + b, 0), 51);
});

for (const source of ['manual', 'auto-read']) test(`${source} acknowledgement deltas use the exact Inbox snapshot`, t => {
  const q = queen('q', 'older');
  const other = queen('other', 'current');
  const f = fixture(t, [other, q]);
  f.ui.addOlderTopics(f.cell.id, 'test', f.cell.threads, false, null);
  f.cell.threads = f.cell.threads.filter(t => t.id === 'current');
  f.cell.messages = f.cell.messages.filter(m => m.id === 'other');
  assert.equal(f.counts(null).messages, 2);
  const settled = snapshot([other, { ...q, ack: read }]);
  if (source === 'manual') f.ui.noteAck(f.cell.id, 'q', read, [], settled.rev);
  else f.ui.noteReadBatch(f.cell.id, [{ messageId: 'q', ack: read }], settled.rev);
  assert.equal(f.counts(null).messages, 1);
  const fresh = { ...q, ack: read };
  f.ui.addOlderTopics(f.cell.id, 'test', [threadSummary({ id: q.threadId, title: 'older', count: 1 }, threadIndex([fresh]).get(q.threadId))], false, null);
  f.refresh([{ ...other, ack: { required: true, state: null, rev: 2 } }, q]);
  assert.equal(f.counts(null).messages, 1);
  f.cell.inbox.human = settled;
  assert.equal(f.counts(null).messages, 1);
  assert.deepEqual(f.counts(null).badges, [1]);
});

test('a late acknowledgement reply cannot revert Undo while snapshots catch up', t => {
  const q = queen('q');
  const f = fixture(t, [q]);
  f.ui.addOlderTopics(f.cell.id, 'test', f.cell.threads, false, null);
  f.cell.threads = [];
  f.cell.messages = [];
  f.counts(null);
  const undone = { required: true, state: null, rev: 2 };
  f.ui.noteAck(f.cell.id, 'q', undone, [], snapshot([{ ...q, ack: undone }]).rev);
  f.ui.noteAck(f.cell.id, 'q', read, [], snapshot([{ ...q, ack: read }]).rev);
  assert.deepEqual(f.counts(null), { messages: 1, badges: [1] });
  f.refresh([{ ...q, ack: read }]);
  assert.deepEqual(f.counts(null), { messages: 1, badges: [1] });
  assert.deepEqual(f.counts('human'), inboxChips({ messages: 1, badges: [1] }));
  f.refresh([{ ...q, ack: undone }]);
  assert.deepEqual(f.counts(null), { messages: 1, badges: [1] });
});


function snapshot(messages) {
 const doc = { conversation: { cell_test: messages }, threads: { cell_test: Object.fromEntries([...new Set(messages.map(m => m.threadId))].map(id => [id, {id, title:id}])) } };
 const visible = humanConversationDoc(doc, 'cell_test');
 return inboxSlice(visible, 'cell_test', 'human');
}
for (const source of ['manual', 'auto-read']) test(`${source} confirmations use production hash revisions`, t => {
 const q = queen('q2');
 const f = fixture(t, [q]);
 f.cell.inbox.human = snapshot([q]);
 assert.equal(f.counts(null).messages, 1);
 const settled = {...q, ack:read};
 const after = snapshot([settled]);
 if(source === 'manual') f.ui.noteAck(f.cell.id, q.id, read, [], after.rev);
 else f.ui.noteReadBatch(f.cell.id, [{messageId:q.id, ack:read}], after.rev);
 const got = f.counts(null);
 assert.deepEqual(got, {messages:0,badges:[]});
});

test('multiple older topics stay consistent with production hash snapshots', t => {
 const first = Array.from({length:50}, (_,i)=>({...queen(`first${i}`, 'main'), at:i+1, n:i+1}));
 const extras = [queen('extra1','older1'), queen('extra2','older2')];
 const all = [...first,...extras];
 const f=fixture(t,all);
 f.cell.inbox.human=snapshot(all);
 f.ui.addOlderTopics(f.cell.id,'test',f.cell.threads.filter(x=>x.id!=='main'),false,null);
 f.cell.threads=f.cell.threads.filter(x=>x.id==='main'); f.cell.messages=first;
 f.counts(null);
 for(const q of extras) {
   q.ack=read;
   const after=snapshot(all);
   f.ui.noteAck(f.cell.id,q.id,read,[],after.rev);
   f.cell.inbox.human=after;
 }
 const got=f.counts(null);
 assert.equal(got.messages,50); assert.equal(got.badges.reduce((a,b)=>a+b,0),50);
 const fresh=fixture(t,all);
 fresh.cell.inbox.human=snapshot(all);
 assert.equal(fresh.counts(null).messages,50);
 assert.equal(fresh.counts(null).badges.reduce((a,b)=>a+b,0),50);
});

test('a fresh UI agrees with a settled production snapshot', t => {
 const all = Array.from({length:52}, (_,i)=>({...queen(`reload${i}`,`topic${i}`),ack:i>=50?read:queen('x').ack}));
 const f=fixture(t,all); f.cell.inbox.human=snapshot(all);
 assert.equal(f.counts(null).messages,50);
 assert.equal(f.counts(null).badges.reduce((a,b)=>a+b,0),50);
 assert.equal(f.draw('human').list.children.length,50);
});
test('Undo racing a late read agrees with production hash snapshots', t => {
 const q=queen('q2'); const f=fixture(t,[q]); f.cell.inbox.human=snapshot([q]); f.counts(null);
 const undone={required:true,state:null,rev:2};
 const settledRev=snapshot([{...q,ack:read}]).rev;
 const undoneRev=snapshot([{...q,ack:undone}]).rev;
 f.ui.noteAck(f.cell.id,q.id,undone,[],undoneRev);
 f.ui.noteReadBatch(f.cell.id,[{messageId:q.id,ack:read}],settledRev);
 f.cell.inbox.human=snapshot([{...q,ack:read}]);
 const got=f.counts(null);
 assert.deepEqual(got,{messages:1,badges:[1]});
});

test('a newer server acknowledgement wins over older confirmed reads and Undo', t => {
  const q = queen('q2');
  const f = fixture(t, [q]);
  f.ui.noteAck(f.cell.id, q.id, read);
  f.refresh([{ ...q, ack: { required: true, state: null, rev: 2 } }]);
  assert.deepEqual(f.counts(null), { messages: 1, badges: [1] });
  assert.deepEqual(f.counts('human'), inboxChips({ messages: 1, badges: [1] }));
  f.ui.noteAck(f.cell.id, q.id, { required: true, state: null, rev: 2 });
  f.refresh([{ ...q, ack: { ...read, rev: 3 } }]);
  assert.deepEqual(f.counts(null), { messages: 0, badges: [] });
  assert.deepEqual(f.counts('human'), inboxChips({ messages: 0, badges: [] }));
});

function production(messages) {
  const cell = { id: 'cell_test', rootBeadId: 'hive-root', enabled: true, queenSessionId: 'queen' };
  const threads = Object.fromEntries([...new Set(messages.map(m => m.threadId))].map(id => [id, { id, title: 'History topic', count: messages.filter(m => m.threadId === id).length, lastAt: messages.filter(m => m.threadId === id).at(-1)?.at }]));
  const doc = { cells: { [cell.id]: cell }, conversation: { [cell.id]: messages }, threads: { [cell.id]: threads }, inbox: {}, bindings: {}, beadLayout: {}, arrangeAspect: {}, restoreNotices: {}, operations: {}, launches: {}, requests: {} };
  const rt = { metadata: { read: () => doc, cell: id => doc.cells[id], cells: () => Object.values(doc.cells) }, beads: { status: { state: 'missing' } }, paths: {} };
  return { rt, cell: projectForGraph({ runtime: rt, snapshot: { graph: { beads: {}, edges: [] } } }).cells[cell.id] };
}

for (const source of ['window', 'history', 'deep-link', 'inbox']) for (const mode of ['manual', 'auto-read']) test(`${mode} read from ${source} survives closing an unprojected message`, t => {
  const tid = 'thr_000000000001';
  const all = [...Array.from({ length: 52 }, (_, i) => ({ ...queen(`q${i + 1}`, tid), at: i + 1, n: i + 1 })), ...Array.from({ length: 45 }, (_, i) => ({ ...worker(`w${i}`, tid), at: i + 53, n: i + 53 }))];
  const p = production(all), f = fixture(t, all), q = all[50];
  if (source === 'window') {
    Object.assign(f.cell, production(all.slice(0, 52)).cell);
    f.counts(null);
  }
  Object.assign(f.cell, p.cell);
  assert.equal(f.cell.messages.some(m => m.id === q.id), false);
  assert.equal(f.cell.inbox.human.ids.includes(q.id), false);
  assert.notEqual(f.cell.threads[0].preview.id, q.id);
  f.counts(null);
  const epoch = conversationEpoch('test', f.cell.conversationRevision);
  if (source === 'deep-link') f.ui.openDeepLink(resolveDeepLink(p.rt, { cellId: f.cell.id, threadId: tid, messageId: q.id }), 'test');
  else if (source === 'history') {
    f.ui.openThreadFor(f.cell.id, tid, f.cell.threads[0]);
    const page = threadHistory(p.rt, { cellId: f.cell.id, threadId: tid, before: all[51].id, limit: 1 });
    f.ui.addHistory(f.cell.id, tid, epoch, page, page.anchorN);
  } else if (source === 'inbox') {
    const page = inboxPage(p.rt, { cellId: f.cell.id, awaiting: 'human', after: f.cell.inbox.human.after });
    f.ui.addInboxPage(f.cell.id, 'human', epoch, String(f.cell.inbox.human.rev), page);
  }
  if (mode === 'manual') f.ui.noteAck(f.cell.id, q.id, read);
  else f.ui.noteReadBatch(f.cell.id, [{ messageId: q.id, ack: read }]);
  f.ui.closeThread(f.cell.id);
  assert.deepEqual(f.counts(null), { messages: 51, badges: [51] });
  f.refresh(all.map(m => m.id === q.id ? { ...m, ack: read } : m));
  assert.deepEqual(f.counts(null), { messages: 51, badges: [51] });
});

for (const source of ['history', 'deep-link']) test(`Undo from ${source} retains the row and clears on an audience change`, t => {
  const tid = 'thr_000000000001';
  const q = { ...queen('old', tid), ack: read, text: 'History-only canary', at: 1, n: 1 };
  const all = [q, ...Array.from({ length: 45 }, (_, i) => ({ ...worker(`w${i}`, tid), at: i + 2, n: i + 2 }))];
  const p = production(all), f = fixture(t, all);
  Object.assign(f.cell, p.cell);
  assert.equal(f.cell.messages.some(m => m.id === q.id), false);
  f.counts(null);
  if (source === 'deep-link') f.ui.openDeepLink(resolveDeepLink(p.rt, { cellId: f.cell.id, threadId: tid, messageId: q.id }), 'test');
  else {
    f.ui.openThreadFor(f.cell.id, tid, f.cell.threads[0]);
    const page = threadHistory(p.rt, { cellId: f.cell.id, threadId: tid, before: all[1].id, limit: 1 });
    f.ui.addHistory(f.cell.id, tid, conversationEpoch('test', f.cell.conversationRevision), page, page.anchorN);
  }
  f.ui.noteAck(f.cell.id, q.id, { required: true, state: null, rev: 2 });
  f.ui.closeThread(f.cell.id);
  assert.deepEqual(f.counts(null), { messages: 1, badges: [1] });
  assert.deepEqual(f.counts('human'), inboxChips({ messages: 1, badges: [1] }));
  assert.match(f.draw('human').list.textContent, /History-only canary/);
  Object.assign(f.cell, production([]).cell);
  assert.deepEqual(f.counts(null), { messages: 0, badges: [] });
  assert.doesNotMatch(f.draw('human').list.textContent, /History-only canary/);
});

test('a newer preview acknowledgement preserves full history metadata for Undo', t => {
  const tid = 'thr_000000000001';
  const q = { ...queen('old', tid), beadId: 'hive-work', at: 1, n: 1 };
  const workers = Array.from({ length: 45 }, (_, i) => ({ ...worker(`w${i}`, tid), at: i + 2, n: i + 2 }));
  const p = production([q, ...workers]), f = fixture(t, [q, ...workers]);
  Object.assign(f.cell, p.cell);
  f.hive.beads['hive-work'] = { id: 'hive-work', title: 'Work item', parentId: f.cell.rootBeadId };
  f.counts(null);
  f.ui.openThreadFor(f.cell.id, tid, f.cell.threads[0]);
  const page = threadHistory(p.rt, { cellId: f.cell.id, threadId: tid, before: workers[0].id, limit: 1 });
  const epoch = conversationEpoch('test', f.cell.conversationRevision);
  f.ui.addHistory(f.cell.id, tid, epoch, page, page.anchorN);
  f.ui.noteAck(f.cell.id, q.id, read);
  const settled = { ...q, ack: read };
  f.refresh([settled, ...workers]);
  f.ui.addOlderTopics(f.cell.id, epoch, production([settled]).cell.threads, false, null);
  f.ui.noteAck(f.cell.id, q.id, { required: true, state: null, rev: 2 });
  f.ui.closeThread(f.cell.id);
  const row = f.draw('human').list;
  assert.equal(row.querySelector('.hive-topic-context'), null);
  assert.equal(f.ui.acknowledgedConversation(f.cell.id).messages.find(m => m.id === q.id).beadId, 'hive-work');
  assert.deepEqual(f.counts('human'), inboxChips({ messages: 1, badges: [1] }));
});

for (const state of ['open', 'answered', 'resolved']) for (const legacy of [false, true]) test(`native ${state} card ${legacy ? 'with legacy ack' : 'without ack'} stays out of unread message counts`, t => {
  const card = { ...queen('card', 'request-topic'), requestId: 'hreq_000000000001' };
  if (!legacy) delete card.ack;
  const request = { id: card.requestId, cellId: 'cell_test', messageId: card.id, threadId: card.threadId, title: 'Approve?', body: 'Approve the change?', audience: 'human', state, delivery: { state: 'delivered' } };
  const doc = { requests: { [request.id]: request }, conversation: { cell_test: [card, queen('ordinary')] }, threads: { cell_test: {} } };
  const baseline = inboxSlice(doc, 'cell_test', 'human').acknowledgements;
  assert.deepEqual(baseline[card.id], legacy ? { rev: 0, waiting: false, threadId: card.threadId } : undefined);
  assert.equal(baseline.ordinary.waiting, true);
  const projected = humanConversationDoc(doc, 'cell_test');
  assert.equal(inboxSlice(projected, 'cell_test', 'human').acknowledgements[card.id], undefined);
  const f = fixture(t, projected.conversation.cell_test);
  f.cell.requests = projected.requests;
  f.cell.requestCounts.human = state === 'open' ? 1 : 0;
  const expected = { messages: 1, badges: [1] };
  assert.deepEqual(f.counts(null), { ...expected, badges: state === 'open' ? [1, 1] : [1] });
  const requestBadges = f.draw(null).list.querySelectorAll('.is-needs-you');
  assert.equal(requestBadges.length, state === 'open' ? 1 : 0);
  if (requestBadges.length) assert.equal(requestBadges[0].attributes['aria-label'], '1 request waiting for you');
  assert.deepEqual(f.counts('human'), inboxChips(expected));
  assert.deepEqual(inboxSlice(doc, 'cell_test', 'human').ids, ['ordinary']);
  assert.equal(f.draw('human').list.children.filter(x => x.dataset?.id).length, state === 'open' ? 2 : 1);
  assert.equal(f.draw('needs').list.querySelectorAll('.hive-needs-count').length, state === 'open' ? 1 : 0);
  assert.equal(doc.conversation.cell_test[1].ack.state, null);
});
