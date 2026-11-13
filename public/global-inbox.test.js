import test from 'node:test';
import assert from 'node:assert/strict';
import { createUi } from './client.js';
import { inboxRows, needsRows, messageRows } from './global-inbox.js';
import { parseHiveLink } from './deep-links.js';

const request = (id, over = {}) => ({ id, audience: 'human', state: 'open', title: `Request ${id}`, body: 'Pick one', createdAt: 10, threadId: `t_${id}`, messageId: `m_${id}`, requesterSessionId: 's1', ...over });
const cell = (id, over = {}) => ({ id, taskId: `task_${id}`, enabled: true, rootBeadId: 'b', threads: [], messages: [], requests: {}, inbox: { human: { ids: [], count: 0 }, queen: { ids: [], count: 0 } }, ...over });
const ctx = (cells) => ({ hive: { cells: Object.fromEntries(cells.map(c => [c.id, c])), metaEpoch: 'e' }, graph: { sessions: [{ sessionId: 's1', name: 'Worker' }], tasks: { tasks: cells.map(c => ({ id: c.taskId, name: `Hive ${c.id}` })) } }, ui: createUi() });

test('needs rows span every live hive, open requests only, blocking first, with deep links', () => {
  const a = cell('a', { requests: { r1: request('r1', { createdAt: 30 }), r2: request('r2', { state: 'dismissed' }) } });
  const b = cell('b', { requests: { r3: request('r3', { createdAt: 20, blocking: true }), r4: request('r4', { audience: 'queen' }) } });
  const off = cell('c', { enabled: false, requests: { r5: request('r5') } });
  const rows = needsRows(ctx([a, b, off]), [a, b, off]);
  assert.deepEqual(needsRows(ctx([a, b, off]), [a, b]).map(r => r.key), ['request:r3', 'request:r1']);
  assert.deepEqual(rows.map(r => r.key), ['request:r3', 'request:r5', 'request:r1']);
  assert.deepEqual(parseHiveLink(rows[2].link), { cellId: 'a', threadId: 't_r1', messageId: 'm_r1' });
  assert.equal(rows[0].author, 'Worker');
  assert.equal(inboxRows(ctx([a]), [a], 'needs').length, 1);
});

test('settling a request removes it from the list', () => {
  const a = cell('a', { requests: { r1: request('r1') } });
  const c = ctx([a]);
  assert.equal(needsRows(c, [a]).length, 1);
  a.requests.r1 = request('r1', { state: 'answered', delivery: { state: 'delivered' } });
  assert.equal(needsRows(c, [a]).length, 0);
});

test('message rows group waiting messages by topic across hives', () => {
  const msg = (id, threadId, at, ack) => ({ id, threadId, at, author: 'session', sessionId: 's1', text: `text ${id}`, ack });
  const waiting = { required: true, rev: 1, state: null };
  const a = cell('a', {
    threads: [{ id: 't1', title: 'First topic' }],
    messages: [msg('m1', 't1', 5, waiting), msg('m2', 't1', 6, waiting), msg('m3', 't1', 7, { required: true, rev: 2, state: {} })],
    inbox: { human: { ids: ['m1', 'm2', 'm3'], count: 2, rev: 1 }, queen: { ids: [], count: 0 } },
  });
  const b = cell('b', { threads: [{ id: 't9', title: 'Other' }], messages: [msg('m9', 't9', 1, waiting)], inbox: { human: { ids: ['m9'], count: 1, rev: 1 }, queen: { ids: [], count: 0 } } });
  const rows = messageRows(ctx([a, b]), [a, b], 'human');
  assert.deepEqual(rows.map(r => [r.cellId, r.title, r.count]), [['b', 'Other', 1], ['a', 'First topic', 2]]);
  assert.deepEqual(parseHiveLink(rows[1].link), { cellId: 'a', threadId: 't1', messageId: 'm1' });
  assert.deepEqual(messageRows(ctx([a, b]), [a, b], 'queen'), []);
});

