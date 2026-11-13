import fs from 'node:fs';
import vm from 'node:vm';
import { beadTile, primaryKind, markWords } from '../public/cell-view.js';
import { hexPath } from '../public/hex-grid.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createBeads, claimBead, finishBead, readyBeads, reconcileForAgent, updateBead, waitingOn } from '../server/ops.js';
import { buildGraph, actorFor } from '../server/bead-model.js';

const raw = (id, parent = 'root', extra = {}) => ({ id, title: id, status: 'open', assignee: null, metadata: { hive_kind: 'work' }, dependencies: parent ? [{ issue_id: id, depends_on_id: parent, type: 'parent-child' }] : [], ...extra });
function fixture(limit = 1) {
  let doc = { cells: { cell: { id: 'cell', taskId: 'task', rootBeadId: 'root', enabled: true, queenSessionId: 'queen' }, other: { id: 'other', taskId: 'other-task', rootBeadId: 'other-root', enabled: true, queenSessionId: 'queen2' } }, bindings: {}, operations: {}, launches: {}, workerLaunches: {}, reviews: {}, conversation: {}, threads: {}, inbox: {}, beadLayout: {}, arrangeAspect: {}, workstreamColours: {}, archived: {}, restoreNotices: {}, restoring: {} };
  const live = { root: raw('root', null, { metadata: { hive_kind: 'goal' } }), a: raw('a'), b: raw('b'), 'other-root': raw('other-root', null, { metadata: { hive_kind: 'goal' } }), c: raw('c', 'other-root') };
  const board = new Map([['queen', { sessionId: 'queen', taskId: 'task', status: 'working' }], ['queen2', { sessionId: 'queen2', taskId: 'other-task', status: 'working' }]]);
  const graph = () => buildGraph(Object.values(live));
  const rt = {
    metadata: { read: () => doc, cell: (id) => doc.cells[id], cells: () => Object.values(doc.cells), cellForTask: (id) => Object.values(doc.cells).find((c) => c.taskId === id), mutate: (fn) => { const next = structuredClone(doc); const r = fn(next); doc = next; return r; } },
    snapshots: { graph: graph(), current: { error: null, loadedAt: 1 }, refresh: async () => { rt.snapshots.graph = graph(); return rt.snapshots.current; }, invalidate() {} },
    settings: { get: () => limit }, pendingParticipants: new Map(), changed() {}, log() {},
    beads: {
      status: { state: 'ready' }, loadSnapshot: async () => graph(), show: async (id) => structuredClone(live[id]),
      claim: async (id, who, check) => { check?.({ issues: Object.values(live), errors: [] }); if (live[id].assignee === who) return { already: true }; if (live[id].assignee) throw Object.assign(new Error('already claimed'), { code: 'conflict' }); live[id].assignee = who; live[id].status = 'in_progress'; return { already: false }; },
    },
  };
  const host = { stores: { hive: rt }, settings: rt.settings, sessions: { get: (id) => board.get(id), forTask: (id) => [...board.values()].filter((s) => s.taskId === id) }, tasks: { get: (id) => ({ taskId: id, name: id }), forSession: (id) => board.get(id) ? { taskId: board.get(id).taskId } : null } };
  rt.host = host;
  const actor = (sessionId = 'queen', cellId = 'cell') => ({ sessionId, cell: doc.cells[cellId], role: 'queen', cells: [{ cell: doc.cells[cellId], role: 'queen' }] });
  return { rt, host, live, board, actor, doc: () => doc, setLimit: (n) => { limit = n; } };
}

