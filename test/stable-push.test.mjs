import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const client = fs.readFileSync(new URL('../public/client.js', import.meta.url), 'utf8');
const focusCode = client.slice(client.indexOf('export function restoreFocus('), client.indexOf('// Scroll positions')).replace('export ', '');

test('retained focused controls are never refocused or have their selection rewritten', () => {
  let focused = 0, selected = 0;
  const textarea = { focus: () => focused++, setSelectionRange: () => selected++ };
  const restore = vm.runInNewContext(focusCode + '; restoreFocus', { state: {}, document: { activeElement: textarea }, CSS: { escape: x => x } });
  restore({ querySelector: () => textarea }, { focusKey: 'composer:cell:topic', start: 2, end: 4 });
  assert.equal(focused, 0);
  assert.equal(selected, 0);
});

const scrollCode = client.slice(client.indexOf('export function restoreScroll('), client.indexOf('\nfunction settleShown(')).replace('export ', '');
test('retained scroll containers do not read layout or restore scroll on a push', () => {
  let reads = 0, restores = 0, watches = 0;
  const retained = { dataset: {}, get clientWidth() { reads++; return 100; } };
  const rebuilt = { dataset: {}, get clientWidth() { reads++; return 100; } };
  const restore = vm.runInNewContext(scrollCode + '; restoreScroll', {
    state: { followed: new Set([retained]) }, watchScroll: () => watches++, putBack: () => restores++, revealLinkMessage() {}, settleShown() {},
  });
  restore({ querySelectorAll: selector => selector === '[data-scroll-key]' ? [retained, rebuilt] : [] });
  assert.equal(reads, 1);
  assert.equal(restores, 1);
  assert.equal(watches, 1);
});

test('unrelated metadata keeps conversation and map inputs equal; actual changes invalidate each independently', async () => {
  const { conversationInputs, mapInputs } = await import('../public/view-inputs.js');
  const cell = { id: 'cell', enabled: true, messages: [{ id: 'm', text: 'hello' }], threads: [], beadLayout: {} };
  const hive = { metaEpoch: 'epoch', metaVersion: 1, cells: { cell }, beads: { b: { id: 'b', title: 'Work', status: 'open', summary: 'details' } }, edges: [], backend: {} };
  const ui = { selectedBeadId: () => null, placements: () => [], hideDoneForHive: () => false, detachedRegions: () => new Set(), form: () => null };
  const ctx = { hive, graph: { sessions: [] }, ui, uiVersion: 0, busy: () => false };
  const conversation = conversationInputs(ctx, cell);
  const map = mapInputs(ctx, cell);
  hive.metaVersion++;
  hive.beads.b.summary = 'new details';
  assert.equal(conversationInputs(ctx, cell), conversation);
  assert.equal(mapInputs(ctx, cell), map);
  cell.messages[0].text = 'new message';
  assert.notEqual(conversationInputs(ctx, cell), conversation);
  assert.equal(mapInputs(ctx, cell), map);
  hive.beads.b.status = 'closed';
  assert.notEqual(mapInputs(ctx, cell), map);
  const beforeCreated = mapInputs(ctx, cell);
  hive.beads.b.createdAt = '2026-11-12T00:00:00Z';
  assert.notEqual(mapInputs(ctx, cell), beforeCreated);
});

test('composer updates keep the textarea connected, its draft and selection, with fresh handlers', async () => {
  const { syncChildren } = await import('../public/dom.js');
  const source = fs.readFileSync(new URL('../public/conversation.js', import.meta.url), 'utf8');
  const start = source.indexOf('const composers =');
  const code = source.slice(start, source.indexOf('export function renderConversation', start)).replaceAll('export ', '');
  class Element {
    constructor(tag) { this.tag = tag; this.childNodes = []; this.value = ''; this.attrs = {}; }
    setAttribute(k, v) { this.attrs[k] = v; }
    removeChild(el) { assert.notEqual(el, input, 'the connected textarea must never be removed'); this.childNodes.splice(this.childNodes.indexOf(el), 1); el.parentNode = null; }
    insertBefore(el, before) {
      assert.ok(el !== input || !el.parentNode, 'the connected textarea must never be moved');
      if (el.parentNode) el.parentNode.removeChild(el);
      const at = before ? this.childNodes.indexOf(before) : this.childNodes.length;
      this.childNodes.splice(at, 0, el); el.parentNode = this;
    }
    get lastChild() { return this.childNodes.at(-1); }
  }
  let input;
  const api = vm.runInNewContext(code + '; ({ composerInput, composerShell })', { WeakMap, h: tag => new Element(tag), syncChildren });
  let draft = 'typing', saves = 0;
  const ui = { draftFor: () => draft, setDraftFor: (_key, value) => { draft = value; saves++; } };
  input = api.composerInput(ui, 'cell:topic', { placeholder: 'Reply' });
  input.selectionStart = 2; input.selectionEnd = 4;
  const root = api.composerShell(ui, 'cell:topic', { class: 'hive-composer' }, new Element('head'), input, new Element('row'));
  const next = api.composerInput(ui, 'cell:topic', { placeholder: 'New title' });
  assert.equal(next, input);
  assert.equal(api.composerShell(ui, 'cell:topic', { class: 'hive-composer' }, new Element('quote'), input, new Element('row')), root);
  assert.equal(input.parentNode, root);
  assert.equal(input.value, 'typing');
  assert.equal(input.selectionStart, 2);
  assert.equal(input.selectionEnd, 4);
  input.value += '!';
  input.oninput();
  assert.equal(draft, 'typing!');
  assert.equal(saves, 1);
});

