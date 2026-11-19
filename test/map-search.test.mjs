import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('search ranks fields before substring position, without case sensitivity', async () => {
  const { rankBeads } = await import('../public/map-search.js');
  const fields = ['title', 'id', 'goal', 'summary', 'acceptance', 'nextAction', 'evidence'];
  const beads = fields.map((field, i) => ({ id: `b${i}`, title: 'Other', [field]: field === 'evidence' ? [{ label: 'Prefix NEEDLE suffix', detail: 'detail' }] : 'Prefix NEEDLE suffix' }));
  assert.deepEqual(rankBeads(beads.reverse(), 'need').map(r => r.field), fields);
  assert.equal(rankBeads(beads, 'EdLe').length, 7);
  assert.equal(rankBeads(beads, '  ').length, 0);
});

import { rankBeads } from '../public/bead-rank.js';
import { renderHive } from '../public/hive-view.js';
import client, { createUi, captureFocus, restoreFocus } from '../public/client.js';

class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.attributes = {}; this.events = {}; this.dataset = {}; this.style = {}; this.value = ''; this.clientWidth = 1000; this.clientHeight = 700; }
  setAttribute(k, v) { this.attributes[k] = String(v); if (k.startsWith('data-')) this.dataset[k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(v); }
  getAttribute(k) { return this.attributes[k] ?? (k.startsWith('data-') ? this.dataset[k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] : undefined) ?? null; }
  removeAttribute(k) { delete this.attributes[k]; }
  get classList() { const el = this; const get = () => new Set((el.attributes.class || '').split(' ').filter(Boolean)); return { contains: n => get().has(n), add(...ns) { const s = get(); ns.forEach(n => s.add(n)); el.attributes.class = [...s].join(' '); }, remove(...ns) { const s = get(); ns.forEach(n => s.delete(n)); el.attributes.class = [...s].join(' '); }, toggle(n, on) { const s = get(); if (on ?? !s.has(n)) s.add(n); else s.delete(n); el.attributes.class = [...s].join(' '); } }; }
  get childNodes() { return this.children; }
  get firstChild() { return this.children[0]; }
  get lastChild() { return this.children.at(-1); }
  get parentElement() { return this.parentNode; }
  removeChild(n) { this.children.splice(this.children.indexOf(n), 1); n.parentNode = null; return n; }
  append(...ns) { for (let n of ns) { if (!(n instanceof Element)) n = Object.assign(new Element('#text'), { text: String(n) }); n.parentNode?.removeChild(n); n.parentNode = this; this.children.push(n); } }
  insertBefore(n, before) { if (n === before) return; n.parentNode?.removeChild(n); n.parentNode = this; const i = this.children.indexOf(before); this.children.splice(i < 0 ? this.children.length : i, 0, n); }
  replaceChildren(...ns) { this.children.forEach(n => n.parentNode = null); this.children = []; this.append(...ns); }
  get textContent() { return this.text ?? this.children.map(n => n.textContent).join(''); }
  set textContent(v) { this.replaceChildren(); this.text = String(v); }
  matches(selector) { return selector.split(',').some(part => { const s = part.trim(); const descendant = s.match(/^(\.[\w-]+) (.+)$/); if (descendant) return this.matches(descendant[2]) && Boolean(this.parentNode?.closest(descendant[1])); if (s.startsWith('.')) return s.slice(1).split('.').every(c => this.classList.contains(c)); const a = s.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/); return a ? this.getAttribute(a[1]) !== null && (a[2] === undefined || this.getAttribute(a[1]) === a[2]) : this.tagName === s; }); }
  closest(s) { for (let el = this; el; el = el.parentNode) if (el.matches(s)) return el; return null; }
  querySelectorAll(s) { return this.children.flatMap(n => [...(n.matches(s) ? [n] : []), ...n.querySelectorAll(s)]); }
  querySelector(s) { return this.querySelectorAll(s)[0] || null; }
  isEqualNode(other) { return this === other; }
  contains(n) { return n === this || this.children.some(c => c.contains(n)); }
  focus() {
    for (let el = this; el; el = el.parentNode) if (el.hidden) return;
    document.activeElement = this;
  }
  addEventListener(type, fn, capture = false) { (this.events[type] ||= []).push({ fn, capture: capture === true }); }
  removeEventListener(type, fn) { this.events[type] = (this.events[type] || []).filter(e => e.fn !== fn); }
  fire(type, props = {}) { const e = { type, target: this, key: '', preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, ...props }; const path = []; for (let el = this; el; el = el.parentNode) path.push(el); for (const capture of [true, false]) for (const el of capture ? [...path].reverse() : path) { for (const h of el.events[type] || []) if (h.capture === capture) h.fn(e); if (e.stopped) return e; } return e; }
  getBoundingClientRect() { return { left: 0, top: 0, right: 1000, bottom: 700, width: 1000, height: 700 }; }
}

function fixture(t, extra = 0, preferences = []) {
  const saved = Object.fromEntries(['Node', 'document', 'requestAnimationFrame', 'cancelAnimationFrame', 'CSS'].map(k => [k, globalThis[k]]));
  Object.assign(globalThis, { Node: Element, document: { createElement: t => new Element(t), createElementNS: (_, t) => new Element(t), createTextNode: t => Object.assign(new Element('#text'), { text: t }), body: new Element('body'), querySelector: s => document.body.querySelector(s), addEventListener() {}, removeEventListener() {} }, requestAnimationFrame: () => 1, cancelAnimationFrame() {}, CSS: { escape: s => s } });
  t.after(() => Object.assign(globalThis, saved));
  const values = new Map([['cell', JSON.stringify('cell')], ...preferences]);
  client.register({ api: { storage: { get: k => values.get(k), set: (k, v) => values.set(k, v), remove: k => values.delete(k) } }, register() {} });
  const ui = createUi();
  const beads = {
    root: { id: 'root', kind: 'goal', status: 'open', title: 'Search demo' },
    ws: { id: 'ws', parentId: 'root', kind: 'workstream', status: 'open', title: 'Delivery' },
    title: { id: 'title', parentId: 'ws', status: 'open', title: 'Needle in title' },
    goal: { id: 'goal', parentId: 'ws', status: 'open', title: 'Second', goal: 'Needle in goal' },
    done: { id: 'done', parentId: 'ws', status: 'closed', outcome: 'done', title: 'Needle done' },
    outside: { id: 'outside', parentId: 'root', status: 'open', title: 'Outside', evidence: [{ detail: 'Needle evidence' }] },
  };
  for (let i = 0; i < extra; i++) beads[`extra${i}`] = { id: `extra${i}`, parentId: 'ws', status: 'open', title: `Work ${i}`, summary: 'ordinary text' };
  const cell = { id: 'cell', taskId: 'task', enabled: true, rootBeadId: 'root', queenSessionId: 'queen', bindings: [], messages: [], threads: [], beadLayout: {} };
  const ctx = { ui, hive: { beads, cells: { cell }, edges: [], operations: [], launches: [], backend: {} }, graph: { sessions: [] }, api: {}, notices: [], busy: () => false, notice() {}, searchDelay: 0,
    send(frame, { onReply } = {}) { if (frame.type === 'hive-bead-search') onReply({ ok: true, results: rankBeads(Object.values(beads), frame.query) }); } };
  let dock;
  let top;
  const draw = () => {
    const out = renderHive(ctx);
    dock = out.bottom;
    if (top && top !== out.top && top.parentNode) {
      const parent = top.parentNode;
      parent.removeChild(top); parent.append(out.top);
    }
    top = out.top;
    return top;
  };
  draw();
  document.body.append(top);
  const canvas = () => top.querySelector('.hive-canvas');
  const setQuery = ui.setSearchQuery.bind(ui);
  ui.setSearchQuery = query => { setQuery(query); canvas()?.hiveRefreshSearch?.(ctx); };
  const search = query => { canvas().focus(); canvas().fire('keydown', { key: '/' }); const input = top.querySelector('input'); input.value = query; input.fire('input'); return input; };
  return { values, ui, ctx, beads, get top() { return top; }, dock: () => dock, draw, canvas, search, tile: id => canvas().querySelector(`[data-tile-id="${id}"]`) };
}

