import test from 'node:test';
import assert from 'node:assert/strict';
import { pickupFixture } from './helpers/pickup.mjs';
import { claimBead, updateBead } from '../server/ops.js';
import { spawnWorker } from '../server/workers.js';
import * as pickup from '../server/pickup.js';

const arm = (f, id = 'a', extra = {}) => pickup.setPickup(f.rt, f.host, f.actor(), { bead_id: id, ready: true, profile: f.profile, ...extra });
const run = f => pickup.createPickupDispatcher({ runtime: f.rt, host: f.host, now: f.now }).run();

test('unmarked work never launches; default-on marked work claims exactly once', async () => {
  const f = pickupFixture();
  await run(f); assert.equal(f.spawned.length, 0);
  await arm(f); await run(f); await run(f);
  assert.equal(f.spawned.length, 1);
  assert.equal(f.live.a.assignee, 'aw:worker-1');
  assert.equal(f.doc().workerLaunches[Object.keys(f.doc().workerLaunches)[0]].source, 'automatic');
  assert.equal(Object.keys(f.doc().pickupAttempts).length, 1);
});

test('arming is queen/human only and repeated unused readiness is idempotent', async () => {
  const f = pickupFixture();
  await assert.rejects(pickup.setPickup(f.rt, f.host, f.actor('worker', 'worker'), { bead_id: 'a', ready: true, profile: f.profile }), /queen/i);
  const a = await arm(f), b = await arm(f);
  assert.equal(a.pickup.armToken, b.pickup.armToken);
  assert.equal(f.live.a.updated_at, b.pickup.nativeVersion);
});

test('direct claim and release between sweeps cannot revive readiness; rearm is guarded', async () => {
  const f = pickupFixture(); const first = await arm(f);
  await claimBead(f.rt, f.actor(), { bead_id: 'a' });
  f.live.a.assignee = null; f.live.a.status = 'open'; f.bump('a');
  await run(f); assert.equal(f.spawned.length, 0);
  await assert.rejects(arm(f), /rearm/i);
  await assert.rejects(arm(f, 'a', { rearm: true, reason: 'retry', expected_token: 'wrong' }), /token/i);
  const next = await arm(f, 'a', { rearm: true, reason: 'Confirmed release', expected_token: first.pickup.armToken });
  assert.notEqual(first.pickup.armToken, next.pickup.armToken);
});

test('external drift holds; recognized summary/evidence edits preserve readiness', async () => {
  const f = pickupFixture(); await arm(f);
  await updateBead(f.rt, f.actor(), { bead_id: 'a', summary: 'Current evidence' });
  await run(f); assert.equal(f.spawned.length, 1);
  const g = pickupFixture(); await arm(g); g.bump('a'); await run(g);
  assert.equal(g.spawned.length, 0);
  assert.match(pickup.pickupState(g.rt, g.host, g.doc().cells.cell, g.graph().beads.a, g.graph()).reason, /changed|version/i);
});

for (const scenario of ['disabled', 'snapshot', 'archived', 'setup', 'queen', 'blocked', 'deferred', 'assigned', 'group', 'children', 'review', 'wait', 'missing prerequisite', 'operation']) {
  test(`pickup refuses ${scenario} with an eligibility reason`, async () => {
    const f = pickupFixture(); await arm(f);
    if (scenario === 'disabled') f.doc().cells.cell.enabled = false;
    if (scenario === 'snapshot') f.doc().cells.cell.snapshot = {};
    if (scenario === 'archived') f.host.tasks.get = () => ({ archived: true });
    if (scenario === 'setup') f.doc().cells.cell.setup.state = 'pending';
    if (scenario === 'queen') f.board.delete('queen');
    if (scenario === 'blocked') f.live.a.status = 'blocked';
    if (scenario === 'deferred') f.live.a.status = 'deferred';
    if (scenario === 'assigned') f.live.a.assignee = 'aw:someone';
    if (scenario === 'group') f.live.a.metadata.hive_kind = 'workstream';
    if (scenario === 'children') f.live.b.dependencies[0].depends_on_id = 'a';
    if (scenario === 'review') f.doc().reviews.r = { workBeadId: 'a', state: 'in_review' };
    if (scenario === 'wait') f.live.a.metadata.hive_waiting_for = 'External approval';
    if (scenario === 'missing prerequisite') f.live.a.dependencies.push({ issue_id: 'a', depends_on_id: 'missing', type: 'blocks' });
    if (scenario === 'operation') f.doc().operations.o = { beadIds: ['a'], state: 'uncertain' };
    await run(f); assert.equal(f.spawned.length, 0);
    assert.ok(pickup.pickupState(f.rt, f.host, f.doc().cells.cell, f.graph().beads.a, f.graph()).reason);
  });
}

