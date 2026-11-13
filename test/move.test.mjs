import assert from 'node:assert/strict';
import { test } from 'node:test';
import { layoutCell } from '../public/cell-layout.js';
import { previewMove, planGroupArrange, planReveal, planMove, pieces } from '../public/cell-move.js';
import fs from 'node:fs';
import vm from 'node:vm';
import { performance } from 'node:perf_hooks';
import { toPixel } from '../public/hex-layout.js';
import { layoutBase, stackable } from '../public/layout-base.js';
import { MAX_COORD, nearestFree, span } from '../public/hex-search.js';
import { moveBeads } from '../server/ops.js';

const p = (q, r) => ({ q, r });
const tree = (spec) => {
  const kids = new Map();
  for (const [id, parentId, kind = 'task'] of spec) {
    if (!kids.has(parentId)) kids.set(parentId, []);
    kids.get(parentId).push({ id, parentId, kind, status: 'open' });
  }
  return kids;
};
const lay = (kids, saved) => layoutCell({ kids, rootId: 'root', saved });

test('a workstream can be dragged far beyond the old map edge', () => {
  const kids = tree([['a', 'root', 'workstream'], ['x', 'a']]);
  const layout = lay(kids, { a: p(0, 0), x: p(1, 0) });
  const out = previewMove({ layout, kids, id: 'a', target: p(2000, -1500) });
  assert.equal(out.ok, true);
  assert.deepEqual(out.moves.x, p(2001, -1500));
});

test('a tile drag may not fragment its own nested region', () => {
  const kids = tree([['a', 'root', 'workstream'], ['n', 'a', 'workstream'], ['x', 'n'], ['y', 'n']]);
  const layout = lay(kids, { a: p(0, 0), n: p(1, 0), x: p(2, 0), y: p(3, 0) });
  assert.equal(previewMove({ layout, kids, id: 'y', target: p(-1, 0) }).ok, false);
});

test('a drag that splits the top-level workstream is still refused', () => {
  const kids = tree([['a', 'root', 'workstream'], ['x', 'a'], ['y', 'a']]);
  const layout = lay(kids, { a: p(0, 0), x: p(1, 0), y: p(2, 0) });
  assert.match(previewMove({ layout, kids, id: 'x', target: p(5, 5) }).reason, /split a workstream/);
});

test('gaps between separate workstreams are fine', () => {
  const kids = tree([['a', 'root', 'workstream'], ['x', 'a'], ['b', 'root', 'workstream'], ['y', 'b']]);
  const layout = lay(kids, { a: p(0, 0), x: p(1, 0), b: p(2, 0), y: p(3, 0) });
  assert.equal(previewMove({ layout, kids, id: 'b', target: p(10, 0) }).ok, true);
});

test('arrange works for a workstream beyond the old map edge', () => {
  const kids = tree([['a', 'root', 'workstream'], ['x', 'a'], ['y', 'a']]);
  const layout = lay(kids, { a: p(900, 0), x: p(901, 0), y: p(902, 0) });
  const out = planGroupArrange({ layout, kids, rootId: 'root', saved: { a: p(900, 0), x: p(901, 0), y: p(902, 0) }, headId: 'a', isDone: () => false });
  assert.equal(out.ok, true);
});

test('revealing a workstream beyond the old map edge places its returning work', () => {
  const kids = tree([['a', 'root', 'workstream'], ['x', 'a'], ['y', 'a']]);
  const saved = { a: p(900, 0), x: p(901, 0), y: p(902, 0) };
  const layout = lay(kids, saved);
  const out = planReveal({ layout, kids, rootId: 'root', saved, headId: 'a', back: new Set(['y']) });
  assert.equal(out.ok, true);
});

function graph(parents, saved, done = []) {
  const beads = { root: { id: 'root', kind: 'goal' } };
  const kids = new Map();
  for (const [id, parentId] of Object.entries(parents)) {
    const b = { id, parentId, kind: id === 'h' ? 'workstream' : 'work', status: done.includes(id) ? 'closed' : 'open', outcome: done.includes(id) ? 'done' : null };
    beads[id] = b;
    if (!kids.has(parentId)) kids.set(parentId, []);
    kids.get(parentId).push(b);
  }
  const yieldIds = new Set(done);
  return { rootId: 'root', beads, kids, saved, yieldIds, layout: layoutCell({ kids, rootId: 'root', saved, yieldIds }) };
}

