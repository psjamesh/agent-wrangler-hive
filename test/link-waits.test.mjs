import test from 'node:test';
import assert from 'node:assert/strict';
import { pickupFixture } from './helpers/pickup.mjs';
import { updateBead, createBeads, releaseBead, readyBeads } from '../server/ops.js';
import { createWatchdog, collectWatchdog } from '../server/watchdog.js';
import { createPickupDispatcher, setPickup } from '../server/pickup.js';

const link = (f, pre = 'b') => f.live.a.dependencies.push({ issue_id: 'a', depends_on_id: pre, type: 'blocks' });
async function fixture() {
  const f = pickupFixture();
  f.rt.watchdog = createWatchdog({ runtime: f.rt, host: f.host, now: f.now });
  return f;
}
const flags = f => collectWatchdog(f.rt, f.host, f.doc().cells.cell, f.now());

for (const status of ['blocked', 'deferred']) {
  test(`${status} requires a structured condition, including through create and release`, async () => {
    const f = await fixture();
    await assert.rejects(updateBead(f.rt, f.actor(), { bead_id: 'a', status, waiting_for: 'After the release ships' }), /structured.*hive_link_beads.*resume_after_bead.*resume_review_at/i);
    await assert.rejects(createBeads(f.rt, f.actor(), { beads: [{ title: 'Later', status }] }), /structured/i);
    f.live.a.assignee = 'aw:queen';
    await assert.rejects(releaseBead(f.rt, f.actor(), { bead_id: 'a', status }), /structured/i);
  });
}

test('last closed prerequisite clears linked blocked state and notifies the queen once across restart', async () => {
  const f = await fixture();
  link(f); link(f, 'root');
  f.live.a.status = 'blocked'; f.live.a.metadata.hive_waiting_for = 'Wait for both prerequisites';
  await f.rt.snapshots.refresh(); await f.rt.watchdog.run();
  assert.equal(f.live.a.status, 'blocked'); assert.equal(f.delivered.length, 0);
  f.live.b.status = 'closed'; await f.rt.snapshots.refresh(); await f.rt.watchdog.run();
  assert.equal(f.live.a.status, 'blocked'); assert.equal(f.delivered.length, 0);
  f.live.root.status = 'closed'; await f.rt.snapshots.refresh(); await f.rt.watchdog.run();
  assert.equal(f.live.a.status, 'open');
  assert.equal(f.graph().beads.a.waitingFor, '');
  assert.ok(readyBeads(f.rt, f.actor(), {}).ready.some(b => b.bead_id === 'a'));
  assert.equal(f.delivered.length, 1); assert.equal(f.delivered[0].id, 'queen');
  assert.match(f.delivered[0].message, /prerequisites.*resolved|prerequisites.*closed/i);
  await f.rt.watchdog.run();
  const restarted = createWatchdog({ runtime: f.rt, host: f.host, now: f.now });
  await restarted.run(); assert.equal(f.delivered.length, 1);
});

test('armed pickup launches after linked wait resolves without rearming', async () => {
  const f = await fixture(); link(f);
  f.live.a.status = 'blocked'; f.live.a.metadata.hive_waiting_for = 'Needs b';
  await f.rt.snapshots.refresh();
  await setPickup(f.rt, f.host, f.actor(), { bead_id: 'a', ready: true, profile: f.profile });
  const dispatcher = createPickupDispatcher({ runtime: f.rt, host: f.host, now: f.now });
  await dispatcher.run(); assert.equal(f.spawned.length, 0);
  f.live.b.status = 'closed';
  await dispatcher.run();
  assert.equal(f.spawned.length, 1); assert.equal(f.live.a.assignee, 'aw:worker-1');
  assert.equal(f.delivered.filter(m => /prerequisites.*resolved|prerequisites.*closed/i.test(m.message)).length, 1);
});

test('legacy prose waits remain editable and appear as immediate upgrade attention', async () => {
  const f = await fixture();
  f.live.a.status = 'deferred'; f.live.a.metadata.hive_waiting_for = 'After 0.1.41 ships';
  f.live.b.status = 'blocked';
  await f.rt.snapshots.refresh();
  await updateBead(f.rt, f.actor(), { bead_id: 'a', summary: 'Needs a release bead' });
  await f.rt.snapshots.refresh(); await f.rt.watchdog.run();
  assert.equal(f.live.a.status, 'deferred'); assert.equal(f.live.b.status, 'blocked');
  assert.deepEqual(flags(f).filter(x => x.kind === 'unstructured_wait').map(x => x.bead_id).sort(), ['a', 'b']);
  assert.match(f.delivered[0].message, /structured/i);
});

