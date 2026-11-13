import test from 'node:test';
import assert from 'node:assert/strict';
import { activeKids } from '../public/archive-layout.js';
import { layoutCell } from '../public/cell-layout.js';
import { planHide, planHiveReveal, planMove } from '../public/cell-move.js';
import { key, neighbour } from '../public/hex-layout.js';

function fixture(extra = 0) {
  const beads = Object.fromEntries([
    ['root', null, 'goal'], ['alpha', 'root', 'workstream'],
    ['beta', 'alpha', 'work'], ['gamma', 'alpha', 'work'],
    ['hive-demo1', 'alpha', 'work'],
  ].map(([id, parentId, kind]) => [id, { id, parentId, kind, status: ['beta', 'gamma'].includes(id) ? 'closed' : 'open' }]));
  const saved = { alpha: { q: 0, r: 0 }, beta: { q: 1, r: 0 }, gamma: { q: 2, r: 0 }, 'hive-demo1': { q: 3, r: 0 } };
  for (let i = 0; i < extra; i++) {
    beads[`tail${i}`] = { id: `tail${i}`, parentId: 'alpha', kind: 'work', status: 'open' };
    saved[`tail${i}`] = { q: 4 + i, r: 0 };
  }
  const kids = activeKids(beads), hidden = new Set(['beta', 'gamma']);
  const args = { kids, rootId: 'root', saved, hidden, yieldIds: hidden };
  return { beads, ...args, layout: layoutCell({ ...args, hidden: new Set() }) };
}
const touches = (a, b) => Array.from({ length: 6 }, (_, d) => key(neighbour(a, d))).includes(key(b));

test('A detached tile returns beside its anchor when its two done bridges hide', () => {
  const f = fixture();
  const plan = planHide(f);
  assert.equal(plan.ok, true);
  const saved = { ...f.saved, ...plan.positions };
  assert.ok(touches(saved.alpha, saved['hive-demo1']));
  assert.deepEqual(saved['beta'], { q: 1, r: 0 });
  assert.deepEqual(saved['gamma'], { q: 2, r: 0 });
  const layout = layoutCell({ ...f, saved });
  assert.deepEqual(layout.positions['hive-demo1'], saved['hive-demo1']);
  assert.equal(planHide({ ...f, saved, layout }).same, true);
});

test('a long detached chain keeps every relative offset and never occupies a visible hex', () => {
  const f = fixture(35), plan = planHide(f);
  assert.equal(plan.ok, true);
  const saved = { ...f.saved, ...plan.positions }, dq = saved['hive-demo1'].q - 3, dr = saved['hive-demo1'].r;
  assert.ok(dq || dr);
  for (let i = 0; i < 35; i++) assert.deepEqual(saved[`tail${i}`], { q: 4 + i + dq, r: dr });
  assert.equal(new Set(Object.entries(saved).filter(([id]) => !f.hidden.has(id)).map(([, p]) => key(p))).size, 37);
});

test('Show returns done cells to free old slots and never moves live work occupying an old slot', () => {
  const f = fixture();
  const saved = { ...f.saved, 'hive-demo1': { q: 1, r: 0 } };
  const layout = layoutCell({ ...f, saved });
  const plan = planHiveReveal({ ...f, saved, layout, hidden: new Set(), back: f.hidden });
  assert.equal(plan.ok, true);
  const next = { ...saved, ...plan.positions };
  assert.deepEqual(next['hive-demo1'], { q: 1, r: 0 });
  assert.deepEqual(next.alpha, { q: 0, r: 0 });
  assert.deepEqual(next['gamma'], { q: 2, r: 0 });
  assert.notEqual(key(next['beta']), '1,0');
  assert.equal(new Set(Object.values(next).map(key)).size, 4);
});

test('manual dragging onto a hidden done origin remains saved through Show and repeated toggles', () => {
  const f = fixture();
  const hide = planHide(f), saved = { ...f.saved, ...hide.positions };
  const layout = layoutCell({ ...f, saved });
  const drag = planMove({ ...f, saved, layout, id: 'hive-demo1', target: { q: 1, r: 0 } });
  assert.equal(drag.ok, true);
  Object.assign(saved, drag.positions);
  const shown = planHiveReveal({ ...f, saved, layout: layoutCell({ ...f, saved }), hidden: new Set(), back: f.hidden });
  assert.equal(shown.ok, true);
  Object.assign(saved, shown.positions);
  assert.deepEqual(saved['hive-demo1'], { q: 1, r: 0 });
  for (let i = 0; i < 3; i++) {
    const hiding = planHide({ ...f, saved, layout: layoutCell({ ...f, saved, hidden: new Set() }) });
    assert.equal(hiding.same, true);
    const showing = planHiveReveal({ ...f, saved, layout: layoutCell({ ...f, saved }), hidden: new Set(), back: f.hidden });
    assert.equal(showing.same, true);
  }
});


