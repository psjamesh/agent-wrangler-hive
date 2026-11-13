import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileColours } from '../server/colours.js';
import * as colours from '../public/cell-layout.js';

const beads = {
  root: { id: 'root', kind: 'goal' },
  a: { id: 'a', parentId: 'root', kind: 'workstream' },
  b: { id: 'b', parentId: 'root', kind: 'workstream' },
  child: { id: 'child', parentId: 'a', kind: 'workstream' },
  sibling: { id: 'sibling', parentId: 'a', kind: 'workstream' },
  grandchild: { id: 'grandchild', parentId: 'child', kind: 'workstream' },
};
const parents = { a: null, b: null, child: 'a', sibling: 'a', grandchild: 'child' };

test('stored child colours migrate to ancestor hue without rebalancing top-level colours', () => {
  const doc = { cells: { cell: { id: 'cell', rootBeadId: 'root' } }, workstreamColours: { cell: { a: 4, b: 4, child: 1, sibling: 2, grandchild: 3 } } };
  const metadata = { read: () => doc, mutate: fn => fn(doc) };
  assert.equal(reconcileColours(metadata, beads), true);
  assert.deepEqual(doc.workstreamColours.cell, { a: 4, b: 4, child: 4, sibling: 4, grandchild: 4 });
  assert.equal(reconcileColours(metadata, beads), false);
  const reloaded = JSON.parse(JSON.stringify(doc));
  assert.equal(reconcileColours({ read: () => reloaded, mutate: fn => fn(reloaded) }, beads), false);
});

test('rendering derives child and grandchild hue before stored colours reconcile', () => {
  const stored = { a: 2, b: 5, child: 1, grandchild: 3 };
  assert.equal(colours.workstreamColour('a', stored, parents), 2);
  assert.equal(colours.workstreamColour('child', stored, parents), 2);
  assert.equal(colours.workstreamColour('grandchild', stored, parents), 2);
  assert.equal(colours.workstreamColour('b', stored, parents), 5);
  assert.equal(colours.workstreamColour('grandchild', {}, parents), colours.workstreamColour('a'));
});

test('nested shades are bounded, deterministic and distinguish typical siblings', () => {
  const assigned = { a: 2 };
  const classes = colours.workstreamClasses;
  assert.equal(typeof classes, 'function');
  assert.equal(classes('a', assigned, parents), 'hive-ws-c2');
  const child = classes('child', assigned, parents);
  assert.match(child, /^hive-ws-c2 hive-ws-shade[0-4]$/);
  assert.notEqual(child, classes('sibling', assigned, parents));
  assert.equal(classes('grandchild', assigned, parents), classes('grandchild', JSON.parse(JSON.stringify(assigned)), { ...parents }));
  assert.equal(classes('child', assigned, { ...parents, extra: 'a' }), child);
});

test('siblings avoid shade collisions while five shades are available', () => {
  const parents = { top: null, build: 'top', deploy: 'top' };
  assert.notEqual(colours.workstreamClasses('build', { top: 2 }, parents), colours.workstreamClasses('deploy', { top: 2 }, parents));
  assert.equal(colours.workstreamClasses('deploy', { top: 2 }, parents), colours.workstreamClasses('deploy', { top: 2 }, { deploy: 'top', build: 'top', top: null }));
});

test('new top-level workstreams use a free slot and reparented children follow their new family', () => {
  const doc = { cells: { cell: { id: 'cell', rootBeadId: 'root' } }, workstreamColours: { cell: { a: 4 } } };
  const metadata = { read: () => doc, mutate: fn => fn(doc) };
  reconcileColours(metadata, beads);
  assert.equal(doc.workstreamColours.cell.b, 0);
  assert.equal(doc.workstreamColours.cell.child, 4);
  reconcileColours(metadata, { ...beads, child: { ...beads.child, parentId: 'b' } });
  assert.equal(doc.workstreamColours.cell.a, 4);
  assert.equal(doc.workstreamColours.cell.child, 0);
  assert.equal(doc.workstreamColours.cell.grandchild, 0);
});

test('stored shades survive new earlier siblings, removal and JSON reload', () => {
  let doc = { cells: { cell: { id: 'cell', rootBeadId: 'root' } } };
  const metadata = { read: () => doc, mutate: fn => fn(doc) };
  reconcileColours(metadata, beads);
  const shades = { ...doc.workstreamShades?.cell };
  assert.equal(Object.keys(shades).length, 3);
  const more = { ...beads, aaa: { id: 'aaa', parentId: 'a', kind: 'workstream' } };
  doc = JSON.parse(JSON.stringify(doc));
  reconcileColours(metadata, more);
  for (const [id, shade] of Object.entries(shades)) assert.equal(doc.workstreamShades.cell[id], shade);
  assert.notEqual(doc.workstreamShades.cell.aaa, shades.child);
  assert.notEqual(doc.workstreamShades.cell.aaa, shades.sibling);
  const render = colours.workstreamClasses('child', doc.workstreamColours.cell, { ...parents, aaa: 'a' }, doc.workstreamShades.cell);
  const fewer = { ...more }; delete fewer.sibling;
  reconcileColours(metadata, fewer);
  assert.equal(doc.workstreamShades.cell.child, shades.child);
  assert.equal(colours.workstreamClasses('child', doc.workstreamColours.cell, { ...parents, aaa: 'a' }, doc.workstreamShades.cell), render);
});

test('missing parent keeps the same own-slot fallback as the server retains for disconnected work', () => {
  const doc = { cells: { cell: { id: 'cell', rootBeadId: 'root' } }, workstreamColours: { cell: { a: 2, child: 5 } } };
  const disconnected = { ...beads, child: { ...beads.child, parentId: 'missing' } };
  reconcileColours({ read: () => doc, mutate: fn => fn(doc) }, disconnected);
  assert.equal(doc.workstreamColours.cell.child, 5);
  assert.equal(colours.workstreamColour('child', doc.workstreamColours.cell, { child: 'missing' }), 5);
});

test('shade metadata persists on disk, reaches the graph and invalidates the retained map', async t => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { MetadataStore } = await import('../server/metadata-store.js');
  const { projectForGraph } = await import('../server/projection.js');
  const { mapInputs } = await import('../public/view-inputs.js');
  const dir = mkdtempSync(join(tmpdir(), 'hive-shades-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'metadata.json');
  const metadata = new MetadataStore({ file });
  metadata.mutate(d => { d.cells.cell = { id: 'cell', rootBeadId: 'root', enabled: true }; });
  reconcileColours(metadata, beads);
  const loaded = new MetadataStore({ file });
  assert.deepEqual(loaded.read().workstreamShades, metadata.read().workstreamShades);
  const runtime = { metadata: loaded, beads: { status: { state: 'missing' } }, paths: {} };
  const hive = projectForGraph({ runtime, snapshot: { graph: { beads, edges: [] } } });
  const cell = hive.cells.cell;
  assert.deepEqual(cell.workstreamShades, loaded.read().workstreamShades.cell);
  const ui = { selectedBeadId: () => null, placements: () => [], hideDoneForHive: () => false, detachedRegions: () => new Set(), form: () => null };
  const ctx = { hive, graph: { sessions: [] }, ui, busy: () => false };
  const before = mapInputs(ctx, cell);
  assert.notEqual(mapInputs(ctx, { ...cell, workstreamShades: { ...cell.workstreamShades, child: (cell.workstreamShades.child + 1) % 5 } }), before);
});
