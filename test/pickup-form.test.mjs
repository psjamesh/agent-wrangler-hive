import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { primaryKind, markWords } from '../public/cell-view.js';

const h = (tag, attrs, ...children) => ({ tag, attrs, children: children.flat(Infinity).filter(x => x != null) });
const walk = node => node && typeof node === 'object' ? [node, ...node.children.flatMap(walk)] : [];
test('pickup form saves one explicit profile and shows actionable server errors', () => {
  const source = fs.readFileSync(new URL('../public/pickup.js', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '').replace(/export /g, '');
  const draw = vm.runInNewContext(source + '\npickupDetails', { h });
  const forms = new Map(), sent = [];
  const ctx = { api: { agents: () => [{ id: 'claude', models: [{ value: 'sonnet', default: true, autoEffort: 'medium', efforts: ['medium'] }] }] }, ui: { form: k => forms.get(k), setForm: (k, v) => forms.set(k, v), patchForm: (k, v) => forms.set(k, { ...forms.get(k), ...v }) }, send: (msg, options) => sent.push({ msg, options }) };
  const cell = { id: 'cell', enabled: true }, bead = { id: 'a', kind: 'work', status: 'open', pickup: { armed: true, state: 'queued', reason: 'Waiting on prerequisite b', armToken: 'arm_old' } };
  let tree = draw(ctx, cell, bead);
  assert.ok(walk(tree).some(n => n.children.includes('Waiting on prerequisite b')));
  for (const [name, value] of [['cwd', '/tmp/fake-repo'], ['reason', 'Checked previous result']]) walk(tree).find(n => n.tag === 'input' && n.attrs.name === name).attrs.oninput({ target: { value } });
  tree = draw(ctx, cell, bead); walk(tree).find(n => n.tag === 'form').attrs.onsubmit({ preventDefault() {} });
  assert.equal(sent[0].msg.type, 'hive-bead-pickup');
  assert.equal(sent[0].msg.expectedToken, 'arm_old');
  assert.equal(sent[0].msg.profile.agent, 'claude');
  assert.equal(sent[0].msg.profile.cwd, '/tmp/fake-repo');
  sent[0].options.onReply({ ok: false, error: 'Reconcile the previous worker first.' });
  assert.ok(walk(draw(ctx, cell, bead)).some(n => n.children.includes('Reconcile the previous worker first.')));
});

test('pickup mark yields to activity, waits, review, input and closed states', () => {
  const ready = { status: 'open', pickup: { state: 'ready', armed: true } };
  for (const state of ['ready', 'queued']) assert.equal(primaryKind({ ...ready, pickup: { armed: true, state } }, [], []), 'pickup');
  assert.match(markWords('pickup', ready), /Ready for pickup/);
  assert.equal(primaryKind(ready, [], ['working']), 'busy');
  assert.equal(primaryKind(ready, ['b'], []), 'waiting');
  assert.equal(primaryKind({ ...ready, status: 'deferred' }, [], []), 'deferred');
  assert.equal(primaryKind({ ...ready, reviewState: 'in_review' }, [], []), 'review-pending');
  assert.equal(primaryKind(ready, [], [], 1), 'person');
  assert.equal(primaryKind({ ...ready, status: 'closed' }, [], []), 'closed');
});

test('pickup uses an outline play glyph and the Key explains pickup and external marks', () => {
  const source = fs.readFileSync(new URL('../public/hex-grid.js', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '').replaceAll('export ', '');
  const mark = vm.runInNewContext(source + "\nprimaryMark('pickup', 'Ready for pickup')", { h });
  const glyphs = walk(mark).filter(n => n.attrs.class === 'hive-pm-line');
  assert.equal(glyphs.length, 1);
  assert.equal(glyphs[0].attrs.d, 'M-3,-4 L4,0 L-3,4 Z');
  const view = fs.readFileSync(new URL('../public/cell-view.js', import.meta.url), 'utf8').replace(/^import [\s\S]*?;\n/gm, '').replaceAll('export ', '');
  for (const snapshot of [false, true]) {
    const key = vm.runInNewContext(view + `\nlegend(${snapshot})`, { h, hexPath: () => '', primaryMark: kind => ({ tag: kind, attrs: {}, children: [] }) });
    const words = walk(key).flatMap(n => n.children.filter(c => typeof c === 'string')).join(' ');
    assert.match(words, /ready for automatic pickup/);
    assert.match(words, /external: outside this hive \(teammate PR, release, vendor\)/);
    assert.ok(walk(key).some(n => n.tag === 'external'));
  }
});
