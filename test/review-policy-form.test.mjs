import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const h = (tag, attrs, ...children) => ({ tag, attrs, children: children.flat(Infinity).filter(x => x != null) });
const walk = el => el && typeof el === 'object' ? [el, ...el.children.flatMap(walk)] : [];
test('review policy form shows both configs, saves them and reports server errors', () => {
  const source = fs.readFileSync(new URL('../public/review-policy.js', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '').replace(/export /g, '');
  const draw = vm.runInNewContext(source + '\nreviewPolicyForm', { h });
  const forms = new Map(), sent = [];
  const ctx = { ui: { form: key => forms.get(key), setForm: (key, value) => forms.set(key, value), patchForm: (key, value) => forms.set(key, { ...forms.get(key), ...value }) }, send: (msg, options) => sent.push({ msg, options }) };
  const cell = { id: 'one' };
  let tree = draw(ctx, cell);
  assert.deepEqual(Array.from(walk(tree).filter(el => el.tag === 'input'), i => i.attrs.value), ['claude', 'opus', 'medium', 'codex', 'gpt-6.1-sol', 'medium']);
  walk(tree).filter(el => el.tag === 'input')[1].attrs.oninput({ target: { value: 'sonnet' } });
  tree = draw(ctx, cell); tree.attrs.onsubmit({ preventDefault() {} });
  assert.equal(sent[0].msg.type, 'hive-review-policy');
  assert.equal(sent[0].msg.policy.primary.model, 'sonnet');
  assert.equal(sent[0].msg.policy.secondary.agent, 'codex');
  sent[0].options.onReply({ ok: false, error: 'Terra refused' });
  assert.ok(walk(draw(ctx, cell)).some(el => el.children.includes('Terra refused')));
});