test('parallel wake requests and manual launch races submit only once', async () => {
  const f = pickupFixture(1); await arm(f);
  const d = pickup.createPickupDispatcher({ runtime: f.rt, host: f.host, now: f.now });
  await Promise.allSettled([d.run(), d.run(), spawnWorker(f.rt, f.host, f.actor(), { bead_id: 'a', ...f.profile })]);
  assert.equal(f.spawned.length, 1);
});

test('unknown host outcome is durable and never automatically retried', async () => {
  const f = pickupFixture(); await arm(f);
  f.host.sessions.spawn = async opts => { f.spawned.push(opts); throw new Error('unknown host result'); };
  await run(f); f.advance(120000); await run(f);
  assert.equal(f.spawned.length, 1);
  assert.equal(Object.values(f.doc().workerLaunches)[0].state, 'uncertain');
});

test('strict export failure and retired runtime cannot dispatch', async () => {
  const f = pickupFixture(); await arm(f);
  f.rt.beads.loadSnapshot = async () => { throw new Error('invalid export'); };
  await run(f); assert.equal(f.spawned.length, 0);
  const g = pickupFixture(); await arm(g); g.rt.metadata.lifetime.stop();
  await run(g); assert.equal(g.spawned.length, 0);
});

test('priority and rolling guards order the queue; Unlimited keeps the guard', async () => {
  const f = pickupFixture(0); f.live.b.priority = 0;
  await arm(f); await arm(f, 'b'); await run(f);
  assert.equal(f.spawned[0].ext.hive.beadId, 'b');
  await run(f); assert.equal(f.spawned.length, 1);
  f.advance(60000); await run(f); assert.equal(f.spawned.length, 2);
});

test('two hives share the final capacity slot and round-robin cursor', async () => {
  const f = pickupFixture(1);
  f.doc().cells.other = { ...f.doc().cells.cell, id: 'other', taskId: 'task2', rootBeadId: 'root2', queenSessionId: 'queen2' };
  f.live.root2 = { ...structuredClone(f.live.root), id: 'root2' };
  f.live.c = { ...structuredClone(f.live.a), id: 'c', dependencies: [{ issue_id: 'c', depends_on_id: 'root2', type: 'parent-child' }] };
  f.board.set('queen2', { sessionId: 'queen2', taskId: 'task2', status: 'idle' });
  await f.rt.snapshots.refresh();
  const cell = f.doc().cells.other;
  const actor = { sessionId: 'queen2', role: 'queen', cell, cells: [{ cell, role: 'queen' }] };
  await arm(f); await pickup.setPickup(f.rt, f.host, actor, { bead_id: 'c', ready: true, profile: f.profile });
  await run(f); assert.equal(f.spawned.length, 1);
  assert.equal(f.doc().pickupRates.cursor, 'cell');
  f.live.a.status = 'closed'; f.live.a.assignee = null; f.advance(60000); await run(f);
  assert.equal(f.spawned.length, 2); assert.equal(f.spawned[1].ext.hive.beadId, 'c');
});

