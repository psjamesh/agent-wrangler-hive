import { h } from './dom.js';
import { reducedMotion } from './hex-grid.js';

// Decoration only: bees drift across the honeycomb now and then. They mean
// nothing about the work, take no pointer events and are hidden from
// assistive technology. Number of bees, one preference for every hive, sets
// how often they come and how many may fly at once, from none at all; About
// right is one occasional visitor.

export const BEE_LEVEL_SETTING = 'beeLevel';
// Hive 0.1.9 and earlier read only this switch. It is kept in step with the
// level, and read when no level has been stored yet: off means None.
export const BEES_SETTING = 'showBees';
export const BEE_LEVELS = [
  { text: 'None', max: 0 },
  { text: 'A few', first: [8000, 15000], next: [60000, 120000], max: 1 },
  { text: 'About right', first: [3000, 6000], next: [30000, 60000], max: 1 },
  { text: 'Lots', first: [1500, 3000], next: [5000, 10000], max: 3 },
  { text: 'Frankly too many bees', first: [300, 800], next: [600, 1400], max: 12 },
];
export const DEFAULT_BEE_LEVEL = 2;
export const BEE_SCALE_MIN = 0.7;
export const BEE_SCALE_MAX = 1.4;
const FLIGHT_MS = [7000, 10000];
const SIZE = 30;

export function beeScaleOf(id) {
  let hash = 2166136261;
  for (const ch of String(id)) hash = Math.imul(hash ^ ch.charCodeAt(0), 16777619) >>> 0;
  hash = Math.imul(hash ^ (hash >>> 15), 2246822507) >>> 0;
  hash = (hash ^ (hash >>> 13)) >>> 0;
  return BEE_SCALE_MIN + (hash / 4294967296) * (BEE_SCALE_MAX - BEE_SCALE_MIN);
}

export function beeLevelOf(values) {
  const v = values?.[BEE_LEVEL_SETTING];
  if (Number.isInteger(v) && v >= 0 && v < BEE_LEVELS.length) return v;
  return values?.[BEES_SETTING] === false ? 0 : DEFAULT_BEE_LEVEL;
}

const rand = ([a, b]) => a + Math.random() * (b - a);

function beeEl(scale = 1) {
  const size = SIZE * scale;
  const props = { class: 'hive-bee' };
  if (scale !== 1) props.style = { margin: `${(-13 * scale).toFixed(1)}px 0 0 ${(-15 * scale).toFixed(1)}px` };
  return h('div', props,
    h('svg:svg', { viewBox: '-16 -14 32 28', width: String(size), height: String(Math.round(size * 0.875)) },
      h('svg:ellipse', { class: 'hive-bee-wing hive-bee-wing-back', cx: '-2', cy: '-7', rx: '6', ry: '8.5' }),
      h('svg:path', { class: 'hive-bee-sting', d: 'M-12.5 1 L-16 2 L-12.5 3.2 Z' }),
      h('svg:ellipse', { class: 'hive-bee-body', cx: '-1', cy: '2', rx: '11.5', ry: '7.5' }),
      h('svg:path', { class: 'hive-bee-stripe', d: 'M-6 -4.9 Q-4 2 -6 8.9 L-3.2 9.4 Q-1.2 2 -3.2 -5.4 Z' }),
      h('svg:path', { class: 'hive-bee-stripe', d: 'M0.6 -5.5 Q2.6 2 0.6 9.5 L3.4 9.2 Q5.4 2 3.4 -5.2 Z' }),
      h('svg:circle', { class: 'hive-bee-head', cx: '10.5', cy: '0.5', r: '5' }),
      h('svg:circle', { class: 'hive-bee-eye', cx: '12.4', cy: '-0.6', r: '1.1' }),
      h('svg:path', { class: 'hive-bee-feeler', d: 'M12 -4 Q13.5 -9 16 -9.5' }),
      h('svg:ellipse', { class: 'hive-bee-wing hive-bee-wing-front', cx: '2', cy: '-7.5', rx: '5.5', ry: '8' })));
}

