import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installDom, walk, fire, press } from './helpers/dom.mjs';
import { h } from '../public/dom.js';
import { settingsButton, settingsModal } from '../public/settings-view.js';
import { hiveSettings, openQueenPopover } from '../public/cell-view.js';
import { disposeCellPopover, refreshCellPopover } from '../public/cell-popover.js';

function fixture(t, extra = {}) {
  t.after(() => disposeCellPopover());
  installDom(t);
  const previousCSS = globalThis.CSS;
  globalThis.CSS = { escape: value => value };
  t.after(() => { globalThis.CSS = previousCSS; });
  const oldFrame = globalThis.requestAnimationFrame;
  const frames = [];
  globalThis.requestAnimationFrame = fn => frames.push(fn);
  t.after(() => { globalThis.requestAnimationFrame = oldFrame; });
  const forms = new Map(), sent = [], writes = [];
  const cell = { id: 'c', enabled: true, rootBeadId: 'r', taskId: 't', ...extra };
  const root = { id: 'r', goal: 'Ship useful work', acceptance: 'People can use it', updatedAt: 'v1' };
  const settings = {};
  const ctx = {
    hive: { cells: { c: cell }, beads: { r: root }, launches: [] },
    graph: { sessions: [], tasks: { tasks: [{ id: 't', name: 'Example hive' }] } },
    bees: { slider: () => h('input', { type: 'range', 'aria-label': 'Number of bees' }) },
    ui: { form: k => forms.get(k), setForm: (k, v) => forms.set(k, v), patchForm: (k, p) => forms.set(k, { ...forms.get(k), ...p }), cellId: () => 'c' },
    send: (msg, options) => sent.push({ msg, options }), busy: () => false,
    api: { settings: Object.assign(() => settings, { set: async (key, value) => { writes.push([key, value]); settings[key] = value; } }) },
  };
  document.querySelector = selector => walk(document.body).find(el => el.getAttribute('data-focus-key') === selector.match(/data-focus-key="([^"]+)"/)?.[1]);
  const draw = (current = cell) => {
    document.body.replaceChildren(settingsButton(ctx, current), settingsModal(ctx, current, leave => hiveSettings(ctx, current, leave)) || h('span'));
    while (frames.length) frames.shift()();
    return document.body;
  };
  const key = k => walk(document.body).find(el => el.dataset.focusKey === k);
  const dialog = () => walk(document.body).find(el => el.getAttribute('role') === 'dialog');
  const button = text => walk(document.body).find(el => el.tagName === 'button' && el.textContent === text);
  const open = (current = cell) => { draw(current); key('open-settings').click(); draw(current); };
  return { ctx, cell, root, forms, sent, writes, draw, key, dialog, button, open };
}

test('cog opens labelled modal; tabs change content and preserve hive drafts', t => {
  const f = fixture(t);
  f.draw();
  assert.equal(f.key('open-settings').getAttribute('aria-label'), 'Settings');
  assert.equal(f.key('open-settings').children[0].tagName, 'svg');
  f.open();
  assert.equal(f.dialog().getAttribute('aria-modal'), 'true');
  assert.equal(f.dialog().getAttribute('aria-labelledby'), 'hive-settings-title');
  assert.equal(document.activeElement, f.key('settings-close'));
  assert.match(f.dialog().textContent, /How the queen works.*Watchdog thresholds.*Codex approvals.*Automatic pickup.*Reviewers.*Turn hive off.*Retire hive/s);
  f.key('watchdog:c:workerMinutes').value = '15';
  fire(f.key('watchdog:c:workerMinutes'), 'input');
  f.key('settings-tab-all').click(); f.draw();
  assert.match(f.dialog().textContent, /Maximum active workers.*bd executable.*Pop up/s);
  assert.doesNotMatch(f.dialog().textContent, /Watchdog thresholds/);
  assert.equal(f.key('settings-tab-all').getAttribute('aria-selected'), 'true');
  press(f.key('settings-tab-all'), 'ArrowLeft'); f.draw();
  assert.equal(f.key('watchdog:c:workerMinutes').value, '15');
  assert.equal(document.activeElement, f.key('settings-tab-hive'));
  assert.equal(walk(f.dialog()).some(el => el.textContent === 'Info'), false);
});