test('two cells competing for the last slot admit only one claim', async () => {
  const f = fixture();
  const results = await Promise.allSettled([claimBead(f.rt, f.actor(), { bead_id: 'a' }), claimBead(f.rt, f.actor('queen2', 'other'), { bead_id: 'c' })]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(Object.values(f.live).filter((b) => b.assignee).length, 1);
  assert.match(results.find((r) => r.status === 'rejected').reason.message, /limit|capacity/i);
});

test('settings change without restart, unlimited admits and repeated own claims cost no slot', async () => {
  const f = fixture();
  await claimBead(f.rt, f.actor(), { bead_id: 'a' });
  assert.equal((await claimBead(f.rt, f.actor(), { bead_id: 'a' })).already_yours, true);
  await assert.rejects(claimBead(f.rt, f.actor(), { bead_id: 'b' }), /limit|capacity/i);
  f.setLimit(0);
  await claimBead(f.rt, f.actor(), { bead_id: 'b' });
  assert.equal(f.live.b.assignee, actorFor('queen'));
});

export { fixture, raw };

import * as workers from '../server/workers.js';
async function dispatchFixture(f, mode = 'ok') {
  const { createManifest } = await import('../server/manifest.js');
  const manifest = createManifest({ dir: '.' });
  let n = 0;
  f.host.sessions.spawn = async (opts) => {
    const sessionId = `worker-${++n}`;
    const ext = opts.ext.hive;
    assert.ok(opts.intent.includes(`hive_context({ scope: "bead", bead_id: "${ext.beadId}", cell_id: "${f.rt.metadata.cellForTask(opts.taskId).id}" })`));
    manifest.hooks['session.prepare']({ sessionId, taskId: opts.taskId, spawnedBy: null, host: f.host });
    await manifest.session.onBeforeDispatch({ sessionId, ext, host: f.host });
    const out = await manifest.hooks['session.launchContext']({ sid: sessionId, task: { id: opts.taskId }, reason: 'spawn', host: f.host });
    if (out?.refuse) throw new Error(out.refuse);
    if (ext.reviewId) assert.equal(f.doc().reviews[ext.reviewId].reviewerSessionId, sessionId, 'reviewer is bound before its first action');
    else if (opts.intent.includes('You are a helper on Hive bead')) assert.notEqual(f.live[ext.beadId].assignee, actorFor(sessionId), 'a helper never takes the claim');
    else assert.equal(f.live[ext.beadId].assignee, actorFor(sessionId), 'the first agent action must see its claim');
    assert(Object.values(f.doc().bindings).flat().some((b) => b.sessionId === sessionId && b.beadId === ext.beadId && b.active));
    if (mode === 'throw-after-claim') throw new Error('startup failed after claim');
    f.board.set(sessionId, { sessionId, taskId: opts.taskId, status: 'working' });
    return { sessionId };
  };
}

test('worker launch claims and binds before the first agent action', async () => {
  const f = fixture();
  await dispatchFixture(f);
  const out = await workers.spawnWorker(f.rt, f.host, f.actor(), { bead_id: 'a', intent: 'build it' });
  assert.equal(out.session_id, 'worker-1');
  assert.equal(f.live.a.assignee, 'aw:worker-1');
});

test('reservations fence duplicate launches and cross-cell claims before dispatch', async () => {
  const f = fixture();
  let release;
  const pending = new Promise((r) => { release = r; });
  f.host.sessions.spawn = () => pending;
  const job = workers.spawnWorker(f.rt, f.host, f.actor(), { bead_id: 'a', intent: 'build it' });
  while (!Object.values(f.doc().workerLaunches).length) await new Promise((r) => setImmediate(r));
  await assert.rejects(workers.spawnWorker(f.rt, f.host, f.actor(), { bead_id: 'a', intent: 'duplicate' }), /reserved/);
  await assert.rejects(claimBead(f.rt, f.actor('queen2', 'other'), { bead_id: 'c' }), /limit|capacity/i);
  release({ sessionId: 'unexpected' });
  await assert.rejects(job, /unconfirmed|confirm|uncertain/i);
});

test('a failed launch after claiming retains ownership and capacity for reconciliation', async () => {
  const f = fixture();
  await dispatchFixture(f, 'throw-after-claim');
  await assert.rejects(workers.spawnWorker(f.rt, f.host, f.actor(), { bead_id: 'a', intent: 'build it' }), /uncertain/i);
  assert.equal(f.live.a.assignee, 'aw:worker-1');
  assert.equal(Object.values(f.doc().workerLaunches)[0].state, 'uncertain');
  await assert.rejects(claimBead(f.rt, f.actor(), { bead_id: 'b' }), /limit|capacity/i);
});

test('launch gate refuses a stale session identity and never transfers a claim', async () => {
  const f = fixture();
  await dispatchFixture(f);
  const out = await workers.spawnWorker(f.rt, f.host, f.actor(), { bead_id: 'a', intent: 'build it' });
  const r = await workers.workerLaunchContext({ sid: 'imposter', task: { id: 'task' }, reason: 'spawn', ext: { workerLaunchId: out.launch_id, beadId: 'a' }, host: f.host });
  assert.match(r.refuse, /session|launch/i);
  assert.equal(f.live.a.assignee, 'aw:worker-1');
});

function reviewFixture(f) {
  f.rt.beads.update = async (id, patch, who, check) => {
    check?.({ issues: Object.values(f.live), errors: [] });
    if (patch.nextAction !== undefined) f.live[id].metadata.hive_next_action = patch.nextAction;
    if (patch.evidence) f.live[id].metadata.hive_evidence = patch.evidence;
  };
  f.host.deliver = async () => ({ mode: 'live' });
}
import * as reviews from '../server/reviews.js';



import * as tracking from '../server/tracking.js';
test('drift flags unowned or archived work but preserves idle and dormant owners and real waits', async () => {
  const f = fixture(8);
  f.live.a.status = 'in_progress';
  await f.rt.snapshots.refresh();
  assert.equal(tracking.isUntracked(f.host, f.rt.snapshots.graph, f.rt.snapshots.graph.beads.a), true);
  f.live.a.assignee = 'aw:idle';
  f.board.set('idle', { sessionId: 'idle', status: 'idle', dormant: true });
  await f.rt.snapshots.refresh();
  assert.equal(tracking.isUntracked(f.host, f.rt.snapshots.graph, f.rt.snapshots.graph.beads.a), false);
  f.board.get('idle').archived = true;
  assert.equal(tracking.isUntracked(f.host, f.rt.snapshots.graph, f.rt.snapshots.graph.beads.a), true);
  f.live.a.dependencies.push({ issue_id: 'a', depends_on_id: 'b', type: 'blocks' });
  await f.rt.snapshots.refresh();
  assert.equal(tracking.isUntracked(f.host, f.rt.snapshots.graph, f.rt.snapshots.graph.beads.a), false);
  f.live.b.status = 'closed';
  await f.rt.snapshots.refresh();
  assert.equal(tracking.isUntracked(f.host, f.rt.snapshots.graph, f.rt.snapshots.graph.beads.a), true);
});

test('untracked work has a distinct map mark even when an unclaimed bound agent is busy', async () => {
  const { primaryKind, markWords } = await import('../public/cell-view.js');
  const kind = primaryKind({ status: 'in_progress', untracked: true }, [], ['working']);
  assert.equal(kind, 'untracked');
  assert.match(markWords(kind, {}), /Untracked/);
});

test('default eight counts work across cells, excludes headings, and explicit zero is unlimited', async () => {
  const f = fixture(undefined);
  f.setLimit(undefined);
  for (let i = 0; i < 9; i++) f.live[`job-${i}`] = raw(`job-${i}`, i % 2 ? 'root' : 'other-root');
  f.live.heading = raw('heading', 'root', { status: 'in_progress', assignee: 'aw:queen', metadata: { hive_kind: 'workstream' } });
  await f.rt.snapshots.refresh();
  for (let i = 0; i < 8; i++) await claimBead(f.rt, f.actor(i % 2 ? 'queen' : 'queen2', i % 2 ? 'cell' : 'other'), { bead_id: `job-${i}` });
  await assert.rejects(claimBead(f.rt, f.actor('queen2', 'other'), { bead_id: 'job-8' }), /limit.*8/);
  f.setLimit(0);
  await claimBead(f.rt, f.actor('queen2', 'other'), { bead_id: 'job-8' });
});

test('a claimed blocked item cannot bypass the limit by updating its status', async () => {
  const f = fixture(1);
  f.live.b.assignee = 'aw:queen';
  f.live.b.status = 'blocked';
  f.rt.beads.update = async (id, patch, who, check) => { check?.({ issues: Object.values(f.live), errors: [] }); Object.assign(f.live[id], patch); };
  await f.rt.snapshots.refresh();
  await claimBead(f.rt, f.actor(), { bead_id: 'a' });
  await assert.rejects(updateBead(f.rt, f.actor(), { bead_id: 'b', status: 'in_progress' }), /limit|capacity/i);
  assert.equal(f.live.b.status, 'blocked');
});

test('a swallowed binding save failure refuses startup through its in-memory dispatch identity', async () => {
  const f = fixture();
  const { createManifest } = await import('../server/manifest.js');
  const manifest = createManifest({ dir: '.' });
  f.host.sessions.spawn = async (opts) => {
    const mutate = f.rt.metadata.mutate;
    f.rt.metadata.mutate = () => { throw new Error('disk unavailable'); };
    try { manifest.session.onBeforeDispatch({ sessionId: 'worker-broken', ext: opts.ext.hive, host: f.host }); } catch {}
    const out = await manifest.hooks['session.launchContext']({ sid: 'worker-broken', task: { id: 'task' }, reason: 'spawn', host: f.host });
    f.rt.metadata.mutate = mutate;
    assert.match(out.refuse, /disk unavailable/);
    throw new Error(out.refuse);
  };
  await assert.rejects(workers.spawnWorker(f.rt, f.host, f.actor(), { bead_id: 'a', intent: 'build' }), /uncertain/);
  assert.equal(f.live.a.assignee, null);
});

test('abandon fences a late dispatch and releases only the reservation, never a surviving claim', async () => {
  const f = fixture();
  f.host.sessions.spawn = async () => { throw new Error('no result'); };
  await assert.rejects(workers.spawnWorker(f.rt, f.host, f.actor(), { bead_id: 'a', intent: 'build' }), /uncertain/);
  const l = Object.values(f.doc().workerLaunches)[0];
  await workers.reconcileWorkerLaunch(f.rt, f.host, f.actor(), { launch_id: l.id, abandon: true, reason: 'confirmed no process' });
  workers.workerBeforeDispatch({ sessionId: 'late', ext: { workerLaunchId: l.id }, host: f.host });
  const r = await workers.workerLaunchContext({ sid: 'late', task: { id: 'task' }, reason: 'spawn', host: f.host });
  assert.match(r.refuse, /stale|session|launch/);
  await claimBead(f.rt, f.actor(), { bead_id: 'b' });
});




test('context exposes global capacity, drift and ordinary untracked sessions from current state', async () => {
  const { buildContext } = await import('../server/tools.js');
  const f = fixture(2);
  f.live.a.assignee = 'aw:queen'; f.live.a.status = 'in_progress';
  f.live.c.assignee = 'aw:queen2'; f.live.c.status = 'in_progress';
  f.live.b.status = 'in_progress';
  f.board.set('plain', { sessionId: 'plain', taskId: 'task', status: 'working' });
  const actor = { ...f.actor('plain'), role: 'worker' };
  const out = await buildContext(f.rt, f.host, actor);
  assert.deepEqual(out.capacity, { limit: 2, unlimited: false, claimed: 2, reserved: 0, used: 2, available: 0 });
  assert.deepEqual(out.attention.untracked_beads.map((b) => b.bead_id), ['b']);
  assert(out.attention.untracked_sessions.some((s) => s.session_id === 'plain'));
  assert.equal(out.beads.find((b) => b.bead_id === 'b').untracked, true);
});

test('context lists dormant claim holders even when more than 60 sessions are bound', async () => {
  const { buildContext } = await import('../server/tools.js');
  const f = fixture(2);
  f.live.a.assignee = 'aw:holder'; f.live.a.status = 'in_progress';
  f.board.set('holder', { sessionId: 'holder', taskId: 'task', status: 'idle', dormant: true });
  f.doc().bindings.cell = Array.from({ length: 70 }, (_, i) => ({ id: `bind-${i}`, sessionId: `extra-${i}`, beadId: 'b', role: 'worker', active: true }));
  const out = await buildContext(f.rt, f.host, { ...f.actor('holder'), role: 'worker' });
  assert.deepEqual(out.attention.claims_held_by_inactive_sessions.map((s) => [s.session_id, s.status]), [['holder', 'dormant']]);
});

test('the launch gate rechecks coordinator authority before claiming', async () => {
  const f = fixture();
  f.host.sessions.spawn = async (opts) => {
    workers.workerBeforeDispatch({ sessionId: 'worker-late', ext: opts.ext.hive, host: f.host });
    f.doc().cells.cell.queenSessionId = 'replacement';
    const out = await workers.workerLaunchContext({ sid: 'worker-late', task: { id: 'task' }, reason: 'spawn', host: f.host });
    assert.match(out.refuse, /queen|coordinator/);
    throw new Error(out.refuse);
  };
  await assert.rejects(workers.spawnWorker(f.rt, f.host, f.actor(), { bead_id: 'a', intent: 'build' }), /uncertain/);
  assert.equal(f.live.a.assignee, null);
});

test('an incomplete export cannot admit an explicit claim even with unlimited capacity', async () => {
  const f = fixture(0);
  f.rt.beads.claim = async (id, who, check) => { check({ issues: Object.values(f.live), errors: ['truncated line'] }); throw new Error('must refuse before write'); };
  await assert.rejects(claimBead(f.rt, f.actor(), { bead_id: 'a' }), /incomplete/);
  assert.equal(f.live.a.assignee, null);
});

test('reconciliation cannot abandon a surviving worker claim and confirms the existing session instead of respawning', async () => {
  const f = fixture(2);
  await dispatchFixture(f, 'throw-after-claim');
  await assert.rejects(workers.spawnWorker(f.rt, f.host, f.actor(), { bead_id: 'a', intent: 'build' }), /uncertain/);
  const l = Object.values(f.doc().workerLaunches)[0];
  await assert.rejects(workers.reconcileWorkerLaunch(f.rt, f.host, f.actor(), { launch_id: l.id, abandon: true, reason: 'checked' }), /surviving/);
  f.board.set('worker-1', { sessionId: 'worker-1', taskId: 'task', status: 'idle', dormant: true });
  const out = await workers.reconcileWorkerLaunch(f.rt, f.host, f.actor(), { launch_id: l.id });
  assert.equal(out.state, 'launched');
  assert.equal(out.session_id, 'worker-1');
});

import * as archival from '../server/archived-claims.js';
function archiveFixture(f) {
  f.board.set('builder', { sessionId: 'builder', taskId: 'task', status: 'idle', archived: true });
  f.rt.beads.release = async (id, who, { holder, priorStatus, status, check, onStep }) => {
    check?.(f.live[id]);
    assert.equal(f.live[id].assignee, holder);
    assert.equal(f.live[id].status, priorStatus);
    onStep?.({ step: 'unclaim', state: 'started' });
    f.live[id].assignee = null;
    f.live[id].status = status;
    onStep?.({ step: 'unclaim', state: 'done' });
  };
}

test('archiving releases unfinished claims across hives and keeps each work status', async () => {
  const f = fixture(8);
  archiveFixture(f);
  for (const [id, status] of [['a', 'in_progress'], ['b', 'blocked'], ['c', 'deferred']]) { f.live[id].assignee = 'aw:builder'; f.live[id].status = status; }
  await archival.releaseArchivedClaims(f.rt, f.host, 'builder');
  for (const [id, status] of [['a', 'in_progress'], ['b', 'blocked'], ['c', 'deferred']]) { assert.equal(f.live[id].assignee, null); assert.equal(f.live[id].status, status); }
  assert.equal(Object.values(f.doc().operations).filter((op) => op.kind === 'release').length, 3);
  await archival.releaseArchivedClaims(f.rt, f.host, 'builder');
  assert.equal(Object.values(f.doc().operations).filter((op) => op.kind === 'release').length, 3);
});

test('archive cleanup does not release a replacement claimant discovered after its scan', async () => {
  const f = fixture(8);
  archiveFixture(f);
  f.live.a.assignee = 'aw:builder'; f.live.a.status = 'in_progress';
  const show = f.rt.beads.show;
  f.rt.beads.show = async (id) => { if (id === 'a') f.live.a.assignee = 'aw:replacement'; return show(id); };
  await archival.releaseArchivedClaims(f.rt, f.host, 'builder');
  assert.equal(f.live.a.assignee, 'aw:replacement');
  assert.equal(Object.keys(f.doc().operations).length, 0);
});

test('the native release fence rechecks archive state after waiting in the adapter queue', async () => {
  const f = fixture(8);
  archiveFixture(f);
  f.live.a.assignee = 'aw:builder'; f.live.a.status = 'blocked';
  const release = f.rt.beads.release;
  f.rt.beads.release = async (...args) => { f.board.get('builder').archived = false; return release(...args); };
  await archival.releaseArchivedClaims(f.rt, f.host, 'builder');
  assert.equal(f.live.a.assignee, 'aw:builder');
  assert.equal(f.live.a.status, 'blocked');
});

test('an uncertain archive release is never repeated by subsequent cleanup', async () => {
  const f = fixture(8);
  archiveFixture(f);
  f.live.a.assignee = 'aw:builder'; f.live.a.status = 'in_progress';
  let writes = 0;
  f.rt.beads.release = async () => { writes++; throw Object.assign(new Error('native timeout'), { code: 'uncertain' }); };
  await archival.releaseArchivedClaims(f.rt, f.host, 'builder');
  await archival.releaseArchivedClaims(f.rt, f.host, 'builder');
  assert.equal(writes, 1);
  assert.equal(Object.values(f.doc().operations)[0].state, 'uncertain');
});

test('archiving before spawn returns retires its reservation without resurrecting it as uncertain', async () => {
  const f = fixture(1);
  await dispatchFixture(f);
  archiveFixture(f);
  const spawn = f.host.sessions.spawn;
  f.host.sessions.spawn = async (opts) => {
    const result = await spawn(opts);
    f.board.get(result.sessionId).archived = true;
    await archival.onArchive({ sessionId: result.sessionId, host: f.host });
    return result;
  };
  const out = await workers.spawnWorker(f.rt, f.host, f.actor(), { bead_id: 'a', intent: 'build' });
  assert.equal(out.state, 'archived');
  assert.equal(f.doc().workerLaunches[out.launch_id].state, 'archived');
  assert.equal(f.live.a.assignee, null);
  assert.equal(f.live.a.status, 'in_progress');
  await claimBead(f.rt, f.actor(), { bead_id: 'b' });
});


for (const reason of ['resume', 'message', 'snooze-wake', 'headless']) {
  test(`tracked ${reason} reacquires its released claim through admission or refuses at the cap`, async () => {
    const f = fixture(1);
    await dispatchFixture(f); archiveFixture(f);
    await workers.spawnWorker(f.rt, f.host, f.actor(), { bead_id: 'a', intent: 'build' });
    f.board.get('worker-1').archived = true;
    await archival.releaseArchivedClaims(f.rt, f.host, 'worker-1');
    f.board.get('worker-1').archived = false;
    await claimBead(f.rt, f.actor(), { bead_id: 'b' });
    const payload = { sid: 'worker-1', task: { id: 'task' }, reason, host: f.host };
    const denied = await workers.workerLaunchContext(payload);
    assert.match(denied?.refuse || '', /limit|capacity/i);
    assert.equal(f.live.a.assignee, null);
    f.live.b.assignee = null;
    const allowed = await workers.workerLaunchContext(payload);
    assert.equal(allowed?.refuse, undefined);
    assert.equal(f.live.a.assignee, 'aw:worker-1');
    assert.equal(Object.values(f.doc().workerLaunches)[0].state, 'launched');
  });
}

test('relaunch identity survives restart and refuses missing, abandoned or misdirected tracking', async () => {
  const f = fixture(1); await dispatchFixture(f);
  const out = await workers.spawnWorker(f.rt, f.host, f.actor(), { bead_id: 'a', intent: 'build' });
  const payload = { sid: 'worker-1', task: { id: 'task' }, reason: 'resume', host: f.host };
  f.rt.workerDispatches.clear();
  const l = f.doc().workerLaunches[out.launch_id];
  l.state = 'abandoned';
  assert.match((await workers.workerLaunchContext(payload))?.refuse || '', /abandon|stale/i);
  l.state = 'launched';
  assert.match((await workers.workerLaunchContext({ ...payload, task: { id: 'other-task' } }))?.refuse || '', /task/i);
  delete f.doc().workerLaunches[out.launch_id];
  assert.match((await workers.workerLaunchContext(payload))?.refuse || '', /missing|stale|launch/i);
});

test('update cannot start unclaimed work and creation cannot start unclaimed work at a full cap', async () => {
  const { createBeads } = await import('../server/ops.js');
  const f = fixture(1); reviewFixture(f);
  await claimBead(f.rt, f.actor(), { bead_id: 'a' });
  f.rt.beads.update = async (id, patch, who, check) => { check?.({ issues: Object.values(f.live), errors: [] }); Object.assign(f.live[id], patch); };
  await assert.rejects(updateBead(f.rt, f.actor(), { bead_id: 'b', status: 'in_progress' }), /claim/i);
  assert.equal(f.live.b.status, 'open');
  await assert.rejects(createBeads(f.rt, f.actor(), { beads: [{ title: 'Work', status: 'in_progress' }] }), /claim/i);
  assert.equal(Object.values(f.live).some((b) => b.id.startsWith('review-')), false);
  f.live.b.status = 'in_progress';
  await f.rt.snapshots.refresh();
  await updateBead(f.rt, f.actor(), { bead_id: 'b', status: 'in_progress' });
  assert.equal(f.live.b.assignee, null, 'status-preserving released work remains released');
});

import { capacity } from '../server/admission.js';










test('an early relaunch while the spawn result is pending keeps the confirmed launch', async () => {
  const f = fixture(); await dispatchFixture(f);
  const spawn = f.host.sessions.spawn;
  f.host.sessions.spawn = async (opts) => {
    const result = await spawn(opts);
    const resumed = await workers.workerLaunchContext({ sid: result.sessionId, task: { id: 'task' }, reason: 'resume', host: f.host });
    assert.equal(resumed?.refuse, undefined);
    return result;
  };
  const out = await workers.spawnWorker(f.rt, f.host, f.actor(), { bead_id: 'a', intent: 'build' });
  assert.equal(f.doc().workerLaunches[out.launch_id].state, 'launched');
});

test('concurrent relaunches preserve a valid existing claim after queen replacement and lowering the limit', async () => {
  const f = fixture(2); await dispatchFixture(f);
  await workers.spawnWorker(f.rt, f.host, f.actor(), { bead_id: 'a', intent: 'build' });
  await claimBead(f.rt, f.actor('queen2', 'other'), { bead_id: 'c' });
  f.setLimit(1);
  f.doc().cells.cell.queenSessionId = 'replacement';
  f.board.set('replacement', { sessionId: 'replacement', taskId: 'task', status: 'working' });
  const results = await Promise.all(['resume', 'message'].map((reason) => workers.workerLaunchContext({ sid: 'worker-1', task: { id: 'task' }, reason, host: f.host })));
  assert(results.every((r) => !r?.refuse));
  assert.equal(f.live.a.assignee, 'aw:worker-1');
  assert.equal(capacity(f.rt).used, 2);
});


test('review starts on the existing bead at full capacity, without a bead or link and without taking its builder claim', async () => {
  const f = fixture(1); reviewFixture(f); await dispatchFixture(f);
  await claimBead(f.rt, f.actor(), { bead_id: 'a' });
  const out = await reviews.requestReview(f.rt, f.host, f.actor(), { bead_id: 'a', intent: 'review' });
  assert.equal(out.bead_id, 'a');
  assert.equal(f.live.a.assignee, 'aw:queen');
  assert.equal(Object.keys(f.live).length, 5);
  assert.equal(f.live.a.dependencies.length, 1);
  const review = f.doc().reviews[out.review_id];
  assert.equal(review.state, 'in_review');
  assert.equal(review.reviewerSessionId, 'worker-1');
  assert(f.doc().bindings.cell.some((b) => b.sessionId === 'worker-1' && b.beadId === 'a' && b.role === 'reviewer' && b.active));
  assert.equal(capacity(f.rt).used, 1);
});

test('only the bound reviewer can give a verdict on work; generic finish cannot bypass the review', async () => {
  const { finishBead } = await import('../server/ops.js');
  const f = fixture(1); reviewFixture(f); await dispatchFixture(f);
  await claimBead(f.rt, f.actor(), { bead_id: 'a' });
  await reviews.requestReview(f.rt, f.host, f.actor(), { bead_id: 'a', intent: 'review' });
  const args = { bead_id: 'a', verdict: 'changes_requested', summary: 'Fix the race' };
  await assert.rejects(reviews.reviewVerdict(f.rt, f.host, f.actor(), args), /reviewer/);
  await assert.rejects(finishBead(f.rt, f.actor(), { bead_id: 'a', outcome: 'done', summary: 'skip review' }), /review/);
  await reviews.reviewVerdict(f.rt, f.host, f.actor('worker-1'), args);
  await reviews.reviewVerdict(f.rt, f.host, f.actor('worker-1'), args);
  assert.equal(f.live.a.status, 'in_progress');
  assert.equal(f.live.a.assignee, 'aw:queen');
  assert.equal(Object.values(f.doc().reviews)[0].state, 'changes_requested');
  assert.match(f.live.a.metadata.hive_next_action, /Fix the race/);
  assert.equal(f.live.a.metadata.hive_evidence.length, 1);
});

async function reviewRounds(f) {
  await claimBead(f.rt, f.actor(), { bead_id: 'a' });
  const out = await reviews.requestReview(f.rt, f.host, f.actor(), { bead_id: 'a', intent: 'review' });
  const reviewer = f.actor(out.session_id);
  const give = (verdict, commit, summary = `${verdict} ${commit}`, who = reviewer) => reviews.reviewVerdict(f.rt, f.host, who, { bead_id: 'a', verdict, summary, ...(commit ? { commit } : {}) });
  return { out, reviewer, give, record: () => f.doc().reviews[out.review_id] };
}

test('a retained reviewer records a new round on a later commit after changes requested, keeping earlier rounds', async () => {
  const { reviewFields } = await import('../server/review-state.js');
  const f = fixture(1); reviewFixture(f); await dispatchFixture(f);
  const { give, record, out } = await reviewRounds(f);
  await give('changes_requested', '128e9c8');
  assert.equal(record().state, 'changes_requested');
  const result = await give('approved', '9f54fb4');
  assert.equal(result.verdict, 'approved');
  assert.equal(result.review_id, out.review_id);
  assert.equal(Object.keys(f.doc().reviews).length, 1);
  assert.equal(record().state, 'approved');
  assert.equal(record().round, 2);
  assert.equal(record().commit, '9f54fb4');
  assert.equal(record().reviewerSessionId, out.session_id);
  assert.equal(record().history.length, 1);
  assert.deepEqual({ round: record().history[0].round, commit: record().history[0].commit, value: record().history[0].verdict.value }, { round: 1, commit: '128e9c8', value: 'changes_requested' });
  assert.equal(reviewFields(f.rt, 'a').reviewState, 'approved');
  assert.equal(reviewFields(f.rt, 'a').review.summary, 'approved 9f54fb4');
  const labels = f.live.a.metadata.hive_evidence.map((e) => e.label);
  assert.equal(labels.length, 2);
  assert.equal(new Set(labels).size, 2);
  assert.match(f.live.a.metadata.hive_next_action, /approved/i);
  assert.equal(Object.values(f.doc().operations).filter((op) => op.kind === 'review-verdict' && op.state === 'applied').length, 2);
});

test('repeated rounds of changes requested notify the builder each time and keep every earlier verdict', async () => {
  const f = fixture(1); reviewFixture(f); await dispatchFixture(f);
  const sent = []; f.host.deliver = async (sid, text) => { sent.push(text); return { mode: 'live' }; };
  const { give, record } = await reviewRounds(f);
  await give('changes_requested', 'c1'); await give('changes_requested', 'c2'); await give('approved', 'c3');
  assert.equal(record().round, 3);
  assert.deepEqual(record().history.map((h) => [h.round, h.commit, h.verdict.value]), [[1, 'c1', 'changes_requested'], [2, 'c2', 'changes_requested']]);
  assert.equal(sent.filter((t) => /requested changes/.test(t)).length, 2);
  assert.equal(f.live.a.metadata.hive_evidence.length, 3);
});

test('an identical repeat of the latest round stays idempotent and a conflicting verdict for the same commit is refused', async () => {
  const f = fixture(1); reviewFixture(f); await dispatchFixture(f);
  const { give, record } = await reviewRounds(f);
  await give('changes_requested', 'c1', 'Fix it');
  await give('changes_requested', 'c1', 'Fix it');
  assert.equal(record().round, 1);
  assert.equal(f.live.a.metadata.hive_evidence.length, 1);
  await assert.rejects(give('approved', 'c1', 'Fix it'), /different verdict/);
  await assert.rejects(give('changes_requested', 'c1', 'Other findings'), /different verdict/);
  await give('approved', 'c2', 'Clean');
  await give('approved', 'c2', 'Clean');
  assert.equal(record().round, 2);
  assert.equal(f.live.a.metadata.hive_evidence.length, 2);
  await assert.rejects(give('changes_requested', 'c2', 'Clean'), /different verdict/);
  await assert.rejects(give('changes_requested', 'c1', 'Fix it'), /different verdict|earlier round/);
  assert.equal(record().state, 'approved');
  assert.equal(f.live.a.metadata.hive_evidence.length, 2);
});

test('an approved review cannot be reopened, and a new round needs a different commit and the bound reviewer', async () => {
  const f = fixture(1); reviewFixture(f); await dispatchFixture(f);
  const { give, record, out } = await reviewRounds(f);
  await give('approved', 'c1');
  await assert.rejects(give('changes_requested', 'c2'), /different verdict/);
  assert.equal(record().round || 1, 1);
  const g = fixture(1); reviewFixture(g); await dispatchFixture(g);
  const second = await reviewRounds(g);
  await second.give('changes_requested', 'c1');
  await assert.rejects(second.give('approved', 'c2', 'x', g.actor()), /reviewer/);
  await assert.rejects(second.give('approved', 'c2', 'x', g.actor('worker-9')), /reviewer|access|session/i);
  assert.equal(second.record().state, 'changes_requested');
  assert.equal(second.record().round || 1, 1);
});

test('a verdict without a commit keeps the earlier single-verdict behaviour', async () => {
  const f = fixture(1); reviewFixture(f); await dispatchFixture(f);
  const { give, record } = await reviewRounds(f);
  await give('changes_requested');
  await assert.rejects(give('approved'), /different verdict/);
  await give('changes_requested');
  assert.equal(record().state, 'changes_requested');
  await give('approved', 'c2');
  assert.equal(record().round, 2);
  assert.equal(record().history[0].commit, undefined);
});

test('a new round is an open review until its verdict: finish is refused and a failed write is retried in the same round', async () => {
  const { finishBead } = await import('../server/ops.js');
  const f = fixture(1); reviewFixture(f); await dispatchFixture(f);
  const { give, record } = await reviewRounds(f);
  await give('changes_requested', 'c1');
  const update = f.rt.beads.update; let fail = true;
  f.rt.beads.update = async (...args) => { if (fail) { fail = false; throw new Error('receipt lost'); } return update(...args); };
  await assert.rejects(give('approved', 'c2'), /receipt lost/);
  assert.equal(record().round, 2);
  assert.equal(record().history.length, 1);
  assert.notEqual(record().state, 'changes_requested');
  await assert.rejects(finishBead(f.rt, f.actor(), { bead_id: 'a', outcome: 'done', summary: 'skip' }), /review/);
  await give('approved', 'c2');
  assert.equal(record().state, 'approved');
  assert.equal(record().round, 2);
  assert.equal(record().history.length, 1);
});

test('a new round is not opened on work that closed meanwhile, and the reopen holds the bead lock', async () => {
  const { withLock } = await import('../server/ops.js');
  const f = fixture(1); reviewFixture(f); await dispatchFixture(f);
  const { give, record } = await reviewRounds(f);
  await give('changes_requested', 'c1');
  let release; const gate = new Promise((r) => { release = r; });
  const held = withLock('bead:a', async () => { await gate; f.live.a.status = 'closed'; });
  const pending = give('approved', 'c2');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(record().state, 'changes_requested');
  assert.equal(record().round, 1);
  release(); await held;
  await assert.rejects(pending, /missing or closed/);
  assert.equal(record().state, 'changes_requested');
  assert.equal(record().round, 1);
  assert.equal(record().history, undefined);
});

test('startReviewRound only starts from a settled changes_requested verdict and replaces the stale summary', async () => {
  const f = fixture(1); reviewFixture(f); await dispatchFixture(f);
  const { give, record, out } = await reviewRounds(f);
  assert.throws(() => reviews.startReviewRound(f.rt, out.review_id, { commit: 'c1' }), /settled changes_requested/);
  await give('approved', 'c1', 'Looks fine');
  assert.throws(() => reviews.startReviewRound(f.rt, out.review_id, { commit: 'c2' }), /settled changes_requested/);
  assert.equal(record().history, undefined);
  const g = fixture(1); reviewFixture(g); await dispatchFixture(g);
  const second = await reviewRounds(g);
  await second.give('changes_requested', 'c1', 'Old findings');
  reviews.startReviewRound(g.rt, second.out.review_id, { commit: 'c2' });
  assert.equal(second.record().state, 'in_review');
  assert.doesNotMatch(second.record().summary, /Old findings/);
  assert.equal(second.record().history[0].summary, 'Old findings');
  g.doc().operations[second.record().history[0].verdictOpId] && (g.doc().operations[second.record().history[0].verdictOpId].state = 'uncertain');
  await second.give('changes_requested', 'c2', 'Again');
  g.doc().operations[second.record().verdictOpId].state = 'uncertain';
  assert.throws(() => reviews.startReviewRound(g.rt, second.out.review_id, { commit: 'c3' }), /settled|unsettled/);
});

test('concurrent full-cap reviews across cells share their work slots, including after builder release/archive', async () => {
  const f = fixture(2); reviewFixture(f); await dispatchFixture(f); archiveFixture(f);
  await claimBead(f.rt, f.actor(), { bead_id: 'a' });
  await claimBead(f.rt, f.actor('queen2', 'other'), { bead_id: 'c' });
  await Promise.all([reviews.requestReview(f.rt, f.host, f.actor(), { bead_id: 'a', intent: 'review a' }), reviews.requestReview(f.rt, f.host, f.actor('queen2', 'other'), { bead_id: 'c', intent: 'review c' })]);
  assert.equal(capacity(f.rt).used, 2);
  f.live.a.assignee = null;
  f.board.get('queen2').archived = true;
  await archival.releaseArchivedClaims(f.rt, f.host, 'queen2');
  assert.equal(capacity(f.rt).used, 2);
  await assert.rejects(claimBead(f.rt, f.actor(), { bead_id: 'b' }), /limit/);
});

test('a review of uncounted work needs capacity and standalone review-kind work is not exempt', async () => {
  const f = fixture(1); reviewFixture(f); await dispatchFixture(f);
  await claimBead(f.rt, f.actor(), { bead_id: 'a' });
  await assert.rejects(reviews.requestReview(f.rt, f.host, f.actor(), { bead_id: 'b', intent: 'review' }), /limit/);
  assert.equal(Object.keys(f.doc().reviews).length, 0);
  f.live.b.metadata.hive_kind = 'review'; await f.rt.snapshots.refresh();
  await assert.rejects(claimBead(f.rt, f.actor(), { bead_id: 'b' }), /limit/);
});

test('capacity is the union of actual work, open reviews and all reservations including missing targets', async () => {
  const f = fixture(3);
  f.live.a.assignee = 'aw:queen'; f.live.a.status = 'in_progress';
  f.doc().reviews.r = { id: 'r', workBeadId: 'a', cellId: 'cell', state: 'in_review' };
  f.doc().workerLaunches.rev = { id: 'rev', beadId: 'a', state: 'uncertain' };
  f.doc().workerLaunches.missing = { id: 'missing', beadId: 'missing', state: 'reserved' };
  f.doc().operations.claim = { id: 'claim', kind: 'claim', state: 'pending', intent: { beadId: 'missing' } };
  await f.rt.snapshots.refresh();
  assert.deepEqual(capacity(f.rt), { limit: 3, unlimited: false, claimed: 1, reserved: 1, used: 2, available: 1 });
});

test('an uncertain reviewer launch keeps its wait and reservation and only explicit reconciliation permits replacement', async () => {
  const f = fixture(1); reviewFixture(f); await dispatchFixture(f);
  const spawn = f.host.sessions.spawn;
  f.host.sessions.spawn = async () => { throw new Error('startup unavailable'); };
  await assert.rejects(reviews.requestReview(f.rt, f.host, f.actor(), { bead_id: 'a', intent: 'review' }), /remains a wait/);
  const record = Object.values(f.doc().reviews)[0];
  assert.equal(record.state, 'requested');
  assert.equal(capacity(f.rt).used, 1);
  await assert.rejects(reviews.requestReview(f.rt, f.host, f.actor(), { bead_id: 'a', intent: 'review again' }), /unsettled/);
  await workers.reconcileWorkerLaunch(f.rt, f.host, f.actor(), { launch_id: record.launchId, abandon: true, reason: 'no process started' });
  f.host.sessions.spawn = spawn;
  const replacement = await reviews.requestReview(f.rt, f.host, f.actor(), { bead_id: 'a', intent: 'retry review' });
  assert.equal(replacement.review_id, record.id);
  assert.equal(Object.keys(f.doc().reviews).length, 1);
});

test('archive recovery leaves a pending wait, fences the stale reviewer and allows a deliberate replacement', async () => {
  const f = fixture(1); reviewFixture(f); await dispatchFixture(f); archiveFixture(f);
  await claimBead(f.rt, f.actor(), { bead_id: 'a' });
  const first = await reviews.requestReview(f.rt, f.host, f.actor(), { bead_id: 'a', intent: 'review' });
  f.board.get(first.session_id).archived = true;
  await archival.onArchive({ sessionId: first.session_id, host: f.host });
  assert.equal(f.doc().reviews[first.review_id].state, 'requested');
  assert.equal(f.live.a.assignee, 'aw:queen');
  assert.equal(capacity(f.rt).used, 1);
  f.board.get(first.session_id).archived = false;
  const payload = { sid: first.session_id, task: { id: 'task' }, reason: 'resume', host: f.host };
  assert.match((await workers.workerLaunchContext(payload))?.refuse || '', /archived|replaced|reviewer/);
  await assert.rejects(reviews.reviewVerdict(f.rt, f.host, f.actor(first.session_id), { bead_id: 'a', verdict: 'approved', summary: 'late' }), /reviewer/);
  const next = await reviews.requestReview(f.rt, f.host, f.actor(), { bead_id: 'a', intent: 'replace' });
  assert.equal(next.review_id, first.review_id);
  assert.notEqual(next.session_id, first.session_id);
  assert.equal(f.doc().reviews[first.review_id].reviewerSessionId, next.session_id);
  assert.match((await workers.workerLaunchContext(payload))?.refuse || '', /replaced|reviewer/);
});

test('only a coordinator may cancel, cancellation is explicit and fences verdict and relaunch without changing work', async () => {
  const f = fixture(1); reviewFixture(f); await dispatchFixture(f);
  await claimBead(f.rt, f.actor(), { bead_id: 'a' });
  const out = await reviews.requestReview(f.rt, f.host, f.actor(), { bead_id: 'a', intent: 'review' });
  const args = { bead_id: 'a', reason: 'Target replaced' };
  await assert.rejects(reviews.cancelReview(f.rt, f.host, f.actor(out.session_id), args), /queen|coordinator/);
  await reviews.cancelReview(f.rt, f.host, f.actor(), args);
  assert.equal(f.doc().reviews[out.review_id].state, 'cancelled');
  assert.equal(f.live.a.assignee, 'aw:queen'); assert.equal(f.live.a.status, 'in_progress');
  assert.equal(f.live.a.metadata.hive_evidence, undefined);
  await assert.rejects(reviews.reviewVerdict(f.rt, f.host, f.actor(out.session_id), { bead_id: 'a', verdict: 'approved', summary: 'late' }), /reviewer/);
  assert.match((await workers.workerLaunchContext({ sid: out.session_id, task: { id: 'task' }, reason: 'message', host: f.host }))?.refuse || '', /cancelled|stale/);
  const next = await reviews.requestReview(f.rt, f.host, f.actor(), { bead_id: 'a', intent: 'new review' });
  assert.notEqual(next.review_id, out.review_id);
});

test('lost verdict receipt is recovered once from evidence without another write or an invented verdict', async () => {
  const f = fixture(1); reviewFixture(f); await dispatchFixture(f);
  const out = await reviews.requestReview(f.rt, f.host, f.actor(), { bead_id: 'a', intent: 'review' });
  const update = f.rt.beads.update; let writes = 0;
  f.rt.beads.update = async (...args) => { writes++; await update(...args); throw Object.assign(new Error('receipt lost'), { code: 'uncertain' }); };
  const args = { bead_id: 'a', verdict: 'approved', summary: 'Checks pass' };
  await assert.rejects(reviews.reviewVerdict(f.rt, f.host, f.actor(out.session_id), args), /receipt lost/);
  await reviews.recoverReviews(f.rt, f.host);
  await reviews.reviewVerdict(f.rt, f.host, f.actor(out.session_id), args);
  assert.equal(writes, 1); assert.equal(f.live.a.metadata.hive_evidence.length, 1);
  assert.equal(f.doc().reviews[out.review_id].state, 'approved');
  assert.equal(Object.values(f.doc().operations).find((op) => op.kind === 'review-verdict').state, 'applied');
});

test('an unconfirmed verdict is never replayed and cannot be silently cancelled', async () => {
  const f = fixture(1); reviewFixture(f); await dispatchFixture(f);
  const out = await reviews.requestReview(f.rt, f.host, f.actor(), { bead_id: 'a', intent: 'review' });
  let writes = 0; f.rt.beads.update = async () => { writes++; throw Object.assign(new Error('timeout'), { code: 'uncertain' }); };
  const args = { bead_id: 'a', verdict: 'approved', summary: 'Checks pass' };
  await assert.rejects(reviews.reviewVerdict(f.rt, f.host, f.actor(out.session_id), args), /timeout/);
  await assert.rejects(reviews.reviewVerdict(f.rt, f.host, f.actor(out.session_id), args), /unsettled/);
  await assert.rejects(reviews.cancelReview(f.rt, f.host, f.actor(), { bead_id: 'a', reason: 'skip' }), /pending verdict/);
  assert.equal(writes, 1); assert.equal(f.doc().reviews[out.review_id].state, 'in_review');
});

test('a reviewer unbound at the final export cannot record a verdict', async () => {
  const f = fixture(1); reviewFixture(f); await dispatchFixture(f);
  const out = await reviews.requestReview(f.rt, f.host, f.actor(), { bead_id: 'a', intent: 'review' });
  const update = f.rt.beads.update;
  f.rt.beads.update = async (...args) => { f.doc().bindings.cell.find((b) => b.reviewId === out.review_id).active = false; return update(...args); };
  await assert.rejects(reviews.reviewVerdict(f.rt, f.host, f.actor(out.session_id), { bead_id: 'a', verdict: 'approved', summary: 'pass' }), /changed/);
  assert.equal(f.live.a.metadata.hive_evidence, undefined);
  await reviews.cancelReview(f.rt, f.host, f.actor(), { bead_id: 'a', reason: 'Reviewer removed' });
  assert.equal(f.doc().reviews[out.review_id].state, 'cancelled');
});

test('context and map project the review wait on the work bead and track reviewer activity without owner drift', async () => {
  const { buildContext } = await import('../server/tools.js');
  const { projectForGraph } = await import('../server/projection.js');
  const { primaryKind, beadTile } = await import('../public/cell-view.js');
  const f = fixture(1); reviewFixture(f); await dispatchFixture(f);
  const out = await reviews.requestReview(f.rt, f.host, f.actor(), { bead_id: 'a', intent: 'Review races' });
  f.live.a.status = 'in_progress'; await f.rt.snapshots.refresh();
  const projected = () => projectForGraph({ runtime: f.rt, snapshot: { graph: f.rt.snapshots.graph, revision: 1 } });
  const context = await buildContext(f.rt, f.host, { ...f.actor(out.session_id), role: 'worker' }, { bead_id: 'a' });
  f.rt.paths = { beadsWorkspace: '/temporary-test-store' };
  assert.equal(context.focus.reviewState, 'in_review');
  assert.equal(context.focus.waiting_for_review, true);
  assert.equal(context.attention.reviews_awaiting_verdict.length, 1);
  assert(!context.attention.untracked_beads.some((b) => b.bead_id === 'a'));
  assert(!context.attention.untracked_sessions.some((s) => s.session_id === out.session_id));
  let hive = projected();
  assert.equal(Object.keys(hive.beads).length, 5);
  assert.equal(primaryKind(hive.beads.a, [], []), 'review-working');
  const workingTile = beadTile({ hive, graph: { sessions: [...f.board.values()] } }, hive.beads.a, { cellId: 'cell', x: 0, y: 0, layout: { groupHeads: [], parentHead: {}, halo: {}, rootId: 'root' } }, new Map());
  for (const text of [workingTile.title, workingTile.mark.title, workingTile.ariaLabel]) assert.match(text, /Review races/);
  f.board.get(out.session_id).status = 'idle';
  hive = projected();
  assert.equal(primaryKind(hive.beads.a, [], []), 'review-pending');
  assert.equal(primaryKind(hive.beads.a, [], ['needs']), 'person');
  const tile = beadTile({ hive, graph: { sessions: [...f.board.values()] } }, hive.beads.a, { cellId: 'cell', x: 0, y: 0, layout: { groupHeads: [], parentHead: {}, halo: {}, rootId: 'root' } }, new Map());
  assert.match(tile.ariaLabel, /review pending/i);
  assert.equal(tile.mark.kind, 'review-pending');
  for (const text of [tile.title, tile.mark.title, tile.ariaLabel]) assert.match(text, /Review races/);
  f.board.get(out.session_id).archived = true;
  hive = projected();
  assert.equal(hive.beads.a.reviewState, 'requested');
  assert.equal(primaryKind(hive.beads.a, [], []), 'review-pending');
});

test('review marks have rendered glyphs and both states appear in the map Key', async (t) => {
  const { legend } = await import('../public/cell-view.js');
  const { primaryMark } = await import('../public/hex-grid.js');
  const previousDocument = globalThis.document; const previousNode = globalThis.Node;
  class Element {
    constructor(text = '') { this.text = text; this.children = []; this.attributes = {}; this.dataset = {}; this.style = {}; }
    setAttribute(k, v) { this.attributes[k] = v; }
    append(child) { this.children.push(child); }
    addEventListener() {}
  }
  globalThis.Node = Element;
  globalThis.document = { createElement: () => new Element(), createElementNS: () => new Element(), createTextNode: (text) => new Element(text) };
  t.after(() => { globalThis.document = previousDocument; globalThis.Node = previousNode; });
  const words = (node) => node.text + node.children.map(words).join(' ');
  assert(primaryMark('review-working', 'Reviewer working'));
  assert(primaryMark('review-pending', 'Review pending'));
  assert.match(words(legend()), /reviewer working/);
  assert.match(words(legend()), /review pending/);
});

test('a review request respects an unsettled status-preserving release', async () => {
  const f = fixture(1); reviewFixture(f); await dispatchFixture(f);
  f.doc().operations.release = { id: 'release', kind: 'release', cellId: 'cell', state: 'uncertain', intent: { beadId: 'a', holder: 'aw:queen', priorStatus: 'in_progress', status: 'in_progress' } };
  await assert.rejects(reviews.requestReview(f.rt, f.host, f.actor(), { bead_id: 'a', intent: 'review' }), /must be reconciled/);
  assert.equal(Object.keys(f.doc().reviews).length, 0);
});

test('a concurrent review request and generic finish cannot leave closed work with an open review', async () => {
  const { finishBead } = await import('../server/ops.js');
  const f = fixture(1); reviewFixture(f); await dispatchFixture(f);
  f.rt.beads.close = async (id) => { f.live[id].status = 'closed'; };
  const results = await Promise.allSettled([
    reviews.requestReview(f.rt, f.host, f.actor(), { bead_id: 'a', intent: 'review' }),
    finishBead(f.rt, f.actor(), { bead_id: 'a', outcome: 'done', summary: 'finished' }),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert(!(f.live.a.status === 'closed' && Object.values(f.doc().reviews).some((r) => ['requested', 'in_review'].includes(r.state))));
});

test('launch reconciliation cannot reactivate a reviewer cancelled during its queued read', async () => {
  const f = fixture(1); reviewFixture(f); await dispatchFixture(f);
  const out = await reviews.requestReview(f.rt, f.host, f.actor(), { bead_id: 'a', intent: 'review' });
  f.doc().workerLaunches[out.launch_id].state = 'uncertain';
  const show = f.rt.beads.show; let once = true;
  f.rt.beads.show = async (id) => {
    if (once) { once = false; await reviews.cancelReview(f.rt, f.host, f.actor(), { bead_id: 'a', reason: 'cancelled during reconciliation' }); }
    return show(id);
  };
  const result = await workers.reconcileWorkerLaunch(f.rt, f.host, f.actor(), { launch_id: out.launch_id });
  assert.equal(result.state, 'cancelled');
  assert.equal(f.doc().workerLaunches[out.launch_id].state, 'cancelled');
  assert(f.doc().bindings.cell.filter((b) => b.reviewId === out.review_id).every((b) => !b.active));
});

test('reviewer startup rechecks coordinator authority after a delayed snapshot read', async () => {
  const f = fixture(1); reviewFixture(f);
  f.host.sessions.spawn = async (opts) => {
    workers.workerBeforeDispatch({ sessionId: 'reviewer', ext: opts.ext.hive, host: f.host });
    const refresh = f.rt.snapshots.refresh;
    f.rt.snapshots.refresh = async () => { const out = await refresh(); f.doc().cells.cell.queenSessionId = 'replacement'; return out; };
    const result = await workers.workerLaunchContext({ sid: 'reviewer', task: { id: 'task' }, reason: 'spawn', host: f.host });
    assert.match(result?.refuse || '', /queen|coordinator/);
    throw new Error(result.refuse);
  };
  await assert.rejects(reviews.requestReview(f.rt, f.host, f.actor(), { bead_id: 'a', intent: 'review' }), /queen|coordinator/);
  assert.equal(Object.values(f.doc().reviews)[0].reviewerSessionId, null);
});

test('a disappeared reviewer cannot give a verdict through its retained binding', async () => {
  const f = fixture(1); reviewFixture(f); await dispatchFixture(f);
  const out = await reviews.requestReview(f.rt, f.host, f.actor(), { bead_id: 'a', intent: 'review' });
  f.board.delete(out.session_id);
  await assert.rejects(reviews.reviewVerdict(f.rt, f.host, f.actor(out.session_id), { bead_id: 'a', verdict: 'approved', summary: 'late' }), /reviewer/);
  assert.equal(f.live.a.metadata.hive_evidence, undefined);
});

test('review admission cannot deadlock a same-bead status update or later cross-cell claims', async (t) => {
  const f = fixture(8); reviewFixture(f); await dispatchFixture(f);
  const update = f.rt.beads.update;
  f.rt.beads.update = async (id, patch, ...args) => { await update(id, patch, ...args); if (patch.status) f.live[id].status = patch.status; };
  let entered; let release;
  const reachedSnapshot = new Promise((resolve) => { entered = resolve; });
  const snapshotGate = new Promise((resolve) => { release = resolve; });
  const refresh = f.rt.snapshots.refresh; let pause = true;
  f.rt.snapshots.refresh = async () => {
    if (pause) { pause = false; entered(); await snapshotGate; }
    return refresh();
  };
  const request = reviews.requestReview(f.rt, f.host, f.actor(), { bead_id: 'a', intent: 'review' });
  await reachedSnapshot;
  const status = updateBead(f.rt, f.actor(), { bead_id: 'a', status: 'blocked' });
  await new Promise(setImmediate);
  const otherCell = claimBead(f.rt, f.actor('queen2', 'other'), { bead_id: 'c' });
  release();
  let timer;
  t.after(() => clearTimeout(timer));
  await Promise.race([
    Promise.all([request, status, otherCell]),
    new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('Review, status update and cross-cell admission deadlocked')), 1000); }),
  ]);
  assert.equal(f.live.a.status, 'blocked');
  assert.equal(f.live.c.assignee, 'aw:queen2');
  assert.equal(Object.values(f.doc().reviews)[0].state, 'in_review');
});

