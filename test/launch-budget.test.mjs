import test from 'node:test';
import assert from 'node:assert/strict';
import { launchRate, reservePickupStart } from '../server/launch-budget.js';

test('rolling starts allow one per hive and two globally, including restart and rollback', () => {
  let d = {};
  reservePickupStart(d, 'a', 'a1', 100000);
  assert.match(launchRate(d, 'a', 99999).reason, /hive/);
  reservePickupStart(d, 'b', 'b1', 100001);
  d = JSON.parse(JSON.stringify(d));
  assert.match(launchRate(d, 'c', 100002).reason, /global/);
  assert.match(launchRate(d, 'c', 0).reason, /global/);
  assert.throws(() => reservePickupStart(d, 'c', 'c1', 100003), /global/);
  reservePickupStart(d, 'c', 'c1', 160000);
  assert.equal(d.pickupRates.cursor, 'c');
  assert.equal(d.pickupRates.starts.length, 2);
});
