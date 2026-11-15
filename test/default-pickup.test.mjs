import test from 'node:test';
import assert from 'node:assert/strict';
import { pickupFixture } from './helpers/pickup.mjs';
import * as pickup from '../server/pickup.js';
import { collectWatchdog } from '../server/watchdog.js';

const run = f => pickup.createPickupDispatcher({ runtime: f.rt, host: f.host, now: f.now }).run();
const defaults = f => {
  f.live.ws = { ...structuredClone(f.live.a), id: 'ws', metadata: { hive_kind: 'workstream', hive_pickup: { workerProfile: f.profile, auto: true, briefTemplate: 'Run the repo tests. Hand back with a merge wait; do not close.' } }, dependencies: [{ issue_id: 'ws', depends_on_id: 'root', type: 'parent-child' }] };
  for (const id of ['a', 'b']) f.live[id].dependencies[0].depends_on_id = 'ws';
  f.live.a.priority = 0; f.live.b.priority = 1;
};

test('default profile starts scoped work once using existing claim and rate guards', async () => {
  const f = pickupFixture(); defaults(f);
  await run(f); await run(f);
  assert.equal(f.spawned.length, 1);
  assert.equal(f.actions.length, 1);
  assert.equal(f.live.a.assignee, 'aw:worker-1');
  f.live.a.assignee = null; f.live.a.status = 'open'; f.bump('a');
  f.advance(60000); await run(f);
  assert.equal(f.spawned.length, 2);
  assert.equal(f.spawned[1].ext.hive.beadId, 'b');
});

for (const kind of ['investigation', 'decision', 'external', 'idea', 'goal', 'workstream']) {
  test(`default pickup excludes ${kind}`, async () => {
    const f = pickupFixture(); defaults(f);
    f.live.a.metadata.hive_kind = kind;
    f.live.b.status = 'closed';
    await run(f); assert.equal(f.spawned.length, 0);
  });
}

for (const scenario of ['brief', 'prerequisite', 'human request', 'wait', 'resume']) {
  test(`default pickup excludes work with ${scenario}`, async () => {
    const f = pickupFixture(); defaults(f); f.live.b.status = 'closed';
    if (scenario === 'brief') f.live.a.acceptance_criteria = '';
    if (scenario === 'prerequisite') f.live.a.dependencies.push({ issue_id: 'a', depends_on_id: 'missing', type: 'blocks' });
    if (scenario === 'human request') f.doc().requests = { r: { state: 'open', cellId: 'cell', beadId: 'a' } };
    if (scenario === 'wait') f.live.a.metadata.hive_waiting_for = 'Awaiting human approval';
    if (scenario === 'resume') f.live.a.metadata.hive_resume = { reviewAt: '2099-01-01' };
    await run(f); assert.equal(f.spawned.length, 0);
  });
}

test('hold and unhold persist and explicit marks retain their profiles', async () => {
  const f = pickupFixture(); defaults(f); f.live.b.status = 'closed';
  await pickup.setPickup(f.rt, f.host, f.actor(), { bead_id: 'a', hold: true });
  await run(f); assert.equal(f.spawned.length, 0);
  await pickup.setPickup(f.rt, f.host, f.actor(), { bead_id: 'a', hold: false });
  await run(f); assert.equal(f.spawned.length, 1);
  const g = pickupFixture(); defaults(g);
  await pickup.setPickup(g.rt, g.host, g.actor(), { bead_id: 'a', ready: true, profile: { ...g.profile, intent: 'Per-bead override' } });
  await run(g); assert.equal(g.spawned[0].ext.hive.beadId, 'a');
  assert.equal(g.live.a.metadata.hive_pickup.profile.intent, 'Per-bead override');
});

test('free capacity watchdog names missing profile and missing cwd, excludes held work', async () => {
  const f = pickupFixture();
  f.live.a.metadata.hive_pickup = { automatic: true };
  f.live.b.metadata.hive_pickup = { automatic: true };
  await f.rt.snapshots.refresh();
  const flags = () => collectWatchdog(f.rt, f.host, f.doc().cells.cell, f.now()).filter(x => x.kind === 'pickup_unavailable');
  assert.match(flags()[0]?.reason || '', /profile/i);
  defaults(f); f.live.ws.metadata.hive_pickup.workerProfile.cwd = '';
  await f.rt.snapshots.refresh();
  assert.match(flags()[0]?.reason || '', /cwd|folder/i);
  f.live.a.metadata.hive_pickup = { held: true }; f.live.b.status = 'closed';
  await f.rt.snapshots.refresh(); assert.equal(flags().length, 0);
});

