import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { layoutCell, groupOutlines } from '../public/cell-layout.js';
import { planMove, planReveal } from '../public/cell-move.js';
import { activeKids, planReturn } from '../public/archive-layout.js';
import { MAX_COORD, inRange } from '../public/hex-search.js';
import { layoutBase } from '../public/layout-base.js';
import { moveBeads } from '../server/ops.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/new-items-layout.json', import.meta.url)));
const distance = (a, b) => Math.max(Math.abs(a.q - b.q), Math.abs(a.r - b.r), Math.abs(a.q + a.r - b.q - b.r));
const at = (p) => `${p.q},${p.r}`;
const directions = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];

function children(beads) {
  const kids = new Map();
  for (const bead of beads) {
    if (!kids.has(bead.parentId)) kids.set(bead.parentId, []);
    kids.get(bead.parentId).push(bead);
  }
  return kids;
}

function assertJoinedNearest(layout, id, existing, anchor) {
  const busy = new Set(Object.entries(layout.positions).filter(([other]) => other !== id).map(([, p]) => at(p)));
  const frontier = existing.flatMap((p) => directions.map(([q, r]) => ({ q: p.q + q, r: p.r + r }))).filter((p) => !busy.has(at(p)));
  assert.ok(existing.some((p) => distance(p, layout.positions[id]) === 1), `${id} must touch its workstream`);
  assert.equal(distance(anchor, layout.positions[id]), Math.min(...frontier.map((p) => distance(anchor, p))), `${id} must use the nearest free boundary hex`);
  assert.equal(new Set(Object.values(layout.positions).map(at)).size, layout.order.length);
}

const newIds = ['demo-bead-031', 'demo-bead-004', 'demo-bead-000', 'demo-bead-044', 'demo-bead-023', 'demo-bead-006', 'demo-bead-035'];
for (const id of newIds) {
  test(`synthetic layout joins newly created ${id} to demo-bead-009`, () => {
    const saved = structuredClone(fixture.saved);
    delete saved[id];
    const beads = fixture.beads.filter((b) => saved[b.id] || b.id === id || b.id === fixture.rootId);
    const layout = layoutCell({ ...fixture, saved, kids: children(beads) });
    const own = beads.filter((b) => saved[b.id] && layout.halo[b.id] === layout.halo[id]).map((b) => saved[b.id]);
    assertJoinedNearest(layout, id, own, saved['demo-bead-009']);
    for (const [id, p] of Object.entries(saved)) assert.deepEqual(layout.positions[id], p);
  });
  test(`synthetic ${id} stays joined after its workstream has been moved`, () => {
    const saved = structuredClone(fixture.saved);
    delete saved[id];
    const beads = fixture.beads.filter((b) => saved[b.id] || b.id === id || b.id === fixture.rootId);
    const before = layoutCell({ ...fixture, saved, kids: children(beads.filter((b) => b.id !== id)) });
    const ownIds = Object.keys(saved).filter((other) => before.halo[other] === before.halo['demo-bead-009']);
    for (const other of ownIds) saved[other] = { q: saved[other].q + 80, r: saved[other].r - 30 };
    const layout = layoutCell({ ...fixture, saved, kids: children(beads) });
    assertJoinedNearest(layout, id, ownIds.map((other) => saved[other]), saved['demo-bead-009']);
    for (const [id, p] of Object.entries(saved)) assert.deepEqual(layout.positions[id], p);
  });
}

test('a crowded heading grows from its distant free boundary without moving saved tiles', () => {
  const beads = [{ id: 'stream', parentId: 'root', kind: 'workstream' }, { id: 'new', parentId: 'stream' }];
  const saved = { stream: { q: 800, r: 0 } };
  for (let q = 801; q <= 804; q++) {
    const id = `member${q}`;
    beads.push({ id, parentId: 'stream' });
    saved[id] = { q, r: 0 };
  }
  const own = Object.values(saved);
  let n = 0;
  for (const p of own.slice(0, -1)) for (const [dq, dr] of directions) {
    const next = { q: p.q + dq, r: p.r + dr };
    if (Object.values(saved).some((p) => at(p) === at(next))) continue;
    const id = `blocker${n++}`;
    saved[id] = next;
    beads.push({ id, parentId: 'root' });
  }
  const layout = layoutCell({ kids: children(beads), rootId: 'root', saved });
  assertJoinedNearest(layout, 'new', own, saved.stream);
  for (const [id, p] of Object.entries(saved)) assert.deepEqual(layout.positions[id], p);
});

