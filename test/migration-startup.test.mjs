import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HiveRuntime } from '../server/runtime.js';
import { reopenWorkstream } from '../server/workstreams.js';
import * as ops from '../server/ops.js';
import { legacyLayoutCell } from '../public/legacy-cell-layout.js';
import { activeKids } from '../public/archive-layout.js';
import { layoutCell } from '../public/cell-layout.js';
import { buildGraph } from '../server/bead-model.js';

const p = (q, r = 0) => ({ q, r });
const raw = (id, parentId, kind = 'work', status = 'open') => ({
  id, title: id, status, closed_at: status === 'closed' ? 'old' : null, metadata: { hive_kind: kind },
  dependencies: parentId ? [{ type: 'parent-child', issue_id: id, depends_on_id: parentId }] : [],
});
function fixture(t, issues) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-startup-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const workspace = path.join(dir, 'hive/beads/.beads');
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'metadata.json'), JSON.stringify({ backend: 'dolt', dolt_mode: 'embedded' }));
  const exportFile = path.join(workspace, 'fixture-export.jsonl');
  const commandFile = path.join(dir, 'commands.jsonl');
  const executable = path.join(dir, 'fixture-bd');
  fs.writeFileSync(executable, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2).filter((a) => a !== '--readonly');
fs.appendFileSync(${JSON.stringify(commandFile)}, JSON.stringify(args) + '\\n');
if (args[0] === '--version') console.log('bd version 1.3.4');
else if (args[0] === 'schema') console.log('{"schema_version":1}');
else if (args[0] === 'info') console.log('{}');
else if (args[0] === 'export') process.stdout.write(fs.readFileSync(${JSON.stringify(exportFile)}));
else { console.error('Unexpected fixture command', args); process.exitCode = 1; }
`, { mode: 0o700 });
  const options = { env: { ...process.env, AW_DATA_DIR: dir }, settings: { get: () => executable } };
  const rt = new HiveRuntime(options);
  const writeExport = (rows) => fs.writeFileSync(exportFile, rows.map((r) => typeof r === 'string' ? r : JSON.stringify(r)).join('\n') + '\n');
  writeExport(issues);
  return { rt, options, writeExport, commands: () => fs.readFileSync(commandFile, 'utf8').trim().split('\n').map(JSON.parse) };
}

for (const malformed of ['{"id":', { _type: 'issue', title: 'missing id' }]) {
  test(`startup migration waits for a complete export (${typeof malformed === 'string' ? 'invalid JSON' : 'invalid issue'})`, async (t) => {
    const issues = [raw('root', null, 'goal'), raw('parent', 'root', 'workstream'), raw('child', 'parent', 'workstream'), raw('b', 'child')];
    const f = fixture(t, issues);
    const saved = { parent: p(0), child: p(40) };
    f.rt.metadata.mutate((d) => {
      d.cells.cell = { id: 'cell', rootBeadId: 'root', enabled: true };
      d.beadLayout.cell = saved;
    });
    f.writeExport([...issues.slice(0, 3), malformed]);
    await f.rt.recheck();
    assert.equal(f.rt.snapshots.hierarchyCurrent, false);
    assert.match(f.rt.snapshots.current.error || '', /export/i);
    assert.equal(f.rt.metadata.read().regionLayout.cell, undefined);
    assert.deepEqual(f.rt.metadata.read().beadLayout.cell, saved);
    f.writeExport(issues);
    await f.rt.snapshots.refresh();
    assert.equal(f.rt.snapshots.hierarchyCurrent, true);
    const graph = buildGraph(issues);
    const expected = legacyLayoutCell({ kids: activeKids(graph.beads), rootId: 'root', saved });
    assert.deepEqual(f.rt.metadata.read().beadLayout.cell.b, expected.positions.b);
    assert.equal(f.rt.metadata.read().regionLayout.cell, 1);
  });
}

test('actual attach migrates persisted metadata and recovers a real interrupted reopen without replay', { timeout: 10000 }, async (t) => {
  const issues = [raw('root', null, 'goal', 'closed'), raw('parent', 'root', 'workstream', 'closed'), raw('a', 'parent', 'work', 'closed'), raw('nested', 'parent', 'workstream', 'closed'), raw('b', 'nested', 'work', 'closed'), raw('outside', 'root')];
  const f = fixture(t, issues);
  const geometry = { parent: p(0), a: p(1), nested: p(40), b: p(41) };
  f.rt.metadata.mutate((d) => {
    d.cells.cell = { id: 'cell', rootBeadId: 'root', enabled: true };
    d.beadLayout.cell = { outside: p(0) };
    d.archived.parent = { ids: Object.keys(geometry), positions: geometry, closedAt: 'old' };
  });
  const before = {
    metadata: f.rt.metadata, log() {}, changed() {},
    snapshots: { invalidate() {}, hierarchyCurrent: true, graph: buildGraph(issues), refresh: async () => { before.snapshots.graph = buildGraph(issues); } },
    beads: {
      status: { state: 'ready' },
      show: async (id) => issues.find((b) => b.id === id),
      reopen: async (ids, reason, actor, check) => {
        check({ issues: structuredClone(issues), errors: [] });
        for (const id of ids) Object.assign(issues.find((b) => b.id === id), { status: 'open', closed_at: null });
      },
    },
  };
  const rename = fs.renameSync;
  let diskFailures = 0;
  fs.renameSync = (from, to) => {
    if (to === f.rt.metadata.file && !JSON.parse(fs.readFileSync(from, 'utf8')).archived.parent) {
      diskFailures++;
      throw new Error('injected atomic rename failure');
    }
    return rename(from, to);
  };
  let result;
  try {
    result = await reopenWorkstream(before, { cellId: 'cell', headId: 'nested', reason: 'more work', confirmAncestors: ['parent'] });
  } finally { fs.renameSync = rename; }
  assert.ok(diskFailures > 0);
  assert.equal(result.placed, 'pending');
  const intent = f.rt.metadata.read().restoring['cell:nested'];
  assert.deepEqual(intent.geo, geometry);
  assert.ok(intent.opened);
  assert.equal(f.rt.metadata.read().operations[intent.opId].state, 'applied');
  assert.deepEqual(JSON.parse(fs.readFileSync(f.rt.metadata.file, 'utf8')).restoring['cell:nested'].geo, geometry);
  f.writeExport(issues);
  const restarted = new HiveRuntime(f.options);
  let restored;
  const settled = new Promise((resolve) => { restored = resolve; });
  const host = { stores: { hive: restarted }, rebuild: () => {
    const doc = restarted.metadata.read();
    if (doc.regionLayout.cell === 1 && !doc.restoring['cell:nested']) restored();
  } };
  restarted.attach(host);
  t.after(() => restarted.detach());
  await settled;
  assert.equal(restarted.snapshots.hierarchyCurrent, true);
  const doc = restarted.metadata.read();
  assert.equal(doc.archived.parent, undefined);
  assert.equal(doc.operations[intent.opId].state, 'applied');
  assert.deepEqual(doc.beadLayout.cell.outside, p(0));
  const layout = layoutCell({ kids: activeKids(restarted.snapshots.graph.beads), rootId: 'root', saved: doc.beadLayout.cell });
  const anchor = layout.positions.parent;
  for (const [id, at] of Object.entries(geometry)) assert.deepEqual(layout.positions[id], p(anchor.q + at.q, anchor.r + at.r));
  assert.equal(f.commands().some((args) => args[0] === 'reopen'), false);
});


for (const malformed of ['{"id":', { _type: 'issue', title: 'missing id' }]) {
  test(`migrated display keeps valid records through malformed export and restart (${typeof malformed})`, async (t) => {
    const issues = [raw('root', null, 'goal'), raw('parent', 'root', 'workstream')];
    const f = fixture(t, issues);
    f.rt.metadata.mutate((d) => {
      d.cells.cell = { id: 'cell', rootBeadId: 'root', enabled: true };
      d.beadLayout.cell = { parent: p(0) };
      d.regionLayout.cell = 1;
    });
    await f.rt.recheck();
    f.writeExport([...issues, raw('fresh', 'parent'), malformed]);
    for (const rt of [f.rt, new HiveRuntime(f.options)]) {
      await rt.recheck();
      const projection = rt.projection();
      assert.deepEqual(Object.keys(projection.beads).sort(), ['fresh', 'parent', 'root']);
      assert.match(projection.backend.snapshotError, /export/i);
      assert.equal(projection.backend.snapshotComplete, false);
      assert.equal(projection.backend.snapshotBeadIds, null);
      assert.equal(rt.snapshots.hierarchyCurrent, false);
      assert.equal(rt.metadata.read().regionLayout.cell, 1);
    }
    f.writeExport([...issues, raw('fresh', 'parent')]);
    await f.rt.snapshots.refresh();
    assert.equal(f.rt.projection().backend.snapshotError, null);
    assert.equal(f.rt.projection().backend.snapshotComplete, true);
    assert.deepEqual([...f.rt.projection().backend.snapshotBeadIds].sort(), ['fresh','parent','root']);
    assert.equal(f.rt.snapshots.hierarchyCurrent, true);
  });
}


test('incomplete display cannot admit any hierarchy-dependent agent mutation', async (t) => {
  const issues = [raw('root', null, 'goal'), raw('parent', 'root', 'workstream'), raw('unfinished', 'parent')];
  const f = fixture(t, issues);
  const sessionId = '11111111-1111-4111-8111-111111111111';
  f.rt.metadata.mutate((d) => {
    d.cells.cell = { id: 'cell', rootBeadId: 'root', enabled: true, queenSessionId: sessionId };
    d.beadLayout.cell = { parent: p(0), unfinished: p(1) };
    d.regionLayout.cell = 1;
  });
  await f.rt.recheck();
  f.writeExport([...issues.slice(0, 2), '{"id":']);
  await f.rt.snapshots.refresh();
  assert.equal(f.rt.snapshots.hierarchyCurrent, false);
  assert.deepEqual(Object.keys(f.rt.snapshots.graph.beads).sort(), ['parent', 'root']);
  const cell = f.rt.metadata.cell('cell');
  const actor = { sessionId, cell, role: 'queen', cells: [{ cell, role: 'queen' }] };
  const writes = [];
  for (const name of ['show', 'update', 'close', 'claim', 'release', 'createMany', 'linkMany', 'deleteMany', 'deletionContext', 'finishFenced']) {
    f.rt.beads[name] = async () => { writes.push(name); return { id:'parent',status:'open' }; };
  }
  const mutations = [
    ['finish', () => ops.finishBead(f.rt, actor, { bead_id:'parent',outcome:'done',summary:'done' })],
    ['claim', () => ops.claimBead(f.rt, actor, { bead_id:'parent' })],
    ['release', () => ops.releaseBead(f.rt, actor, { bead_id:'parent',reason:'handoff' })],
    ['update status', () => ops.updateBead(f.rt, actor, { bead_id:'parent',status:'deferred' })],
    ['update parent', () => ops.updateBead(f.rt, actor, { bead_id:'parent',parent_id:'root' })],
    ['create under heading', () => ops.createBeads(f.rt, actor, { beads:[{ title:'new',parent:'parent' }] })],
    ['create under default root', () => ops.createBeads(f.rt, actor, { beads:[{ title:'new' }] })],
    ['link', () => ops.linkBeads(f.rt, actor, { links:[{ dependent:'parent',prerequisite:'root' }] })],
    ['delete preview', () => ops.deleteBeads(f.rt, actor, { bead_ids:['parent'],reason:'remove' })],
    ['delete execution', () => ops.deleteBeads(f.rt, actor, { bead_ids:['parent'],reason:'remove',execute:true,confirm_token:'token' })],
    ['bind admission', () => ops.bindSession(f.rt, {}, actor, { bead_id:'parent' })],
    ['ready admission', () => ops.readyBeads(f.rt, actor, {})],
    ['operation reconciliation', () => ops.reconcileForAgent(f.rt, actor, { op_id:'pending',verdict:'applied',note:'checked' })],
  ];
  const before = structuredClone(f.rt.metadata.read());
  for (const [label, mutate] of mutations) {
    await assert.rejects(async () => mutate(), /incomplete|complete.*refresh/i, label);
    assert.deepEqual(writes, [], `${label} called the native adapter`);
    assert.deepEqual(f.rt.metadata.read(), before, `${label} changed metadata`);
  }
});
