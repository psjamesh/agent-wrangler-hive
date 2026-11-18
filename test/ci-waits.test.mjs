import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCiWait, reconcileCiWaits, reportCiWait, ciWaitAttention } from '../server/ci-waits.js';
import { pickupFixture } from './helpers/pickup.mjs';

const URL = 'https://github.com/example/repo/pull/7', SHA = 'a'.repeat(40);
const NOW = Date.now();
const snapshot = (extra = {}) => ({ url: URL, nodeId: 'PR_7', isDraft: false, state: 'open', headSha: SHA, fetchedAt: new Date(NOW).toISOString(), lastError: null, statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }], ...extra });
const wait = (extra = {}) => ({ id: 'wait_1', beadId: 'a', cellId: 'cell', sessionId: 'queen', url: URL, headSha: SHA, nodeId: 'PR_7', target: 'checks', desiredOutcome: 'success', deadline: NOW + 600000, createdAt: NOW, state: 'pending', ...extra });

for (const [conclusion, outcome] of [['SUCCESS', 'success'], ['FAILURE', 'failure'], ['CANCELLED', 'cancelled'], ['TIMED_OUT', 'failure'], ['ACTION_REQUIRED', 'action-required']]) {
  test(`resolves check outcome ${conclusion}`, () => {
    assert.equal(evaluateCiWait(wait(), snapshot({ statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion }] }), NOW).outcome, outcome);
  });
}
test('distinguishes completion, readiness and merge and ignores incomplete or unknown check sets', () => {
  for (const rows of [[], [{ name: 'test', status: 'IN_PROGRESS' }], [{ name: 'test', conclusion: 'NEW_ENUM' }]]) assert.equal(evaluateCiWait(wait(), snapshot({ statusCheckRollup: rows }), NOW).outcome, undefined);
  assert.equal(evaluateCiWait(wait({ target: 'merge' }), snapshot(), NOW).outcome, undefined);
  assert.equal(evaluateCiWait(wait({ target: 'merge' }), snapshot({ state: 'merged' }), NOW).outcome, 'success');
  assert.equal(evaluateCiWait(wait(), snapshot({ state: 'closed' }), NOW).outcome, 'cancelled');
  assert.equal(evaluateCiWait(wait({ target: 'mergeable' }), snapshot({ checkStatus: 'awaiting-review' }), NOW).outcome, undefined);
  assert.equal(evaluateCiWait(wait({ target: 'mergeable' }), snapshot({ checkStatus: 'passing' }), NOW).outcome, 'success');
  const mixed = snapshot({ statusCheckRollup: [{ status: 'IN_PROGRESS' }, { status: 'COMPLETED', conclusion: 'FAILURE' }] });
  assert.equal(evaluateCiWait(wait(), mixed, NOW).outcome, 'failure');
  assert.equal(evaluateCiWait(wait({ desiredOutcome: 'completed' }), mixed, NOW).outcome, undefined);
});
test('selects named checks including status contexts without guessing missing or ambiguous identities', () => {
  const selected = wait({ target: 'check', checkName: 'test' });
  assert.equal(evaluateCiWait(selected, snapshot({ statusCheckRollup: [{ context: 'test', state: 'SUCCESS' }, { name: 'other', status: 'IN_PROGRESS' }] }), NOW).outcome, 'success');
  assert.deepEqual(evaluateCiWait(selected, snapshot({ statusCheckRollup: [] }), NOW), {});
  assert.match(evaluateCiWait(selected, snapshot({ statusCheckRollup: [{ name: 'test' }, { name: 'test' }] }), NOW).unavailable, /ambiguous/i);
});
test('head changes and URL identity replacement supersede the target, never advance it', () => {
  assert.equal(evaluateCiWait(wait(), snapshot({ headSha: 'b'.repeat(40), fetchedAt: NOW + 1 }), NOW + 1).outcome, 'superseded');
  assert.equal(evaluateCiWait(wait(), snapshot({ nodeId: 'PR_new', fetchedAt: NOW + 1 }), NOW + 1).outcome, 'superseded');
});
test('stale, absent and failed observations cannot establish success; deadline remains fixed', () => {
  for (const obs of [null, snapshot({ lastError: 'no permission' }), snapshot({ fetchedAt: new Date(NOW - 240000).toISOString() })]) assert.ok(evaluateCiWait(wait(), obs, NOW).unavailable);
  assert.equal(evaluateCiWait(wait({ deadline: NOW }), null, NOW).outcome, 'overdue');
});
function fixture() {
  const f = pickupFixture();
  f.live.a.assignee = 'aw:queen'; f.live.a.status = 'in_progress';
  f.rt.snapshots.graph = f.graph();
  f.rt.metadata.mutate(d => { d.prLabels = { [URL]: { url: URL, associations: [{ cellId: 'cell', beadId: 'a' }] } }; });
  let observation = snapshot({ statusCheckRollup: [{ name: 'test', status: 'IN_PROGRESS' }] });
  f.host.links = { prObservation: () => observation };
  return { ...f, observe: value => { observation = value; } };
}
const args = () => ({ bead_id: 'a', state: 'wait', url: URL, head_sha: SHA, reason: 'Continue after tests', target: 'checks', desired_outcome: 'success', deadline: new Date(NOW + 600000).toISOString() });