test('failed implicit startup never retries on later sweeps', async () => {
  const f = pickupFixture(); defaults(f); f.live.b.status = 'closed';
  f.host.sessions.spawn = async opts => { f.spawned.push(opts); throw new Error('uncertain start'); };
  await run(f); f.advance(60000); await run(f);
  assert.equal(f.spawned.length, 1);
});

test('default profile saves only installed resolved models and rejects invalid folders', async () => {
  const f = pickupFixture(); defaults(f); await f.rt.snapshots.refresh();
  await pickup.setWorkerProfile(f.rt, f.host, { cellId: 'cell', beadId: 'ws', profile: f.profile, auto: true, briefTemplate: 'Run checks, create PR, wait for queen merge.' });
  assert.equal(f.live.ws.metadata.hive_pickup.auto, true);
  assert.match(f.live.ws.metadata.hive_pickup.briefTemplate, /queen merge/);
  assert.equal(f.live.ws.metadata.hive_pickup.workerProfile.resolvedModel, 'claude-sonnet-fixed');
  await assert.rejects(pickup.setWorkerProfile(f.rt, f.host, { cellId: 'cell', beadId: 'ws', profile: { ...f.profile, model: 'missing' } }), /unavailable/i);
  await assert.rejects(pickup.setWorkerProfile(f.rt, f.host, { cellId: 'cell', beadId: 'ws', profile: { ...f.profile, cwd: 'relative' } }), /absolute/i);
  await pickup.setWorkerProfile(f.rt, f.host, { cellId: 'cell', beadId: 'ws', profile: null });
  assert.equal(f.live.ws.metadata.hive_pickup.workerProfile, null);
  assert.equal(f.live.ws.metadata.hive_pickup.auto, false);
});

test('holds preserve explicit authorization receipts and do not create watchdog noise', async () => {
  const f = pickupFixture(); f.live.b.status = 'closed';
  await pickup.setPickup(f.rt, f.host, f.actor(), { bead_id: 'a', ready: true, profile: f.profile });
  const token = f.live.a.metadata.hive_pickup.armToken;
  await pickup.setPickup(f.rt, f.host, f.actor(), { bead_id: 'a', hold: true });
  await run(f); assert.equal(f.spawned.length, 0);
  assert.deepEqual(pickup.pickupState(f.rt, f.host, f.doc().cells.cell, f.graph().beads.a).reconciliation_reasons, []);
  await pickup.setPickup(f.rt, f.host, f.actor(), { bead_id: 'a', hold: false });
  assert.equal(f.live.a.metadata.hive_pickup.armToken, token);
  await run(f); assert.equal(f.spawned.length, 1);
});

test('manual claim then release does not authorize a default replacement worker', async () => {
  const { claimBead } = await import('../server/ops.js');
  const f = pickupFixture(); defaults(f); f.live.b.status = 'closed';
  await claimBead(f.rt, f.actor(), { bead_id: 'a' });
  f.live.a.assignee = null; f.live.a.status = 'open'; f.bump('a');
  await run(f); assert.equal(f.spawned.length, 0);
  await pickup.setPickup(f.rt, f.host, f.actor(), { bead_id: 'a', hold: false });
  assert.match(pickup.pickupState(f.rt, f.host, f.doc().cells.cell, f.graph().beads.a, f.graph()).reason, /replacement/);
});

test('default work begins after its last prerequisite closes and capacity becomes free', async () => {
  const f = pickupFixture(1); defaults(f);
  f.live.a.dependencies.push({ issue_id: 'a', depends_on_id: 'b', type: 'blocks' });
  f.live.b.status = 'in_progress'; f.live.b.assignee = 'aw:queen';
  await run(f); assert.equal(f.spawned.length, 0);
  assert.equal(collectWatchdog(f.rt, f.host, f.doc().cells.cell, f.now()).filter(x => x.kind === 'pickup_unavailable').length, 0);
  f.live.b.status = 'closed'; f.live.b.assignee = null;
  await run(f); assert.equal(f.spawned.length, 1);
  assert.equal(f.spawned[0].ext.hive.beadId, 'a');
});

