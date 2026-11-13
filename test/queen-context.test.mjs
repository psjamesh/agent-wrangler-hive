import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const h = (tag, attrs, ...children) => ({ tag, attrs, children: children.flat(Infinity).filter(Boolean) });
const walk = (el) => el && typeof el === 'object' ? [el, ...el.children.flatMap(walk)] : [];
const widgets = fs.readFileSync(new URL('../public/widgets.js', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '').replace(/export /g, '');
const scope = { h };
vm.createContext(scope);
vm.runInContext(widgets + '\nthis.fields = launchFields; this.summary = launchSummary; this.instructions = instructionsField;', scope);
const api = { agents: () => [{ id: 'a', controls: { autoCompact: { presets: [100000, 500000] } } }, { id: 'b', controls: { autoCompact: { presets: [50000, 1000000] } } }] };
function fixture() {
  const forms = new Map();
  const sent = [];
  const ui = { form: (k) => forms.get(k), setForm: (k, v) => forms.set(k, v), patchForm: (k, v) => forms.set(k, { ...forms.get(k), ...v }) };
  return { ui, sent, api, busy: () => false, send: (m) => sent.push(m), graph: { tasks: { tasks: [{ id: 'task', name: 'Task' }] } }, hive: { cells: {} } };
}
const dialogScope = { h, launchFields: scope.fields, launchSummary: scope.summary, instructionsField: scope.instructions, sessionsInTask: () => [{ sessionId: 'existing' }], sessionLabel: () => 'Existing' };
const dialogCode = fs.readFileSync(new URL('../public/cell-dialog.js', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '').replace(/export /g, '');
const { open, draw } = vm.runInNewContext(dialogCode + '\n({ open: openCellDialog, draw: cellDialog })', dialogScope);
const control = (tree, key) => walk(tree).find((el) => el.attrs?.['data-focus-key'] === key);
for (const mode of ['new', 'adopt']) test(`${mode} hive launch defaults to 250k and preserves human choices`, () => {
  const f = fixture(); open(f.ui, mode, 'open');
  f.ui.patchForm('cell-dialog', { more: true, name: 'Hive', taskId: 'task', queen: '__launch' });
  let tree = draw(f);
  const select = control(tree, 'launch-auto-compact');
  assert.equal(select.children.find((el) => el.attrs.selected)?.attrs.value, '250000');
  walk(tree).find((el) => el.tag === 'form').attrs.onsubmit({ preventDefault() {} });
  assert.equal(f.sent[0].queen.autoCompactTokens, 250000);
  for (const value of ['500000', '']) {
    f.ui.patchForm('cell-dialog', { pending: null });
    tree = draw(f);
    control(tree, 'launch-auto-compact').attrs.onchange({ target: { value } });
    tree = draw(f);
    walk(tree).find((el) => el.tag === 'form').attrs.onsubmit({ preventDefault() {} });
    assert.equal(f.sent.at(-1).queen.autoCompactTokens, value ? Number(value) : undefined);
  }
});
test('adopting an existing queen sends no context settings', () => {
  const f = fixture(); open(f.ui, 'adopt', 'open');
  f.ui.patchForm('cell-dialog', { taskId: 'task', queen: 'existing', more: true });
  const tree = draw(f);
  assert.equal(control(tree, 'launch-auto-compact'), undefined);
  walk(tree).find((el) => el.tag === 'form').attrs.onsubmit({ preventDefault() {} });
  assert.equal(f.sent[0].queen, null);
});
test('Hive info new queen defaults to 250k and supports changing agent and threshold', () => {
  const source = fs.readFileSync(new URL('../public/cell-view.js', import.meta.url), 'utf8');
  const code = source.slice(source.indexOf('function queenBar('), source.indexOf('\n// A nominated queen'));
  const queenBar = vm.runInNewContext(code + '\nqueenBar', { ...dialogScope, launchState: () => null, nominatedNote: () => null });
  const f = fixture(), cell = { id: 'cell', taskId: 'task' };
  let tree = queenBar(f, cell);
  walk(tree).find((el) => el.tag === 'button').attrs.onclick();
  tree = queenBar(f, cell);
  assert.equal(control(tree, 'launch-auto-compact').children.find((el) => el.attrs.selected)?.attrs.value, '250000');
  walk(tree).find((el) => el.tag === 'form').attrs.onsubmit({ preventDefault() {} });
  assert.equal(f.sent.at(-1).autoCompactTokens, 250000);
  control(tree, 'launch-agent').attrs.onchange({ target: { value: 'b' } });
  assert.equal(f.ui.form('launch:cell').autoCompactTokens, 250000);
  tree = queenBar(f, cell);
  control(tree, 'launch-auto-compact').attrs.onchange({ target: { value: '' } });
  tree = queenBar(f, cell);
  walk(tree).find((el) => el.tag === 'form').attrs.onsubmit({ preventDefault() {} });
  assert.equal(f.sent.at(-1).autoCompactTokens, undefined);
});