test('worker relaunch releases admission before taking the bead lock needed by a competing update', async (t) => {
  const f = fixture(8); reviewFixture(f); await dispatchFixture(f);
  await workers.spawnWorker(f.rt, f.host, f.actor(), { bead_id: 'a', intent: 'build' });
  let entered; let release;
  const reachedSnapshot = new Promise((resolve) => { entered = resolve; });
  const snapshotGate = new Promise((resolve) => { release = resolve; });
  const refresh = f.rt.snapshots.refresh; let pause = true;
  f.rt.snapshots.refresh = async () => { if (pause) { pause = false; entered(); await snapshotGate; } return refresh(); };
  const resume = workers.workerLaunchContext({ sid: 'worker-1', task: { id: 'task' }, reason: 'resume', host: f.host });
  await reachedSnapshot;
  const status = updateBead(f.rt, f.actor(), { bead_id: 'a', status: 'blocked' });
  await new Promise(setImmediate);
  const otherCell = claimBead(f.rt, f.actor('queen2', 'other'), { bead_id: 'c' });
  release();
  let timer; t.after(() => clearTimeout(timer));
  const results = await Promise.race([
    Promise.all([resume, status, otherCell]),
    new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('Worker relaunch deadlocked admission')), 1000); }),
  ]);
  assert.equal(results[0]?.refuse, undefined);
  assert.equal(f.live.a.assignee, 'aw:worker-1');
  assert.equal(f.live.c.assignee, 'aw:queen2');
});

