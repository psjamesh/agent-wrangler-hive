import test from 'node:test';
import assert from 'node:assert/strict';
import { setPickup, createPickupDispatcher } from '../server/pickup.js';
import { pickupFixture } from './helpers/pickup.mjs';
import { collectWatchdog, createWatchdog, setWatchdogSettings } from '../server/watchdog.js';

const MIN = 60000;
const flags = f => collectWatchdog(f.rt, f.host, f.doc().cells.cell, f.now()).filter(x => x.kind === 'idle_ready_work');
async function fixture() {
  const f = pickupFixture();
  f.live.b.status = 'closed';
  await f.rt.snapshots.refresh();
  f.watchdog = createWatchdog({ runtime: f.rt, host: f.host, now: f.now });
  return f;
}

for (const mode of ['unmarked', 'held', 'missing profile']) {
  test(`${mode} ready work flags after fifteen minutes and receipts survive restart`, async () => {
    const f = await fixture();
    if (mode === 'held') f.live.a.metadata.hive_pickup = { held: true };
    if (mode === 'missing profile') f.live.a.metadata.hive_pickup = { automatic: true };
    await f.rt.snapshots.refresh();
    await f.watchdog.run();
    f.advance(15 * MIN - 1); await f.watchdog.run(); assert.deepEqual(flags(f), []);
    f.advance(1); await f.watchdog.run();
    assert.equal(flags(f).length, 1);
    assert.equal(flags(f)[0].bead_id, 'a');
    assert.match(flags(f)[0].reason, mode === 'missing profile' ? /profile/i : new RegExp(mode, 'i'));
    assert.equal(flags(f)[0].age_ms, 15 * MIN);
    const count = f.delivered.length;
    await createWatchdog({ runtime: f.rt, host: f.host, now: f.now }).run();
    assert.equal(f.delivered.length, count);
    assert.match(f.delivered.at(-1).message, /idle_ready_work/);
    f.live.a.status = 'closed'; await f.rt.snapshots.refresh();
    await f.watchdog.run(); assert.deepEqual(flags(f), []);
  });
}

for (const exclusion of ['deferred', 'external', 'idea', 'assigned', 'prerequisite', 'missing prerequisite', 'review', 'approved', 'request', 'wait', 'resume', 'descendants', 'capacity', 'launchable', 'PR', 'handoff', 'armed']) {
  test(`${exclusion} work does not raise idle ready attention`, async () => {
    const f = await fixture();
    if (['deferred'].includes(exclusion)) f.live.a.status = exclusion;
    if (['external', 'idea'].includes(exclusion)) f.live.a.metadata.hive_kind = exclusion;
    if (exclusion === 'assigned') f.live.a.assignee = 'aw:queen';
    if (exclusion.includes('prerequisite')) { f.live.b.status = 'open'; f.live.a.dependencies.push({ issue_id: 'a', depends_on_id: exclusion === 'prerequisite' ? 'b' : 'missing', type: 'blocks' }); }
    if (exclusion === 'review' || exclusion === 'approved') f.doc().reviews.r = { workBeadId: 'a', cellId: 'cell', state: exclusion === 'review' ? 'in_review' : 'approved' };
    if (exclusion === 'request') f.doc().requests = { r: { cellId: 'cell', beadId: 'a', state: 'open' } };
    if (exclusion === 'wait') f.live.a.metadata.hive_waiting_for = 'Waiting on another team';
    if (exclusion === 'resume') f.live.a.metadata.hive_resume = { reviewAt: '2099-01-01' };
    if (exclusion === 'descendants') { f.live.b.status = 'open'; f.live.b.dependencies[0].depends_on_id = 'a'; }
    if (exclusion === 'capacity') { f.setLimit(1); f.live.b.status = 'in_progress'; f.live.b.assignee = 'aw:queen'; }
    if (exclusion === 'PR') f.doc().prLabels = { pr: { state: 'OPEN', beadIds: ['a'] } };
    if (exclusion === 'handoff') f.live.a.metadata.hive_evidence = [{ kind: 'install-wait', label: 'Await installation' }];
    if (exclusion === 'armed') f.live.a.metadata.hive_pickup = { armed: true, armToken: 'authorized' };
    if (exclusion === 'launchable') f.live.a.metadata.hive_pickup = { automatic: true, workerProfile: f.profile };
    await f.rt.snapshots.refresh();
    await f.watchdog.run(); f.advance(20 * MIN); await f.watchdog.run();
    assert.equal(flags(f).filter(x => x.bead_id === 'a').length, 0);
  });
}