test('default profile catalog problems flag free work and recover without consuming a launch', async () => {
  const f = pickupFixture(); defaults(f); f.live.b.status = 'closed';
  const list = f.host.agents.list;
  f.host.agents.list = async () => { throw new Error('unavailable'); };
  await run(f); assert.equal(f.spawned.length, 0);
  assert.match(collectWatchdog(f.rt, f.host, f.doc().cells.cell, f.now()).find(x => x.kind === 'pickup_unavailable')?.reason || '', /catalog/i);
  assert.equal(Object.keys(f.doc().pickupAttempts).length, 0);
  f.host.agents.list = list;
  await run(f); assert.equal(f.spawned.length, 1);
});


test('nearest workstream profile and per-bead override choose their own repositories', async () => {
  const f = pickupFixture(); defaults(f); f.live.b.status = 'closed';
  f.live.nested = { ...structuredClone(f.live.ws), id: 'nested', metadata: { hive_kind: 'workstream', hive_pickup: { workerProfile: { ...f.profile, cwd: '/tmp/nested' }, briefTemplate: 'Nested delivery commands' } }, dependencies: [{ issue_id: 'nested', depends_on_id: 'ws', type: 'parent-child' }] };
  f.live.a.dependencies[0].depends_on_id = 'nested';
  await run(f);
  assert.equal(f.live.a.metadata.hive_pickup.profile.cwd, '/tmp/nested');
  assert.match(f.live.a.metadata.hive_pickup.profile.intent, /Nested delivery commands/);
  const g = pickupFixture(); defaults(g); g.live.b.status = 'closed';
  g.live.a.metadata.hive_pickup = { workerProfile: { ...g.profile, cwd: '/tmp/override' } };
  await run(g); assert.equal(g.live.a.metadata.hive_pickup.profile.cwd, '/tmp/override');
});

test('legacy unmarked work stays held until its workstream switches to auto; new work opts in', async () => {
  const f = pickupFixture(); defaults(f); f.live.b.status = 'closed';
  f.live.ws.metadata.hive_pickup.auto = false;
  assert.equal(pickup.pickupState(f.rt, f.host, f.doc().cells.cell, f.graph().beads.a, f.graph()).held, true);
  await run(f); assert.equal(f.spawned.length, 0);
  f.live.ws.metadata.hive_pickup.auto = true;
  await run(f); assert.equal(f.spawned.length, 1);
  const g = pickupFixture(); defaults(g); g.live.b.status = 'closed';
  g.live.ws.metadata.hive_pickup.auto = false;
  g.live.a.metadata.hive_pickup = { automatic: true };
  await run(g); assert.equal(g.spawned.length, 1);
});

for (const condition of ['open PR', 'approved review', 'merge handoff', 'install handoff', 'live claim']) {
  test(`structured ${condition} excludes awaiting delivery even after prose waits are cleared`, async () => {
    const f = pickupFixture(); defaults(f); f.live.b.status = 'closed';
    if (condition === 'open PR') f.doc().prLabels = { pr: { url: 'https://github.com/example/repo/pull/1', state: 'OPEN', associations: [{ cellId: 'cell', beadId: 'a' }] } };
    if (condition === 'approved review') f.doc().reviews.r = { workBeadId: 'a', cellId: 'cell', state: 'approved' };
    if (condition === 'merge handoff') f.live.a.metadata.hive_evidence = [{ kind: 'merge-wait', label: 'Handed to queen for merge' }];
    if (condition === 'install handoff') f.live.a.metadata.hive_evidence = [{ kind: 'install-wait', label: 'Handed to queen for install' }];
    if (condition === 'live claim') f.live.a.assignee = 'aw:queen';
    f.live.a.metadata.hive_waiting_for = '';
    await run(f); assert.equal(f.spawned.length, 0);
  });
}

test('one sweep arms only the worker being launched and does not freeze the backlog profile', async () => {
  const f = pickupFixture(); defaults(f);
  await run(f);
  assert.ok(f.live.a.metadata.hive_pickup.armToken);
  assert.equal(f.live.a.metadata.hive_pickup.armedBy, 'hive:default');
  assert.equal(f.live.b.metadata.hive_pickup?.armToken, undefined);
  f.live.ws.metadata.hive_pickup.workerProfile = null;
  f.advance(60000); await run(f);
  assert.equal(f.spawned.length, 1);
});

test('new Hive-created beads carry their default-pickup eligibility marker', async () => {
  const { createBeads } = await import('../server/ops.js');
  const f = pickupFixture(); let created;
  f.rt.beads.createMany = async ({ nodes }) => { created = nodes; return { ids: { n0: 'new' } }; };
  await createBeads(f.rt, f.actor(), { beads: [{ title: 'New bounded work' }] });
  assert.equal(created[0].pickup.automatic, true);
});

