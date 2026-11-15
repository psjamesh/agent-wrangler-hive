import test from 'node:test';
import assert from 'node:assert/strict';
import { pickupFixture } from './helpers/pickup.mjs';
import * as pickup from '../server/pickup.js';
import { collectWatchdog } from '../server/watchdog.js';

const run = f => pickup.createPickupDispatcher({ runtime: f.rt, host: f.host, now: f.now }).run();
const defaults = f => { f.doc().cells.cell.workerProfile = f.profile; f.live.a.priority = 0; f.live.b.priority = 1; };

test('default profile starts scoped work once using existing claim and rate guards', async () => {
  const f = pickupFixture(); defaults(f);
  await run(f); await run(f);
  assert.equal(f.spawned.length, 1);
  assert.equal(f.actions.length, 1);
  assert.equal(f.live.a.assignee, 'aw:worker-1');
  f.live.a.assignee = null; f.live.a.status = 'open'; f.bump('a');
  f.advance(60000); await run(f);
  assert.equal(f.spawned.length, 2);
  assert.equal(f.spawned[1].ext.hive.beadId, 'b');
});

for (const kind of ['investigation', 'decision', 'external', 'idea', 'goal', 'workstream']) {
  test(`default pickup excludes ${kind}`, async () => {
    const f = pickupFixture(); defaults(f);
    f.live.a.metadata.hive_kind = kind;
    f.live.b.status = 'closed';
    await run(f); assert.equal(f.spawned.length, 0);
  });
}

for (const scenario of ['brief', 'prerequisite', 'human request', 'wait', 'resume']) {
  test(`default pickup excludes work with ${scenario}`, async () => {
    const f = pickupFixture(); defaults(f); f.live.b.status = 'closed';
    if (scenario === 'brief') f.live.a.acceptance_criteria = '';
    if (scenario === 'prerequisite') f.live.a.dependencies.push({ issue_id: 'a', depends_on_id: 'missing', type: 'blocks' });
    if (scenario === 'human request') f.doc().requests = { r: { state: 'open', cellId: 'cell', beadId: 'a' } };
    if (scenario === 'wait') f.live.a.metadata.hive_waiting_for = 'Awaiting human approval';
    if (scenario === 'resume') f.live.a.metadata.hive_resume = { reviewAt: '2099-01-01' };
    await run(f); assert.equal(f.spawned.length, 0);
  });
}

test('hold and unhold persist and explicit marks retain their profiles', async () => {
  const f = pickupFixture(); defaults(f); f.live.b.status = 'closed';
  await pickup.setPickup(f.rt, f.host, f.actor(), { bead_id: 'a', hold: true });
  await run(f); assert.equal(f.spawned.length, 0);
  await pickup.setPickup(f.rt, f.host, f.actor(), { bead_id: 'a', hold: false });
  await run(f); assert.equal(f.spawned.length, 1);
  const g = pickupFixture(); defaults(g);
  await pickup.setPickup(g.rt, g.host, g.actor(), { bead_id: 'a', ready: true, profile: { ...g.profile, intent: 'Per-bead override' } });
  await run(g); assert.equal(g.spawned[0].ext.hive.beadId, 'a');
  assert.equal(g.live.a.metadata.hive_pickup.profile.intent, 'Per-bead override');
});

test('free capacity watchdog names missing profile and missing cwd, excludes held work', async () => {
  const f = pickupFixture(); await f.rt.snapshots.refresh();
  const flags = () => collectWatchdog(f.rt, f.host, f.doc().cells.cell, f.now()).filter(x => x.kind === 'pickup_unavailable');
  assert.match(flags()[0]?.reason || '', /profile/i);
  f.doc().cells.cell.workerProfile = { ...f.profile, cwd: '' };
  assert.match(flags()[0]?.reason || '', /cwd|folder/i);
  f.live.a.metadata.hive_pickup = { held: true }; f.live.b.status = 'closed';
  await f.rt.snapshots.refresh(); assert.equal(flags().length, 0);
});