test('timer measures continuous free capacity, honors settings and ignores unrelated edits', async () => {
  const f = await fixture();
  setWatchdogSettings(f.rt, { cellId: 'cell', settings: { idleReadyMinutes: 2 } });
  await f.watchdog.run(); f.advance(MIN);
  f.live.a.notes = 'Updated summary'; f.bump('a'); await f.rt.snapshots.refresh();
  await f.watchdog.run(); f.advance(MIN); await f.watchdog.run(); assert.equal(flags(f).length, 1);
  f.setLimit(1); f.live.b.status = 'in_progress'; f.live.b.assignee = 'aw:queen';
  await f.rt.snapshots.refresh(); await f.watchdog.run(); assert.deepEqual(flags(f), []);
  f.advance(10 * MIN); f.live.b.status = 'closed'; f.live.b.assignee = null;
  await f.rt.snapshots.refresh(); await f.watchdog.run(); assert.deepEqual(flags(f), []);
  f.advance(2 * MIN); await f.watchdog.run(); assert.equal(flags(f).length, 1);
});

for (const history of ['spent', 'binding', 'launch', 'investigation']) {
  test(`${history} ready work warns that explicit pickup is needed without launching`, async () => {
    const f = await fixture();
    f.live.a.metadata.hive_pickup = { automatic: true, workerProfile: f.profile };
    if (history === 'spent') f.doc().defaultPickupSpent = { a: { at: f.now() } };
    if (history === 'binding') f.doc().bindings.cell = [{ beadId: 'a', sessionId: 'old-worker', role: 'work', active: false }];
    if (history === 'launch') f.doc().workerLaunches.old = { beadId: 'a', state: 'launched', sessionId: 'old-worker' };
    if (history === 'investigation') f.live.a.metadata.hive_kind = 'investigation';
    await f.rt.snapshots.refresh();
    await f.watchdog.run(); f.advance(15 * MIN); await f.watchdog.run();
    assert.equal(flags(f).length, 1);
    assert.match(flags(f)[0].reason, history === 'investigation' ? /explicit.*pickup|unmarked/i : /rearm/i);
    await createPickupDispatcher({ runtime: f.rt, host: f.host, now: f.now }).run();
    assert.equal(f.spawned.length, 0);
  });
}

for (const mode of ['held', 'disarmed', 'reconciliation', 'rearmed held']) {
  test(`${mode} readiness keeps its stored profile and raises one warning`, async () => {
    const f = await fixture();
    if (mode === 'rearmed held') f.doc().bindings.cell = [{ beadId: 'a', sessionId: 'old-worker', role: 'work', active: false }];
    await setPickup(f.rt, f.host, f.actor(), { bead_id: 'a', ready: true, profile: f.profile });
    if (mode === 'disarmed') await setPickup(f.rt, f.host, f.actor(), { bead_id: 'a', ready: false });
    else await setPickup(f.rt, f.host, f.actor(), { bead_id: 'a', hold: true });
    if (mode === 'reconciliation') { delete f.doc().pickupReceipts.a; }
    await f.watchdog.run(); f.advance(15 * MIN); await f.watchdog.run();
    const attention = collectWatchdog(f.rt, f.host, f.doc().cells.cell, f.now()).filter(x => ['idle_ready_work', 'pickup_held'].includes(x.kind));
    assert.equal(attention.length, 1);
    assert.equal(attention[0].kind, mode === 'reconciliation' ? 'pickup_held' : 'idle_ready_work');
    assert.doesNotMatch(attention[0].reason, /No worker profile/i);
    if (mode === 'rearmed held') assert.doesNotMatch(attention[0].reason, /explicit rearm/i);
  });
}
