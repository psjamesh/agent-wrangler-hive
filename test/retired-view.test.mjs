import test from 'node:test';
import assert from 'node:assert/strict';
import { renderHexMap } from '../public/hex-grid.js';
import { renderHive } from '../public/hive-view.js';
import client, { createUi } from '../public/client.js';
import { projectForGraph } from '../server/projection.js';

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

function fixture(t) {
  const saved = Object.fromEntries(['Node', 'document', 'requestAnimationFrame', 'cancelAnimationFrame', 'CSS'].map(k => [k, globalThis[k]]));
  Object.assign(globalThis, { Node: Element, document: { createElement: t => new Element(t), createElementNS: (_, t) => new Element(t), createTextNode: t => Object.assign(new Element('#text'), { text: t }), body: new Element('body') }, requestAnimationFrame: () => 1, cancelAnimationFrame() {}, CSS: { escape: s => s } });
  t.after(() => Object.assign(globalThis, saved));
  const store = new Map();
  client.register({ api: { storage: { get: (k) => store.get(k), set: (k, v) => store.set(k, v), remove: (k) => store.delete(k) } }, register() {} });
  const cells = {
    live: { id: 'live', taskId: 't1', enabled: true, rootBeadId: 'r1', queenSessionId: 'q', position: { q: 0, r: 0 } },
    gone: { id: 'gone', taskId: 't2', enabled: false, rootBeadId: 'r2', position: { q: 2, r: 0 }, retired: { outcome: 'done', summary: 'shipped it', at: 1, by: 'aw:human', position: { q: 2, r: 0 } } },
  };
  const beads = { r1: { id: 'r1', title: 'Live', kind: 'goal', status: 'in_progress' }, r2: { id: 'r2', title: 'Gone', kind: 'goal', status: 'closed' }, w2: { id: 'w2', title: 'Old work', parentId: 'r2', kind: 'task', status: 'closed', outcome: 'done' } };
  const doc = { cells, conversation: {}, threads: {}, inbox: {}, bindings: {}, beadLayout: {}, arrangeAspect: {}, restoreNotices: {}, operations: {}, launches: {}, requests: {}, archived: {} };
  const runtime = { metadata: { read: () => doc, cells: () => Object.values(doc.cells) }, beads: { status: { state: 'missing' } }, paths: {} };
  const ui = createUi();
  const sent = [];
  const hive = () => projectForGraph({ runtime, snapshot: { graph: { beads, edges: [] } } });
  const draw = () => renderHive({ ui, hive: hive(), graph: { sessions: [] }, api: {}, notices: [], busy: () => false, send: (m) => sent.push(m), notice() {} });
  return { doc, ui, draw, hive, sent };
}
const text = (el) => el.textContent;

test('a retired hive keeps its beads in the projection', (t) => {
  const f = fixture(t);
  const hive = f.hive();
  assert.ok(hive.beads.w2);
  assert.equal(hive.cells.gone.retired.outcome, 'done');
  assert.equal(hive.cells.gone.beadCount, 2);
});

test('retired hives are off the All hives map until Show retired, which is remembered', (t) => {
  const f = fixture(t);
  let top = f.draw().top;
  assert.ok(top.querySelector('[data-tile-id="live"]'));
  assert.equal(top.querySelector('[data-tile-id="gone"]'), null);
  const toggle = () => f.draw().top.querySelector('[data-focus-key="show-retired"]');
  assert.match(text(toggle()), /Show retired \(1\)/);
  f.ui.setShowRetired(true);
  top = f.draw().top;
  const tile = top.querySelector('[data-tile-id="gone"]');
  assert.ok(tile);
  assert.match(tile.getAttribute('class'), /is-retired/);
  assert.ok(tile.querySelector('.hive-pm-done'), 'outcome mark follows the closed-work style');
  assert.match(text(toggle()), /Hide retired \(1\)/);
  assert.equal(f.ui.showRetired(), true);
  f.ui.setShowRetired(false);
  assert.equal(f.draw().top.querySelector('[data-tile-id="gone"]'), null);
});

test('no toggle appears when nothing is retired', (t) => {
  const f = fixture(t);
  delete f.doc.cells.gone.retired;
  assert.equal(f.draw().top.querySelector('[data-focus-key="show-retired"]'), null);
});

test('a shown retired hive opens read-only with its map, marked Retired, and offers Reopen', (t) => {
  const f = fixture(t);
  f.ui.setShowRetired(true);
  f.ui.openCell('gone');
  const top = f.draw().top;
  assert.match(text(top), /Retired · done/);
  assert.match(text(top), /Reopen hive…/);
  assert.ok(top.querySelector('[data-tile-id="w2"]'), 'its map is drawn');
  assert.doesNotMatch(text(top), /Turn on/);
});
