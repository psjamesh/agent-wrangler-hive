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
  assert.equal(primaryKind(ready, [], []), 'pickup');
  assert.match(markWords('pickup', ready), /Ready for pickup/);
  assert.equal(primaryKind(ready, [], ['working']), 'busy');
  assert.equal(primaryKind(ready, ['b'], []), 'waiting');
  assert.equal(primaryKind({ ...ready, status: 'deferred' }, [], []), 'deferred');
  assert.equal(primaryKind({ ...ready, reviewState: 'in_review' }, [], []), 'review-pending');
  assert.equal(primaryKind(ready, [], [], 1), 'person');
  assert.equal(primaryKind({ ...ready, status: 'closed' }, [], []), 'closed');
});