test('map search uses shared fields in a labelled search region', t => {
  const f = fixture(t);
  const bar = f.canvas().querySelector('.hive-map-search');
  assert.equal(bar.getAttribute('role'), 'search');
  assert.equal(bar.getAttribute('aria-label'), 'Search Hive');
  const row = bar.querySelector('.hive-search-row');
  assert.equal(f.top.querySelectorAll('input').length, 1);
  assert.equal(row.querySelector('input').classList.contains('hive-input'), true);
  assert.equal(row.querySelector('select').classList.contains('hive-input'), true);
  assert.equal(row.querySelector('button').classList.contains('hive-quiet-btn'), true);
  assert.ok(f.canvas().querySelector('.hive-search-open').closest('.hive-zoom'));
  f.ui.closeCell();
  f.ui.setGlobalInboxOpen(true);
  f.draw();
  assert.equal(f.draw().querySelector('.hive-inbox-search-input').classList.contains('hive-input'), true);
});

test('real render opens only on map focus, highlights, navigates and clears without rebuilding', t => {
  const f = fixture(t);
  const canvas = f.canvas();
  const composer = f.dock().querySelector('textarea');
  assert.ok(composer, 'fixture renders the real conversation composer');
  { composer.focus(); composer.fire('keydown', { key: '/' }); assert.equal(canvas.querySelector('.hive-map-search').hidden, true); }
  for (const tag of ['input', 'textarea', 'select', 'button']) {
    const control = new Element(tag); canvas.append(control); control.fire('keydown', { key: 'a' });
    assert.equal(canvas.querySelector('.hive-map-search').hidden, true);
    canvas.removeChild(control);
  }
  const editable = new Element('div'); editable.setAttribute('contenteditable', ''); canvas.append(editable); editable.fire('keydown', { key: '/' });
  assert.equal(canvas.querySelector('.hive-map-search').hidden, true);
  f.tile('title').fire('keydown', { key: 'n' });
  const input = f.top.querySelector('input'); assert.equal(input.value, 'n'); assert.equal(document.activeElement, input);
  input.value = 'nEEdle'; input.fire('input');
  assert.equal(canvas.querySelector('.hive-search-count').textContent, '4 matches');
  assert.equal(f.tile('goal').classList.contains('is-search-match'), true);
  assert.equal(f.tile('ws').classList.contains('is-search-dim'), true);
  const before = canvas.hiveCaptureView();
  input.fire('keydown', { key: 'Enter' });
  assert.match(canvas.querySelector('.hive-search-field').textContent, /Needle done — title/);
  assert.notDeepEqual(canvas.hiveCaptureView(), before);
  input.fire('keydown', { key: 'Enter' }); assert.match(canvas.querySelector('.hive-search-field').textContent, /Needle in title — title/);
  input.fire('keydown', { key: 'Enter', shiftKey: true }); assert.match(canvas.querySelector('.hive-search-field').textContent, /Needle done — title/);
  input.fire('keydown', { key: 'ArrowUp' }); assert.match(canvas.querySelector('.hive-search-field').textContent, /Outside — evidence/);
  f.draw(); assert.equal(f.canvas(), canvas);
  f.beads.goal.goal = 'changed'; f.ctx.hive.revision = 2; f.draw(); assert.equal(f.canvas(), canvas); assert.equal(f.tile('goal').classList.contains('is-search-match'), false);
  f.top.querySelector('input').fire('keydown', { key: 'Escape' });
  assert.deepEqual(canvas.hiveCaptureView(), before);
  assert.equal(canvas.querySelector('.hive-map-search').hidden, true);
  assert.equal(canvas.querySelectorAll('.is-search-match').length, 0); assert.equal(canvas.querySelectorAll('.is-search-dim').length, 0);
});

test('Hide done counts separately, reveals temporarily and survives retained-map refresh', t => {
  const f = fixture(t);
  f.ui.setHideDoneForHive('cell', true); f.draw();
  const input = f.search('needle');
  assert.equal(f.tile('done'), null);
  assert.equal(f.canvas().querySelector('.hive-search-count').textContent, '3 matches · 1 hidden by Hide done');
  const reveal = f.canvas().querySelector('.hive-map-search').querySelectorAll('button').find(b => b.textContent === 'Reveal hidden matches'); reveal.fire('click'); f.draw();
  assert.equal(f.tile('done').classList.contains('is-search-match'), true);
  assert.equal(f.top.querySelector('input').value, 'needle');
  assert.equal(f.canvas().querySelector('.hive-search-count').textContent, '4 matches · 1 revealed from Hide done');
  f.top.querySelector('input').fire('keydown', { key: 'Escape' }); f.draw();
  assert.equal(f.tile('done'), null);
  assert.equal(f.ui.hideDoneForHive('cell'), true);
  assert.equal(f.canvas().querySelectorAll('.is-search-dim').length, 0);
});

test('workstream scope excludes other work and typing on a 250-bead map retains it', t => {
  const f = fixture(t, 250); const input = f.search('needle'); const canvas = f.canvas();
  const scope = canvas.querySelector('.hive-map-search').querySelector('select'); scope.value = 'ws'; scope.fire('change');
  assert.equal(canvas.querySelector('.hive-search-count').textContent, '3 matches');
  assert.equal(f.tile('outside').classList.contains('is-search-dim'), true);
  for (const query of ['n', 'ne', 'nee', 'need', 'needle', 'work', 'no match', '']) { input.value = query; input.fire('input'); f.draw(); assert.equal(f.canvas(), canvas); }
  assert.equal(canvas.querySelectorAll('.is-search-dim').length, 0);
});