// A gentle curve from one side of the box to the other, with a little
// bobbing. Returns keyframes that turn the bee to follow its path.
function flightFrames(w, hgt, scale = 1) {
  const size = SIZE * scale;
  const fromLeft = Math.random() < 0.5;
  const y0 = hgt * (0.15 + Math.random() * 0.7);
  const y3 = hgt * (0.15 + Math.random() * 0.7);
  const x0 = fromLeft ? -size * 1.5 : w + size * 1.5;
  const x3 = fromLeft ? w + size * 1.5 : -size * 1.5;
  const c1 = { x: x0 + (x3 - x0) * 0.3, y: y0 + (Math.random() - 0.5) * hgt * 0.9 };
  const c2 = { x: x0 + (x3 - x0) * 0.7, y: y3 + (Math.random() - 0.5) * hgt * 0.9 };
  const at = (t) => {
    const u = 1 - t;
    return {
      x: u * u * u * x0 + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * x3,
      y: u * u * u * y0 + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * y3,
    };
  };
  const steps = 48;
  const bob = (4 + Math.random() * 4) * scale;
  const frames = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const p = at(t);
    const q = at(Math.min(1, t + 0.01));
    const r = at(Math.max(0, t - 0.01));
    let angle = Math.atan2(q.y - r.y, q.x - r.x) * 180 / Math.PI;
    if (!fromLeft) angle -= 180;
    angle = ((angle + 540) % 360) - 180;
    const y = p.y + Math.sin(t * Math.PI * 7) * bob;
    const flip = fromLeft ? 1 : -1;
    frames.push({ transform: `translate(${p.x.toFixed(1)}px, ${y.toFixed(1)}px) rotate(${(angle * 0.6).toFixed(1)}deg) scaleX(${flip})` });
  }
  return frames;
}