test('a bead created held cannot start while its brief and prerequisites are assembled', async () => {
  const { createBeads } = await import('../server/ops.js');
  const f = pickupFixture(); defaults(f); f.live.a.status = 'closed'; f.live.b.status = 'closed';
  f.rt.beads.createMany = async ({ nodes }) => {
    const n = nodes[0];
    f.live.new = { id: 'new', title: n.title, description: n.goal, acceptance_criteria: n.acceptance, status: 'open', updated_at: 'new-v1',
      metadata: { hive_kind: n.kind, hive_pickup: n.pickup }, dependencies: [{ issue_id: 'new', depends_on_id: n.parentId, type: 'parent-child' }] };
    return { ids: { n0: 'new' } };
  };
  await f.rt.snapshots.refresh();
  await createBeads(f.rt, f.actor(), { beads: [{ title: 'Assemble before launch', goal: 'Build it', acceptance: 'Verify it', parent: 'ws', hold: true }] });
  await run(f); assert.equal(f.spawned.length, 0);
  assert.equal(f.live.new.metadata.hive_pickup.held, true);
  await pickup.setPickup(f.rt, f.host, f.actor(), { bead_id: 'new', hold: false });
  f.advance(Date.now() + 120001 - f.now());
  await run(f); assert.equal(f.spawned.length, 1);
});

test('explicit readiness can launch PR fixes but default-created marks recheck delivery exclusions', async () => {
  const f = pickupFixture(); f.live.b.status = 'closed';
  f.doc().prLabels = { pr: { state: 'OPEN', beadIds: ['a'] } };
  f.doc().requests = { r: { cellId: 'cell', beadId: 'a', state: 'open' } };
  await pickup.setPickup(f.rt, f.host, f.actor(), { bead_id: 'a', ready: true, profile: f.profile });
  await run(f); assert.equal(f.spawned.length, 1);
  const g = pickupFixture(); g.live.b.status = 'closed';
  await pickup.setPickup(g.rt, g.host, g.actor(), { bead_id: 'a', ready: true, profile: g.profile });
  g.live.a.metadata.hive_pickup.source = 'default';
  g.doc().prLabels = { pr: { state: 'OPEN', beadIds: ['a'] } };
  await run(g); assert.equal(g.spawned.length, 0);
});

test('new bead grace period leaves time to assemble prerequisites across calls', async () => {
  const f = pickupFixture(); defaults(f); f.live.b.status = 'closed';
  f.live.a.metadata.hive_pickup = { automatic: true, notBefore: f.now() + 120000 };
  await run(f); assert.equal(f.spawned.length, 0);
  f.advance(119999); await run(f); assert.equal(f.spawned.length, 0);
  f.advance(1); await run(f); assert.equal(f.spawned.length, 1);
});

test('worker-created follow-up beads default to held and cannot request unheld creation', async () => {
  const { createBeads } = await import('../server/ops.js');
  const f = pickupFixture(); let created;
  f.rt.beads.createMany = async ({ nodes }) => { created = nodes; return { ids: { n0: 'new' } }; };
  await createBeads(f.rt, f.actor('worker', 'worker'), { beads: [{ title: 'Follow-up' }] });
  assert.equal(created[0].pickup.held, true);
  await assert.rejects(createBeads(f.rt, f.actor('worker', 'worker'), { beads: [{ title: 'Bypass readiness', hold: false }] }), /queen|human/i);
});

test('nearest workstream auto setting can opt legacy work out of a parent auto setting', async () => {
  const f = pickupFixture(); defaults(f); f.live.b.status = 'closed';
  f.live.nested = { ...structuredClone(f.live.ws), id: 'nested', metadata: { hive_kind: 'workstream', hive_pickup: { auto: false } }, dependencies: [{ issue_id: 'nested', depends_on_id: 'ws', type: 'parent-child' }] };
  f.live.a.dependencies[0].depends_on_id = 'nested';
  await run(f); assert.equal(f.spawned.length, 0);
});

test('an open review directly excludes default work without relying on launch or binding history', async () => {
  const f = pickupFixture(); defaults(f); f.live.b.status = 'closed';
  f.doc().reviews.r = { workBeadId: 'a', state: 'in_review' };
  await run(f); assert.equal(f.spawned.length, 0);
});
