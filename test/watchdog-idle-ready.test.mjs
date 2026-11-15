import test from 'node:test';
import assert from 'node:assert/strict';
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

for (const exclusion of ['deferred', 'external', 'investigation', 'idea', 'assigned', 'prerequisite', 'missing prerequisite', 'review', 'approved', 'request', 'wait', 'resume', 'descendants', 'capacity', 'spent', 'launchable', 'PR', 'handoff', 'armed']) {
  test(`${exclusion} work does not raise idle ready attention`, async () => {
    const f = await fixture();
    if (['deferred'].includes(exclusion)) f.live.a.status = exclusion;
    if (['external', 'investigation', 'idea'].includes(exclusion)) f.live.a.metadata.hive_kind = exclusion;
    if (exclusion === 'assigned') f.live.a.assignee = 'aw:queen';
    if (exclusion.includes('prerequisite')) { f.live.b.status = 'open'; f.live.a.dependencies.push({ issue_id: 'a', depends_on_id: exclusion === 'prerequisite' ? 'b' : 'missing', type: 'blocks' }); }
    if (exclusion === 'review' || exclusion === 'approved') f.doc().reviews.r = { workBeadId: 'a', cellId: 'cell', state: exclusion === 'review' ? 'in_review' : 'approved' };
    if (exclusion === 'request') f.doc().requests = { r: { cellId: 'cell', beadId: 'a', state: 'open' } };
    if (exclusion === 'wait') f.live.a.metadata.hive_waiting_for = 'Waiting on another team';
    if (exclusion === 'resume') f.live.a.metadata.hive_resume = { reviewAt: '2099-01-01' };
    if (exclusion === 'descendants') { f.live.b.status = 'open'; f.live.b.dependencies[0].depends_on_id = 'a'; }
    if (exclusion === 'capacity') { f.setLimit(1); f.live.b.status = 'in_progress'; f.live.b.assignee = 'aw:queen'; }
    if (exclusion === 'spent') f.doc().defaultPickupSpent = { a: { at: f.now() } };
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
