import test from 'node:test';
import assert from 'node:assert/strict';
import client, { createUi } from './client.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function setup() {
  const sent = [];
  let reply;
  const values = new Map();
  client.register({ api: { storage: { get: k => values.get(k), set: (k, v) => values.set(k, v), remove: k => values.delete(k) }, send: frame => sent.push(frame) }, register() {}, onMessage(fn) { reply = fn; } });
  const ui = createUi();
  return { sent, ui, answer: (i, over = {}) => reply({ op: 'hive-inbox-search', requestId: sent[i].requestId, ok: true, human: [], queen: [], ...over }) };
}

test('whitespace-only edits keep the search scheduled and send it once', async () => {
  const { sent, ui } = setup();
  ui.setGlobalInboxQuery('widget');
  ui.askGlobalInboxSearch(['a'], '1');
  ui.setGlobalInboxQuery('widget ');
  ui.askGlobalInboxSearch(['a'], '1');
  ui.setGlobalInboxQuery(' widget ');
  ui.askGlobalInboxSearch(['a'], '1');
  ui.askGlobalInboxSearch(['a'], '1');
  await wait(260);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].query, 'widget');
  ui.askGlobalInboxSearch(['a'], '1');
  await wait(260);
  assert.equal(sent.length, 1);
});

test('remote results and failures belong to their own request key', async () => {
  const { sent, ui, answer } = setup();
  ui.setGlobalInboxQuery('widget');
  assert.equal(ui.askGlobalInboxSearch(['a'], '1').pending, true);
  await wait(260);
  answer(0, { human: [{ key: 'k' }] });
  let st = ui.askGlobalInboxSearch(['a'], '1');
  assert.deepEqual([st.remote?.human.length, st.pending, st.failed], [1, false, false]);
  st = ui.askGlobalInboxSearch(['a'], '2');
  assert.deepEqual([st.remote?.human.length, st.pending, st.failed], [1, true, false]);
  await wait(260);
  assert.equal(sent.length, 2);
  answer(1, { ok: false });
  st = ui.askGlobalInboxSearch(['a'], '2');
  assert.deepEqual([st.remote, st.pending, st.failed], [null, false, true]);
  ui.setGlobalInboxQuery('gadget');
  st = ui.askGlobalInboxSearch(['a'], '2');
  assert.deepEqual([st.remote, st.pending, st.failed], [null, true, false]);
  await wait(260);
  answer(1, { ok: true, human: [{ key: 'late' }] });
  st = ui.askGlobalInboxSearch(['a'], '2');
  assert.equal(st.remote, null);
  answer(2, { human: [{ key: 'g' }] });
  assert.equal(ui.askGlobalInboxSearch(['a'], '2').remote.human[0].key, 'g');
  ui.setGlobalInboxQuery('');
  assert.deepEqual(ui.askGlobalInboxSearch(['a'], '2'), { remote: null, pending: false, failed: false });
});

test('a new metadata epoch with identical counters refetches and drops the old epoch results', async () => {
  const { sent, ui, answer } = setup();
  ui.setGlobalInboxQuery('widget');
  ui.askGlobalInboxSearch(['a'], '1:1', 'e1');
  await wait(260);
  answer(0, { human: [{ key: 'old' }] });
  assert.equal(ui.askGlobalInboxSearch(['a'], '1:1', 'e1').remote.human[0].key, 'old');
  const st = ui.askGlobalInboxSearch(['a'], '1:1', 'e2');
  assert.deepEqual([st.remote, st.pending], [null, true]);
  await wait(260);
  assert.equal(sent.length, 2);
  answer(1, { ok: false });
  assert.equal(ui.askGlobalInboxSearch(['a'], '1:1', 'e2').failed, true);
  assert.equal(ui.askGlobalInboxSearch(['a'], '1:1', 'e3').failed, false);
  await wait(260);
  assert.equal(sent.length, 3);
});

test('a scheduled search is cancelled by choosing Needs you or leaving the panel', async () => {
  const { sent, ui } = setup();
  ui.setGlobalInboxQuery('widget');
  ui.setGlobalInboxView('human');
  ui.askGlobalInboxSearch(['a'], '1', 'e');
  ui.setGlobalInboxView('needs');
  await wait(260);
  assert.equal(sent.length, 0);
  ui.setGlobalInboxView('human');
  ui.askGlobalInboxSearch(['a'], '1', 'e');
  ui.cancelGlobalInboxSearch();
  await wait(260);
  assert.equal(sent.length, 0);
  ui.askGlobalInboxSearch(['a'], '1', 'e');
  await wait(260);
  assert.equal(sent.length, 1);
});

test('replies from an old epoch are ignored once a new epoch is seen, even before the replacement is sent', async () => {
  for (const ok of [true, false]) {
    const writes = [];
    const saved = { window: globalThis.window, sessionStorage: globalThis.sessionStorage };
    globalThis.window = { location: { hash: '#x' }, addEventListener() {}, removeEventListener() {} };
    globalThis.sessionStorage = { setItem: (k) => writes.push(k), getItem: () => null };
    const { sent, ui, answer } = setup();
    ui.setGlobalInboxQuery('widget');
    assert.ok(writes.length > 0, 'the navigation spy sees a real navigate');
    ui.askGlobalInboxSearch(['a'], '1:1', 'e1');
    await wait(260);
    assert.equal(sent.length, 1);
    ui.askGlobalInboxSearch(['a'], '1:1', 'e2');
    const before = writes.length;
    answer(0, { ok, human: [{ key: 'old' }] });
    assert.equal(writes.length, before, `ok=${ok}: an old-epoch reply must not navigate`);
    const st = ui.askGlobalInboxSearch(['a'], '1:1', 'e2');
    assert.deepEqual([st.remote, st.failed, st.pending], [null, false, true], `ok=${ok}`);
    await wait(260);
    assert.equal(sent.length, 2);
    Object.assign(globalThis, saved);
  }
});
