import test from 'node:test';
import assert from 'node:assert/strict';
import { beeScaleOf, createBees, BEE_SCALE_MIN, BEE_SCALE_MAX } from '../public/bees.js';

class Element {
  constructor(tag) { this.tag = tag; this.attrs = {}; this.children = []; this.events = {}; this.style = {}; this.dataset = {}; }
  setAttribute(k, v) { this.attrs[k] = v; }
  append(...c) { this.children.push(...c); }
  addEventListener(k, fn) { this.events[k] = fn; }
}
const walk = el => [el, ...(el.children || []).flatMap(walk)];

function dom(t) {
  const previous = Object.fromEntries(['Node', 'document'].map(k => [k, globalThis[k]]));
  Object.assign(globalThis, {
    Node: Element,
    document: { createElement: tag => new Element(tag), createElementNS: (_, tag) => new Element(tag), createTextNode: text => Object.assign(new Element('#text'), { text }) },
  });
  t.after(() => Object.assign(globalThis, previous));
}

test('a bee scale is stable for its id and always between S and L', () => {
  assert.equal(BEE_SCALE_MIN, 0.7);
  assert.equal(BEE_SCALE_MAX, 1.4);
  for (let i = 0; i < 2000; i++) {
    const v = beeScaleOf(`bee-${i}`);
    assert.ok(v >= BEE_SCALE_MIN && v <= BEE_SCALE_MAX, String(v));
    assert.equal(beeScaleOf(`bee-${i}`), v);
  }
});

test('bee scales spread across the whole range', () => {
  const v = Array.from({ length: 2000 }, (_, i) => beeScaleOf(`session-${i}`));
  assert.ok(Math.min(...v) < 0.78 && Math.max(...v) > 1.32);
  assert.ok(new Set(v.map(x => x.toFixed(3))).size > 400);
  const thirds = [0, 0, 0];
  for (const x of v) thirds[Math.min(2, Math.floor((x - 0.7) / (0.7 / 3)))]++;
  assert.ok(thirds.every(n => n > 500), thirds.join());
});

function stubWorld(t) {
  dom(t);
  const previous = Object.fromEntries(['Element', 'matchMedia', 'setTimeout', 'clearTimeout', 'getComputedStyle'].map(k => [k, globalThis[k]]));
  const animations = [];
  const timers = new Map(); let serial = 0;
  Element.prototype.animate = function (frames) { animations.push({ el: this, frames }); return { cancel() {}, set onfinish(_) {} }; };
  Element.prototype.remove = function () { this.removed = true; };
  Element.prototype.querySelector = function () { return comb; };
  const comb = Object.assign(new Element('div'), {
    checkVisibility: () => true,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
  });
  Object.assign(globalThis, {
    Element,
    matchMedia: () => ({ matches: false }),
    setTimeout: fn => { timers.set(++serial, fn); return serial; }, clearTimeout: id => timers.delete(id),
  });
  t.after(() => { Object.assign(globalThis, previous); delete Element.prototype.animate; });
  const root = Object.assign(new Element('div'), { isConnected: true });
  Object.defineProperty(globalThis, 'document', { value: { ...globalThis.document, visibilityState: 'visible', addEventListener() {}, removeEventListener() {} }, configurable: true, writable: true });
  return { animations, root, fire() { const [[id, fn]] = [...timers]; timers.delete(id); fn(); } };
}

const svgWidth = a => Number(walk(a.el).find(e => e.tag === 'svg').attrs.width);

test('each bee flies at its own size within S to L and its path matches that size', t => {
  const w = stubWorld(t);
  const bees = createBees({ level: () => 4 });
  bees.mount(w.root);
  for (let i = 0; i < 12; i++) w.fire();
  assert.ok(w.animations.length >= 10);
  const widths = w.animations.map(svgWidth);
  for (const width of widths) assert.ok(width >= 30 * BEE_SCALE_MIN - 1e-9 && width <= 30 * BEE_SCALE_MAX + 1e-9, String(width));
  assert.ok(new Set(widths).size > 1, 'bees differ in size');
  for (const a of w.animations) {
    const scale = svgWidth(a) / 30;
    const first = Number(/translate\((-?[\d.]+)px/.exec(a.frames[0].transform)[1]);
    assert.ok(Math.abs(Math.abs(first < 0 ? first : first - 800) - 30 * scale * 1.5) < 0.1, 'enters just outside the box');
  }
  bees.unmount();
});

test('rerenders and syncs keep a flying bee at its size', t => {
  const w = stubWorld(t);
  const bees = createBees({ level: () => 2 });
  bees.mount(w.root);
  w.fire();
  const el = w.animations[0].el;
  const width = svgWidth(w.animations[0]);
  bees.sync(); bees.keep(); bees.sync();
  assert.notEqual(el.removed, true);
  assert.equal(svgWidth(w.animations[0]), width);
  bees.unmount();
});

test('createBees ignores any size option and a stale saved size', t => {
  const w = stubWorld(t);
  const bees = createBees({ level: () => 2, size: () => 99 });
  bees.mount(w.root);
  w.fire();
  const width = svgWidth(w.animations[0]);
  assert.ok(width >= 21 - 1e-9 && width <= 42 + 1e-9);
  bees.unmount();
});
