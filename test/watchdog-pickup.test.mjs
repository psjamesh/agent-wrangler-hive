import test from 'node:test';
import assert from 'node:assert/strict';
import { pickupFixture } from './helpers/pickup.mjs';
import { setPickup, createPickupDispatcher } from '../server/pickup.js';
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
