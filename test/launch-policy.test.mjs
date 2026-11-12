import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture } from './ownership.test.mjs';
import { CLAUDE_SPAWN_DENIES, applyLaunchPolicy, launchRestriction } from '../server/launch-policy.js';
import * as workers from '../server/workers.js';
import { handoffQueen } from '../server/queen-handoff.js';
import { createManifest } from '../server/manifest.js';
import { resolveCaller } from '../server/access.js';
import { spawnRestriction, workTools } from '../server/tools.js';
import { ungovernedDescendants } from '../server/tracking.js';
import { reconcileLaunch } from '../server/sessions.js';

const DENIES = ['mcp__agent-wrangler__spawn_session', 'mcp__agent-wrangler__spawn_workflow'];

test('the exact AW MCP deny names are applied to Claude and cannot be overridden', () => {
  assert.deepEqual([...CLAUDE_SPAWN_DENIES], DENIES);
  assert.deepEqual(applyLaunchPolicy({ intent: 'x' }).disallowedTools, DENIES);
  assert.deepEqual(applyLaunchPolicy({ agent: 'claude', disallowedTools: [] }).disallowedTools, DENIES);
  assert.deepEqual(applyLaunchPolicy({ agent: 'Claude', disallowedTools: ['Bash'] }).disallowedTools, DENIES);
});

test('Codex and Gemini launches carry no deny list and are labelled unrestricted', () => {
  for (const agent of ['codex', 'gemini']) {
    const out = applyLaunchPolicy({ agent, disallowedTools: DENIES });
    assert.equal('disallowedTools' in out, false);
    assert.equal(launchRestriction(agent), 'unrestricted');
  }
  assert.equal(launchRestriction(undefined), 'denied');
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
    const out = await manifest.hooks['session.launchContext']({ sid: sessionId, task: { id: opts.taskId }, ext, reason: 'spawn', host: f.host });
    if (out?.refuse) throw new Error(out.refuse);
    f.board.set(sessionId, { sessionId, taskId: opts.taskId, status: 'working', spawnedBy: null });
    return { sessionId };
  };
  return { calls, manifest };
}

test('worker and helper launches deny the AW spawn tools; Codex workers do not and record it', async () => {
  const f = fixture(0);
  const { calls } = recordSpawns(f);
  await workers.spawnWorker(f.rt, f.host, f.actor(), { bead_id: 'a', intent: 'build' });
  await workers.spawnWorker(f.rt, f.host, f.actor(), { bead_id: 'b', intent: 'advise' }, { role: 'investigator' });
  assert.deepEqual(calls.map((c) => c.disallowedTools), [DENIES, DENIES]);
  assert.match(calls[0].intent, /spawn_session and spawn_workflow are denied/);
  await workers.spawnWorker(f.rt, f.host, f.actor(), { bead_id: 'a', intent: 'again', agent: 'codex' }).catch(() => {});
  f.live.a.assignee = null; f.live.a.status = 'open';
  await workers.spawnWorker(f.rt, f.host, f.actor(), { bead_id: 'a', intent: 'codex build', agent: 'codex' });
  const codex = calls.at(-1);
  assert.equal('disallowedTools' in codex, false);
  assert.match(codex.intent, /cannot restrict for this provider/);
  const launches = Object.values(f.doc().workerLaunches);
  assert.equal(launches.at(-1).restriction, 'unrestricted');
  assert.equal(spawnRestriction(f.doc(), launches[0].sessionId), 'denied');
  assert.equal(spawnRestriction(f.doc(), launches.at(-1).sessionId), 'unrestricted for this provider');
  assert.equal(spawnRestriction(f.doc(), 'nominated'), 'launch restrictions not applied');
});

test('Hive tools are not among the denied names and the handoff tool exists', () => {
  assert(workTools.some((t) => t.name === 'hive_handoff_queen'));
  assert(workTools.every((t) => !DENIES.includes(`mcp__agent-wrangler__${t.name}`)));
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
  assert.deepEqual(call.disallowedTools, DENIES);
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
    const gate = await manifest.hooks['session.launchContext']({ sid: 'stale-succ', task: { id: 'task' }, ext: opts.ext.hive, reason: 'spawn', host: f.host });
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
