import { waitingGraphKey } from '../public/waiting-model.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { capacityControl } from '../public/capacity-control.js';
import { allSettings } from '../public/settings-view.js';
import { h } from '../public/dom.js';
import { renderSetup, setupNeeded } from '../public/setup.js';
import { createManifest } from '../server/manifest.js';

class Element {
  constructor(tag, text = '') { this.tag = tag; this.text = text; this.children = []; this.attrs = {}; this.events = {}; this.dataset = {}; }
  setAttribute(k, v) { this.attrs[k] = v; }
  append(child) { this.children.push(child); }
  addEventListener(k, fn) { this.events[k] = fn; }
  focus() { globalThis.document.activeElement = this; }
}
const walk = el => [el, ...el.children.flatMap(walk)];
const text = el => el.text + el.children.map(text).join(' ');
function fixture(t) {
  const previous = { document: globalThis.document, Node: globalThis.Node, requestAnimationFrame: globalThis.requestAnimationFrame };
  const frames = [];
  globalThis.Node = Element;
  globalThis.document = { createElement: tag => new Element(tag), createTextNode: value => new Element('#text', value), querySelector: selector => walk(tree).find(el => el.attrs['data-focus-key'] === selector.match(/"([^"]+)"/)?.[1]) };
  globalThis.requestAnimationFrame = fn => frames.push(fn);
  t.after(() => Object.assign(globalThis, previous));
  const forms = new Map(), writes = [], sent = [], settings = {};
  let redraw = () => {};
  const ctx = {
    bees: { slider: () => h('span', {}, 'Bee slider') }, send: m => sent.push(m), busy: () => false, notices: [],
    hive: { backend: { state: 'missing-binary' }, capacity: { used: 5, limit: 8, unlimited: false, breakdown: { claimed: 2, reviews: 1, launching: 2 } } },
    ui: { form: k => forms.get(k), setForm: (k, v) => { forms.set(k, v); redraw(); }, patchForm: (k, v) => forms.set(k, { ...forms.get(k), ...v }) },
    api: { settings: Object.assign(() => settings, { set: async (k, v) => { writes.push([k, v]); settings[k] = v; } }) },
  };
  let tree;
  const draw = () => { tree = ctx.setupMode ? renderSetup(ctx) : h('div', {}, capacityControl(ctx), allSettings(ctx)); while (frames.length) frames.shift()(); return tree; };
  const control = key => walk(tree).find(el => el.attrs['data-focus-key'] === key);
  const open = () => { draw(); control('capacity-toggle').events.click(); draw(); };
  const submit = () => walk(tree).find(el => el.attrs.id === 'hive-capacity-editor').events.submit({ preventDefault() {} });
  redraw = draw;
  return { ctx, writes, sent, draw, control, open, submit };
}

test('renders limited/unlimited global count with deduplicated breakdown and over-limit note', t => {
  const f = fixture(t);
  assert.match(text(f.draw()), /5 of 8 in progress/);
  assert.match(f.control('capacity-toggle').attrs.title, /2 claimed.*1.*reviews.*2.*launching/i);
  assert.equal(f.control('capacity-toggle').tag, 'button');
  assert.equal(f.control('capacity-toggle').attrs.type, 'button');
  f.ctx.hive.capacity.limit = 0;
  assert.match(text(f.draw()), /5 in progress/);
  assert.doesNotMatch(text(f.draw()), /of 0/);
  f.ctx.hive.capacity.limit = 2;
  assert.match(text(f.draw()), /Over limit.*Current work continues/);
});

test('editor preserves a draft during live updates and saves through host settings', async t => {
  const f = fixture(t); f.open();
  const input = f.control('capacity-limit');
  assert.equal(input.attrs.type, 'number'); assert.equal(input.attrs.min, '0'); assert.equal(input.attrs.step, '1');
  input.events.input({ target: { value: '3' } });
  f.ctx.hive.capacity.used = 6;
  f.draw();
  assert.equal(f.control('capacity-limit').value, '3');
  await f.submit();
  assert.deepEqual(f.writes, [['maxClaimedWork', 3]]);
  assert.equal(f.control('capacity-save').attrs.type, 'submit');
  f.control('settings-close').events.click(); f.open();
  f.control('capacity-unlimited').events.change({ target: { checked: true } }); f.draw();
  await f.submit();
  assert.deepEqual(f.writes.at(-1), ['maxClaimedWork', 0]);
});

test('invalid drafts and failed writes keep the editor with an accessible error', async t => {
  const f = fixture(t); f.open();
  for (const value of ['', '-1', '1.5', '9007199254740992']) {
    f.control('capacity-limit').events.input({ target: { value } }); f.draw(); await f.submit(); f.draw();
    assert.ok(walk(f.draw()).some(el => el.attrs.role === 'alert'));
    assert.equal(f.writes.length, 0);
  }
  f.control('capacity-limit').events.input({ target: { value: '4' } }); f.draw();
  f.ctx.api.settings.set = async () => { throw new Error('Disk full'); };
  await f.submit();
  assert.match(text(f.draw()), /Disk full/);
  assert.equal(f.control('capacity-limit').value, '4');
});

test('Escape and Close dismiss settings without saving', t => {
  const f = fixture(t); f.open();
  const form = walk(f.draw()).find(el => el.attrs.id === 'hive-all-settings');
  form.events.keydown({ key: 'Escape', preventDefault() {}, stopPropagation() {} });
  f.draw();
  assert.equal(f.control('capacity-toggle').attrs['aria-expanded'], 'false');
  f.open(); f.control('settings-close').events.click(); f.draw();
  assert.equal(f.control('capacity-toggle').attrs['aria-expanded'], 'false');
  assert.deepEqual(f.writes, []);
});

test('submitting immediately after typing saves the current draft without a rerender', async t => {
  const f = fixture(t); f.open();
  f.control('capacity-limit').events.input({ target: { value: '12' } });
  await f.submit();
  assert.deepEqual(f.writes, [['maxClaimedWork', 12]]);
});

test('count opens the shared Settings panel and focuses the limit field', t => {
  const f = fixture(t); f.open();
  assert.match(text(f.draw()), /Settings for all hives.*Maximum active workers.*Bee slider.*bd executable/);
  assert.equal(globalThis.document.activeElement.attrs['data-focus-key'], 'capacity-limit');
  assert.equal(f.control('capacity-toggle').attrs['aria-controls'], 'hive-all-settings');
  f.control('settings-close').events.click(); f.draw();
  assert.equal(globalThis.document.activeElement.attrs['data-focus-key'], 'capacity-toggle');
});

test('Hive settings render without bd and save its path through the host', async t => {
  const f = fixture(t);
  assert.equal(setupNeeded(f.ctx.hive), true);
  const setup = renderSetup(f.ctx);
  assert.ok(walk(setup).some(el => el.attrs['data-focus-key'] === 'open-settings'));
  walk(setup).find(el => el.attrs['data-focus-key'] === 'open-settings').events.click(); f.draw();
  const input = f.control('settings-bd-path');
  assert.equal(input.attrs.type, 'text');
  input.events.input({ target: { value: '/tmp/beads-test' } });
  await walk(f.draw()).find(el => el.attrs.id === 'hive-bd-setting').events.submit({ preventDefault() {} });
  assert.deepEqual(f.writes, [['bdPath', '/tmp/beads-test']]);
  assert.deepEqual(f.sent, [{ type: 'hive-setup-recheck' }]);
});

test('all settings rows are hidden from extension settings', () => {
  const defs = createManifest({ dir: '/tmp' }).settings;
  assert.equal(defs.find(s => s.key === 'maxClaimedWork').hidden, true);
  assert.equal(defs.find(s => s.key === 'bdPath').hidden, true);
  assert.equal(defs.find(s => s.key === 'beeLevel').hidden, true);
  assert.equal(defs.find(s => s.key === 'beeSize'), undefined);
  assert.equal(defs.find(s => s.key === 'requestNotifications').hidden, true);
  assert.equal(defs.find(s => s.key === 'requestNotifications').label, 'Pop up when a Hive request needs you');
});

test('closing settings discards drafts before the next open', t => {
  const f = fixture(t); f.open();
  f.control('capacity-limit').events.input({ target: { value: '19' } });
  f.control('settings-close').events.click(); f.draw();
  f.ctx.hive.capacity.limit = 12;
  f.open();
  assert.equal(f.control('capacity-limit').value, '12');
});

test('failed bd saves retain the path and never request a recheck', async t => {
  const f = fixture(t); f.open();
  f.ctx.api.settings.set = async () => { throw new Error('Disk full'); };
  f.control('settings-bd-path').events.input({ target: { value: '/tmp/my-bd' } }); f.draw();
  await walk(f.draw()).find(el => el.attrs.id === 'hive-bd-setting').events.submit({ preventDefault() {} });
  assert.match(text(f.draw()), /Could not save bd executable: Disk full/);
  assert.equal(f.control('settings-bd-path').value, '/tmp/my-bd');
  assert.deepEqual(f.sent, []);
});

test('settings close restores the setup Settings button if a bad path removed the count', t => {
  const f = fixture(t); f.open();
  f.ctx.setupMode = true; f.draw();
  f.control('settings-close').events.click(); f.draw();
  assert.equal(globalThis.document.activeElement.attrs['data-focus-key'], 'open-settings');
});

test('completed saves restore focus after the pending controls were disabled', async t => {
  const f = fixture(t); f.open();
  f.ctx.api.settings.set = async () => { globalThis.document.activeElement = null; };
  await f.submit(); f.draw();
  assert.equal(globalThis.document.activeElement?.attrs['data-focus-key'], 'capacity-save');
  await walk(f.draw()).find(el => el.attrs.id === 'hive-bd-setting').events.submit({ preventDefault() {} }); f.draw();
  assert.equal(globalThis.document.activeElement?.attrs['data-focus-key'], 'settings-bd-save');
});

test('changing a saved choice removes the saved confirmation', async t => {
  const f = fixture(t); f.open(); await f.submit(); f.draw();
  assert.match(text(f.draw()), /Worker limit saved/);
  f.control('capacity-unlimited').events.change({ target: { checked: true } });
  assert.doesNotMatch(text(f.draw()), /Worker limit saved/);
});

test('request popups default on, save through host settings and recover from errors', async t => {
  const f = fixture(t); f.open();
  assert.match(text(f.draw()), /Pop up when a Hive request needs you/);
  assert.equal(f.control('settings-notifications').attrs.checked, '');
  await f.control('settings-notifications').events.change({ target: { checked: false } }); f.draw();
  assert.deepEqual(f.writes.at(-1), ['requestNotifications', false]);
  assert.equal(f.control('settings-notifications').attrs.checked, undefined);
  f.ctx.api.settings.set = async () => { throw new Error('Disk full'); };
  await f.control('settings-notifications').events.change({ target: { checked: true } });
  assert.match(text(f.draw()), /Could not save notification preference: Disk full/);
  assert.equal(f.control('settings-notifications').attrs.checked, undefined);
});


test('Unlimited saves after an invalid numeric draft without native validation blocking submit', async t => {
  const f = fixture(t); f.open();
  for (const value of ['-1', '1.5', '']) {
    f.control('capacity-limit').events.input({ target: { value } });
    f.control('capacity-unlimited').events.change({ target: { checked: true } });
    const form = walk(f.draw()).find(el => el.attrs.id === 'hive-capacity-editor');
    assert.equal(form.attrs.novalidate, '');
    await f.submit();
    assert.deepEqual(f.writes.at(-1), ['maxClaimedWork', 0]);
  }
});

test('idle popup checkbox follows external host changes in either direction', t => {
  const f = fixture(t); f.open();
  f.ctx.api.settings().requestNotifications = false;
  f.draw();
  assert.equal(f.control('settings-notifications').attrs.checked, undefined);
  f.ctx.api.settings().requestNotifications = true;
  f.draw();
  assert.equal(f.control('settings-notifications').attrs.checked, '');
});

test('popup checkbox preserves a pending choice and reads live host state after failure', async t => {
  const f = fixture(t); f.open();
  let reject;
  f.ctx.api.settings.set = () => new Promise((_, fail) => { reject = fail; });
  const pending = f.control('settings-notifications').events.change({ target: { checked: false } });
  f.draw();
  assert.equal(f.control('settings-notifications').attrs.checked, undefined);
  assert.equal(f.control('settings-notifications').attrs.disabled, '');
  reject(new Error('Disk full'));
  await pending;
  assert.equal(f.control('settings-notifications').attrs.checked, '');
  assert.match(text(f.draw()), /Disk full/);
});

test('external popup changes invalidate the client render signature', () => {
  const source = readFileSync(new URL('../public/client.js', import.meta.url), 'utf8');
  const code = source.slice(source.indexOf('function signature('), source.indexOf('export function captureFocus'));
  const settings = {};
  const signature = vm.runInNewContext(`${code}\nsignature`, {
    state: { api: { settings: () => settings }, pending: new Set(), placements: [], notices: [] },
    beeLevel: () => 0, capacityLimit: () => 8, waitingGraphKey,
  });
  const hive = { cells: {}, backend: {} };
  const before = signature(hive);
  settings.requestNotifications = false;
  assert.notEqual(signature(hive), before);
  settings.requestNotifications = true;
  assert.equal(signature(hive), before);
});
