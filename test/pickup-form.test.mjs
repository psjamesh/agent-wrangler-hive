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
    if (!snapshot) {
      const explanation = walk(key).find(n => n.attrs.class === 'hive-legend-item hive-legend-marks').attrs.title;
      assert.match(explanation, /Plain magnifier badges.*green.*blue/);
      assert.match(explanation, /prerequisite cross is grey; amber marks untracked work/);
      assert.match(explanation, /green outlined triangle/);
      assert.match(explanation, /chain-link glyph/);
    }
    assert.match(words, /external: outside this hive \(teammate PR, release, vendor\)/);
    assert.ok(walk(key).some(n => n.tag === 'external'));
    assert.match(words, /waiting on something outside this hive/);
    const combined = walk(key).find(n => n.children.includes('waiting on something outside this hive'));
    assert.ok(walk(combined).some(n => n.tag === 'waiting'));
    assert.ok(walk(combined).some(n => n.tag === 'external'));
  }
});

test('external mark draws two chain ends and a connecting link at badge scale', () => {
  const source = fs.readFileSync(new URL('../public/hex-grid.js', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '').replaceAll('export ', '');
  const mark = vm.runInNewContext(source + "\nprimaryMark('external', 'External prerequisite')", { h });
  const glyphs = walk(mark).filter(n => n.attrs.class === 'hive-pm-line');
  assert.equal(glyphs.length, 3);
  assert.ok(glyphs.every(n => n.tag === 'svg:path'));
  assert.ok(glyphs.slice(0, 2).every(n => /A3,3/.test(n.attrs.d)));
  assert.equal(glyphs[2].attrs.d, 'M-1.8,1.8 L1.8,-1.8');
});

test('status styles use theme colours for quiet waits, blue review and green pickup', () => {
  const css = fs.readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
  assert.match(css, /--hive-pm-waiting: var\(--fg-muted, var\(--fg\)\)/);
  assert.match(css, /--hive-pm-review: var\(--blue, #[0-9a-f]+\)/);
  assert.match(css, /\.hive-pm-review-pending \.hive-pm-bg \{ fill: var\(--hive-pm-review\); stroke: var\(--hive-pm-review\)/);
  assert.match(css, /\.hive-pm-pickup \.hive-pm-line \{ stroke: var\(--hive-pm-busy\)/);
  assert.match(css, /\.hive-pm-line \{ fill: none;/);
  assert.match(css, /\.hive-pm-untracked \.hive-pm-line \{ stroke: var\(--warn-fg/);
  assert.doesNotMatch(css, /\.hive-pm-(?:waiting|review-pending|pickup)[^{]*\{[^}]*var\(--warn-fg/);
});
