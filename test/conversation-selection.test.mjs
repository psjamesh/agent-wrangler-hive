import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../public/client.js', import.meta.url), 'utf8');
const updateStart = source.indexOf('  update(el, session, graph) {');
const updateCode = source.slice(updateStart, source.indexOf('  unmount(el)', updateStart));
const code = source.slice(source.indexOf('export function createUi'), source.indexOf('function openInspector')).replace('export ', '');

test('message selection uses the mounted highlight updater without rerendering the view', () => {
  let renders = 0;
  const selections = [];
  let ui;
  const relations = { hiveSelectMessage: () => selections.push(ui.conversationMessage('cell', 'topic')) };
  const state = { uiVersion: 0, root: { querySelector: () => relations } };
  const createUi = vm.runInNewContext(`${code}\ncreateUi`, {
    state, sendPlacement() {}, load: (key, fallback) => fallback, save() {}, rerender: () => renders++, DRAFT_TEXT_MAX: 20000,
  });
  ui = createUi();
  ui.selectConversationMessage('cell', 'topic', 'first');
  ui.selectConversationMessage('cell', 'topic', 'second');
  ui.selectConversationMessage('cell', 'topic', 'second');
  ui.selectConversationMessage('cell', 'topic', null);
  assert.deepEqual(selections, ['first', 'second', null]);
  assert.equal(renders, 0, 'selection must not rebuild map geometry or replace focused controls');
});

for (const failure of [{ ok: false }, { ok: false, timeout: true }, { ok: true, conversationRevision: 'stale' }]) {
  test(`relation reads recover at unchanged metadata after ${JSON.stringify(failure)}`, () => {
    let now = 0, renders = 0;
    const state = { startAt: new Map(), uiVersion: 0, root: { querySelector: () => ({ hiveSelectMessage() {} }) } };
    const createUi = vm.runInNewContext(`${code}\ncreateUi`, {
      state, Date: { now: () => now }, RELATION_RETRY_MS: 1000,
      sendPlacement() {}, load: (key, fallback) => key === 'cell' ? 'cell' : fallback,
      save() {}, cancelDeepLink() {}, syncHiveSelection() {}, persistView() {},
      rerender: () => renders++, DRAFT_TEXT_MAX: 20000,
    });
    const ui = createUi();
    ui.openThreadFor('cell', 'topic');
    const token = ui.askRelations('cell', 'topic', 'epoch:current', 1);
    const before = renders;
    ui.receiveRelations(token, failure);
    for (let i = 0; i < 100; i++) assert.equal(ui.askRelations('cell', 'topic', 'epoch:current', 1), null);
    assert.equal(renders, before, 'failure must not trigger a render-driven retry');
    state.ui = ui;
    state.lastSig = 'unchanged';
    const update = vm.runInNewContext(`({${updateCode}}).update`, { state, settlePlacements() {}, rerender() {} });
    update(state.root, null, { hive: {} });
    assert.equal(state.lastSig, 'unchanged', 'graph updates inside the cooldown do not force a retry');
    now = 1000;
    update(state.root, null, { hive: {} });
    assert.equal(state.lastSig, '', 'an unchanged graph/reconnect must bypass the render signature when retry is due');
    assert.equal(ui.retryRelations(), true, 'an unchanged graph/reconnect can recover');
    const retry = ui.askRelations('cell', 'topic', 'epoch:current', 1);
    assert.ok(retry);
    ui.receiveRelations(token, { ok: true, relations: { references: ['hive-stale'] } });
    assert.equal(ui.relationsFor('cell', 'topic', 'epoch:current', 1), null);
    ui.receiveRelations(retry, { ok: true, relations: { references: ['hive-older'] } });
    assert.deepEqual(ui.relationsFor('cell', 'topic', 'epoch:current', 1).references, ['hive-older']);
    assert.equal(ui.retryRelations(), false);
    assert.equal(ui.askRelations('cell', 'topic', 'epoch:current', 1), null);
  });
}
