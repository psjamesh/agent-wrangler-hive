import test from 'node:test';
import assert from 'node:assert/strict';
import { createManifest } from '../server/manifest.js';
import pkg from '../package.json' with { type: 'json' };
import client, { send } from '../public/client.js';

test('Hive declares paired deck and board API 2 halves', () => {
  const manifest = createManifest({ dir: '.' });
  assert.equal(manifest.engines.wranglerApi, '^2.1.0');
  assert.equal(pkg.wranglerExtension.engines.wranglerApi, '^2.1.0');
  assert.ok(manifest.requires.includes('schema:zod'));
  assert.ok(pkg.wranglerExtension.requires.includes('schema:zod'));
  assert.equal(pkg.dependencies?.zod, undefined);
  assert.equal(manifest.boardApi, '^2.0.0');
  assert.deepEqual(manifest.board, { client: 'public/client.js', styles: 'public/styles.css' });
  assert.equal('client' in manifest, false);
  assert.equal('styles' in manifest, false);
});

test('the rail badge reads Hive state through its API, including before the first frame', () => {
  let view, own = null;
  client.register({ api: { state: () => own }, register(kind, value) { view = value; } });
  const graph = new Proxy({ sessions: [] }, { get(target, key) {
    assert.notEqual(key, 'hive', 'extension state must never be read from the legacy graph');
    return target[key];
  } });
  assert.equal(view.badge(graph), 0);
  own = { hive: { metadataError: 'unavailable' } };
  assert.equal(view.badge(graph), 0);
});

test('Hive requests consume deck action results and report transport errors', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const calls = [], replies = [];
  let result = { ok: true, data: { ok: true, bead: { id: 'a' } } };
  client.register({ api: { act: async (...args) => { calls.push(args); return result; } }, register() {} });
  send({ type: 'hive-bead-detail', beadId: 'a' }, { quiet: true, onReply: r => replies.push(r) });
  await Promise.resolve();
  assert.equal(calls[0][0], 'hive-bead-detail');
  assert.equal(calls[0][1].beadId, 'a');
  assert.deepEqual(replies[0].bead, { id: 'a' });
  result = { ok: false, error: { code: 'disconnected', message: 'Deck disconnected' } };
  send({ type: 'hive-bead-detail', beadId: 'b' }, { quiet: true, onReply: r => replies.push(r) });
  await Promise.resolve();
  assert.equal(replies[1].ok, false);
  assert.equal(replies[1].error, 'Deck disconnected');
});