test('all search fields rank through the real render path and never enter unrelated inputs', t => {
  const f = fixture(t);
  const fields = ['title', 'id', 'goal', 'summary', 'acceptance', 'nextAction', 'evidence'];
  for (const [i, field] of fields.entries()) {
    const id = field === 'id' ? 'rank-id' : `field${i}`;
    f.beads[id] = { id, parentId: 'ws', status: 'open', title: 'Other', [field]: field === 'evidence' ? [{ label: 'rank label' }] : field === 'id' ? id : 'rank value' };
  }
  f.draw();
  const input = f.search('rank');
  for (const field of fields) {
    input.fire('keydown', { key: 'ArrowDown' });
    assert.ok(f.canvas().querySelector('.hive-search-field').textContent.endsWith(`— ${{ id: 'cell id', nextAction: 'next action' }[field] || field}`));
  }
  input.value = 'no results'; input.fire('input');
  assert.equal(f.canvas().querySelector('.hive-search-count').textContent, '0 matches');
  f.top.querySelector('input').fire('keydown', { key: 'Escape' });
  for (const props of [{ key: 'a', ctrlKey: true }, { key: 'a', metaKey: true }, { key: 'a', altKey: true }, { key: 'a', isComposing: true }]) {
    f.canvas().fire('keydown', props); assert.equal(f.canvas().querySelector('.hive-map-search').hidden, true);
  }
  f.canvas().fire('keydown', { key: ' ' }); assert.equal(f.ui.searchQuery(), ' ');
  f.canvas().focus(); f.canvas().fire('keydown', { key: 'Escape' });
  assert.equal(f.canvas().querySelector('.hive-map-search').hidden, true);
});

test('returning to an open search preserves its query and appends typing from the map', t => {
  const f = fixture(t); let input = f.search('need');
  f.canvas().focus(); f.canvas().fire('keydown', { key: '/' });
  assert.equal(input.value, 'need'); assert.equal(document.activeElement, input);
  f.canvas().focus(); f.canvas().fire('keydown', { key: 'l' });
  assert.equal(input.value, 'needl'); assert.equal(document.activeElement, input);
});

test('existing selection and zoom shortcuts work until search is open', t => {
  const f = fixture(t); const map = f.canvas();
  f.tile('title').fire('keydown', { key: ' ' });
  assert.equal(f.ui.selectedBeadId(), 'title');
  assert.equal(map.querySelector('.hive-map-search').hidden, true);
  for (const key of ['+', '=', '-', '_']) {
    const before = map.hiveCaptureView().k;
    map.fire('keydown', { key });
    assert.notEqual(map.hiveCaptureView().k, before);
    assert.equal(map.querySelector('.hive-map-search').hidden, true);
  }
  map.fire('keydown', { key: '0' }); assert.equal(map.hiveCaptureView().auto, true);
  assert.equal(map.querySelector('.hive-map-search').hidden, true);
  const input = f.search('query');
  for (const key of [' ', '+', '=', '-', '_', '0']) {
    map.focus(); map.fire('keydown', { key });
  }
  assert.equal(input.value, 'query +=-_0');
});

test('hive-wide Hide done search includes completed child regions and preserves the hive preference', t => {
  const f = fixture(t);
  f.beads.closedHead = { id: 'closedHead', parentId: 'ws', kind: 'workstream', status: 'closed', outcome: 'done', title: 'Needle completed region' };
  f.beads.closedKid = { id: 'closedKid', parentId: 'closedHead', status: 'closed', outcome: 'done', title: 'Needle completed child' };
  f.ui.setHideDoneForHive('cell', true); f.draw();
  f.search('needle');
  assert.equal(f.canvas().querySelector('.hive-search-count').textContent, '3 matches · 3 hidden by Hide done');
  assert.equal(f.tile('closedHead'), null); assert.equal(f.tile('closedKid'), null);
  f.canvas().querySelector('.hive-map-search').querySelectorAll('button').find(b => b.textContent === 'Reveal hidden matches').fire('click'); f.draw();
  assert.equal(f.tile('closedHead').classList.contains('is-search-match'), true);
  assert.equal(f.tile('closedKid').classList.contains('is-search-match'), true);
  assert.equal(f.canvas().querySelector('.hive-search-count').textContent, '6 matches · 3 revealed from Hide done');
  f.top.querySelector('input').fire('keydown', { key: 'Escape' }); f.draw();
  assert.equal(f.tile('closedHead'), null); assert.equal(f.tile('closedKid'), null);
  assert.equal(f.ui.hideDoneForHive('cell'), true);
  assert.equal(f.ui.hideDoneForHive('cell'), true);
  assert.equal(f.canvas().querySelectorAll('.is-search-dim').length, 0);
});

for (const saved of [['ws'], { malformed: true }, null]) test(`obsolete workstream preference is ignored: ${JSON.stringify(saved)}`, t => {
  const f = fixture(t, 0, [['hideDone:cell', JSON.stringify(saved)], ['regionHiding:cell', 'true']]);
  assert.ok(f.tile('done'), 'old preference cannot hide closed work');
  const canvas = f.canvas();
  f.values.set('hideDone:cell', JSON.stringify(['root']));
  f.draw();
  assert.equal(f.canvas(), canvas, 'obsolete preference does not invalidate the map cache');
  f.tile('ws').fire('keydown', { key: 'F10', shiftKey: true }); f.draw();
  const menu = f.top.querySelector('.hive-wsmenu');
  assert.ok(menu);
  assert.doesNotMatch(menu.textContent, /Show done|Hide done/);
  assert.equal(f.top.querySelector('[data-focus-key="wsmenu:arrange"]'), null);
  assert.equal(f.top.querySelector('[data-focus-key="wsmenu:suggest"]').textContent, 'Suggest completion');
});

test('opening a hive removes obsolete local keys while preserving the hive setting', t => {
  const f = fixture(t, 0, [['hideDone:cell', '["ws"]'], ['regionHiding:cell', 'true'], ['hideDoneForHive:cell', 'true'], ['hideDone:other', '["other"]']]);
  assert.equal(f.values.has('hideDone:cell'), false);
  assert.equal(f.values.has('regionHiding:cell'), false);
  assert.equal(f.values.get('hideDoneForHive:cell'), 'true');
  assert.equal(f.values.get('hideDone:other'), '["other"]');
  assert.equal(f.tile('done'), null);
});

for (const reduced of [false, true]) test(`Hide done animates a detached live chain (${reduced ? 'reduced motion' : 'normal motion'})`, t => {
  const f = fixture(t);
  const previousMedia = globalThis.matchMedia;
  globalThis.matchMedia = () => ({ matches: reduced });
  t.after(() => { globalThis.matchMedia = previousMedia; });
  const animations = [];
  Element.prototype.animate = function(frames, options) { animations.push({ id: this.dataset.tileId, frames, options }); };
  t.after(() => { delete Element.prototype.animate; });
  const { cell } = f.ctx.hive.cells;
  cell.beadLayout = { ws: { q: 0, r: 0 }, done: { q: 1, r: 0 }, title: { q: 2, r: 0 }, goal: { q: 3, r: 0 }, outside: { q: 20, r: 0 } };
  f.draw();
  animations.length = 0;
  f.ui.setHideDoneForHive('cell', true); f.draw();
  assert.equal(f.tile('done'), null);
  assert.equal(f.tile('title').getAttribute('transform'), 'translate(103.9 0.0)');
  assert.equal(animations.length, reduced ? 0 : 2);
  if (!reduced) {
    assert.deepEqual(animations.map(a => a.id).sort(), ['goal', 'title']);
    assert.ok(animations.every(a => a.options.duration > 0));
  }
});

