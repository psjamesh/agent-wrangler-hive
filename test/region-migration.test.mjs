import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MetadataStore } from '../server/metadata-store.js';
import { legacyLayoutCell } from '../public/legacy-cell-layout.js';
import { layoutCell } from '../public/cell-layout.js';
import { activeKids, archiveHidden } from '../public/archive-layout.js';

const p = (q, r = 0) => ({ q, r });
const graph = Object.fromEntries([
  ['root', null, 'goal'], ['parent', 'root', 'workstream'], ['a', 'parent', 'work'],
  ['nested', 'parent', 'workstream'], ['b', 'nested', 'work'], ['closed', 'nested', 'work'],
].map(([id, parentId, kind]) => [id, { id, parentId, kind, status: id === 'closed' ? 'closed' : 'open' }]));
async function migration() {
  const mod = await import('../server/region-migration.js').catch(() => ({}));
  assert.equal(typeof mod.migrateRegions, 'function', 'versioned migration must exist');
  return mod.migrateRegions;
}
function store(t, saved = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-regions-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const metadata = new MetadataStore({ file: path.join(dir, 'metadata.json') });
  metadata.mutate((d) => {
    d.cells.cell = { id: 'cell', enabled: true, rootBeadId: 'root' };
    d.beadLayout.cell = saved;
    d.arrangeAspect.cell = 1.8;
  });
  return metadata;
}

test('migration pins legacy unsaved positions once and leaves saved positions identical', async (t) => {
  const migrate = await migration();
  const metadata = store(t, { parent: p(25), nested: p(26) });
  const legacy = legacyLayoutCell({ kids: activeKids(graph), rootId: 'root', saved: metadata.read().beadLayout.cell, aspect: 1.8, yieldIds: new Set(['closed']) });
  assert.equal(migrate(metadata, graph), true);
  const saved = metadata.read().beadLayout.cell;
  assert.deepEqual(saved, legacy.positions);
  assert.equal(metadata.read().regionLayout.cell, 1);
  assert.deepEqual(layoutCell({ kids: activeKids(graph), rootId: 'root', saved, aspect: 1.8, yieldIds: new Set(['closed']) }).positions, legacy.positions);
  const version = metadata.version;
  assert.equal(migrate(metadata, graph), false);
  assert.equal(metadata.version, version);
  const reloaded = new MetadataStore({ file: metadata.file });
  assert.equal(migrate(reloaded, graph), false);
});

test('migration keeps closed canonical stacks and archive geometry untouched', async (t) => {
  const migrate = await migration();
  const canonical = { parent: p(0), a: p(1), nested: p(2), b: p(3), closed: p(3) };
  const metadata = store(t, canonical);
  metadata.mutate((d) => { d.archived.elsewhere = { ids: ['other'], positions: { other: p(80) } }; });
  const archives = structuredClone(metadata.read().archived);
  migrate(metadata, graph);
  assert.deepEqual(metadata.read().beadLayout.cell, canonical);
  assert.deepEqual(metadata.read().archived, archives);
});

test('migration does not revive archived descendants or discard owed restore geometry', async (t) => {
  const migrate = await migration();
  const closed = Object.fromEntries(Object.entries(graph).map(([id, b]) => [id, { ...b, status: 'closed', closedAt: 'old' }]));
  const metadata = store(t);
  metadata.mutate((d) => {
    d.archived.parent = { ids: ['parent', 'a', 'nested', 'b', 'closed'], closedAt: 'old', positions: { parent: p(4), a: p(5), nested: p(40), b: p(41), closed: p(42) } };
    d.restoring.op = { heads: ['parent'], positions: { parent: p(4) } };
  });
  const before = structuredClone(metadata.read());
  migrate(metadata, closed);
  assert.deepEqual(metadata.read().beadLayout.cell, {});
  assert.deepEqual(metadata.read().archived, before.archived);
  assert.deepEqual(metadata.read().restoring, before.restoring);
  assert.equal(archiveHidden({ beads: closed, rootId: 'root', archived: metadata.read().archived }).size, 5);
});

