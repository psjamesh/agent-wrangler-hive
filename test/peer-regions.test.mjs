import { subtreeMembers } from '../public/region-attachments.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { layoutCell, groupOutlines } from '../public/cell-layout.js';
import { hiddenWork } from '../public/region-visibility.js';
import { activeKids, planArchive, planReturn } from '../public/archive-layout.js';
import { previewMove, planMove, planReveal, membersOf, pieces, planGroupArrange } from '../public/cell-move.js';

const p = (q, r = 0) => ({ q, r });
const beads = Object.fromEntries([
  ['root', null, 'goal'], ['parent', 'root', 'workstream'], ['a', 'parent', 'work'],
  ['child', 'parent', 'workstream'], ['b', 'child', 'work'],
  ['deep', 'child', 'workstream'], ['c', 'deep', 'work'],
].map(([id, parentId, kind]) => [id, { id, parentId, kind, status: 'open', title: id }]));
const saved = { parent: p(0), a: p(1), child: p(2), b: p(3), deep: p(4), c: p(5) };
const fixture = (positions = saved, graph = beads) => {
  const kids = activeKids(graph);
  return { rootId: 'root', kids, saved: positions, layout: layoutCell({ kids, rootId: 'root', saved: positions }) };
};

test('every nested workstream owns a peer outline and its direct work only', () => {
  const f = fixture();
  assert.deepEqual(groupOutlines(f.layout, 60).map((o) => o.headId), ['parent', 'child', 'deep']);
  assert.deepEqual([...membersOf(f.layout, f.kids, 'parent')], ['parent', 'a']);
  assert.deepEqual([...membersOf(f.layout, f.kids, 'child')], ['child', 'b']);
  assert.deepEqual(f.layout.positions, saved);
});

test('a new nested item grows on its own boundary even beside an earlier ancestor heading', () => {
  const graph = { ...beads, fresh: { id: 'fresh', parentId: 'child', kind: 'work' } };
  const f = fixture({ ...saved, child: p(40), b: p(41) }, graph);
  const at = f.layout.positions.fresh;
  assert.ok(Math.max(Math.abs(at.q - 40), Math.abs(at.r), Math.abs(at.q + at.r - 40)) === 1);
  for (const [id, pos] of Object.entries(f.saved)) assert.deepEqual(f.layout.positions[id], pos);
});

test('a new child region uses a nearest free hex to its parent, not the map origin', () => {
  const f = fixture({ parent: p(100), a: p(101) });
  const at = f.layout.positions.child;
  assert.equal(Math.max(Math.abs(at.q - 100), Math.abs(at.r), Math.abs(at.q + at.r - 100)), 1);
});

test('dragging a heading carries its subtree while outside regions stay in place', () => {
  const f = fixture();
  for (const id of ['parent', 'child', 'deep']) {
    const move = planMove({ ...f, id, target: id === 'parent' ? p(80,30) : id === 'child' ? p(0,1) : p(2,1) });
    assert.equal(move.ok, true, move.reason);
    const own = subtreeMembers(f.layout,f.kids,id);
    const next = layoutCell({ ...f, saved: { ...saved, ...move.positions } });
    for (const other of Object.keys(saved)) {
      if (!own.has(other)) assert.deepEqual(next.positions[other], saved[other]);
    }
    assert.equal(pieces([...own].map((o) => next.positions[o])), 1);
  }
});

test('ordinary tile drags cannot fragment their own nested region', () => {
  const f = fixture();
  assert.equal(previewMove({ ...f, id: 'b', target: p(-1) }).ok, false);
});

test('fragmented migrated regions can translate without gathering their members', () => {
  const f = fixture({ ...saved, b: p(20) });
  const move = planMove({ ...f, id: 'child', target: p(0,1) });
  assert.equal(move.ok, true, move.reason);
  assert.deepEqual(move.moves.b, p(18,1));
  assert.deepEqual(move.moves.deep, p(2,1));
});

test('reveal moves only the selected region and leaves child and ancestor regions fixed', () => {
  const f = fixture({ ...saved, parent: p(3), a: p(2), child: p(0), b: p(1) });
  const hidden = new Set(['b']);
  const layout = layoutCell({ ...f, hidden, yieldIds: hidden });
  const out = planReveal({ ...f, layout, headId: 'child', hidden: new Set(), back: hidden, yieldIds: hidden });
  assert.equal(out.ok, true, out.reason);
  for (const id of ['parent', 'a', 'deep', 'c']) assert.equal(out.moves?.[id], undefined);
});

