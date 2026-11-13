import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrTracker } from '../server/pr-tracking.js';
import * as waiting from '../server/waiting.js';
const SHA = 'a'.repeat(40), URL = 'https://github.com/example/repo/pull/7';
const SID = '22222222-2222-4222-8222-222222222222';
const observed = { state: 'OPEN', number: 7, title: 'Ship it', headRefOid: SHA, isDraft: false, reviewDecision: 'APPROVED', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }] };

function fixture() {
  const beads = { 'hive-root': { id: 'hive-root' }, 'hive-a': { id: 'hive-a', parentId: 'hive-root', ownerSessionId: SID }, 'hive-b': { id: 'hive-b', parentId: 'hive-root' } };
  const cell = { id: 'cell', enabled: true, rootBeadId: 'hive-root', taskId: 'task' };
  const doc = { cells: { cell }, conversation: { cell: [] }, threads: { cell: {} }, prLabels: { [URL]: { url: URL, state: 'OPEN', headSha: SHA, checks: 'green', reviewDecision: 'APPROVED', isDraft: false, stateCheckedAt: Date.now(), associations: [{ cellId: 'cell', beadId: 'hive-a' }, { cellId: 'cell', beadId: 'hive-b' }] } } };
  const rt = { metadata: { read: () => doc, cells: () => Object.values(doc.cells), mutate: fn => fn(doc) }, snapshots: { graph: { beads } }, changed() {} };
  const actor = { sessionId: SID, cell, role: 'worker', cells: [{ cell, role: 'worker' }] };
  return { rt, doc, beads, cell, actor };
}

test('tracker reads the exact head, review and all check results, including legacy status contexts', async () => {
  let args;
  const tracker = createPrTracker({ gh: async a => { args = a; return JSON.stringify(observed); }, now: () => 100 });
  const result = await tracker.state(URL);
  assert.equal(result.headSha, SHA);
  assert.equal(result.checks, 'green');
  assert.match(args[4], /headRefOid/);
  for (const [statusCheckRollup, checks] of [[[], 'unknown'], [[{ status: 'IN_PROGRESS', conclusion: null }], 'pending'], [[{ state: 'FAILURE' }], 'failing'], [[{ state: 'SUCCESS' }], 'green'], [[{ status: 'COMPLETED', conclusion: 'CANCELLED' }], 'failing']]) {
    const t = createPrTracker({ gh: async () => JSON.stringify({ ...observed, statusCheckRollup }) });
    assert.equal((await t.state(URL)).checks, checks);
  }
});

test('claimant reports require a known associated PR and its full observed head; coordinator still needs bead access', () => {
  const f = fixture(), report = waiting.reportPrWait;
  const args = { bead_id: 'hive-a', url: URL, head_sha: SHA, state: 'ready', reason: 'Independent review approved; please review.' };
  assert.deepEqual(report(f.rt, f.actor, args)?.state, 'ready');
  assert.equal(f.doc.prLabels[URL].humanAttention.actor, SID);
  assert.throws(() => report(f.rt, f.actor, { ...args, head_sha: 'b'.repeat(40) }), /head/i);
  assert.throws(() => report(f.rt, { ...f.actor, sessionId: 'stranger' }, args), /claimant|queen|coordinator/i);
  assert.throws(() => report(f.rt, f.actor, { ...args, url: URL + '0' }), /known|recorded/i);
  assert.throws(() => report(f.rt, { ...f.actor, cells: [{ cell: f.cell, role: 'queen' }] }, { ...args, bead_id: 'hive-root' }), /associated/i);
  assert.throws(() => report(f.rt, f.actor, { ...args, head_sha: 'a'.repeat(39) }), /head|SHA/i);
  report(f.rt, f.actor, { ...args, state: 'clear', reason: '' });
  assert.equal(f.doc.prLabels[URL].humanAttention, null);
});

test('projection covers every outstanding message beyond conversation paging, and keeps PR associations explicit', () => {
  const f = fixture();
  f.doc.conversation.cell = Array.from({ length: 75 }, (_, i) => ({ id: 'm' + i, author: 'session', text: 'Please look ' + i, beadId: i === 0 ? null : 'hive-a', threadId: 'thread', ack: { required: true, state: null }, at: i }));
  f.doc.conversation.cell[1].ack.state = { kind: 'read' };
  const view = waiting.waitingProjection(f.rt, f.cell, new Set(Object.keys(f.beads)));
  assert.equal(view.waits?.length, 74);
  assert.deepEqual(view.waits[0].beadIds, ['hive-root']);
  assert.match(view.waits[0].reason, /read|acknowledg/i);
  assert.equal(view.waitTargets.messages.m2, 'hive-a');
  assert.equal(view.pullRequests.length, 1);
  assert.deepEqual(view.pullRequests[0].beadIds, ['hive-a', 'hive-b']);
  f.cell.snapshot = {};
  assert.deepEqual(waiting.waitingProjection(f.rt, f.cell, new Set(Object.keys(f.beads))), { waits: [], pullRequests: [], waitTargets: { messages: {}, topics: {} } });
});

