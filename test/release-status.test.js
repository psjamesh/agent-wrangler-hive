import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile as nodeExecFile, execFileSync, spawnSync } from 'node:child_process';
import { buildContext } from '../server/tools.js';
import { createBeadsAdapter } from '../server/beads.js';
import { MetadataStore } from '../server/metadata-store.js';
import { createSnapshotCache } from '../server/snapshots.js';
import { releaseBead, humanRelease, claimBead, settleOne, needsSettling, createBeads, updateBead, reconcileForAgent, deleteBeads } from '../server/ops.js';

const executable = process.env.HIVE_TEST_BD || '/opt/homebrew/bin/bd';
const sessionId = '00000000-0000-4000-8000-000000000001';
const who = `aw:${sessionId}`;

async function fixture(t, status = 'in_progress') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-release-'));
  const control = { before: null, after: null, calls: [] };
  let nativeOptions;
  const execFile = (exe, args, options, callback) => {
    nativeOptions = options;
    control.calls.push(args);
    try { control.before?.(args, options); } catch (err) {
      queueMicrotask(() => callback(err, '', 'injected failure'));
      return { stdin: { end() {} } };
    }
    return nodeExecFile(exe, args, options, (err, stdout, stderr) => {
      try { control.after?.(args, options, err); } catch (failure) { err = failure; }
      callback(err, stdout, stderr);
    });
  };
  const beads = createBeadsAdapter({ execFile, configuredPath: () => executable, workspaceDir: path.join(dir, 'workspace'), homeDir: path.join(dir, 'home'), scratchDir: path.join(dir, 'scratch') });
  const initialized = await beads.initialize();
  assert.equal(initialized.state.state, 'ready');
  const { ids } = await beads.createMany({ nodes: [{ key: 'root', title: 'Root' }, { key: 'work', title: 'Work', parentKey: 'root' }] }, who, 'op_fixture');
  await beads.claim(ids.work, who);
  await beads.update(ids.work, { status }, who);
  const metadata = new MetadataStore({ file: path.join(dir, 'metadata.json') });
  const cell = { id: 'cell_test', rootBeadId: ids.root, enabled: true };
  metadata.mutate((d) => { d.cells[cell.id] = cell; });
  const rt = { beads, metadata, pendingParticipants: new Map(), snapshots: createSnapshotCache({ beads }), log() {} };
  t.after(async () => { await rt.snapshots.refresh(); fs.rmSync(dir, { recursive: true, force: true }); });
  await rt.snapshots.refresh();
  const actor = { sessionId, cell, role: 'worker', cells: [{ cell, role: 'worker' }] };
  const host = { tasks: { get: () => ({}), forSession: () => ({ taskId: 'task_test' }) }, sessions: { forTask: () => [], get: () => null } };
  metadata.mutate((d) => { d.bindings[cell.id] = [{ sessionId, active: true }]; });
  return { rt, actor, host, id: ids.work, dir, control, native: (args) => JSON.parse(execFileSync(executable, args, { ...nativeOptions, encoding: 'utf8' })) };
}

for (const status of ['open', 'in_progress', 'blocked', 'deferred']) {
  test(`release preserves ${status} in a native embedded store`, async (t) => {
    const { rt, actor, id } = await fixture(t, status);
    await releaseBead(rt, actor, { bead_id: id });
    const after = await rt.beads.show(id);
    assert.equal(after.status, status);
    assert.ok(!after.assignee);
    const op = Object.values(rt.metadata.read().operations)[0];
    assert.equal(op.state, 'applied');
    assert.equal(op.intent.status, status);
  });
}

test('explicit release status overrides the prior status', async (t) => {
  const { rt, actor, id } = await fixture(t, 'blocked');
  await releaseBead(rt, actor, { bead_id: id, status: 'deferred' });
  assert.equal((await rt.beads.show(id)).status, 'deferred');
});

test('human release also preserves the prior status', async (t) => {
  const { rt, id } = await fixture(t, 'deferred');
  await humanRelease(rt, { beadId: id, reason: 'Holder finished review' });
  assert.equal((await rt.beads.show(id)).status, 'deferred');
});

