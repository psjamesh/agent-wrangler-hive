import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture } from './ownership.test.mjs';
import { applyLaunchPolicy, launchRestriction } from '../server/launch-policy.js';
import * as workers from '../server/workers.js';
import { handoffQueen } from '../server/queen-handoff.js';
import { createManifest } from '../server/manifest.js';
import { resolveCaller } from '../server/access.js';
import { spawnRestriction, workTools } from '../server/tools.js';
import { ungovernedDescendants } from '../server/tracking.js';
import { reconcileLaunch } from '../server/sessions.js';

test('Hive launches carry no deny list and are labelled unrestricted for every provider', () => {
  for (const agent of [undefined, 'claude', 'Claude', 'codex', 'gemini']) {
    assert.equal('disallowedTools' in applyLaunchPolicy({ agent, intent: 'x' }), false);
    const out = applyLaunchPolicy({ agent, disallowedTools: ['Bash'], intent: 'x' });
    assert.deepEqual(out, { agent, intent: 'x' });
    assert.equal(launchRestriction(agent), 'unrestricted');
  }
});

function recordSpawns(f) {
  const calls = [];
  const manifest = createManifest({ dir: '.' });
  let n = 0;
  f.host.sessions.spawn = async (opts) => {
    calls.push(opts);
    const sessionId = `s-${++n}`;
    const ext = opts.ext.hive;
    await manifest.session.onBeforeDispatch({ sessionId, ext, host: f.host });
    const out = await manifest.hooks['session.launchContext']({ sid: sessionId, task: { id: opts.taskId }, reason: 'spawn', host: f.host });
    if (out?.refuse) throw new Error(out.refuse);
    f.board.set(sessionId, { sessionId, taskId: opts.taskId, status: 'working', spawnedBy: null });
    return { sessionId };
  };
  return { calls, manifest };
}

test('Claude and Codex worker launches add no denied tools and record unrestricted launches', async () => {
  const f = fixture(0);
  const { calls } = recordSpawns(f);
  await workers.spawnWorker(f.rt, f.host, f.actor(), { bead_id: 'a', intent: 'build' });
  await workers.spawnWorker(f.rt, f.host, f.actor(), { bead_id: 'b', intent: 'advise' });
  assert(calls.every((c) => !('disallowedTools' in c)));
  assert.doesNotMatch(calls[0].intent, /are denied/);
  await workers.spawnWorker(f.rt, f.host, f.actor(), { bead_id: 'a', intent: 'again', agent: 'codex' }).catch(() => {});
  f.live.a.assignee = null; f.live.a.status = 'open';
  await workers.spawnWorker(f.rt, f.host, f.actor(), { bead_id: 'a', intent: 'codex build', agent: 'codex' });
  const codex = calls.at(-1);
  assert.equal('disallowedTools' in codex, false);
  assert.match(codex.intent, /cannot restrict for this provider/);
  const launches = Object.values(f.doc().workerLaunches);
  assert.equal(launches.at(-1).restriction, 'unrestricted');
  assert.equal(spawnRestriction(f.doc(), launches[0].sessionId), 'unrestricted for this provider');
  assert.equal(spawnRestriction(f.doc(), launches.at(-1).sessionId), 'unrestricted for this provider');
  assert.equal(spawnRestriction(f.doc(), 'nominated'), 'launch restrictions not applied');
});

test('the handoff tool exists', () => {
  assert(workTools.some((t) => t.name === 'hive_handoff_queen'));
});

function queenFixture() {
  const f = fixture(0);
  f.rt.metadata.mutate((d) => { d.cells.cell.queens = [{ sessionId: 'queen', from: 1, to: null, via: 'launched' }]; d.cells.cell.queenGeneration = 3; });
  return f;
}

