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

test('a write waits for a queued hierarchy change and its post-settlement export', async () => {
  const f = fixture();
  await f.rt.snapshots.refresh();
  f.rt.beads.hierarchy.writing = true;
  f.rt.beads.hierarchy.generation++;
  setImmediate(() => {
    f.rt.beads.hierarchy.writing = false;
    f.rt.beads.hierarchy.generation++;
  });
  const out = await linkBeads(f.rt, f.actor, { links });
  assert.equal(out.changed, 1);
  assert.equal(f.calls, 1);
  assert.equal(f.rt.snapshots.hierarchyCurrent, true);
});

test('hierarchy admission bounds a stuck export and leaves no write behind', async () => {
  const { waitForHierarchy } = await import('../server/access.js');
  const f = fixture();
  await f.rt.snapshots.refresh();
  f.rt.beads.hierarchy.generation++;
  f.setRead(() => new Promise(() => {}));
  await assert.rejects(waitForHierarchy(f.rt, { timeoutMs: 20 }), error => {
    assert.equal(error.code, 'busy');
    assert.match(error.message, /safe to retry.*1 second/i);
    return true;
  });
  assert.equal(f.calls, 0);
  assert.deepEqual(f.doc.operations, {});
});

test('hierarchy admission requires a read started after the final settlement', async () => {
  const { waitForHierarchy } = await import('../server/access.js');
  const f = fixture();
  await f.rt.snapshots.refresh();
  let finishRead;
  const gate = new Promise(resolve => { finishRead = resolve; });
  let reads = 0;
  f.setRead(async () => {
    reads++;
    if (reads === 1) await gate;
    return f.current();
  });
  const refresh = f.rt.snapshots.refresh();
  f.rt.beads.hierarchy.generation++;
  f.rt.beads.hierarchy.writing = true;
  const wait = waitForHierarchy(f.rt, { timeoutMs: 2000 });
  finishRead();
  await refresh;
  assert.equal(f.rt.snapshots.hierarchyCurrent, false);
  assert.equal(reads, 1);
  f.rt.beads.hierarchy.generation++;
  f.rt.beads.hierarchy.writing = false;
  await wait;
  assert.equal(f.rt.snapshots.hierarchyCurrent, true);
  assert.equal(reads, 2);
});

test('a hierarchy waiter stops on runtime replacement without writing', async () => {
  const { waitForHierarchy } = await import('../server/access.js');
  const f = fixture();
  await f.rt.snapshots.refresh();
  f.rt.beads.hierarchy.writing = true;
  let stopped = false;
  f.rt.metadata.lifetime = { assertCurrent() { if (stopped) throw Object.assign(new Error('retired'), { code: 'runtime-stopped' }); } };
  const wait = waitForHierarchy(f.rt);
  stopped = true;
  await assert.rejects(wait, { code: 'runtime-stopped' });
  assert.equal(f.calls, 0);
});

test('a write waits when hierarchy invalidation begins after preparation at the journal gate', async () => {
  const { journaled } = await import('../server/ops.js');
  const f = fixture();
  await f.rt.snapshots.refresh();
  f.rt.beads.hierarchy.writing = true;
  f.rt.beads.hierarchy.generation++;
  setImmediate(() => {
    f.rt.beads.hierarchy.writing = false;
    f.rt.beads.hierarchy.generation++;
  });
  let calls = 0;
  await journaled(f.rt, { kind: 'example', beadIds: ['hive-dep'] }, async () => { calls++; return {}; });
  assert.equal(calls, 1);
  assert.equal(Object.values(f.doc.operations)[0].state, 'applied');
});

test('waiting at the journal gate cannot apply an action prepared against a moved bead', async () => {
  const { journaled } = await import('../server/ops.js');
  const f = fixture();
  await f.rt.snapshots.refresh();
  f.rt.beads.hierarchy.writing = true;
  f.rt.beads.hierarchy.generation++;
  setImmediate(() => {
    const next = structuredClone(f.current());
    next.beads['hive-dep'].parentId = null;
    f.setRead(async () => next);
    f.rt.beads.hierarchy.writing = false;
    f.rt.beads.hierarchy.generation++;
  });
  let calls = 0;
  await assert.rejects(journaled(f.rt, { kind: 'example', beadIds: ['hive-dep'] }, async () => { calls++; return {}; }), /changed while waiting/);
  assert.equal(calls, 0);
  assert.deepEqual(f.doc.operations, {});
});

test('settlement during a running refresh waits for the coalesced follow-up export', async () => {
  const { waitForHierarchy } = await import('../server/access.js');
  const f = fixture();
  let settled;
  f.rt.beads.onHierarchySettled = fn => { settled = fn; };
  f.rt.snapshots = createSnapshotCache({ beads: f.rt.beads });
  await f.rt.snapshots.refresh();
  let finishRead;
  const gate = new Promise(resolve => { finishRead = resolve; });
  let reads = 0;
  f.setRead(async () => {
    if (++reads === 1) await gate;
    return f.current();
  });
  const refresh = f.rt.snapshots.refresh();
  f.rt.beads.hierarchy.generation += 2;
  settled();
  const waiting = waitForHierarchy(f.rt);
  finishRead();
  await Promise.all([refresh, waiting]);
  assert.equal(f.rt.snapshots.hierarchyCurrent, true);
  assert.equal(reads, 2);
});
