import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createKeepAwake, parsePowerSource, CAFFEINATE } from '../server/keep-awake.js';
import { HiveRuntime } from '../server/runtime.js';
import { flush } from './helpers/fake-timers.mjs';
import { buildGraph } from '../server/bead-model.js';

const AC = "Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t100%; charged; 0:00 remaining present: true\n";
const BATTERY = "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t80%; discharging; 4:00 remaining present: true\n";

function harness({ platform = 'darwin', power = AC, present = true } = {}) {
  let t = 1000;
  const spawns = [];
  const pmset = [];
  const hooks = new Set();
  const changes = [];
  const state = { power };
  const ka = createKeepAwake({
    platform, pid: 777, now: () => t, exists: (file) => present && file === CAFFEINATE,
    exitHooks: { add: (fn) => hooks.add(fn), remove: (fn) => hooks.delete(fn) },
    onChange: (s) => changes.push(s),
    spawn(file, args, options) {
      const child = new EventEmitter();
      child.pid = 9000 + spawns.length;
      child.exitCode = null;
      child.kills = [];
      child.unref = () => { child.unrefd = true; };
      child.kill = (sig) => {
        child.kills.push(sig);
        setImmediate(() => { child.exitCode = null; child.signalCode = sig; child.emit('exit', null, sig); });
        return true;
      };
      spawns.push({ file, args, options, child });
      return child;
    },
    execFile(file, args, options, cb) {
      pmset.push({ file, args });
      setImmediate(() => (state.power instanceof Error ? cb(state.power, '', '') : cb(null, state.power, '')));
      return { stdin: { end() {} } };
    },
  });
  return { ka, spawns, pmset, hooks, changes, state, advance: (ms) => { t += ms; } };
}

const active = { enabled: true, acOnly: true, active: true, work: 1, ciWaits: 0 };

test('parses pmset power sources', () => {
  assert.equal(parsePowerSource(AC), 'ac');
  assert.equal(parsePowerSource(BATTERY), 'battery');
  assert.equal(parsePowerSource("Now drawing from 'UPS Power'"), 'battery');
  assert.equal(parsePowerSource('garbage'), null);
});

test('holds caffeinate tied to the service pid while work is active and releases it when idle', async () => {
  const h = harness();
  assert.equal(h.ka.evaluate(active).reason, 'checking');
  assert.equal(h.spawns.length, 0, 'never holds before the power source is known');
  await flush();
  assert.equal(h.pmset[0].file, '/usr/bin/pmset');
  assert.deepEqual(h.pmset[0].args, ['-g', 'batt']);
  assert.equal(h.spawns.length, 1);
  assert.equal(h.spawns[0].file, '/usr/bin/caffeinate');
  assert.deepEqual(h.spawns[0].args, ['-i', '-w', '777']);
  assert.deepEqual(h.spawns[0].options, { stdio: 'ignore' });
  assert.equal(h.spawns[0].child.unrefd, true);
  assert.equal(h.ka.status.holding, true);
  assert.equal(h.ka.status.pid, 9000);
  assert.equal(h.hooks.size, 1);
  h.ka.evaluate(active);
  assert.equal(h.spawns.length, 1, 'evaluate is idempotent');

  const idle = h.ka.evaluate({ ...active, active: false, work: 0 });
  assert.equal(idle.reason, 'idle');
  assert.equal(idle.holding, false);
  assert.deepEqual(h.spawns[0].child.kills, ['SIGTERM']);
  assert.equal(h.hooks.size, 0);
  h.ka.evaluate(active);
  assert.equal(h.spawns.length, 1, 'waits for the old process to exit before starting another');
  await flush();
  assert.equal(h.spawns.length, 2);
  assert.equal(h.ka.status.holding, true);
});

test('turning the setting off releases the assertion', async () => {
  const h = harness();
  h.ka.evaluate(active);
  await flush();
  assert.equal(h.ka.status.holding, true);
  const off = h.ka.evaluate({ ...active, enabled: false });
  assert.equal(off.reason, 'disabled');
  assert.deepEqual(h.spawns[0].child.kills, ['SIGTERM']);
  await flush();
  assert.equal(h.spawns.length, 1);
});

test('moving from AC to battery releases it when only on AC, and holds on battery when allowed', async () => {
  const h = harness();
  h.ka.evaluate(active);
  await flush();
  assert.equal(h.ka.status.holding, true);
  h.state.power = BATTERY;
  h.advance(10000);
  h.ka.evaluate(active);
  await flush();
  assert.equal(h.pmset.length, 1, 'power is rechecked only after its cache expires');
  assert.equal(h.ka.status.holding, true);
  h.advance(30000);
  h.ka.evaluate(active);
  await flush();
  assert.equal(h.pmset.length, 2);
  assert.equal(h.ka.status.holding, false);
  assert.equal(h.ka.status.reason, 'battery');
  assert.deepEqual(h.spawns[0].child.kills, ['SIGTERM']);
  h.ka.evaluate({ ...active, acOnly: false });
  await flush();
  assert.equal(h.ka.status.holding, true);
  assert.equal(h.spawns.length, 2);
});

