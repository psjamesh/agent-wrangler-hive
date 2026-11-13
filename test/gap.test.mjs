import assert from 'node:assert/strict';
import test from 'node:test';
import { layoutCell } from '../public/cell-layout.js';
import { planReturn, activeKids } from '../public/archive-layout.js';

const dist = (a, b) => Math.max(Math.abs(a.q - b.q), Math.abs(a.r - b.r), Math.abs(a.q + a.r - b.q - b.r));
const at = (p) => `${p.q},${p.r}`;

function kidsOf(beads) {
  const kids = new Map();
  for (const b of beads) {
    if (!kids.has(b.parentId)) kids.set(b.parentId, []);
    kids.get(b.parentId).push({ createdAt: '2026-01-01', ...b });
  }
  return kids;
}

function owners(layout) {
  const top = (id) => {
    let head = layout.parentHead[id];
    while (head && layout.regionParents[head]) head = layout.regionParents[head];
    return head || id;
  };
  return Object.fromEntries(layout.order.map((id) => [id, top(id)]));
}

function assertGap(layout, except = new Set()) {
  const own = owners(layout);
  const ids = layout.order;
  for (const a of ids) for (const b of ids) {
    if (a >= b || own[a] === own[b] || except.has(a) || except.has(b)) continue;
    assert.ok(dist(layout.positions[a], layout.positions[b]) >= 2, `${a} and ${b} touch`);
  }
}

