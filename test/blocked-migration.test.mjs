import test from 'node:test';
import assert from 'node:assert/strict';
import { pickupFixture } from './helpers/pickup.mjs';
import { createBeads, updateBead, releaseBead, settleOne } from '../server/ops.js';
import { createBeadsTool, updateBeadTool, releaseBeadTool } from '../server/tools.js';
import { createWatchdog, collectWatchdog } from '../server/watchdog.js';
import { resolveLinkWaits } from '../server/link-waits.js';
import { cellCounts, workCounts, childrenMap, waitingOn } from '../public/model.js';
import { beadTile } from '../public/cell-view.js';

for (const prerequisite of [false, true]) test(`blocked writes are refused with prerequisite=${prerequisite}`, async () => {
  const f = pickupFixture();
  if (prerequisite) f.live.a.dependencies.push({ issue_id: 'a', depends_on_id: 'b', type: 'blocks' });
  f.live.a.assignee = 'aw:queen';
  await f.rt.snapshots.refresh();
  const message = /blocked.*no longer stored.*hive_link_beads.*blocks.*external/i;
  for (const [fn, input] of [[updateBead, { bead_id: 'a', status: 'blocked' }], [createBeads, { beads: [{ title: 'Nope', status: 'blocked' }] }], [releaseBead, { bead_id: 'a', status: 'blocked' }]]) await assert.rejects(fn(f.rt, f.actor(), input), message);
  for (const [tool, input] of [[updateBeadTool, { bead_id: 'a', status: 'blocked' }], [createBeadsTool, { beads: [{ title: 'Nope', status: 'blocked' }] }], [releaseBeadTool, { bead_id: 'a', status: 'blocked' }]]) {
    const parsed = tool.inputSchema.safeParse(input);
    assert.equal(parsed.success, false);
    assert.match(parsed.error.message, message);
  }
  assert.equal(f.live.a.status, 'open');
  assert.equal(f.live.a.assignee, 'aw:queen');
});

test('upgrade preserves links, annotations, resume and ownership and reports migrations once across restart and queen handoff', async () => {
  const f = pickupFixture();
  f.live.a.status = 'blocked'; f.live.b.status = 'blocked';
  f.live.a.assignee = 'aw:queen';
  f.live.a.metadata.hive_waiting_for = 'Human: approve design';
  f.live.a.metadata.hive_resume = { reviewAt: '2099-01-01' };
  f.live.a.dependencies.push({ issue_id: 'a', depends_on_id: 'b', type: 'blocks' });
  const before = structuredClone(f.live.a);
  const wd = () => createWatchdog({ runtime: f.rt, host: f.host, now: f.now });
  await f.rt.snapshots.refresh(); await wd().run();
  assert.equal(f.live.a.status, 'open'); assert.equal(f.live.b.status, 'open');
  assert.equal(f.live.a.assignee, before.assignee);
  assert.deepEqual(f.live.a.metadata, before.metadata);
  assert.deepEqual(f.live.a.dependencies, before.dependencies);
  assert.equal(f.delivered.length, 1);
  assert.match(f.delivered[0].message, /Migrated blocked beads to open: a/); assert.match(f.delivered[0].message, /b \(b\)/);
  const after = structuredClone(f.live);
  await wd().run(); f.doc().cells.cell.queenGeneration++; await wd().run();
  assert.deepEqual(f.live, after); assert.equal(f.delivered.length, 1);
});

test('migration notices survive no recipient and closed migrated work', async () => {
  const f = pickupFixture(); f.live.a.status = 'blocked'; f.board.delete('queen');
  await f.rt.snapshots.refresh();
  const wd = createWatchdog({ runtime: f.rt, host: f.host, now: f.now });
  await wd.run(); assert.equal(f.delivered.length, 0);
  f.live.a.status = 'closed'; await f.rt.snapshots.refresh();
  f.board.set('queen', { sessionId: 'queen', taskId: 'task', status: 'idle' });
  await wd.run(); assert.equal(f.delivered.length, 1); assert.match(f.delivered[0].message, /Migrated blocked beads to open: a/);
});

