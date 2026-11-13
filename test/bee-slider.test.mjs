import test from 'node:test';
import assert from 'node:assert/strict';
import { beeSlider } from '../public/bees.js';

import { installDom, walk, fire } from './helpers/dom.mjs';

function fixture(t, reduced = false) {
  installDom(t);
  const previous = Object.fromEntries(['matchMedia', 'setTimeout', 'clearTimeout'].map(k => [k, globalThis[k]]));
  const timers = new Map(); let serial = 0;
  Object.assign(globalThis, {
    matchMedia: () => ({ matches: reduced }),
    setTimeout: fn => { timers.set(++serial, fn); return serial; }, clearTimeout: id => timers.delete(id),
  });
  t.after(() => Object.assign(globalThis, previous));
  const previews = [], commits = [], holds = [];
  const tree = beeSlider({ value: 2, idKey: 'settings', onInput: v => previews.push(v), onCommit: v => commits.push(v), onHold: v => holds.push(v) });
  const input = walk(tree).find(el => el.getAttribute('type') === 'range');
  const thumb = walk(tree).find(el => el.getAttribute('class') === 'hive-bee-thumb');
  return { tree, input, thumb, previews, commits, holds, settle() { for (const [id, fn] of timers) { timers.delete(id); fn(); } } };
}

test('shared bee thumb decorates a labelled native range and follows its value', t => {
  const f = fixture(t);
  assert.ok(f.thumb, 'bee thumb is rendered');
  assert.equal(f.thumb.getAttribute('aria-hidden'), 'true');
  assert.ok(walk(f.thumb).some(el => el.tagName === 'svg'));
  assert.equal(f.thumb.style.left, '50%');
  assert.equal(walk(f.tree).find(el => el.tagName === 'label').getAttribute('for'), f.input.getAttribute('id'));
  assert.equal(f.input.getAttribute('aria-valuetext'), 'About right');
  assert.equal(f.input.getAttribute('tabindex'), null);
  f.input.value = '4'; fire(f.input, 'input');
  assert.equal(f.thumb.style.left, '100%');
  assert.equal(f.input.getAttribute('aria-valuetext'), 'Frankly too many bees');
  assert.deepEqual(f.previews, [4]);
  fire(f.input, 'change');
  assert.deepEqual(f.commits, [4]);
});

test('pointer drag and keyboard input flap the wings briefly and release holds', t => {
  const f = fixture(t);
  assert.ok(f.thumb, 'bee thumb is rendered');
  assert.notEqual(f.thumb.dataset.flapping, 'true');
  fire(f.input, 'pointerdown');
  assert.equal(f.thumb.dataset.flapping, 'true');
  f.settle();
  fire(f.input, 'pointermove', { buttons: 1 });
  assert.equal(f.thumb.dataset.flapping, 'true');
  fire(f.input, 'pointerup');
  const released = f.holds.length;
  f.settle();
  assert.equal(f.holds.length, released, 'released thumbs leave no timer that could release a newer gesture');
  assert.equal(f.thumb.dataset.flapping, 'false');
  f.input.value = '3'; fire(f.input, 'input');
  fire(f.input, 'change');
  assert.equal(f.holds.at(-1), true, 'keyboard animation holds rerenders until the wings settle');
  assert.equal(f.thumb.dataset.flapping, 'true');
  f.settle(); assert.equal(f.thumb.dataset.flapping, 'false');
  fire(f.input, 'pointerdown'); fire(f.input, 'blur');
  assert.equal(f.thumb.dataset.flapping, 'false');
  assert.equal(f.holds.at(-1), false);
});

test('reduced motion keeps the bee still while native changes still work', t => {
  const f = fixture(t, true);
  assert.ok(f.thumb, 'bee thumb is rendered');
  fire(f.input, 'pointerdown');
  f.input.value = '0'; fire(f.input, 'input');
  assert.notEqual(f.thumb.dataset.flapping, 'true');
  assert.equal(f.thumb.style.left, '0%');
  assert.deepEqual(f.previews, [0]);
});