test('missing graphs are not marked migrated, and later new work does not get legacy placement', async (t) => {
  const migrate = await migration();
  const metadata = store(t);
  assert.equal(migrate(metadata, {}), false);
  assert.equal(metadata.read().regionLayout?.cell, undefined);
  migrate(metadata, graph);
  const saved = structuredClone(metadata.read().beadLayout.cell);
  const later = { ...graph, next: { id: 'next', parentId: 'nested', kind: 'work' } };
  assert.equal(migrate(metadata, later), false);
  assert.deepEqual(metadata.read().beadLayout.cell, saved);
  assert.equal(metadata.read().beadLayout.cell.next, undefined);
});

test('runtime migrates only a current hierarchy and before projecting any new layout', async (t) => {
  const { HiveRuntime } = await import('../server/runtime.js');
  const metadata = store(t, { parent: p(5), nested: p(20) });
  const fake = { metadata, snapshots: { hierarchyCurrent: false, graph: { beads: graph } } };
  HiveRuntime.prototype.migrateRegions.call(fake);
  assert.equal(metadata.read().regionLayout.cell, undefined);
  fake.snapshots.hierarchyCurrent = true;
  HiveRuntime.prototype.migrateRegions.call(fake);
  assert.equal(metadata.read().regionLayout.cell, 1);
  assert.ok(metadata.read().beadLayout.cell.b);
});

test('a failed migration write is atomic and retryable', async (t) => {
  const migrate = await migration();
  const metadata = store(t, { parent: p(10) });
  const before = structuredClone(metadata.read());
  const mutate = metadata.mutate.bind(metadata);
  metadata.mutate = () => { throw new Error('disk full'); };
  assert.throws(() => migrate(metadata, graph), /disk full/);
  assert.deepEqual(metadata.read(), before);
  metadata.mutate = mutate;
  assert.equal(migrate(metadata, graph), true);
});

for (const [label, previousBase] of [['nested', '26894a63fc768363:60'], ['independent peer', 'd8b923011f5968a6:82']]) test(`${label} browser moves are stale even when all saved coordinates were already pinned`, async () => {
  const { layoutBase } = await import('../public/layout-base.js');
  const { moveBeads } = await import('../server/ops.js');
  const beads = { root: { id: 'root', kind: 'goal' }, a: { id: 'a', parentId: 'root', kind: 'workstream' } };
  const saved = { a: p(0) };
  assert.notEqual(layoutBase({ beads, rootId: 'root', saved }), previousBase);
  let doc = { beadLayout: { cell: saved }, arrangeAspect: {}, archived: {} };
  const rt = { snapshots: { hierarchyCurrent: true, graph: { beads } }, metadata: { cell: () => ({ rootBeadId: 'root' }), mutate: (fn) => fn(doc) } };
  assert.throws(() => moveBeads(rt, { cellId: 'cell', positions: { a: p(1) }, base: previousBase }), /changed/);
  assert.deepEqual(doc.beadLayout.cell.a, p(0));
});

test('the first runtime projection includes migrated coordinates and subsequent renders do not write', async (t) => {
  const { HiveRuntime } = await import('../server/runtime.js');
  const metadata = store(t, { parent: p(5), nested: p(20) });
  const rt = {
    metadata, snapshots: { hierarchyCurrent: true, graph: { beads: graph }, current: { graph: { beads: graph, edges: [] }, revision: 1 } },
    paths: {}, beads: { status: { state: 'ready' } }, _projection: { key: '', value: null },
  };
  rt.migrateRegions = () => HiveRuntime.prototype.migrateRegions.call(rt);
  const projection = HiveRuntime.prototype.projection.call(rt);
  assert.ok(projection.cells.cell.beadLayout.b);
  assert.deepEqual(projection.cells.cell.beadLayout, metadata.read().beadLayout.cell);
  const version = metadata.version;
  assert.equal(HiveRuntime.prototype.projection.call(rt), projection);
  assert.equal(metadata.version, version);
});

