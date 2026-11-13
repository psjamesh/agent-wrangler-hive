import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HiveRuntime } from '../server/runtime.js';
import { buildGraph } from '../server/bead-model.js';
import { capacity } from '../server/admission.js';
import { cellCounts, workCounts, childrenMap, countsSentence } from '../public/model.js';

const raw = (id, parent, claimed = false) => ({ id, title: id, status: claimed ? 'in_progress' : 'open', assignee: claimed ? 'aw:worker' : '', metadata: { hive_kind: parent ? 'work' : 'goal' }, dependencies: parent ? [{ issue_id: id, depends_on_id: parent, type: 'parent-child' }] : [] });
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-capacity-'));
  let limit = 8;
  const rt = new HiveRuntime({ env: { AW_DATA_DIR: dir }, settings: { get: () => limit } });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  rt.metadata.mutate(d => {
    d.cells.one = { id: 'one', rootBeadId: 'root', enabled: true };
    d.cells.two = { id: 'two', rootBeadId: 'other', enabled: true };
  });
  let revision = 1;
  const setGraph = issues => {
    const graph = buildGraph(issues);
    rt.snapshots = { graph, current: { graph, revision: revision++, loadedAt: 1 } };
  };
  setGraph([raw('root'), raw('a', 'root', true), raw('b', 'root'), raw('other'), raw('c', 'other', true)]);
  return { rt, setGraph, setLimit: v => { limit = v; } };
}

test('global projection uses admission union and explains shared review/launch slots', t => {
  const { rt } = fixture(t);
  rt.metadata.mutate(d => {
    d.reviews.shared = { workBeadId: 'a', state: 'requested' };
    d.reviews.extra = { workBeadId: 'b', state: 'in_review' };
    d.workerLaunches.shared = { beadId: 'b', state: 'binding' };
    d.workerLaunches.extra = { beadId: 'missing', state: 'uncertain' };
    d.operations.claim = { kind: 'claim', state: 'pending', intent: { beadId: 'claiming' } };
  });
  const actual = rt.projection().capacity;
  assert.ok(actual, 'capacity is present in the view projection');
  const { breakdown, outside, ...counts } = actual;
  assert.equal(outside, 2);
  assert.deepEqual(counts, capacity(rt));
  assert.deepEqual(breakdown, { claimed: 2, reviews: 1, launching: 2 });
  assert.equal(actual.used, 5);
});

test('cached projection updates for claims, reviews, launches and limit changes without restart', t => {
  const f = fixture(t);
  assert.equal(f.rt.projection().capacity?.used, 2);
  f.rt.metadata.mutate(d => { d.reviews.r = { workBeadId: 'b', state: 'requested' }; });
  assert.equal(f.rt.projection().capacity.used, 3);
  f.rt.metadata.mutate(d => { d.reviews.r.state = 'approved'; d.workerLaunches.l = { beadId: 'missing', state: 'reserved' }; });
  assert.equal(f.rt.projection().capacity.breakdown.launching, 1);
  f.rt.metadata.mutate(d => { d.workerLaunches.l.state = 'launched'; });
  f.setGraph([raw('root'), raw('a', 'root'), raw('other'), raw('c', 'other', true)]);
  assert.equal(f.rt.projection().capacity.used, 1);
  f.setLimit(0);
  assert.equal(f.rt.projection().capacity.unlimited, true);
  f.setLimit(1);
  assert.equal(f.rt.projection().capacity.limit, 1);
});