test('an already hidden hive saves new pull-in positions when a bridge becomes done', t => {
  const f = fixture(t), frames = [], sent = [];
  globalThis.requestAnimationFrame = callback => { frames.push(callback); return frames.length; };
  f.ui.sendPlacement = (message, placement) => { sent.push(message); Object.assign(f.ctx.hive.cells.cell.beadLayout, placement.positions); };
  f.ctx.hive.cells.cell.beadLayout = { ws: { q: 0, r: 0 }, done: { q: 1, r: 0 }, title: { q: 2, r: 0 }, goal: { q: 3, r: 0 }, outside: { q: 20, r: 0 } };
  f.beads.done.status = 'open';
  f.ui.setHideDoneForHive('cell', true); f.draw();
  for (const callback of frames.splice(0)) callback();
  assert.equal(sent.length, 0);
  f.beads.done.status = 'closed'; f.draw();
  f.canvas().isConnected = true;
  for (const callback of frames.splice(0)) callback();
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].positions, { title: { q: 1, r: 0 }, goal: { q: 2, r: 0 } });
  assert.deepEqual(sent[0].stack, ['done']);
  f.draw(); f.canvas().isConnected = true;
  for (const callback of frames.splice(0)) callback();
  assert.equal(sent.length, 1, 'the saved pull-in is idempotent on rerender');
});

test('a refused automatic pull-in waits for changed geometry before retrying', t => {
  const f = fixture(t), frames = [], sent = [];
  globalThis.requestAnimationFrame = callback => { frames.push(callback); return frames.length; };
  f.ui.sendPlacement = message => { sent.push(message); };
  f.ctx.hive.cells.cell.beadLayout = { ws: { q: 0, r: 0 }, done: { q: 1, r: 0 }, title: { q: 2, r: 0 }, goal: { q: 3, r: 0 }, outside: { q: 20, r: 0 } };
  f.ui.setHideDoneForHive('cell', true); f.draw(); f.canvas().isConnected = true;
  for (const callback of frames.splice(0)) callback();
  assert.equal(sent.length, 1);
  f.ui.setForm('wsMenu', { cellId: 'cell', headId: 'ws', at: { x: 0, y: 0 } });
  f.draw(); f.canvas().isConnected = true;
  for (const callback of frames.splice(0)) callback();
  assert.equal(sent.length, 1);
  f.ctx.hive.cells.cell.beadLayout.outside = { q: 21, r: 0 };
  f.draw(); f.canvas().isConnected = true;
  for (const callback of frames.splice(0)) callback();
  assert.equal(sent.length, 2);
});

test('a pointer drop does not animate the moved chain again from its old origin', t => {
  const f = fixture(t), animations = [];
  Element.prototype.animate = function() { animations.push(this.dataset.tileId); };
  Element.prototype.getScreenCTM = () => ({ inverse: () => ({}) });
  Element.prototype.createSVGPoint = () => ({ matrixTransform() { return { x: this.x, y: this.y }; } });
  t.after(() => { delete Element.prototype.animate; delete Element.prototype.getScreenCTM; delete Element.prototype.createSVGPoint; });
  f.ui.sendPlacement = (message, placement) => { Object.assign(f.ctx.hive.cells.cell.beadLayout, placement.positions); };
  f.ctx.hive.cells.cell.beadLayout = { ws: { q: 0, r: 0 }, title: { q: 1, r: 0 }, goal: { q: 2, r: 0 }, done: { q: 3, r: 0 }, outside: { q: 20, r: 0 } };
  f.draw(); animations.length = 0;
  const tile = f.tile('ws');
  tile.fire('pointerdown', { button: 0, pointerType: 'mouse', pointerId: 1, clientX: 0, clientY: 0 });
  tile.fire('pointermove', { clientX: 0, clientY: 270 });
  tile.fire('pointerup', { clientX: 0, clientY: 270 });
  f.draw();
  assert.deepEqual(f.ctx.hive.cells.cell.beadLayout.ws, { q: -1, r: 3 });
  assert.deepEqual(animations, []);
});

test('a search reply for an older query is dropped', t => {
  const f = fixture(t);
  const pending = [];
  f.ctx.send = (frame, { onReply }) => pending.push({ frame, onReply });
  const input = f.search('needle');
  assert.equal(pending.length, 1);
  input.value = 'outside'; input.fire('input');
  assert.equal(pending.length, 2);
  pending[1].onReply({ ok: true, results: [{ id: 'outside', field: 'title', rank: 0 }] });
  pending[0].onReply({ ok: true, results: [{ id: 'title', field: 'title', rank: 0 }, { id: 'goal', field: 'goal', rank: 2 }] });
  assert.equal(f.canvas().querySelector('.hive-search-count').textContent, '1 match');
  assert.equal(f.tile('outside').classList.contains('is-search-match'), true);
  assert.equal(f.tile('title').classList.contains('is-search-match'), false);
});

test('a failed search falls back to titles and says so', t => {
  const f = fixture(t);
  f.ctx.send = (frame, { onReply }) => onReply({ ok: false, error: 'x' });
  f.search('needle');
  assert.match(f.canvas().querySelector('.hive-search-count').textContent, /titles only/);
});

for (const overview of [false, true]) {
  test(`auto-fit follows ${overview ? 'overview' : 'cell'} map replacements and resize, but pauses for gestures`, t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = fixture(t);
    const saved = { ResizeObserver: globalThis.ResizeObserver, matchMedia: globalThis.matchMedia };
    const observers = [];
    globalThis.ResizeObserver = class {
      constructor(callback) { this.callback = callback; observers.push(this); }
      observe() {}
      disconnect() { this.disconnected = true; }
    };
    globalThis.matchMedia = () => ({ matches: true });
    t.after(() => Object.assign(globalThis, saved));
    f.ctx.api.storage = { get: key => f.values.get(key), set: (key, value) => f.values.set(key, value) };
    let top = f.top;
    if (overview) { f.ui.closeCell(); top = f.draw(); }
    const mount = () => {
      const canvas = top.querySelector('.hive-canvas');
      canvas.isConnected = true;
      canvas.hiveViewMounted();
      return canvas;
    };
    let canvas = mount();
    t.mock.timers.tick(200);
    const initial = canvas.hiveCaptureView();
    const world = canvas.querySelector('.hive-world');
    let writes = 0;
    const set = world.setAttribute.bind(world);
    world.setAttribute = (...args) => { writes++; set(...args); };
    const observer = observers.at(-1);
    observer.callback();
    t.mock.timers.tick(200);
    assert.equal(writes, 1, 'resize redraws once but identical fit does not write the transform again');
    canvas.clientWidth = 1200;
    observer.callback();
    t.mock.timers.tick(100);
    observer.callback();
    t.mock.timers.tick(199);
    assert.equal(canvas.hiveCaptureView().tx, initial.tx);
    t.mock.timers.tick(1);
    assert.equal(canvas.hiveCaptureView().tx, initial.tx + 100);
    canvas.fire('wheel', { deltaMode: 0, deltaX: 40, deltaY: 0 });
    assert.equal(canvas.hiveCaptureView().auto, false);
    const paused = canvas.hiveCaptureView();
    const toggle = canvas.querySelectorAll('button').find(b => b.textContent === 'Auto-fit paused');
    assert.ok(toggle);
    assert.equal(toggle.getAttribute('aria-pressed'), null);
    canvas.clientWidth = 1400;
    observer.callback();
    t.mock.timers.tick(300);
    assert.deepEqual(canvas.hiveCaptureView(), paused);
    if (overview) {
      f.ctx.hive.cells.other = { ...f.ctx.hive.cells.cell, id: 'other', taskId: 'other', position: { q: 5, r: 0 } };
    } else {
      f.beads.new = { id: 'new', parentId: 'root', kind: 'work', status: 'open', title: 'New work' };
    }
    top = f.draw();
    assert.equal(observer.disconnected, true);
    canvas = mount();
    t.mock.timers.tick(300);
    assert.deepEqual(canvas.hiveCaptureView(), paused, 'board updates preserve manual viewport');
    canvas.fire('keydown', { key: '0' });
    assert.equal(canvas.hiveCaptureView().auto, true);
    const before = canvas.hiveCaptureView();
    if (overview) delete f.ctx.hive.cells.other;
    else delete f.beads.new;
    top = f.draw();
    canvas = mount();
    t.mock.timers.tick(199);
    assert.deepEqual(canvas.hiveCaptureView(), before);
    t.mock.timers.tick(1);
    assert.notDeepEqual(canvas.hiveCaptureView(), before, 'removal refits the changed board');
    canvas.hiveDisposeView();
  });
}


