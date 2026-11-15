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
const automatic = tier => ({ reviewPolicy: { primary: { mode: 'automatic', agent: 'claude', model: 'opus', effort: 'medium', ...tier }, secondary: { mode: 'automatic', agent: 'codex', model: 'sol', effort: 'high', ...tier } } });

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
    assert.match(chosen.selection.reason, /No installed different-provider/);
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