test('conversation cache skips builds for metadata and other-thread messages, but renders arrivals', async () => {
  const { conversationInputs } = await import('../public/view-inputs.js');
  const source = fs.readFileSync(new URL('../public/conversation.js', import.meta.url), 'utf8');
  const code = source.slice(source.indexOf('export function renderConversation('), source.indexOf('\nfunction renderTopics(')).replace('export ', '');
  let builds = 0;
  const render = vm.runInNewContext(code + '; renderConversation', {
    conversationViews: new WeakMap(), conversationInputs, conversationEpoch: (a, b) => a + ':' + b, renderTopics: () => ({ list: ++builds }), h() {},
  });
  const cell = { id: 'cell', enabled: true, threads: [{ id: 'topic' }], messages: [{ id: 'm', threadId: 'topic', text: 'hello' }, { id: 'other', threadId: 'other', text: 'away' }] };
  const ui = { openThread: () => 'topic', askRelations: () => null };
  const hive = { cells: { cell }, beads: {}, metaVersion: 1 };
  const ctx = { hive, ui, uiVersion: 0, busy: () => false };
  const args = { cell, hive, ui, ctx };
  const first = render(args);
  hive.metaVersion++;
  assert.equal(render(args), first);
  cell.messages[1].text = 'different';
  assert.equal(render(args), first);
  assert.equal(builds, 1);
  cell.messages[0].text = 'arrival';
  assert.notEqual(render(args), first);
  assert.equal(builds, 2);
});

test('map renderer caches actual builds across conversation updates and rebuilds on status changes', async () => {
  const { mapInputs } = await import('../public/view-inputs.js');
  const source = fs.readFileSync(new URL('../public/hive-view.js', import.meta.url), 'utf8');
  const code = source.slice(source.indexOf('export function renderHive('), source.indexOf('\nexport function disposeHiveView')).replace('export ', '');
  let builds = 0;
  const h = () => ({ querySelector: () => ({}) });
  const render = vm.runInNewContext(code + '; renderHive', {
    hiveViews: new WeakMap(), mapInputs, h,
    cellPanels: () => ({ header: h(), related: null, dock: h() }),
    cellMap: () => { builds++; return h(); },
    syncChildren: (el, children) => {
      for (const child of el.children || []) if (child && !children.includes(child)) child.parentNode = null;
      el.children = children;
      for (const child of children) if (child) child.parentNode = el;
      return el;
    },
  });
  const cell = { id: 'cell', enabled: true, rootBeadId: 'root', messages: [] };
  const hive = { cells: { cell }, beads: { root: { id: 'root', title: 'Goal', status: 'open' } }, edges: [] };
  const ui = { cellId: () => 'cell', pane: () => 'conversation', selectedBeadId: () => null, placements: () => [], hideDoneForHive: () => false, detachedRegions: () => new Set(), form: () => null };
  const ctx = { hive, graph: { sessions: [] }, ui, busy: () => false };
  const top = render(ctx).top;
  hive.metaVersion = 2;
  cell.messages.push({ text: 'new arrival' });
  assert.equal(render(ctx).top, top);
  assert.equal(builds, 1);
  hive.beads.root.status = 'closed';
  render(ctx);
  assert.equal(builds, 2);
  cell.enabled = false;
  render(ctx);
  cell.enabled = true;
  render(ctx);
  assert.equal(builds, 3, 'a detached map needs a fresh resize observer on return');
});

