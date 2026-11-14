import test from 'node:test';
import assert from 'node:assert/strict';
import { pickupFixture } from './helpers/pickup.mjs';
import { setPickup, pickupState, createPickupDispatcher } from '../server/pickup.js';
import { collectWatchdog, createWatchdog, setWatchdogSettings } from '../server/watchdog.js';

const MIN = 60000;
const flags = f => collectWatchdog(f.rt, f.host, f.doc().cells.cell, f.now()).filter(x => x.kind === 'pickup_held');
async function fixture() {
  const f = pickupFixture();
  f.doc().conversation = {};
  f.host.sessions.list = () => [...f.board.values()];
  await setPickup(f.rt, f.host, f.actor(), { bead_id: 'a', ready: true, profile: f.profile });
  f.board.set('stray', { sessionId: 'stray', spawnedBy: 'queen', status: 'working', managed: true });
  f.watchdog = createWatchdog({ runtime: f.rt, host: f.host, now: f.now });
  return f;
}

test('continuous pickup holds flag at five minutes, digest once, survive restart and clear on disarm', async () => {
  const f = await fixture();
  await f.watchdog.run();
  f.advance(5 * MIN - 1); await f.watchdog.run(); assert.deepEqual(flags(f), []);
  f.advance(1); await f.watchdog.run();
  const flag = flags(f)[0];
  assert.equal(flag.bead_id, 'a'); assert.equal(flag.age_ms, 5 * MIN);
  assert.deepEqual(flag.session_ids, ['stray']); assert.match(flag.reason, /stray/);
  assert.ok(flag.reasons.length);
  assert.equal(f.delivered.length, 1); assert.match(f.delivered[0].message, /pickup_held.*|stray/);
  await createWatchdog({ runtime: f.rt, host: f.host, now: f.now }).run();
  assert.equal(f.delivered.length, 1);
  await setPickup(f.rt, f.host, f.actor(), { bead_id: 'a', ready: false });
  await f.watchdog.run(); assert.deepEqual(flags(f), []);
  assert.deepEqual(f.doc().cells.cell.pickupHoldAnchors, {});
});

test('hold timer starts when held, resets on eligibility and uses per-hive settings', async () => {
  const f = await fixture();
  f.board.get('stray').dormant = true;
  f.advance(60 * MIN); await f.watchdog.run(); assert.deepEqual(flags(f), []);
  f.board.get('stray').dormant = false; await f.watchdog.run(); assert.deepEqual(flags(f), []);
  setWatchdogSettings(f.rt, { cellId: 'cell', settings: { pickupHeldMinutes: 2 } });
  f.advance(2 * MIN); await f.watchdog.run(); assert.equal(flags(f).length, 1);
  f.board.get('stray').dormant = true; await f.watchdog.run(); assert.deepEqual(flags(f), []);
  f.board.get('stray').dormant = false; await f.watchdog.run(); assert.deepEqual(flags(f), []);
  f.advance(2 * MIN); await f.watchdog.run(); assert.equal(flags(f).length, 1);
  f.board.get('stray').dormant = true;
  await createPickupDispatcher({ runtime: f.rt, host: f.host, now: f.now }).run();
  assert.equal(f.spawned.length, 1);
  await f.watchdog.run(); assert.deepEqual(flags(f), []);
});

test('reason text and live blocker membership changes do not repeat a continuous hold digest', async () => {
  const f = await fixture();
  await f.watchdog.run(); f.advance(5 * MIN); await f.watchdog.run();
  assert.equal(f.delivered.length, 1);
  f.board.set('second-stray', { sessionId: 'second-stray', spawnedBy: 'queen', status: 'working' });
  await f.watchdog.run();
  assert.deepEqual(flags(f)[0].session_ids, ['second-stray', 'stray']);
  assert.equal(f.delivered.length, 1);
  f.board.get('second-stray').dormant = true;
  await f.watchdog.run();
  assert.deepEqual(flags(f)[0].session_ids, ['stray']);
  assert.equal(f.delivered.length, 1);
  f.board.get('stray').dormant = true; await f.watchdog.run();
  f.board.get('stray').dormant = false; await f.watchdog.run();
  f.advance(5 * MIN); await f.watchdog.run();
  assert.equal(f.delivered.length, 2);
});

for (const hold of ['prerequisite', 'recorded-wait', 'descendants', 'review', 'capacity', 'rate']) {
  test(`ordinary ${hold} pickup waits never raise watchdog alerts`, async () => {
    const f = await fixture();
    f.board.get('stray').dormant = true;
    if (hold === 'prerequisite') f.live.a.dependencies.push({ issue_id: 'a', depends_on_id: 'b', type: 'blocks' });
    if (hold === 'recorded-wait') f.live.a.metadata.hive_waiting_for = 'Waiting on hive-xyz to merge';
    if (hold === 'descendants') f.live.b.dependencies = [{ issue_id: 'b', depends_on_id: 'a', type: 'parent-child' }];
    if (hold === 'review') f.doc().reviews.r = { id: 'r', cellId: 'cell', workBeadId: 'a', state: 'in_review', createdAt: f.now() };
    if (hold === 'capacity') { f.setLimit(1); f.live.b.assignee = 'aw:queen'; f.live.b.status = 'in_progress'; }
    if (hold === 'rate') f.doc().pickupRates = { starts: [{ cellId: 'cell', at: f.now() }] };
    f.bump('a'); await f.rt.snapshots.refresh();
    f.doc().pickupReceipts.a.nativeVersion = f.graph().beads.a.updatedAt;
    const state = pickupState(f.rt, f.host, f.doc().cells.cell, f.graph().beads.a, f.graph(), { now: f.now() });
    assert.equal(state.state, 'queued');
    assert.deepEqual(state.reconciliation_reasons, []);
    await f.watchdog.run(); f.advance(6 * MIN);
    if (hold === 'rate') f.doc().pickupRates.starts[0].at = f.now();
    await f.watchdog.run();
    assert.deepEqual(flags(f), []);
    assert.equal(f.delivered.length, 0);
  });
}

test('a reconciliation hold disappearing resets its timer even while a recorded wait remains', async () => {
  const f = await fixture();
  f.live.a.metadata.hive_waiting_for = 'Waiting on an external review';
  await f.rt.snapshots.refresh();
  await f.watchdog.run(); f.advance(4 * MIN);
  f.board.get('stray').dormant = true; await f.watchdog.run();
  f.advance(10 * MIN); await f.watchdog.run(); assert.deepEqual(flags(f), []);
  f.board.get('stray').dormant = false; await f.watchdog.run(); assert.deepEqual(flags(f), []);
  f.advance(5 * MIN); await f.watchdog.run(); assert.equal(flags(f).length, 1);
});

for (const hold of ['profile', 'receipt', 'version', 'brief', 'task']) {
  test(`a ${hold} reconciliation hold raises pickup attention`, async () => {
    const f = await fixture(); f.board.get('stray').dormant = true;
    if (hold === 'profile') f.doc().pickupHolds = { a: { token: f.graph().beads.a.pickup.armToken, reason: 'Model catalog unavailable' } };
    if (hold === 'receipt') delete f.doc().pickupReceipts.a;
    if (hold === 'version') { f.bump('a'); await f.rt.snapshots.refresh(); }
    if (hold === 'brief') { f.live.a.description = 'Changed brief'; await f.rt.snapshots.refresh(); }
    if (hold === 'task') f.host.tasks.get = () => ({ archived: true });
    await f.watchdog.run(); f.advance(5 * MIN); await f.watchdog.run();
    assert.equal(flags(f).length, 1);
    assert.equal(f.delivered.length, 1);
  });
}