test('recovery does not accept a released item in the wrong status', async (t) => {
  const { rt, id } = await fixture(t);
  rt.metadata.mutate((d) => { d.operations.op_crash = { id: 'op_crash', kind: 'release', cellId: 'cell_test', state: 'pending', updatedAt: 0, beadIds: [id], intent: { beadId: id, holder: who, priorStatus: 'in_progress', status: 'in_progress' } }; });
  await rt.beads.release(id, who, { holder: who });
  assert.equal(needsSettling(rt.metadata.read().operations.op_crash), true);
  assert.equal((await settleOne(rt, 'op_crash')).settled, false);
  assert.equal(rt.metadata.read().operations.op_crash.state, 'pending');
  await rt.beads.update(id, { status: 'in_progress' }, who);
  assert.equal((await settleOne(rt, 'op_crash')).settled, true);
});

test('an unresolved release fences new claims', async (t) => {
  const { rt, actor, id } = await fixture(t);
  rt.metadata.mutate((d) => { d.operations.op_crash = { id: 'op_crash', kind: 'release', state: 'partial', beadIds: [id], intent: { beadId: id, holder: who, priorStatus: 'in_progress', status: 'in_progress' } }; });
  await rt.beads.release(id, who, { holder: who });
  await assert.rejects(claimBead(rt, actor, { bead_id: id }), { code: 'busy' });
  assert.ok(!(await rt.beads.show(id)).assignee);
});

for (const step of ['prepare', 'unclaim', 'restore']) {
  for (const timing of ['before', 'after']) {
    test(`native failure ${timing} ${step} remains durable and is never replayed`, async (t) => {
      const f = await fixture(t, 'blocked');
      let fired = false;
      const match = (args) => step === 'unclaim' ? args[0] === 'unclaim'
        : args[0] === 'update' && args[args.indexOf('--status') + 1] === (step === 'prepare' ? 'open' : 'blocked');
      f.control[timing] = (args) => {
        if (!fired && match(args)) { fired = true; throw Object.assign(new Error('injected native failure'), { code: timing === 'before' ? 1 : null }); }
      };
      await assert.rejects(releaseBead(f.rt, f.actor, { bead_id: f.id }), { code: 'uncertain' });
      f.control.before = null;
      f.control.after = null;
      await f.rt.snapshots.refresh();
      const metadata = new MetadataStore({ file: f.rt.metadata.file });
      const rt = { ...f.rt, metadata };
      const op = Object.values(metadata.read().operations)[0];
      const unclaims = f.control.calls.filter((args) => args[0] === 'unclaim').length;
      const current = await rt.beads.show(f.id);
      const settled = await settleOne(rt, op.id);
      assert.equal(settled.settled, !current.assignee && current.status === 'blocked');
      assert.equal(f.control.calls.filter((args) => args[0] === 'unclaim').length, unclaims);
      const context = await buildContext(rt, f.host, f.actor);
      assert.equal(context.attention.operations_to_reconcile.length, settled.settled ? 0 : 1);
      if (!settled.settled) {
        assert.equal(context.attention.operations_to_reconcile[0].release_step.step, step);
        await assert.rejects(claimBead(rt, f.actor, { bead_id: f.id }), { code: 'busy' });
      }
    });
  }
}

test('context lists in-progress work without an owner after release', async (t) => {
  const f = await fixture(t);
  await releaseBead(f.rt, f.actor, { bead_id: f.id });
  const context = await buildContext(f.rt, f.host, f.actor);
  assert.deepEqual(context.attention.in_progress_without_owner.map((b) => b.bead_id), [f.id]);
});

test('holder guards reject another actor and stale holders without changing status', async (t) => {
  const f = await fixture(t, 'blocked');
  const other = 'aw:00000000-0000-4000-8000-000000000002';
  await assert.rejects(releaseBead(f.rt, { ...f.actor, sessionId: other.slice(3) }, { bead_id: f.id }), { code: 'conflict' });
  await assert.rejects(f.rt.beads.release(f.id, who, { holder: other, priorStatus: 'blocked', status: 'blocked' }), { code: 'conflict' });
  assert.equal((await f.rt.beads.show(f.id)).status, 'blocked');
  assert.equal((await f.rt.beads.show(f.id)).assignee, who);
});

