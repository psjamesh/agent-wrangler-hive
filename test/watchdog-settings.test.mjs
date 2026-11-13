import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const h = (tag, attrs, ...children) => ({ tag, attrs, children: children.flat(Infinity).filter(x => x != null) });
const walk = el => el && typeof el === 'object' ? [el, ...el.children.flatMap(walk)] : [];
test('per-hive watchdog form shows defaults, saves all values and reports server errors', () => {
  const source = fs.readFileSync(new URL('../public/watchdog-settings.js', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '').replace(/export /g, '');
  const draw = vm.runInNewContext(source + '\nwatchdogSettingsForm', { h });
  const forms = new Map(), sent = [];
  const ctx = { ui: { form: key => forms.get(key), setForm: (key, value) => forms.set(key, value), patchForm: (key, value) => forms.set(key, { ...forms.get(key), ...value }) }, send: (msg, options) => sent.push({ msg, options }) };
  const cell = { id: 'one' };
  let tree = draw(ctx, cell);
  let inputs = walk(tree).filter(el => el.tag === 'input');
  assert.deepEqual(Array.from(inputs, i => i.attrs.value), [30, 60, 30, 24, 7, 30, 30, 10]);
  inputs[0].attrs.oninput({ target: { value: '15' } });
  tree = draw(ctx, cell); tree.attrs.onsubmit({ preventDefault() {} });
  assert.equal(sent[0].msg.type, 'hive-watchdog-settings'); assert.equal(sent[0].msg.cellId, 'one'); assert.equal(sent[0].msg.settings.workerMinutes, 15);
  sent[0].options.onReply({ ok: false, error: 'Invalid threshold' });
  assert.ok(walk(draw(ctx, cell)).some(el => el.children.includes('Invalid threshold')));
  draw(ctx, { id: 'two', watchdogSettings: { waitHours: 2 } });
  assert.equal(forms.get('watchdog:two').waitHours, 2); assert.equal(forms.get('watchdog:one').workerMinutes, '15');
});
