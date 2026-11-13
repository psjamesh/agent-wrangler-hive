import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HiveRuntime } from '../server/runtime.js';
import { buildGraph } from '../server/bead-model.js';
import { capacity } from '../server/admission.js';

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
  const { breakdown, ...counts } = actual;
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
