import test from 'node:test';
import assert from 'node:assert/strict';
import { pickupFixture } from './helpers/pickup.mjs';
import { createSnapshotCache } from '../server/snapshots.js';
import { createBeadsTool } from '../server/tools.js';

const flush = () => new Promise(setImmediate);
const input = { beads: [{ ref: 'new', title: 'New work', kind: 'investigation' }] };

async function fixture() {
  const f = pickupFixture();
  let writes = 0;
  f.rt.beads.hierarchy = { generation: 0, writing: false };
  f.rt.beads.createMany = async () => {
    writes++;
    f.live.created = { ...structuredClone(f.live.a), id: 'created', title: 'New work' };
    f.rt.beads.hierarchy.generation += 2;
    return { ids: { new: 'created' } };
  };
  f.rt.snapshots = createSnapshotCache({ beads: f.rt.beads });
  await f.rt.snapshots.refresh();
  return { ...f, get writes() { return writes; }, create: () => createBeadsTool.handler({ host: f.host, caller: 'queen' }, input) };
}

test('create returns confirmed ids by its settlement deadline while an export is stuck', async t => {
  const f = await fixture();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  f.rt.beads.loadSnapshot = async () => { await gate; return f.graph(); };
  let response;
  const operation = f.create().then(out => { response = out; });
  try {
    await flush();
    assert.equal(f.writes, 1);
    t.mock.timers.tick(10000);
    await flush();
    assert.ok(response, 'the MCP response must not depend on the export completing');
    assert.equal(response.isError, undefined);
    assert.deepEqual(response.structuredContent.ids, { new: 'created' });
    assert.match(response.structuredContent.note, /created.*settling.*do not repeat/i);
    const op = f.doc().operations[response.structuredContent.op_id];
    assert.equal(op.state, 'applied');
    assert.deepEqual(op.result.ids, { new: 'created' });
    assert.equal(f.rt.snapshots.hierarchyCurrent, false);
  } finally {
    release();
    await operation;
    await f.rt.snapshots.refresh();
  }
  assert.equal(f.rt.snapshots.hierarchyCurrent, true);
  assert.ok(f.rt.snapshots.graph.beads.created);
  assert.equal(f.writes, 1);
});

test('confirmed creation is journaled before snapshot settlement', async () => {
  const f = await fixture();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  f.rt.beads.loadSnapshot = async () => { await gate; return f.graph(); };
  const operation = f.create();
  try {
    await flush();
    const op = Object.values(f.doc().operations)[0];
    assert.equal(op.state, 'applied');
    assert.deepEqual(op.result.ids, { new: 'created' });
  } finally {
    release();
    await operation;
  }
});

test('coalesced follow-up exports cannot extend the create response deadline', async t => {
  const f = await fixture();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let releaseFirst, releaseRest;
  const first = new Promise(resolve => { releaseFirst = resolve; });
  const rest = new Promise(resolve => { releaseRest = resolve; });
  let reads = 0;
  f.rt.beads.loadSnapshot = async () => { await (++reads === 1 ? first : rest); return f.graph(); };
  let response;
  const operation = f.create().then(out => { response = out; });
  try {
    await flush();
    f.rt.snapshots.invalidate();
    releaseFirst();
    await flush();
    assert.equal(reads, 2);
    assert.ok(f.rt.snapshots.graph.beads.created);
    assert.equal(response, undefined);
    t.mock.timers.tick(10000);
    await flush();
    assert.ok(response, 'a follow-up export must not hold the original response');
    assert.deepEqual(response.structuredContent.ids, { new: 'created' });
    assert.match(response.structuredContent.note, /settling/);
  } finally {
    releaseFirst();
    releaseRest();
    await operation;
    await f.rt.snapshots.refresh();
  }
  assert.equal(f.writes, 1);
});

test('a failed post-create refresh still returns confirmed ids and keeps admission closed', async () => {
  const f = await fixture();
  f.rt.beads.loadSnapshot = async () => { throw new Error('export failed'); };
  const out = await f.create();
  assert.equal(out.isError, undefined);
  assert.deepEqual(out.structuredContent.ids, { new: 'created' });
  assert.match(out.structuredContent.note, /settling.*do not repeat/i);
  assert.equal(f.doc().operations[out.structuredContent.op_id].state, 'applied');
  assert.equal(f.rt.snapshots.hierarchyCurrent, false);
  assert.equal(f.writes, 1);
});

test('a quick post-create snapshot preserves the ordinary response', async () => {
  const f = await fixture();
  const out = await f.create();
  assert.equal(out.isError, undefined);
  assert.deepEqual(out.structuredContent.ids, { new: 'created' });
  assert.equal(out.structuredContent.note, undefined);
  assert.equal(f.rt.snapshots.hierarchyCurrent, true);
  assert.equal(f.writes, 1);
});

test('an uncertain create remains uncertain and is never repeated', async () => {
  const f = await fixture();
  f.rt.beads.createMany = async () => { throw Object.assign(new Error('native timeout'), { code: 'uncertain' }); };
  const out = await f.create();
  assert.equal(out.isError, true);
  assert.match(out.content[0].text, /native timeout.*Do not repeat/);
  assert.equal(Object.values(f.doc().operations)[0].state, 'uncertain');
  assert.equal(out.structuredContent, undefined);
});