test('arrange of a parent region does not move child regions', () => {
  const f = fixture({ ...saved, a: p(-1) });
  const out = planGroupArrange({ ...f, headId: 'parent', isDone: () => false });
  assert.equal(out.ok, true, out.reason);
  for (const id of ['child', 'b', 'deep', 'c']) assert.equal(out.moves?.[id], undefined);
});

test('archive/return preserve all peer regions as one rigid subtree constellation', () => {
  const graph = Object.fromEntries(Object.entries(beads).map(([id, b]) => [id, { ...b, status: 'closed' }]));
  const original = { ...saved, child: p(30), b: p(31), deep: p(80), c: p(81) };
  const archive = planArchive({ beads: graph, rootId: 'root', saved: original, archived: {}, headId: 'parent' });
  assert.equal(archive.ok, true);
  assert.deepEqual(archive.positions, original);
  graph.blocker = { id: 'blocker', parentId: 'root', kind: 'work', status: 'open' };
  const returned = planReturn({ beads: graph, rootId: 'root', saved: { blocker: p(30) }, hiddenBefore: new Set(Object.keys(original)), hiddenAfter: new Set(), headId: 'parent', positions: archive.positions });
  const lay = layoutCell({ kids: activeKids(graph), rootId: 'root', saved: returned.saved });
  const shift = lay.positions.parent;
  for (const id of Object.keys(original)) assert.deepEqual(lay.positions[id], p(original[id].q + shift.q, original[id].r + shift.r));
  assert.deepEqual(lay.positions.blocker, p(30));
  assert.equal(groupOutlines(lay, 60).length, 3);
});

test('reveal preserves a migrated fragmented region instead of gathering it', () => {
  const f = fixture({ ...saved, child: p(40), b: p(90) });
  const hidden = new Set(['b']);
  const layout = layoutCell({ ...f, hidden, yieldIds: hidden });
  const out = planReveal({ ...f, layout, headId: 'child', back: hidden, hidden: new Set(), yieldIds: hidden });
  assert.equal(out.ok, true, out.reason);
  assert.equal(out.same, true);
});

test('region hiding counts closed direct work', async () => {
  const mod = await import('../public/region-visibility.js');
  const f = fixture();
  const { hidden, counts } = mod.hiddenWork({ beads: { ...beads, a: { ...beads.a, status: 'closed' }, b: { ...beads.b, status: 'closed' } } }, f.layout, f.kids, ['parent']);
  assert.deepEqual([...hidden], ['a']);
  assert.equal(counts.get('parent'), 1);
});

test('nested heading tiles identify their logical parent visibly', async () => {
  const { beadTile } = await import('../public/cell-view.js');
  const f = fixture();
  const ctx = { hive: { beads, edges: [], cells: { cell: { bindings: [] } } }, graph: { sessions: [] } };
  const tile = beadTile(ctx, beads.child, { cellId: 'cell', layout: f.layout, local: saved.child, x: 0, y: 0 }, f.kids);
  assert.match(tile.sub?.join(' ') || '', /parent/);
  assert.match(tile.ariaLabel, /this workstream and its descendants/);
});

test('colours are assigned to all nested regions and exclude other cells', async () => {
  const { topWorkstreams } = await import('../server/colours.js');
  assert.deepEqual(topWorkstreams({ ...beads, other: { id: 'other', kind: 'workstream', parentId: 'elsewhere' } }, 'root').sort(), ['child', 'deep', 'parent']);
});


test('displaced visible closed work joins its own region instead of an unrelated free hex', () => {
  const graph = {
    root: { id: 'root', kind: 'goal' }, stream: { id: 'stream', kind: 'workstream', parentId: 'root' },
    closed: { id: 'closed', kind: 'work', status: 'closed', parentId: 'stream' },
    other: { id: 'other', kind: 'work', parentId: 'root' },
  };
  const positions = { stream: p(0), closed: p(40), other: p(40) };
  const layout = layoutCell({ kids: activeKids(graph), rootId: 'root', saved: positions, yieldIds: new Set(['closed']) });
  assert.equal(pieces([layout.positions.stream, layout.positions.closed]), 1);
  assert.deepEqual(layout.positions.other, p(40));
  assert.deepEqual(layout.positions.stream, p(0));
});