test('archive cleanup takes admission only after releasing the bead lock, allowing competing updates and claims', async (t) => {
  const f = fixture(8); reviewFixture(f); archiveFixture(f);
  f.live.a.assignee = 'aw:builder'; f.live.a.status = 'in_progress'; await f.rt.snapshots.refresh();
  let entered; let release;
  const reachedRelease = new Promise((resolve) => { entered = resolve; });
  const releaseGate = new Promise((resolve) => { release = resolve; });
  const nativeRelease = f.rt.beads.release;
  f.rt.beads.release = async (...args) => { entered(); await releaseGate; return nativeRelease(...args); };
  const cleanup = archival.releaseArchivedClaims(f.rt, f.host, 'builder');
  await reachedRelease;
  const status = updateBead(f.rt, f.actor(), { bead_id: 'a', status: 'blocked' });
  await new Promise(setImmediate);
  const otherCell = claimBead(f.rt, f.actor('queen2', 'other'), { bead_id: 'c' });
  release();
  let timer; t.after(() => clearTimeout(timer));
  await Promise.race([
    Promise.all([cleanup, status, otherCell]),
    new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('Archive cleanup deadlocked admission')), 1000); }),
  ]);
  assert.equal(f.live.a.assignee, null);
  assert.equal(f.live.c.assignee, 'aw:queen2');
});

