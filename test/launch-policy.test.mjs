import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture } from './ownership.test.mjs';
import { applyLaunchPolicy, launchRestriction } from '../server/launch-policy.js';
import * as workers from '../server/workers.js';
import { requestReview } from '../server/reviews.js';
import { handoffQueen } from '../server/queen-handoff.js';
import { createManifest } from '../server/manifest.js';
import { capacity } from '../server/admission.js';
import { resolveCaller } from '../server/access.js';
import { spawnRestriction, workTools } from './helpers/tools.mjs';
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
  const calls = [], policies = [];
  const manifest = createManifest({ dir: '.' });
  let n = 0;
  f.host.sessions.spawn = async (opts) => {
    calls.push(opts);
    const sessionId = `s-${++n}`;
    const ext = opts.ext.hive;
    await manifest.session.onBeforeDispatch({ sessionId, ext, host: f.host });
    const out = await manifest.hooks['session.launchContext']({ sid: sessionId, task: { id: opts.taskId }, reason: 'spawn', host: f.host });
    if (out?.refuse) throw new Error(out.refuse);
    policies.push(manifest.codexPolicy({ phase: 'dispatch', sessionId, ext: f.host }));
    f.board.set(sessionId, { sessionId, taskId: opts.taskId, status: 'working', spawnedBy: null });
    return { sessionId };
  };
  return { calls, manifest, policies };
}

for (const codex_approval of [undefined, 'on-request', 'never']) {
  test(`Codex work launches use ${codex_approval ?? 'core default'} approvals`, async () => {
    const f = fixture(0);
    const { calls } = recordSpawns(f);
    await workers.spawnWorker(f.rt, f.host, f.actor(), { bead_id: 'a', intent: 'build', agent: 'codex', codex_approval });
    assert.equal(calls[0].approvalPolicy, codex_approval);
    assert.equal('codex_approval' in calls[0], false);
  });

  test(`policy-selected Codex reviews use ${codex_approval ?? 'core default'} approvals`, async () => {
    const f = fixture(0);
    const { calls } = recordSpawns(f);
    f.live.a.assignee = 'aw:builder';
    f.board.set('builder', { sessionId: 'builder', taskId: 'task', agent: 'claude', status: 'working' });
    await requestReview(f.rt, f.host, f.actor(), { bead_id: 'a', intent: 'review', codex_approval });
    assert.equal(calls[0].agent, 'codex');
    assert.equal(calls[0].approvalPolicy, codex_approval);
    assert.equal('codex_approval' in calls[0], false);
  });
}

test('invalid Codex approval policies are refused before reserving or spawning a worker', async () => {
  for (const codex_approval of ['untrusted', 'on-failure', '', null, 42, {}]) {
    const f = fixture(0);
    const { calls } = recordSpawns(f);
    await assert.rejects(workers.spawnWorker(f.rt, f.host, f.actor(), { bead_id: 'a', intent: 'build', agent: 'codex', codex_approval }), /codex_approval.*on-request.*never/);
    assert.equal(calls.length, 0);
    assert.equal(Object.keys(f.doc().workerLaunches).length, 0);
  }
});

test('non-Codex launches ignore valid Codex approval choices', async () => {
  for (const agent of [undefined, 'claude', 'gemini']) {
    const f = fixture(0);
    const { calls } = recordSpawns(f);
    await workers.spawnWorker(f.rt, f.host, f.actor(), { bead_id: 'a', intent: 'build', agent, codex_approval: 'never' });
    assert.equal('approvalPolicy' in calls[0], false);
    assert.equal('codex_approval' in calls[0], false);
  }
});

test('worker and review tool schemas accept only core-supported Codex approval policies', () => {
  for (const name of ['hive_spawn_worker', 'hive_request_review']) {
    const tool = workTools.find(t => t.name === name);
    for (const codex_approval of ['on-request', 'never']) {
      const parsed = tool.inputSchema.parse({ bead_id: 'a', intent: 'x', codex_approval });
      assert.equal(parsed.codex_approval, codex_approval);
    }
    for (const codex_approval of ['untrusted', 'on-failure', '', null, 42, {}]) {
      assert.equal(tool.inputSchema.safeParse({ bead_id: 'a', intent: 'x', codex_approval }).success, false);
    }
  }
});