for (const stage of ['provider', 'refresh', 'export', 'claim', 'pre-dispatch']) {
  test(`changed queen during ${stage} prevents first worker action`, async () => {
    const f = pickupFixture(); await arm(f);
    const change = () => { f.doc().cells.cell.queenGeneration += 1; };
    if (stage === 'provider') { const original = f.host.agents.list; f.host.agents.list = async () => { const result = await original(); change(); return result; }; }
    if (stage === 'refresh') { const original = f.rt.snapshots.refresh; let n = 0; f.rt.snapshots.refresh = async () => { const result = await original(); if (++n === 2) change(); return result; }; }
    if (stage === 'export' || stage === 'pre-dispatch') { const original = f.rt.beads.loadSnapshot; let n = 0; f.rt.beads.loadSnapshot = async opts => { const result = await original(opts); if (++n === (stage === 'export' ? 2 : 3)) change(); return result; }; }
    if (stage === 'claim') { const original = f.rt.beads.claim; f.rt.beads.claim = async (...args) => { change(); return original(...args); }; }
    await run(f);
    assert.equal(f.live.a.assignee || null, null);
  });
}

test('retiring during provider read leaves no attempt or spawn', async () => {
  const f = pickupFixture(); await arm(f);
  f.host.agents.list = async () => { f.rt.metadata.lifetime.stop(); return f.catalog; };
  await run(f); assert.equal(f.spawned.length, 0); assert.equal(Object.keys(f.doc().pickupAttempts).length, 0);
});

for (const change of ['brief', 'model', 'missing-provider', 'invalid-effort', 'mixed-model']) {
  test(`${change} cannot silently change an authorized profile or brief`, async () => {
    const f = pickupFixture(); await arm(f);
    if (change === 'brief') f.live.a.description = 'Different executable work';
    if (change === 'model') f.catalog[0].models[0].resolved = 'new-model';
    if (change === 'missing-provider') f.catalog[0].available = false;
    if (change === 'invalid-effort') f.catalog[0].models[0].efforts = ['high'];
    if (change === 'mixed-model') f.catalog[0].models[0].resolved = null;
    await run(f); assert.equal(f.spawned.length, 0);
  });
}

test('disarm after reservation refuses queued native startup', async () => {
  const f = pickupFixture(); await arm(f);
  const original = f.host.sessions.spawn;
  f.host.sessions.spawn = async opts => { f.live.a.metadata.hive_pickup.armed = false; f.bump('a'); return original(opts); };
  await run(f); assert.equal(f.live.a.assignee || null, null);
});

test('an arming receipt failure never replays the native write', async () => {
  const f = pickupFixture(); let writes = 0;
  const update = f.rt.beads.update;
  f.rt.beads.update = async (...args) => { writes += 1; await update(...args); throw new Error('lost native receipt'); };
  await assert.rejects(arm(f), /receipt/);
  await run(f); await run(f);
  assert.equal(f.spawned.length, 0); assert.equal(writes, 1);
});

test('a failed metadata reservation cannot cross the host boundary', async () => {
  const f = pickupFixture(); await arm(f);
  const mutate = f.rt.metadata.mutate;
  f.rt.metadata.mutate = fn => mutate(d => { const result = fn(d); if (Object.values(d.workerLaunches).some(l => l.state === 'reserved')) throw new Error('metadata disk full'); return result; });
  await run(f); assert.equal(f.spawned.length, 0);
});

test('changing a brief and changing it back cannot revive an old readiness mark', async () => {
  const f = pickupFixture(); await arm(f);
  const original = f.live.a.description;
  await updateBead(f.rt, f.actor(), { bead_id: 'a', goal: 'Changed executable brief' });
  await updateBead(f.rt, f.actor(), { bead_id: 'a', goal: original });
  await run(f); assert.equal(f.spawned.length, 0);
});

test('a recovered unconfirmed reservation needs attention and never submits again', async () => {
  const f = pickupFixture(); await arm(f);
  const bead = f.graph().beads.a;
  f.doc().workerLaunches.lost = { id: 'lost', cellId: 'cell', taskId: 'task', beadId: 'a', state: 'reserved', source: 'automatic', requestedBy: 'queen', role: 'worker' };
  f.doc().pickupAttempts[bead.pickup.armToken] = { token: bead.pickup.armToken, beadId: 'a', cellId: 'cell', launchId: 'lost' };
  await run(f); await run(f);
  assert.equal(f.spawned.length, 0);
  assert.equal(f.doc().workerLaunches.lost.state, 'uncertain');
  assert.equal(f.delivered.length, 1);
});

