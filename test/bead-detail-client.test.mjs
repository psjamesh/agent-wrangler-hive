import test from 'node:test';
import assert from 'node:assert/strict';
import client, { createUi } from '../public/client.js';

function setup(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const saved = { document: globalThis.document, requestAnimationFrame: globalThis.requestAnimationFrame };
  globalThis.document = { visibilityState: 'hidden', addEventListener() {}, removeEventListener() {}, querySelector: () => null };
  globalThis.requestAnimationFrame = () => 1;
  t.after(() => Object.assign(globalThis, saved));
  const sent = [];
  let deliver;
  const values = new Map();
  client.register({ api: { storage: { get: k => values.get(k), set: (k, v) => values.set(k, v), remove: k => values.delete(k) }, send: frame => sent.push(frame) }, register() {}, onMessage: fn => { deliver = fn; } });
  const ui = createUi();
  const reply = (frame, extra) => deliver({ op: frame.type, requestId: frame.requestId, ok: true, ...extra });
  const flush = () => new Promise(resolve => queueMicrotask(resolve));
  return { ui, sent, reply, deliver: frame => deliver(frame), flush };
}

const bead = (id, extra = {}) => ({ id, status: 'open', updatedAt: 't1', ...extra });

test('detail loads once, shows the record, and refetches when the bead changes', async t => {
  const f = setup(t);
  const b = bead('a');
  assert.deepEqual(f.ui.beadDetail(b), { bead: null, loading: true, error: null });
  assert.deepEqual(f.ui.beadDetail(b), { bead: null, loading: true, error: null });
  await f.flush();
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].type, 'hive-bead-detail');
  assert.equal(f.sent[0].beadId, 'a');
  f.reply(f.sent[0], { bead: { id: 'a', goal: 'G' } });
  assert.deepEqual(f.ui.beadDetail(b), { bead: { id: 'a', goal: 'G' }, loading: false, error: null });
  await f.flush();
  assert.equal(f.sent.length, 1);
  for (const change of [{ updatedAt: 't2' }, { status: 'closed' }, { reviewState: 'requested' }]) {
    Object.assign(b, change);
    const shown = f.ui.beadDetail(b);
    assert.equal(shown.loading, true);
    assert.match(shown.bead.goal, /^G/);
    await f.flush();
    f.reply(f.sent.at(-1), { bead: { id: 'a', goal: `G ${f.sent.length}` } });
  }
  assert.equal(f.sent.length, 4);
});

test('a failed load keeps the old copy, is not retried until Retry or a change, and reads as a read', async t => {
  const f = setup(t);
  const b = bead('a');
  f.ui.beadDetail(b);
  await f.flush();
  f.reply(f.sent[0], { bead: { id: 'a', goal: 'G' } });
  b.updatedAt = 't2';
  f.ui.beadDetail(b);
  await f.flush();
  f.reply(f.sent[1], { ok: false, error: 'boom' });
  for (let i = 0; i < 3; i++) assert.deepEqual(f.ui.beadDetail(b), { bead: { id: 'a', goal: 'G' }, loading: false, error: 'boom' });
  await f.flush();
  assert.equal(f.sent.length, 2);
  f.ui.retryBeadDetail('a');
  assert.equal(f.ui.beadDetail(b).bead.goal, 'G');
  await f.flush();
  assert.equal(f.sent.length, 3);
  t.mock.timers.tick(30001);
  const failed = f.ui.beadDetail(b);
  assert.equal(failed.error, 'The server did not reply.');
  assert.equal(failed.bead.goal, 'G');
  b.updatedAt = 't3';
  f.ui.beadDetail(b);
  await f.flush();
  assert.equal(f.sent.length, 4);
});

test('a reply for an entry that has been replaced is dropped', async t => {
  const f = setup(t);
  const b = bead('a');
  f.ui.beadDetail(b);
  await f.flush();
  const first = f.sent[0];
  f.ui.retryBeadDetail('a');
  b.updatedAt = 't2';
  f.ui.beadDetail(b);
  await f.flush();
  const second = f.sent[1];
  f.reply(first, { bead: { id: 'a', goal: 'old' } });
  assert.equal(f.ui.beadDetail(b).bead, null);
  f.reply(second, { bead: { id: 'a', goal: 'new' } });
  assert.equal(f.ui.beadDetail(b).bead.goal, 'new');
});

test('the cache holds the 40 most recent beads', async t => {
  const f = setup(t);
  for (let i = 0; i < 41; i++) {
    f.ui.beadDetail(bead(`b${i}`));
    await f.flush();
    f.reply(f.sent.at(-1), { bead: { id: `b${i}` } });
  }
  assert.equal(f.sent.length, 41);
  assert.equal(f.ui.beadDetail(bead('b40')).loading, false);
  assert.equal(f.ui.beadDetail(bead('b1')).loading, false);
  assert.equal(f.sent.length, 41);
  assert.equal(f.ui.beadDetail(bead('b0')).loading, true);
  await f.flush();
  assert.equal(f.sent.length, 42);
});