test('nested work uses its own region boundary and outline', () => {
  const kids = children([
    { id: 'stream', kind: 'workstream', parentId: 'root' },
    { id: 'nested', kind: 'workstream', parentId: 'stream' },
    { id: 'new', parentId: 'nested' },
  ]);
  const saved = { stream: { q: 20, r: 0 }, nested: { q: 21, r: 0 } };
  const layout = layoutCell({ kids, rootId: 'root', saved });
  assertJoinedNearest(layout, 'new', [saved.nested], saved.nested);
  assert.equal(groupOutlines(layout, 60).length, 2);
  assert.equal(groupOutlines(layout, 60)[0].headId, 'stream');
});

test('a batch grows one joined patch around saved members even when its heading is unplaced', () => {
  const kids = children([
    { id: 'stream', kind: 'workstream', parentId: 'root' },
    { id: 'old', parentId: 'stream' },
    ...Array.from({ length: 8 }, (_, i) => ({ id: `new${i}`, parentId: 'stream' })),
  ]);
  const layout = layoutCell({ kids, rootId: 'root', saved: { old: { q: -40, r: 12 } } });
  const reached = new Set(['old']);
  for (let pass = 0; pass < layout.order.length; pass++) for (const id of layout.order) {
    if ([...reached].some((other) => distance(layout.positions[id], layout.positions[other]) === 1)) reached.add(id);
  }
  assert.equal(reached.size, layout.order.length);
  assert.deepEqual(layout.positions.old, { q: -40, r: 12 });
});

test('an enclosed workstream translates rigidly with its new tile to the nearest free fit', () => {
  const saved = { stream: { q: 0, r: 0 }, member: { q: 1, r: 0 } };
  const beads = [{ id: 'stream', kind: 'workstream', parentId: 'root' }, { id: 'member', parentId: 'stream' }, { id: 'new', parentId: 'stream' }];
  for (const p of [{ q: 0, r: 0 }, { q: 1, r: 0 }]) for (const [dq, dr] of directions) {
    const next = { q: p.q + dq, r: p.r + dr };
    if (Object.values(saved).some((p) => at(p) === at(next))) continue;
    const id = `blocker${beads.length}`;
    saved[id] = next;
    beads.push({ id, parentId: 'root' });
  }
  const layout = layoutCell({ rootId: 'root', kids: children(beads), saved });
  const shift = layout.positions.stream;
  assert.deepEqual(layout.positions.member, { q: shift.q + 1, r: shift.r });
  assert.equal(distance(layout.positions.new, layout.positions.stream), 1);
  assert.equal(distance(shift, { q: 0, r: 0 }), 3);
  assert.equal(new Set(Object.values(layout.positions).map(at)).size, layout.order.length);
  for (const [id, p] of Object.entries(saved)) if (id.startsWith('blocker')) assert.deepEqual(layout.positions[id], p);
});