test('registration persists before snapshot read, resolves already finished checks and awaits exact acknowledgement', async () => {
  const f = fixture();
  f.host.links.prObservation = () => { assert.ok(f.doc().ciWaits.a); return snapshot(); };
  const registered = await reportCiWait(f.rt, f.host, f.actor(), args(), NOW);
  assert.equal(registered.outcome, 'success'); assert.equal(f.delivered.length, 1);
  assert.match(f.delivered[0].message, /acknowledge.*wait_id/i);
  assert.equal(f.doc().ciWaits.a.wake.state, 'delivered');
  assert.throws(() => reportCiWait(f.rt, f.host, f.actor(), { bead_id: 'a', state: 'acknowledge', wait_id: 'wrong' }), /wait/i);
  await reportCiWait(f.rt, f.host, f.actor(), { bead_id: 'a', state: 'acknowledge', wait_id: registered.id });
  assert.ok(f.doc().ciWaits.a.acknowledgedAt);
});
test('same-head completion resolves on reconciliation and restart does not repeat a confirmed wake', async () => {
  const f = fixture(); await reportCiWait(f.rt, f.host, f.actor(), args(), NOW);
  assert.equal(f.delivered.length, 0);
  f.observe(snapshot({ statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' }] }));
  await reconcileCiWaits(f.rt, f.host, NOW + 1000);
  assert.equal(f.doc().ciWaits.a.outcome, 'failure'); assert.equal(f.delivered.length, 1);
  await reconcileCiWaits(f.rt, f.host, NOW + 2000); assert.equal(f.delivered.length, 1);
});
test('interrupted, uncertain and unavailable wake delivery is retained for queen attention', async () => {
  for (const wake of [undefined, { state: 'sending', at: NOW }, { state: 'uncertain', at: NOW }]) {
    const f = fixture(); f.rt.metadata.mutate(d => { d.ciWaits = { a: wait({ state: 'resolved', outcome: 'failure', resolvedAt: NOW, wake }) }; });
    if (!wake) f.host.deliver = async () => ({ mode: 'error', outcome: 'unknown' });
    await reconcileCiWaits(f.rt, f.host, NOW + 1000);
    assert.ok(ciWaitAttention(f.rt, f.doc().cells.cell, NOW + 1000).some(flag => flag.kind === 'ci_wait_delivery'));
    assert.equal(f.doc().ciWaits.a.acknowledgedAt, undefined);
  }
});
test('missing owner preserves pending observation and notifies queen attention rather than a replacement worker', async () => {
  const f = fixture(); await reportCiWait(f.rt, f.host, f.actor(), args(), NOW);
  f.live.a.assignee = 'aw:other'; f.rt.snapshots.graph = f.graph();
  await reconcileCiWaits(f.rt, f.host, NOW + 1000);
  assert.equal(f.doc().ciWaits.a.state, 'pending'); assert.equal(f.doc().ciWaits.a.outcome, undefined); assert.equal(f.delivered.length, 0);
  assert.ok(ciWaitAttention(f.rt, f.doc().cells.cell, NOW + 1000).length);
});
test('unsupported selectors, unassociated PRs and nonclaimants are refused before registration', () => {
  const f = fixture();
  for (const change of [{ target: 'workflow' }, { run_id: 123 }, { attempt: 2 }, { workflow: 'Test' }, { url: URL + '0' }, { head_sha: 'short' }]) assert.throws(() => reportCiWait(f.rt, f.host, f.actor(), { ...args(), ...change }, NOW));
  assert.throws(() => reportCiWait(f.rt, f.host, f.actor('stranger', 'worker'), args(), NOW), /claimant|queen|coordinator/i);
  assert.equal(f.doc().ciWaits, undefined);
});

test('existing wait tool registers structured targets and rejects unsupported identity fields', async () => {
  const { reportPrWaitTool } = await import('./helpers/tools.mjs');
  assert.equal(reportPrWaitTool.inputSchema.safeParse(args()).success, true);
  assert.equal(reportPrWaitTool.inputSchema.safeParse({ ...args(), run_id: 1 }).success, false);
  assert.equal(reportPrWaitTool.inputSchema.safeParse({ bead_id: 'a', state: 'acknowledge', wait_id: 'ciwait_123' }).success, true);
});

test('prose suppression expires from its original anchor, even after unrelated bead edits', async () => {
  const { collectWatchdog, syncWaitAnchors } = await import('../server/watchdog.js');
  const f = fixture();
  const start = NOW - 3600000;
  f.live.a.metadata.hive_waiting_for = 'Waiting for CI';
  f.live.a.updated_at = new Date(start).toISOString();
  f.board.get('queen').lastActivity = start;
  f.rt.snapshots.graph = f.graph();
  syncWaitAnchors(f.rt);
  f.live.a.updated_at = new Date(NOW - 31 * 60000).toISOString();
  f.rt.snapshots.graph = f.graph(); syncWaitAnchors(f.rt);
  assert.equal(f.doc().cells.cell.waitAnchors.a.at, start);
  assert.ok(collectWatchdog(f.rt, f.host, f.doc().cells.cell, NOW).some(flag => flag.kind === 'stalled_worker' && flag.bead_id === 'a'));
  f.doc().cells.cell.waitAnchors.a.at = NOW - 60000;
  assert.equal(collectWatchdog(f.rt, f.host, f.doc().cells.cell, NOW).some(flag => flag.kind === 'stalled_worker' && flag.bead_id === 'a'), false);
});

test('pending structured waits suppress alarms only while valid; a finished wait exposes an idle worker', async () => {
  const { collectWatchdog } = await import('../server/watchdog.js');
  const f = fixture();
  const start = NOW - 3600000;
  f.live.a.updated_at = new Date(start).toISOString(); f.board.get('queen').lastActivity = start;
  f.live.a.metadata.hive_waiting_for = 'Waiting for CI'; f.rt.snapshots.graph = f.graph();
  await reportCiWait(f.rt, f.host, f.actor(), args(), NOW);
  const flags = () => collectWatchdog(f.rt, f.host, f.doc().cells.cell, NOW);
  assert.equal(flags().some(flag => flag.kind === 'stalled_worker' && flag.bead_id === 'a'), false);
  f.observe(null);
  assert.ok(flags().some(flag => flag.kind === 'ci_wait_unavailable'));
  assert.ok(flags().some(flag => flag.kind === 'stalled_worker' && flag.bead_id === 'a'));
  f.observe(snapshot()); await reconcileCiWaits(f.rt, f.host, NOW);
  assert.ok(flags().some(flag => flag.kind === 'stalled_worker' && flag.bead_id === 'a'));
});

test('observer subscribes before baseline, resolves events and stops on deactivation', async () => {
  const { startCiWaits } = await import('../server/ci-waits.js');
  const f = fixture(); await reportCiWait(f.rt, f.host, f.actor(), args(), NOW);
  let listener, subscribed = false;
  f.host.events = { on(name, fn) { assert.equal(name, 'pr:observation'); subscribed = true; listener = fn; return () => { listener = null; }; } };
  f.host.links.prObservation = () => { assert.ok(subscribed); return snapshot(); };
  const stop = startCiWaits(f.rt, f.host, () => NOW);
  await listener();
  assert.equal(f.doc().ciWaits.a.outcome, 'success'); assert.equal(f.delivered.length, 1);
  stop(); assert.equal(listener, null);
});

test('pending wait and wake receipt reconcile from disk without duplicate delivery after restart', async t => {
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const { MetadataStore } = await import('../server/metadata-store.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-waits-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'metadata.json'), f = fixture();
  const original = f.doc();
  f.rt.metadata = new MetadataStore({ file }); f.rt.metadata.mutate(d => Object.assign(d, original));
  await reportCiWait(f.rt, f.host, f.actor(), args(), NOW);
  f.rt.metadata = new MetadataStore({ file });
  f.observe(snapshot()); await reconcileCiWaits(f.rt, f.host, NOW + 1000);
  assert.equal(f.rt.metadata.read().ciWaits.a.outcome, 'success'); assert.equal(f.delivered.length, 1);
  f.rt.metadata = new MetadataStore({ file });
  await reconcileCiWaits(f.rt, f.host, NOW + 2000); assert.equal(f.delivered.length, 1);
  assert.ok(ciWaitAttention(f.rt, f.rt.metadata.cell('cell'), NOW + 301000).some(flag => flag.kind === 'ci_wait_unacknowledged'));
});

test('an old retained merged snapshot proves merge after link removal and restart', () => {
  assert.equal(evaluateCiWait(wait({ target: 'merge' }), snapshot({ state: 'merged', fetchedAt: new Date(NOW - 86400000).toISOString() }), NOW).outcome, 'success');
});

test('retirement during wake leaves a sending receipt without writing a late success', async () => {
  const f = fixture();
  f.observe(snapshot());
  f.host.deliver = async () => { f.rt.metadata.lifetime.stop(); return { mode: 'live' }; };
  await reportCiWait(f.rt, f.host, f.actor(), args(), NOW);
  assert.equal(f.doc().ciWaits.a.wake.state, 'sending');
});

test('definite delivery failure can be retried explicitly; delayed acknowledgements never clear a newer wait', async () => {
  const f = fixture(); f.observe(snapshot());
  f.host.deliver = async () => ({ mode: 'error', error: 'No transport' });
  const old = await reportCiWait(f.rt, f.host, f.actor(), args(), NOW);
  assert.equal(old.wake.state, 'failed');
  f.host.deliver = async () => ({ mode: 'live' });
  await reportCiWait(f.rt, f.host, f.actor(), { bead_id: 'a', state: 'retry-wake', wait_id: old.id }, NOW + 1000);
  assert.equal(f.doc().ciWaits.a.wake.state, 'delivered');
  await reportCiWait(f.rt, f.host, f.actor(), { bead_id: 'a', state: 'acknowledge', wait_id: old.id }, NOW + 2000);
  const next = await reportCiWait(f.rt, f.host, f.actor(), { ...args(), target: 'merge' }, NOW + 3000);
  assert.notEqual(next.id, old.id);
  assert.throws(() => reportCiWait(f.rt, f.host, f.actor(), { bead_id: 'a', state: 'acknowledge', wait_id: old.id }), /wait_id/);
});

test('real wait tool enforces caller identity and exposes the persisted outcome in bead context', async t => {
  const { reportPrWaitTool, contextTool } = await import('./helpers/tools.mjs');
  const f = fixture();
  const sid = '22222222-2222-4222-8222-222222222222';
  f.board.set(sid, { sessionId: sid, taskId: 'task', status: 'idle' });
  f.live.a.assignee = `aw:${sid}`; f.rt.snapshots.graph = f.graph();
  f.observe(snapshot());
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-wait-context-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  f.rt.paths = { root: dir };
  f.rt.log = message => { throw new Error(message); };
  const refusal = await reportPrWaitTool.handler({ host: f.host, caller: '33333333-3333-4333-8333-333333333333' }, args());
  assert.equal(refusal.isError, true); assert.equal(f.doc().ciWaits, undefined);
  const accepted = await reportPrWaitTool.handler({ host: f.host, caller: sid }, args());
  assert.equal(accepted.isError, undefined); assert.equal(accepted.structuredContent.outcome, 'success', JSON.stringify(accepted));
  const context = await contextTool.handler({ host: f.host, caller: sid }, { scope: 'bead', bead_id: 'a' });
  assert.equal(context.isError, undefined, JSON.stringify(context));
  assert.equal(context.structuredContent.focus.ci_wait.id, accepted.structuredContent.id);
});

test('superseding a head permanently resolves the old wait without registering a continuation', async () => {
  const f = fixture(); await reportCiWait(f.rt, f.host, f.actor(), args(), NOW);
  const id = f.doc().ciWaits.a.id;
  f.observe(snapshot({ headSha: 'b'.repeat(40), fetchedAt: NOW + 1 })); await reconcileCiWaits(f.rt, f.host, NOW + 1000);
  assert.equal(f.doc().ciWaits.a.outcome, 'superseded');
  f.observe(snapshot()); await reconcileCiWaits(f.rt, f.host, NOW + 2000);
  assert.equal(f.doc().ciWaits.a.outcome, 'superseded'); assert.equal(f.doc().ciWaits.a.id, id); assert.equal(f.delivered.length, 1);
});

test('older hosts retain unavailable waits and deadlines without any fallback observer', async () => {
  const f = fixture(); delete f.host.links;
  const result = await reportCiWait(f.rt, f.host, f.actor(), args(), NOW);
  assert.equal(result.state, 'pending'); assert.equal(f.delivered.length, 0);
  assert.ok(ciWaitAttention(f.rt, f.doc().cells.cell, NOW).some(flag => flag.kind === 'ci_wait_unavailable'));
  await reconcileCiWaits(f.rt, f.host, NOW + 600000);
  assert.equal(f.doc().ciWaits.a.outcome, 'overdue'); assert.equal(f.delivered.length, 1);
});

test('late reconciliation preserves terminal evidence and expires only unfinished waits', () => {
  const expired = wait({ deadline: NOW });
  assert.equal(evaluateCiWait(expired, snapshot(), NOW + 1000).outcome, 'success');
  assert.equal(evaluateCiWait({ ...expired, target: 'merge' }, snapshot({ state: 'merged' }), NOW + 1000).outcome, 'success');
  assert.equal(evaluateCiWait(expired, snapshot({ statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' }] }), NOW + 1000).outcome, 'failure');
  assert.equal(evaluateCiWait(expired, snapshot({ headSha: 'b'.repeat(40), fetchedAt: NOW + 1 }), NOW + 1000).outcome, 'superseded');
  assert.equal(evaluateCiWait(expired, null, NOW + 1000).outcome, 'overdue');
  assert.equal(evaluateCiWait(expired, snapshot({ statusCheckRollup: [{ name: 'test', status: 'IN_PROGRESS' }] }), NOW + 1000).outcome, 'overdue');
});

test('retry-wake refuses a send active in this process without discarding its receipt', async () => {
  const f = fixture(); f.observe(snapshot());
  let finish, calls = 0;
  const delivery = new Promise(resolve => { finish = resolve; });
  f.host.deliver = () => { calls++; return delivery; };
  const registration = reportCiWait(f.rt, f.host, f.actor(), args(), NOW);
  const id = f.doc().ciWaits.a.id;
  let rejection;
  try { reportCiWait(f.rt, f.host, f.actor(), { bead_id: 'a', state: 'retry-wake', wait_id: id }, NOW + 1000); }
  catch (err) { rejection = err; }
  finish({ mode: 'live' }); await registration;
  assert.match(rejection?.message || '', /in.flight|active|sending/i);
  assert.equal(calls, 1); assert.equal(f.doc().ciWaits.a.wake.state, 'delivered');
});

test('retry-wake through a host store proxy refuses a send the raw runtime has in flight', async () => {
  const f = fixture(); f.observe(snapshot());
  const proxy = new Proxy(f.rt, { get(target, key) { const value = Reflect.get(target, key, target); return typeof value === 'function' ? (...a) => value.apply(target, a) : value; } });
  let finish, calls = 0;
  const delivery = new Promise(resolve => { finish = resolve; });
  f.host.deliver = () => { calls++; return delivery; };
  const registration = reportCiWait(f.rt, f.host, f.actor(), args(), NOW);
  const id = f.doc().ciWaits.a.id;
  let rejection;
  try { reportCiWait(proxy, f.host, f.actor(), { bead_id: 'a', state: 'retry-wake', wait_id: id }, NOW + 1000); }
  catch (err) { rejection = err; }
  finish({ mode: 'live' }); await registration;
  assert.match(rejection?.message || '', /in.flight|active|sending/i);
  assert.equal(calls, 1);
});

for (const target of ['checks', 'check', 'mergeable', 'merge']) {
  test(`expected-head merge preserves the ${target} outcome`, () => {
    const selected = wait({ target, ...(target === 'check' ? { checkName: 'test' } : {}) });
    assert.equal(evaluateCiWait(selected, snapshot({ state: 'merged', checkStatus: null }), NOW).outcome, 'success');
    if (['checks', 'check'].includes(target)) {
      assert.equal(evaluateCiWait(selected, snapshot({ state: 'merged', statusCheckRollup: [] }), NOW).outcome, 'reconciliation-required');
      assert.equal(evaluateCiWait(selected, snapshot({ state: 'merged', statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' }] }), NOW).outcome, 'failure');
    }
  });
}

test('checks not yet attached stay pending and suppressing until their deadline', async () => {
  const { ciWaitSuppresses } = await import('../server/ci-waits.js');
  for (const selected of [{ target: 'checks' }, { target: 'check', check_name: 'deploy' }]) {
    const f = fixture(); f.observe(snapshot({ statusCheckRollup: [] }));
    const record = await reportCiWait(f.rt, f.host, f.actor(), { ...args(), ...selected }, NOW);
    assert.equal(record.state, 'pending'); assert.deepEqual(ciWaitAttention(f.rt, f.doc().cells.cell, NOW), []);
    assert.equal(ciWaitSuppresses(f.rt, f.host, f.rt.snapshots.graph.beads.a, NOW), true);
    f.observe(snapshot({ statusCheckRollup: [{ name: 'build', status: 'IN_PROGRESS' }] }));
    await reconcileCiWaits(f.rt, f.host, NOW + 1000);
    assert.deepEqual(ciWaitAttention(f.rt, f.doc().cells.cell, NOW + 1000), []);
    f.observe(snapshot({ fetchedAt: new Date(NOW + 600000).toISOString(), statusCheckRollup: [] }));
    await reconcileCiWaits(f.rt, f.host, NOW + 600000);
    assert.equal(f.doc().ciWaits.a.outcome, 'overdue');
  }
});

test('claim handoff preserves merge observation, records success and flags the queen without waking a former owner', async () => {
  const f = fixture(); await reportCiWait(f.rt, f.host, f.actor(), { ...args(), target: 'merge' }, NOW);
  delete f.live.a.assignee; f.live.a.status = 'open'; f.rt.snapshots.graph = f.graph();
  await reconcileCiWaits(f.rt, f.host, NOW + 1000);
  assert.equal(f.doc().ciWaits.a.state, 'pending'); assert.equal(f.doc().ciWaits.a.outcome, undefined);
  assert.ok(ciWaitAttention(f.rt, f.doc().cells.cell, NOW + 1000).some(flag => flag.kind === 'ci_wait_unavailable'));
  f.observe(snapshot({ state: 'merged' })); await reconcileCiWaits(f.rt, f.host, NOW + 2000);
  assert.equal(f.doc().ciWaits.a.outcome, 'success'); assert.equal(f.delivered.length, 0);
  assert.ok(ciWaitAttention(f.rt, f.doc().cells.cell, NOW + 2000).some(flag => flag.kind === 'ci_wait_delivery'));
});

test('transient worker errors do not consume the wait; recovery wakes the same owner once', async () => {
  const f = fixture(); await reportCiWait(f.rt, f.host, f.actor(), args(), NOW);
  f.board.get('queen').status = 'error';
  await reconcileCiWaits(f.rt, f.host, NOW + 1000);
  assert.equal(f.doc().ciWaits.a.state, 'pending');
  f.observe(snapshot()); await reconcileCiWaits(f.rt, f.host, NOW + 2000);
  assert.equal(f.doc().ciWaits.a.outcome, 'success'); assert.equal(f.delivered.length, 0);
  f.board.get('queen').status = 'idle'; await reconcileCiWaits(f.rt, f.host, NOW + 3000);
  assert.equal(f.delivered.length, 1);
});

test('a merged snapshot with ambiguous or missing check evidence requires reconciliation', () => {
  for (const statusCheckRollup of [null, [{ name: 'test' }, { name: 'test' }], [{ name: 'test', status: 'IN_PROGRESS' }]]) {
    assert.equal(evaluateCiWait(wait({ target: 'check', checkName: 'test' }), snapshot({ state: 'merged', statusCheckRollup }), NOW).outcome, 'reconciliation-required');
  }
});

for (const source of ['session-link', 'bead-evidence']) {
  test(`registers a just-opened PR from ${source} before discovery`, async () => {
    const f = fixture();
    f.rt.metadata.mutate(d => { delete d.prLabels; });
    if (source === 'session-link') f.host.links.get = sid => sid === 'queen' ? [{ type: 'pr', url: URL }] : [];
    else {
      f.live.a.metadata.hive_evidence = [{ kind: 'pr', label: 'New PR', url: URL }];
      f.rt.snapshots.graph = f.graph();
    }
    f.observe(null);
    const registered = await reportCiWait(f.rt, f.host, f.actor(), args(), NOW);
    assert.equal(registered.state, 'pending');
    assert.equal(registered.nodeId, null);
    const enrolled = f.doc().prLabels[URL];
    assert.equal(enrolled.source, source);
    assert.ok(enrolled.associations.some(a => a.cellId === 'cell' && a.beadId === 'a'));
    assert.equal(enrolled.firstSeenAt, NOW);
    f.observe(snapshot());
    await reconcileCiWaits(f.rt, f.host, NOW + 1000);
    assert.equal(f.doc().ciWaits.a.outcome, 'success');
    assert.equal(f.doc().ciWaits.a.nodeId, 'PR_7');
    assert.equal(f.delivered.length, 1);
  });
}

test('new enrollment refuses unrelated links, evidence and malformed PR URLs', () => {
  for (const url of [URL, URL + '/files', URL.replace('github.com', 'other.example')]) {
    const f = fixture();
    f.rt.metadata.mutate(d => { delete d.prLabels; });
    f.host.links.get = () => [{ type: 'pr', url: URL + '0' }, { type: 'jira', url }];
    f.live.b.metadata.hive_evidence = [{ kind: 'pr', label: 'Other bead PR', url }];
    f.rt.snapshots.graph = f.graph();
    assert.throws(() => reportCiWait(f.rt, f.host, f.actor(), { ...args(), url }, NOW));
    assert.equal(f.doc().ciWaits, undefined);
    assert.equal(f.doc().prLabels, undefined);
  }
});

test('invalid waits do not enroll PRs and coordinator links cannot substitute for claimant links', () => {
  const f = fixture();
  f.rt.metadata.mutate(d => { delete d.prLabels; });
  f.host.links.get = () => [{ type: 'pr', url: URL }];
  assert.throws(() => reportCiWait(f.rt, f.host, f.actor(), { ...args(), deadline: 'bad' }, NOW));
  assert.equal(f.doc().prLabels, undefined);
  f.live.a.assignee = 'aw:worker'; f.rt.snapshots.graph = f.graph();
  f.host.links.get = sid => sid === 'queen' ? [{ type: 'pr', url: URL }] : [];
  assert.throws(() => reportCiWait(f.rt, f.host, f.actor(), args(), NOW), /associated/);
  assert.equal(f.doc().prLabels, undefined);
});

test('immediate enrollment preserves known node identity and other bead associations', async () => {
  const f = fixture();
  f.rt.metadata.mutate(d => { d.prLabels[URL] = { url: URL, nodeId: 'PR_original', firstSeenAt: NOW - 1000, associations: [{ cellId: 'cell', beadId: 'b' }] }; });
  f.host.links.get = () => [{ type: 'pr', url: URL }];
  f.observe(snapshot({ fetchedAt: NOW }));
  const registered = await reportCiWait(f.rt, f.host, f.actor(), args(), NOW - 1);
  assert.equal(registered.outcome, 'superseded');
  assert.equal(registered.nodeId, 'PR_original');
  assert.equal(f.doc().prLabels[URL].associations.length, 2);
  assert.equal(f.doc().prLabels[URL].firstSeenAt, NOW - 1000);
});

test('a claimant worker can enroll its own linked PR without exposing other session links', async () => {
  const f = fixture();
  f.rt.metadata.mutate(d => { delete d.prLabels; });
  f.live.a.assignee = 'aw:worker'; f.rt.snapshots.graph = f.graph();
  f.board.set('worker', { sessionId: 'worker', taskId: 'task', status: 'working' });
  f.host.links.get = sid => { assert.equal(sid, 'worker'); return [{ type: 'pr', url: URL }]; };
  const registered = await reportCiWait(f.rt, f.host, f.actor('worker', 'worker'), args(), NOW);
  assert.equal(registered.sessionId, 'worker');
  assert.equal(registered.state, 'pending');
});

for (const source of ['bead-evidence', 'label-search']) {
  test(`discovery labels registration-enrolled ${source} PRs without losing bead associations`, async () => {
    const { createPrLabelSweep } = await import('../server/pr-label-discovery.js');
    const f = fixture();
    f.rt.metadata.mutate(d => {
      delete d.prLabels;
      if (source === 'label-search') d.prLabels = { [URL]: { url: URL, source, associations: [], firstSeenAt: NOW - 1000 } };
    });
    f.live.a.metadata.hive_evidence = [{ kind: 'pr', label: 'New PR', url: URL }];
    f.rt.snapshots.graph = f.graph();
    await reportCiWait(f.rt, f.host, f.actor(), args(), NOW);
    f.host.version = '1.93.0';
    f.host.sessions.list = () => [{ sessionId: 'queen' }];
    f.host.links.get = () => [{ type: 'pr', url: URL }];
    f.rt.metadata.mutate(d => { d.bindings.cell = [{ sessionId: 'queen', beadId: 'b', active: true, role: 'worker' }]; });
    const labelled = [];
    const sweep = createPrLabelSweep({ runtime: f.rt, host: f.host, now: () => NOW + 1000,
      labeler: { apply: async (url, eligible) => { assert.equal(eligible(), true); labelled.push(url); return 'labelled'; }, stop() {} },
      tracker: { search: async () => [], state: async () => null, stop() {} },
    });
    await sweep.run();
    assert.deepEqual(labelled, [URL]);
    const record = f.doc().prLabels[URL];
    assert.equal(record.source, 'session-link');
    assert.equal(record.status, 'labelled');
    assert.deepEqual(new Set(record.associations.map(a => a.beadId)), new Set(['a', 'b']));
    assert.deepEqual(new Set(record.beadIds), new Set(['a', 'b']));
    await sweep.run();
    assert.deepEqual(labelled, [URL]);
  });
}

test('finishing a bead settles its CI wait immediately and reopening cannot revive it', async () => {
  const { finishBead } = await import('../server/ops.js');
  for (const state of ['pending', 'resolved']) {
    const f = fixture();
    f.rt.metadata.mutate(d => { d.ciWaits = { a: wait(state === 'resolved' ? { state, outcome: 'failure', resolvedAt: NOW, wake: { state: 'uncertain', at: NOW } } : {}) }; });
    f.rt.beads.close = async id => { f.live[id].status = 'closed'; };
    await finishBead(f.rt, f.actor(), { bead_id: 'a', outcome: 'done', evidence: [{ label: 'Acceptance verified' }], summary: 'Delivered' });
    const saved = f.doc().ciWaits.a;
    assert.equal(saved.state, 'resolved');
    assert.equal(saved.outcome, state === 'pending' ? 'cancelled' : 'failure');
    assert.ok(saved.acknowledgedAt);
    assert.equal(saved.settledReason, 'Bead closed');
    f.live.a.status = 'open'; f.rt.snapshots.graph = f.graph();
    await reconcileCiWaits(f.rt, f.host, NOW + 700000);
    assert.deepEqual(ciWaitAttention(f.rt, f.doc().cells.cell, NOW + 700000), []);
    assert.equal(f.delivered.length, 0);
  }
});

test('legacy closed beads never raise CI attention and reconciliation durably settles their waits', async () => {
  for (const state of ['pending', 'resolved']) {
    const f = fixture();
    f.rt.metadata.mutate(d => { d.ciWaits = { a: wait(state === 'resolved' ? { state, outcome: 'success', resolvedAt: NOW } : {}) }; });
    f.live.a.status = 'closed'; f.rt.snapshots.graph = f.graph();
    f.board.get('queen').archived = true;
    assert.deepEqual(ciWaitAttention(f.rt, f.doc().cells.cell, NOW + 700000), []);
    await reconcileCiWaits(f.rt, f.host, NOW + 700000);
    assert.equal(f.doc().ciWaits.a.settledReason, 'Bead closed');
    assert.ok(f.doc().ciWaits.a.acknowledgedAt);
    assert.equal(f.delivered.length, 0);
  }
});

test('a refused close keeps its CI wait active', async () => {
  const { finishBead } = await import('../server/ops.js');
  const f = fixture();
  await reportCiWait(f.rt, f.host, f.actor(), args(), NOW);
  const original = structuredClone(f.doc().ciWaits.a);
  f.rt.beads.close = async () => { throw new Error('Close refused'); };
  await assert.rejects(finishBead(f.rt, f.actor(), { bead_id: 'a', outcome: 'done', evidence: [{ label: 'Acceptance verified' }], summary: 'Delivered' }), /closing.*refused/i);
  assert.deepEqual(f.doc().ciWaits.a, original);
});

test('group closure settles its wait even if recording the outcome fails', async () => {
  const { finishBead } = await import('../server/ops.js');
  const f = fixture();
  f.live.b.dependencies = [{ issue_id: 'b', depends_on_id: 'a', type: 'parent-child' }];
  f.live.b.status = 'closed'; f.rt.snapshots.graph = f.graph();
  await reportCiWait(f.rt, f.host, f.actor(), args(), NOW);
  f.rt.beads.finishFenced = async (id, fields, who, check, written) => {
    check({ issues: Object.values(f.live), errors: [] });
    written(0);
    f.live[id].status = 'closed'; written(1);
    throw Object.assign(new Error('Outcome write failed'), { step: 2 });
  };
  await assert.rejects(finishBead(f.rt, f.actor(), { bead_id: 'a', outcome: 'done', evidence: [{ label: 'Acceptance verified' }], summary: 'Delivered' }), /closed.*outcome/);
  assert.equal(f.doc().ciWaits.a.outcome, 'cancelled');
  assert.equal(f.doc().ciWaits.a.settledReason, 'Bead closed');
});

test('closed-bead reconciliation respects snapshot and missing cells', async () => {
  for (const kind of ['snapshot', 'missing', 'disabled']) {
    const f = fixture();
    f.rt.metadata.mutate(d => {
      d.ciWaits = { a: wait() };
      if (kind === 'missing') delete d.cells.cell;
      else if (kind === 'snapshot') d.cells.cell.snapshot = { capturedAt: NOW };
      else d.cells.cell.enabled = false;
    });
    f.live.a.status = 'closed'; f.rt.snapshots.graph = f.graph();
    const original = structuredClone(f.doc().ciWaits.a);
    await reconcileCiWaits(f.rt, f.host, NOW + 1000);
    if (kind === 'disabled') assert.equal(f.doc().ciWaits.a.settledReason, 'Bead closed');
    else assert.deepEqual(f.doc().ciWaits.a, original);
  }
});

for (const source of ['delete cleanup', 'legacy deletion']) {
  test(`${source} drops pending and finished CI waits without attention or worker wakes`, async () => {
    const { forgetDeleted } = await import('../server/ops.js');
    for (const state of ['pending', 'resolved']) {
      const f = fixture();
      f.rt.metadata.mutate(d => { d.ciWaits = { a: wait(state === 'resolved' ? { state, outcome: 'failure', resolvedAt: NOW, wake: { state: 'uncertain', at: NOW } } : {}) }; });
      if (source === 'delete cleanup') {
        f.rt.metadata.mutate(d => {
          Object.assign(d, { beadLayout: {}, archived: {}, restoring: {} });
          forgetDeleted(d, 'cell', ['a'], 'queen');
        });
        assert.equal(f.doc().ciWaits.a, undefined);
      }
      delete f.live.a; f.rt.snapshots.graph = f.graph();
      assert.deepEqual(ciWaitAttention(f.rt, f.doc().cells.cell, NOW + 700000), []);
      await reconcileCiWaits(f.rt, f.host, NOW + 700000);
      assert.equal(f.doc().ciWaits.a, undefined);
      assert.equal(f.delivered.length, 0);
    }
  });
}

for (const fetchedAt of [NOW - 1000, NOW]) {
  test(`pre-registration head observation at ${fetchedAt - NOW}ms stays pending until fresh evidence or deadline`, async () => {
    const f = fixture();
    f.observe(snapshot({ headSha: 'b'.repeat(40), fetchedAt: new Date(fetchedAt).toISOString() }));
    const registered = await reportCiWait(f.rt, f.host, f.actor(), args(), NOW);
    assert.equal(registered.state, 'pending');
    assert.equal(f.delivered.length, 0);
    await reconcileCiWaits(f.rt, f.host, NOW + 1000);
    assert.equal(f.doc().ciWaits.a.state, 'pending');
    f.observe(snapshot({ fetchedAt: NOW + 2000 }));
    await reconcileCiWaits(f.rt, f.host, NOW + 2000);
    assert.equal(f.doc().ciWaits.a.outcome, 'success');
    assert.equal(f.delivered.length, 1);
  });
}

test('a pre-registration different head cannot supersede an expired wait', () => {
  const observed = snapshot({ headSha: 'b'.repeat(40), fetchedAt: NOW - 1000 });
  assert.deepEqual(evaluateCiWait(wait({ deadline: NOW + 1000 }), observed, NOW + 1000), { outcome: 'overdue' });
});