test('several detached groups move deterministically without changing unrelated work', () => {
  const f = fixture(3);
  f.beads.second = { id: 'second', parentId: 'alpha', kind: 'work', status: 'open' };
  f.saved.second = { q: 0, r: 4 };
  f.beads.other = { id: 'other', parentId: 'root', kind: 'workstream', status: 'open' };
  f.saved.other = { q: 1, r: -1 };
  for (let i = 1; i <= 3; i++) {
    const id = `bridge${i}`;
    f.beads[id] = { id, parentId: 'alpha', kind: 'work', status: 'closed' };
    f.saved[id] = { q: 0, r: i };
    f.hidden.add(id);
  }
  const kids = activeKids(f.beads), layout = layoutCell({ ...f, kids, hidden: new Set() });
  const first = planHide({ ...f, kids, layout });
  const second = planHide({ ...f, kids, layout });
  assert.deepEqual(second, first);
  const saved = { ...f.saved, ...first.positions };
  assert.deepEqual(saved.other, { q: 1, r: -1 });
  assert.ok(touches(saved.second, saved.alpha) || touches(saved.second, saved['hive-demo1']) || touches(saved.second, saved.tail0) || touches(saved.second, saved.tail1) || touches(saved.second, saved.tail2));
  assert.equal(new Set(Object.entries(saved).filter(([id]) => !f.hidden.has(id)).map(([, p]) => key(p))).size, 7);
});

test('Show never shifts a live region when outside work occupies a done origin', () => {
  const f = fixture();
  f.beads.block = { id: 'block', parentId: 'root', kind: 'work', status: 'open' };
  const saved = { ...f.saved, alpha: { q: 0, r: 0 }, 'hive-demo1': { q: 1, r: 0 }, beta: { q: 2, r: 0 }, gamma: { q: 3, r: 0 }, block: { q: 2, r: 0 } };
  const kids = activeKids(f.beads), layout = layoutCell({ ...f, kids, saved });
  const plan = planHiveReveal({ ...f, kids, layout, saved, back: f.hidden, hidden: new Set() });
  assert.equal(plan.ok, true);
  for (const id of ['alpha', 'hive-demo1', 'block']) assert.deepEqual(plan.positions[id] || saved[id], saved[id]);
  assert.deepEqual(plan.positions['gamma'] || saved['gamma'], { q: 3, r: 0 });
});

test('saved hide and Show batches pass the server collision checks', async () => {
  const { moveBeads } = await import('../server/ops.js');
  const { layoutBase } = await import('../public/layout-base.js');
  const f = fixture(4), data = { beadLayout: { cell: structuredClone(f.saved) }, arrangeAspect: {} };
  const rt = {
    snapshots: { hierarchyCurrent: true, graph: { beads: f.beads } },
    metadata: { cell: () => ({ rootBeadId: 'root', enabled: true }), mutate: fn => fn(data), epoch: 'e', version: 1 },
  };
  const apply = plan => moveBeads(rt, { cellId: 'cell', positions: plan.positions, stack: plan.stack, base: layoutBase({ beads: f.beads, rootId: 'root', saved: data.beadLayout.cell }) });
  const hiding = planHide(f);
  apply(hiding);
  assert.deepEqual(data.beadLayout.cell['hive-demo1'], { q: 1, r: 0 });
  const saved = structuredClone(data.beadLayout.cell), layout = layoutCell({ ...f, saved });
  const showing = planHiveReveal({ ...f, saved, layout, hidden: new Set(), back: f.hidden });
  apply(showing);
  for (const id of ['alpha', 'hive-demo1', 'tail0', 'tail1', 'tail2', 'tail3']) assert.deepEqual(data.beadLayout.cell[id], saved[id]);
  assert.equal(new Set(Object.values(data.beadLayout.cell).map(key)).size, 8);
});

test('done collision ties prefer a dependency when the parent is far away', () => {
  const beads = Object.fromEntries([
    ['root', null, 'goal'], ['ws', 'root', 'workstream'], ['done', 'ws', 'work'], ['block', 'root', 'work'], ['dep', 'root', 'work'],
  ].map(([id, parentId, kind]) => [id, { id, parentId, kind }]));
  const saved = { ws: { q: 20, r: 0 }, done: { q: 0, r: 0 }, block: { q: 0, r: 0 }, dep: { q: 1, r: -1 } };
  const kids = activeKids(beads), back = new Set(['done']);
  const layout = layoutCell({ kids, rootId: 'root', saved, hidden: back, yieldIds: back });
  const args = { layout, kids, saved, back };
  assert.deepEqual(planHiveReveal(args).positions.done, { q: 1, r: 0 });
  assert.deepEqual(planHiveReveal({ ...args, edges: [{ prerequisite: 'dep', dependent: 'done', blocking: true }] }).positions.done, { q: 0, r: -1 });
});

test('a live descendant chain connected only through a hidden parent is pulled rigidly', () => {
  const f = fixture(2);
  f.beads['hive-demo1'].parentId = 'gamma';
  f.beads.tail0.parentId = 'hive-demo1';
  f.beads.tail1.parentId = 'hive-demo1';
  const kids = activeKids(f.beads), layout = layoutCell({ ...f, kids, hidden: new Set() });
  const plan = planHide({ ...f, kids, layout });
  assert.equal(plan.ok, true);
  const saved = { ...f.saved, ...plan.positions };
  assert.deepEqual(saved['hive-demo1'], { q: 1, r: 0 });
  assert.deepEqual(saved.tail0, { q: 2, r: 0 });
  assert.deepEqual(saved.tail1, { q: 3, r: 0 });
  assert.deepEqual(saved['gamma'], { q: 2, r: 0 });
});