function incompleteAdmissionFixture(f) {
  f.live.a.assignee = 'aw:queen'; f.live.a.status = 'in_progress';
  const partial = () => buildGraph(Object.values(f.live).filter((b) => b.id !== 'a'));
  f.rt.snapshots.refresh = async () => { f.rt.snapshots.graph = partial(); return f.rt.snapshots.current; };
  f.rt.beads.loadSnapshot = async ({ all = false } = {}) => {
    if (all) throw Object.assign(new Error('Cannot read ownership from an incomplete Beads export.'), { code: 'refused' });
    return partial();
  };
}

test('review request refuses a partial display export before recording or launching another work slot', async () => {
  const f = fixture(1); reviewFixture(f); await dispatchFixture(f); incompleteAdmissionFixture(f);
  await assert.rejects(reviews.requestReview(f.rt, f.host, f.actor(), { bead_id: 'b', intent: 'review' }), /incomplete/);
  assert.equal(Object.keys(f.doc().reviews).length, 0);
  assert.equal(Object.keys(f.doc().workerLaunches).length, 0);
  assert.equal(f.live.a.assignee, 'aw:queen');
});

test('worker spawn preflight refuses a partial display export before reserving or dispatching', async () => {
  const f = fixture(1); await dispatchFixture(f); incompleteAdmissionFixture(f);
  await assert.rejects(workers.spawnWorker(f.rt, f.host, f.actor(), { bead_id: 'b', intent: 'build' }), /incomplete/);
  assert.equal(Object.keys(f.doc().workerLaunches).length, 0);
  assert.equal(f.live.b.assignee, null);
});

for (const role of ['worker', 'reviewer']) test(`${role} startup refuses a partial export before claim or binding`, async () => {
  const f = fixture(1); incompleteAdmissionFixture(f);
  f.doc().workerLaunches.launch = { id: 'launch', cellId: 'cell', taskId: 'task', beadId: 'b', requestedBy: 'queen', sessionId: 'new-session', state: 'binding', role, ...(role === 'reviewer' ? { reviewId: 'review' } : {}) };
  if (role === 'reviewer') f.doc().reviews.review = { id: 'review', workBeadId: 'b', cellId: 'cell', state: 'requested', launchId: 'launch', reviewerSessionId: null };
  const claim = f.rt.beads.claim; let attemptedClaim = false;
  f.rt.beads.claim = async (...args) => { attemptedClaim = true; return claim(...args); };
  const out = await workers.workerLaunchContext({ sid: 'new-session', task: { id: 'task' }, reason: 'spawn', host: f.host });
  assert.match(out?.refuse || '', /incomplete/);
  assert.equal(attemptedClaim, false);
  assert.equal((f.doc().bindings.cell || []).length, 0);
  assert.equal(f.doc().reviews.review?.reviewerSessionId || null, null);
});

test('an unbound reviewer cannot forge recovery evidence after a definitely refused verdict', async () => {
  const f = fixture(1); reviewFixture(f); await dispatchFixture(f);
  const out = await reviews.requestReview(f.rt, f.host, f.actor(), { bead_id: 'a', intent: 'review' });
  const update = f.rt.beads.update;
  f.rt.beads.update = async (...args) => { f.doc().bindings.cell.find((b) => b.reviewId === out.review_id).active = false; return update(...args); };
  await assert.rejects(reviews.reviewVerdict(f.rt, f.host, f.actor(out.session_id), { bead_id: 'a', verdict: 'approved', summary: 'Forged approval' }), /changed/);
  f.rt.beads.update = update;
  let refused;
  try { await updateBead(f.rt, f.actor(out.session_id), { bead_id: 'a', add_evidence: [{ label: `Review ${out.review_id}: approved`, kind: 'review', detail: 'Forged approval' }] }); }
  catch (err) { refused = err; }
  await reviews.recoverReviews(f.rt, f.host);
  assert.equal(f.doc().reviews[out.review_id].state, 'in_review');
  assert.equal(f.doc().reviews[out.review_id].verdict, undefined);
  assert.match(refused?.message || '', /reserved/);
});

test('failed verdict intent is cleared before even preexisting matching evidence is considered', async () => {
  const f = fixture(1); reviewFixture(f); await dispatchFixture(f);
  const out = await reviews.requestReview(f.rt, f.host, f.actor(), { bead_id: 'a', intent: 'review' });
  const record = f.doc().reviews[out.review_id];
  record.verdictOpId = 'failed'; record.verdict = { by: out.session_id, value: 'approved', summary: 'Forged approval', at: Date.now() };
  f.doc().operations.failed = { id: 'failed', kind: 'review-verdict', actor: actorFor(out.session_id), beadIds: ['a'], state: 'error' };
  f.live.a.metadata.hive_evidence = [{ label: `Review ${out.review_id}: approved`, by: actorFor(out.session_id), detail: 'Forged approval' }];
  await reviews.recoverReviews(f.rt, f.host);
  assert.equal(f.doc().reviews[out.review_id].state, 'in_review');
  assert.equal(f.doc().reviews[out.review_id].verdict, undefined);
});

test('recovery requires a managed verdict operation for the same work and reviewer', async () => {
  const f = fixture(1); reviewFixture(f); await dispatchFixture(f);
  const out = await reviews.requestReview(f.rt, f.host, f.actor(), { bead_id: 'a', intent: 'review' });
  const record = f.doc().reviews[out.review_id];
  record.verdictOpId = 'unrelated'; record.verdict = { by: out.session_id, value: 'approved', summary: 'Forged approval', at: Date.now() };
  f.doc().operations.unrelated = { id: 'unrelated', kind: 'update-bead', actor: actorFor(out.session_id), beadIds: ['a'], state: 'applied' };
  f.live.a.metadata.hive_evidence = [{ label: `Review ${out.review_id}: approved`, by: actorFor(out.session_id), detail: 'Forged approval' }];
  await reviews.recoverReviews(f.rt, f.host);
  assert.equal(f.doc().reviews[out.review_id].state, 'in_review');
});

test('ordinary evidence input reserves managed review labels for verdict receipts', async () => {
  const { evidenceInput } = await import('../server/ops.js');
  assert.throws(() => evidenceInput([{ label: 'Review review_123456789abc: approved' }], 'aw:worker'), /reserved/);
  assert.equal(evidenceInput([{ label: 'PR review findings', detail: 'Useful notes' }], 'aw:worker').length, 1);
});

for (const phase of ['spawn', 'gate']) test(`review cancellation during the ${phase} strict read cannot resurrect a launch or consume capacity`, async () => {
  const f = fixture(1); reviewFixture(f); await dispatchFixture(f);
  const load = f.rt.beads.loadSnapshot; let reads = 0; let calls = 0; let beforeCancel;
  const spawn = f.host.sessions.spawn;
  f.host.sessions.spawn = async (...args) => { calls++; return spawn(...args); };
  f.rt.beads.loadSnapshot = async (options) => {
    if (options?.all && ++reads === (phase === 'spawn' ? 2 : 3)) {
      beforeCancel = structuredClone(Object.values(f.doc().reviews)[0]);
      await reviews.cancelReview(f.rt, f.host, f.actor(), { bead_id: 'a', reason: 'Cancel during strict export' });
    }
    return load(options);
  };
  await assert.rejects(reviews.requestReview(f.rt, f.host, f.actor(), { bead_id: 'a', intent: 'review' }), /review|launch/i);
  await reviews.recoverReviews(f.rt, f.host);
  const record = Object.values(f.doc().reviews)[0];
  assert.equal(record.state, 'cancelled');
  assert.equal(record.launchId, beforeCancel.launchId);
  assert.equal(record.reviewerSessionId, null);
  assert.equal(capacity(f.rt).used, 0);
  assert.equal(capacity(f.rt).available, 1);
  if (phase === 'spawn') { assert.equal(calls, 0); assert.equal(Object.keys(f.doc().workerLaunches).length, 0); }
  else { assert.equal(calls, 1); assert.equal(f.doc().workerLaunches[record.launchId].state, 'cancelled'); }
  assert(Object.values(f.doc().bindings).flat().every((b) => !b.active));
});

for (const phase of ['spawn', 'gate']) test(`reviewer ${phase} rechecks requester authority after its strict read`, async () => {
  const f = fixture(1); reviewFixture(f); await dispatchFixture(f);
  const load = f.rt.beads.loadSnapshot; let reads = 0; let calls = 0;
  const spawn = f.host.sessions.spawn;
  f.host.sessions.spawn = async (...args) => { calls++; return spawn(...args); };
  f.rt.beads.loadSnapshot = async (options) => {
    if (options?.all && ++reads === (phase === 'spawn' ? 2 : 3)) f.doc().cells.cell.queenSessionId = 'replacement';
    return load(options);
  };
  await assert.rejects(reviews.requestReview(f.rt, f.host, f.actor(), { bead_id: 'a', intent: 'review' }), /queen|coordinator/);
  const record = Object.values(f.doc().reviews)[0];
  assert.equal(record.reviewerSessionId, null);
  if (phase === 'spawn') { assert.equal(calls, 0); assert.equal(Object.keys(f.doc().workerLaunches).length, 0); }
  else assert.notEqual(f.doc().workerLaunches[record.launchId].claimStarted, true);
});

test('a completed review at the admission/binding boundary leaves no uncertain reservation', async () => {
  const f = fixture(1); reviewFixture(f); await dispatchFixture(f);
  const out = await reviews.requestReview(f.rt, f.host, f.actor(), { bead_id: 'a', intent: 'review' });
  const mutate = f.rt.metadata.mutate; let completed = false;
  f.rt.metadata.mutate = (fn) => {
    const result = mutate(fn);
    if (!completed && f.doc().workerLaunches[out.launch_id].state === 'binding') {
      completed = true;
      mutate((d) => { d.reviews[out.review_id].state = 'approved'; });
    }
    return result;
  };
  const result = await workers.workerLaunchContext({ sid: out.session_id, task: { id: 'task' }, reason: 'resume', host: f.host });
  assert.match(result?.refuse || '', /reviewer|review/);
  assert.equal(f.doc().reviews[out.review_id].state, 'approved');
  assert.equal(capacity(f.rt).used, 0);
});

test('cancellation after reservation but before dispatch prevents the host spawn', async () => {
  const f = fixture(1); reviewFixture(f); await dispatchFixture(f);
  const mutate = f.rt.metadata.mutate; let cancel; let calls = 0;
  const spawn = f.host.sessions.spawn;
  f.host.sessions.spawn = async (...args) => { calls++; return spawn(...args); };
  f.rt.metadata.mutate = (fn) => {
    const result = mutate(fn);
    if (!cancel && Object.values(f.doc().workerLaunches).some((l) => l.state === 'reserved')) {
      cancel = reviews.cancelReview(f.rt, f.host, f.actor(), { bead_id: 'a', reason: 'Cancel before dispatch' });
    }
    return result;
  };
  await assert.rejects(reviews.requestReview(f.rt, f.host, f.actor(), { bead_id: 'a', intent: 'review' }), /cancelled/);
  await cancel;
  assert.equal(calls, 0);
  assert.equal(Object.values(f.doc().workerLaunches)[0].state, 'cancelled');
  assert.equal(capacity(f.rt).used, 0);
});

test('authority lost after reservation retires a definitely undispatched launch without uncertainty', async () => {
  const f = fixture(1); reviewFixture(f); await dispatchFixture(f);
  const mutate = f.rt.metadata.mutate; let changed = false; let calls = 0;
  f.host.sessions.spawn = async () => { calls++; throw new Error('must not dispatch'); };
  f.rt.metadata.mutate = (fn) => {
    const result = mutate(fn);
    if (!changed && Object.values(f.doc().workerLaunches).some((l) => l.state === 'reserved')) {
      changed = true; mutate((d) => { d.cells.cell.queenSessionId = 'replacement'; });
    }
    return result;
  };
  await assert.rejects(reviews.requestReview(f.rt, f.host, f.actor(), { bead_id: 'a', intent: 'review' }), /queen|coordinator/);
  assert.equal(calls, 0);
  assert.equal(Object.values(f.doc().workerLaunches)[0].state, 'refused');
  assert.equal(Object.values(f.doc().reviews)[0].state, 'requested');
});

test('worker reservation publishes capacity before an asynchronous launch completes', async () => {
  const f = fixture();
  const observations = [];
  f.rt.changed = () => observations.push(capacity(f.rt).used);
  let enter, fail;
  const entered = new Promise(resolve => { enter = resolve; });
  f.host.sessions.spawn = () => { enter(); return new Promise((resolve, reject) => { fail = reject; }); };
  const pending = workers.spawnWorker(f.rt, f.host, f.actor(), { bead_id: 'a', intent: 'build' }).catch(e => e);
  await entered;
  const duringLaunch = [...observations];
  fail(new Error('synthetic uncertain launch'));
  await pending;
  assert.ok(duringLaunch.includes(1), 'the reserved slot is broadcast while spawn is still pending');
});