test('explicit resume condition survives closed links and may be used for blocked status', async () => {
  const f = await fixture(); link(f); f.live.b.status = 'closed';
  f.live.a.status = 'deferred'; f.live.a.metadata.hive_resume = { reviewAt: '2099-01-01T00:00:00.000Z' };
  await f.rt.snapshots.refresh(); await f.rt.watchdog.run();
  assert.equal(f.live.a.status, 'deferred'); assert.equal(f.delivered.length, 0);
  await updateBead(f.rt, f.actor(), { bead_id: 'a', status: 'blocked', resume_after_bead: 'b' });
  await assert.rejects(updateBead(f.rt, f.actor(), { bead_id: 'a', resume_after_bead: '', resume_review_at: '' }), /structured/i);
});

test('missing prerequisites never auto-resolve and closed links cannot justify a new wait', async () => {
  const f = await fixture(); link(f, 'missing'); f.live.a.status = 'blocked';
  await f.rt.snapshots.refresh(); await f.rt.watchdog.run();
  assert.equal(f.live.a.status, 'blocked');
  f.live.a.dependencies.pop(); link(f); f.live.b.status = 'closed';
  await f.rt.snapshots.refresh();
  await assert.rejects(updateBead(f.rt, f.actor(), { bead_id: 'a', status: 'blocked' }), /structured/i);
});

test('claimed waits reopen without dropping ownership or starting work beyond capacity', async () => {
  const f = await fixture(); link(f); f.live.b.status = 'closed';
  f.live.a.status = 'blocked'; f.live.a.assignee = 'aw:queen';
  await f.rt.snapshots.refresh(); await f.rt.watchdog.run();
  assert.equal(f.live.a.status, 'open'); assert.equal(f.live.a.assignee, 'aw:queen');
  assert.equal(f.delivered.length, 1);
});

for (const kind of ['work', 'external']) {
  test(`open ${kind} prerequisite justifies blocked and deferred writes`, async () => {
    const f = await fixture(); link(f); f.live.b.metadata.hive_kind = kind;
    await f.rt.snapshots.refresh();
    for (const status of ['blocked', 'deferred']) {
      await updateBead(f.rt, f.actor(), { bead_id: 'a', status });
      await f.rt.snapshots.refresh(); assert.equal(f.live.a.status, status);
    }
  });
}

test('a newly open prerequisite in the queued export prevents stale auto-resolution', async () => {
  const f = await fixture(); link(f); f.live.b.status = 'closed'; f.live.a.status = 'blocked';
  await f.rt.snapshots.refresh();
  const update = f.rt.beads.update;
  f.rt.beads.update = async (...args) => { f.live.b.status = 'open'; return update(...args); };
  await f.rt.watchdog.run();
  assert.equal(f.live.a.status, 'blocked'); assert.equal(f.delivered.length, 0);
});

test('a retired runtime cannot clear a linked wait', async () => {
  const f = await fixture(); link(f); f.live.b.status = 'closed'; f.live.a.status = 'blocked';
  await f.rt.snapshots.refresh(); f.rt.metadata.lifetime.stop();
  await f.rt.watchdog.run(); assert.equal(f.live.a.status, 'blocked'); assert.equal(f.delivered.length, 0);
});

test('open link-derived waits suppress idle and dormant worker flags without a blocked status', async () => {
  const f = await fixture(); link(f);
  f.live.a.status = 'in_progress'; f.live.a.assignee = 'aw:queen';
  f.board.get('queen').lastActivity = f.now();
  await f.rt.snapshots.refresh(); f.advance(60 * 60000);
  assert.ok(!flags(f).some(x => ['stalled_worker', 'dormant_claim'].includes(x.kind)));
  f.board.get('queen').dormant = true;
  assert.ok(!flags(f).some(x => ['stalled_worker', 'dormant_claim'].includes(x.kind)));
});

test('wait resolution preserves a hold from an unrelated native edit', async () => {
  const f = await fixture(); link(f); f.live.a.status = 'blocked';
  await f.rt.snapshots.refresh();
  await setPickup(f.rt, f.host, f.actor(), { bead_id: 'a', ready: true, profile: f.profile });
  f.bump('a'); f.live.b.status = 'closed';
  await createPickupDispatcher({ runtime: f.rt, host: f.host, now: f.now }).run();
  assert.equal(f.live.a.status, 'open'); assert.equal(f.spawned.length, 0);
});

test('link-only deferred status and open wait annotations also resolve', async () => {
  for (const status of ['deferred', 'open']) {
    const f = await fixture(); link(f); f.live.b.status = 'closed';
    f.live.a.status = status; f.live.a.metadata.hive_waiting_for = 'Needs b';
    await f.rt.snapshots.refresh(); await f.rt.watchdog.run();
    assert.equal(f.live.a.status, 'open'); assert.equal(f.graph().beads.a.waitingFor, '');
    assert.equal(f.delivered.length, 1);
  }
});