test('an unreadable power source does not hold when only on AC', async () => {
  const h = harness({ power: new Error('pmset failed') });
  h.ka.evaluate(active);
  await flush();
  assert.equal(h.ka.status.reason, 'power-unknown');
  assert.equal(h.spawns.length, 0);
});

test('stop releases without respawning when the old process exits', async () => {
  const h = harness();
  h.ka.evaluate(active);
  await flush();
  h.ka.stop();
  assert.deepEqual(h.spawns[0].child.kills, ['SIGTERM']);
  await flush();
  await flush();
  assert.equal(h.spawns.length, 1);
  assert.equal(h.ka.status.holding, false);
  assert.equal(h.ka.status.reason, 'stopped');
  h.ka.evaluate(active);
  assert.equal(h.spawns.length, 2, 'a later evaluation can hold again');
});

test('dispose on runtime shutdown kills the process and ignores later evaluations', async () => {
  const h = harness();
  h.ka.evaluate(active);
  await flush();
  h.ka.dispose();
  assert.deepEqual(h.spawns[0].child.kills, ['SIGTERM']);
  assert.equal(h.ka.status.holding, false);
  assert.equal(h.hooks.size, 0);
  h.ka.evaluate(active);
  await flush();
  assert.equal(h.spawns.length, 1);
});

test('an unexpected exit backs off before holding again', async () => {
  const h = harness();
  h.ka.evaluate(active);
  await flush();
  h.spawns[0].child.emit('exit', 1, null);
  assert.equal(h.ka.status.reason, 'backoff');
  assert.equal(h.spawns.length, 1);
  assert.equal(h.hooks.size, 0);
  h.advance(5000);
  h.ka.evaluate(active);
  assert.equal(h.spawns.length, 2);
  assert.equal(h.ka.status.holding, true);
});

test('does nothing on other platforms, without caffeinate, or when switched off for the process', async () => {
  for (const [opts, reason] of [[{ platform: 'linux' }, 'unsupported'], [{ present: false }, 'missing'], [{ platform: 'off' }, 'env-off']]) {
    const h = harness(opts);
    assert.equal(h.ka.evaluate(active).reason, reason);
    await flush();
    assert.equal(h.spawns.length, 0);
    assert.equal(h.pmset.length, 0);
  }
});

test('the runtime counts pending CI waits as active work and releases on detach', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-keep-awake-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let spawnArgs = null;
  const rt = new HiveRuntime({
    env: { AW_DATA_DIR: dir },
    keepAwake: {
      platform: 'darwin', pid: 777, exists: () => true, exitHooks: { add() {}, remove() {} },
      execFile: (file, args, options, cb) => { setImmediate(() => cb(null, AC, '')); return {}; },
      spawn: (file, args) => {
        spawnArgs = args;
        return Object.assign(new EventEmitter(), { pid: 1, exitCode: null, kill(sig) { setImmediate(() => this.emit('exit', null, sig)); } });
      },
    },
  });
  const settings = new Map();
  const host = { stores: { hive: rt }, settings: { get: (k) => settings.get(k) }, sessions: { get: () => null, forTask: () => [] }, tasks: { get: () => null }, events: { on: () => () => {} } };
  rt.host = host;
  const lifetime = rt.metadata.lifetime;
  lifetime.isCurrent = () => true;
  assert.equal(rt.evaluateKeepAwake().reason, 'idle');
  rt.metadata.mutate((d) => { d.cells.c = { id: 'c', enabled: true }; (d.ciWaits ||= {})['hive-a'] = { id: 'w1', cellId: 'c', state: 'pending' }; });
  rt.evaluateKeepAwake();
  await flush();
  assert.equal(rt.keepAwake.status.holding, true);
  assert.equal(rt.keepAwake.status.ciWaits, 1);
  assert.deepEqual(spawnArgs, ['-i', '-w', '777']);
  settings.set('keepAwake', false);
  assert.equal(rt.evaluateKeepAwake().reason, 'disabled');
  settings.delete('keepAwake');
  await flush();
  rt.evaluateKeepAwake();
  await flush();
  assert.equal(rt.keepAwake.status.holding, true);
  rt.detach();
  assert.equal(rt.keepAwake.status.holding, false);
  assert.equal(rt.keepAwake.status.reason, 'stopped');
});

