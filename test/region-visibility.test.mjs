import test from 'node:test';
import assert from 'node:assert/strict';
import { hiddenWork } from '../public/region-visibility.js';

test('overlapping Hide done settings inspect nested regions in linear work', () => {
  const ids = Array.from({ length: 400 }, (_, i) => `b${i}`);
  const beads = Object.fromEntries(ids.map((id) => [id, { id, status: 'closed' }]));
  let reads = 0;
  class Children extends Map {
    get(id) { reads += 1; return super.get(id); }
  }
  const kids = new Children(ids.slice(0, -1).map((id, i) => [id, [beads[ids[i + 1]]]]));
  const layout = { order: ids, groupHeads: ids };
  const { hidden, counts } = hiddenWork({ beads }, layout, kids, ids);
  assert.equal(hidden.size, 399);
  assert.equal(hidden.has('b0'), false);
  for (let i = 0; i < ids.length; i += 1) assert.equal(counts.get(ids[i]), 399 - i);
  assert.ok(reads < 400 * 20, `nested visibility read children ${reads} times`);
  beads.b399.status = 'open';
  reads = 0;
  const reopened = hiddenWork({ beads }, layout, kids, ids);
  assert.equal(reopened.hidden.size, 0);
  for (const count of reopened.counts.values()) assert.equal(count, 0);
  assert.ok(reads < 400 * 20, `reopened nested visibility read children ${reads} times`);
});