for (const enabled of [false, true]) {
  test(`a first-time map fits immediately with auto-fit ${enabled ? 'on' : 'off'}`, async t => {
    fixture(t);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { renderHexMap } = await import('../public/hex-grid.js');
    const options = {
      viewKey: `fresh-mount-${enabled}`, size: 60, items: [],
      bounds: { x: 600, y: 400, w: 500, h: 400 },
      storage: { get: () => JSON.stringify(enabled) },
    };
    const first = renderHexMap(options).el;
    first.hiveViewMounted();
    const fitted = first.hiveCaptureView();
    assert.notEqual(fitted.tx, 0, 'mount fits before any debounce time passes');
    assert.notEqual(fitted.ty, 0);
    first.hiveDisposeView();
    const next = renderHexMap({ ...options, bounds: { x: 0, y: 0, w: 100, h: 100 } }).el;
    next.hiveViewMounted();
    assert.deepEqual(next.hiveCaptureView(), fitted, 'existing viewport is preserved on rebuild');
    t.mock.timers.tick(200);
    if (enabled) assert.notDeepEqual(next.hiveCaptureView(), fitted, 'later board updates debounce');
    else assert.deepEqual(next.hiveCaptureView(), fitted, 'disabled auto-fit leaves an existing view alone');
    next.hiveDisposeView();
  });
}

test('map controls group zoom, stable view toggles and actions with explicit states', t => {
  const f = fixture(t);
  f.canvas().fire('keydown', { key: '0' });
  const buttons = () => f.canvas().querySelector('.hive-zoom').querySelectorAll('button');
  assert.deepEqual(buttons().filter(b => !b.closest('.hive-map-menu') && !b.hidden).map(b => b.textContent), ['Search', '☰']);
  const menu = f.canvas().querySelector('.hive-map-menu');
  assert.equal(menu.hidden, true);
  assert.deepEqual(menu.querySelectorAll('button').map(b => b.textContent), ['−', '+', 'Auto-fit', 'Show done', 'Key', 'Arrange']);
  const done = () => buttons().find(b => b.textContent === 'Show done');
  assert.equal(done().getAttribute('aria-checked'), 'true');
  assert.equal(done().getAttribute('aria-pressed'), null);
  assert.equal(done().getAttribute('role'), 'menuitemcheckbox');
  f.ui.setHideDoneForHive('cell', true);
  f.draw();
  assert.equal(done().getAttribute('aria-checked'), 'false');
  const key = buttons().find(b => b.textContent === 'Key');
  assert.equal(key.getAttribute('aria-checked'), 'false');
  key.fire('click'); f.draw();
  assert.equal(buttons().find(b => b.textContent === 'Key').getAttribute('aria-checked'), 'true');
  const auto = buttons().find(b => b.textContent === 'Auto-fit');
  f.canvas().fire('wheel', { deltaMode: 0, deltaX: 60, deltaY: 0 });
  assert.equal(auto.textContent, 'Auto-fit');
  const resume = buttons().find(b => b.textContent === 'Auto-fit paused');
  assert.equal(resume.hidden, false);
  assert.equal(resume.closest('.hive-map-menu'), null);
  resume.fire('click');
  assert.equal(resume.hidden, true);
  assert.equal(auto.getAttribute('data-paused'), 'false');
  auto.fire('click');
  assert.equal(auto.getAttribute('aria-checked'), 'false');
  f.canvas().fire('wheel', { deltaMode: 0, deltaX: 60, deltaY: 0 });
  assert.equal(resume.hidden, true);
  f.canvas().fire('keydown', { key: '0' });
  assert.equal(auto.getAttribute('aria-checked'), 'true');
  assert.equal(auto.getAttribute('data-paused'), 'false');
  f.ui.closeCell();
  const overview = f.draw().querySelector('.hive-canvas');
  overview.fire('keydown', { key: '0' });
  assert.deepEqual(overview.querySelector('.hive-zoom').querySelectorAll('button').map(b => b.textContent), ['Auto-fit paused', 'Search', '☰', '−', '+', 'Auto-fit']);
});

for (const overview of [false, true]) {
  test(`map menu supports keyboard navigation and dismissal in ${overview ? 'overview' : 'hive'}`, t => {
    const f = fixture(t);
    if (overview) { f.ui.closeCell(); f.draw(); }
    const canvas = f.canvas();
    const trigger = canvas.querySelector('.hive-map-menu-toggle');
    const menu = canvas.querySelector('.hive-map-menu');
    assert.ok(menu);
    const items = menu.querySelectorAll('button').filter(b => b.getAttribute('disabled') === null);
    assert.equal(trigger.getAttribute('aria-expanded'), 'false');
    assert.equal(trigger.getAttribute('aria-haspopup'), 'menu');
    assert.equal(trigger.getAttribute('aria-controls'), menu.getAttribute('id'));
    const launcher = trigger.parentNode;
    assert.equal(launcher.children.at(-2).querySelector('button').textContent, 'Search');
    trigger.focus();
    trigger.fire('keydown', { key: 'ArrowDown' });
    assert.equal(menu.hidden, false);
    assert.equal(trigger.getAttribute('aria-expanded'), 'true');
    assert.equal(document.activeElement, items[0]);
    items[0].fire('keydown', { key: 'ArrowUp' });
    assert.equal(document.activeElement, items.at(-1));
    items.at(-1).fire('keydown', { key: 'ArrowDown' });
    assert.equal(document.activeElement, items[0]);
    items[0].fire('keydown', { key: 'End' });
    assert.equal(document.activeElement, items.at(-1));
    items.at(-1).fire('keydown', { key: 'Home' });
    assert.equal(document.activeElement, items[0]);
    assert.equal(items[0].fire('keydown', { key: 'Tab' }).defaultPrevented, undefined);
    assert.ok(items.every(b => b.getAttribute('tabindex') !== '-1'));
    const before = canvas.hiveCaptureView();
    menu.fire('wheel', { deltaMode: 0, deltaX: 60, deltaY: 0 });
    assert.deepEqual(canvas.hiveCaptureView(), before);
    items[0].fire('keydown', { key: 'Escape' });
    assert.equal(menu.hidden, true);
    assert.equal(document.activeElement, trigger);
    trigger.fire('click');
    assert.equal(menu.hidden, false);
    menu.fire('focusout', { relatedTarget: canvas });
    assert.equal(menu.hidden, true);
    trigger.fire('keydown', { key: 'ArrowUp' });
    assert.equal(document.activeElement, items.at(-1));
    trigger.focus();
    trigger.fire('keydown', { key: 'Escape' });
    assert.equal(menu.hidden, true);
    trigger.fire('click');
    items[0].fire('click');
    assert.equal(menu.hidden, true);
    assert.equal(document.activeElement, trigger);
    canvas.hiveDisposeView();
  });
}