test('only live evidence counts as active work', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-active-work-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const rt = new HiveRuntime({ env: { AW_DATA_DIR: dir }, keepAwake: { platform: 'linux' } });
  const sessions = new Map([['live', { sessionId: 'live', status: 'working' }], ['sleepy', { sessionId: 'sleepy', status: 'idle', dormant: true }], ['gone', { sessionId: 'gone', status: 'exited' }]]);
  rt.host = { sessions: { get: (id) => sessions.get(id), forTask: () => [] } };
  rt.metadata.lifetime.isCurrent = () => true;
  const raw = (id, parentId, extra = {}) => ({ id, title: id, status: 'open', metadata: { hive_kind: parentId ? 'work' : 'goal' }, dependencies: parentId ? [{ issue_id: id, depends_on_id: parentId, type: 'parent-child' }] : [], ...extra });
  let graph = buildGraph([raw('root'), raw('a', 'root', { status: 'in_progress', assignee: 'aw:sleepy' }), raw('b', 'root')]);
  rt.snapshots = { get graph() { return graph; } };
  rt.metadata.mutate((d) => {
    d.cells.c = { id: 'c', taskId: 't', rootBeadId: 'root', enabled: true };
    d.workerLaunches.l1 = { id: 'l1', cellId: 'c', beadId: 'b', state: 'uncertain', sessionId: 'missing', createdAt: 0 };
    d.workerLaunches.l2 = { id: 'l2', cellId: 'c', beadId: 'b', state: 'reserved', sessionId: null, createdAt: 0 };
    d.workerLaunches.l3 = { id: 'l3', cellId: 'c', beadId: 'b', state: 'claimed', sessionId: 'gone', createdAt: 0 };
    d.reviews.r1 = { id: 'r1', workBeadId: 'b', state: 'requested', reviewerSessionId: 'missing' };
    d.operations.o1 = { id: 'o1', kind: 'claim', state: 'uncertain', intent: { beadId: 'b' } };
  });
  assert.deepEqual(rt.activeWork(10 * 60 * 1000 + 1), { active: false, work: 0, ciWaits: 0 });
  rt.metadata.mutate((d) => { d.workerLaunches.l4 = { id: 'l4', cellId: 'c', beadId: 'b', state: 'claimed', sessionId: 'live', createdAt: 0 }; });
  assert.equal(rt.activeWork(10 * 60 * 1000 + 1).active, false, 'a claimed launch whose claim was released does not count');
  rt.metadata.mutate((d) => { d.workerLaunches.l5 = { id: 'l5', cellId: 'c', beadId: 'b', state: 'binding', sessionId: 'live', createdAt: 0 }; });
  assert.equal(rt.activeWork(10 * 60 * 1000 + 1).active, false, 'a launch stuck past its start window does not count');
  assert.equal(rt.activeWork(1000).work, 1);
  rt.metadata.mutate((d) => { delete d.workerLaunches.l4; delete d.workerLaunches.l5; d.reviews.r2 = { id: 'r2', workBeadId: 'b', state: 'in_review', reviewerSessionId: 'live' }; });
  assert.deepEqual(rt.activeWork(10 * 60 * 1000 + 1), { active: true, work: 1, ciWaits: 0 });
  rt.metadata.mutate((d) => { delete d.reviews.r2; });
  assert.equal(rt.activeWork(1000).active, true, 'a launch still starting within its window counts');
  graph = buildGraph([raw('root'), raw('a', 'root', { status: 'in_progress', assignee: 'aw:live' }), raw('b', 'root')]);
  assert.deepEqual(rt.activeWork(10 * 60 * 1000 + 1), { active: true, work: 1, ciWaits: 0 });
  graph = buildGraph([raw('root'), raw('a', 'root'), raw('b', 'root')]);
  rt.metadata.mutate((d) => { d.bindings.c = [{ beadId: 'b', sessionId: 'sleepy', role: 'investigator', active: true, autoEnrolled: true }]; });
  assert.equal(rt.activeWork(10 * 60 * 1000 + 1).active, false, 'a dormant helper does not count');
  rt.metadata.mutate((d) => { d.bindings.c[0].sessionId = 'live'; });
  assert.equal(rt.activeWork(10 * 60 * 1000 + 1).work, 1, 'a running helper counts');
  rt.metadata.mutate((d) => { d.bindings.c = []; d.cells.c.enabled = false; d.ciWaits = { b: { id: 'w', cellId: 'c', beadId: 'b', state: 'pending' } }; d.reviews.r3 = { id: 'r3', workBeadId: 'b', state: 'in_review', reviewerSessionId: 'live' }; });
  assert.deepEqual(rt.activeWork(10 * 60 * 1000 + 1), { active: false, work: 0, ciWaits: 0 }, 'a disabled hive does not count');
  rt.metadata.mutate((d) => { d.cells.c.enabled = true; });
  assert.deepEqual(rt.activeWork(10 * 60 * 1000 + 1), { active: true, work: 1, ciWaits: 1 });
  rt.metadata.mutate((d) => { delete d.reviews.r3; d.ciWaits.b.deadline = 10 * 60 * 1000; });
  assert.deepEqual(rt.activeWork(10 * 60 * 1000 + 1), { active: false, work: 0, ciWaits: 0 }, 'an expired CI wait does not count');
});
