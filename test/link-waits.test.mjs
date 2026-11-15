import test from 'node:test';
import assert from 'node:assert/strict';
import { pickupFixture } from './helpers/pickup.mjs';
import { updateBead, createBeads, releaseBead, readyBeads } from '../server/ops.js';
import { createWatchdog, collectWatchdog } from '../server/watchdog.js';
import { createPickupDispatcher, setPickup } from '../server/pickup.js';

const link = (f, pre = 'b') => f.live.a.dependencies.push({ issue_id: 'a', depends_on_id: pre, type: 'blocks' });
async function fixture() {
  const f = pickupFixture();
  f.live.a.metadata.hive_pickup = { held: true };
  f.live.b.metadata.hive_pickup = { held: true };
  f.rt.watchdog = createWatchdog({ runtime: f.rt, host: f.host, now: f.now });
  return f;
}
const flags = f => collectWatchdog(f.rt, f.host, f.doc().cells.cell, f.now());

for (const status of ['deferred']) {
  test(`${status} requires a structured condition, including through create and release`, async () => {
    const f = await fixture();
    await assert.rejects(updateBead(f.rt, f.actor(), { bead_id: 'a', status, waiting_for: 'After the release ships' }), /structured.*hive_link_beads.*resume_after_bead.*resume_review_at/i);
    await assert.rejects(createBeads(f.rt, f.actor(), { beads: [{ title: 'Later', status }] }), /structured/i);
    f.live.a.assignee = 'aw:queen';
    await assert.rejects(releaseBead(f.rt, f.actor(), { bead_id: 'a', status }), /structured/i);
  });
}

test('last closed prerequisite clears linked deferred state and notifies the queen once across restart', async () => {
  const f = await fixture();
  link(f); link(f, 'root');
  f.live.a.status = 'deferred'; f.live.a.metadata.hive_waiting_for = 'Wait for both prerequisites';
  await f.rt.snapshots.refresh(); await f.rt.watchdog.run();
  assert.equal(f.live.a.status, 'deferred'); assert.equal(f.delivered.length, 0);
  f.live.b.status = 'closed'; await f.rt.snapshots.refresh(); await f.rt.watchdog.run();
  assert.equal(f.live.a.status, 'deferred'); assert.equal(f.delivered.length, 0);
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
  f.live.a.status = 'deferred'; f.live.a.metadata.hive_waiting_for = 'Needs b';
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
  f.live.b.status = 'deferred';
  await f.rt.snapshots.refresh();
  await updateBead(f.rt, f.actor(), { bead_id: 'a', summary: 'Needs a release bead' });
  await f.rt.snapshots.refresh(); await f.rt.watchdog.run();
  assert.equal(f.live.a.status, 'deferred'); assert.equal(f.live.b.status, 'deferred');
  assert.deepEqual(flags(f).filter(x => x.kind === 'unstructured_wait').map(x => x.bead_id).sort(), ['a', 'b']);
  assert.match(f.delivered[0].message, /structured/i);
});

test('explicit resume condition survives closed links and may be used for deferred status', async () => {
  const f = await fixture(); link(f); f.live.b.status = 'closed';
  f.live.a.status = 'deferred'; f.live.a.metadata.hive_resume = { reviewAt: '2099-01-01T00:00:00.000Z' };
  await f.rt.snapshots.refresh(); await f.rt.watchdog.run();
  assert.equal(f.live.a.status, 'deferred'); assert.equal(f.delivered.length, 0);
  await updateBead(f.rt, f.actor(), { bead_id: 'a', status: 'deferred', resume_after_bead: 'b' });
  await assert.rejects(updateBead(f.rt, f.actor(), { bead_id: 'a', resume_after_bead: '', resume_review_at: '' }), /structured/i);
});

test('missing prerequisites never auto-resolve and closed links cannot justify a new wait', async () => {
  const f = await fixture(); link(f, 'missing'); f.live.a.status = 'deferred';
  await f.rt.snapshots.refresh(); await f.rt.watchdog.run();
  assert.equal(f.live.a.status, 'deferred');
  f.live.a.dependencies.pop(); link(f); f.live.b.status = 'closed';
  await f.rt.snapshots.refresh();
  await assert.rejects(updateBead(f.rt, f.actor(), { bead_id: 'a', status: 'deferred' }), /structured/i);
});