for (const overview of [false, true]) {
  test(`resume reserves its layout space through pause, drag and rebuild in ${overview ? 'overview' : 'hive'}`, t => {
    const f = fixture(t);
    if (overview) { f.ui.closeCell(); f.draw(); }
    const canvas = f.canvas();
    canvas.fire('keydown', { key: '0' });
    const tools = canvas.querySelector('.hive-zoom');
    const slot = tools.querySelector('.hive-map-resume-slot');
    assert.ok(slot, 'resume has a persistent layout slot');
    const resume = slot.querySelector('button');
    const launcher = tools.querySelector('.hive-map-menu-launcher');
    const structure = [...tools.children];
    assert.equal(resume.hidden, true);
    const svg = canvas.querySelector('svg');
    svg.fire('pointerdown', { button: 0, clientX: 10, clientY: 10 });
    svg.fire('pointermove', { clientX: 30, clientY: 30 });
    assert.equal(resume.hidden, false);
    assert.deepEqual(tools.children, structure);
    svg.fire('pointerup', { clientX: 30, clientY: 30 });
    resume.fire('click');
    assert.equal(resume.hidden, true);
    const tile = canvas.querySelector(`[data-tile-id="${overview ? 'cell' : 'title'}"]`);
    tile.fire('pointerdown', { button: 0, clientX: 10, clientY: 10 });
    tile.fire('pointermove', { clientX: 30, clientY: 30 });
    assert.ok(canvas.querySelector('.hive-zoom') === tools, 'drag does not rebuild controls');
    assert.equal(resume.hidden, true, 'tile drag does not pause auto-fit');
    assert.ok(tools.querySelector('.hive-map-menu-launcher') === launcher);
    tile.fire('pointercancel');
    f.beads.title.status = 'in_progress';
    f.draw();
    assert.ok(f.canvas().querySelector('.hive-map-resume-slot'));
    assert.equal(f.canvas().querySelector('.hive-map-resume-slot').querySelector('button').hidden, true);
    const css = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
    const hiddenResume = css.match(/\.hive-map-resume-slot > \.hive-zoom-btn\[hidden\]\s*\{([^}]+)\}/)?.[1];
    assert.match(hiddenResume || '', /display:\s*inline-flex/, 'hidden resume retains its natural width and height');
    assert.match(hiddenResume || '', /visibility:\s*hidden/, 'inactive resume is invisible and cannot receive focus');
  });
}

for (const label of ['Key', 'Show retired (1)']) {
  test(`activating ${label} keeps focus on the new menu trigger after a synchronous rebuild`, t => {
    const f = fixture(t);
    if (label !== 'Key') {
      f.ctx.hive.cells.gone = { id: 'gone', rootBeadId: 'gone', enabled: false, retired: { outcome: 'done' } };
      f.beads.gone = { id: 'gone', title: 'Gone', status: 'closed', kind: 'goal' };
      f.ui.closeCell(); f.draw();
    }
    const method = label === 'Key' ? 'setForm' : 'setShowRetired';
    const original = f.ui[method].bind(f.ui);
    f.ui[method] = (...args) => {
      original(...args);
      const focus = captureFocus(f.top);
      f.draw();
      document.activeElement = document.body;
      restoreFocus(f.top, focus);
    };
    const oldTrigger = f.canvas().querySelector('.hive-map-menu-toggle');
    oldTrigger.fire('click');
    const item = f.canvas().querySelector('.hive-map-menu').querySelectorAll('button').find(b => b.textContent === label);
    item.focus();
    item.fire('click');
    const nextTrigger = f.canvas().querySelector('.hive-map-menu-toggle');
    assert.ok(oldTrigger !== nextTrigger);
    assert.ok(document.activeElement === nextTrigger);
    assert.equal(nextTrigger.getAttribute('aria-expanded'), 'false');
  });
}

test('a live map rebuild restores hidden menu item focus to the hamburger', t => {
  const f = fixture(t);
  f.canvas().querySelector('.hive-map-menu-toggle').fire('click');
  const key = f.canvas().querySelector('.hive-map-menu').querySelectorAll('button').find(b => b.textContent === 'Key');
  key.focus();
  const focus = captureFocus(f.top);
  f.beads.title.status = 'in_progress';
  f.draw();
  document.activeElement = document.body;
  restoreFocus(f.top, focus);
  assert.ok(document.activeElement === f.canvas().querySelector('.hive-map-menu-toggle'));
});

test('one in-map query filters topics and messages while highlighting the map, and clearing restores both', t => {
  const f = fixture(t);
  const cell = f.ctx.hive.cells.cell;
  cell.threads = [
    { id: 'matching', title: 'Matching discussion', beads: [], retained: 2 },
    { id: 'other', title: 'Other discussion', beads: [], retained: 1 },
  ];
  cell.messages = [
    { id: 'm1', threadId: 'matching', n: 1, author: 'session', text: 'needle message', at: 1 },
    { id: 'm2', threadId: 'matching', n: 2, author: 'session', text: 'ordinary message', at: 2 },
    { id: 'm3', threadId: 'other', n: 3, author: 'session', text: 'unrelated', at: 3 },
  ];
  f.ui.setSearchQuery('needle'); f.draw();
  assert.equal(f.top.querySelectorAll('input').filter(e => e.getAttribute('type') === 'search').length, 1);
  assert.equal(f.canvas().querySelector('input').value, 'needle');
  assert.equal(f.tile('title').classList.contains('is-search-match'), true);
  assert.equal(f.tile('ws').classList.contains('is-search-dim'), true);
  assert.equal(f.dock().querySelectorAll('.hive-topic').length, 1);
  f.ui.openThreadFor('cell', 'matching', cell.threads[0]); f.draw();
  assert.equal(f.dock().querySelectorAll('.hive-message').length, 1);
  f.top.querySelector('input').fire('keydown', { key: 'Escape' }); f.draw();
  assert.equal(f.canvas().querySelectorAll('.is-search-dim').length, 0);
  assert.equal(f.dock().querySelectorAll('.hive-message').length, 2);
  f.ui.closeThread('cell'); f.draw();
  assert.equal(f.dock().querySelectorAll('.hive-topic').length, 2);
});

