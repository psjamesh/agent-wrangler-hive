import test from 'node:test';
import assert from 'node:assert/strict';
import { createSnapshotCache } from '../server/snapshots.js';
import { flush } from './helpers/fake-timers.mjs';

function gatedBeads() {
  const gates = [];
  const beads = {
    status: { state: 'ready' },
    hierarchy: { generation: 0, writing: false },
    probe: async () => beads.status,
    loadSnapshot: () => new Promise((resolve, reject) => gates.push({ resolve: () => resolve({ beads: { [`p${gates.length}`]: {} }, edges: [] }), reject })),
  };
  return { beads, gates };
}

test('each snapshot caller waits only for its own pass while refreshes keep arriving', async () => {
  const { beads, gates } = gatedBeads();
  const cache = createSnapshotCache({ beads });
  const order = [];
  const first = cache.refresh().then(() => order.push('first'));
  await flush();
  assert.equal(gates.length, 1);
  const second = cache.refresh().then(() => order.push('second'));
  const alsoSecond = cache.refresh().then(() => order.push('alsoSecond'));
  gates[0].resolve();
  await first;
  await flush();
  assert.deepEqual(order, ['first']);
  assert.equal(gates.length, 2, 'one more pass serves every caller that arrived during the first');
  let stop = false;
  const continuous = (async () => {
    while (!stop) {
      cache.refresh();
      await flush(1);
    }
  })();
  gates[1].resolve();
  await second;
  await alsoSecond;
  assert.deepEqual(order, ['first', 'second', 'alsoSecond']);
  const late = cache.refresh();
  for (let i = 2; i < 6; i += 1) {
    await flush();
    gates[i]?.resolve();
  }
  const result = await late;
  assert.ok(result.loadedAt);
  stop = true;
  await continuous;
  for (const g of gates) g.resolve();
});

test('a failed pass rejects only its own callers and later callers get a fresh pass', async () => {
  const { beads, gates } = gatedBeads();
  beads.probe = async () => { throw new Error('runtime stopped'); };
  beads.status = { state: 'unknown' };
  const cache = createSnapshotCache({ beads });
  await assert.rejects(cache.refresh(), /runtime stopped/);
  beads.status = { state: 'ready' };
  const next = cache.refresh();
  await flush();
  gates[0].resolve();
  assert.ok((await next).loadedAt);
});

test('hierarchy currency still requires a pass that started after the last hierarchy write', async () => {
  const { beads, gates } = gatedBeads();
  const cache = createSnapshotCache({ beads });
  const pass = cache.refresh();
  await flush();
  beads.hierarchy.generation += 2;
  gates[0].resolve();
  await pass;
  assert.equal(cache.hierarchyCurrent, false);
  const again = cache.refresh();
  await flush();
  gates[1].resolve();
  await again;
  assert.equal(cache.hierarchyCurrent, true);
});

test('callers are released when the runtime stops mid-pass', async () => {
  const { beads, gates } = gatedBeads();
  let current = true;
  const cache = createSnapshotCache({ beads, isCurrent: () => current });
  const a = cache.refresh();
  await flush();
  const b = cache.refresh();
  current = false;
  gates[0].resolve();
  await a;
  await b;
  assert.equal(gates.length, 1);
});
