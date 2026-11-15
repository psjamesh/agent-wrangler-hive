import test from 'node:test';
import assert from 'node:assert/strict';
import { createBees } from '../public/bees.js';
import { installDom, Element } from './helpers/dom.mjs';

function world(t, { level = 2, reduced = false, random = 0.1 } = {}) {
  let bees;
  t.after(() => bees?.unmount());
  installDom(t);
  const old = Object.fromEntries(['Element', 'matchMedia', 'setTimeout', 'clearTimeout'].map(k => [k, globalThis[k]]));
  const oldRandom = Math.random;
  const animations = [], timers = new Map(), events = {};
  let serial = 0, motion;
  Math.random = typeof random === 'function' ? random : () => random;
  Object.assign(globalThis, {
    Element,
    matchMedia: () => ({ matches: reduced, addEventListener: (_, fn) => { motion = fn; }, removeEventListener() {} }),
    setTimeout: fn => { timers.set(++serial, fn); return serial; }, clearTimeout: id => timers.delete(id),
  });
  const previousAnimate = Element.prototype.animate;
  Element.prototype.animate = function (frames, options) {
    const anim = { el: this, frames, options, cancelled: false, cancel() { this.cancelled = true; } };
    animations.push(anim); return anim;
  };
  t.after(() => { Object.assign(globalThis, old); Math.random = oldRandom; Element.prototype.animate = previousAnimate; });
  document.visibilityState = 'visible';
  document.addEventListener = (key, fn) => { events[key] = fn; };
  document.removeEventListener = key => { delete events[key]; };
  const comb = new Element('div');
  comb.checkVisibility = () => true;
  comb.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600 });
  const root = new Element('div'); document.body.append(root);
  root.querySelector = () => comb;
  bees = createBees({ level: () => level }); bees.mount(root);
  return { root, comb, bees, animations, timers,
    visit() { const [id, fn] = timers.entries().next().value; timers.delete(id); fn(); },
    level(value) { level = value; bees.sync(); },
    reduced(value) { reduced = value; motion(); },
    visible(value) { document.visibilityState = value ? 'visible' : 'hidden'; events.visibilitychange(); },
  };
}

const isBee = a => a.el.getAttribute('class') === 'hive-bee';
const points = frames => frames.map(f => /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(f.transform).slice(1).map(Number));

test('bees always have trails and occasional loop geometry', t => {
  const w = world(t); w.visit();
  const bee = w.animations.find(isBee), dots = w.animations.filter(a => !isBee(a));
  assert.equal(dots.length, 16);
  assert.equal(w.root.children[0].getAttribute('aria-hidden'), 'true');
  const p = points(bee.frames);
  const backwards = p.some((v, i) => i && v[0] < p[i - 1][0]);
  assert.equal(backwards, true, 'a loop travels backwards during a left-to-right flight');
  for (const dot of dots) {
    assert.equal(dot.options.duration, bee.options.duration + 2000);
    assert.equal(dot.options.delay || 0, 0);
    assert.equal(dot.frames[0].opacity, 0);
    assert.equal(dot.frames.at(-1).opacity, 0);
    for (let i = 1; i < dot.frames.length; i++) {
      const prev = dot.frames[i - 1], frame = dot.frames[i];
      if (prev.opacity > 0 || frame.opacity > 0) {
        assert.equal(frame.transform, prev.transform, 'visible dots never move');
      }
    }
  }
});

test('Acrobatics only occasionally adds a loop', t => {
  const w = world(t, { random: 0.9 }); w.visit();
  const p = points(w.animations.find(isBee).frames);
  assert.ok(p.every((v, i) => !i || v[0] < p[i - 1][0]));
});

test('bees respect zero bees and reduced motion', t => {
  const w = world(t, { level: 0 }); assert.equal(w.timers.size, 0);
  w.level(2); w.reduced(true); assert.equal(w.timers.size, 0); assert.equal(w.animations.length, 0);
  w.reduced(false); w.visit(); assert.ok(w.animations.length);
  w.reduced(true); assert.ok(w.animations.every(a => a.cancelled)); assert.equal(w.root.children.length, 0);
});