test('the same query follows cell and global views and finds read conversations outside the inbox', t => {
  const f = fixture(t);
  const cell = f.ctx.hive.cells.cell;
  cell.threads = [{ id: 'read', title: 'Read discussion', beads: [] }];
  cell.messages = [{ id: 'read1', threadId: 'read', author: 'session', text: 'needle already read', at: 1 }];
  cell.inbox = { human: { ids: [], count: 0 }, queen: { ids: [], count: 0 } };
  f.ui.setSearchQuery('needle');
  f.ui.closeCell(); f.ui.setGlobalInboxOpen(true);
  const top = f.draw();
  assert.equal(top.querySelectorAll('input').length, 1);
  assert.equal(top.querySelector('input').value, 'needle');
  assert.equal(top.querySelectorAll('.is-search-match').length, 1);
  assert.equal(f.dock().querySelectorAll('.hive-inbox-item').length, 1);
  top.querySelector('.hive-search-clear').fire('click'); f.draw();
  assert.equal(top.querySelectorAll('.is-search-match').length, 0);
  assert.equal(f.dock().querySelectorAll('.hive-inbox-item').length, 0);
  f.ui.openCell('cell');
  assert.equal(f.draw().querySelector('input').value, '');
});

test('Search opens inside both maps and Escape or clearing hides it while sharing the conversation query', t => {
  const f = fixture(t);
  for (const overview of [false, true]) {
    if (overview) f.ui.closeCell();
    const top = f.draw();
    const canvas = top.querySelector('.hive-canvas');
    const bar = canvas.querySelector('.hive-map-search');
    const trigger = canvas.querySelector('.hive-search-open');
    assert.ok(trigger.closest('.hive-zoom'));
    assert.equal(trigger.getAttribute('aria-pressed'), 'false');
    assert.equal(bar.hidden, true);
    assert.equal(top.querySelectorAll('.hive-global-search').length, 0);
    trigger.fire('click');
    assert.equal(bar.hidden, false);
    assert.equal(trigger.getAttribute('aria-pressed'), 'true');
    const input = bar.querySelector('input');
    assert.equal(document.activeElement, input);
    input.value = 'needle'; input.fire('input'); f.draw();
    assert.equal(f.ui.searchQuery(), 'needle');
    input.fire('keydown', { key: 'Escape' }); f.draw();
    assert.equal(f.ui.searchQuery(), '');
    assert.equal(bar.hidden, true);
    canvas.fire('keydown', { key: '/' });
    assert.equal(bar.hidden, false);
    input.value = 'needle'; input.fire('input');
    input.value = ''; input.fire('input');
    assert.equal(bar.hidden, true);
    assert.equal(f.ui.searchQuery(), '');
  }
});


test('overview has no footer hint and shares bottom-aligned map controls', t => {
  const f = fixture(t);
  f.ui.closeCell();
  const overview = f.draw();
  assert.equal(overview.querySelector('.hive-stage-hint'), null);
  assert.doesNotMatch(overview.textContent, /Drag hives to arrange/);
  const tools = overview.querySelector('.hive-zoom');
  assert.ok(tools.querySelector('.hive-search-open'));
  assert.ok(tools.querySelector('.hive-map-menu-launcher'));
  const css = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
  assert.doesNotMatch(css, /\.hive-overview\s+\.hive-zoom\s*\{/);
  assert.match(css.match(/\.hive-zoom\s*\{([^}]+)\}/)?.[1] || '', /bottom:\s*10px/);
  f.ctx.hive.cells = {};
  assert.match(f.draw().querySelector('.hive-stage-empty').textContent, /No hives yet/);
});


test('workstream menu suggests completion without opening a completion form or moving work', t => {
  const f = fixture(t);
  const sent = [], notices = [];
  f.ctx.send = (message, options) => sent.push([message, options]);
  f.ctx.notice = (...args) => notices.push(args);
  f.tile('ws').fire('keydown', { key: 'F10', shiftKey: true }); f.draw();
  const menu = f.top.querySelector('.hive-wsmenu');
  assert.doesNotMatch(menu.textContent, /Complete workstream|Arrange this workstream/);
  f.top.querySelector('[data-focus-key="wsmenu:suggest"]').fire('click');
  assert.deepEqual(sent[0][0], { type: 'hive-ws-suggest-completion', cellId: 'cell', headId: 'ws' });
  assert.ok(!f.ui.form('wscomplete:cell'));
  assert.ok(menu.querySelector('[data-focus-key="wsmenu:close-request"]'));
  sent[0][1].onReply({ ok: true, created: true, delivery: { state: 'delivered' } });
  assert.equal(notices[0][0], 'Completion suggested to the queen.');
  sent[0][1].onReply({ ok: true, created: false });
  assert.match(notices[1][0], /already has/);
  sent[0][1].onReply({ ok: false, error: 'Unavailable' });
  assert.deepEqual(notices[2], ['Unavailable', { severity: 'error' }]);
  assert.equal(f.beads.ws.status, 'open');
});

function autoFitMap(t, suffix = '') {
  fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const options = {
    viewKey: `intent-${t.name}-${suffix}`, size: 60,
    items: [{ id: 'edge', x: 900, y: 0, local: { q: 1, r: 0 }, titleText: 'Edge' }],
    bounds: { x: -60, y: -60, w: 1020, h: 120 },
  };
  return import('../public/hex-grid.js').then(({ renderHexMap }) => {
    const el = renderHexMap(options).el;
    document.body.replaceChildren(el);
    return { el, options, renderHexMap };
  });
}

test('edge focus and tile focus restoration reveal without pausing auto-fit', async t => {
  const { el, options, renderHexMap } = await autoFitMap(t);
  const tile = el.querySelector('[data-tile-id="edge"]');
  const outside = () => ({ left: 950, right: 1050, top: 0, bottom: 100, width: 100, height: 100 });
  tile.getBoundingClientRect = outside;
  const before = el.hiveCaptureView();
  tile.fire('focusin');
  assert.notEqual(el.hiveCaptureView().tx, before.tx);
  assert.equal(el.hiveCaptureView().auto, true);
  tile.focus();
  const captured = captureFocus(el);
  assert.equal(captured.tileId, 'edge');
  const next = renderHexMap(options).el;
  document.body.replaceChildren(next);
  const replacement = next.querySelector('[data-tile-id="edge"]');
  replacement.getBoundingClientRect = outside;
  replacement.focus = () => { document.activeElement = replacement; replacement.fire('focusin'); };
  restoreFocus(next, captured);
  assert.equal(document.activeElement, replacement);
  assert.equal(next.hiveCaptureView().auto, true);
});

test('programmatic pan and search restore cannot introduce a paused view', async t => {
  const { el } = await autoFitMap(t);
  const before = el.hiveCaptureView();
  el.hivePanTo('edge');
  assert.notEqual(el.hiveCaptureView().tx, before.tx);
  assert.equal(el.hiveCaptureView().auto, true);
  el.hiveRestoreView({ k: 1.2, tx: 50, ty: 70, auto: false });
  assert.deepEqual(el.hiveCaptureView(), { k: 1.2, tx: 50, ty: 70, auto: true });
  el.fire('wheel', { deltaX: 40, deltaY: 0 });
  el.hiveRestoreView({ ...before, auto: true });
  assert.equal(el.hiveCaptureView().auto, false, 'restore also preserves a deliberate pause');
});

test('search navigation and clearing keep auto-fit active', t => {
  const f = fixture(t);
  f.canvas().fire('keydown', { key: '0' });
  const input = f.search('needle');
  input.fire('keydown', { key: 'Enter' });
  assert.equal(f.canvas().hiveCaptureView().auto, true);
  input.fire('keydown', { key: 'Escape' });
  assert.equal(f.canvas().hiveCaptureView().auto, true);
});