test('removing the root cleans read listeners from the old conversation before hiding its panel', () => {
  const source = fs.readFileSync(new URL('../public/cell-view.js', import.meta.url), 'utf8');
  const code = source.slice(source.indexOf('export function cellPanels(')).replace('export ', '');
  const removed = [];
  const h = () => ({ dataset: {}, addEventListener() {}, removeEventListener(type) { removed.push(type); } });
  const render = vm.runInNewContext(code + '; cellPanels', {
    panelViews: new WeakMap(), h, hasPanels: (_cell, root) => Boolean(root),
    renderConversation: () => ({ list: h(), scrollKey: 'messages:cell', onReadInteraction() {} }),
    syncChildren: el => el, beadDetails: h, cellHeader: h, infoDrawer: () => null, workstreamDrawer: () => null, retireDrawer: () => null, isRetired: () => false, paneTabs: h,
  });
  const ui = { inspecting: () => null, dockOpen: () => true };
  const cell = { id: 'cell', rootBeadId: 'root', enabled: true };
  const hive = { beads: { root: { id: 'root' } } };
  const ctx = { ui, hive };
  assert.ok(render(ctx, cell).dock);
  delete hive.beads.root;
  assert.equal(render(ctx, cell).dock, null);
  assert.deepEqual(removed, ['pointerdown', 'keydown', 'focusin', 'wheel', 'touchstart']);
});

test('scroll restoration never rewinds an active wheel or momentum scroll', () => {
  const code = client.slice(client.indexOf('function putBack('), client.indexOf('// Puts `item`'));
  const state = { startAt: new Map(), follow: new Map([['messages', false]]), scrollMemo: new Map([['messages', { top: 100, left: 0 }]]) };
  const putBack = vm.runInNewContext(code + '; putBack', { state, Date, scrolling: el => el.hiveScrollUntil > Date.now() });
  const el = { dataset: { scrollKey: 'messages', scrollFollow: '' }, hiveScrollUntil: Date.now() + 300, scrollTop: 160, scrollLeft: 0, children: [] };
  putBack(el, true);
  assert.equal(el.scrollTop, 160, 'a captured position must not overwrite newer user scrolling');
});

function scrollingFixture() {
  let now = 1000;
  const state = { startAt: new Map(), follow: new Map([['messages', true]]), scrollMemo: new Map([['messages', { top: 100, left: 0 }]]), reveal: new Set(), followed: new Set() };
  const events = new Map();
  const el = { dataset: { scrollKey: 'messages', scrollFollow: '' }, isConnected: true, clientWidth: 200, clientHeight: 200, scrollHeight: 100, scrollTop: 0, children: [], addEventListener(type, fn) { if (!events.has(type)) events.set(type, []); events.get(type).push(fn); }, querySelectorAll: () => [] };
  const code = client.slice(client.indexOf('function captureScroll('), client.indexOf('\nfunction releaseFollowers('));
  const api = vm.runInNewContext(code + '; ({watchScroll, putBack, captureScroll})', { state, Date: { now: () => now }, document: {}, FOLLOW_SLACK_PX: 40 });
  api.watchScroll(el);
  return { ...api, state, el, advance: ms => { now += ms; }, fire(type, props = {}) { for (const fn of events.get(type) || []) fn(props); } };
}

test('an upward wheel over a short list does not disable following later arrivals', () => {
  const f = scrollingFixture();
  f.fire('wheel', { deltaY: -50 });
  f.el.scrollHeight = 500;
  f.putBack(f.el, true);
  assert.equal(f.el.scrollTop, 500, 'the newest message still follows when the list could not scroll up');
});

test('a newly opened list restores its saved position while its outer panel was recently scrolled', () => {
  const f = scrollingFixture();
  f.state.follow.set('messages', false);
  f.el.parentElement = { hiveScrollUntil: 1300 };
  f.putBack(f.el, false);
  assert.equal(f.el.scrollTop, 100, 'a new list must open at its saved position');
});

test('continued momentum renews the scroll guard after the initial wheel ends', () => {
  const f = scrollingFixture();
  f.state.follow.set('messages', false);
  f.el.scrollHeight = 2000;
  f.fire('wheel', { deltaY: 50 });
  f.advance(250);
  f.el.scrollTop = 400;
  f.fire('scroll');
  f.advance(250);
  f.putBack(f.el, true);
  assert.equal(f.el.scrollTop, 400);
});