test('a pending claim publishes its reserved slot before the Beads write completes', async () => {
  const f = fixture();
  const observations = [];
  f.rt.changed = () => observations.push(capacity(f.rt).used);
  let enter, fail;
  const entered = new Promise(resolve => { enter = resolve; });
  f.rt.beads.claim = () => { enter(); return new Promise((resolve, reject) => { fail = reject; }); };
  const pending = claimBead(f.rt, f.actor(), { bead_id: 'a' }).catch(e => e);
  await entered;
  const duringClaim = [...observations];
  fail(new Error('synthetic failed claim'));
  await pending;
  assert.ok(duringClaim.includes(1), 'the claim reservation is broadcast before its write finishes');
});

import { resolveCaller } from '../server/access.js';
import { buildContext } from '../server/tools.js';
function statusFixture() {
  const f = fixture(0);
  f.board.set('worker', { sessionId: 'worker', taskId: 'task', status: 'working' });
  f.board.set('coordinator', { sessionId: 'coordinator', taskId: 'task', status: 'working' });
  f.doc().bindings.cell = [{ sessionId: 'coordinator', beadId: 'b', role: 'coordinator', active: true }];
  f.rt.beads.update = async (id, patch, who, check) => {
    check?.({ issues: Object.values(f.live), errors: [] });
    if (patch.status !== undefined) f.live[id].status = patch.status;
    if (patch.waitingFor !== undefined) f.live[id].metadata.hive_waiting_for = patch.waitingFor;
  };
  return f;
}

function externalFixture() {
  const f = fixture(1);
  f.rt.beads.createMany = async ({ nodes, edges }) => {
    const ids = Object.fromEntries(nodes.map(n => [n.key, n.key]));
    for (const n of nodes) f.live[n.key] = raw(n.key, n.parentId || ids[n.parentKey], { title: n.title, metadata: { hive_kind: n.kind }, status: n.status || 'open' });
    for (const e of edges) f.live[e.fromId || ids[e.fromKey]].dependencies.push({ type: e.type, issue_id: e.fromId || ids[e.fromKey], depends_on_id: e.toId || ids[e.toKey] });
    return { ids };
  };
  f.rt.beads.update = async (id, patch, who, check) => {
    check?.({ issues: Object.values(f.live), errors: [] });
    for (const [key, value] of Object.entries(patch)) {
      if (key === 'kind') f.live[id].metadata.hive_kind = value;
      else if (key === 'evidence') f.live[id].metadata.hive_evidence = value;
      else f.live[id][key] = value;
    }
  };
  f.rt.beads.close = async id => { f.live[id].status = 'closed'; };
  f.addExternal = async () => {
    await createBeads(f.rt, f.actor(), { beads: [{ ref: 'outside', kind: 'external', title: 'Teammate PR approved' }], links: [{ dependent: 'a', prerequisite: 'outside', type: 'blocks' }] });
  };
  return f;
}

for (const caller of ['queen', 'coordinator']) {
  for (const status of ['blocked', 'deferred']) {
    for (const assignee of [null, 'aw:worker']) {
      test(`${caller} can mark ${assignee ? 'worker-owned' : 'unclaimed'} work ${status} without changing its claim`, async () => {
        const f = statusFixture();
        f.live.a.assignee = assignee;
        f.live.a.status = assignee ? 'in_progress' : 'open';
        await f.rt.snapshots.refresh();
        const bindings = structuredClone(f.doc().bindings);
        await updateBead(f.rt, resolveCaller(f.rt, f.host, caller), { bead_id: 'a', status, waiting_for: 'External prerequisite' });
        assert.equal(f.live.a.status, status);
        assert.equal(f.live.a.assignee, assignee);
        assert.deepEqual(f.doc().bindings, bindings);
      });
    }
  }
}

for (const caller of ['queen', 'coordinator', 'worker']) {
  test(`${caller} still needs a claim to start work`, async () => {
    const f = statusFixture();
    for (const status of ['open', 'blocked', 'deferred']) {
      f.live.a.status = status;
      await f.rt.snapshots.refresh();
      await assert.rejects(updateBead(f.rt, resolveCaller(f.rt, f.host, caller), { bead_id: 'a', status: 'in_progress' }), /Claim .*before starting work/);
      assert.equal(f.live.a.status, status);
      assert.equal(f.live.a.assignee, null);
    }
  });

  test(`${caller} cannot update another cell's work`, async () => {
    const f = statusFixture();
    await f.rt.snapshots.refresh();
    for (const status of ['blocked', 'deferred']) {
      await assert.rejects(updateBead(f.rt, resolveCaller(f.rt, f.host, caller), { bead_id: 'c', status }), /do not take part/);
      assert.equal(f.live.c.status, 'open');
    }
  });
}

test('context attention includes every open bead with a recorded wait only in its cell', async () => {
  const f = statusFixture();
  f.live.root.metadata.hive_waiting_for = 'Goal prerequisite';
  f.live.a.metadata.hive_waiting_for = 'External prerequisite';
  f.live.b.status = 'blocked';
  f.live.b.assignee = 'aw:worker';
  f.live.b.metadata.hive_waiting_for = 'Dependency';
  f.live.parked = raw('parked', 'root', { status: 'deferred', metadata: { hive_kind: 'work', hive_waiting_for: 'Later' } });
  f.live.active = raw('active', 'root', { status: 'in_progress', assignee: 'aw:worker', metadata: { hive_kind: 'work', hive_waiting_for: 'Build running' } });
  f.live.empty = raw('empty');
  f.live.closed = raw('closed', 'root', { status: 'closed', metadata: { hive_waiting_for: 'Old wait' } });
  f.live.c.metadata.hive_waiting_for = 'Other cell';
  const out = await buildContext(f.rt, f.host, resolveCaller(f.rt, f.host, 'worker'));
  assert.deepEqual(out.attention.waiting_beads.toSorted((a, b) => a.bead_id.localeCompare(b.bead_id)), [
    { bead_id: 'root', title: 'root', status: 'open', owner_session_id: null, waiting_for: 'Goal prerequisite' },
    { bead_id: 'a', title: 'a', status: 'open', owner_session_id: null, waiting_for: 'External prerequisite' },
    { bead_id: 'b', title: 'b', status: 'blocked', owner_session_id: 'worker', waiting_for: 'Dependency' },
    { bead_id: 'parked', title: 'parked', status: 'deferred', owner_session_id: null, waiting_for: 'Later' },
    { bead_id: 'active', title: 'active', status: 'in_progress', owner_session_id: 'worker', waiting_for: 'Build running' },
  ].toSorted((a, b) => a.bead_id.localeCompare(b.bead_id)));
});

test('external prerequisite blocks real work until the queen closes it', async () => {
  const f = externalFixture();
  await f.addExternal();
  assert.equal(f.rt.snapshots.graph.beads.outside.kind, 'external');
  assert.deepEqual(waitingOn(f.rt, 'a'), ['outside']);
  assert.deepEqual(readyBeads(f.rt, f.actor(), {}).ready.map(b => b.bead_id), ['b']);
  const hive = { ...f.rt.snapshots.graph, cells: { cell: {} } };
  const tile = beadTile({ hive, graph: { sessions: [] } }, hive.beads.a, { cellId: 'cell', layout: { groupHeads: [], parentHead: {}, halo: {} } }, new Map());
  assert.equal(tile.mark.kind, 'waiting');
  await finishBead(f.rt, f.actor(), { bead_id: 'outside', outcome: 'done', summary: 'Approval received' });
  await f.rt.snapshots.refresh();
  assert.deepEqual(waitingOn(f.rt, 'a'), []);
  assert.ok(readyBeads(f.rt, f.actor(), {}).ready.some(b => b.bead_id === 'a'));
  hive.beads = f.rt.snapshots.graph.beads;
  assert.equal(beadTile({ hive, graph: { sessions: [] } }, hive.beads.a, { cellId: 'cell', layout: { groupHeads: [], parentHead: {}, halo: {} } }, new Map()).mark, null);
});

test('external prerequisites refuse claims and worker launches before dispatch', async () => {
  const f = externalFixture();
  await f.addExternal();
  let spawned = false;
  f.host.sessions.spawn = async () => { spawned = true; };
  await assert.rejects(claimBead(f.rt, f.actor(), { bead_id: 'outside' }), /external.*(claim|work)/i);
  await assert.rejects(workers.spawnWorker(f.rt, f.host, f.actor(), { bead_id: 'outside', intent: 'build' }), /external.*(claim|work)/i);
  assert.equal(spawned, false);
  assert.equal(f.live.outside.assignee, null);
  assert.deepEqual(f.doc().workerLaunches, {});
});

test('external kind read at the claim fence refuses a stale work claim', async () => {
  const f = externalFixture();
  f.live.a.metadata.hive_kind = 'external';
  await assert.rejects(claimBead(f.rt, f.actor(), { bead_id: 'a' }), /external.*(claim|work)/i);
  assert.equal(f.live.a.assignee, null);
});

test('legacy external claims and reservations never consume work capacity', async () => {
  const f = externalFixture();
  await f.addExternal();
  f.live.outside.status = 'in_progress';
  f.live.outside.assignee = 'aw:legacy';
  f.rt.metadata.mutate(d => {
    d.workerLaunches.old = { state: 'uncertain', beadId: 'outside' };
    d.operations.old = { kind: 'claim', state: 'pending', intent: { beadId: 'outside' } };
    d.reviews.old = { state: 'in_review', workBeadId: 'outside' };
  });
  await f.rt.snapshots.refresh();
  assert.equal(capacity(f.rt, undefined, { reserve: ['outside'] }).used, 0);
  await claimBead(f.rt, f.actor(), { bead_id: 'b' });
  await f.rt.snapshots.refresh();
  assert.equal(capacity(f.rt).used, 1);
  assert.equal(tracking.isUntracked(f.host, f.rt.snapshots.graph, f.rt.snapshots.graph.beads.outside), false);
});

test('claimed or reserved work cannot be converted to an external prerequisite', async () => {
  const f = externalFixture();
  await claimBead(f.rt, f.actor(), { bead_id: 'a' });
  await assert.rejects(updateBead(f.rt, f.actor(), { bead_id: 'a', kind: 'external' }), /external|release/i);
  f.rt.metadata.mutate(d => { d.workerLaunches.pending = { state: 'reserved', beadId: 'b' }; });
  await assert.rejects(updateBead(f.rt, f.actor(), { bead_id: 'b', kind: 'external' }), /external|reserved/i);
  assert.equal(f.live.a.metadata.hive_kind, 'work');
  assert.equal(f.live.b.metadata.hive_kind, 'work');
});

for (const state of ['pending', 'uncertain', 'partial']) test(`${state} claim reservation prevents external conversion until reconciled`, async () => {
  const f = externalFixture();
  const operation = { id: 'unsettled-claim', kind: 'claim', state, cellId: 'cell', actor: 'aw:queen', beadIds: ['a'], createdAt: 1, updatedAt: 1, intent: { beadId: 'a', assignee: 'aw:queen' } };
  f.rt.metadata.mutate(d => { d.operations[operation.id] = operation; });
  const before = capacity(f.rt);
  assert.equal(before.used, 1);
  await assert.rejects(updateBead(f.rt, f.actor(), { bead_id: 'a', kind: 'external' }), /claim|reconcil|settle/i);
  await f.rt.snapshots.refresh();
  assert.equal(f.live.a.metadata.hive_kind, 'work');
  assert.equal(f.rt.snapshots.graph.beads.a.kind, 'work');
  assert.deepEqual(capacity(f.rt), before);
  assert.deepEqual(f.doc().operations[operation.id], operation);
  await assert.rejects(claimBead(f.rt, f.actor(), { bead_id: 'b' }), /limit|capacity/i);
  await reconcileForAgent(f.rt, f.actor(), { op_id: operation.id, verdict: 'not-applied', note: 'Checked the store: the claim was not applied.' });
  assert.equal(f.doc().operations[operation.id].state, 'resolved');
  await updateBead(f.rt, f.actor(), { bead_id: 'a', kind: 'external' });
  await f.rt.snapshots.refresh();
  assert.equal(f.rt.snapshots.graph.beads.a.kind, 'external');
  assert.equal(capacity(f.rt).used, 0);
  await claimBead(f.rt, f.actor(), { bead_id: 'b' });
});

test('external tile has a labelled hexagonal arrow, dashed rim and normal status priority', () => {
  const external = { id: 'outside', title: 'Vendor approval', kind: 'external', status: 'open' };
  assert.equal(primaryKind(external, [], []), 'external');
  assert.equal(markWords('external', external), 'External prerequisite');
  assert.equal(primaryKind({ ...external, status: 'closed', outcome: 'done' }, [], []), 'done');
  assert.equal(primaryKind(external, ['prereq'], []), 'waiting');
  const hive = { cells: { cell: {} }, beads: { outside: external }, edges: [] };
  const tile = beadTile({ hive, graph: { sessions: [] } }, external, { cellId: 'cell', layout: { groupHeads: [], parentHead: {}, halo: {} } }, new Map());
  assert.match(tile.ariaLabel, /External/);
  assert.match(tile.title, /External/);
  const css = fs.readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.hive-kind-external \.hive-hex-rim\s*\{[^}]*stroke-dasharray:/);
  const source = fs.readFileSync(new URL('../public/hex-grid.js', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '').replaceAll('export ', '');
  const mark = vm.runInNewContext(`${source}\nprimaryMark('external', 'External')`, { h: (tag, attrs, ...children) => ({ tag, attrs, children }), document: undefined });
  assert.equal(mark.children[1].tag, 'svg:path');
  assert.equal(mark.children[1].attrs.class, 'hive-pm-bg');
  assert.match(mark.children[1].attrs.d, /^M.*Z$/);
  assert.match(fs.readFileSync(new URL('../public/cell-view.js', import.meta.url), 'utf8'), /swatch\('is-external', 'External'\)/);
});