test('claimed waits reopen without dropping ownership or starting work beyond capacity', async () => {
  const f = await fixture(); link(f); f.live.b.status = 'closed';
  f.live.a.status = 'deferred'; f.live.a.assignee = 'aw:queen';
  await f.rt.snapshots.refresh(); await f.rt.watchdog.run();
  assert.equal(f.live.a.status, 'open'); assert.equal(f.live.a.assignee, 'aw:queen');
  assert.equal(f.delivered.length, 1);
});

for (const kind of ['work', 'external']) {
  test(`open ${kind} prerequisite justifies deferred writes`, async () => {
    const f = await fixture(); link(f); f.live.b.metadata.hive_kind = kind;
    await f.rt.snapshots.refresh();
    for (const status of ['deferred']) {
      await updateBead(f.rt, f.actor(), { bead_id: 'a', status });
      await f.rt.snapshots.refresh(); assert.equal(f.live.a.status, status);
    }
  });
}

test('a newly open prerequisite in the queued export prevents stale auto-resolution', async () => {
  const f = await fixture(); link(f); f.live.b.status = 'closed'; f.live.a.status = 'deferred';
  await f.rt.snapshots.refresh();
  const update = f.rt.beads.update;
  f.rt.beads.update = async (...args) => { f.live.b.status = 'open'; return update(...args); };
  await f.rt.watchdog.run();
  assert.equal(f.live.a.status, 'deferred'); assert.equal(f.delivered.length, 0);
});

test('a retired runtime cannot clear a linked wait', async () => {
  const f = await fixture(); link(f); f.live.b.status = 'closed'; f.live.a.status = 'deferred';
  await f.rt.snapshots.refresh(); f.rt.metadata.lifetime.stop();
  await f.rt.watchdog.run(); assert.equal(f.live.a.status, 'deferred'); assert.equal(f.delivered.length, 0);
});

test('open link-derived waits suppress idle and dormant worker flags without a deferred status', async () => {
  const f = await fixture(); link(f);
  f.live.a.status = 'in_progress'; f.live.a.assignee = 'aw:queen';
  f.board.get('queen').lastActivity = f.now();
  await f.rt.snapshots.refresh(); f.advance(60 * 60000);
  assert.ok(!flags(f).some(x => ['stalled_worker', 'dormant_claim'].includes(x.kind)));
  f.board.get('queen').dormant = true;
  assert.ok(!flags(f).some(x => ['stalled_worker', 'dormant_claim'].includes(x.kind)));
});

test('wait resolution preserves a hold from an unrelated native edit', async () => {
  const f = await fixture(); link(f); f.live.a.status = 'deferred';
  await f.rt.snapshots.refresh();
  await setPickup(f.rt, f.host, f.actor(), { bead_id: 'a', ready: true, profile: f.profile });
  f.bump('a'); f.live.b.status = 'closed';
  await createPickupDispatcher({ runtime: f.rt, host: f.host, now: f.now }).run();
  assert.equal(f.live.a.status, 'open'); assert.equal(f.spawned.length, 0);
});

test('link-only deferred status resolves but historic open annotations are preserved', async () => {
  for (const status of ['deferred', 'open', 'in_progress']) {
    const f = await fixture(); link(f); f.live.b.status = 'closed';
    f.live.a.status = status; f.live.a.metadata.hive_waiting_for = 'PR checks running';
    await f.rt.snapshots.refresh(); await f.rt.watchdog.run();
    assert.equal(f.live.a.status, status === 'deferred' ? 'open' : status);
    assert.equal(f.graph().beads.a.waitingFor, status === 'deferred' ? '' : 'PR checks running');
    assert.equal(f.delivered.length, status === 'deferred' ? 1 : 0);
  }
});

