import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeTimers, flush } from './helpers/fake-timers.mjs';
import { behave, hardenedAdapter } from './helpers/beads-fake.mjs';

test('a read that ignores SIGTERM is killed with SIGKILL and the next command waits until it has closed', async (t) => {
  const clock = fakeTimers();
  const f = await hardenedAdapter(t, { clock, script: (args) => (args[0] === 'export' ? behave.dieOn(['SIGKILL']) : behave.ok('[]')) });
  const read = f.adapter.loadSnapshot().catch((err) => err);
  const next = f.adapter.findByOperation('op_next');
  await flush();
  assert.equal(f.spawned.length, 1);
  assert.equal(f.spawned[0].options.timeout, undefined, 'Hive owns the deadline, not execFile');
  await clock.advance(20000);
  assert.deepEqual(f.spawned[0].child.kills, ['SIGTERM']);
  assert.equal(f.spawned.length, 1, 'no command starts while the timed-out one is still running');
  await clock.advance(3000);
  assert.deepEqual(f.spawned[0].child.kills, ['SIGTERM', 'SIGKILL']);
  const err = await read;
  assert.equal(err.code, 'failed');
  assert.equal(err.timedOut, true);
  assert.match(err.message, /Reading the Beads store timed out \(command bd-\d+ \(export\), pid 4000, queued 0\.0s behind 0, ran 23s, ignored SIGTERM and was killed with SIGKILL, signal SIGKILL\)/);
  assert.equal(err.diagnostics.pid, 4000);
  assert.equal(err.diagnostics.signal, 'SIGKILL');
  assert.equal(err.diagnostics.stderr, 'partial output');
  assert.equal(f.adapter.status.state, 'ready', 'a timeout is not a store fault');
  assert.deepEqual(await next, []);
  assert.equal(f.spawned[1].args[0], 'list');
  assert.ok(f.spawned[1].at >= f.spawned[0].closedAt);
});

test('a child that keeps its pipes open after SIGKILL has its streams destroyed before the slot is freed', async (t) => {
  const clock = fakeTimers();
  const f = await hardenedAdapter(t, { clock, script: (args) => (args[0] === 'export' ? behave.pipeHeldOpen() : behave.ok('[]')) });
  const read = f.adapter.loadSnapshot().catch((err) => err);
  const next = f.adapter.findByOperation('op_next');
  await flush();
  await clock.advance(23000);
  assert.deepEqual(f.spawned[0].child.kills, ['SIGTERM', 'SIGKILL']);
  assert.equal(f.spawned.length, 1);
  assert.equal(f.spawned[0].child.destroyed, undefined);
  await clock.advance(2000);
  assert.equal(f.spawned[0].child.destroyed, true);
  const err = await read;
  assert.match(err.message, /timed out/);
  assert.deepEqual(await next, []);
  assert.ok(f.spawned[1].at >= f.spawned[0].closedAt);
});

test('a child that never exits keeps the queue slot and is reported, never signalled after exit', async (t) => {
  const clock = fakeTimers();
  const f = await hardenedAdapter(t, { clock, script: (args) => (args[0] === 'export' ? behave.manual() : behave.ok('[]')) });
  let settled = false;
  const read = f.adapter.loadSnapshot().catch((err) => err).finally(() => { settled = true; });
  await clock.advance(40000);
  assert.equal(settled, false);
  assert.deepEqual(f.spawned[0].child.kills, ['SIGTERM', 'SIGKILL']);
  assert.ok(f.logs.some((l) => /has not exited .* after SIGKILL; its queue slot stays held/.test(l)));
  f.spawned[0].child.emit('exit', null, 'SIGKILL');
  f.spawned[0].finish();
  await flush();
  assert.equal(settled, true);
  await read;
  assert.deepEqual(f.spawned[0].child.kills, ['SIGTERM', 'SIGKILL']);
});