test('hiding a region includes wholly closed child subtrees and their outlines', () => {
  const graph = Object.fromEntries(Object.entries(beads).map(([id, b]) => [id, { ...b, status: ['child', 'b', 'deep', 'c'].includes(id) ? 'closed' : 'open' }]));
  const f = fixture(saved, graph);
  const { hidden, counts } = hiddenWork({ beads: graph }, f.layout, f.kids, ['parent']);
  assert.deepEqual([...hidden].sort(), ['b', 'c', 'child', 'deep']);
  assert.equal(counts.get('parent'), 4);
  const layout = layoutCell({ ...f, hidden });
  const drawn = { ...layout, positions: Object.fromEntries(Object.entries(layout.positions).filter(([id]) => !hidden.has(id))) };
  assert.deepEqual(groupOutlines(drawn, 60).map((o) => o.headId), ['parent']);
  assert.deepEqual(f.saved, saved);
  assert.deepEqual([...hiddenWork({ beads: graph }, layout, f.kids, []).hidden], []);
});

test('closed child with open descendants stays visible while a completed deeper region hides', () => {
  const graph = Object.fromEntries(Object.entries(beads).map(([id, b]) => [id, { ...b, status: ['child', 'deep', 'c'].includes(id) ? 'closed' : 'open' }]));
  const f = fixture(saved, graph);
  const { hidden } = hiddenWork({ beads: graph }, f.layout, f.kids, ['parent']);
  assert.deepEqual([...hidden].sort(), ['c', 'deep']);
});


test('hiding whole regions preserves detached pins without pinning newly invisible heads', () => {
  const f = fixture();
  const hidden = new Set(['child', 'b', 'deep', 'c']);
  const layout = layoutCell({ ...f, hidden, detachedPinned: new Set(['deep']) });
  assert.deepEqual([...layout.detachedPinned], ['deep']);
  assert.deepEqual(layout.automatic, {});
});

test('Show done plans returning child regions when their saved hexes were reused', () => {
  const graph = { ...beads, block: { id: 'block', parentId: 'root', kind: 'work', status: 'open' } };
  const positions = { ...saved, block: p(2) };
  const f = fixture(positions, graph);
  const back = new Set(['child', 'b', 'deep', 'c']);
  const layout = layoutCell({ ...f, hidden: back, yieldIds: back });
  const out = planReveal({ ...f, layout, headId: 'parent', back, hidden: new Set(), yieldIds: back });
  assert.equal(out.ok, true, out.reason);
  assert.notEqual(out.same, true);
  const next = layoutCell({ ...f, saved: { ...positions, ...out.positions }, yieldIds: back });
  assert.deepEqual(next.positions.block, p(2));
  assert.deepEqual(next.positions.parent, out.moves.parent || p(0));
  for (const id of ['child', 'b', 'deep', 'c']) assert.deepEqual(next.positions[id], out.moves[id] || layout.positions[id]);
  assert.equal(new Set(Object.values(next.positions).map((p) => `${p.q},${p.r}`)).size, 7);
});


test('overlapping hidden regions do not mutate the caller’s flags', () => {
  const graph = Object.fromEntries(Object.entries(beads).map(([id, b]) => [id, { ...b, status: ['child', 'b', 'deep', 'c'].includes(id) ? 'closed' : 'open' }]));
  const f = fixture(saved, graph);
  const hiding = ['parent', 'child'];
  assert.deepEqual([...hiddenWork({ beads: graph }, f.layout, f.kids, hiding).hidden].sort(), ['b', 'c', 'child', 'deep']);
  assert.deepEqual(hiding, ['parent', 'child']);
  assert.deepEqual([...hiddenWork({ beads: graph }, f.layout, f.kids, ['child']).hidden].sort(), ['b', 'c', 'deep']);
  graph.child.status = 'open';
  assert.deepEqual([...hiddenWork({ beads: graph }, f.layout, f.kids, ['parent']).hidden].sort(), ['c', 'deep']);
});