test('per-cell occupied counts sum to capacity and mixed-hive summaries partition work', t => {
  const { rt, setGraph } = fixture(t);
  rt.metadata.mutate(d => {
    d.cells.three = { id: 'three', rootBeadId: 'third', enabled: true };
    d.reviews.claimed = { workBeadId: 'a', state: 'requested' };
    d.reviews.extra = { workBeadId: 'review', state: 'in_review' };
    d.workerLaunches.shared = { beadId: 'review', state: 'binding' };
    d.workerLaunches.extra = { beadId: 'launch', state: 'reserved' };
    d.operations.claim = { kind: 'claim', state: 'pending', intent: { beadId: 'claiming' } };
  });
  const heading = (id, parent, kind, claimed = false) => ({ ...raw(id, parent, claimed), status: 'in_progress', metadata: { hive_kind: kind } });
  setGraph([
    heading('root', null, 'goal', true), heading('stream', 'root', 'workstream', true),
    raw('a', 'stream', true), { ...raw('unowned', 'stream'), status: 'in_progress' },
    { ...raw('blocked', 'root', true), status: 'blocked' },
    heading('external', 'root', 'external', true),
    heading('other', null, 'goal'), heading('heading', 'other', 'workstream'),
    raw('b', 'heading', true), raw('review', 'heading'), raw('launch', 'other'),
    raw('third'), raw('c', 'third', true), raw('claiming', 'third'),
  ]);
  const hive = rt.projection();
  const cells = Object.values(hive.cells);
  const counts = cells.map(cell => cell.occupiedCount);
  assert.deepEqual(counts, [1, 3, 2]);
  assert.equal(counts.reduce((sum, count) => sum + count, 0), hive.capacity.used);
  for (const cell of cells) {
    for (const c of [cellCounts(hive, cell), workCounts(hive, childrenMap(hive.beads), cell.rootBeadId)]) {
      assert.equal(c.open + c.in_progress + c.in_review + c.blocked + c.closed + c.not_active, c.total);
    }
  }
  assert.equal(workCounts(hive, childrenMap(hive.beads), 'stream').in_progress, 0);
});

test('disabled, retired and nested hives attribute occupied work to exactly one nearest cell', t => {
  const { rt, setGraph } = fixture(t);
  rt.metadata.mutate(d => {
    d.cells.two.enabled = false;
    d.cells.nested = { id: 'nested', rootBeadId: 'nested', enabled: true };
    d.cells.retired = { id: 'retired', rootBeadId: 'retired', enabled: false, retired: { outcome: 'done' } };
    d.workerLaunches.missing = { beadId: 'missing', state: 'reserved' };
    d.operations.orphan = { kind: 'claim', state: 'uncertain', intent: { beadId: 'orphan' } };
    d.reviews.outside = { workBeadId: 'outside', state: 'requested' };
  });
  setGraph([raw('root'), raw('a', 'root', true), raw('other'), raw('b', 'other', true),
    { ...raw('nested', 'root'), metadata: { hive_kind: 'goal' } }, raw('n', 'nested', true),
    raw('retired'), raw('r', 'retired', true), { ...raw('orphan'), metadata: { hive_kind: 'work' } }, { ...raw('outside'), metadata: { hive_kind: 'work' } }]);
  const hive = rt.projection();
  assert.deepEqual(Object.values(hive.cells).map(c => c.occupiedCount), [1, 1, 1, 1]);
  assert.equal(hive.capacity.outside, 3);
  assert.equal(Object.values(hive.cells).reduce((n, c) => n + c.occupiedCount, hive.capacity.outside), hive.capacity.used);
});

test('summary categories partition reviewed, closed and status-only work without overlap', t => {
  const { rt, setGraph } = fixture(t);
  rt.metadata.mutate(d => {
    d.reviews.claimed = { workBeadId: 'a', state: 'requested' };
    d.reviews.closed = { workBeadId: 'c', state: 'in_review' };
  });
  setGraph([raw('root'), raw('a', 'root', true), { ...raw('c', 'root'), status: 'closed' },
    { ...raw('h', 'root'), status: 'in_progress', metadata: { hive_kind: 'workstream' } },
    { ...raw('u', 'h'), status: 'in_progress' }, raw('other')]);
  const hive = rt.projection();
  for (const c of [cellCounts(hive, hive.cells.one), workCounts(hive, childrenMap(hive.beads), 'root')]) {
    assert.equal(c.in_progress, 0);
    assert.equal(c.in_review, 1);
    assert.equal(c.closed, 1);
    assert.equal(c.not_active, 2);
    assert.equal(c.open + c.in_progress + c.in_review + c.blocked + c.closed + c.not_active, c.total);
    assert.match(countsSentence(c), /2 not active/);
  }
  assert.equal(hive.cells.one.occupiedCount, 2);
});
