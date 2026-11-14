import test from 'node:test';
import assert from 'node:assert/strict';

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
import client, { createUi } from '../public/client.js';

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
  matches(selector) { return selector.split(',').some(part => { const s = part.trim(); if (s.startsWith('.')) return s.slice(1).split('.').every(c => this.classList.contains(c)); const a = s.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/); return a ? this.getAttribute(a[1]) !== null && (a[2] === undefined || this.getAttribute(a[1]) === a[2]) : this.tagName === s; }); }
  closest(s) { for (let el = this; el; el = el.parentNode) if (el.matches(s)) return el; return null; }
  querySelectorAll(s) { return this.children.flatMap(n => [...(n.matches(s) ? [n] : []), ...n.querySelectorAll(s)]); }
  querySelector(s) { return this.querySelectorAll(s)[0] || null; }
  contains(n) { return n === this || this.children.some(c => c.contains(n)); }
  focus() { document.activeElement = this; }
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
  const draw = () => { const out = renderHive(ctx); dock = out.bottom; return out.top; };
  const top = draw();
  document.body.append(top);
  const canvas = () => top.querySelector('.hive-canvas');
  const search = query => { canvas().focus(); canvas().fire('keydown', { key: '/' }); const input = canvas().querySelector('input'); input.value = query; input.fire('input'); return input; };
  return { values, ui, ctx, beads, top, dock: () => dock, draw, canvas, search, tile: id => canvas().querySelector(`[data-tile-id="${id}"]`) };
}

test('map search uses shared fields in a labelled search region', t => {
  const f = fixture(t);
  const bar = f.canvas().querySelector('.hive-map-search');
  assert.equal(bar.getAttribute('role'), 'search');
  assert.equal(bar.getAttribute('aria-label'), 'Search beads');
  const row = bar.querySelector('.hive-search-row');
  assert.equal(row.querySelector('input').classList.contains('hive-input'), true);
  assert.equal(row.querySelector('select').classList.contains('hive-input'), true);
  assert.equal(row.querySelector('button').classList.contains('hive-quiet-btn'), true);
  assert.equal(f.canvas().querySelector('.hive-search-open').classList.contains('hive-btn'), true);
  f.ui.closeCell();
  f.ui.setGlobalInboxOpen(true);
  f.draw();
  assert.equal(f.dock().querySelector('.hive-inbox-search-input').classList.contains('hive-input'), true);
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
  const input = canvas.querySelector('input'); assert.equal(input.value, 'n'); assert.equal(document.activeElement, input);
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
  f.draw(); assert.equal(f.canvas(), canvas); assert.equal(canvas.querySelector('input'), input);
  f.beads.goal.goal = 'changed'; f.ctx.hive.revision = 2; f.draw(); assert.equal(f.canvas(), canvas); assert.equal(f.tile('goal').classList.contains('is-search-match'), false);
  input.fire('keydown', { key: 'Escape' });
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
  assert.equal(f.canvas().querySelector('input').value, 'needle');
  assert.equal(f.canvas().querySelector('.hive-search-count').textContent, '4 matches · 1 revealed from Hide done');
  f.canvas().querySelector('input').fire('keydown', { key: 'Escape' }); f.draw();
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
    assert.ok(f.canvas().querySelector('.hive-search-field').textContent.endsWith(`— ${{ id: 'bead id', nextAction: 'next action' }[field] || field}`));
  }
  input.value = 'no results'; input.fire('input');
  assert.equal(f.canvas().querySelector('.hive-search-count').textContent, '0 matches');
  input.fire('keydown', { key: 'Escape' });
  for (const props of [{ key: 'a', ctrlKey: true }, { key: 'a', metaKey: true }, { key: 'a', altKey: true }, { key: 'a', isComposing: true }]) {
    f.canvas().fire('keydown', props); assert.equal(f.canvas().querySelector('.hive-map-search').hidden, true);
  }
  f.canvas().fire('keydown', { key: ' ' }); assert.equal(f.canvas().querySelector('.hive-map-search').hidden, false);
  f.canvas().focus(); f.canvas().fire('keydown', { key: 'Escape' });
  assert.equal(f.canvas().querySelector('.hive-map-search').hidden, true);
});

test('returning to an open search preserves its query and appends typing from the map', t => {
  const f = fixture(t); const input = f.search('need');
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
  f.canvas().querySelector('input').fire('keydown', { key: 'Escape' }); f.draw();
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
  assert.ok(f.top.querySelector('[data-focus-key="wsmenu:arrange"]'));
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
    assert.equal(toggle.getAttribute('aria-pressed'), 'true');
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
    canvas.querySelectorAll('button').find(b => b.textContent === 'Fit').fire('click');
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