test('failed implicit startup never retries on later sweeps', async () => {
  const f = pickupFixture(); defaults(f); f.live.b.status = 'closed';
  f.host.sessions.spawn = async opts => { f.spawned.push(opts); throw new Error('uncertain start'); };
  await run(f); f.advance(60000); await run(f);
  assert.equal(f.spawned.length, 1);
});

test('default profile saves only installed resolved models and rejects invalid folders', async () => {
  const f = pickupFixture();
  await pickup.setWorkerProfile(f.rt, f.host, { cellId: 'cell', profile: f.profile });
  assert.equal(f.doc().cells.cell.workerProfile.resolvedModel, 'claude-sonnet-fixed');
  await assert.rejects(pickup.setWorkerProfile(f.rt, f.host, { cellId: 'cell', profile: { ...f.profile, model: 'missing' } }), /unavailable/i);
  await assert.rejects(pickup.setWorkerProfile(f.rt, f.host, { cellId: 'cell', profile: { ...f.profile, cwd: 'relative' } }), /absolute/i);
  await pickup.setWorkerProfile(f.rt, f.host, { cellId: 'cell', profile: null });
  assert.equal(f.doc().cells.cell.workerProfile, null);
});

test('holds preserve explicit authorization receipts and do not create watchdog noise', async () => {
  const f = pickupFixture(); f.live.b.status = 'closed';
  await pickup.setPickup(f.rt, f.host, f.actor(), { bead_id: 'a', ready: true, profile: f.profile });
  const token = f.live.a.metadata.hive_pickup.armToken;
  await pickup.setPickup(f.rt, f.host, f.actor(), { bead_id: 'a', hold: true });
  await run(f); assert.equal(f.spawned.length, 0);
  assert.deepEqual(pickup.pickupState(f.rt, f.host, f.doc().cells.cell, f.graph().beads.a).reconciliation_reasons, []);
  await pickup.setPickup(f.rt, f.host, f.actor(), { bead_id: 'a', hold: false });
  assert.equal(f.live.a.metadata.hive_pickup.armToken, token);
  await run(f); assert.equal(f.spawned.length, 1);
});

test('manual claim then release does not authorize a default replacement worker', async () => {
  const { claimBead } = await import('../server/ops.js');
  const f = pickupFixture(); defaults(f); f.live.b.status = 'closed';
  await claimBead(f.rt, f.actor(), { bead_id: 'a' });
  f.live.a.assignee = null; f.live.a.status = 'open'; f.bump('a');
  await run(f); assert.equal(f.spawned.length, 0);
});

test('default work begins after its last prerequisite closes and capacity becomes free', async () => {
  const f = pickupFixture(1); defaults(f);
  f.live.a.dependencies.push({ issue_id: 'a', depends_on_id: 'b', type: 'blocks' });
  f.live.b.status = 'in_progress'; f.live.b.assignee = 'aw:queen';
  await run(f); assert.equal(f.spawned.length, 0);
  assert.equal(collectWatchdog(f.rt, f.host, f.doc().cells.cell, f.now()).filter(x => x.kind === 'pickup_unavailable').length, 0);
  f.live.b.status = 'closed'; f.live.b.assignee = null;
  await run(f); assert.equal(f.spawned.length, 1);
  assert.equal(f.spawned[0].ext.hive.beadId, 'a');
});

test('default profile catalog problems flag free work and recover without consuming a launch', async () => {
  const f = pickupFixture(); defaults(f); f.live.b.status = 'closed';
  const list = f.host.agents.list;
  f.host.agents.list = async () => { throw new Error('unavailable'); };
  await run(f); assert.equal(f.spawned.length, 0);
  assert.match(collectWatchdog(f.rt, f.host, f.doc().cells.cell, f.now()).find(x => x.kind === 'pickup_unavailable')?.reason || '', /catalog/i);
  assert.equal(Object.keys(f.doc().pickupAttempts).length, 0);
  f.host.agents.list = list;
  await run(f); assert.equal(f.spawned.length, 1);
});