test('a new native holder between unclaim and restore is preserved', async (t) => {
  const f = await fixture(t);
  const other = 'aw:00000000-0000-4000-8000-000000000002';
  let raced = false;
  f.control.before = (args, options) => {
    if (!raced && args[0] === 'update' && args.includes('--if-assignee') && args[args.indexOf('--if-assignee') + 1] === '') {
      raced = true;
      execFileSync(executable, ['update', f.id, '--if-assignee', '', '--assignee', other, '--status', 'in_progress', '--json', '--actor', other], options);
    }
  };
  await assert.rejects(releaseBead(f.rt, f.actor, { bead_id: f.id }), { code: 'uncertain' });
  const after = await f.rt.beads.show(f.id);
  assert.equal(after.assignee, other);
  assert.equal((await settleOne(f.rt, Object.keys(f.rt.metadata.read().operations)[0])).settled, false);
});

test('native unclaim clears the lease and started_at and records its event', async (t) => {
  const f = await fixture(t);
  f.native(['heartbeat', f.id, '--actor', who, '--json']);
  const leases = () => JSON.parse(execFileSync(process.env.HIVE_TEST_DOLT || '/opt/homebrew/bin/dolt', ['--data-dir', path.join(f.dir, 'workspace', '.beads', 'embeddeddolt'), 'sql', '-q', `SELECT COUNT(*) AS n FROM hive.leases WHERE issue_id = '${f.id}'`, '-r', 'json'], { encoding: 'utf8', cwd: f.dir, env: { ...process.env, HOME: path.join(f.dir, 'home') } })).rows[0].n;
  assert.equal(leases(), 1);
  await releaseBead(f.rt, f.actor, { bead_id: f.id, status: 'open' });
  await f.rt.snapshots.refresh();
  const after = await f.rt.beads.show(f.id);
  assert.ok(!after.started_at);
  assert.equal(leases(), 0);
  const events = f.native(['--readonly', 'history', f.id, '--events', '--json']);
  assert.ok(events.some((event) => event.event_type === 'unclaimed'));
  await f.rt.beads.claim(f.id, who);
  f.native(['heartbeat', f.id, '--actor', who, '--json']);
  assert.equal(leases(), 1);
  await releaseBead(f.rt, f.actor, { bead_id: f.id });
  await f.rt.snapshots.refresh();
  assert.equal(leases(), 0);
  const restored = await f.rt.beads.show(f.id);
  assert.equal(restored.status, 'in_progress');
  assert.ok(!restored.assignee);
  assert.ok(restored.started_at);
});

