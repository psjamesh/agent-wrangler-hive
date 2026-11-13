import assert from 'node:assert/strict';
import test from 'node:test';
import { linkBeads, waitingOn } from '../server/ops.js';
import { createSnapshotCache } from '../server/snapshots.js';

function fixture() {
  const cell = { id: 'cell_test', rootBeadId: 'hive-root' };
  const actor = { sessionId: 'worker', cell, cells: [{ cell, role: 'worker' }] };
  const graph = {
    beads: Object.fromEntries(['root', 'dep', 'pre'].map((name) => [`hive-${name}`, {
      id: `hive-${name}`, parentId: name === 'root' ? null : 'hive-root', status: 'open',
    }])),
    edges: [{ dependent: 'hive-dep', prerequisite: 'hive-pre', type: 'blocks', blocking: true }],
  };
  let stored = graph;
  let calls = 0;
  let read = async () => stored;
  const doc = { operations: {} };
  const beads = {
    status: { state: 'ready' },
    hierarchy: { generation: 0, writing: false },
    loadSnapshot: () => read(),
    async linkMany() { calls++; stored = { ...graph, edges: [] }; },
  };
  const rt = {
    beads,
    metadata: { read: () => doc, mutate: (fn) => fn(doc), cells: () => [cell] },
    snapshots: createSnapshotCache({ beads }),
  };
  return { rt, actor, doc, get calls() { return calls; }, setRead(fn) { read = fn; }, current: () => stored };
}
const links = [{ dependent: 'hive-dep', prerequisite: 'hive-pre', remove: true }];

test('link removal waits for the snapshot used by finish dependency checks', async () => {
  const f = fixture();
  await f.rt.snapshots.refresh();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  f.setRead(async () => { await gate; return f.current(); });
  let settled = false;
  const operation = linkBeads(f.rt, f.actor, { links }).then((out) => { settled = true; return out; });
  await new Promise(setImmediate);
  const settledBeforeRead = settled;
  release();
  const out = await operation;
  await f.rt.snapshots.refresh();
  assert.equal(settledBeforeRead, false, 'success must wait for dependency snapshot refresh');
  assert.equal(out.changed, 1);
  assert.deepEqual(waitingOn(f.rt, 'hive-dep'), []);
  assert.equal(f.calls, 1);
});

test('failed post-link refresh leaves an uncertain operation without repeating the write', async () => {
  const f = fixture();
  await f.rt.snapshots.refresh();
  f.setRead(async () => { throw new Error('read failed'); });
  await assert.rejects(linkBeads(f.rt, f.actor, { links }), { code: 'uncertain' });
  assert.equal(f.calls, 1);
  assert.equal(Object.values(f.doc.operations)[0].state, 'uncertain');
  assert.deepEqual(Object.values(f.doc.operations)[0].intent.links, [{ ...links[0], type: 'blocks' }]);
});


test('an uncertain native mutation is recorded without retrying it', async () => {
  const f = fixture();
  await f.rt.snapshots.refresh();
  let writes = 0;
  f.rt.beads.linkMany = async () => {
    writes++;
    throw Object.assign(new Error('native timeout'), { code: 'uncertain' });
  };
  await assert.rejects(linkBeads(f.rt, f.actor, { links }), { code: 'uncertain' });
  assert.equal(writes, 1);
  assert.equal(Object.values(f.doc.operations)[0].state, 'uncertain');
  assert.equal(f.rt.snapshots.graph.edges.length, 1);
});