const loose = (n, prefix = 'l') => Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`, parentId: 'root' }));
const work = (head, n) => Array.from({ length: n }, (_, i) => ({ id: `${head}-w${i}`, parentId: head }));

test('new loose items never touch each other', () => {
  const layout = layoutCell({ kids: kidsOf(loose(12)), rootId: 'root' });
  assertGap(layout);
  assert.equal(new Set(Object.values(layout.positions).map(at)).size, 12);
});

test('new loose items keep a gap from workstream regions, and new regions from loose items', () => {
  const beads = [{ id: 's', parentId: 'root', kind: 'workstream' }, ...work('s', 6), ...loose(6), { id: 't', parentId: 'root', kind: 'workstream' }, ...work('t', 5)];
  const layout = layoutCell({ kids: kidsOf(beads), rootId: 'root' });
  assertGap(layout);
});

test('a loose item added beside saved work avoids every neighbour of it', () => {
  const saved = { s: { q: 0, r: 0 }, 's-w0': { q: 1, r: 0 }, 's-w1': { q: 2, r: 0 }, a: { q: 5, r: 0 } };
  const beads = [{ id: 's', parentId: 'root', kind: 'workstream' }, ...work('s', 2), { id: 'a', parentId: 'root' }, { id: 'b', parentId: 'root' }, { id: 'c', parentId: 'root' }];
  const layout = layoutCell({ kids: kidsOf(beads), rootId: 'root', saved });
  for (const id of Object.keys(saved)) assert.deepEqual(layout.positions[id], saved[id]);
  assertGap(layout);
});

test('region growth keeps the gap as members are added', () => {
  let beads = [{ id: 's', parentId: 'root', kind: 'workstream' }, { id: 'u', parentId: 'root', kind: 'workstream' }, ...loose(4)];
  let saved = {};
  for (let i = 0; i < 14; i += 1) {
    beads = [...beads, { id: `s-n${i}`, parentId: 's' }, { id: `u-n${i}`, parentId: 'u' }];
    const layout = layoutCell({ kids: kidsOf(beads), rootId: 'root', saved });
    assertGap(layout);
    for (const id of Object.keys(saved)) assert.deepEqual(layout.positions[id], saved[id], `${id} moved`);
    saved = { ...layout.positions };
  }
});

test('nested workstreams stay attached to their parent and gapped from everything else', () => {
  const beads = [
    { id: 's', parentId: 'root', kind: 'workstream' }, ...work('s', 4),
    { id: 'c1', parentId: 's', kind: 'workstream' }, ...work('c1', 4),
    { id: 'c2', parentId: 's', kind: 'workstream' }, ...work('c2', 4),
    { id: 'g', parentId: 'c1', kind: 'workstream' }, ...work('g', 3),
    { id: 'o', parentId: 'root', kind: 'workstream' }, ...work('o', 5),
    ...loose(5),
  ];
  const layout = layoutCell({ kids: kidsOf(beads), rootId: 'root' });
  assertGap(layout);
  assert.equal(layout.detachedHeads.length, 0);
});

test('a walled-in legacy region takes a touching hex and moves no existing tile', () => {
  const saved = { s: { q: 0, r: 0 }, 's-w0': { q: 1, r: 0 } };
  const beads = [{ id: 's', parentId: 'root', kind: 'workstream' }, { id: 's-w0', parentId: 's' }, { id: 's-new', parentId: 's' }];
  const ring = [[0, -1], [1, -1], [2, -1], [-1, 0], [3, 0], [-1, 1], [0, 1], [1, 1], [2, -2], [0, -2], [1, -2]];
  ring.forEach(([q, r], i) => {
    saved[`x${i}`] = { q, r };
    beads.push({ id: `x${i}`, parentId: 'root' });
  });
  const layout = layoutCell({ kids: kidsOf(beads), rootId: 'root', saved });
  for (const id of Object.keys(saved)) assert.deepEqual(layout.positions[id], saved[id], `${id} moved`);
  assert.deepEqual(layout.positions['s-new'], { q: 2, r: 0 });
  assert.equal(new Set(Object.values(layout.positions).map(at)).size, layout.order.length);
});

test('existing saved positions are never moved to make a gap', () => {
  const saved = { a: { q: 0, r: 0 }, b: { q: 1, r: 0 }, c: { q: 2, r: 0 } };
  const layout = layoutCell({ kids: kidsOf([...loose(3, 'q').map((b, i) => ({ ...b, id: 'abc'[i] })), { id: 'd', parentId: 'root' }]), rootId: 'root', saved });
  for (const id of Object.keys(saved)) assert.deepEqual(layout.positions[id], saved[id]);
  for (const id of Object.keys(saved)) assert.ok(dist(layout.positions.d, layout.positions[id]) >= 2);
});

test('an archived workstream returns with a gap from the other work', () => {
  const beads = Object.fromEntries([
    { id: 'root', kind: 'goal' }, { id: 's', parentId: 'root', kind: 'workstream', status: 'open' }, { id: 's-w', parentId: 's', status: 'open' },
    { id: 'a', parentId: 'root', status: 'open' }, { id: 'b', parentId: 'root', status: 'open' },
  ].map((b) => [b.id, b]));
  const saved = { a: { q: 0, r: 0 }, b: { q: 5, r: 0 } };
  const plan = planReturn({ beads, rootId: 'root', saved, hiddenBefore: new Set(['s', 's-w']), hiddenAfter: new Set(), headId: 's', positions: { s: { q: 0, r: 0 }, 's-w': { q: 1, r: 0 } } });
  assert.ok(plan);
  const layout = layoutCell({ kids: activeKids(beads), rootId: 'root', saved: plan.saved });
  assertGap(layout);
});

test('an archived nested workstream returns attached to its parent without shifting', () => {
  const beads = Object.fromEntries([
    { id: 'root', kind: 'goal' }, { id: 'p', parentId: 'root', kind: 'workstream', status: 'open' }, { id: 'p1', parentId: 'p', status: 'open' },
    { id: 'c', parentId: 'p', kind: 'workstream', status: 'open' }, { id: 'c1', parentId: 'c', status: 'open' },
  ].map((b) => [b.id, b]));
  const saved = { p: { q: 0, r: 0 }, p1: { q: 1, r: 0 }, c: { q: 0, r: 1 }, c1: { q: -1, r: 2 } };
  const plan = planReturn({ beads, rootId: 'root', saved: { p: saved.p, p1: saved.p1 }, hiddenBefore: new Set(['c', 'c1']), hiddenAfter: new Set(), headId: 'c', positions: { c: saved.c, c1: saved.c1 } });
  assert.ok(plan);
  assert.equal(plan.shift, 0);
  const layout = layoutCell({ kids: activeKids(beads), rootId: 'root', saved: plan.saved });
  assert.deepEqual(layout.detachedHeads, []);
  assert.deepEqual(layout.positions.c, saved.c);
});

test('a new nested workstream beside a dense saved parent moves no saved tile', () => {
  const saved = { p: { q: 0, r: 0 }, p1: { q: 1, r: 0 } };
  const beads = [{ id: 'p', parentId: 'root', kind: 'workstream' }, { id: 'p1', parentId: 'p' }, { id: 'c', parentId: 'p', kind: 'workstream' }, { id: 'c1', parentId: 'c' }];
  let n = 0;
  for (let q = -3; q <= 4; q += 1) for (let r = -3; r <= 3; r += 1) {
    const d = Math.max(Math.abs(q), Math.abs(r), Math.abs(q + r));
    const d2 = Math.max(Math.abs(q - 1), Math.abs(r), Math.abs(q - 1 + r));
    if (Math.min(d, d2) !== 2) continue;
    saved[`x${n}`] = { q, r };
    beads.push({ id: `x${n}`, parentId: 'root' });
    n += 1;
  }
  const layout = layoutCell({ kids: kidsOf(beads), rootId: 'root', saved });
  for (const id of Object.keys(saved)) assert.deepEqual(layout.positions[id], saved[id], `${id} moved`);
  assert.deepEqual(layout.detachedHeads, []);
});

test('fallback layout also keeps the gap for new items', () => {
  const layout = layoutCell({ kids: kidsOf(loose(10)), rootId: 'root', fallback: true });
  assertGap(layout);
});