function runtime(g) {
  let data = { beadLayout: { cell: structuredClone(g.saved) }, arrangeAspect: {} };
  return { snapshots: { hierarchyCurrent: true, graph: { beads: g.beads } }, metadata: { cell: () => ({ rootBeadId: 'root', enabled: true }), mutate: (fn) => { const copy = structuredClone(data); fn(copy); data = copy; }, epoch: 'e', version: 1 } };
}

const grid = fs.readFileSync(new URL('../public/hex-grid.js', import.meta.url), 'utf8');
const ghostCode = `${grid.slice(grid.indexOf('const drawGhosts = () => {'), grid.indexOf('  let ghostFrame = 0;'))}\ndrawGhosts();`;
function ghosts(q, r) {
  const centre = toPixel({ q, r }, 60);
  let count = 0;
  const sandbox = { MAX_COORD, el: { clientWidth: 1000, clientHeight: 800, classList: { toggle: () => {} } }, view: { k: 1, tx: 500 - centre.x, ty: 400 - centre.y }, pitch: { x: Math.sqrt(3) * 60, y: 90 }, ghostKey: '', GHOST_CAP: 3500, id: 'probe', occupied: new Set(), h: () => { count += 1; return null; }, ghostLayer: { replaceChildren: () => {} } };
  vm.runInNewContext(ghostCode, sandbox, { timeout: 100 });
  return count;
}

test('the server refuses positions beyond the shared limit', () => {
  const g = graph({ x: 'root' }, { x: p(0, 0) });
  const base = layoutBase(g);
  assert.throws(() => moveBeads(runtime(g), { cellId: 'cell', positions: { x: p(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER) }, base }), /whole numbers/);
  assert.throws(() => moveBeads(runtime(g), { cellId: 'cell', positions: { x: p(MAX_COORD + 1, 0) }, base }), /whole numbers/);
  moveBeads(runtime(g), { cellId: 'cell', positions: { x: p(MAX_COORD, -MAX_COORD) }, base });
});