test('migration respects incomplete reads, disabled cells, snapshots, native races and unsettled writes', async () => {
  for (const scenario of ['incomplete', 'disabled', 'snapshot', 'race', 'unsettled']) {
    const f = pickupFixture(); f.live.a.status = 'blocked'; await f.rt.snapshots.refresh();
    if (scenario === 'incomplete') f.rt.snapshots.hierarchyCurrent = false;
    if (scenario === 'disabled') f.doc().cells.cell.enabled = false;
    if (scenario === 'snapshot') f.doc().cells.cell.snapshot = {};
    if (scenario === 'unsettled') f.doc().operations.op = { state: 'uncertain', beadIds: ['a'] };
    if (scenario === 'race') { const update = f.rt.beads.update; f.rt.beads.update = (...args) => { f.bump('a'); return update(...args); }; }
    await resolveLinkWaits(f.rt, f.host, f.now()); assert.equal(f.live.a.status, 'blocked', scenario);
  }
});

test('uncertain migration bookkeeping recovers its notice without repeating the write', async () => {
  const f = pickupFixture(); f.live.a.status = 'open';
  f.doc().operations.op = { id: 'op', kind: 'migrate-blocked', state: 'uncertain', cellId: 'cell', intent: { beadId: 'a' }, createdAt: f.now() };
  assert.equal((await settleOne(f.rt, 'op')).settled, true);
  await f.rt.snapshots.refresh();
  await createWatchdog({ runtime: f.rt, host: f.host, now: f.now }).run();
  assert.equal(f.delivered.length, 1); assert.match(f.delivered[0].message, /Migrated blocked beads to open: a/);
});

test('external and design prerequisites derive waiting display, counts and watchdog flags from open statuses', async () => {
  for (const kind of ['external', 'decision', 'investigation']) {
    const f = pickupFixture(); f.live.b.metadata.hive_kind = kind;
    f.live.a.status = 'in_progress';
    f.live.a.updated_at = new Date(f.now()).toISOString();
    f.live.a.dependencies.push({ issue_id: 'a', depends_on_id: 'b', type: 'blocks' });
    await f.rt.snapshots.refresh(); f.advance(48 * 3600000);
    const hive = { ...f.rt.snapshots.graph, cells: { cell: {} } };
    assert.deepEqual(waitingOn(hive, 'a'), ['b']);
    const tile = beadTile({ hive, graph: { sessions: [] } }, hive.beads.a, { cellId: 'cell', layout: { groupHeads: [], parentHead: {}, halo: {}, rootId: 'root' } }, childrenMap(hive.beads));
    assert.equal(tile.mark.kind, 'waiting');
    assert.match(tile.title, kind === 'external' ? /Waiting on a prerequisite/ : /Waiting on design/);
    for (const c of [cellCounts(hive, { rootBeadId: 'root' }), workCounts(hive, childrenMap(hive.beads), 'root')]) { assert.equal(c.waiting, 1); assert.equal(c.blocked, undefined); }
    const flags = collectWatchdog(f.rt, f.host, f.doc().cells.cell, f.now());
    assert.ok(flags.some(x => x.kind === 'stale_wait' && x.bead_id === 'a'));
    assert.ok(!flags.some(x => ['untracked_work', 'human_wait_unasked'].includes(x.kind) && x.bead_id === 'a'));
    f.live.b.status = 'closed'; await f.rt.snapshots.refresh();
    const after = collectWatchdog(f.rt, f.host, f.doc().cells.cell, f.now());
    assert.ok(!after.some(x => x.kind === 'stale_wait' && x.bead_id === 'a'));
    assert.ok(after.some(x => x.kind === 'untracked_work' && x.bead_id === 'a'));
  }
});

test('migration digest names every bead beyond the ordinary ten-item limit', async () => {
  const f = pickupFixture();
  for (let i = 0; i < 15; i++) f.live[`old${i}`] = { ...structuredClone(f.live.a), id: `old${i}`, title: `Old ${i}`, status: 'blocked', dependencies: [{ issue_id: `old${i}`, depends_on_id: 'root', type: 'parent-child' }] };
  await f.rt.snapshots.refresh();
  await createWatchdog({ runtime: f.rt, host: f.host, now: f.now }).run();
  assert.equal(f.delivered.length, 1);
  for (let i = 0; i < 15; i++) assert.ok(f.delivered[0].message.includes(`old${i} (Old ${i})`));
});