test('automatic growth uses freed hidden hexes and touches visible work', () => {
  const saved = { stream: { q: 0, r: 0 } };
  const beads = [{ id: 'stream', parentId: 'root', kind: 'workstream' }, { id: 'new', parentId: 'stream' }];
  const hidden = new Set();
  for (const [q, r] of directions) {
    const id = `done${hidden.size}`;
    beads.push({ id, parentId: 'stream', status: 'closed' });
    hidden.add(id);
    saved[id] = { q, r };
  }
  const layout = layoutCell({ rootId: 'root', kids: children(beads), saved, hidden });
  assert.deepEqual(layout.positions.stream, { q: 0, r: 0 });
  assert.equal(distance(layout.positions.stream, layout.positions.new), 1);
  const displaced = [...hidden].filter((id) => at(saved[id]) === at(layout.positions.new));
  assert.equal(displaced.length, 1);
  assert.ok(layout.yielded.includes(displaced[0]));
  assert.equal(new Set(Object.values(layout.positions).map(at)).size, layout.order.length);
  const reveal = planReveal({ layout, kids: children(beads), rootId: 'root', saved, headId: 'stream', back: hidden, yieldIds: hidden });
  assert.equal(reveal.ok, true);
  const shown = layoutCell({ rootId: 'root', kids: children(beads), saved: { ...saved, ...reveal.positions }, yieldIds: hidden });
  assert.equal(new Set(Object.values(shown.positions).map(at)).size, shown.order.length);
  assert.equal(groupOutlines(shown, 60)[0].d.match(/M/g).length, 1);
});

test('pinning a move keeps a new tile on its reused hidden hex until reveal', () => {
  const saved = { stream: { q: 0, r: 0 }, done: { q: -1, r: 0 }, other: { q: 20, r: 0 } };
  const kids = children([{ id: 'stream', parentId: 'root', kind: 'workstream' }, { id: 'done', parentId: 'stream', status: 'closed' }, { id: 'new', parentId: 'stream' }, { id: 'other', parentId: 'root' }]);
  const hidden = new Set(['done']);
  const layout = layoutCell({ rootId: 'root', kids, saved, hidden, yieldIds: hidden });
  assert.deepEqual(layout.positions.new, { q: -1, r: 0 });
  const move = planMove({ layout, rootId: 'root', kids, saved, hidden, yieldIds: hidden, id: 'other', target: { q: 21, r: 0 } });
  assert.equal(move.ok, true);
  const after = layoutCell({ rootId: 'root', kids, saved: { ...saved, ...move.positions }, hidden, yieldIds: hidden });
  assert.deepEqual(after.positions.new, layout.positions.new);
  assert.deepEqual(after.positions.stream, layout.positions.stream);
  assert.deepEqual(after.positions.other, { q: 21, r: 0 });
});

test('new work joins its workstream after an archived shape returns around occupied hexes', () => {
  const beads = Object.fromEntries([
    { id: 'root', kind: 'goal' },
    { id: 'stream', parentId: 'root', kind: 'workstream', status: 'closed' },
    { id: 'member', parentId: 'stream', status: 'closed' },
    { id: 'new', parentId: 'stream', status: 'open' },
    { id: 'other', parentId: 'root', status: 'open' },
  ].map((b) => [b.id, b]));
  const plan = planReturn({ beads, rootId: 'root', saved: { other: { q: 40, r: 0 } }, hiddenBefore: new Set(['stream', 'member']), hiddenAfter: new Set(), headId: 'stream', positions: { stream: { q: 40, r: 0 }, member: { q: 41, r: 0 } } });
  assert.ok(plan);
  const layout = layoutCell({ kids: activeKids(beads), rootId: 'root', saved: plan.saved });
  assert.deepEqual(layout.positions.other, { q: 40, r: 0 });
  assert.equal(layout.positions.member.q - layout.positions.stream.q, 1);
  assert.equal(layout.positions.member.r - layout.positions.stream.r, 0);
  assertJoinedNearest(layout, 'new', [layout.positions.stream, layout.positions.member], layout.positions.stream);
});

function enclosedHidden(done = { q: 1, r: 0 }) {
  const saved = { stream: { q: 0, r: 0 }, done };
  const beads = [{ id: 'stream', parentId: 'root', kind: 'workstream' }, { id: 'done', parentId: 'stream', status: 'closed' }, { id: 'new', parentId: 'stream' }];
  for (const [q, r] of directions) {
    const id = `blocker${beads.length}`;
    saved[id] = { q, r };
    beads.push({ id, parentId: 'root' });
  }
  const kids = children(beads);
  const hidden = new Set(['done']);
  const layout = layoutCell({ kids, rootId: 'root', saved, hidden, yieldIds: hidden });
  return { kids, rootId: 'root', saved, hidden, yieldIds: hidden, layout };
}