test('ghost hexes are drawn and the loop ends anywhere on the map, even past its limit', () => {
  for (const at of [0, 1e6, MAX_COORD, -MAX_COORD]) assert(ghosts(at, at) > 0);
  ghosts(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
  ghosts(-Number.MAX_SAFE_INTEGER, 0);
});

test('a heading drag that would carry a member past the limit is refused', () => {
  const g = graph({ h: 'root', a: 'h' }, { h: p(0, 0), a: p(1, 0) });
  const out = planMove({ ...g, id: 'h', target: p(MAX_COORD, 0) });
  assert.equal(out.ok, false);
  assert.match(out.reason, /too far out/);
  assert.equal(planMove({ ...g, id: 'h', target: p(MAX_COORD - 1, 0) }).ok, true);
  assert.equal(previewMove({ layout: g.layout, kids: g.kids, id: 'a', target: p(Number.MAX_SAFE_INTEGER, 0) }).ok, false);
});

test('a reveal searches as far as it needs and never runs out of room', () => {
  const parents = { h: 'root' };
  const saved = { h: p(0, 0) };
  const done = [];
  for (let q = -200; q <= 200; q += 1) {
    if (!q) continue;
    const id = `m${q + 200}`;
    parents[id] = 'h';
    saved[id] = p(q, 0);
    if (Math.abs(q) === 200) done.push(id);
  }
  for (let r = -100; r <= 100; r += 1) {
    if (!r) continue;
    const id = `o${r + 100}`;
    parents[id] = 'root';
    saved[id] = p(0, r);
  }
  for (const q of [-200, 200]) {
    parents[`edge${q}`] = 'root';
    saved[`edge${q}`] = p(q, 0);
  }
  const g = graph(parents, saved, done);
  const out = planReveal({ ...g, headId: 'h', back: new Set(done) });
  assert.equal(out.ok, true, out.reason);
  const ids = g.layout.order.filter((id) => id === 'h' || parents[id] === 'h');
  const after = layoutCell({ kids: g.kids, rootId: 'root', saved: { ...saved, ...out.positions }, yieldIds: g.yieldIds });
  assert.equal(pieces(ids.map((id) => after.positions[id])), 1);
  const keys = Object.values(after.positions).map((t) => `${t.q},${t.r}`);
  assert.equal(new Set(keys).size, keys.length);
  moveBeads(runtime(g), { cellId: 'cell', positions: out.positions, base: layoutBase(g) });
});

const hexKey = (t) => `${t.q},${t.r}`;

function revealCheck(g, headId, back, topId) {
  const out = planReveal({ ...g, headId, back: new Set(back) });
  assert.equal(out.ok, true, out.reason);
  const after = layoutCell({ kids: g.kids, rootId: 'root', saved: { ...g.saved, ...out.positions }, yieldIds: g.yieldIds });
  const keys = Object.values(after.positions).map(hexKey);
  assert.equal(new Set(keys).size, keys.length);
  const under = (id) => [id, ...(g.kids.get(id) || []).flatMap((c) => under(c.id))];
  assert.equal(pieces(under(headId).map((id) => after.positions[id])), 1);
  for (const id of under(topId).filter((id) => !under(headId).includes(id))) assert.deepEqual(after.positions[id], g.layout.positions[id]);
  moveBeads(runtime(g), { cellId: 'cell', positions: out.positions, stack: out.stack, base: layoutBase(g) });
  return { out, after };
}

function walledField(pocket) {
  const parents = { t: 'root', h: 't' };
  const saved = { t: p(0, 0), h: p(1, 0) };
  const done = [];
  const keep = new Set(['0,0', '1,0', '2,0', '3,0', '4,0', '5,0', '7,0', '8,0', '9,0', '10,0']);
  if (pocket) for (let q = 2; q <= 6; q += 1) keep.add(`${q},-1`);
  for (let i = 1; i <= 9; i += 1) {
    parents[`a${i}`] = 'h';
    saved[`a${i}`] = p(i + 1, 0);
    done.push(`a${i}`);
  }
  for (let q = -12; q <= 12; q += 1) {
    for (let r = -12; r <= 12; r += 1) {
      if (Math.abs(q + r) > 12 || keep.has(`${q},${r}`)) continue;
      parents[`f${q}_${r}`] = 'root';
      saved[`f${q}_${r}`] = p(q, r);
    }
  }
  return { g: graph(parents, saved, done), done };
}

test('a reveal whose every returning tile lands on held done work still finds room', () => {
  const kids = tree([['h', 'root', 'workstream'], ['x', 'h'], ['k', 'root', 'workstream'], ['z', 'k'], ['w', 'k']]);
  const layout = { rootId: 'root', order: ['h', 'x', 'k', 'z', 'w'], positions: { h: p(5, 0), x: p(6, 0), k: p(10, 0), z: p(0, 0), w: p(1, 0) } };
  const saved = { h: p(0, 0), x: p(1, 0), k: p(10, 0), z: p(0, 0), w: p(1, 0) };
  const out = planReveal({ layout, kids, rootId: 'root', saved, headId: 'h', back: new Set(['h', 'x']), hidden: new Set(['z', 'w']) });
  assert.equal(out.ok, true, out.reason);
  const placed = ['h', 'x'].map((id) => out.moves[id] || layout.positions[id]);
  assert.equal(pieces(placed), 1);
  for (const t of placed) assert(!['0,0', '1,0', '10,0'].includes(hexKey(t)));
});

test('a reveal with nothing shown preserves scattered canonical geometry', () => {
  const g = graph({ h: 'root', x: 'h', y: 'h' }, { h: p(0, 0), x: p(5, 0), y: p(-4, 2) }, ['x', 'y']);
  const out = planReveal({ ...g, headId: 'h', back: new Set(['h', 'x', 'y']) });
  assert.equal(out.ok, true, out.reason);
  assert.equal(out.same, true);
});

test('a nested reveal preserves the parent while restoring its direct work', () => {
  const { g, done } = walledField(true);
  const { after } = revealCheck(g, 'h', done, 't');
  assert.deepEqual(after.positions.t, p(0, 0));
  assert.equal(pieces([...Array.from({ length: 9 }, (_, i) => `a${i + 1}`), 'h'].map((id) => after.positions[id])), 1);
});

test('a nested reveal walled in by other work preserves the parent position', () => {
  const { g, done } = walledField(false);
  const out = planReveal({ ...g, headId: 'h', back: new Set(done) });
  assert.equal(out.ok, true, out.reason);
  assert.deepEqual(out.moves.t, undefined);
  const again = layoutCell({ ...g, saved: { ...g.saved, ...out.positions } });
  assert.deepEqual(again.positions.t, g.layout.positions.t);
});

test('a reveal whose only shift in range is taken ends its search at once and places the work beside the group', () => {
  const M = MAX_COORD;
  const saved = { h: p(-M, -M), a: p(M, M), d: p(-M + 1, -M), x: p(-M + 1, -M) };
  const kids = new Map([['root', [{ id: 'h', kind: 'workstream' }, { id: 'x' }]], ['h', [{ id: 'a' }, { id: 'd' }]]]);
  const yieldIds = new Set(['d']);
  const layout = layoutCell({ kids, rootId: 'root', saved, yieldIds });
  const NativeI = globalThis.Int32Array;
  let largest = 0;
  globalThis.Int32Array = class extends NativeI { constructor(n) { super(n); largest = Math.max(largest, n); } };
  let out;
  try {
    out = planReveal({ layout, kids, rootId: 'root', saved, yieldIds, headId: 'h', back: new Set(['d']) });
  } finally {
    globalThis.Int32Array = NativeI;
  }
  assert(largest <= 16, `asked for ${largest} entries`);
  assert.equal(out.ok, true, out.reason);
  const d = out.moves.d;
  assert.notDeepEqual(d, saved.x);
  assert.equal(pieces([saved.h, d]), 1);
  assert(Math.abs(d.q) <= M && Math.abs(d.r) <= M);
});

for (const [name, far] of [['two distant tiles', 10000], ['tiles at the coordinate limit', MAX_COORD]]) {
  test(`past the window ceiling the nearest free shift still wins over ${name}`, () => {
    const shape = [];
    const taken = [];
    for (let i = -256; i <= 256; i += 1) {
      shape.push(p(i, 0));
      taken.push(p(0, i));
    }
    taken.push(p(far, far), p(-far, -far));
    const at = nearestFree(shape, taken);
    assert.equal(span(at), 257);
    const busy = new Set(taken.map((t) => `${t.q},${t.r}`));
    assert(shape.every((s) => !busy.has(`${s.q + at.q},${s.r + at.r}`)));
  });
}

test('distant unrelated work never turns a short reveal past the window into a far jump', () => {
  const parents = { h: 'root' };
  const saved = { h: p(0, 0) };
  const done = [];
  for (let q = -600; q <= 600; q += 1) {
    if (!q) continue;
    const id = `m${q + 600}`;
    parents[id] = 'h';
    saved[id] = p(q, 0);
    if (Math.abs(q) === 600) done.push(id);
  }
  for (let r = -256; r <= 256; r += 1) {
    if (!r) continue;
    const id = `o${r + 256}`;
    parents[id] = 'root';
    saved[id] = p(0, r);
  }
  for (const q of [-600, 600]) {
    parents[`edge${q}`] = 'root';
    saved[`edge${q}`] = p(q, 0);
  }
  for (const q of [-1000000, 1000000]) {
    parents[`far${q}`] = 'root';
    saved[`far${q}`] = p(q, q);
  }
  const g = graph(parents, saved, done);
  const out = planReveal({ ...g, headId: 'h', back: new Set(done) });
  assert.equal(out.ok, true, out.reason);
  assert(out.shift <= 257, `moved ${out.shift} hexes`);
  moveBeads(runtime(g), { cellId: 'cell', positions: out.positions, stack: out.stack, base: layoutBase(g) });
});

const closedOutcomes = ['done', 'dropped', 'superseded', 'duplicate', null];

test('closed work of every outcome is hidden and yields, open work is not', () => {
  for (const outcome of closedOutcomes) assert.equal(stackable({ status: 'closed', outcome }), true, String(outcome));
  for (const status of ['open', 'in_progress', 'blocked']) assert.equal(stackable({ status, outcome: null }), false, status);
});

test('a closed bead of any outcome shares its saved hex and is drawn beside it', () => {
  for (const outcome of closedOutcomes) {
    const g = graph({ h: 'root', a: 'h', b: 'h' }, { h: p(0, 0), a: p(1, 0), b: p(2, 0) });
    g.beads.a = { ...g.beads.a, status: 'closed', outcome };
    const base = layoutBase(g);
    moveBeads(runtime(g), { cellId: 'cell', positions: { b: p(1, 0) }, stack: ['a'], base });
    const layout = layoutCell({ kids: g.kids, rootId: 'root', saved: { ...g.saved, b: p(1, 0) }, yieldIds: new Set(Object.values(g.beads).filter(stackable).map((b) => b.id)) });
    assert.deepEqual(layout.positions.b, p(1, 0), String(outcome));
    assert.notDeepEqual(layout.positions.a, p(1, 0), String(outcome));
  }
});

test('an open bead still may not share a hex', () => {
  const g = graph({ h: 'root', a: 'h', b: 'h' }, { h: p(0, 0), a: p(1, 0), b: p(2, 0) });
  assert.throws(() => moveBeads(runtime(g), { cellId: 'cell', positions: { b: p(1, 0) }, stack: ['a'], base: layoutBase(g) }), /two beads on one hex/);
});