test('process crashes at every journal and native boundary remain reconcilable after restart', async (t) => {
  const f = await fixture(t, 'blocked');
  const moduleUrls = Object.fromEntries(['beads', 'metadata-store', 'snapshots', 'ops'].map((name) => [name, new URL(`../server/${name}.js`, import.meta.url).href]));
  const boundaries = ['journal', ...['prepare', 'unclaim', 'restore'].flatMap((step) => [`${step}:started`, `${step}:native`, `${step}:done`])];
  for (const boundary of boundaries) {
    await t.test(boundary, async () => {
      const { ids } = await f.rt.beads.createMany({ nodes: [{ key: 'work', title: boundary, parentId: f.actor.cell.rootBeadId }] }, who, `op_${boundary.replace(':', '_')}`);
      const id = ids.work;
      await f.rt.beads.claim(id, who);
      await f.rt.beads.update(id, { status: 'blocked' }, who);
      const script = `
        import path from 'node:path';
        import { execFile } from 'node:child_process';
        const urls = ${JSON.stringify(moduleUrls)};
        const { createBeadsAdapter } = await import(urls.beads);
        const { MetadataStore } = await import(urls['metadata-store']);
        const { createSnapshotCache } = await import(urls.snapshots);
        const { releaseBead } = await import(urls.ops);
        const dir = ${JSON.stringify(f.dir)}, boundary = ${JSON.stringify(boundary)};
        const beads = createBeadsAdapter({ configuredPath: () => ${JSON.stringify(executable)},
          workspaceDir: path.join(dir, 'workspace'), homeDir: path.join(dir, 'home'), scratchDir: path.join(dir, 'scratch'),
          execFile(exe, args, options, cb) {
            return execFile(exe, args, options, (err, stdout, stderr) => {
              const step = args[0] === 'unclaim' ? 'unclaim' : args[0] === 'update' && args.includes('--status')
                ? args[args.indexOf('--status') + 1] === 'open' ? 'prepare' : 'restore' : null;
              if (!err && boundary === step + ':native') process.exit(77);
              cb(err, stdout, stderr);
            });
          },
        });
        await beads.probe();
        const metadata = new MetadataStore({ file: path.join(dir, 'metadata.json') });
        const rt = { beads, metadata, snapshots: createSnapshotCache({ beads }), log() {} };
        await rt.snapshots.refresh();
        const mutate = metadata.mutate.bind(metadata);
        metadata.mutate = (fn) => {
          const result = mutate(fn);
          const op = Object.values(metadata.read().operations).find((op) => op.intent?.beadId === ${JSON.stringify(id)});
          if (op && (boundary === 'journal' && !op.releaseStep || boundary === op.releaseStep?.step + ':' + op.releaseStep?.state)) process.exit(77);
          return result;
        };
        const cell = metadata.cell('cell_test');
        await releaseBead(rt, { sessionId: ${JSON.stringify(sessionId)}, cell, cells: [{ cell, role: 'worker' }] }, { bead_id: ${JSON.stringify(id)} });
        process.exit(99);
      `;
      const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 30000 });
      assert.equal(child.status, 77, child.stderr);
      f.rt.metadata = new MetadataStore({ file: f.rt.metadata.file });
      await f.rt.snapshots.refresh();
      const op = Object.values(f.rt.metadata.read().operations).find((op) => op.intent?.beadId === id);
      assert.equal(op.state, 'pending');
      assert.equal(needsSettling(op), true);
      const before = await f.rt.beads.show(id);
      const calls = f.control.calls.length;
      const settled = await settleOne(f.rt, op.id);
      assert.equal(settled.settled, !before.assignee && before.status === 'blocked');
      assert.ok(f.control.calls.slice(calls).every((args) => args[0] === '--readonly'));
      assert.deepEqual(await f.rt.beads.show(id), before);
      const context = await buildContext(f.rt, f.host, f.actor);
      assert.equal(context.attention.operations_to_reconcile.some((item) => item.op_id === op.id), !settled.settled);
    });
  }
});

test('only a coordinator with a reason can release another holder', async (t) => {
  const f = await fixture(t, 'deferred');
  const sessionId = '00000000-0000-4000-8000-000000000002';
  const actor = { ...f.actor, sessionId };
  await assert.rejects(releaseBead(f.rt, actor, { bead_id: f.id, force: true, reason: 'checked' }), { code: 'access' });
  actor.cells = [{ cell: actor.cell, role: 'coordinator' }];
  await assert.rejects(releaseBead(f.rt, actor, { bead_id: f.id, force: true }), { code: 'invalid' });
  await releaseBead(f.rt, actor, { bead_id: f.id, force: true, reason: 'Holder confirmed handover' });
  const unclaim = f.control.calls.find((args) => args[0] === 'unclaim');
  assert.equal(unclaim[unclaim.indexOf('--if-assignee') + 1], who);
  assert.ok(!unclaim.includes('--force'));
  assert.equal((await f.rt.beads.show(f.id)).status, 'deferred');
});

for (const failedReceipt of ['unclaim', 'applied']) {
  test(`metadata failure recording ${failedReceipt} leaves a recoverable release`, async (t) => {
    const f = await fixture(t, 'deferred');
    const mutate = f.rt.metadata.mutate.bind(f.rt.metadata);
    let fired = false;
    f.rt.metadata.mutate = (fn) => mutate((d) => {
      const result = fn(d);
      const op = Object.values(d.operations)[0];
      if (!fired && (failedReceipt === 'applied' ? op?.state === 'applied' : op?.releaseStep?.step === 'unclaim' && op.releaseStep.state === 'done')) {
        fired = true;
        throw new Error('metadata disk failure');
      }
      return result;
    });
    await assert.rejects(releaseBead(f.rt, f.actor, { bead_id: f.id }), { code: failedReceipt === 'applied' ? 'partial' : 'uncertain' });
    f.rt.metadata = new MetadataStore({ file: f.rt.metadata.file });
    const op = Object.values(f.rt.metadata.read().operations)[0];
    assert.ok(needsSettling(op));
    const after = await f.rt.beads.show(f.id);
    assert.ok(!after.assignee);
    assert.equal((await settleOne(f.rt, op.id)).settled, failedReceipt === 'applied');
    assert.equal(after.status, failedReceipt === 'applied' ? 'deferred' : 'open');
  });
}

