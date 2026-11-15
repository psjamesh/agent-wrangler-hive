import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const h = (tag, attrs, ...children) => ({ tag, attrs, children: children.flat(Infinity).filter(x => x != null) });
const walk = el => el && typeof el === 'object' ? [el, ...el.children.flatMap(walk)] : [];
const source = ['agent-profile', 'worker-profile'].map(name => fs.readFileSync(new URL(`../public/${name}.js`, import.meta.url), 'utf8').replace(/^import .*;\n/gm, '').replace(/export /g, '')).join('\n');
const draw = vm.runInNewContext(source + '\nworkerProfileForm', { h });

test('default worker selects installed agents, resets dependent choices and saves a profile', () => {
  const forms = new Map(), sent = [];
  const agents = [{ id: 'claude', available: true, models: [{ value: 'sonnet', efforts: ['medium'] }] },
    { id: 'codex', available: false, models: [] }, { id: 'other', available: true, models: [{ value: 'basic', efforts: [] }] }];
  const ctx = { hive: { agents }, ui: { form: key => forms.get(key), patchForm: (key, patch) => forms.set(key, { ...forms.get(key), ...patch }) }, send: (msg, options) => sent.push({ msg, options }) };
  const cell = { id: 'one' };
  const workstream = { id: 'ws', kind: 'workstream', title: 'Repository' };
  let tree = draw(ctx, cell, workstream);
  const select = name => walk(tree).find(el => el.tag === 'select' && el.attrs.name === name);
  assert.ok(!walk(select('agent')).some(el => el.tag === 'option' && el.attrs.value === 'codex'));
  select('agent').attrs.onchange({ target: { value: 'claude' } });
  tree = draw(ctx, cell, workstream);
  assert.equal(select('model').attrs.value, 'sonnet');
  assert.equal(select('effort').attrs.value, 'medium');
  forms.get('worker-profile:one:ws').cwd = '/tmp/repository';
  tree.attrs.onsubmit({ preventDefault() {} });
  assert.equal(sent[0].msg.type, 'hive-worker-profile');
  assert.equal(sent[0].msg.profile.cwd, '/tmp/repository');
  assert.equal(sent[0].msg.profile.worktree.auto, true);
  sent[0].options.onReply({ ok: false, error: 'Profile rejected' });
  tree = draw(ctx, cell, workstream); assert.ok(walk(tree).some(el => el.children.includes('Profile rejected')));
  select('agent').attrs.onchange({ target: { value: 'other' } });
  tree = draw(ctx, cell, workstream); assert.equal(select('effort').attrs.value, '');
  walk(tree).find(el => el.tag === 'button' && el.children.includes('Clear default worker')).attrs.onclick();
  assert.equal(sent[1].msg.profile, null);
  assert.equal(sent[1].msg.auto, false);
});

test('settings select a workstream in this hive and save its visible brief template', () => {
  const drawSettings = vm.runInNewContext(source + '\nworkstreamProfileSettings', { h });
  const forms = new Map(), sent = [];
  const beads = { root: { id: 'root', kind: 'goal' }, ws: { id: 'ws', kind: 'workstream', parentId: 'root', title: 'First repository' },
    second: { id: 'second', kind: 'workstream', parentId: 'root', title: 'Second repository', pickup: { briefTemplate: 'Run repository checks, open PR, hand back with merge wait.', auto: true } },
    outside: { id: 'outside', kind: 'workstream', parentId: 'other' } };
  const ctx = { hive: { beads }, api: { agents: () => [] }, ui: { form: key => forms.get(key), patchForm: (key, patch) => forms.set(key, { ...forms.get(key), ...patch }), beadDetail: bead => ({ bead }) }, send: (msg, options) => sent.push({ msg, options }) };
  const cell = { id: 'one', rootBeadId: 'root' };
  let tree = drawSettings(ctx, cell);
  const picker = walk(tree).find(el => el.attrs['data-focus-key'] === 'worker-workstream');
  assert.deepEqual(Array.from(picker.children, option => option.attrs.value), ['ws', 'second']);
  picker.attrs.onchange({ target: { value: 'second' } });
  tree = drawSettings(ctx, cell);
  assert.ok(walk(tree).some(el => el.tag === 'textarea' && el.attrs.value === beads.second.pickup.briefTemplate));
  walk(tree).find(el => el.tag === 'form').attrs.onsubmit({ preventDefault() {} });
  assert.equal(sent[0].msg.beadId, 'second');
  assert.equal(sent[0].msg.briefTemplate, beads.second.pickup.briefTemplate);
  assert.equal(sent[0].msg.auto, true);
});
