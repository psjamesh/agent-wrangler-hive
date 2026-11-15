import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom, walk, fire, press } from './helpers/dom.mjs';
import { cellTitle, cellGoalForm } from '../public/cell-settings.js';
import { configHandlers } from '../server/handlers.js';
import { fixture } from './ownership.test.mjs';

function uiFixture(t) {
  installDom(t);
  const previousFrame = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = fn => fn();
  t.after(() => { globalThis.requestAnimationFrame = previousFrame; });
  const forms = new Map(), sent = [];
  const cell = { id: 'c', taskId: 't', rootBeadId: 'root', enabled: true };
  const ctx = {
    graph: { tasks: { tasks: [{ id: 't', name: 'Old name' }] } },
    hive: { beads: { root: { goal: 'Old goal', acceptance: 'Old done', updatedAt: 'v1' } } },
    ui: { form: k => forms.get(k), setForm: (k, v) => forms.set(k, v), patchForm: (k, v) => forms.set(k, { ...forms.get(k), ...v }) },
    send: (msg, options) => sent.push({ msg, options }),
  };
  const draw = (render = cellTitle) => { document.body.replaceChildren(render(ctx, cell)); return document.body.children[0]; };
  return { ctx, cell, forms, sent, draw };
}

test('title renames inline with an accessible input; Escape cancels; failures keep the draft', t => {
  const f = uiFixture(t);
  f.draw().click();
  let form = f.draw();
  let input = walk(form).find(el => el.tagName === 'input');
  assert.equal(input.getAttribute('aria-label'), 'Hive name');
  input.value = 'New name'; fire(input, 'input');
  press(form, 'Escape');
  assert.equal(f.draw().textContent, 'Old name');
  assert.equal(f.sent.length, 0);
  f.draw().click(); form = f.draw();
  input = walk(form).find(el => el.tagName === 'input');
  input.value = 'New name'; fire(input, 'input');
  fire(form, 'submit');
  assert.deepEqual(f.sent[0].msg, { type: 'hive-cell-rename', cellId: 'c', name: 'New name' });
  f.sent[0].options.onReply({ ok: false, error: 'Rename failed' });
  assert.match(f.draw().textContent, /Rename failed/);
  assert.equal(f.forms.get('rename:c').name, 'New name');
  fire(f.draw(), 'submit');
  f.ctx.graph.tasks.tasks[0].name = 'New name';
  f.sent[1].options.onReply({ ok: true });
  assert.equal(f.draw().textContent, 'New name');
});

test('goal settings submit markdown, retain failed drafts and update the saved revision', t => {
  const f = uiFixture(t);
  let form = f.draw(cellGoalForm);
  const fields = walk(form).filter(el => el.tagName === 'textarea');
  for (const [i, value] of ['# New goal', '- New acceptance'].entries()) { fields[i].value = value; fire(fields[i], 'input'); }
  fire(form, 'submit');
  assert.deepEqual(f.sent[0].msg, { type: 'hive-cell-goal', cellId: 'c', goal: '# New goal', acceptance: '- New acceptance', expectedUpdatedAt: 'v1' });
  f.sent[0].options.onReply({ ok: false, error: 'Store unavailable' });
  assert.match(f.draw(cellGoalForm).textContent, /Store unavailable/);
  fire(f.draw(cellGoalForm), 'submit');
  f.sent[1].options.onReply({ ok: true, updatedAt: 'v2' });
  assert.match(f.draw(cellGoalForm).textContent, /Goal and done when saved/);
  assert.equal(f.forms.get('goal:c').expectedUpdatedAt, 'v2');
});

for (const mode of ['snapshot', 'retired']) test(`${mode} title and goal stay read only, including existing drafts`, t => {
  const f = uiFixture(t);
  f.draw().click();
  f.cell[mode] = {};
  assert.equal(f.draw().tagName, 'span');
  const form = f.draw(cellGoalForm);
  assert.ok(walk(form).filter(el => el.tagName === 'textarea').every(el => el.getAttribute('disabled') === ''));
  fire(form, 'submit');
  assert.equal(f.sent.length, 0);
});

async function request(f, type, values) {
  let reply;
  await configHandlers.find(h => h.type === type).handler({ cellId: 'cell', ...values }, f.host, r => { reply = r; });
  return reply;
}