test('Claude and Codex worker launches add no denied tools and record unrestricted launches', async () => {
  const f = fixture(0);
  const { calls } = recordSpawns(f);
  await workers.spawnWorker(f.rt, f.host, f.actor(), { bead_id: 'a', intent: 'build' });
  await workers.spawnWorker(f.rt, f.host, f.actor(), { bead_id: 'b', intent: 'advise' });
  assert(calls.every((c) => !('disallowedTools' in c)));
  assert.doesNotMatch(calls[0].intent, /are denied|cannot restrict for this provider/);
  assert.match(calls[0].intent, /do not use spawn_session, spawn_workflow or schedule_session; they leave the session untracked/);
  await workers.spawnWorker(f.rt, f.host, f.actor(), { bead_id: 'a', intent: 'again', agent: 'codex' }).catch(() => {});
  f.live.a.assignee = null; f.live.a.status = 'open';
  await workers.spawnWorker(f.rt, f.host, f.actor(), { bead_id: 'a', intent: 'codex build', agent: 'codex' });
  const codex = calls.at(-1);
  assert.equal('disallowedTools' in codex, false);
  assert.match(codex.intent, /do not use spawn_session, spawn_workflow or schedule_session; they leave the session untracked/);
  const launches = Object.values(f.doc().workerLaunches);
  assert.equal(launches.at(-1).restriction, 'unrestricted');
  assert.equal(spawnRestriction(f.doc(), launches[0].sessionId), 'unrestricted');
  assert.equal(spawnRestriction(f.doc(), launches.at(-1).sessionId), 'unrestricted');
  assert.equal(spawnRestriction(f.doc(), 'nominated'), 'launch restrictions not applied');
});

