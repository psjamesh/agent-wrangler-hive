import test from 'node:test';
import assert from 'node:assert/strict';
import { beeSlider } from '../public/bees.js';

class Element {
  constructor(tag) { this.tag = tag; this.attrs = {}; this.children = []; this.events = {}; this.style = {}; this.dataset = {}; }
  setAttribute(k, v) { this.attrs[k] = v; }
  append(child) { this.children.push(child); }
  addEventListener(k, fn) { this.events[k] = fn; }
}
const walk = el => [el, ...el.children.flatMap(walk)];
function fixture(t, reduced = false) {
  const previous = Object.fromEntries(['Node', 'document', 'matchMedia', 'setTimeout', 'clearTimeout'].map(k => [k, globalThis[k]]));
  const timers = new Map(); let serial = 0;
  Object.assign(globalThis, {
    Node: Element,
    document: { createElement: tag => new Element(tag), createElementNS: (_, tag) => new Element(tag), createTextNode: text => Object.assign(new Element('#text'), { text }) },
    matchMedia: () => ({ matches: reduced }),
    setTimeout: fn => { timers.set(++serial, fn); return serial; }, clearTimeout: id => timers.delete(id),
  });
  t.after(() => Object.assign(globalThis, previous));
  const previews = [], commits = [], holds = [];
  const tree = beeSlider({ value: 2, idKey: 'settings', onInput: v => previews.push(v), onCommit: v => commits.push(v), onHold: v => holds.push(v) });
  const input = walk(tree).find(el => el.attrs.type === 'range');
  const thumb = walk(tree).find(el => el.attrs.class === 'hive-bee-thumb');
  return { tree, input, thumb, previews, commits, holds, settle() { for (const [id, fn] of timers) { timers.delete(id); fn(); } } };
}

test('shared bee thumb decorates a labelled native range and follows its value', t => {
  const f = fixture(t);
  assert.ok(f.thumb, 'bee thumb is rendered');
  assert.equal(f.thumb.attrs['aria-hidden'], 'true');
  assert.ok(walk(f.thumb).some(el => el.tag === 'svg'));
  assert.equal(f.thumb.style.left, '50%');
  assert.equal(walk(f.tree).find(el => el.tag === 'label').attrs.for, f.input.attrs.id);
  assert.equal(f.input.attrs['aria-valuetext'], 'About right');
  assert.equal(f.input.attrs.tabindex, undefined);
  f.input.value = '4'; f.input.events.input({ target: f.input });
  assert.equal(f.thumb.style.left, '100%');
  assert.equal(f.input.attrs['aria-valuetext'], 'Frankly too many bees');
  assert.deepEqual(f.previews, [4]);
  f.input.events.change({ target: f.input });
  assert.deepEqual(f.commits, [4]);
});

test('pointer drag and keyboard input flap the wings briefly and release holds', t => {
  const f = fixture(t);
  assert.ok(f.thumb, 'bee thumb is rendered');
  assert.notEqual(f.thumb.dataset.flapping, 'true');
  f.input.events.pointerdown({ target: f.input });
  assert.equal(f.thumb.dataset.flapping, 'true');
  f.settle();
  f.input.events.pointermove({ buttons: 1 });
  assert.equal(f.thumb.dataset.flapping, 'true');
  f.input.events.pointerup();
  const released = f.holds.length;
  f.settle();
  assert.equal(f.holds.length, released, 'released thumbs leave no timer that could release a newer gesture');
  assert.equal(f.thumb.dataset.flapping, 'false');
  f.input.value = '3'; f.input.events.input({ target: f.input });
  f.input.events.change({ target: f.input });
  assert.equal(f.holds.at(-1), true, 'keyboard animation holds rerenders until the wings settle');
  assert.equal(f.thumb.dataset.flapping, 'true');
  f.settle(); assert.equal(f.thumb.dataset.flapping, 'false');
  f.input.events.pointerdown({ target: f.input }); f.input.events.blur();
  assert.equal(f.thumb.dataset.flapping, 'false');
  assert.equal(f.holds.at(-1), false);
});

test('reduced motion keeps the bee still while native changes still work', t => {
  const f = fixture(t, true);
  assert.ok(f.thumb, 'bee thumb is rendered');
  f.input.events.pointerdown({ target: f.input });
  f.input.value = '0'; f.input.events.input({ target: f.input });
  assert.notEqual(f.thumb.dataset.flapping, 'true');
  assert.equal(f.thumb.style.left, '0%');
  assert.deepEqual(f.previews, [0]);
});