test('queen handoff launches a top-level fenced successor with the policy and no spawn_session', async () => {
  const f = queenFixture();
  const { calls } = recordSpawns(f);
  await workers.spawnWorker(f.rt, f.host, f.actor(), { bead_id: 'a', intent: 'build' });
  const claim = f.live.a.assignee;
  const out = await handoffQueen(f.rt, f.host, f.actor(), { summary: 'Finish the API work' });
  const call = calls.at(-1);
  assert.equal('disallowedTools' in call, false);
  assert.equal('parentSession' in call, false);
  assert.equal(call.taskId, 'task');
  assert.match(call.intent, /Finish the API work/);
  assert.match(call.intent, /hive_context first/);
  assert.equal(out.installed, true);
  assert.equal(f.doc().cells.cell.queenSessionId, out.successor_session_id);
  assert.equal(f.doc().cells.cell.queenGeneration, 4);
  assert.equal(f.live.a.assignee, claim);
  assert.equal(resolveCaller(f.rt, f.host, 'queen', 'cell').role, 'worker');
  assert.equal(resolveCaller(f.rt, f.host, out.successor_session_id, 'cell').role, 'queen');
});

test('only the current queen can hand off', async () => {
  const f = queenFixture();
  recordSpawns(f);
  f.board.set('w', { sessionId: 'w', taskId: 'task', status: 'working' });
  await assert.rejects(handoffQueen(f.rt, f.host, { ...f.actor('w'), role: 'worker' }, { summary: 's' }), /current queen/);
  await assert.rejects(handoffQueen(f.rt, f.host, { ...f.actor('queen'), sessionId: 'w', role: 'queen' }, { summary: 's' }), /current queen/);
});

test('one handoff at a time: a second request while one is unresolved is refused', async () => {
  const f = queenFixture();
  let release;
  f.host.sessions.spawn = () => new Promise((r) => { release = r; });
  const first = handoffQueen(f.rt, f.host, f.actor(), { summary: 'one' });
  while (!Object.values(f.doc().launches).length) await new Promise((r) => setImmediate(r));
  await assert.rejects(handoffQueen(f.rt, f.host, f.actor(), { summary: 'two' }), /already/);
  release({ sessionId: 'later' });
  await first;
  assert.equal(Object.values(f.doc().launches).length, 1);
});

test('a human nomination during the handoff supersedes it and the stale successor is refused before acting', async () => {
  const f = queenFixture();
  const manifest = createManifest({ dir: '.' });
  f.board.set('human-pick', { sessionId: 'human-pick', taskId: 'task', status: 'working' });
  f.host.sessions.spawn = async (opts) => {
    f.rt.metadata.mutate((d) => { d.cells.cell.queens.push({ sessionId: 'human-pick', from: 2, to: null, via: 'nominated' }); d.cells.cell.queenSessionId = 'human-pick'; d.cells.cell.queenGeneration += 1; });
    await manifest.session.onBeforeDispatch({ sessionId: 'stale-succ', ext: opts.ext.hive, host: f.host });
    const gate = await manifest.hooks['session.launchContext']({ sid: 'stale-succ', task: { id: 'task' }, reason: 'spawn', host: f.host });
    assert.match(gate.refuse, /superseded/);
    return { sessionId: 'stale-succ' };
  };
  const out = await handoffQueen(f.rt, f.host, f.actor(), { summary: 's' });
  assert.equal(out.installed, false);
  assert.equal(f.doc().cells.cell.queenSessionId, 'human-pick');
  assert.equal(Object.values(f.doc().launches)[0].superseded, true);
});

test('a handoff made with a stale generation is refused before any spawn', async () => {
  const f = queenFixture();
  let spawned = 0;
  f.host.sessions.spawn = async () => { spawned++; return { sessionId: 'x' }; };
  const actor = f.actor();
  f.rt.metadata.mutate((d) => { d.cells.cell.queenSessionId = 'other'; });
  await assert.rejects(handoffQueen(f.rt, f.host, actor, { summary: 's' }), /current queen|stale/);
  assert.equal(spawned, 0);
});

test('an unknown spawn outcome keeps the launch uncertain and never respawns', async () => {
  const f = queenFixture();
  let spawned = 0;
  f.host.sessions.spawn = async () => { spawned++; throw new Error('host hiccup'); };
  await assert.rejects(handoffQueen(f.rt, f.host, f.actor(), { summary: 's' }), /host hiccup/);
  assert.equal(f.doc().cells.cell.queenSessionId, 'queen');
  assert.equal(spawned, 1);
  const l = Object.values(f.doc().launches)[0];
  assert.equal(l.state, 'failed');
  assert.deepEqual(reconcileLaunch(f.rt, f.host, { launchId: l.id, dismiss: true }).state, 'dismissed');
});

