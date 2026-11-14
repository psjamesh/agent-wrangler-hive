import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { key, neighbour, DIRECTIONS } from '../public/hex-layout.js';

const source = fs.readFileSync(new URL('../public/hex-grid.js', import.meta.url), 'utf8');

function fixture() {
  const events = {}, frames = new Map(), writes = [], follows = [], drops = [], states = [];
  let serial = 0, reads = 0;
  const g = { classList: { add() {}, remove() {} }, setPointerCapture() {}, setAttribute: (...args) => writes.push(args), addEventListener: (type, fn) => { events[type] = fn; } };
  const args = { g, it: { id: 'bead', x: 0, y: 0, local: { q: 0, r: 0 } },
    toWorld: e => { reads++; return { x: e.clientX, y: e.clientY }; }, snap: p => ({ q: p.x / 10, r: 0 }),
    onMove() {}, onDrop: (id, target) => drops.push(target), onDragState: on => states.push(on),
    aid: () => ({ start() {}, follow: (it, p) => follows.push(p), stop() {} }),
  };
  vm.runInNewContext(source.slice(source.indexOf('function wireTile(')) + '\nwireTile(args);', {
    args, key, neighbour, DIRECTIONS, DRAG_THRESHOLD: 6,
    requestAnimationFrame: fn => { frames.set(++serial, fn); return serial; }, cancelAnimationFrame: id => frames.delete(id),
  });
  const fire = (type, x = 0) => events[type]({ button: 0, pointerType: 'mouse', pointerId: 1, clientX: x, clientY: 0, stopPropagation() {}, preventDefault() {} });
  return { fire, frames, writes, follows, drops, states, reads: () => reads, flush() { const callbacks = [...frames.values()]; frames.clear(); for (const fn of callbacks) fn(); } };
}

test('tile drag batches pointer bursts into one frame using the latest coordinates', () => {
  const f = fixture();
  f.fire('pointerdown');
  for (let x = 10; x <= 100; x += 10) f.fire('pointermove', x);
  assert.equal(f.reads(), 0);
  assert.equal(f.writes.length, 0);
  assert.equal(f.frames.size, 1);
  f.flush();
  assert.equal(f.reads(), 1);
  assert.equal(f.follows.length, 1);
  assert.equal(f.follows[0].x, 100);
  assert.equal(f.writes.length, 1);
});

test('release resolves its own coordinates and cancels the queued preview', () => {
  const f = fixture();
  f.fire('pointerdown'); f.fire('pointermove', 20); f.fire('pointerup', 30);
  assert.equal(f.frames.size, 0);
  assert.deepEqual(f.drops, [{ q: 3, r: 0 }]);
  f.flush();
  assert.equal(f.follows.length, 0);
  assert.deepEqual(f.states, [true, false]);
});

test('cancel prevents a pending frame from moving the tile after it returns home', () => {
  const f = fixture();
  f.fire('pointerdown'); f.fire('pointermove', 20); f.fire('pointercancel');
  f.flush();
  assert.equal(f.follows.length, 0);
  assert.equal(f.writes.at(-1)[1], 'translate(0.0 0.0)');
  assert.equal(f.frames.size, 0);
});
