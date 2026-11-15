import test from 'node:test';
import assert from 'node:assert/strict';
import { setReviewPolicy, reviewPolicy, chooseReviewer } from '../server/review-policy.js';
import { createManifest } from '../server/manifest.js';
import { RuntimeLifetime } from '../server/lifetime.js';

const catalog = () => [
  { id: 'claude', label: 'Claude', available: true, models: [{ value: 'opus', label: 'Opus', default: true, efforts: ['medium', 'high'], autoEffort: 'high' }], efforts: [{ value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' }] },
  { id: 'codex', label: 'Codex', available: true, models: [{ value: 'gpt-6.1-sol', default: true, efforts: ['medium'] }] },
  { id: 'simple', available: true, models: [{ value: 'auto', default: true, efforts: [] }] },
];
function fixture() {
  let doc = { cells: { c: { id: 'c' } } }, calls = 0, changes = 0;
  const agents = catalog();
  const rt = { metadata: { lifetime: new RuntimeLifetime(), cell: id => doc.cells[id], mutate: fn => { const next = structuredClone(doc); fn(next); doc = next; } }, projection: () => ({}), changed: () => { changes++; } };
  const host = { sessions: { list: () => [] }, agents: { list: async () => { calls++; return structuredClone(agents); } }, stores: { hive: rt } };
  rt.host = host;
  return { rt, host, agents, cell: () => doc.cells.c, calls: () => calls, changes: () => changes };
}
const save = (f, primary) => setReviewPolicy(f.rt, { cellId: 'c', policy: { primary } });
const valid = { agent: 'claude', model: 'opus', effort: 'high' };

test('existing graph path exposes host agent labels, model defaults and efforts after async read', async () => {
  const f = fixture(), manifest = createManifest({ dir: '.' });
  assert.equal(manifest.graph({ host: f.host }).hive.agents, null);
  await new Promise(resolve => setImmediate(resolve));
  const graph = manifest.graph({ host: f.host });
  assert.deepEqual(graph.hive.agents, f.agents);
  assert.equal(f.changes(), 1);
  assert.equal(f.calls(), 1, 'graph ticks share the cached catalogue');
});

test('save reads a fresh catalogue and persists supported values including empty effort', async () => {
  const f = fixture();
  await save(f, valid);
  assert.deepEqual(reviewPolicy(f.cell()).primary, valid);
  await save(f, { agent: 'simple', model: 'auto', effort: '' });
  assert.equal(reviewPolicy(f.cell()).primary.effort, '');
  assert.equal(f.calls(), 2);
});

for (const [field, value, message] of [['agent', 'missing', /agent is not installed/], ['model', 'missing', /model is not installed/], ['effort', 'ultra', /effort is not supported/]]) test(`server refuses an unlisted ${field} without writing`, async () => {
  const f = fixture();
  await assert.rejects(save(f, { ...valid, [field]: value }), message);
  assert.equal(f.cell().reviewPolicy, undefined);
});

test('server refuses unavailable agents, stale retained slots, and unsupported per-model efforts', async () => {
  const f = fixture();
  f.agents[0].available = false;
  await assert.rejects(save(f, valid), /agent is unavailable/);
  f.agents[0].available = true;
  f.agents[0].models[0].efforts = ['medium'];
  await assert.rejects(save(f, valid), /effort is not supported/);
  f.agents.pop(); f.agents.pop();
  f.cell().reviewPolicy = { secondary: { agent: 'codex', model: 'gpt-6.1-sol', effort: 'medium' } };
  await assert.rejects(save(f, { ...valid, effort: 'medium' }), /secondary reviewer agent is not installed/);
  assert.equal(f.cell().reviewPolicy.primary, undefined);
});

test('catalogue failures fail closed on graph and save; a retired runtime cannot save after awaiting host', async () => {
  const f = fixture();
  f.host.agents.list = async () => { throw new Error('offline'); };
  await assert.rejects(save(f, valid), /could not be read/);
  const manifest = createManifest({ dir: '.' });
  manifest.graph({ host: f.host });
  await new Promise(resolve => setImmediate(resolve));
  assert.match(manifest.graph({ host: f.host }).hive.agentsError, /could not be read/);
  f.host.agents.list = async () => { f.rt.metadata.lifetime.stop(); return f.agents; };
  await assert.rejects(save(f, valid), /retired/);
  assert.equal(f.cell().reviewPolicy, undefined);
});

for (const problem of ['agent', 'model', 'effort', 'unavailable']) test(`a missing pinned ${problem} falls back to installed host defaults and keeps the saved pin`, () => {
  const agents = catalog();
  const pin = { agent: 'codex', model: 'gpt-6.1-sol', effort: 'medium' };
  if (problem === 'unavailable') agents[1].available = false;
  else pin[problem] = 'removed';
  const cell = { reviewPolicy: { secondary: pin } };
  const before = structuredClone(cell);
  const chosen = chooseReviewer(cell, 'claude', agents);
  assert.equal(chosen.config.agent, problem === 'unavailable' ? 'simple' : 'codex');
  assert.equal(chosen.sameProvider, false);
  assert.deepEqual(chosen.fallback.pinned, pin);
  assert.match(chosen.fallback.reason, /Automatic host defaults/);
  assert.deepEqual(cell, before);
});

test('fallback refuses an empty catalogue and bans Terra, and records same-provider when necessary', () => {
  const cell = { reviewPolicy: { primary: { agent: 'missing', model: 'old', effort: 'high' } } };
  assert.throws(() => chooseReviewer(cell, 'codex', []), /No installed reviewer/);
  const agents = catalog().slice(0, 1);
  const chosen = chooseReviewer(cell, 'claude', agents);
  assert.equal(chosen.config.model, 'opus');
  assert.equal(chosen.config.effort, 'high');
  assert.equal(chosen.sameProvider, true);
  agents[0].models[0].resolved = 'gpt-6-terra';
  assert.throws(() => chooseReviewer(cell, 'claude', agents), /No installed reviewer/);
});

test('graph refresh reflects removed models without rewriting saved settings', async t => {
  const f = fixture(), manifest = createManifest({ dir: '.' });
  let now = 100000;
  t.mock.method(Date, 'now', () => now);
  manifest.graph({ host: f.host });
  await new Promise(resolve => setImmediate(resolve));
  f.agents[0].models = [];
  now += 60000;
  manifest.graph({ host: f.host });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(manifest.graph({ host: f.host }).hive.agents[0].models, []);
  assert.equal(f.calls(), 2);
});

test('graph refresh handles a rebuild failure without an unhandled rejection', async () => {
  const f = fixture(), logs = [];
  f.rt.changed = () => { throw new Error('rebuild unavailable'); };
  f.rt.log = message => logs.push(message);
  const manifest = createManifest({ dir: '.' });
  manifest.graph({ host: f.host });
  await new Promise(resolve => setImmediate(resolve));
  assert.match(logs[0], /rebuild unavailable/);
  assert.deepEqual(manifest.graph({ host: f.host }).hive.agents, f.agents);
});

test('automatic settings persist tiers and retain existing pins', async () => {
  const f = fixture();
  const secondary = { mode: 'pinned', agent: 'codex', model: 'gpt-6.1-sol', effort: 'medium' };
  f.cell().reviewPolicy = { secondary };
  await save(f, { ...valid, mode: 'automatic', minQuality: 75, maxUsd: 3 });
  assert.equal(f.cell().reviewPolicy.primary.mode, 'automatic');
  assert.equal(f.cell().reviewPolicy.primary.minQuality, 75);
  assert.equal(f.cell().reviewPolicy.primary.maxUsd, 3);
  assert.deepEqual(f.cell().reviewPolicy.secondary, secondary);
});

for (const tier of [{ minQuality: -1 }, { minQuality: 101 }, { minQuality: '70' }, { maxUsd: 0 }, { maxUsd: Infinity }]) test(`invalid automatic tier ${JSON.stringify(tier)} is refused`, async () => {
  const f = fixture();
  await assert.rejects(save(f, { ...valid, mode: 'automatic', ...tier }), /quality must be/);
  assert.equal(f.cell().reviewPolicy, undefined);
});

test('graph projects a refreshed front for the settings preview and caches concurrent reads', async () => {
  const f = fixture(), manifest = createManifest({ dir: '.' });
  const front = { read: '2026-11-01', front: [{ agent: 'claude', model: 'opus', effort: 'high', usd: 2, quality: 85 }] };
  let calls = 0;
  f.host.agents.front = async () => { calls++; return front; };
  manifest.graph({ host: f.host });
  manifest.graph({ host: f.host });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(manifest.graph({ host: f.host }).hive.reviewerFront, front);
  assert.equal(calls, 1);
});