export function createBees({ level }) {
  let root = null;
  let layer = null;
  let timer = 0;
  const flights = new Set();
  let motionQuery = null;
  let lastLevel = null;
  const salt = Math.random().toString(36).slice(2);
  let serial = 0;
  const plan = () => BEE_LEVELS[level()] || BEE_LEVELS[0];
  const allowed = () => Boolean(root?.isConnected) && plan().max > 0 && !reducedMotion() && document.visibilityState !== 'hidden';

  const endFlight = (f) => {
    try { f.anim.cancel(); } catch { }
    f.el.remove();
    flights.delete(f);
  };
  const stopFlights = () => { for (const f of [...flights]) endFlight(f); };
  const stop = () => {
    clearTimeout(timer);
    timer = 0;
    stopFlights();
    layer?.remove();
  };
  const schedule = (key) => {
    clearTimeout(timer);
    timer = 0;
    if (!allowed()) return;
    timer = setTimeout(visit, rand(plan()[key]));
  };

  // The honeycomb bees may fly over: the one shown, not one hidden behind a
  // panel tab, which keeps its size while it is out of sight.
  const shownComb = () => {
    const comb = root?.querySelector('.hive-canvas');
    if (!comb) return null;
    const shown = typeof comb.checkVisibility === 'function'
      ? comb.checkVisibility({ visibilityProperty: true })
      : getComputedStyle(comb).visibility !== 'hidden';
    return shown ? comb : null;
  };

  const sameBox = (a, b) => Math.abs(a.left - b.left) < 2 && Math.abs(a.top - b.top) < 2
    && Math.abs(a.width - b.width) < 2 && Math.abs(a.height - b.height) < 2;

  // Each visit starts one bee, then waits for the next one while there is
  // room for another; at the level's limit, the next waits until one lands.
  function visit() {
    timer = 0;
    if (!allowed()) return;
    if (flights.size >= plan().max) return;
    const comb = shownComb();
    const box = comb?.getBoundingClientRect();
    if (!box || box.width < 160 || box.height < 120 || typeof Element.prototype.animate !== 'function') return schedule('next');
    const view = comb.dataset.viewKey || '';
    for (const f of [...flights]) if (f.view !== view || !sameBox(f.box, box)) endFlight(f);
    if (!layer) layer = h('div', { class: 'hive-bees', 'aria-hidden': 'true' });
    Object.assign(layer.style, { left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px` });
    if (layer.parentNode !== root) root.append(layer);
    const scale = beeScaleOf(`${salt}:${serial++}`);
    const el = beeEl(scale);
    layer.append(el);
    const anim = el.animate(flightFrames(box.width, box.height, scale), { duration: rand(FLIGHT_MS), easing: 'linear', fill: 'forwards' });
    const f = { el, anim, view, box };
    flights.add(f);
    anim.onfinish = () => {
      if (!flights.has(f)) return;
      el.remove();
      flights.delete(f);
      if (!timer) schedule('next');
    };
    if (flights.size < plan().max) schedule('next');
  }

  const onVisibility = () => {
    if (document.visibilityState === 'hidden') {
      clearTimeout(timer);
      timer = 0;
      stopFlights();
    } else if (!timer && !flights.size) {
      schedule('next');
    }
  };
  const onMotion = () => {
    if (reducedMotion()) stop();
    else if (!timer && !flights.size) schedule('first');
  };

  return {
    mount(el) {
      if (root === el) return;
      this.unmount();
      root = el;
      lastLevel = level();
      document.addEventListener('visibilitychange', onVisibility);
      motionQuery = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)') || null;
      motionQuery?.addEventListener?.('change', onMotion);
      schedule('first');
    },
    // Called on every rerender and layout change. A flight belongs to the
    // honeycomb it started over: if that view is gone, hidden behind a tab,
    // replaced (overview, another cell, Inspect) or has moved or resized, its
    // bees leave. While no honeycomb is shown nothing is scheduled; when one
    // is shown again, visits resume. Otherwise nothing changes, so ordinary
    // updates keep the schedule.
    keep() {
      if (!root) return;
      const comb = shownComb();
      if (!comb) {
        clearTimeout(timer);
        timer = 0;
        stopFlights();
        return;
      }
      if (flights.size) {
        const box = comb.getBoundingClientRect();
        const view = comb.dataset.viewKey || '';
        for (const f of [...flights]) if (f.view !== view || !sameBox(f.box, box)) endFlight(f);
        if (layer && layer.parentNode !== root) root.append(layer);
      }
      if (!timer && !flights.size) schedule('next');
    },
    // Reconciles the effective level. Called from the settings callback, on
    // every view update and while the slider moves; acts only on a change.
    // None stops every bee and the schedule at once; a lower limit sends the
    // extra bees away; any change starts the new pace from now.
    sync() {
      const next = level();
      if (next === lastLevel) return;
      lastLevel = next;
      const max = plan().max;
      if (!max) { stop(); return; }
      for (const f of [...flights].slice(max)) endFlight(f);
      if (root) schedule('first');
    },
    unmount() {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
      motionQuery?.removeEventListener?.('change', onMotion);
      motionQuery = null;
      layer = null;
      root = null;
      lastLevel = null;
    },
  };
}

// The Number of bees control, the same wherever it is shown.
export function beeSlider({ value, onInput, onCommit, onHold, idKey }) {
  const text = (v) => BEE_LEVELS[v]?.text || '';
  const id = `hive-bees-${idKey}`;
  const read = (e) => Math.max(0, Math.min(BEE_LEVELS.length - 1, Math.round(Number(e.target.value) || 0)));
  const thumb = h('span', { class: 'hive-bee-thumb', 'aria-hidden': 'true', style: { left: `${value / (BEE_LEVELS.length - 1) * 100}%` } }, beeEl());
  let timer;
  let pointerHeld = false;
  const settle = () => { clearTimeout(timer); thumb.dataset.flapping = 'false'; if (!pointerHeld) onHold?.(false); };
  const flap = () => {
    clearTimeout(timer);
    if (reducedMotion()) { settle(); return; }
    onHold?.(true);
    thumb.dataset.flapping = 'true';
    timer = setTimeout(settle, 180);
  };
  const release = () => { pointerHeld = false; settle(); };
  return h('div', { class: 'hive-bee-setting' },
    h('label', { class: 'hive-bee-label', for: id }, 'Number of bees'),
    h('div', { class: 'hive-bee-slider' }, h('input', {
      type: 'range',
      id,
      class: 'hive-bee-range',
      min: '0',
      max: String(BEE_LEVELS.length - 1),
      step: '1',
      'aria-valuetext': text(value),
      'data-focus-key': id,
      oninput: (e) => { const v = read(e); thumb.style.left = `${v / (BEE_LEVELS.length - 1) * 100}%`; e.target.setAttribute('aria-valuetext', text(v)); flap(); onInput(v); },
      onchange: (e) => onCommit(read(e)),
      onpointerdown: () => { pointerHeld = true; onHold?.(true); flap(); },
      onpointermove: e => { if (e.buttons & 1) flap(); },
      onpointerup: release,
      onpointercancel: release,
      onlostpointercapture: release,
      onblur: release,
      value: String(value),
    }), h('span', { class: 'hive-bee-thumb-track', 'aria-hidden': 'true' }, thumb)),
    h('div', { class: 'hive-bee-scale', 'aria-hidden': 'true' },
      h('span', {}, 'None'), h('span', {}, 'About right'), h('span', {}, 'Frankly too many bees')));
}