test('persisted denied launch records keep their restriction label', () => {
  const doc = { workerLaunches: { oldWorker: { sessionId: 'worker', restriction: 'denied' } }, launches: { oldQueen: { sessionId: 'queen', restriction: 'denied' } } };
  assert.equal(spawnRestriction(doc, 'worker'), 'denied');
  assert.equal(spawnRestriction(doc, 'queen'), 'denied');
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
  assert.equal(call.autoCompactTokens, 250000);
  const launch = f.doc().launches[out.launch_id];
  assert.equal(launch.handoverSourceSessionId, null);
  assert.equal(launch.archiveSourceAfterHandover, false);
  assert.match(call.intent, /no handover, no archive/);
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
  assert.deepEqual(out.map((s) => [s.session_id, s.in_cell_task]), [['rogue-same', true], ['rogue-other', false], ['gone', true]]);
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

test('a helper shares a builder bead through the tool and spawn path', async () => {
  const f = fixture(1);
  recordSpawns(f);
  const tool = workTools.find((t) => t.name === 'hive_spawn_worker');
  assert.equal(tool.inputSchema.safeParse({ bead_id: 'a', intent: 'x', role: 'helper' }).success, true);
  await workers.spawnWorker(f.rt, f.host, f.actor(), { bead_id: 'a', intent: 'build' });
  const helper = await workers.spawnWorker(f.rt, f.host, f.actor(), { bead_id: 'a', intent: 'advise' }, { role: 'investigator' });
  assert.equal(Object.values(f.live).filter((b) => b.assignee).length, 1);
  assert.equal(capacity(f.rt).used, 1);
  f.live.a.assignee = '';
  f.live.a.status = 'open';
  await f.rt.snapshots.refresh();
  assert.equal(capacity(f.rt).used, 1);
  f.board.get(helper.session_id).status = 'exited';
  assert.equal(capacity(f.rt).used, 0);
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
  assert.deepEqual(out.map((s) => s.session_id), ['child', 'grandchild', 'dead-mid', 'orphan-gc']);
  assert(out.every((s) => s.origin_session_id === 'queen' || s.origin_session_id === 'queen'));
});

for (const role of ['work', 'review']) for (const [setting, policy] of [
  ['config', undefined], ['approve-for-me', { approveForMe: true }], ['on-request', { approval: 'on-request' }], ['never', { approval: 'never' }],
]) for (const codex_approval of [undefined, 'never', 'on-request']) {
  test(`${role}: hive ${setting} takes precedence over launch ${codex_approval ?? 'default'}`, async () => {
    const f = fixture(0);
    f.rt.metadata.mutate(d => { d.cells.cell.codexApprovals = setting; });
    const { calls, manifest, policies } = recordSpawns(f);
    const answers = [];
    const spawn = f.host.sessions.spawn;
    f.host.sessions.spawn = async opts => {
      const result = await spawn(opts);
      for (const phase of ['dispatch', 'resume', 'fork']) {
        answers.push(manifest.codexPolicy({ phase, sessionId: phase === 'fork' ? 'forked' : result.sessionId, parentId: result.sessionId, ext: f.host }));
      }
      return result;
    };
    if (role === 'review') {
      f.live.a.assignee = 'aw:builder';
      f.board.set('builder', { sessionId: 'builder', taskId: 'task', agent: 'claude', status: 'working' });
      await requestReview(f.rt, f.host, f.actor(), { bead_id: 'a', intent: 'review', codex_approval });
    } else {
      await workers.spawnWorker(f.rt, f.host, f.actor(), { bead_id: 'a', intent: 'build', agent: 'codex', codex_approval });
    }
    assert.equal(calls[0].approvalPolicy, codex_approval);
    assert.equal(Object.hasOwn(calls[0], 'approvalPolicy'), codex_approval !== undefined);
    assert.deepEqual(policies, [policy]);
    assert.deepEqual(answers, [policy, policy, policy]);
  });
}

function launchDirectory(t, git = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-worker-cwd-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  if (git) execFileSync('git', ['init', dir], { stdio: 'pipe' });
  const cwd = path.join(dir, 'nested');
  fs.mkdirSync(cwd);
  return cwd;
}

for (const git of [true, false]) test(`work launch in ${git ? 'git' : 'non-git'} cwd defaults worktree appropriately`, async t => {
  const f = fixture();
  const { calls } = recordSpawns(f);
  const cwd = launchDirectory(t, git);
  await workers.spawnWorker(f.rt, f.host, f.actor(), { bead_id: 'a', intent: 'build', cwd });
  assert.deepEqual(calls[0].worktree, git ? { auto: true } : undefined);
});

for (const worktree of [{ auto: false, branch: 'chosen' }, { auto: true, base: 'origin/main' }]) test(`work launch preserves explicit worktree ${JSON.stringify(worktree)}`, async t => {
  const f = fixture();
  const { calls } = recordSpawns(f);
  await workers.spawnWorker(f.rt, f.host, f.actor(), { bead_id: 'a', intent: 'build', cwd: launchDirectory(t), worktree });
  assert.deepEqual(calls[0].worktree, worktree);
});

for (const role of ['reviewer', 'investigator']) test(`${role} in git cwd keeps optional worktree`, async t => {
  const f = fixture(0);
  const { calls } = recordSpawns(f);
  const cwd = launchDirectory(t);
  await workers.spawnWorker(f.rt, f.host, f.actor(), { bead_id: 'a', intent: 'build' });
  if (role === 'reviewer') await requestReview(f.rt, f.host, f.actor(), { bead_id: 'a', intent: 'review', commit: 'abc', cwd });
  else await workers.spawnWorker(f.rt, f.host, f.actor(), { bead_id: 'a', intent: 'help', cwd }, { role });
  assert.equal(calls[1].worktree, undefined);
});

for (const worktree of [false, null]) test(`worker cannot opt out with worktree ${worktree}`, async () => {
  const f = fixture();
  const { calls } = recordSpawns(f);
  await assert.rejects(workers.spawnWorker(f.rt, f.host, f.actor(), { bead_id: 'a', intent: 'build', worktree }), /worktree must be an object/);
  assert.equal(calls.length, 0);
});
