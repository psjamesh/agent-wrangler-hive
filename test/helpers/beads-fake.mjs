import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createBeadsAdapter } from '../../server/beads.js';
import { fakeTimers } from './fake-timers.mjs';

const killedError = (signal) => Object.assign(new Error(`killed by ${signal}`), { killed: true, signal, code: null });

export const behave = {
  ok: (stdout = '') => (child, close) => setImmediate(() => { child.emit('exit', 0, null); close(null, stdout, ''); }),
  manual: () => () => {},
  dieOn: (signals) => (child, close) => {
    child.kill = (sig) => {
      child.kills.push(sig);
      if (signals.includes(sig)) setImmediate(() => { child.emit('exit', null, sig); close(killedError(sig), '', 'partial output'); });
      return true;
    };
  },
  pipeHeldOpen: () => (child, close) => {
    child.kill = (sig) => {
      child.kills.push(sig);
      if (sig === 'SIGKILL') setImmediate(() => child.emit('exit', null, sig));
      return true;
    };
    child.stdout.destroy = () => { child.destroyed = true; setImmediate(() => close(killedError('SIGKILL'), '', '')); };
  },
};

export async function hardenedAdapter(t, { clock = fakeTimers(), script = () => behave.ok() } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-hardening-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const exe = path.join(root, 'bd');
  fs.writeFileSync(exe, '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  const workspaceDir = path.join(root, 'store');
  fs.mkdirSync(path.join(workspaceDir, '.beads'), { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, '.beads', 'metadata.json'), JSON.stringify({ backend: 'dolt', dolt_mode: 'embedded' }));
  const spawned = [];
  const logs = [];
  const state = { script };
  const adapter = createBeadsAdapter({
    workspaceDir, homeDir: path.join(root, 'home'), scratchDir: path.join(root, 'scratch'), configuredPath: () => exe,
    timers: clock.timers, log: (line) => logs.push(line),
    execFile(file, argv, options, callback) {
      const args = argv.filter((a) => a !== '--readonly');
      const child = new EventEmitter();
      child.pid = 4000 + spawned.length;
      child.kills = [];
      child.stdin = { end() {} };
      child.stdout = { destroy() {} };
      child.stderr = { destroy() {} };
      child.kill = (sig) => { child.kills.push(sig); return true; };
      let closed = false;
      const close = (err, stdout = '', stderr = '') => {
        if (closed) return;
        closed = true;
        rec.closedAt = clock.now();
        callback(err, stdout, stderr);
      };
      const rec = { args, argv, options, child, at: clock.now(), finish: (stdout = '') => { child.emit('exit', 0, null); close(null, stdout, ''); } };
      spawned.push(rec);
      if (args[0] === '--version') setImmediate(() => close(null, 'bd version 1.3.4', ''));
      else if (args[0] === 'schema') setImmediate(() => close(null, '{"schema_version":1}', ''));
      else if (args[0] === 'info') setImmediate(() => close(null, '{}', ''));
      else state.script(args, rec)(child, close);
      return child;
    },
  });
  assert.equal((await adapter.probe()).state, 'ready');
  spawned.length = 0;
  return { adapter, spawned, logs, clock, state, set script(fn) { state.script = fn; } };
}