test('a queued write that expires before it starts is dropped with no later effect', async (t) => {
  const clock = fakeTimers();
  const f = await hardenedAdapter(t, { clock });
  f.script = (args) => (args[1] === 'hive-slow' ? behave.manual() : behave.ok('{"id":"hive-x"}'));
  const slow = f.adapter.close('hive-slow', 'done', 'aw:a').catch((err) => err);
  const doomed = f.adapter.close('hive-doomed', 'done', 'aw:a').catch((err) => err);
  await flush();
  await clock.advance(29000);
  f.spawned[0].finish('{"id":"hive-slow"}');
  await slow;
  await flush();
  assert.equal(f.spawned.at(-1).args[1], 'hive-doomed', 'a job still within its deadline runs');
  await doomed;

  f.script = (args) => (args[1] === 'hive-stuck' ? behave.dieOn(['SIGKILL']) : behave.ok('{"id":"hive-x"}'));
  f.spawned.length = 0;
  const stuck = f.adapter.close('hive-stuck', 'done', 'aw:a').catch((err) => err);
  const behind = f.adapter.close('hive-behind', 'done', 'aw:a').catch((err) => err);
  const late = f.adapter.loadSnapshot().catch((err) => err);
  await flush();
  for (let i = 0; i < 4; i += 1) {
    await clock.advance(33000);
  }
  const stuckErr = await stuck;
  assert.equal(stuckErr.code, 'uncertain');
  const behindResult = await behind;
  assert.equal(behindResult.id, 'hive-x', 'one fully escalated head does not starve the next write');
  assert.ok((await late) && f.spawned.some((s) => s.args[0] === 'export'));

  f.script = (args) => (args[1] === 'hive-wedged' ? behave.manual() : behave.ok('{"id":"hive-x"}'));
  f.spawned.length = 0;
  const wedged = f.adapter.close('hive-wedged', 'done', 'aw:a').catch((err) => err);
  const expiring = f.adapter.close('hive-expiring', 'done', 'aw:a').catch((err) => err);
  await flush();
  await clock.advance(180000, 1000);
  const err = await expiring;
  assert.equal(err.code, 'busy');
  assert.equal(err.noWrite, true);
  assert.equal(err.expired, true);
  assert.match(err.message, /waited 180s in Hive's queue behind 1 other\(s\) and was dropped before it started .*nothing was changed and it is safe to retry/);
  f.spawned[0].child.emit('exit', null, 'SIGKILL');
  f.spawned[0].finish();
  await wedged;
  await clock.advance(5000);
  await f.adapter.findByOperation('op_after');
  assert.equal(f.spawned.some((s) => s.args[1] === 'hive-expiring'), false, 'the expired write never ran');
});

test('a host sleep renews a running command deadline instead of killing it, in either timer order', async (t) => {
  for (const reverse of [false, true]) {
    const clock = fakeTimers();
    const f = await hardenedAdapter(t, { clock, script: (args) => (args[0] === 'export' ? behave.manual() : behave.ok('[]')) });
    const read = f.adapter.loadSnapshot();
    await clock.advance(5000);
    await clock.sleep(900000, { reverse });
    assert.deepEqual(f.spawned[0].child.kills, [], `no signal after wake (reverse=${reverse})`);
    await clock.advance(5000);
    f.spawned[0].finish('');
    const graph = await read;
    assert.ok(graph);
    const d = f.adapter.recentCommands.at(-1);
    assert.equal(d.extensions, 1);
    assert.ok(d.resumeGapMs >= 890000, `resume gap recorded (reverse=${reverse}): ${d.resumeGapMs}`);
  }
});

test('a command that hangs after a wake times out with the sleep named in its error', async (t) => {
  const clock = fakeTimers();
  const f = await hardenedAdapter(t, { clock, script: (args) => (args[0] === 'export' ? behave.dieOn(['SIGTERM']) : behave.ok('[]')) });
  const read = f.adapter.loadSnapshot().catch((err) => err);
  await clock.advance(2000);
  await clock.sleep(904000, { reverse: true });
  await clock.advance(20000);
  const err = await read;
  assert.match(err.message, /timed out \(command bd-\d+ \(export\).*stopped with SIGTERM.*deadline renewed 1× after a wake\)\. The host was asleep or suspended for about 90\ds while this command was queued or running; this is a host sleep, not a store fault\./);
  assert.equal(f.adapter.status.state, 'ready');
  assert.ok(f.logs.some((l) => l.includes('"timedOut":true')));
});

test('a queued job that waits through a host sleep is dropped and says so', async (t) => {
  const clock = fakeTimers();
  const f = await hardenedAdapter(t, { clock, script: (args) => (args[1] === 'hive-head' ? behave.manual() : behave.ok('{"id":"hive-x"}')) });
  const head = f.adapter.close('hive-head', 'done', 'aw:a');
  const queued = f.adapter.close('hive-queued', 'done', 'aw:a').catch((err) => err);
  await flush();
  await clock.sleep(600000);
  const err = await queued;
  assert.equal(err.expired, true);
  assert.match(err.message, /host was asleep or suspended for about (599|600)s/);
  f.spawned[0].finish('{"id":"hive-head"}');
  await head;
  await flush();
  assert.equal(f.spawned.some((s) => s.args[1] === 'hive-queued'), false);
});

test('a started write that times out stays uncertain and is not retried', async (t) => {
  const clock = fakeTimers();
  const f = await hardenedAdapter(t, { clock, script: () => behave.dieOn(['SIGKILL']) });
  const write = f.adapter.update('hive-a', { summary: 'x' }, 'aw:a').catch((err) => err);
  await clock.advance(34000);
  const err = await write;
  assert.equal(err.code, 'uncertain');
  assert.notEqual(err.noWrite, true);
  assert.match(err.message, /may or may not have been applied\. It will not be retried automatically \(command bd-\d+ \(update\), pid \d+, .*ignored SIGTERM and was killed with SIGKILL/);
  await clock.advance(60000);
  assert.equal(f.spawned.filter((s) => s.args[0] === 'update').length, 1);
});

test('a genuine export failure still marks the backend as needing a recheck', async (t) => {
  const f = await hardenedAdapter(t, { script: () => (child, close) => setImmediate(() => close(Object.assign(new Error('boom'), { code: 2 }), '', 'database is corrupt')) });
  const err = await f.adapter.loadSnapshot().catch((e) => e);
  assert.match(err.message, /Reading the Beads store failed: database is corrupt \(command bd-\d+ \(export\), pid \d+, .*exit 2\)/);
  assert.equal(f.adapter.status.state, 'error');
});

test('a command that exits but leaves its pipe held open is closed at its deadline without signals', async (t) => {
  const clock = fakeTimers();
  const f = await hardenedAdapter(t, { clock, script: (args) => (args[0] === 'export' ? (child, close) => {
    setImmediate(() => child.emit('exit', 0, null));
    child.stdout.destroy = () => { child.destroyed = true; setImmediate(() => close(Object.assign(new Error('closed'), { code: 1 }), '', '')); };
  } : behave.ok('[]')) });
  const read = f.adapter.loadSnapshot().catch((err) => err);
  await flush();
  await clock.advance(5000);
  assert.equal(f.spawned[0].child.destroyed, undefined, 'a normal exit is never cut short');
  await clock.advance(16000);
  assert.equal(f.spawned[0].child.destroyed, true);
  assert.deepEqual(f.spawned[0].child.kills, []);
  assert.match((await read).message, /timed out/);
});

test('a read queued across a host sleep still runs at wake, in either timer order', async (t) => {
  for (const reverse of [false, true]) {
    const clock = fakeTimers();
    const f = await hardenedAdapter(t, { clock, script: (args) => (args[1] === 'hive-head' ? behave.manual() : behave.ok('')) });
    const head = f.adapter.close('hive-head', 'done', 'aw:a');
    const read = f.adapter.loadSnapshot();
    await flush();
    await clock.sleep(600000, { reverse });
    await clock.advance(5000);
    f.spawned[0].finish('{"id":"hive-head"}');
    await head;
    assert.ok(await read);
    assert.equal(f.spawned.at(-1).args[0], 'export');
  }
});