test('Escape and Close return focus to the cog and Tab stays within the dialog', t => {
  const f = fixture(t); f.open();
  const dialog = f.dialog();
  const controls = walk(dialog).filter(el => ['button', 'input', 'select', 'textarea'].includes(el.tagName) && el.getAttribute('tabindex') !== '-1' && el.getAttribute('disabled') === null);
  dialog.querySelectorAll = () => controls;
  controls[0].focus();
  const back = press(dialog, 'Tab', { shiftKey: true, currentTarget: dialog });
  assert.equal(back.defaultPrevented, true);
  assert.equal(document.activeElement, controls.at(-1));
  press(dialog, 'Tab', { currentTarget: dialog });
  assert.equal(document.activeElement, controls[0]);
  press(dialog, 'Escape'); f.draw();
  assert.equal(f.dialog(), undefined);
  assert.equal(document.activeElement, f.key('open-settings'));
  f.open(); f.key('settings-close').click(); f.draw();
  assert.equal(f.dialog(), undefined);
  assert.equal(document.activeElement, f.key('open-settings'));
});

test('per-hive settings save and prevent closing across tabs while pending', t => {
  const f = fixture(t); f.open();
  const form = walk(f.dialog()).find(el => el.getAttribute('class') === 'hive-form hive-watchdog');
  fire(form, 'submit'); f.draw();
  assert.equal(f.sent[0].msg.type, 'hive-watchdog-settings');
  f.key('settings-tab-all').click(); f.draw();
  press(f.dialog(), 'Escape'); f.key('settings-close').click(); f.draw();
  assert.ok(f.dialog());
  assert.equal(f.key('settings-close').getAttribute('disabled'), '');
  f.sent[0].options.onReply({ ok: true }); f.draw();
  f.key('settings-tab-hive').click(); f.draw();
  assert.match(f.dialog().textContent, /Watchdog settings saved/);
  f.key('settings-close').click(); f.draw();
  assert.equal(f.dialog(), undefined);
});

test('global saves prevent closing and successful saves persist', async t => {
  const f = fixture(t); f.open(null);
  assert.equal(f.key('settings-tab-hive'), undefined);
  let finish;
  f.ctx.api.settings.set = (key, value) => new Promise(resolve => { finish = () => { f.writes.push([key, value]); resolve(); }; });
  f.key('capacity-limit').value = '4'; fire(f.key('capacity-limit'), 'input');
  let form = walk(f.dialog()).find(el => el.getAttribute('id') === 'hive-capacity-editor');
  const saving = fire(form, 'submit');
  f.draw(null); press(f.dialog(), 'Escape'); f.draw(null);
  assert.ok(f.dialog());
  finish(); await new Promise(resolve => setImmediate(resolve)); f.draw(null);
  assert.deepEqual(f.writes, [['maxClaimedWork', 4]]);
  assert.match(f.dialog().textContent, /Worker limit saved/);
  assert.equal(saving.defaultPrevented, true);
  f.key('settings-close').click(); f.draw(null);
  assert.equal(document.activeElement, f.key('open-settings'));
});

test('retired hives retain reopening and snapshots only offer All hives settings', t => {
  const f = fixture(t, { enabled: false, retired: { outcome: 'done', summary: 'Shipped' } });
  f.open();
  assert.match(f.dialog().textContent, /Retired as done.*Shipped.*Reopen hive/s);
  assert.doesNotMatch(f.dialog().textContent, /Watchdog thresholds/);
  f.button('Reopen hive…').click();
  assert.equal(f.forms.get('settings'), null);
  assert.equal(f.forms.get('retire:c').mode, 'reopen');
  f.cell.snapshot = { brief: 'Captured brief', sessions: {} };
  f.open();
  assert.equal(f.key('settings-tab-hive'), undefined);
  assert.match(f.dialog().textContent, /Maximum active workers/);
});