test('External key swatch has six clear vertices without changing other swatches', () => {
  const source = fs.readFileSync(new URL('../public/cell-view.js', import.meta.url), 'utf8').replace(/^import [\s\S]*?;\n/gm, '').replaceAll('export ', '');
  const tree = vm.runInNewContext(`${source}\nlegend()`, { hexPath, primaryMark: () => null, h: (tag, attrs, ...children) => ({ tag, attrs, children }) });
  const nodes = [];
  const visit = value => {
    if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') { nodes.push(value); visit(value.children); }
  };
  visit(tree);
  const swatch = kind => nodes.find(n => n.attrs?.class === `hive-legend-hex ${kind}`).children[0];
  assert.equal(swatch('is-external').tag, 'svg:polygon');
  assert.equal(swatch('is-external').attrs.points.trim().split(/\s+/).length, 6);
  assert.equal(swatch('is-done').tag, 'svg:path');
  assert.equal(swatch('is-group').tag, 'svg:path');
});

test('a refused claim tells the worker to raise hive_request_input to the queen', async () => {
  const f = fixture();
  await claimBead(f.rt, f.actor(), { bead_id: 'a' });
  await assert.rejects(claimBead(f.rt, f.actor(), { bead_id: 'b' }), /hive_request_input/);
});

test('deferring takes a review date or prerequisite, validates them and clears them on leaving deferred', async () => {
  const f = fixture(8);
  const patches = [];
  f.rt.beads.update = async (id, patch, who, check) => { check?.({ issues: Object.values(f.live), errors: [] }); patches.push(patch); };
  await updateBead(f.rt, f.actor(), { bead_id: 'a', status: 'deferred', resume_review_at: '2026-12-01', resume_after_bead: 'b' });
  assert.deepEqual(patches.at(-1).resume, { reviewAt: '2026-12-01T00:00:00.000Z', afterBead: 'b' });
  await assert.rejects(updateBead(f.rt, f.actor(), { bead_id: 'a', status: 'deferred', resume_review_at: 'soon' }), /date/);
  await assert.rejects(updateBead(f.rt, f.actor(), { bead_id: 'a', status: 'deferred', resume_review_at: '1' }), /date/);
  await assert.rejects(updateBead(f.rt, f.actor(), { bead_id: 'a', status: 'deferred', resume_after_bead: 'nope' }), /does not exist/);
  await assert.rejects(updateBead(f.rt, f.actor(), { bead_id: 'a', status: 'deferred', resume_after_bead: 'a' }), /itself/);
  await assert.rejects(updateBead(f.rt, f.actor(), { bead_id: 'a', status: 'open', resume_review_at: '2026-12-01' }), /deferred/);
  f.live.a.status = 'deferred'; f.live.a.metadata.hive_resume = JSON.stringify({ reviewAt: '2026-12-01T00:00:00.000Z', afterBead: 'b' });
  await f.rt.snapshots.refresh();
  await updateBead(f.rt, f.actor(), { bead_id: 'a', resume_review_at: '' });
  assert.deepEqual(patches.at(-1).resume, { afterBead: 'b' });
  await updateBead(f.rt, f.actor(), { bead_id: 'a', status: 'open' });
  assert.equal(patches.at(-1).resume, '');
  f.live.a.status = 'in_progress'; await f.rt.snapshots.refresh();
  await updateBead(f.rt, f.actor(), { bead_id: 'a', status: 'deferred' });
  assert.equal(patches.at(-1).resume, '');
  const { normalizeIssue } = await import('../server/bead-model.js');
  assert.deepEqual(normalizeIssue(f.live.a).resume, { reviewAt: '2026-12-01T00:00:00.000Z', afterBead: 'b' });
  assert.equal(normalizeIssue(f.live.b).resume, null);
});

function guardedUpdate(f) {
  f.rt.beads.update = async (id, patch, who, check) => {
    const guard = check?.({ issues: Object.values(f.live), errors: [] });
    if (guard && (f.live[id].assignee !== guard.assignee || f.live[id].status !== guard.status)) throw Object.assign(new Error('guard'), { code: 'conflict' });
    Object.assign(f.live[id], { title: patch.title ?? f.live[id].title });
    f.live[id].updated_at = `t${Date.now()}${Math.random()}`;
    f.calls = [...(f.calls || []), { id, patch, who }];
  };
}

test('the queen edits text fields and evidence on a held and an unclaimed bead without claiming', async () => {
  const f = fixture(8); guardedUpdate(f);
  f.live.a.assignee = 'aw:worker'; f.live.a.status = 'in_progress';
  await f.rt.snapshots.refresh();
  await updateBead(f.rt, f.actor(), { bead_id: 'a', title: 'Corrected', summary: 's', next_action: 'n', waiting_for: 'w', add_evidence: [{ label: 'note', text: 'x' }] });
  await updateBead(f.rt, f.actor(), { bead_id: 'b', title: 'Corrected b', summary: 's' });
  assert.equal(f.live.a.title, 'Corrected');
  assert.equal(f.live.b.title, 'Corrected b');
  assert.equal(f.live.b.assignee, null);
  assert.equal(f.calls[0].who, 'aw:queen');
});

test('queen text edits plus status in_progress on a worker-held bead', async () => {
  const f = fixture(8); guardedUpdate(f);
  f.live.a.assignee = 'aw:worker'; f.live.a.status = 'blocked';
  await f.rt.snapshots.refresh();
  await updateBead(f.rt, f.actor(), { bead_id: 'a', title: 'Corrected', summary: 's', status: 'in_progress' });
  assert.equal(f.live.a.title, 'Corrected');
  f.live.b.status = 'open';
  await f.rt.snapshots.refresh();
  await assert.rejects(updateBead(f.rt, f.actor(), { bead_id: 'b', title: 'Corrected', status: 'in_progress' }), /Claim b with hive_claim_bead before starting work.*status/s);
  assert.equal(f.live.b.title, 'b', 'a refused update changes none of its fields');
});

test('expected_updated_at refuses a stale edit and accepts a current one; omitting it overwrites as before', async () => {
  const f = fixture(8); guardedUpdate(f);
  f.live.a.updated_at = '2026-11-12T10:00:00Z';
  await f.rt.snapshots.refresh();
  await assert.rejects(updateBead(f.rt, f.actor(), { bead_id: 'a', title: 'Stale', expected_updated_at: '2026-11-12T09:00:00Z' }), /changed since/i);
  assert.equal(f.live.a.title, 'a');
  await updateBead(f.rt, f.actor(), { bead_id: 'a', title: 'Current', expected_updated_at: '2026-11-12T10:00:00Z' });
  assert.equal(f.live.a.title, 'Current');
  await updateBead(f.rt, f.actor(), { bead_id: 'a', title: 'Unguarded' });
  assert.equal(f.live.a.title, 'Unguarded');
});

async function dormantWorker(f) {
  await dispatchFixture(f);
  const out = await workers.spawnWorker(f.rt, f.host, f.actor(), { bead_id: 'a', intent: 'build' });
  return out;
}
const restore = (f) => workers.workerLaunchContext({ sid: 'worker-1', task: { id: 'task' }, reason: 'resume', host: f.host });

test('restore accepts a worker whose launch bead is closed but who holds another open claim', async () => {
  const f = fixture(2);
  await dormantWorker(f);
  f.live.b.assignee = 'aw:worker-1'; f.live.b.status = 'in_progress';
  f.live.a.status = 'closed'; f.live.a.assignee = null;
  const result = await restore(f);
  assert.equal(result?.refuse, undefined);
  assert.equal(f.live.b.assignee, 'aw:worker-1');
  assert(Object.values(f.doc().bindings).flat().some((x) => x.sessionId === 'worker-1' && x.beadId === 'b' && x.active));
});

test('restore refuses a worker whose launch bead is closed and who holds no open claim', async () => {
  const f = fixture(2);
  await dormantWorker(f);
  f.live.a.status = 'closed'; f.live.a.assignee = null;
  assert.match((await restore(f))?.refuse || '', /missing or closed/);
});

test('restore ignores a closed claim and an open launch bead is unchanged', async () => {
  const f = fixture(2);
  await dormantWorker(f);
  f.live.b.assignee = 'aw:worker-1'; f.live.b.status = 'closed';
  f.live.a.status = 'closed'; f.live.a.assignee = null;
  assert.match((await restore(f))?.refuse || '', /missing or closed/);
  f.live.a.status = 'in_progress'; f.live.a.assignee = 'aw:worker-1';
  assert.equal((await restore(f))?.refuse, undefined);
  assert(Object.values(f.doc().bindings).flat().some((x) => x.sessionId === 'worker-1' && x.beadId === 'a' && x.active));
});

test('a refused restore names the claim the worker holds and how to clear it', async () => {
  const f = fixture(2);
  await dormantWorker(f);
  f.live.b.assignee = 'aw:worker-1'; f.live.b.status = 'in_progress';
  f.live.a.status = 'closed'; f.live.a.assignee = null;
  f.doc().workerLaunches.rival = { id: 'rival', cellId: 'cell', taskId: 'task', beadId: 'b', state: 'reserved', sessionId: null };
  const refuse = (await restore(f))?.refuse || '';
  assert.match(refuse, /holds an open claim on b/);
  assert.match(refuse, /release it or hand it over/);
});

test('restore ignores a claim held in another cell even when it sorts first', async () => {
  const f = fixture(3);
  await dormantWorker(f);
  f.live['0x'] = raw('0x', 'other-root', { assignee: 'aw:worker-1', status: 'in_progress' });
  f.live.b.assignee = 'aw:worker-1'; f.live.b.status = 'in_progress';
  f.live.a.status = 'closed'; f.live.a.assignee = null;
  assert.equal((await restore(f))?.refuse, undefined);
  assert(Object.values(f.doc().bindings).flat().some((x) => x.sessionId === 'worker-1' && x.beadId === 'b' && x.active));
});

test('restore prefers the held bead that already has an active binding', async () => {
  const f = fixture(3);
  await dormantWorker(f);
  f.live.b.assignee = 'aw:worker-1'; f.live.b.status = 'in_progress';
  f.live.d = raw('d', 'root', { assignee: 'aw:worker-1', status: 'in_progress' });
  f.doc().bindings.cell.push({ id: 'bind-d', sessionId: 'worker-1', beadId: 'd', role: 'worker', active: true });
  f.live.a.status = 'closed'; f.live.a.assignee = null;
  assert.equal((await restore(f))?.refuse, undefined);
  assert.equal(f.live.d.assignee, 'aw:worker-1');
});

test('a restore cannot re-take a held bead the queen released after the snapshot', async () => {
  const f = fixture(2);
  await dormantWorker(f);
  f.live.b.assignee = 'aw:worker-1'; f.live.b.status = 'in_progress';
  f.live.a.status = 'closed'; f.live.a.assignee = null;
  const claim = f.rt.beads.claim;
  f.rt.beads.claim = async (...args) => { f.live.b.assignee = null; f.live.b.status = 'open'; return claim(...args); };
  assert.match((await restore(f))?.refuse || '', /no longer held/);
  assert.equal(f.live.b.assignee, null);
});

test('a restore whose launch bead went to another worker names the claim it still holds', async () => {
  const f = fixture(2);
  await dormantWorker(f);
  f.live.b.assignee = 'aw:worker-1'; f.live.b.status = 'in_progress';
  f.live.a.assignee = 'aw:worker-9';
  assert.equal((await restore(f))?.refuse, undefined);
  assert(Object.values(f.doc().bindings).flat().some((x) => x.sessionId === 'worker-1' && x.beadId === 'b' && x.active));
  assert.equal(f.live.a.assignee, 'aw:worker-9');
});

import { setReviewPolicy, reviewPolicy } from '../server/review-policy.js';
import { attachmentsFor, deriveActivity } from '../server/bead-sessions.js';
import { bindSession } from '../server/ops.js';

function holderFixture(builderAgent = 'codex', limit = 2) {
  const f = fixture(limit); reviewFixture(f);
  f.board.set('builder', { sessionId: 'builder', taskId: 'task', status: 'working', agent: builderAgent });
  f.board.set('other', { sessionId: 'other', taskId: 'task', status: 'working', agent: 'claude' });
  f.live.a.assignee = 'aw:builder'; f.live.a.status = 'in_progress';
  f.rt.snapshots.graph = buildGraph(Object.values(f.live));
  f.sent = []; f.host.deliver = async (sid, text) => { f.sent.push({ sid, text }); return { mode: 'live' }; };
  f.launched = [];
  f.worker = (sid) => ({ sessionId: sid, cell: f.doc().cells.cell, role: 'worker', cells: [{ cell: f.doc().cells.cell, role: 'worker' }] });
  return f;
}
async function launchRecording(f) {
  await dispatchFixture(f);
  const spawn = f.host.sessions.spawn;
  f.host.sessions.spawn = async (opts) => { f.launched.push(opts); const out = await spawn(opts); const s = f.board.get(out.sessionId); s.agent = opts.agent; s.model = opts.model; s.effort = opts.effort; return out; };
}

test('the claim holder spawns its own review on the policy, ignoring its own model choice, and the queen is told', async () => {
  const f = holderFixture('codex'); await launchRecording(f);
  const out = await reviews.requestReview(f.rt, f.host, f.worker('builder'), { bead_id: 'a', intent: 'review', agent: 'codex', model: 'weak', effort: 'low' });
  assert.deepEqual([f.launched[0].agent, f.launched[0].model, f.launched[0].effort], ['claude', 'opus', 'medium']);
  assert.equal(out.policy.sameProvider, false);
  assert.equal(f.doc().reviews[out.review_id].requestedBy, 'builder');
  assert.equal(f.live.a.assignee, 'aw:builder');
  assert(f.sent.some((m) => m.sid === 'queen' && /Review session .* started on a/.test(m.text)));
});

test('a Claude builder gets the secondary reviewer; when neither differs the primary is used and sameProvider is recorded', async () => {
  const f = holderFixture('claude'); await launchRecording(f);
  const out = await reviews.requestReview(f.rt, f.host, f.worker('builder'), { bead_id: 'a', intent: 'review' });
  assert.deepEqual([f.launched[0].agent, f.launched[0].model], ['codex', 'gpt-6.1-sol']);
  assert.equal(out.policy.sameProvider, false);
  const g = holderFixture('claude'); await launchRecording(g);
  setReviewPolicy(g.rt, { cellId: 'cell', policy: { secondary: { agent: 'claude', model: 'sonnet', effort: 'high' } } });
  const same = await reviews.requestReview(g.rt, g.host, g.worker('builder'), { bead_id: 'a', intent: 'review' });
  assert.equal(g.launched[0].model, 'opus');
  assert.equal(same.policy.sameProvider, true);
  assert.equal(g.doc().reviews[same.review_id].policy.sameProvider, true);
});