test('recovery observes a claimed worker after a lost host receipt without replay', async () => {
  const f = pickupFixture(); await arm(f);
  const original = f.host.sessions.spawn;
  f.host.sessions.spawn = async opts => { await original(opts); throw new Error('lost receipt after claim'); };
  await run(f);
  await run(f);
  assert.equal(f.spawned.length, 1);
  assert.equal(Object.values(f.doc().workerLaunches)[0].state, 'launched');
});

test('untracked descendant sessions suspend automatic pickup', async () => {
  const f = pickupFixture(); await arm(f);
  f.board.set('escaped', { sessionId: 'escaped', spawnedBy: 'queen', taskId: 'other-task', status: 'idle' });
  f.host.sessions.list = () => [...f.board.values()];
  await run(f); assert.equal(f.spawned.length, 0);
});

test('a known pre-dispatch refusal refunds the rolling debit, preserving its tombstone', async () => {
  const f = pickupFixture(); await arm(f);
  const original = f.rt.beads.loadSnapshot; let n = 0;
  f.rt.beads.loadSnapshot = async opts => { const graph = await original(opts); if (++n === 3) f.doc().cells.cell.enabled = false; return graph; };
  await run(f);
  assert.equal(f.spawned.length, 0);
  assert.equal(f.doc().pickupRates.starts.length, 0);
  assert.equal(Object.keys(f.doc().pickupAttempts).length, 1);
});

