import test from 'node:test';
import assert from 'node:assert/strict';
import { searchInbox } from '../server/inbox-search.js';

const rt = (conversation, threads) => {
  const doc = { cells: {}, conversation, threads, inbox: { a: { rev: 1 }, b: { rev: 1 } } };
  return { metadata: { error: null, read: () => doc, cell: (id) => (['a', 'b'].includes(id) ? { id, enabled: true } : null) } };
};
const sm = (id, threadId, text, over = {}) => ({ id, threadId, at: 1, author: 'session', sessionId: 's1', text, ack: { required: true, rev: 1 }, ...over });
const hm = (id, threadId, text, over = {}) => ({ id, threadId, at: 2, author: 'human', text, response: { required: true, answers: [] }, ...over });

test('server search finds waiting messages past any loaded page, in every listed hive', () => {
  const many = Array.from({ length: 80 }, (_, i) => sm(`m${i}`, 'thr_000000000001', i === 79 ? 'the NEEDLE is last' : 'filler'));
  const runtime = rt(
    { a: many, b: [sm('x1', 'thr_000000000002', 'nothing', { beadId: 'hive-find' }), hm('h1', 'thr_000000000002', 'please Needle this'), sm('x2', 'thr_000000000003', 'answered', { ack: { required: true, rev: 1, state: { emoji: '👍' } } })] },
    { a: { thr_000000000001: { id: 'thr_000000000001', title: 'Big topic' } }, b: { thr_000000000002: { id: 'thr_000000000002', title: 'Second' }, thr_000000000003: { id: 'thr_000000000003', title: 'Needle answered' } } },
  );
  const out = searchInbox(runtime, { cellIds: ['a', 'b', 'missing'], query: 'needle' });
  assert.deepEqual(out.human.map(r => [r.cellId, r.title, r.count, r.firstId]), [['a', 'Big topic', 80, 'm0']]);
  assert.equal(out.human[0].snippet, 'the NEEDLE is last');
  assert.equal(out.human[0].preview, 'the NEEDLE is last');
  assert.deepEqual(out.queen.map(r => [r.cellId, r.title, r.last.author]), [['b', 'Second', 'human']]);
  assert.deepEqual(searchInbox(runtime, { cellIds: ['b'], query: 'HIVE-FIND' }).human.map(r => r.firstId), ['x1']);
  assert.deepEqual(searchInbox(runtime, { cellIds: ['b'], query: 'second' }).human.map(r => r.firstId), ['x1']);
});

test('server search ignores empty queries and unreadable metadata', () => {
  const runtime = rt({ a: [sm('m', 't', 'x')] }, {});
  assert.deepEqual(searchInbox(runtime, { cellIds: ['a'], query: '  ' }), { query: '  ', human: [], queen: [], truncated: false });
  runtime.metadata.error = 'broken';
  assert.equal(searchInbox(runtime, { cellIds: ['a'], query: 'x' }).human.length, 0);
});

import { audienceConversationDoc } from '../server/conversation.js';

test('the search view is built once per metadata version and cell', () => {
  let reads = 0;
  const doc = { cells: {}, conversation: { a: [sm('m1', 'thr_000000000001', 'needle')] }, threads: { a: { thr_000000000001: { id: 'thr_000000000001', title: 'T' } } }, inbox: { a: { rev: 1 } } };
  const store = { error: null, version: 1, read: () => { reads += 1; return doc; }, cell: (id) => ({ id, enabled: true }) };
  const runtime = { metadata: store };
  for (const q of ['needle', 'nee', 'needle t']) assert.equal(searchInbox(runtime, { cellIds: ['a'], query: q }).human.length, 1);
  assert.equal(reads, 1);
  store.version = 2;
  searchInbox(runtime, { cellIds: ['a'], query: 'needle' });
  assert.equal(reads, 2);
});

test('cell ids are validated, deduplicated and capped before any work', () => {
  const seen = [];
  const runtime = { metadata: { error: null, version: 1, read: () => ({ conversation: {}, threads: {}, inbox: {} }), cell: (id) => { seen.push(id); return null; } } };
  searchInbox(runtime, { cellIds: ['a', 'a', 'b'.repeat(81), 'bad id', 7, null, '../x'], query: 'x' });
  assert.deepEqual(seen, ['a']);
  seen.length = 0;
  searchInbox(runtime, { cellIds: Array.from({ length: 900 }, (_, i) => `c${i}`), query: 'x' });
  assert.equal(seen.length, 500);
});

test('building the visible view reads each message a bounded number of times however many topics there are', () => {
  const reads = (n) => {
    let count = 0;
    const list = Array.from({ length: n }, (_, i) => new Proxy(sm(`m${i}`, `thr_${String(i).padStart(12, '0')}`, `text ${i}`), { get(t, k) { if (k === 'threadId') count += 1; return t[k]; } }));
    const threads = Object.fromEntries(list.map((m) => [m.threadId, { id: m.threadId, title: `T${m.id}`, origin: 'agent', createdAt: 1, lastAt: 1 }]));
    audienceConversationDoc({ cells: {}, requests: {}, conversation: { a: list }, threads: { a: threads }, inbox: { a: { rev: 1 } } }, 'a');
    return count;
  };
  const small = reads(200), large = reads(2000);
  assert.ok(large <= small * 11, `reads grew ${small} -> ${large}`);
});