test('non-holders cannot spawn reviews or helpers and a holder cannot spawn another work session', async () => {
  const f = holderFixture(); await launchRecording(f);
  await assert.rejects(reviews.requestReview(f.rt, f.host, f.worker('other'), { bead_id: 'a', intent: 'review' }), /queen|coordinator|attach/);
  await assert.rejects(workers.spawnWorker(f.rt, f.host, f.worker('other'), { bead_id: 'a', intent: 'help' }, { role: 'investigator' }), /own bead|queen|coordinator|attach/);
  await assert.rejects(workers.spawnWorker(f.rt, f.host, f.worker('builder'), { bead_id: 'a', intent: 'more' }), /queen|coordinator/);
  assert.equal(f.launched.length, 0);
});

test('queen overrides need an override_reason, recorded on the review; terra is refused everywhere', async () => {
  const f = holderFixture(); await launchRecording(f);
  await assert.rejects(reviews.requestReview(f.rt, f.host, f.actor(), { bead_id: 'a', intent: 'review', model: 'sonnet' }), /override_reason/);
  await assert.rejects(reviews.requestReview(f.rt, f.host, f.actor(), { bead_id: 'a', intent: 'review', model: 'gpt-6-terra', override_reason: 'x' }), /Terra/);
  const out = await reviews.requestReview(f.rt, f.host, f.actor(), { bead_id: 'a', intent: 'review', model: 'sonnet', override_reason: 'cheaper check' });
  assert.equal(f.launched[0].model, 'sonnet');
  assert.equal(f.doc().reviews[out.review_id].policy.overrideReason, 'cheaper check');
  assert.throws(() => setReviewPolicy(f.rt, { cellId: 'cell', policy: { primary: { agent: 'codex', model: 'gpt-5.6-terra', effort: 'high' } } }), /Terra/);
  assert.equal(reviewPolicy(f.doc().cells.cell).primary.model, 'opus');
});

test('a claimless helper can no longer share a builder bead or slot through spawn', async () => {
  const f = holderFixture('codex', 1); await launchRecording(f);
  const used = capacity(f.rt).used;
  const before = f.launched.length;
  for (const who of [f.worker('builder'), f.actor()]) await assert.rejects(workers.spawnWorker(f.rt, f.host, who, { bead_id: 'a', intent: 'investigate' }, { role: 'investigator' }), /own bead/);
  assert.equal(f.live.a.assignee, 'aw:builder');
  assert.equal(capacity(f.rt).used, used);
  assert.equal(f.launched.length, before);
});

test('a session started elsewhere is nominated as reviewer by the holder or queen and can give its verdict', async () => {
  const f = holderFixture(); f.board.set('plain', { sessionId: 'plain', taskId: 'task', status: 'working', agent: 'claude' });
  const holder = f.worker('builder');
  await assert.rejects(bindSession(f.rt, f.host, f.worker('other'), { bead_id: 'a', session_id: 'plain', role: 'review' }), /nominate|queen|coordinator/);
  const joined = await bindSession(f.rt, f.host, holder, { bead_id: 'a', session_id: 'plain', role: 'review' });
  assert.equal(joined.role, 'review');
  const rec = f.doc().reviews[joined.review_id];
  assert.equal(rec.state, 'in_review'); assert.equal(rec.reviewerSessionId, 'plain'); assert.equal(rec.policy.joined, true);
  await new Promise((r) => setImmediate(r));
  assert(f.sent.some((m) => m.sid === 'queen' && /joined a/.test(m.text)));
  await assert.rejects(bindSession(f.rt, f.host, holder, { bead_id: 'a', session_id: 'plain', role: 'review' }), /open review/);
  await reviews.reviewVerdict(f.rt, f.host, f.worker('plain'), { bead_id: 'a', verdict: 'changes_requested', summary: 'Fix', commit: 'c1' });
  assert.equal(f.doc().reviews[joined.review_id].state, 'changes_requested');
  assert(f.sent.some((m) => m.sid === 'queen' && /Review verdict on a: changes_requested/.test(m.text)));
});

test('no session can make itself a reviewer, and the holder or anyone who worked on the bead can never review it', async () => {
  const f = holderFixture(); f.board.set('plain', { sessionId: 'plain', taskId: 'task', status: 'working', agent: 'claude' });
  for (const who of [f.worker('other'), f.worker('builder'), f.actor()]) {
    await assert.rejects(bindSession(f.rt, f.host, who, { bead_id: 'a', session_id: who.sessionId, role: 'review' }), /nominate itself/);
  }
  await assert.rejects(bindSession(f.rt, f.host, f.actor(), { bead_id: 'a', session_id: 'builder', role: 'review' }), /own work|worked on/);
  await launchRecording(f);
  f.board.set('helper-s', { sessionId: 'helper-s', taskId: 'task', status: 'working', agent: 'claude' });
  await bindSession(f.rt, f.host, f.worker('builder'), { bead_id: 'a', session_id: 'helper-s', role: 'helper' });
  const helper = { session_id: 'helper-s' };
  await assert.rejects(bindSession(f.rt, f.host, f.worker(helper.session_id), { bead_id: 'a', session_id: helper.session_id, role: 'review' }), /nominate itself/);
  await assert.rejects(bindSession(f.rt, f.host, f.actor(), { bead_id: 'a', session_id: helper.session_id, role: 'review' }), /worked on/);
  assert.equal(Object.values(f.doc().reviews).length, 0);
});

test('a terra session cannot be joined as reviewer, and a padded role still takes the locks and the checks', async () => {
  const f = holderFixture(); f.board.set('terra', { sessionId: 'terra', taskId: 'task', status: 'working', agent: 'codex', model: 'gpt-6-terra' });
  await assert.rejects(bindSession(f.rt, f.host, f.worker('builder'), { bead_id: 'a', session_id: 'terra', role: 'review' }), /Terra/);
  f.board.set('plain', { sessionId: 'plain', taskId: 'task', status: 'working', agent: 'claude' });
  f.live.a.assignee = 'aw:someone-else';
  await assert.rejects(bindSession(f.rt, f.host, f.worker('builder'), { bead_id: 'a', session_id: 'plain', role: ' review ' }), /nominate|queen/);
  f.live.a.assignee = 'aw:builder';
  const ok = await bindSession(f.rt, f.host, f.worker('builder'), { bead_id: 'a', session_id: 'plain', role: ' review ' });
  assert.equal(ok.role, 'review');
});

test('a stale snapshot does not let a former holder attach sessions', async () => {
  const f = holderFixture(); f.board.set('plain', { sessionId: 'plain', taskId: 'task', status: 'working', agent: 'claude' });
  f.live.a.assignee = 'aw:someone-else';
  await assert.rejects(bindSession(f.rt, f.host, f.worker('builder'), { bead_id: 'a', session_id: 'plain', role: 'review' }), /nominate|queen/);
  await assert.rejects(bindSession(f.rt, f.host, f.worker('builder'), { bead_id: 'a', session_id: 'plain', role: 'helper' }), /queen|coordinator/);
});

test('a bead never has two open reviews: a join during an in-flight request is refused one way or the other', async () => {
  const f = holderFixture(); await launchRecording(f); f.board.set('plain', { sessionId: 'plain', taskId: 'task', status: 'working', agent: 'claude' });
  const results = await Promise.allSettled([
    reviews.requestReview(f.rt, f.host, f.worker('builder'), { bead_id: 'a', intent: 'review' }),
    bindSession(f.rt, f.host, f.worker('builder'), { bead_id: 'a', session_id: 'plain', role: 'review' }),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(Object.values(f.doc().reviews).filter((r) => ['requested', 'in_review'].includes(r.state)).length, 1);
});

test('an unknown builder provider is recorded rather than shown as a different provider', async () => {
  const f = holderFixture(); await launchRecording(f); delete f.board.get('builder').agent;
  const out = await reviews.requestReview(f.rt, f.host, f.worker('builder'), { bead_id: 'a', intent: 'review' });
  assert.equal(out.policy.unknownBuilder, true); assert.equal(out.policy.sameProvider, null);
});

test('joining a review or helper session respects the global work limit', async () => {
  const f = holderFixture('codex', 1); f.board.set('plain', { sessionId: 'plain', taskId: 'task', status: 'working', agent: 'claude' });
  f.live.b.assignee = 'aw:other'; f.live.b.status = 'in_progress'; f.rt.snapshots.graph = buildGraph(Object.values(f.live));
  await assert.rejects(bindSession(f.rt, f.host, f.worker('builder'), { bead_id: 'a', session_id: 'plain', role: 'review' }), /limit/);
  await assert.rejects(bindSession(f.rt, f.host, f.actor(), { bead_id: 'a', session_id: 'plain', role: 'helper' }), /limit/);
});

test('state derives from attached sessions: in review, working, idle; and a re-review is a second session with its own verdict', async () => {
  const f = holderFixture('codex'); await launchRecording(f);
  const cell = f.doc().cells.cell;
  const bead = () => f.rt.snapshots.graph.beads.a;
  assert.equal(deriveActivity(f.rt, f.host, cell, bead()).state, 'working');
  f.board.get('builder').status = 'idle'; f.board.get('builder').lastActivity = Date.now() - 31 * 60000;
  assert.equal(deriveActivity(f.rt, f.host, cell, bead()).state, 'idle');
  const first = await reviews.requestReview(f.rt, f.host, f.worker('builder'), { bead_id: 'a', intent: 'review', commit: 'c1' });
  assert.equal(deriveActivity(f.rt, f.host, cell, bead()).state, 'in_review');
  await reviews.reviewVerdict(f.rt, f.host, f.worker(first.session_id), { bead_id: 'a', verdict: 'changes_requested', summary: 'Fix', commit: 'c1' });
  f.board.get(first.session_id).status = 'exited';
  const second = await reviews.requestReview(f.rt, f.host, f.worker('builder'), { bead_id: 'a', intent: 're-review', commit: 'c2' });
  assert.notEqual(second.session_id, first.session_id);
  assert.notEqual(second.review_id, first.review_id);
  await reviews.reviewVerdict(f.rt, f.host, f.worker(second.session_id), { bead_id: 'a', verdict: 'approved', summary: 'Clean', commit: 'c2' });
  assert.equal(f.doc().reviews[first.review_id].state, 'changes_requested');
  assert.equal(f.doc().reviews[second.review_id].state, 'approved');
  const reviewsOn = attachmentsFor(f.rt, f.host, 'a').filter((x) => x.role === 'review');
  assert.deepEqual(reviewsOn.map((x) => [x.round, x.review_state]), [[1, 'changes_requested'], [2, 'approved']]);
  assert.equal(capacity(f.rt).used, 1);
});

test('hive_update_bead warns when it blocks on the human with no open request, and not otherwise', async () => {
  const f = statusFixture();
  const actor = f.actor();
  const humanWait = await updateBead(f.rt, actor, { bead_id: 'a', status: 'blocked', waiting_for: 'Human: choose' });
  assert.match(humanWait.warning, /hive_request_input/);
  await f.rt.snapshots.refresh();
  const bare = await updateBead(f.rt, actor, { bead_id: 'a', waiting_for: '' });
  assert.match(bare.warning, /hive_request_input/);
  const reasoned = await updateBead(f.rt, actor, { bead_id: 'a', waiting_for: 'External prerequisite' });
  assert.equal(reasoned.warning, undefined);
  const unrelated = await updateBead(f.rt, actor, { bead_id: 'a', summary: 'Still waiting' });
  assert.equal(unrelated.warning, undefined);
  f.doc().requests = { q: { id: 'q', cellId: 'cell', beadId: 'a', state: 'open' } };
  const asked = await updateBead(f.rt, actor, { bead_id: 'a', waiting_for: 'Human: choose' });
  assert.equal(asked.warning, undefined);
});

test('hive_update_bead warns from the applied state when updates race', async () => {
  const f = statusFixture();
  const actor = f.actor();
  const [first, second] = await Promise.all([
    updateBead(f.rt, actor, { bead_id: 'a', status: 'blocked', waiting_for: 'Human: choose' }),
    updateBead(f.rt, actor, { bead_id: 'a', waiting_for: '' }),
  ]);
  assert.equal(f.live.a.status, 'blocked');
  assert.match(second.warning, /hive_request_input/);
  assert.ok(first);
});

test('refused closed-bead wakes tell the current queen once with the linked PR and session', async () => {
  const f = fixture(2);
  await dormantWorker(f);
  const sent = [];
  const url = 'https://github.com/example/repo/pull/42';
  f.host.links = { get: () => [{ type: 'pr', url }] };
  f.host.deliver = async (id, text) => { sent.push({ id, text }); return { mode: 'live' }; };
  f.live.a.status = 'closed'; f.live.a.assignee = null;
  for (let i = 0; i < 2; i++) assert.match((await restore(f))?.refuse || '', /missing or closed/);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].id, 'queen');
  assert.ok(sent[0].text.includes(url));
  assert.match(sent[0].text, /closed.*a|a.*closed/);
  assert.match(sent[0].text, /#session=worker-1/);
  f.doc().cells.cell.queenSessionId = 'queen2';
  await restore(f);
  assert.equal(sent.length, 2);
  assert.equal(sent[1].id, 'queen2');
});

test('uncertain refused-wake delivery is recorded once and does not mask the refusal', async () => {
  const f = fixture(2); const out = await dormantWorker(f); let attempts = 0;
  f.host.links = { get: () => [{ type: 'pr', url: 'https://github.com/example/repo/pull/42' }] };
  f.host.deliver = async () => { attempts++; throw new Error('delivery uncertain'); };
  f.live.a.status = 'closed'; f.live.a.assignee = null;
  assert.match((await restore(f))?.refuse || '', /missing or closed/);
  assert.match((await restore(f))?.refuse || '', /missing or closed/);
  assert.equal(attempts, 1);
  const receipts = Object.values(f.doc().workerLaunches[out.launch_id].closedBeadWakeNotices);
  assert.equal(receipts[0].state, 'uncertain');
});

test('closed-bead refusal without PR links does not send; another held open claim resumes without notice', async () => {
  const f = fixture(2); await dormantWorker(f); const sent = [];
  f.host.deliver = async (...args) => { sent.push(args); return { mode: 'live' }; };
  f.live.a.status = 'closed'; f.live.a.assignee = null;
  assert.match((await restore(f))?.refuse || '', /missing or closed/);
  assert.equal(sent.length, 0);
  f.host.links = { get: () => [{ type: 'pr', url: 'https://github.com/example/repo/pull/42' }] };
  f.live.b.status = 'in_progress'; f.live.b.assignee = 'aw:worker-1';
  assert.equal((await restore(f))?.refuse, undefined);
  assert.equal(sent.length, 0);
});