for (const zoom of [false, true]) {
  test(`${zoom ? 'pinch zoom' : 'wheel pan'} ignores zero and small isolated movement, accepts a deliberate burst`, async t => {
    const { el } = await autoFitMap(t);
    const wheel = (delta, timeStamp) => el.fire('wheel', { deltaX: zoom ? 0 : delta, deltaY: zoom ? delta : 0, ctrlKey: zoom, timeStamp, clientX: 500, clientY: 350 });
    const before = el.hiveCaptureView();
    wheel(0, 0);
    wheel(zoom ? 0.25 : 3, 10);
    assert.deepEqual(el.hiveCaptureView(), before);
    wheel(zoom ? 0.25 : 3, 300);
    assert.deepEqual(el.hiveCaptureView(), before, 'separate tiny gestures do not accumulate');
    for (let i = 1; i <= 4; i++) wheel(zoom ? 0.5 : 3, 300 + i * 10);
    assert.equal(el.hiveCaptureView().auto, false);
    assert.notDeepEqual(el.hiveCaptureView(), before);
  });
}

test('wheel units, pointer threshold, zoom buttons and shortcuts still pause deliberately', async t => {
  const { el } = await autoFitMap(t);
  const resume = () => el.fire('keydown', { key: '0' });
  for (const deltaMode of [1, 2]) {
    resume();
    el.fire('wheel', { deltaMode, deltaX: 0, deltaY: 1 });
    assert.equal(el.hiveCaptureView().auto, false);
  }
  resume();
  const svg = el.querySelector('svg');
  svg.fire('pointerdown', { button: 0, clientX: 0, clientY: 0 });
  svg.fire('pointermove', { clientX: 1, clientY: 1 });
  assert.equal(el.hiveCaptureView().auto, true);
  svg.fire('pointermove', { clientX: 10, clientY: 0 });
  assert.equal(el.hiveCaptureView().auto, false);
  svg.fire('pointerup');
  for (const button of el.querySelectorAll('button').filter(b => ['Zoom in', 'Zoom out'].includes(b.getAttribute('aria-label')))) {
    resume(); button.fire('click'); assert.equal(el.hiveCaptureView().auto, false);
  }
  for (const key of ['+', '-']) {
    resume(); el.fire('keydown', { key }); assert.equal(el.hiveCaptureView().auto, false);
  }
});

test('session-restored transforms start active instead of reviving a stale pause', async t => {
  const { renderHexMap, options } = await autoFitMap(t);
  const saved = { k: 1, tx: 80, ty: 90, auto: false };
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: { getItem: () => JSON.stringify(saved), setItem() {} } });
  t.after(() => descriptor ? Object.defineProperty(globalThis, 'sessionStorage', descriptor) : delete globalThis.sessionStorage);
  const next = renderHexMap({ ...options, viewKey: `${options.viewKey}-session` }).el;
  assert.deepEqual(next.hiveCaptureView(), { ...saved, auto: true });
});

test('restoring map and control focus by data-focus-key keeps auto-fit active', async t => {
  const { el } = await autoFitMap(t);
  el.setAttribute('data-focus-key', 'map:test');
  for (const target of [el, el.querySelector('.hive-map-menu-toggle')]) {
    target.focus();
    const focus = captureFocus(document.body);
    assert.ok(focus.focusKey);
    document.activeElement = document.body;
    restoreFocus(document.body, focus);
    assert.equal(document.activeElement, target);
    assert.equal(el.hiveCaptureView().auto, true);
  }
});

test('resuming auto-fit requires fresh wheel intent even during the previous burst', async t => {
  const { el } = await autoFitMap(t);
  el.fire('wheel', { deltaX: 40, deltaY: 0, timeStamp: 0 });
  assert.equal(el.hiveCaptureView().auto, false);
  el.fire('keydown', { key: '0' });
  const before = el.hiveCaptureView();
  el.fire('wheel', { deltaX: 1, deltaY: 0, timeStamp: 10 });
  assert.deepEqual(el.hiveCaptureView(), before);
});

test('zoom at its limit does not pause an unchanged view', async t => {
  const { el } = await autoFitMap(t);
  el.hiveRestoreView({ k: 2.5, tx: 50, ty: 50 });
  const before = el.hiveCaptureView();
  el.fire('keydown', { key: '+' });
  assert.deepEqual(el.hiveCaptureView(), before);
});

test('slow wheel drift never accumulates into deliberate intent', async t => {
  const { el } = await autoFitMap(t);
  const before = el.hiveCaptureView();
  for (let timeStamp = 0; timeStamp < 2000; timeStamp += 20) {
    el.fire('wheel', { deltaX: 0.25, deltaY: 0, timeStamp });
  }
  assert.deepEqual(el.hiveCaptureView(), before);
});

for (const [event, props] of [['contextmenu', { button: 2, clientX: 50, clientY: 60 }], ['keydown', { key: 'ContextMenu' }], ['keydown', { key: 'F10', shiftKey: true }]]) test(`open item close request menu supports ${event} ${props.key || ''}`, t => {
  const f = fixture(t);
  const sent = [], notices = [];
  f.ctx.send = (message, options) => sent.push([message, options]);
  f.ctx.notice = (...args) => notices.push(args);
  f.tile('title').fire(event, props); f.draw();
  const action = f.top.querySelector('[data-focus-key="wsmenu:close-request"]');
  assert.ok(action, 'ordinary items offer a close request');
  assert.equal(f.top.querySelector('[data-focus-key="wsmenu:suggest"]'), null);
  f.top.querySelector('.hive-wsmenu').fire('keydown', { key: 'Escape' });
  assert.equal(document.activeElement, f.tile('title'));
  f.draw();
  f.tile('title').fire(event, props); f.draw();
  f.top.querySelector('[data-focus-key="wsmenu:close-request"]').fire('click');
  assert.deepEqual(sent[0][0], { type: 'hive-bead-suggest-completion', cellId: 'cell', beadId: 'title' });
  sent[0][1].onReply({ ok: true, created: false });
  assert.match(notices.at(-1)[0], /already has/);
  for (const state of ['failed', 'uncertain', 'no-queen']) {
    sent[0][1].onReply({ ok: true, created: true, delivery: { state } });
    assert.match(notices.at(-1)[0], /Delivery to the queen needs attention/);
    assert.equal(notices.at(-1)[1].severity, 'error');
  }
  assert.equal(f.beads.title.status, 'open');
});

for (const mode of ['closed', 'external', 'snapshot', 'retired', 'disabled']) test(`close request unavailable for ${mode} items`, t => {
  const f = fixture(t);
  const cell = f.ctx.hive.cells.cell;
  if (mode === 'closed') f.beads.title.status = 'closed';
  else if (mode === 'external') f.beads.title.kind = 'external';
  else if (mode === 'disabled') cell.enabled = false;
  else cell[mode] = mode === 'snapshot' ? {} : true;
  f.draw();
  f.canvas()?.querySelector('[data-tile-id="title"]')?.fire('keydown', { key: 'ContextMenu' }); f.draw();
  assert.equal(f.top.querySelector('[data-focus-key="wsmenu:close-request"]'), null);
  f.ui.setForm('wsMenu', { cellId: 'cell', headId: 'title', at: { x: 0, y: 0 } }); f.draw();
  assert.equal(f.top.querySelector('[data-focus-key="wsmenu:close-request"]'), null);
});