test('hive reveal restores free done slots and places collisions without moving visible work', async () => {
  const { planHiveReveal } = await import('../public/cell-move.js');
  assert.equal(typeof planHiveReveal, 'function');
  const graph = { ...Object.fromEntries(Object.entries(beads).map(([id, b]) => [id, { ...b, status: ['a', 'b', 'deep', 'c'].includes(id) ? 'closed' : 'open' }])), blocker: { id: 'blocker', parentId: 'root', status: 'open', kind: 'work' }, loose: { id: 'loose', parentId: 'root', status: 'closed', kind: 'work' } };
  const positions = { ...saved, blocker: p(4), loose: p(4) };
  const f = fixture(positions, graph);
  const back = new Set(['a', 'b', 'deep', 'loose']);
  const hidden = new Set(['c']);
  const layout = layoutCell({ ...f, hidden: new Set([...back, ...hidden]), yieldIds: new Set([...back, ...hidden]) });
  const out = planHiveReveal({ ...f, layout, back, hidden, yieldIds: new Set([...back, ...hidden]) });
  assert.equal(out.ok, true, out.reason);
  const next = layoutCell({ ...f, saved: { ...positions, ...out.positions }, hidden, yieldIds: new Set([...back, ...hidden]) });
  assert.deepEqual(next.positions.blocker, positions.blocker);
  for (const id of ['parent', 'child']) assert.deepEqual(next.positions[id], layout.positions[id]);
  for (const id of ['a', 'b', 'deep']) assert.deepEqual(next.positions[id], out.positions[id] || positions[id]);
  const visible = Object.entries(next.positions).filter(([id]) => !hidden.has(id)).map(([, p]) => `${p.q},${p.r}`);
  assert.equal(new Set(visible).size, visible.length);
  assert.equal(pieces(['parent', 'a'].map((id) => next.positions[id])), 1);
  const { moveBeads } = await import('../server/ops.js');
  const { layoutBase } = await import('../public/layout-base.js');
  let data = { beadLayout: { cell: structuredClone(positions) }, arrangeAspect: {} };
  const rt = {
    snapshots: { hierarchyCurrent: true, graph: { beads: graph } },
    metadata: { cell: () => ({ rootBeadId: 'root', enabled: true }), mutate: (fn) => { const next = structuredClone(data); fn(next); data = next; }, epoch: 'e', version: 1 },
  };
  moveBeads(rt, { cellId: 'cell', positions: out.positions, stack: out.stack, base: layoutBase({ beads: graph, rootId: 'root', saved: positions }) });
  assert.deepEqual(data.beadLayout.cell, { ...positions, ...out.positions });
});

for (const detached of [false, true]) test(`hive reveal keeps free child slots and live positions (${detached ? 'pinned' : 'attached'} before hiding)`, async () => {
  const { planHiveReveal } = await import('../public/cell-move.js');
  const graph = Object.fromEntries(['root', 'parent', 'a', 'child', 'b'].map((id) => [id, { ...beads[id], status: ['child', 'b'].includes(id) ? 'closed' : 'open' }]));
  graph.blocker = { id: 'blocker', parentId: 'root', kind: 'work', status: 'open' };
  const q = detached ? 20 : 2;
  const positions = { parent: p(0), a: p(1), child: p(q), b: p(q + 1), blocker: p(40) };
  const detachedPinned = new Set(detached ? ['child'] : []);
  const f = fixture(positions, graph);
  const before = layoutCell({ ...f, detachedPinned });
  assert.equal(before.attachments.child.status, detached ? 'detached' : 'direct');
  positions.blocker = p(q);
  const back = new Set(['child', 'b']);
  const layout = layoutCell({ ...f, hidden: back, yieldIds: back, detachedPinned });
  const out = planHiveReveal({ ...f, layout, back, yieldIds: back });
  assert.equal(out.ok, true, out.reason);
  const next = layoutCell({ ...f, saved: { ...positions, ...out.positions }, yieldIds: back, detachedPinned: out.detachedPinned });
  assert.deepEqual(next.positions.blocker, p(q));
  assert.deepEqual(next.positions.parent, p(0));
  assert.deepEqual(next.positions.a, p(1));
  assert.deepEqual(next.positions.b, p(q + 1));
  assert.notDeepEqual(next.positions.child, p(q));
  assert.deepEqual([...next.detachedPinned], [...detachedPinned]);
});