test('automatic workers inherit the governed Hive launch policy', async () => {
  const f = pickupFixture(); await arm(f); await run(f);
  assert.equal('disallowedTools' in f.spawned[0], false);
  assert.match(f.spawned[0].intent, /Delegate only through Hive \(hive_spawn_worker/);
});

test('finishing unclaimed ready work retires its authorization durably', async () => {
  const f = pickupFixture(); await arm(f);
  f.rt.beads.close = async id => { f.live[id].status = 'closed'; f.bump(id); };
  const { finishBead } = await import('../server/ops.js');
  await finishBead(f.rt, f.actor(), { bead_id: 'a', outcome: 'done', summary: 'No worker needed' });
  assert.equal(Object.values(f.doc().pickupAttempts)[0]?.source, 'finish');
});

test('planning readiness stays separate from pickup authorization and rejects missing prerequisites', async () => {
  const f = pickupFixture();
  const { readyBeads } = await import('../server/ops.js');
  assert.deepEqual(readyBeads(f.rt, f.actor(), {}).ready.map(b => b.bead_id).sort(), ['a', 'b']);
  assert.equal(readyBeads(f.rt, f.actor(), {}).pickup.length, 0);
  f.live.a.dependencies.push({ issue_id: 'a', depends_on_id: 'missing', type: 'blocks' });
  await f.rt.snapshots.refresh();
  assert.deepEqual(readyBeads(f.rt, f.actor(), {}).ready.map(b => b.bead_id), ['b']);
});

for (const stage of ['refresh', 'export', 'pre-dispatch', 'queued-claim', 'receipt']) {
  test(`runtime retirement at ${stage} leaves existing journals intact and starts no further work`, async () => {
    const f = pickupFixture(); await arm(f);
    let stoppedDoc;
    const stop = () => { f.rt.metadata.lifetime.stop(); stoppedDoc = JSON.stringify(f.doc()); };
    if (stage === 'refresh') { const original = f.rt.snapshots.refresh; f.rt.snapshots.refresh = async () => { const result = await original(); stop(); return result; }; }
    if (stage === 'export' || stage === 'pre-dispatch') { const original = f.rt.beads.loadSnapshot; let n = 0; f.rt.beads.loadSnapshot = async opts => { const graph = await original(opts); if (++n === (stage === 'export' ? 1 : 3)) stop(); return graph; }; }
    if (stage === 'queued-claim') { const original = f.rt.beads.claim; f.rt.beads.claim = async (...args) => { stop(); return original(...args); }; }
    if (stage === 'receipt') { const original = f.host.sessions.spawn; f.host.sessions.spawn = async opts => { const result = await original(opts); stop(); return result; }; }
    await run(f);
    assert.ok(stoppedDoc);
    assert.equal(JSON.stringify(f.doc()), stoppedDoc);
    if (!['receipt', 'queued-claim'].includes(stage)) assert.equal(f.spawned.length, 0);
    if (stage !== 'receipt') assert.equal(f.live.a.assignee || null, null);
  });
}

test('Unlimited permits more than two concurrent automatic builders after rolling windows', async () => {
  const f = pickupFixture(0);
  f.live.c = { ...structuredClone(f.live.a), id: 'c', dependencies: [{ issue_id: 'c', depends_on_id: 'root', type: 'parent-child' }] };
  await f.rt.snapshots.refresh();
  for (const id of ['a', 'b', 'c']) await arm(f, id);
  for (let i = 0; i < 3; i++) { await run(f); f.advance(60000); }
  assert.equal(f.spawned.length, 3);
  assert.equal(Object.values(f.live).filter(b => b.assignee).length, 3);
});

for (const change of ['queen', 'mark', 'task']) {
  test(`${change} changing during the native claim refuses first agent action`, async () => {
    const f = pickupFixture(); await arm(f);
    const original = f.rt.beads.claim;
    f.rt.beads.claim = async (...args) => {
      const result = await original(...args);
      if (change === 'queen') f.doc().cells.cell.queenGeneration += 1;
      if (change === 'mark') { f.live.a.metadata.hive_pickup.armed = false; f.bump('a'); }
      if (change === 'task') f.host.tasks.get = () => ({ archived: true });
      return result;
    };
    await run(f);
    assert.equal(f.actions.length, 0);
    assert.equal(f.live.a.assignee, 'aw:worker-1');
  });
}

test('removing readiness does not hide an uncertain launch from bead details', async () => {
  const f = pickupFixture(); await arm(f);
  f.host.sessions.spawn = async opts => { f.spawned.push(opts); throw new Error('unknown receipt'); };
  await run(f);
  await pickup.setPickup(f.rt, f.host, f.actor(), { bead_id: 'a', ready: false });
  const state = pickup.pickupState(f.rt, f.host, f.doc().cells.cell, f.graph().beads.a, f.graph());
  assert.equal(state.armed, false);
  assert.equal(state.state, 'attention');
  assert.match(state.reason, /unknown receipt/);
});

for (const field of ['agent', 'model', 'resolved']) {
  test(`readiness rejects Terra in ${field} before arming`, async () => {
    const f = pickupFixture();
    if (field === 'agent') { f.profile.agent = 'Terra-provider'; f.catalog[0].id = f.profile.agent; }
    if (field === 'model') { f.profile.model = 'gpt-6-terra'; f.catalog[0].models[0].value = f.profile.model; }
    if (field === 'resolved') f.catalog[0].models[0].resolved = 'gpt-5.6-TERRA';
    await assert.rejects(arm(f), /Terra/i);
    assert.equal(f.live.a.metadata.hive_pickup, undefined);
    assert.equal(f.spawned.length, 0);
  });
}

test('an armed alias later resolving to Terra cannot launch', async () => {
  const f = pickupFixture(); await arm(f);
  f.catalog[0].models[0].resolved = 'gpt-6-terra';
  await run(f); assert.equal(f.spawned.length, 0);
  assert.match(pickup.pickupState(f.rt, f.host, f.doc().cells.cell, f.graph().beads.a, f.graph()).reason, /Terra/i);
});

for (const field of ['agent', 'model', 'resolved', 'missing-catalog']) {
  test(`shared manual worker launch rejects ${field} Terra or unverifiable catalog`, async () => {
    const f = pickupFixture(); const input = { bead_id: 'a', ...f.profile };
    if (field === 'agent') { input.agent = 'Terra-provider'; f.catalog[0].id = input.agent; }
    if (field === 'model') { input.model = 'gpt-6-terra'; f.catalog[0].models[0].value = input.model; }
    if (field === 'resolved') f.catalog[0].models[0].resolved = 'gpt-6-terra';
    if (field === 'missing-catalog') delete f.host.agents;
    await assert.rejects(spawnWorker(f.rt, f.host, f.actor(), input), field === 'missing-catalog' ? /catalog|agents:read/i : /Terra/i);
    assert.equal(f.spawned.length, 0);
    assert.equal(Object.keys(f.doc().workerLaunches).length, 0);
  });
}

for (const gap of ['provider', 'model', 'empty', 'read-error', 'capability']) {
  test(`a transient ${gap} catalog gap holds the mark, notifies once, and recovers`, async () => {
    const f = pickupFixture(); const mark = await arm(f);
    const list = f.host.agents.list;
    if (gap === 'provider') f.catalog[0].available = false;
    if (gap === 'model') f.catalog[0].models[0].resolved = null;
    if (gap === 'empty') f.host.agents.list = async () => [];
    if (gap === 'read-error') f.host.agents.list = async () => { throw new Error('temporary outage'); };
    if (gap === 'capability') delete f.host.agents.list;
    await run(f); await run(f);
    assert.equal(f.spawned.length, 0);
    assert.equal(Object.keys(f.doc().pickupAttempts).length, 0);
    assert.equal(f.delivered.length, 1);
    const held = pickup.pickupState(f.rt, f.host, f.doc().cells.cell, f.graph().beads.a, f.graph());
    assert.equal(held.state, 'queued'); assert.match(held.reason, /provider|model|catalog|agents:read/i);
    f.catalog[0].available = true; f.catalog[0].models[0].resolved = 'claude-sonnet-fixed'; f.host.agents.list = list;
    f.advance(120000); await run(f);
    assert.equal(f.spawned.length, 1);
    assert.equal(Object.values(f.doc().pickupAttempts)[0].token, mark.pickup.armToken);
  });
}

test('oversize working folders fail at mark time without consuming readiness', async () => {
  const f = pickupFixture(); f.profile.cwd = '/' + 'x'.repeat(2000);
  await assert.rejects(arm(f), /cwd.*2000/i);
  assert.equal(f.live.a.metadata.hive_pickup, undefined);
});

for (const reason of ['decision', 'recorded-wait', 'native-blocked', 'operation', 'reservation']) {
  test(`manual readiness keeps ${reason} planning candidates with separate pickup exclusions`, async () => {
    const f = pickupFixture(); await arm(f);
    if (reason === 'decision') f.live.a.metadata.hive_kind = 'decision';
    if (reason === 'recorded-wait') f.live.a.metadata.hive_waiting_for = 'External review';
    if (reason === 'native-blocked') f.live.a.is_blocked = true;
    if (reason === 'operation') f.doc().operations.wait = { beadIds: ['a'], state: 'uncertain' };
    if (reason === 'reservation') f.doc().workerLaunches.wait = { id: 'wait', beadId: 'a', state: 'reserved' };
    await f.rt.snapshots.refresh();
    const { readyBeads } = await import('../server/ops.js');
    const result = readyBeads(f.rt, f.actor(), {});
    assert.ok(result.ready.some(b => b.bead_id === 'a'));
    const state = result.pickup.find(b => b.bead_id === 'a');
    assert.equal(state.eligible, false); assert.ok(state.reason);
  });
}

for (const gap of ['empty', 'read-error']) {
  test(`a ${gap} catalog gap in shared launch preflight also preserves the mark`, async () => {
    const f = pickupFixture(); await arm(f);
    const original = f.host.agents.list; let reads = 0;
    f.host.agents.list = async () => {
      if (++reads === 2) {
        if (gap === 'read-error') throw new Error('catalog gap');
        return [];
      }
      return original();
    };
    await run(f);
    assert.equal(f.spawned.length, 0); assert.equal(Object.keys(f.doc().pickupAttempts).length, 0);
    f.host.agents.list = original; f.advance(120000); await run(f); assert.equal(f.spawned.length, 1);
  });
}