test('other adapter commands cannot enter between release steps', async (t) => {
  const f = await fixture(t, 'blocked');
  let queued;
  f.control.before = (args) => {
    if (!queued && args[0] === 'update' && args.includes('--if-status')) queued = f.rt.beads.show(f.id);
  };
  await releaseBead(f.rt, f.actor, { bead_id: f.id });
  assert.equal((await queued).status, 'blocked');
  assert.ok(!(await queued).assignee);
});


function pendingRelease(f) {
  f.rt.metadata.mutate((d) => {
    d.operations.op_interrupted = { id: 'op_interrupted', kind: 'release', cellId: f.actor.cell.id, state: 'pending',
      updatedAt: Date.now(), beadIds: [f.id], releaseStep: { step: 'prepare', state: 'done' },
      intent: { beadId: f.id, holder: who, priorStatus: 'blocked', status: 'blocked' } };
  });
}

test('R1 compound creation fences existing link endpoints and parents before native writes', async (t) => {
  const f = await fixture(t, 'blocked');
  let interrupted = false;
  f.control.after = (args) => {
    if (!interrupted && args[0] === 'update' && args.includes('--if-status')) {
      interrupted = true;
      throw Object.assign(new Error('crash after prepare'), { signal: 'SIGKILL' });
    }
  };
  await assert.rejects(releaseBead(f.rt, f.actor, { bead_id: f.id }), { code: 'uncertain' });
  f.control.after = null;
  assert.equal((await f.rt.beads.show(f.id)).status, 'open');
  await assert.rejects(updateBead(f.rt, f.actor, { bead_id: f.id, summary: 'must refuse' }), { code: 'busy' });
  const before = await f.rt.beads.loadSnapshot();
  const calls = f.control.calls.length;
  for (const input of [
    { beads: [{ ref: 'new', title: 'Dependent endpoint' }], links: [{ dependent: f.id, prerequisite: 'new' }] },
    { beads: [{ ref: 'new', title: 'Prerequisite endpoint' }], links: [{ dependent: 'new', prerequisite: f.id }] },
    { beads: [{ ref: 'new', title: 'Existing endpoints' }], links: [{ dependent: f.id, prerequisite: f.actor.cell.rootBeadId }] },
    { beads: [{ ref: 'new', title: 'Existing parent', parent: f.id }] },
  ]) await assert.rejects(createBeads(f.rt, f.actor, input), { code: 'busy' });
  assert.equal(f.control.calls.length, calls);
  assert.deepEqual(await f.rt.beads.loadSnapshot(), before);
  assert.equal(Object.values(f.rt.metadata.read().operations).length, 1);
});

test('R1 reparenting fences both the old and new existing parent', async (t) => {
  const f = await fixture(t, 'blocked');
  const { ids } = await f.rt.beads.createMany({ nodes: [
    { key: 'inside', title: 'Inside', parentId: f.id },
    { key: 'outside', title: 'Outside', parentId: f.actor.cell.rootBeadId },
  ] }, who, 'op_children');
  await f.rt.snapshots.refresh();
  pendingRelease(f);
  await assert.rejects(updateBead(f.rt, f.actor, { bead_id: ids.outside, parent_id: f.id }), { code: 'busy' });
  await assert.rejects(updateBead(f.rt, f.actor, { bead_id: ids.inside, parent_id: f.actor.cell.rootBeadId }), { code: 'busy' });
  assert.equal((await f.rt.beads.loadSnapshot()).beads[ids.inside].parentId, f.id);
  await f.rt.beads.update(ids.outside, { parentId: f.id }, who);
  await f.rt.snapshots.refresh();
  await assert.rejects(updateBead(f.rt, f.actor, { bead_id: ids.outside, parent_id: f.actor.cell.rootBeadId }), { code: 'busy' });
});