test('waiting summaries and target indexes respect native request audience until forwarding', () => {
  const f = fixture(), ids = new Set(Object.keys(f.beads));
  f.doc.requests = { secret: { id: 'secret', cellId: 'cell', messageId: 'private-origin', threadId: 'private-thread', audience: 'queen', state: 'open', title: 'Canonical request' } };
  f.doc.threads.cell = { 'private-thread': { id: 'private-thread', origin: 'request', requestId: 'secret' }, 'public-thread': { id: 'public-thread' } };
  f.doc.conversation.cell = [
    { id: 'private-origin', author: 'session', requestId: 'secret', threadId: 'private-thread', text: 'Private draft' },
    { id: 'private-reply', author: 'session', replyTo: 'private-origin', threadId: 'private-thread', text: 'Private discussion', ack: { required: true } },
    { id: 'public-message', author: 'session', threadId: 'public-thread', text: 'Public update', ack: { required: true } },
  ];
  let view = waiting.waitingProjection(f.rt, f.cell, ids);
  assert.deepEqual(view.waits.map(w => w.title), ['Public update']);
  assert.equal(view.waitTargets.messages['private-origin'], undefined);
  assert.equal(view.waitTargets.messages['private-reply'], undefined);
  assert.equal(view.waitTargets.topics['private-thread'], undefined);
  f.doc.requests.secret.audience = 'human';
  view = waiting.waitingProjection(f.rt, f.cell, ids);
  assert.deepEqual(view.waits.map(w => w.title), ['Private discussion', 'Public update']);
  assert.equal(view.waitTargets.messages['private-reply'], 'hive-root');
});

test('a changed head permanently clears the old human report, including after reverting to the old head', async () => {
  const { createPrLabelSweep } = await import('../server/pr-label-discovery.js');
  const f = fixture();
  waiting.reportPrWait(f.rt, f.actor, { bead_id: 'hive-a', url: URL, head_sha: SHA, state: 'ready', reason: 'Reviewed this head' });
  let head = 'b'.repeat(40);
  const host = { version: '1.70.0', sessions: { list: () => [] }, links: { get: () => [] } };
  const tracker = createPrTracker({ gh: async args => args[0] === 'search' ? '[]' : JSON.stringify({ ...observed, headRefOid: head }) });
  const sweep = createPrLabelSweep({ runtime: f.rt, host, tracker });
  await sweep.run();
  assert.equal(f.doc.prLabels[URL].humanAttention, null);
  assert.equal(f.doc.prLabels[URL].headSha, head);
  head = SHA;
  await sweep.run();
  assert.equal(f.doc.prLabels[URL].humanAttention, null);
});

test('the report tool is registered and refuses other-cell identities through the real tool boundary', async () => {
  const { workTools } = await import('../server/tools.js');
  const f = fixture();
  f.rt.pendingParticipants = new Map();
  f.rt.log = () => {};
  f.doc.bindings = { cell: [] };
  const host = { stores: { hive: f.rt }, tasks: { forSession: sid => sid === SID ? { taskId: 'task' } : null } };
  const tool = workTools.find(t => t.name === 'hive_report_pr_wait');
  assert.ok(tool);
  const args = { bead_id: 'hive-a', url: URL, head_sha: SHA, state: 'ready', reason: 'Independent review approved' };
  const refusal = await tool.handler({ host, caller: '33333333-3333-4333-8333-333333333333' }, args);
  assert.equal(refusal.isError, true);
  assert.equal(f.doc.prLabels[URL].humanAttention, undefined);
  const accepted = await tool.handler({ host, caller: SID }, args);
  assert.equal(accepted.isError, undefined);
  assert.equal(f.doc.prLabels[URL].humanAttention.actor, SID);
});

test('failed PR refresh is immediately stale across tracker, sweep, projection and client until success', async () => {
  const { createPrLabelSweep } = await import('../server/pr-label-discovery.js');
  const { prState } = await import('../public/waiting-model.js');
  const f = fixture();
  let time = 1000000, failure = false;
  const host = { version: '1.70.0', sessions: { list: () => [] }, links: { get: () => [] } };
  const tracker = createPrTracker({ now: () => time, gh: async args => {
    if (args[0] === 'search') return '[]';
    if (failure) throw new Error('HTTP 403 permission denied');
    return JSON.stringify(observed);
  } });
  const sweep = createPrLabelSweep({ runtime: f.rt, host, tracker });
  const project = () => waiting.waitingProjection(f.rt, f.cell, new Set(Object.keys(f.beads))).pullRequests[0];
  await sweep.run();
  waiting.reportPrWait(f.rt, f.actor, { bead_id: 'hive-a', url: URL, head_sha: SHA, state: 'ready', reason: 'Reviewed' });
  assert.equal(prState(project(), time), 'ready');
  failure = true; time += 60000; await sweep.run();
  let pr = project();
  assert.equal(pr.stateCheckedAt, 1000000);
  assert.equal(pr.checks, 'green');
  assert.equal(prState(pr, time), 'stale');
  assert.match(pr.observationError.message, /permission denied/);
  assert.equal(pr.observationError.retryAt, 1120000);
  time += 1000; await sweep.run();
  assert.equal(prState(project(), time), 'stale');
  failure = false; time = 1120001; await sweep.run();
  pr = project();
  assert.equal(pr.observationError, null);
  assert.equal(prState(pr, time), 'ready');
});
