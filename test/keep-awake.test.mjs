import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createKeepAwake, parsePowerSource, CAFFEINATE } from '../server/keep-awake.js';
import { HiveRuntime } from '../server/runtime.js';
import { flush } from './helpers/fake-timers.mjs';

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
  rt.metadata.mutate((d) => { (d.ciWaits ||= {})['hive-a'] = { id: 'w1', state: 'pending' }; });
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