test('open link-derived waiting notifies once on resolution then clears attention across queen handoff', async () => {
  const f = await fixture(); link(f);
  await f.rt.snapshots.refresh(); await f.rt.watchdog.run();
  f.live.b.status = 'closed';
  await f.rt.snapshots.refresh(); await f.rt.watchdog.run();
  assert.equal(f.delivered.length, 1);
  assert.ok(!flags(f).some(x => x.kind === 'prerequisites_resolved'));
  assert.ok(!Object.values(f.doc().cells.cell.watchdogFlags).some(x => x.kind === 'prerequisites_resolved'));
  f.doc().cells.cell.queenGeneration++;
  await f.rt.watchdog.run(); assert.equal(f.delivered.length, 1);
  f.live.a.status = 'in_progress'; f.live.a.metadata.hive_waiting_for = 'Awaiting hreq_123'; f.bump('a');
  await f.rt.snapshots.refresh(); await f.rt.watchdog.run();
  assert.equal(f.graph().beads.a.waitingFor, 'Awaiting hreq_123');
  assert.equal(f.delivered.length, 1);
});

test('historic closed prerequisites do not produce an upgrade notification backlog', async () => {
  const f = await fixture(); link(f); f.live.b.status = 'closed'; f.live.a.status = 'in_progress';
  await f.rt.snapshots.refresh(); await f.rt.watchdog.run();
  assert.deepEqual(flags(f), []); assert.equal(f.delivered.length, 0);
});

test('resolution observed after restart retains the pending dependency transition', async () => {
  const f = await fixture(); link(f);
  await f.rt.snapshots.refresh(); await f.rt.watchdog.run();
  f.live.b.status = 'closed'; await f.rt.snapshots.refresh();
  const restarted = createWatchdog({ runtime: f.rt, host: f.host, now: f.now });
  await restarted.run(); assert.equal(f.delivered.length, 1);
  await restarted.run(); assert.equal(f.delivered.length, 1);
});

test('snapshot observations capture short waits before the watchdog runs', async () => {
  const { observeLinkWaits } = await import('../server/link-waits.js');
  const f = await fixture(); link(f);
  await f.rt.snapshots.refresh(); observeLinkWaits(f.rt, f.now());
  f.live.b.status = 'closed'; await f.rt.snapshots.refresh(); observeLinkWaits(f.rt, f.now());
  await f.rt.watchdog.run(); assert.equal(f.delivered.length, 1);
  assert.deepEqual(flags(f), []);
});

test('resolution stays pending without a recipient and is consumed even if delivery fails', async () => {
  const f = await fixture(); link(f);
  await f.rt.snapshots.refresh(); await f.rt.watchdog.run();
  f.live.b.status = 'closed'; f.board.delete('queen');
  await f.rt.snapshots.refresh(); await f.rt.watchdog.run();
  assert.equal(flags(f).filter(x => x.kind === 'prerequisites_resolved').length, 1);
  f.board.set('queen', { sessionId: 'queen', taskId: 'task', status: 'idle' });
  let attempts = 0;
  f.host.deliver = async () => { attempts++; throw new Error('Uncertain mail delivery'); };
  await f.rt.watchdog.run(); assert.equal(attempts, 1);
  assert.ok(!flags(f).some(x => x.kind === 'prerequisites_resolved'));
  f.doc().cells.cell.queenGeneration++;
  const restarted = createWatchdog({ runtime: f.rt, host: f.host, now: f.now });
  await restarted.run(); assert.equal(attempts, 1);
});

test('an untouched link wait raises stale_wait even with an active prerequisite', async () => {
  const f = await fixture(); link(f);
  f.live.a.updated_at = new Date(f.now()).toISOString();
  f.live.b.status = 'in_progress'; f.live.b.assignee = 'aw:queen';
  await f.rt.snapshots.refresh(); f.advance(48 * 3600000);
  f.board.get('queen').status = 'working'; f.board.get('queen').lastActivity = f.now();
  assert.ok(flags(f).some(x => x.bead_id === 'a' && x.kind === 'stale_wait'));
});
