import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBeadsAdapter } from '../server/beads.js';
import { RuntimeLifetime } from '../server/lifetime.js';

async function adapterFixture(t, { assertCurrent } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-claim-fence-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const exe = path.join(root, 'bd');
  fs.writeFileSync(exe, '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  const workspaceDir = path.join(root, 'store');
  fs.mkdirSync(path.join(workspaceDir, '.beads'), { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, '.beads', 'metadata.json'), JSON.stringify({ backend: 'dolt', dolt_mode: 'embedded' }));
  const live = { a: { id: 'a', status: 'open', assignee: null }, b: { id: 'b', status: 'open', assignee: null } };
  const calls = [];
  let badExport = false;
  const adapter = createBeadsAdapter({ workspaceDir, homeDir: path.join(root, 'home'), scratchDir: path.join(root, 'scratch'), configuredPath: () => exe, assertCurrent,
    execFile(file, argv, options, callback) {
      const args = argv.filter((a) => a !== '--readonly');
      calls.push(argv);
      setImmediate(() => {
        if (args[0] === '--version') return callback(null, 'bd version 1.3.4', '');
        if (args[0] === 'schema') return callback(null, '{"schema_version":1}', '');
        if (args[0] === 'info') return callback(null, '{}', '');
        if (args[0] === 'export') return callback(null, badExport ? 'not-json' : Object.values(live).map((b) => JSON.stringify(b)).join('\n'), '');
        if (args[0] === 'update') {
          const b = live[args[1]];
          if (args.includes('--if-assignee') && (b.assignee || '') !== args[args.indexOf('--if-assignee') + 1]) return callback(Object.assign(new Error('guard mismatch'), { code: 13 }), '', 'guard mismatch');
          if (args.includes('--if-status') && b.status !== args[args.indexOf('--if-status') + 1]) return callback(Object.assign(new Error('guard mismatch'), { code: 13 }), '', 'guard mismatch');
          if (args.includes('--assignee')) b.assignee = args[args.indexOf('--assignee') + 1];
          if (args.includes('--status')) b.status = args[args.indexOf('--status') + 1];
          return callback(null, JSON.stringify(b), '');
        }
        callback(new Error(`unexpected ${args}`), '', 'unexpected');
      });
      return { stdin: { end() {} } };
    },
  });
  assert.equal((await adapter.probe()).state, 'ready');
  calls.length = 0;
  return { adapter, live, calls, corrupt: () => { badExport = true; } };
}

test('claim export, capacity check and guarded write share one adapter queue job', async (t) => {
  const f = await adapterFixture(t);
  let checked = false;
  await Promise.all([f.adapter.claim('a', 'aw:worker', ({ issues }) => {
    assert.equal(issues.find((b) => b.id === 'b').status, 'open');
    assert.equal(f.calls.length, 1);
    checked = true;
  }), f.adapter.update('b', { status: 'blocked' }, 'aw:queen')]);
  assert(checked);
  assert.deepEqual(f.calls.map((a) => a.filter((s) => s !== '--readonly').slice(0, 2)), [['export', '--all'], ['update', 'a'], ['update', 'b']]);
  assert.equal(f.live.a.assignee, 'aw:worker');
  assert.equal(f.live.a.status, 'in_progress');
  assert(f.calls[1].includes('--if-assignee'));
  assert.equal(f.calls[1][f.calls[1].indexOf('--if-assignee') + 1], '');
});

test('retirement after a queued claim export prevents its write and later queued commands', async t => {
  const lifetime = new RuntimeLifetime();
  const f = await adapterFixture(t, { assertCurrent: () => lifetime.assertCurrent() });
  const claim = f.adapter.claim('a', 'aw:worker', () => lifetime.stop());
  const update = f.adapter.update('b', { status: 'blocked' }, 'aw:queen');
  const outcomes = await Promise.allSettled([claim, update]);
  assert.deepEqual(outcomes.map(row => row.reason?.code), ['runtime-stopped', 'runtime-stopped']);
  assert.equal(f.live.a.assignee, null);
  assert.equal(f.live.b.status, 'open');
  assert.deepEqual(f.calls.map(args => args.filter(s => s !== '--readonly').slice(0, 2)), [['export', '--all']]);
});

test('a failed capacity check and malformed export each refuse before the claim write', async (t) => {
  const f = await adapterFixture(t);
  await assert.rejects(f.adapter.claim('a', 'aw:worker', () => { throw new Error('capacity full'); }), /capacity full/);
  assert.equal(f.live.a.assignee, null);
  assert.equal(f.calls.length, 1);
  f.corrupt();
  await assert.rejects(f.adapter.claim('a', 'aw:worker'), /incomplete/);
  assert.equal(f.live.a.assignee, null);
  assert.equal(f.calls.length, 2);
});

test('a foreign claim read at the fence is preserved and nothing is written', async (t) => {
  const f = await adapterFixture(t);
  f.live.a.assignee = 'aw:replacement';
  await assert.rejects(f.adapter.claim('a', 'aw:old'), /replacement/);
  assert.equal(f.calls.length, 1);
  assert.equal(f.live.a.assignee, 'aw:replacement');
});

test('a start update carries both native guards and preserves a holder replaced after export', async (t) => {
  const f = await adapterFixture(t);
  f.live.a.assignee = 'aw:worker';
  f.live.a.status = 'blocked';
  await assert.rejects(f.adapter.update('a', { status: 'in_progress' }, 'aw:worker', ({ issues }) => {
    const before = issues.find((b) => b.id === 'a');
    f.live.a.assignee = 'aw:replacement';
    return { assignee: before.assignee, status: before.status };
  }), /guard mismatch/);
  assert.equal(f.live.a.assignee, 'aw:replacement');
  assert.equal(f.live.a.status, 'blocked');
  assert(f.calls[1].includes('--if-status'));
  assert.equal(f.calls[1][f.calls[1].indexOf('--if-status') + 1], 'blocked');
});


test('a start update preserves a status changed after its admission export', async (t) => {
  const f = await adapterFixture(t);
  f.live.a.assignee = 'aw:worker';
  f.live.a.status = 'blocked';
  await assert.rejects(f.adapter.update('a', { status: 'in_progress' }, 'aw:worker', ({ issues }) => {
    const before = issues.find((b) => b.id === 'a');
    f.live.a.status = 'deferred';
    return { assignee: before.assignee, status: before.status };
  }), /guard mismatch/);
  assert.equal(f.live.a.status, 'deferred');
});

test('display snapshots may tolerate malformed lines but admission snapshots reject the incomplete export', async (t) => {
  const f = await adapterFixture(t);
  f.corrupt();
  assert.deepEqual((await f.adapter.loadSnapshot()).beads, {});
  await assert.rejects(f.adapter.loadSnapshot({ all: true }), /incomplete/);
  assert.equal(f.calls.filter((a) => a.includes('update')).length, 0);
});