test('review control: unrelated creation stays writable and reconciliation clears the fence', async (t) => {
  const f = await fixture(t, 'blocked');
  pendingRelease(f);
  const result = await createBeads(f.rt, f.actor, { beads: [{ ref: 'new', title: 'Unrelated' }] });
  await updateBead(f.rt, f.actor, { bead_id: result.ids.new, summary: 'Unrelated writes work' });
  f.rt.changed = () => {};
  await reconcileForAgent(f.rt, { ...f.actor, role: 'queen' }, { op_id: 'op_interrupted', verdict: 'not-applied', note: 'Verified no unclaim happened' });
  await updateBead(f.rt, f.actor, { bead_id: f.id, summary: 'Fence cleared' });
  assert.equal(f.rt.metadata.read().operations.op_interrupted.state, 'resolved');
});

for (const status of ['in_progress', 'blocked']) {
  test(`R2 first-step holder mismatch from ${status} leaves the new holder writable`, async (t) => {
    const f = await fixture(t, status);
    const otherId = '00000000-0000-4000-8000-000000000002';
    const other = `aw:${otherId}`;
    let raced = false;
    f.control.before = (args, options) => {
      if (!raced && (status === 'in_progress' ? args[0] === 'unclaim' : args[0] === 'update' && args.includes('--if-status'))) {
        raced = true;
        if (status === 'blocked') execFileSync(executable, ['update', f.id, '--status', 'open', '--json', '--actor', who], options);
        execFileSync(executable, ['unclaim', f.id, '--if-assignee', who, '--json', '--actor', who], options);
        execFileSync(executable, ['update', f.id, '--if-assignee', '', '--assignee', other, '--status', 'in_progress', '--json', '--actor', other], options);
      }
    };
    await assert.rejects(releaseBead(f.rt, f.actor, { bead_id: f.id }), { code: 'conflict', noWrite: true });
    f.control.before = null;
    assert.equal((await f.rt.beads.show(f.id)).assignee, other);
    await f.rt.snapshots.refresh();
    const op = Object.values(f.rt.metadata.read().operations)[0];
    assert.equal(op.state, 'error');
    assert.equal(needsSettling(op), false);
    await updateBead(f.rt, { ...f.actor, sessionId: otherId }, { bead_id: f.id, summary: 'New owner working' });
    assert.equal((await buildContext(f.rt, f.host, f.actor)).attention.operations_to_reconcile.length, 0);
  });
}

test('review control: blocked and deferred releases retain native cleanup and unclaimed events', async (t) => {
  const f = await fixture(t, 'blocked');
  for (const status of ['blocked', 'deferred']) {
    await f.rt.beads.update(f.id, { status: 'in_progress' }, who);
    f.native(['heartbeat', f.id, '--actor', who, '--json']);
    await f.rt.beads.update(f.id, { status }, who);
    const leases = () => JSON.parse(execFileSync(process.env.HIVE_TEST_DOLT || '/opt/homebrew/bin/dolt', ['--data-dir', path.join(f.dir, 'workspace', '.beads', 'embeddeddolt'), 'sql', '-q', `SELECT COUNT(*) AS n FROM hive.leases WHERE issue_id = '${f.id}'`, '-r', 'json'], { encoding: 'utf8', cwd: f.dir, env: { ...process.env, HOME: path.join(f.dir, 'home') } })).rows[0].n;
    assert.equal(leases(), 0);
    assert.ok((await f.rt.beads.show(f.id)).started_at);
    await releaseBead(f.rt, f.actor, { bead_id: f.id });
    const after = await f.rt.beads.show(f.id);
    assert.equal(after.status, status);
    assert.ok(!after.assignee);
    assert.ok(!after.started_at);
    await f.rt.snapshots.refresh();
    assert.equal(leases(), 0);
    assert.ok(f.native(['--readonly', 'history', f.id, '--events', '--json']).some((event) => event.event_type === 'unclaimed'));
    await f.rt.beads.claim(f.id, who);
  }
});