test('hidden tabs and unmount clean up every trail', t => {
  const w = world(t); w.visit();
  w.visible(false); assert.ok(w.animations.every(a => a.cancelled)); assert.equal(w.timers.size, 0);
  w.visible(true); w.visit();
  w.bees.unmount(); assert.ok(w.animations.every(a => a.cancelled)); assert.equal(w.root.children.length, 0);
});

test('the last trail dot completes before the flight is cleaned up', t => {
  const w = world(t); w.visit();
  const bee = w.animations.find(isBee), last = w.animations.filter(a => !isBee(a)).at(-1);
  bee.onfinish?.(); assert.equal(last.cancelled, false);
  last.onfinish(); assert.ok(w.animations.every(a => a.cancelled));
  assert.equal(w.root.children[0].children.length, 0);
});

test('Acrobatics turns continuously in both flight directions', t => {
  let calls = 0;
  const w = world(t, { random: () => ++calls === 3 ? 0.9 : 0.1 });
  w.visit();
  const frames = w.animations.find(isBee).frames;
  const angles = frames.map(f => Number(/rotate\((-?[\d.]+)deg\)/.exec(f.transform)[1]));
  assert.ok(Math.max(...angles) - Math.min(...angles) > 300);
  assert.ok(angles.every((a, i) => !i || Math.abs(a - angles[i - 1]) < 60));
});

test('trail work stays bounded by the bee count and leaves with its map', t => {
  const w = world(t, { level: 4 });
  for (let i = 0; i < 12; i++) w.visit();
  assert.equal(w.animations.length, 12 * 17);
  assert.equal(w.timers.size, 0);
  w.comb.checkVisibility = () => false;
  w.bees.keep();
  assert.ok(w.animations.every(a => a.cancelled));
  assert.equal(w.root.children[0].children.length, 0);
  assert.equal(w.timers.size, 0);
});

for (const rightward of [true, false]) {
  test(`bees emit from the tail along the actual ${rightward ? 'rightward' : 'leftward'} path`, t => {
    let calls = 0;
    const w = world(t, { random: () => ++calls === 3 && !rightward ? 0.9 : 0.1 }); w.visit();
    const bee = w.animations.find(isBee), dots = w.animations.filter(a => !isBee(a));
    assert.ok(bee.frames[0].transform.endsWith(`scaleX(${rightward ? 1 : -1})`));
    const positions = points(bee.frames);
    const size = Number(bee.el.children[0].getAttribute('width'));
    let emissions = 0;
    for (const dot of dots) for (let i = 0; i < dot.frames.length; i++) {
      const frame = dot.frames[i];
      if (frame.opacity !== 0.5) continue;
      emissions++;
      const time = frame.offset * dot.options.duration;
      assert.ok(time <= bee.options.duration);
      const sample = time / bee.options.duration * (bee.frames.length - 1);
      const lo = Math.floor(sample), hi = Math.min(lo + 1, positions.length - 1), mix = sample - lo;
      const angle = j => Number(/rotate\((-?[\d.]+)deg\)/.exec(bee.frames[j].transform)[1]);
      const rad = (angle(lo) + (angle(hi) - angle(lo)) * mix) * Math.PI / 180;
      const x = positions[lo][0] + (positions[hi][0] - positions[lo][0]) * mix;
      const y = positions[lo][1] + (positions[hi][1] - positions[lo][1]) * mix;
      const [dx, dy] = points([frame])[0];
      const tailX = -14 * size / 30 * (rightward ? 1 : -1), tailY = 2 * size / 30;
      assert.ok(Math.abs(dx - (x + tailX * Math.cos(rad) - tailY * Math.sin(rad))) < 0.15);
      assert.ok(Math.abs(dy - (y + tailX * Math.sin(rad) + tailY * Math.cos(rad))) < 0.15);
      const faded = dot.frames[i + 1];
      assert.equal(faded.opacity, 0);
      assert.ok(Math.abs((faded.offset - frame.offset) * dot.options.duration - 2000) < 0.001);
    }
    assert.equal(emissions, Math.floor(bee.options.duration / 125) + 1);
  });
}
