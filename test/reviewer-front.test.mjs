import { readReviewerFront } from '../server/reviewer-front.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseReviewer, reviewPolicy } from '../server/review-policy.js';
import { resolveReviewPolicy } from '../server/reviews.js';

const agents = [
  { id: 'claude', available: true, models: [{ value: 'opus', efforts: ['medium'] }] },
  { id: 'codex', available: true, models: [{ value: 'sol', efforts: ['high'] }] },
];
const front = { read: '2026-11-01', front: [
  { agent: 'claude', model: 'opus', effort: 'medium', usd: 1, quality: 70, minutes: 5 },
  { agent: 'codex', model: 'sol', effort: 'high', usd: 2, quality: 85, minutes: 5 },
] };
const automatic = tier => ({ reviewPolicy: { primary: { mode: 'automatic', tier: 'cheapest', agent: 'claude', model: 'opus', effort: 'medium', ...tier }, secondary: { mode: 'automatic', tier: 'cheapest', agent: 'codex', model: 'sol', effort: 'high', ...tier } } });

test('new hives default to automatic while legacy and explicit pins remain pinned', () => {
  assert.equal(reviewPolicy({}).primary.mode, 'automatic');
  for (const mode of [undefined, 'pinned']) {
    const cell = { reviewPolicy: { primary: { mode, agent: 'claude', model: 'opus', effort: 'medium' } } };
    assert.equal(reviewPolicy(cell).primary.mode, undefined);
    assert.equal(chooseReviewer(cell, 'codex', agents, front).selection, undefined);
  }
});

test('automatic launch picks installed different-provider model and effort, recording benchmark and reason', () => {
  const policy = resolveReviewPolicy(automatic({ minQuality: 80, maxUsd: 2 }), 'claude', {}, true, agents, front);
  assert.equal(policy.agent, 'codex');
  assert.equal(policy.model, 'sol');
  assert.equal(policy.effort, 'high');
  assert.equal(policy.sameProvider, false);
  assert.equal(policy.selection.read, front.read);
  assert.match(policy.selection.reason, /Cheapest/);
});

test('tier thresholds and provider independence exclude front rows and preserve configured fallback', () => {
  for (const tier of [{ minQuality: 90 }, { maxUsd: 1 }]) {
    const chosen = chooseReviewer(automatic(tier), 'claude', agents, front);
    assert.equal(chosen.config.agent, 'codex');
    assert.match(chosen.selection.reason, /No eligible different-provider/);
    assert.equal(chosen.selection.pick, undefined);
  }
  const chosen = chooseReviewer(automatic({}), 'codex', agents, { ...front, front: [front.front[1]] });
  assert.equal(chosen.config.agent, 'claude');
  assert.equal(chosen.selection.pick, undefined);
});

test('automatic ignores stale, unavailable, unsupported and banned front models', () => {
  for (const mutate of [a => a[1].available = false, a => a[1].models[0].value = 'old', a => a[1].models[0].efforts = ['low'], a => a[1].models[0].resolved = 'gpt-6-terra']) {
    const catalog = structuredClone(agents); mutate(catalog);
    const chosen = chooseReviewer(automatic({}), 'claude', catalog, front);
    assert.equal(chosen.selection.pick, undefined);
  }
});

test('older and failing hosts degrade to configured policy with an explicit recorded reason', async () => {
  for (const host of [{}, { agents: { front: async () => { throw new Error('offline'); } } }, { agents: { front: async () => ({}) } }]) {
    const result = await readReviewerFront(host);
    const chosen = chooseReviewer(automatic({}), 'claude', agents, result);
    assert.equal(chosen.config.model, 'sol');
    assert.match(chosen.selection.reason, /Host model front/);
  }
});

test('host front deadlines release review launches even if the host never settles', async () => {
  const result = await readReviewerFront({ agents: { front: () => new Promise(() => {}) } }, { timeoutMs: 5 });
  assert.match(result.error, /within its deadline/);
});

import fs from 'node:fs';
const realistic = JSON.parse(fs.readFileSync(new URL('./fixtures/reviewer-front-2026-11-09.json', import.meta.url), 'utf8'));

test('Balanced default preserves review quality against the real 2026-11-09 host front', () => {
  for (const builder of ['claude', 'codex']) {
    const chosen = chooseReviewer({}, builder, realistic.agents, realistic);
    assert.notEqual(chosen.config.agent, builder);
    assert.ok(chosen.selection.pick.quality >= 55);
    assert.equal(chosen.selection.tier.name, 'balanced');
    assert.equal(chosen.selection.scope, 'global-front');
    assert.match(chosen.selection.limitation, /dominated by the builder/);
  }
});

test('Strongest maximizes quality within the cap; Cheapest honors a chosen floor', () => {
  const candidates = { ...front, front: [...front.front, { ...front.front[1], usd: 4, quality: 95 }] };
  const strongest = automatic({ tier: 'strongest', maxUsd: 4 });
  assert.equal(chooseReviewer(strongest, 'claude', agents, candidates).selection.pick.quality, 95);
  strongest.reviewPolicy.secondary.maxUsd = 3;
  assert.equal(chooseReviewer(strongest, 'claude', agents, candidates).selection.pick.quality, 85);
  const cheapest = automatic({ tier: 'cheapest', minQuality: 80 });
  assert.equal(chooseReviewer(cheapest, 'claude', agents, candidates).selection.pick.usd, 2);
});

test('a low cap on the real global front records both missing-point limits and fallback tier exception', () => {
  const chosen = chooseReviewer(automatic({ maxUsd: 1.2 }), 'codex', realistic.agents, realistic);
  assert.equal(chosen.selection.pick, undefined);
  assert.match(chosen.selection.reason, /global host front/);
  assert.match(chosen.selection.reason, /builder provider or Terra/);
  assert.match(chosen.selection.warning, /tier is not guaranteed/);
});

test('modern hosts compute each eligible front before tier selection, including resolved Terra aliases', async () => {
  const catalog = structuredClone(agents);
  catalog[1].models.push({ value: 'auto-terra', resolved: 'gpt-6-terra' });
  catalog.push({ id: 'offline', available: false, models: [] });
  const calls = [];
  const host = { version: '1.94.0', agents: { front: async options => {
    calls.push(options);
    return { read: front.read, front: [{ ...front.front[1], usd: 0.5 }] };
  } } };
  const result = await readReviewerFront(host, { agents: catalog, builderAgent: 'claude' });
  assert.deepEqual(calls, [{ agents: ['codex'], excludeModels: ['auto-terra'] }]);
  const chosen = chooseReviewer(automatic({ maxUsd: 1 }), 'claude', catalog, result);
  assert.equal(chosen.selection.pick.usd, 0.5);
  assert.equal(chosen.selection.scope, 'eligible-front');
  assert.equal(chosen.selection.limitation, undefined);
});

test('older hosts keep unrestricted front reads and the documented post-filter limitation', async () => {
  const calls = [];
  const host = { version: '1.93.0', agents: { front: async (...args) => { calls.push(args); return front; } } };
  const result = await readReviewerFront(host, { agents, builderAgent: 'claude' });
  assert.deepEqual(calls, [[]]);
  assert.equal(chooseReviewer(automatic({}), 'claude', agents, result).selection.scope, 'global-front');
});

test('modern preview reads separate eligible fronts for installed builders', async () => {
  const calls = [];
  const host = { version: '2.0.0', agents: { front: async options => { calls.push(options); return front; } } };
  const result = await readReviewerFront(host, { agents });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(c => c.agents), [['codex'], ['claude']]);
  assert.ok(result.byBuilder.claude);
  assert.ok(result.byBuilder.codex);
});