for (const reused of [false, true]) test(`hive reveal preserves sibling attachment with ${reused ? 'reused' : 'free'} saved hexes`, async () => {
  const { planHiveReveal } = await import('../public/cell-move.js');
  const graph = {
    root: beads.root, parent: beads.parent, child: { ...beads.child, status: 'closed' }, b: { ...beads.b, status: 'closed' },
    sibling: { id: 'sibling', kind: 'workstream', parentId: 'parent', status: 'closed' },
    blocker: { id: 'blocker', kind: 'work', parentId: 'root', status: 'open' },
  };
  const positions = { parent: p(0), child: p(2), b: p(3), sibling: p(1), blocker: p(40) };
  const f = fixture(positions, graph);
  assert.deepEqual(f.layout.groupHeads, ['parent', 'child', 'sibling']);
  assert.equal(f.layout.attachments.child.status, 'sibling');
  if (reused) positions.blocker = p(2);
  const back = new Set(['child', 'b', 'sibling']);
  const layout = layoutCell({ ...f, hidden: back, yieldIds: back });
  const out = planHiveReveal({ ...f, layout, back, yieldIds: back });
  assert.equal(out.ok, true, out.reason);
  const next = layoutCell({ ...f, saved: { ...positions, ...out.positions }, yieldIds: back, detachedPinned: out.detachedPinned });
  assert.deepEqual(next.positions.blocker, positions.blocker);
  if (!reused) assert.equal(out.same, true);
  assert.deepEqual(next.positions.parent, p(0));
  assert.notEqual(next.attachments.child.status, 'detached');
  assert.notEqual(next.attachments.sibling.status, 'detached');
  assert.deepEqual([...next.detachedPinned], []);
});

for (const reused of [false, true]) test(`hive reveal follows reachable contacts when sibling summaries cycle (${reused ? 'reused' : 'free'} hexes)`, async () => {
  const { planHiveReveal } = await import('../public/cell-move.js');
  const graph = { root: beads.root, parent: beads.parent };
  for (const id of ['b', 'c', 'e']) graph[id] = { id, kind: 'workstream', parentId: 'parent', status: 'closed' };
  graph.blocker = { id: 'blocker', kind: 'work', parentId: 'root', status: 'open' };
  const positions = { parent: p(0), b: { q: 1, r: -2 }, c: { q: 2, r: -2 }, e: { q: 1, r: -1 }, blocker: p(40) };
  const f = fixture(positions, graph);
  assert.equal(f.layout.attachments.b.via, 'c');
  assert.equal(f.layout.attachments.c.via, 'b');
  if (reused) positions.blocker = { ...positions.b };
  const back = new Set(['b', 'c', 'e']);
  const layout = layoutCell({ ...f, hidden: back, yieldIds: back });
  const out = planHiveReveal({ ...f, layout, back, yieldIds: back });
  assert.equal(out.ok, true, out.reason);
  if (!reused) { assert.equal(out.same, true); assert.deepEqual(out.positions, {}); }
  const next = layoutCell({ ...f, saved: { ...positions, ...out.positions }, yieldIds: back, detachedPinned: out.detachedPinned });
  assert.deepEqual(next.positions.blocker, positions.blocker);
  assert.deepEqual(next.positions.parent, p(0));
  for (const id of back) assert.notEqual(next.attachments[id].status, 'detached');
});

test('hive reveal preserves free saved constellations across random sibling contact graphs', async () => {
  const { planHiveReveal } = await import('../public/cell-move.js');
  const { neighbour, key } = await import('../public/hex-layout.js');
  let seed = 0x9a4;
  const random = (n) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  for (let trial = 0; trial < 100; trial++) {
    const graph = { root: beads.root, parent: beads.parent }, positions = { parent: p(0) }, back = new Set();
    const points = [p(0)], taken = new Set(['0,0']);
    for (let i = 0; i < 15; i++) {
      const frontier = new Map();
      for (const point of points) for (let d = 0; d < 6; d++) {
        const at = neighbour(point, d);
        if (!taken.has(key(at))) frontier.set(key(at), at);
      }
      const at = [...frontier.values()][random(frontier.size)];
      const id = `s${i}`;
      graph[id] = { id, kind: 'workstream', parentId: 'parent', status: 'closed' };
      positions[id] = at; back.add(id); points.push(at); taken.add(key(at));
    }
    const f = fixture(positions, graph);
    const layout = layoutCell({ ...f, hidden: back, yieldIds: back });
    const out = planHiveReveal({ ...f, layout, back, yieldIds: back });
    assert.equal(out.ok, true, `trial ${trial}: ${out.reason}`);
    assert.equal(out.same, true, `trial ${trial}: ${JSON.stringify(out.positions)}`);
    assert.deepEqual(out.positions, {});
  }
});