for (const stacked of [false, true]) {
  test(`migration preserves the whole legacy enclosure translation${stacked ? ' with a closed canonical stack' : ''}`, async (t) => {
    const migrate = await migration();
    const beads = {
      root: { id: 'root', kind: 'goal' }, h: { id: 'h', parentId: 'root', kind: 'workstream' },
      a: { id: 'a', parentId: 'h', kind: 'work' }, fresh: { id: 'fresh', parentId: 'h', kind: 'work' },
    };
    const saved = { h: p(0), a: p(1) };
    const directions = [p(1), p(1, -1), p(0, -1), p(-1), p(-1, 1), p(0, 1)];
    let count = 0;
    for (const at of [p(0), p(1)]) for (const d of directions) {
      const pos = p(at.q + d.q, at.r + d.r);
      if (Object.values(saved).some((p) => p.q === pos.q && p.r === pos.r)) continue;
      const id = `block${count++}`;
      beads[id] = { id, parentId: 'root', kind: 'work' };
      saved[id] = pos;
    }
    if (stacked) {
      beads.closed = { id: 'closed', parentId: 'h', kind: 'work', status: 'closed' };
      saved.closed = p(1);
    }
    const metadata = store(t, saved);
    const legacy = legacyLayoutCell({ kids: activeKids(beads), rootId: 'root', saved, aspect: 1.8, yieldIds: new Set(['closed']) });
    assert.notDeepEqual(legacy.positions.h, saved.h);
    migrate(metadata, beads);
    const migrated = metadata.read().beadLayout.cell;
    for (const id of ['h', 'a', 'fresh']) assert.deepEqual(migrated[id], legacy.positions[id], id);
    for (const id of Object.keys(saved).filter((id) => id.startsWith('block'))) assert.deepEqual(migrated[id], saved[id]);
    if (stacked) assert.deepEqual(migrated.closed, migrated.a);
    const peer = layoutCell({ kids: activeKids(beads), rootId: 'root', saved: migrated, yieldIds: new Set(['closed']) });
    for (const id of ['h', 'a', 'fresh']) assert.deepEqual(peer.positions[id], legacy.positions[id]);
    assert.equal(metadata.read().regionLayout.cell, 1);
  });
}

test('an atomic rename failure leaves migration memory and disk unversioned for retry', async (t) => {
  const migrate = await migration();
  const metadata = store(t, { parent: p(10) });
  const diskBefore = fs.readFileSync(metadata.file, 'utf8');
  const memoryBefore = structuredClone(metadata.read());
  const versionBefore = metadata.version;
  const rename = fs.renameSync;
  let attempts = 0;
  fs.renameSync = (from, to) => {
    if (to === metadata.file) {
      attempts++;
      assert.equal(JSON.parse(fs.readFileSync(from, 'utf8')).regionLayout.cell, 1);
      throw new Error('injected migration rename failure');
    }
    return rename(from, to);
  };
  try { assert.throws(() => migrate(metadata, graph), /migration rename failure/); }
  finally { fs.renameSync = rename; }
  assert.equal(attempts, 1);
  assert.equal(metadata.version, versionBefore);
  assert.deepEqual(metadata.read(), memoryBefore);
  assert.equal(fs.readFileSync(metadata.file, 'utf8'), diskBefore);
  assert.equal(migrate(metadata, graph), true);
  const reloaded = new MetadataStore({ file: metadata.file });
  assert.equal(reloaded.read().regionLayout.cell, 1);
  assert.ok(reloaded.read().beadLayout.cell.b);
});

test('projection flags inherited detached workstreams without moving their saved coordinates',async(t)=>{
  const {HiveRuntime}=await import('../server/runtime.js');
  const saved={parent:p(0),a:p(1),nested:p(40),b:p(41),closed:p(42)};
  const metadata=store(t,saved);
  const rt={metadata,paths:{},beads:{status:{state:'ready'}},snapshots:{hierarchyCurrent:true,graph:{beads:graph},current:{revision:1,graph:{beads:graph,edges:[]}}},_projection:{key:'',value:null}};
  rt.migrateRegions=()=>HiveRuntime.prototype.migrateRegions.call(rt);
  const projected=HiveRuntime.prototype.projection.call(rt);
  assert.deepEqual(projected.cells.cell.detachedWorkstreams,['nested']);
  assert.equal(projected.cells.cell.regionAttachments.nested.status,'detached');
  assert.deepEqual(projected.cells.cell.beadLayout,saved);
});