test('R2 a holder mismatch after successful prepare still requires reconciliation', async (t) => {
  const f = await fixture(t, 'blocked');
  const other = 'aw:00000000-0000-4000-8000-000000000002';
  let raced = false;
  f.control.before = (args, options) => {
    if (!raced && args[0] === 'unclaim') {
      raced = true;
      execFileSync(executable, ['unclaim', f.id, '--if-assignee', who, '--json', '--actor', who], options);
      execFileSync(executable, ['update', f.id, '--if-assignee', '', '--assignee', other, '--status', 'in_progress', '--json', '--actor', other], options);
    }
  };
  await assert.rejects(releaseBead(f.rt, f.actor, { bead_id: f.id }), { code: 'uncertain', noWrite: true });
  f.control.before = null;
  assert.equal((await f.rt.beads.show(f.id)).assignee, other);
  const op = Object.values(f.rt.metadata.read().operations)[0];
  assert.equal(needsSettling(op), true);
  await assert.rejects(updateBead(f.rt, f.actor, { bead_id: f.id, summary: 'Must reconcile the prepared release' }), { code: 'busy' });
});


test('R1 deletion respects a fenced existing parent at preview and execution', async (t) => {
  const f = await fixture(t, 'blocked');
  f.rt.metadata.mutate((d) => { d.cells[f.actor.cell.id].queenSessionId = sessionId; });
  const actor = { ...f.actor, role: 'queen' };
  const { ids } = await f.rt.beads.createMany({ nodes: [{ key: 'child', title: 'Removable child', parentId: f.id }] }, who, 'op_child');
  await f.rt.snapshots.refresh();
  const input = { bead_ids: [ids.child], reason: 'Remove fixture child' };
  const before = await deleteBeads(f.rt, actor, input);
  assert.equal(before.can_delete, true);
  pendingRelease(f);
  const preview = await deleteBeads(f.rt, actor, input);
  assert.equal(preview.can_delete, false);
  assert.ok(preview.problems.some((problem) => problem.includes('op_interrupted')));
  await assert.rejects(deleteBeads(f.rt, actor, { ...input, execute: true, confirm_token: before.confirm_token }), { code: 'busy' });
  assert.ok(await f.rt.beads.show(ids.child));
});

test('R2 an ambiguous verification mismatch after native unclaim remains uncertain', async (t) => {
  const f = await fixture(t);
  let fired = false;
  f.control.after = (args) => {
    if (!fired && args[0] === 'unclaim') {
      fired = true;
      throw Object.assign(new Error('verification mismatch after native commit'), { code: 1 });
    }
  };
  await assert.rejects(releaseBead(f.rt, f.actor, { bead_id: f.id }), (err) => err.code === 'uncertain' && !err.noWrite);
  f.control.after = null;
  assert.ok(!(await f.rt.beads.show(f.id)).assignee);
  assert.equal((await f.rt.beads.show(f.id)).status, 'open');
  assert.equal(needsSettling(Object.values(f.rt.metadata.read().operations)[0]), true);
});

for (const status of ['open', 'in_progress', 'blocked', 'deferred']) {
  test(`archive cleanup preserves ${status} with the native release sequence`, async (t) => {
    const { releaseArchivedClaims } = await import('../server/archived-claims.js');
    const { rt, host, id } = await fixture(t, status);
    host.sessions.get = (sid) => sid === sessionId ? { sessionId, archived: true } : null;
    rt.host = host;
    await releaseArchivedClaims(rt, host, sessionId);
    const after = await rt.beads.show(id);
    assert.equal(after.status, status);
    assert.ok(!after.assignee);
    assert.equal(Object.values(rt.metadata.read().operations)[0].state, 'applied');
  });
}

test('native archive cleanup does not write when the session is restored during its queued pre-read', async (t) => {
  const { releaseArchivedClaims } = await import('../server/archived-claims.js');
  const { rt, host, id, control } = await fixture(t, 'blocked');
  let archived = true;
  let shows = 0;
  host.sessions.get = (sid) => sid === sessionId ? { sessionId, archived } : null;
  rt.host = host;
  control.calls.length = 0;
  control.before = (args) => { if (args.includes('show') && ++shows === 2) archived = false; };
  await releaseArchivedClaims(rt, host, sessionId);
  control.before = null;
  const after = await rt.beads.show(id);
  assert.equal(after.assignee, who);
  assert.equal(after.status, 'blocked');
  assert.equal(control.calls.some((args) => args.includes('update') || args.includes('unclaim')), false);
});