test('the global inbox defaults to Needs you', () => {
  const ui = createUi();
  assert.equal(ui.globalInboxView(), 'needs');
  ui.setGlobalInboxView('queen');
  assert.equal(ui.globalInboxView(), 'queen');
  ui.setGlobalInboxView('nonsense');
  assert.equal(ui.globalInboxView(), 'needs');
});

test('rows past the first page are reported as more waiting in that hive', () => {
  const waiting = { required: true, rev: 1, state: null };
  const messages = Array.from({ length: 50 }, (_, i) => ({ id: `m${i}`, threadId: 't', at: i, author: 'session', sessionId: 's1', text: 'x', ack: waiting }));
  const e = cell('e', { threads: [{ id: 't', title: 'Big' }], messages, inbox: { human: { ids: messages.map(m => m.id), count: 60, more: true, rev: 1 }, queen: { ids: [], count: 0 } } });
  const rows = messageRows(ctx([e]), [e], 'human');
  assert.equal(rows.at(-1).more, 10);
  assert.equal(parseHiveLink(rows.at(-1).link).cellId, 'e');
});

test('message and needs rows carry the fields the search reads', () => {
  const waiting = { required: true, rev: 1, state: null };
  const a = cell('a', {
    threads: [{ id: 't1', title: 'Topic' }],
    messages: [{ id: 'm1', threadId: 't1', at: 5, author: 'session', sessionId: 's1', text: 'Body text', ack: waiting, context: { beadId: 'hive-9', title: null } }],
    inbox: { human: { ids: ['m1'], count: 1, rev: 1 }, queen: { ids: [], count: 0 } },
    requests: { r1: request('r1', { beadId: 'hive-7' }) },
  });
  const c = ctx([a]);
  const [row] = messageRows(c, [a], 'human');
  assert.deepEqual([row.texts, row.beadIds], [['Body text'], ['hive-9']]);
  assert.deepEqual(needsRows(c, [a])[0].beadIds, ['hive-7']);
});

test('searching spans hives and tabs, uses the server answer once it has arrived', async () => {
  const { searchedInbox } = await import('./global-inbox.js');
  const waiting = { required: true, rev: 1, state: null };
  const msg = (id, t, text, over = {}) => ({ id, threadId: t, at: 1, author: 'session', sessionId: 's1', text, ack: waiting, ...over });
  const a = cell('a', { threads: [{ id: 't1', title: 'Alpha' }], messages: [msg('m1', 't1', 'ship the Widget')], inbox: { human: { ids: ['m1'], count: 1, rev: 1 }, queen: { ids: [], count: 0 } } });
  const b = cell('b', { threads: [{ id: 't2', title: 'WIDGET plan' }], messages: [msg('m2', 't2', 'plan')], inbox: { human: { ids: ['m2'], count: 1, rev: 1 }, queen: { ids: [], count: 0 } }, requests: { r1: request('r1', { title: 'No match', body: 'x' }) } });
  const c = ctx([a, b]);
  const local = searchedInbox(c, [a, b], 'widget');
  assert.deepEqual(local.lists.human.map(r => [r.cellId, r.snippet]), [['a', 'ship the Widget'], ['b', null]]);
  assert.equal(local.lists.needs.length, 0);
  assert.equal(local.pending, false);
  const remoteState = { pending: false, failed: false, remote: { query: 'widget', human: [{ cellId: 'b', threadId: 't2', firstId: 'm2', title: 'Old', at: 2, count: 4, last: { author: 'human' }, snippet: 'widget', key: 'message:b:m2' }], queen: [] } };
  const remote = searchedInbox(c, [a, b], 'widget', remoteState);
  assert.deepEqual(remote.lists.human.map(r => [r.cellId, r.count, r.author]), [['b', 4, 'You']]);
  assert.equal(remote.pending, false);
  const failed = searchedInbox(c, [a, b], 'widget', { remote: null, failed: true });
  assert.equal(failed.failed, true);
  assert.equal(failed.lists.human.length, 2);
});