test('rename handler calls the host task API, rebuilds the board and reports a refusal', async () => {
  const f = fixture();
  const renames = [];
  let rebuilds = 0;
  f.host.tasks.rename = (id, name) => { renames.push([id, name]); return true; };
  f.host.rebuild = () => { rebuilds++; };
  assert.equal((await request(f, 'hive-cell-rename', { name: ' Renamed hive ' })).ok, true);
  assert.deepEqual(renames, [['task', 'Renamed hive']]);
  assert.equal(rebuilds, 1);
  f.host.tasks.rename = () => false;
  const reply = await request(f, 'hive-cell-rename', { name: 'Another' });
  assert.equal(reply.ok, false);
  assert.match(reply.error, /could not be renamed/);
  for (const name of ['', ' '.repeat(5), 'x'.repeat(201), 7]) assert.equal((await request(f, 'hive-cell-rename', { name })).ok, false);
});

test('goal handler writes root fields as human history and records and delivers human input', async () => {
  const f = fixture();
  const writes = [], deliveries = [];
  f.rt.beads.update = async (id, patch, actor, check) => {
    check({ issues: Object.values(f.live) });
    writes.push({ id, patch, actor });
    return { updated_at: 'v2' };
  };
  f.host.deliver = async (sid, body) => { deliveries.push({ sid, body }); return { delivered: true }; };
  const reply = await request(f, 'hive-cell-goal', { goal: '# New goal', acceptance: '- Done' });
  assert.equal(reply.ok, true, JSON.stringify(reply));
  assert.deepEqual(writes, [{ id: 'root', patch: { goal: '# New goal', acceptance: '- Done' }, actor: 'aw:human' }]);
  const message = f.doc().conversation.cell[0];
  assert.equal(message.author, 'human');
  assert.equal(message.beadId, 'root');
  assert.match(message.text, /edited.*Goal and Done when/);
  assert.equal(deliveries[0].sid, 'queen');
  assert.match(deliveries[0].body, /edited.*Goal and Done when/);
  assert.equal(Object.values(f.doc().operations)[0].state, 'applied');
  assert.equal(reply.updatedAt, 'v2');
});

for (const mode of ['snapshot', 'retired']) test(`${mode} handlers reject title and goal writes`, async () => {
  const f = fixture();
  f.doc().cells.cell[mode] = {};
  let writes = 0;
  f.host.tasks.rename = () => { writes++; };
  f.rt.beads.update = () => { writes++; };
  assert.equal((await request(f, 'hive-cell-rename', { name: 'New' })).ok, false);
  assert.equal((await request(f, 'hive-cell-goal', { goal: 'New', acceptance: 'Done' })).ok, false);
  assert.equal(writes, 0);
});

test('stale goal saves and backend failures are reported without recording human input', async () => {
  const f = fixture();
  f.live.root.updated_at = 'newer';
  let writes = 0;
  f.rt.beads.update = async (id, patch, actor, check) => { check({ issues: Object.values(f.live) }); writes++; };
  const stale = await request(f, 'hive-cell-goal', { goal: 'New', acceptance: 'Done', expectedUpdatedAt: 'older' });
  assert.equal(stale.ok, false);
  assert.equal(stale.code, 'stale');
  assert.equal(writes, 0);
  assert.equal(f.doc().conversation.cell, undefined);
  f.rt.beads.update = async () => { throw Object.assign(new Error('Write refused'), { code: 'refused' }); };
  const failed = await request(f, 'hive-cell-goal', { goal: 'New', acceptance: 'Done' });
  assert.equal(failed.ok, false);
  assert.equal(failed.error, 'Write refused');
  assert.equal(f.doc().conversation.cell, undefined);
});

test('maximum length goal fields still produce human input, and failed delivery preserves it', async () => {
  const f = fixture();
  f.rt.beads.update = async (id, patch, actor, check) => { check({ issues: Object.values(f.live) }); return {}; };
  f.host.deliver = async () => { throw new Error('Queen unavailable'); };
  const reply = await request(f, 'hive-cell-goal', { goal: 'g'.repeat(20000), acceptance: 'a'.repeat(20000) });
  assert.equal(reply.ok, true);
  assert.equal(f.doc().conversation.cell[0].author, 'human');
  assert.equal(reply.delivery.state, 'uncertain');
});

test('an off hive can save its goal and keeps human input for the queen', async () => {
  const f = fixture();
  f.doc().cells.cell.enabled = false;
  f.rt.beads.update = async (id, patch, actor, check) => { check({ issues: Object.values(f.live) }); return {}; };
  const reply = await request(f, 'hive-cell-goal', { goal: 'New goal', acceptance: 'Done' });
  assert.equal(reply.ok, true, JSON.stringify(reply));
  assert.equal(f.doc().conversation.cell[0].author, 'human');
});