for (const detached of [false, true]) test(`hive hide/show preserves done origins and ${detached ? 'detached pins' : 'live repairs'}`, async () => {
  const { planHide, planHiveReveal } = await import('../public/cell-move.js');
  const graph = Object.fromEntries([
    ['root', null, 'goal', 'open'], ['parent', 'root', 'workstream', 'open'], ['a', 'parent', 'work', 'closed'],
    ['openChild', 'parent', 'workstream', 'open'], ['closedChild', 'parent', 'workstream', 'closed'],
  ].map(([id, parentId, kind, status]) => [id, { id, parentId, kind, status }]));
  const positions = { parent: p(0), a: p(1), openChild: p(2), closedChild: p(detached ? 30 : 3) };
  const f = fixture(positions, graph), detachedPinned = new Set(detached ? ['closedChild'] : []);
  const before = layoutCell({ ...f, detachedPinned });
  assert.equal(before.attachments.closedChild.status, detached ? 'detached' : 'sibling');
  const hidden = hiddenWork({ beads: graph }, before, f.kids, ['root', ...before.groupHeads]).hidden;
  const hide = planHide({ ...f, layout: before, hidden, yieldIds: hidden });
  assert.equal(hide.ok, true, hide.reason);
  const saved = { ...positions, ...hide.positions };
  const layout = layoutCell({ ...f, saved, hidden, yieldIds: hidden, detachedPinned: hide.detachedPinned });
  assert.notDeepEqual(layout.positions.openChild, positions.openChild);
  const args = { ...f, saved, layout, back: hidden, hidden: new Set(), yieldIds: hidden };
  const show = planHiveReveal(args);
  assert.equal(show.ok, true, show.reason);
  const next = layoutCell({ ...f, saved: { ...saved, ...show.positions }, yieldIds: hidden, detachedPinned: show.detachedPinned || layout.detachedPinned });
  assert.notEqual(next.attachments.openChild.status, 'detached');
  assert.deepEqual(next.positions.closedChild, positions.closedChild);
  assert.deepEqual(next.positions.openChild, layout.positions.openChild);
  assert.deepEqual([...next.detachedPinned], [...detachedPinned]);
});

test('global reveal cannot enclose an attached open region inside a family ring', async () => {
  const { planHide, planHiveReveal } = await import('../public/cell-move.js');
  const graph = Object.fromEntries([
    ['root', null, 'goal', 'open'], ['n0', 'root', 'work', 'open'], ['n1', 'n0', 'work', 'closed'],
    ['n2', 'n0', 'work', 'open'], ['n4', 'n2', 'workstream', 'open'], ['n5', 'n1', 'work', 'closed'],
    ['n10', 'n0', 'workstream', 'open'], ['n11', 'n4', 'workstream', 'closed'], ['block', 'root', 'work', 'open'],
  ].map(([id, parentId, kind, status]) => [id, { id, parentId, kind, status }]));
  const positions = { n0: p(0), n1: p(0, -1), n2: p(-1, 1), n4: p(-2, 1), n5: p(1, -1), n10: p(-1), n11: p(-2), block: p(20, 20) };
  const f = fixture(positions, graph);
  const back = hiddenWork({ beads: graph }, f.layout, f.kids, ['root', ...f.layout.groupHeads]).hidden;
  const hide = planHide({ ...f, hidden: back, yieldIds: back });
  assert.equal(hide.ok, true, hide.reason);
  const saved = { ...positions, ...hide.positions, block: p(1, -1) };
  const layout = layoutCell({ ...f, saved, hidden: back, yieldIds: back, detachedPinned: hide.detachedPinned });
  assert.equal(layout.attachments.n10.status, 'direct');
  const out = planHiveReveal({ ...f, layout, saved, back, yieldIds: back });
  assert.equal(out.ok, true, out.reason);
  const next = layoutCell({ ...f, saved: { ...saved, ...out.positions }, yieldIds: back, detachedPinned: out.detachedPinned });
  assert.deepEqual(next.positions.block, saved.block);
  assert.deepEqual(next.positions.n10, positions.n10);
  for (const id of ['n10', 'n2', 'n4']) assert.notEqual(next.attachments[id].status, 'detached');
});