test('sessions spawned outside Hive by participants are flagged, governed ones are not', () => {
  const f = queenFixture();
  f.rt.metadata.mutate((d) => { d.workerLaunches.w1 = { id: 'w1', cellId: 'cell', sessionId: 'governed', state: 'launched' }; });
  const all = [
    { sessionId: 'governed', spawnedBy: 'queen', taskId: 'task', status: 'working' },
    { sessionId: 'rogue-same', spawnedBy: 'queen', taskId: 'task', status: 'working' },
    { sessionId: 'rogue-other', spawnedBy: 'queen', taskId: 'elsewhere', status: 'idle' },
    { sessionId: 'gone', spawnedBy: 'queen', taskId: 'task', status: 'exited' },
    { sessionId: 'stranger', spawnedBy: 'nobody', taskId: 'task', status: 'working' },
  ];
  f.host.sessions.list = () => all;
  const out = ungovernedDescendants(f.rt, f.host, f.doc().cells.cell, []);
  assert.deepEqual(out.map((s) => [s.session_id, s.in_cell_task]), [['rogue-same', true], ['rogue-other', false]]);
});

test('every host.sessions.spawn call in the server goes through the launch policy', async () => {
  const fs = await import('node:fs');
  const hits = fs.readdirSync(new URL('../server/', import.meta.url)).filter((n) => n.endsWith('.js') && !n.endsWith('.test.js'))
    .flatMap((n) => fs.readFileSync(new URL(`../server/${n}`, import.meta.url), 'utf8').split('\n').filter((l) => /sessions\.spawn\(/.test(l)).map((l) => [n, l]));
  assert.deepEqual(hits.map(([n]) => n).sort(), ['sessions.js', 'workers.js']);
  assert(hits.every(([, l]) => l.includes('applyLaunchPolicy(')));
});

test('a swallowed dispatch-hook failure cannot let a stale successor start, even with no ext at launch context', async () => {
  const f = queenFixture();
  const manifest = createManifest({ dir: '.' });
  const mutate = f.rt.metadata.mutate;
  let started = false;
  f.host.sessions.spawn = async (opts) => {
    f.rt.metadata.mutate = () => { throw new Error('simulated disk failure'); };
    try { manifest.session.onBeforeDispatch({ sessionId: 'stale-start', ext: opts.ext.hive, host: f.host }); } catch {}
    f.rt.metadata.mutate = mutate;
    mutate((d) => { d.cells.cell.queens.push({ sessionId: 'human-pick', from: 2, to: null, via: 'nominated' }); d.cells.cell.queenSessionId = 'human-pick'; d.cells.cell.queenGeneration += 1; });
    const gate = await manifest.hooks['session.launchContext']({ sid: 'stale-start', task: { id: 'task' }, reason: 'spawn', host: f.host });
    assert.match(gate?.refuse, /superseded|replaced|abandoned/);
    return { sessionId: 'stale-start' };
  };
  const out = await handoffQueen(f.rt, f.host, f.actor(), { summary: 'continue' });
  assert.equal(started, false);
  assert.equal(out.installed, false);
  assert.equal(f.doc().cells.cell.queenSessionId, 'human-pick');
});

test('a successor whose dispatch binding was never recorded is refused even when nobody replaced the queen', async () => {
  const f = queenFixture();
  const manifest = createManifest({ dir: '.' });
  const mutate = f.rt.metadata.mutate;
  f.host.sessions.spawn = async (opts) => {
    f.rt.metadata.mutate = () => { throw new Error('simulated disk failure'); };
    try { manifest.session.onBeforeDispatch({ sessionId: 'unbound', ext: opts.ext.hive, host: f.host }); } catch {}
    f.rt.metadata.mutate = mutate;
    const gate = await manifest.hooks['session.launchContext']({ sid: 'unbound', task: { id: 'task' }, reason: 'spawn', host: f.host });
    assert.match(gate?.refuse, /Hive refused queen startup/);
    return { sessionId: 'unbound' };
  };
  await handoffQueen(f.rt, f.host, f.actor(), { summary: 's' });
});

test('handoff revokes the outgoing queen\'s coordinator bindings but keeps its claims and other bindings', async () => {
  const f = queenFixture();
  recordSpawns(f);
  f.live.b.assignee = 'aw:queen'; f.live.b.status = 'in_progress';
  f.rt.metadata.mutate((d) => { d.bindings.cell = [{ sessionId: 'queen', beadId: 'a', role: 'coordinator', active: true }, { sessionId: 'queen', beadId: 'b', role: 'worker', active: true }, { sessionId: 'other', beadId: 'a', role: 'coordinator', active: true }]; });
  await handoffQueen(f.rt, f.host, f.actor(), { summary: 's' });
  const bindings = f.doc().bindings.cell;
  assert.equal(bindings[0].active, false);
  assert.equal(bindings[1].active, true);
  assert.equal(bindings[2].active, true);
  assert.equal(f.live.b.assignee, 'aw:queen');
  assert.equal(resolveCaller(f.rt, f.host, 'queen', 'cell').role, 'worker');
});

test('a later nomination keeps its coordinator bindings when an older handoff is superseded', async () => {
  const f = queenFixture();
  f.rt.metadata.mutate((d) => { d.bindings.cell = [{ sessionId: 'queen', beadId: 'a', role: 'coordinator', active: true }]; });
  const manifest = createManifest({ dir: '.' });
  f.host.sessions.spawn = async (opts) => {
    f.rt.metadata.mutate((d) => { d.cells.cell.queens.push({ sessionId: 'human-pick', from: 2, to: null, via: 'nominated' }); d.cells.cell.queenSessionId = 'human-pick'; d.cells.cell.queenGeneration += 1; });
    await manifest.session.onBeforeDispatch({ sessionId: 'late', ext: opts.ext.hive, host: f.host });
    return { sessionId: 'late' };
  };
  await handoffQueen(f.rt, f.host, f.actor(), { summary: 's' });
  assert.equal(f.doc().bindings.cell[0].active, true);
});

test('a helper cannot share a builder bead through the tool or spawn path', async () => {
  const f = fixture(1);
  recordSpawns(f);
  const tool = workTools.find((t) => t.name === 'hive_spawn_worker');
  assert.equal(tool.inputSchema.safeParse({ bead_id: 'a', intent: 'x', role: 'helper' }).success, false);
  await workers.spawnWorker(f.rt, f.host, f.actor(), { bead_id: 'a', intent: 'build' });
  await assert.rejects(workers.spawnWorker(f.rt, f.host, f.actor(), { bead_id: 'a', intent: 'advise' }, { role: 'investigator' }), /own bead/);
  assert.equal(Object.values(f.live).filter((b) => b.assignee).length, 1);
});

test('descendants are found transitively across tasks, through exited intermediates, with cycle protection', () => {
  const f = queenFixture();
  f.rt.metadata.mutate((d) => { d.workerLaunches.w1 = { id: 'w1', cellId: 'cell', sessionId: 'governed', state: 'launched' }; });
  f.host.sessions.list = () => [
    { sessionId: 'child', spawnedBy: 'queen', taskId: 'elsewhere', status: 'working' },
    { sessionId: 'grandchild', spawnedBy: 'child', taskId: 'elsewhere', status: 'working' },
    { sessionId: 'dead-mid', spawnedBy: 'queen', taskId: 'elsewhere', status: 'exited' },
    { sessionId: 'orphan-gc', spawnedBy: 'dead-mid', taskId: 'x', status: 'working' },
    { sessionId: 'governed', spawnedBy: 'child', taskId: 'x', status: 'working' },
    { sessionId: 'loop-a', spawnedBy: 'loop-b', taskId: 'x', status: 'working' },
    { sessionId: 'loop-b', spawnedBy: 'loop-a', taskId: 'x', status: 'working' },
  ];
  const out = ungovernedDescendants(f.rt, f.host, f.doc().cells.cell, []);
  assert.deepEqual(out.map((s) => s.session_id), ['child', 'grandchild', 'orphan-gc']);
  assert(out.every((s) => s.origin_session_id === 'queen' || s.origin_session_id === 'queen'));
});