test('snapshot queen popover remains read only', t => {
  const f = fixture(t, { snapshot: { sessions: { q: { label: 'Captured queen', status: 'working' } }, queenSessionId: 'q' } });
  openQueenPopover(f.ctx, f.cell, null);
  const dialog = document.body.querySelector('dialog');
  assert.match(dialog.textContent, /Captured queen, working when captured.*read only/s);
  assert.doesNotMatch(dialog.textContent, /Launch a new queen|Send brief/);
});

test('queen popover exposes launch and brief management and refreshes live status', t => {
  const f = fixture(t);
  openQueenPopover(f.ctx, f.cell, null);
  let dialog = document.body.querySelector('dialog');
  assert.match(dialog.textContent, /Setup incomplete: no queen.*Launch a new queen/s);
  f.ctx.graph.sessions = [{ sessionId: 'q', status: 'working', name: 'Queen session' }];
  f.cell.queenSessionId = 'q';
  refreshCellPopover(f.ctx);
  assert.match(dialog.textContent, /Send brief/);
  walk(dialog).find(el => el.tagName === 'button' && el.textContent === 'Send brief').click();
  assert.equal(f.sent[0].msg.type, 'hive-queen-brief');
  f.ctx.ui.cellId = () => null;
  refreshCellPopover(f.ctx);
  assert.equal(dialog.isConnected, false);
});

test('queen Inspect closes its popover before opening the session', t => {
  const f = fixture(t, { queenSessionId: 'q' });
  f.ctx.graph.sessions = [{ sessionId: 'q', status: 'working', name: 'Queen session' }];
  let inspected;
  f.ctx.ui.inspect = id => { inspected = id; };
  openQueenPopover(f.ctx, f.cell, null);
  const dialog = document.body.querySelector('dialog');
  walk(dialog).find(el => el.tagName === 'button' && el.textContent === 'Inspect').click();
  assert.equal(inspected, 'q');
  assert.equal(dialog.isConnected, false);
});

test('bee saves prevent closing settings until complete', t => {
  const f = fixture(t); f.open(null);
  let saving = true;
  f.ctx.bees.saving = () => saving;
  press(f.dialog(), 'Escape'); f.draw(null);
  assert.ok(f.dialog());
  saving = false;
  f.key('settings-close').click(); f.draw(null);
  assert.equal(f.dialog(), undefined);
});

test('title edits inline and queen pill opens its popover', () => {
  const source = readFileSync(new URL('../public/cell-view.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /infoDrawer|info:|openInfo|['"]Info['"]/);
  assert.doesNotMatch(source, /openGoalPopover/);
  assert.match(source, /cellTitle\(ctx, cell\)/);
  assert.match(source, /queenPill\(ctx, cell, event => openQueenPopover\(ctx, cell, event.currentTarget\)\)/);
});

test('goal saves prevent closing settings across tabs and closing clears the goal draft', t => {
  const f = fixture(t); f.open();
  const form = walk(f.dialog()).find(el => el.getAttribute('class') === 'hive-form hive-goal');
  fire(form, 'submit'); f.draw();
  assert.equal(f.sent[0].msg.type, 'hive-cell-goal');
  f.key('settings-tab-all').click(); f.draw();
  press(f.dialog(), 'Escape'); f.draw();
  assert.ok(f.dialog());
  f.sent[0].options.onReply({ ok: true, updatedAt: 'v2' }); f.draw();
  f.key('settings-close').click(); f.draw();
  assert.equal(f.dialog(), undefined);
  assert.equal(f.forms.get('goal:c'), null);
});
