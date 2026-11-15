import { frontPick, reviewerSlot, FRONT_LIMITATION, TIER_FALLBACK_WARNING } from '../public/reviewer-front.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const h = (tag, attrs, ...children) => ({ tag, attrs, children: children.flat(Infinity).filter(x => x != null) });
const walk = el => el && typeof el === 'object' ? [el, ...el.children.flatMap(walk)] : [];
const agents = [
  { id: 'claude', label: 'Claude', available: true, efforts: [{ value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' }], models: [{ value: 'opus', label: 'Opus', default: true, efforts: ['medium', 'high'], autoEffort: 'high' }, { value: 'sonnet', label: 'Sonnet', efforts: ['medium'], autoEffort: 'medium' }] },
  { id: 'codex', label: 'Codex', available: true, efforts: [{ value: 'low', label: 'Low' }], models: [{ value: 'sol', label: 'Sol', default: true, efforts: ['low'], autoEffort: 'low' }] },
  { id: 'missing', label: 'Missing', available: false, reason: 'CLI not found', models: [] },
  { id: 'simple', label: 'Simple', available: true, models: [{ value: 'auto', default: true, efforts: [] }] },
];
function fixture(policy) {
  const source = fs.readFileSync(new URL('../public/review-policy.js', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '').replace(/export /g, '');
  const draw = vm.runInNewContext(source + '\nreviewPolicyForm', { h, frontPick, reviewerSlot, FRONT_LIMITATION, TIER_FALLBACK_WARNING });
  const forms = new Map(), sent = [];
  const ctx = { hive: { agents }, ui: { form: key => forms.get(key), setForm: (key, value) => forms.set(key, value), patchForm: (key, value) => forms.set(key, { ...forms.get(key), ...value }) }, send: (msg, options) => sent.push({ msg, options }) };
  const cell = { id: 'one', reviewPolicy: policy || { primary: { agent: 'claude', model: 'opus', effort: 'high' }, secondary: { agent: 'codex', model: 'sol', effort: 'low' } } };
  const render = () => draw(ctx, cell);
  const selects = () => walk(render()).filter(el => el.tag === 'select' && el.attrs.id);
  const change = (index, value) => selects()[index].attrs.onchange({ target: { value } });
  const draft = () => forms.get('review-policy:one');
  return { render, selects, change, draft, sent, ctx };
}

test('reviewer selects populate labels, disable unavailable agents and save both configs', () => {
  const f = fixture();
  assert.equal(f.selects().length, 6);
  const options = walk(f.selects()[0]).filter(el => el.tag === 'option');
  assert.ok(options.some(el => el.children.includes('Claude')));
  const missing = options.find(el => el.attrs.value === 'missing');
  assert.equal(missing.attrs.disabled, true);
  assert.match(missing.children.join(''), /CLI not found/);
  assert.ok(walk(f.selects()[1]).some(el => el.children.includes('Opus (default)')));
  f.render().attrs.onsubmit({ preventDefault() {} });
  assert.equal(f.sent[0].msg.type, 'hive-review-policy');
  assert.equal(f.sent[0].msg.policy.secondary.model, 'sol');
  f.sent[0].options.onReply({ ok: false, error: 'Model no longer installed' });
  assert.ok(walk(f.render()).some(el => el.children.includes('Model no longer installed')));
});

test('changing agent resets model and effort to host defaults; model resets only invalid effort', () => {
  const f = fixture();
  f.change(1, 'sonnet'); assert.equal(f.draft().primary.effort, 'medium');
  f.change(1, 'opus'); assert.equal(f.draft().primary.effort, 'medium');
  f.change(0, 'codex');
  assert.equal(f.draft().primary.model, 'sol'); assert.equal(f.draft().primary.effort, 'low');
  f.change(0, 'simple');
  assert.equal(f.draft().primary.model, 'auto'); assert.equal(f.draft().primary.effort, '');
});

for (const [field, value, index] of [['agent', 'removed', 0], ['model', 'old-opus', 1], ['effort', 'ultra', 2]]) test(`stale saved ${field} stays visible and flagged until explicitly replaced`, () => {
  const f = fixture({ primary: { agent: 'claude', model: 'opus', effort: 'high', [field]: value }, secondary: { agent: 'codex', model: 'sol', effort: 'low' } });
  const select = f.selects()[index];
  assert.equal(select.attrs['aria-invalid'], 'true');
  assert.ok(walk(select).some(el => el.tag === 'option' && el.attrs.value === value && el.attrs.selected && /not installed/.test(el.children.join(''))));
  assert.equal(f.draft().primary[field], value);
  assert.ok(walk(f.render()).some(el => el.tag === 'button' && el.attrs.type === 'submit' && el.attrs.disabled));
});

test('a model removed from a refreshed catalogue flags the existing draft and explains launch fallback', () => {
  const f = fixture(); f.render();
  f.ctx.hive.agents = agents.map(a => a.id === 'claude' ? { ...a, models: [] } : a);
  assert.equal(f.selects()[1].attrs['aria-invalid'], 'true');
  assert.equal(f.draft().primary.model, 'opus');
  assert.ok(walk(f.render()).some(el => el.children.some(c => typeof c === 'string' && /using Automatic host defaults/.test(c))));
});

test('automatic slots preview the front per builder and persist tier controls', () => {
  const f = fixture({ primary: { mode: 'automatic', tier: 'cheapest', agent: 'claude', model: 'opus', effort: 'high', minQuality: 70, maxUsd: 2 }, secondary: { agent: 'codex', model: 'sol', effort: 'low' } });
  f.ctx.hive.reviewerFront = { front: [{ agent: 'claude', model: 'opus', effort: 'high', quality: 80, usd: 1 }] };
  assert.ok(walk(f.render()).some(el => el.children.some(c => typeof c === 'string' && /Builder Codex: claude \/ opus/.test(c))));
  f.render().attrs.onsubmit({ preventDefault() {} });
  assert.equal(f.sent[0].msg.policy.primary.mode, 'automatic');
  assert.equal(f.sent[0].msg.policy.primary.maxUsd, 2);
  const input = walk(f.render()).find(el => el.tag === 'input');
  input.attrs.oninput({ target: { value: '90' } });
  assert.ok(walk(f.render()).some(el => el.children.some(c => typeof c === 'string' && /Builder Codex: No eligible/.test(c))));
});

test('Automatic preview shows only applicable builders and visible tier and fallback warnings', () => {
  const f = fixture({ primary: { mode: 'automatic', agent: 'claude', model: 'opus', effort: 'high' }, secondary: { mode: 'automatic', agent: 'codex', model: 'sol', effort: 'low' } });
  f.ctx.hive.agents = agents.filter(a => ['claude', 'codex'].includes(a.id));
  f.ctx.hive.reviewerFront = { front: [] };
  const nodes = walk(f.render());
  const previews = nodes.filter(el => el.attrs?.role === 'status' && el.children.some(c => typeof c === 'string' && c.startsWith('Builder ')));
  assert.equal(previews.length, 2);
  assert.ok(previews.every(el => el.attrs.class === 'hive-error' && el.children.some(c => /tier is not guaranteed/.test(c))));
  assert.ok(nodes.some(el => el.children.includes(FRONT_LIMITATION)));
  const options = nodes.filter(el => el.tag === 'option').map(el => el.attrs.value);
  for (const tier of ['balanced', 'strongest', 'cheapest']) assert.ok(options.includes(tier));
});