test('dragging after automatic enclosure growth carries the hidden canonical offset', () => {
  const f = enclosedHidden();
  assert.deepEqual(f.layout.positions.stream, { q: -3, r: 0 });
  const move = planMove({ ...f, id: 'stream', target: { q: 18, r: 0 } });
  assert.equal(move.ok, true);
  assert.deepEqual(move.positions.done, { q: 19, r: 0 });
  const again = layoutCell({ ...f, saved: { ...f.saved, ...move.positions } });
  assert.deepEqual(again.positions.stream, { q: 18, r: 0 });
});

for (const id of ['blocker3', 'blocker6']) test(`saving a move of ${id} preserves the automatically shifted hidden origin`, () => {
  const f = enclosedHidden();
  const move = planMove({ ...f, id, target: { q: 30, r: 0 } });
  assert.equal(move.ok, true);
  const beads = Object.fromEntries([{ id: 'root', kind: 'goal' }, ...[...f.kids.values()].flat()].map((b) => [b.id, b]));
  const doc = { beadLayout: { cell: structuredClone(f.saved) }, arrangeAspect: {}, archived: {} };
  const rt = { snapshots: { hierarchyCurrent: true, graph: { beads } }, metadata: { cell: () => ({ rootBeadId: 'root', enabled: true }), mutate: (fn) => fn(doc) } };
  moveBeads(rt, { cellId: 'cell', positions: move.positions, stack: move.stack, base: layoutBase({ beads, rootId: 'root', saved: f.saved }) });
  const again = layoutCell({ ...f, saved: doc.beadLayout.cell });
  const drag = planMove({ ...f, layout: again, saved: doc.beadLayout.cell, id: 'stream', target: { q: 18, r: 0 } });
  assert.equal(drag.ok, true);
  assert.deepEqual(drag.positions.done, { q: 19, r: 0 });
});

test('revealing automatically translated hidden work uses the translated canonical origin', () => {
  const f = enclosedHidden({ q: 0, r: -1 });
  const reveal = planReveal({ ...f, headId: 'stream', back: f.hidden, hidden: new Set() });
  assert.equal(reveal.ok, true);
  const shown = layoutCell({ ...f, hidden: new Set(), saved: { ...f.saved, ...reveal.positions } });
  assert.equal(groupOutlines(shown, 60)[0].d.match(/M/g).length, 1);
  assert.deepEqual(shown.positions.stream, f.layout.positions.stream);
  assert.deepEqual(shown.positions.done, { q: -3, r: -1 });
});

test('valid extreme saved geometry cannot crash layout when no rigid shift fits', () => {
  const saved = {
    stream: { q: -MAX_COORD, r: -MAX_COORD },
    member: { q: MAX_COORD, r: MAX_COORD },
    b1: { q: -MAX_COORD + 1, r: -MAX_COORD },
    b2: { q: -MAX_COORD, r: -MAX_COORD + 1 },
    b3: { q: MAX_COORD, r: MAX_COORD - 1 },
    b4: { q: MAX_COORD - 1, r: MAX_COORD },
  };
  const kids = children([{ id: 'stream', kind: 'workstream', parentId: 'root' }, { id: 'member', parentId: 'stream' }, { id: 'new', parentId: 'stream' }, ...['b1', 'b2', 'b3', 'b4'].map((id) => ({ id, parentId: 'root' }))]);
  const layout = layoutCell({ rootId: 'root', saved, kids });
  assert.ok(Object.values(layout.positions).every(inRange));
  assert.equal(new Set(Object.values(layout.positions).map(at)).size, layout.order.length);
  for (const [id, p] of Object.entries(saved)) assert.deepEqual(layout.positions[id], p);
  assert.equal(distance(layout.positions.stream, layout.positions.new), 3);
});
