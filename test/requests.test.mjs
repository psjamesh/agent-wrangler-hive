import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MetadataStore } from '../server/metadata-store.js';
import * as requests from '../server/requests.js';

const queen = '11111111-1111-4111-8111-111111111111';
const worker = '22222222-2222-4222-8222-222222222222';
const other = '33333333-3333-4333-8333-333333333333';
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-requests-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const metadata = new MetadataStore({ file: path.join(dir, 'metadata.json') });
  metadata.mutate(d => { d.cells.cell = { id: 'cell', taskId: 'task', enabled: true, queenSessionId: queen, queenGeneration: 1 }; });
  const members = new Map([[queen, { sessionId: queen, taskId: 'task', spawnedBy: other }], [worker, { sessionId: worker, taskId: 'task' }], [other, { sessionId: other, taskId: 'elsewhere', spawnedBy: worker }]]);
  const sent = [];
  const rt = { paths: { attachmentDir: dir, root: dir }, metadata, pendingParticipants: new Map(), changed() {}, snapshots: { graph: { beads: {} }, current: { error: 'Beads unavailable' } } };
  const host = { stores: { hive: rt }, sessions: { get: id => members.get(id) }, tasks: { forSession: id => ({ taskId: members.get(id)?.taskId }) }, deliver: async (id, text) => { sent.push({ id, text }); return { mode: 'live' }; } };
  rt.host = host;
  return { rt, host, members, sent, create: (caller = worker, args = {}) => requests.createRequest(rt, host, caller, { title: 'Approve API?', body: 'Preserve the old API?', ...args }) };
}
const rev = r => ({ revision: r.revision, route_revision: r.routeRevision });

test('worker request and conversation are atomic; queen forwards same id; human answers original requester', async t => {
  const f = fixture(t), r = await f.create();
  assert.match(r.id, /^hreq_/);
  assert.equal(r.audience, 'queen');
  assert.equal(f.sent[0].id, queen);
  assert.equal(f.rt.metadata.read().conversation.cell[0].requestId, r.id);
  assert.equal(f.rt.metadata.read().conversation.cell[0].ack, undefined);
  const forwarded = await requests.forwardRequest(f.rt, f.host, queen, { request_id: r.id, ...rev(r), recommendation: 'Keep compatibility' });
  assert.equal(forwarded.id, r.id);
  assert.equal(forwarded.audience, 'human');
  const answered = await requests.humanAnswer(f.rt, f.host, { request_id: r.id, ...rev(forwarded), text: 'Yes, preserve it', receipt: 'reply-1' });
  assert.equal(answered.answer.author, 'human');
  assert.equal(answered.delivery.state, 'delivered');
  assert.equal(f.sent.at(-1).id, worker);
  assert.match(f.sent.at(-1).text, /human/);
  const again = await requests.humanAnswer(f.rt, f.host, { request_id: r.id, ...rev(forwarded), text: 'Yes, preserve it', receipt: 'reply-1' });
  assert.equal(again.id, r.id);
  assert.equal(f.sent.filter(s => s.id === worker).length, 1);
});

test('task helpers, bindings and launch grace participate; ancestry alone does not', async t => {
  const f = fixture(t);
  await assert.rejects(f.create(other), /standard request_human_input/);
  assert.equal(Object.keys(f.rt.metadata.read().requests).length, 0);
  f.members.get(other).taskId = 'task';
  assert.equal((await f.create(other)).audience, 'queen');
  f.members.get(other).taskId = 'elsewhere';
  f.rt.metadata.mutate(d => { d.bindings.cell = [{ active: true, sessionId: other, role: 'reviewer' }]; });
  assert.equal((await f.create(other)).audience, 'queen');
  f.rt.metadata.mutate(d => { d.bindings.cell = []; });
  f.members.get(other).taskId = null;
  f.rt.pendingParticipants.set(other, { cellId: 'cell', taskId: 'task', at: Date.now() });
  assert.equal((await f.create(other)).audience, 'queen');
  f.members.get(other).taskId = 'elsewhere';
  await assert.rejects(f.create(other), /standard request_human_input/);
});

test('queen with ancestry asks human; missing or archived queen routes human immediately; dormancy does not', async t => {
  const f = fixture(t);
  assert.equal((await f.create(queen)).audience, 'human');
  f.members.get(queen).dormant = true;
  assert.equal((await f.create()).audience, 'queen');
  f.members.get(queen).archived = true;
  const r = await f.create();
  assert.equal(r.audience, 'human');
  assert.equal(r.routeReason, 'no-queen');
  assert.equal(r.warning, 'No queen in this hive');
  f.members.delete(queen);
  assert.equal((await f.create()).routeReason, 'no-queen');
});

test('current queen alone answers its stage and generation; human cannot silently intervene', async t => {
  const f = fixture(t), r = await f.create();
  await assert.rejects(requests.answerRequest(f.rt, f.host, worker, { request_id: r.id, ...rev(r), text: 'No' }), /queen/);
  await assert.rejects(requests.humanAnswer(f.rt, f.host, { request_id: r.id, ...rev(r), text: 'No', receipt: 'a' }), /Unknown|unavailable/);
  f.rt.metadata.mutate(d => { d.cells.cell.queenGeneration++; });
  await assert.rejects(requests.answerRequest(f.rt, f.host, queen, { request_id: r.id, ...rev(r), text: 'No' }), /changed|revision/);
  const current = requests.listMine(f.rt, f.host, worker)[0];
  const answered = await requests.answerRequest(f.rt, f.host, queen, { request_id: r.id, ...rev(current), text: 'Within my authority: keep it' });
  assert.equal(answered.answer.author, 'queen');
  assert.equal(answered.answer.sessionId, queen);
  await assert.rejects(requests.forwardRequest(f.rt, f.host, queen, { request_id: r.id, ...rev(current) }), /closed|answered/);
});

test('own recovery survives departure; archived callers and corrupt metadata cannot bypass checks', async t => {
  const f = fixture(t), r = await f.create();
  f.members.get(worker).taskId = 'elsewhere';
  assert.equal(requests.listMine(f.rt, f.host, worker)[0].id, r.id);
  assert.deepEqual(requests.listMine(f.rt, f.host, other), []);
  await assert.rejects(requests.withdrawRequest(f.rt, f.host, other, { request_id: r.id }), /own|requester/);
  assert.equal((await requests.withdrawRequest(f.rt, f.host, worker, { request_id: r.id })).resolution.reason, 'withdrawn');
  f.members.get(worker).archived = true;
  assert.throws(() => requests.listMine(f.rt, f.host, worker), /archived/);
  f.rt.metadata.error = 'Corrupt metadata';
  await assert.rejects(f.create(other), /Corrupt metadata/);
});

test('expiry and human dismissal resolve without manufacturing an answer', async t => {
  const f = fixture(t), r = await f.create(queen, { expires_at: Date.now() + 1000 });
  requests.reconcileRequests(f.rt, f.host, { now: Date.now() + 2000 });
  assert.equal(f.rt.metadata.read().requests[r.id].resolution.reason, 'expired');
  const next = await f.create(queen);
  const closed = await requests.dismissRequest(f.rt, f.host, { request_id: next.id, ...rev(next), receipt: 'dismiss-1' });
  assert.equal(closed.resolution.by, 'human');
  assert.equal(closed.answer, null);
});

test('answer failure stays visible; uncertain delivery requires explicit repair and never reanswers', async t => {
  const f = fixture(t), r = await f.create(queen);
  f.host.deliver = async () => ({ mode: 'error', outcome: 'unknown', error: 'Timeout after paste' });
  const out = await requests.humanAnswer(f.rt, f.host, { request_id: r.id, ...rev(r), text: 'Yes', receipt: 'answer' });
  assert.equal(out.state, 'answered');
  assert.equal(out.delivery.state, 'uncertain');
  assert.equal(requests.needsHuman(out), true);
  f.host.deliver = async () => ({ mode: 'live' });
  const repaired = await requests.retryDelivery(f.rt, f.host, { request_id: r.id, ...rev(out), confirm_uncertain: true });
  assert.equal(repaired.delivery.state, 'delivered');
  assert.equal(repaired.answer.text, 'Yes');
});

test('dedupe is scoped to owner and cell; admission limits leave no partial messages', async t => {
  const f = fixture(t), r = await f.create(worker, { dedupe_key: 'api' });
  assert.equal((await f.create(worker, { dedupe_key: 'api' })).id, r.id);
  for (let i = 1; i < requests.OPEN_PER_SESSION; i++) await f.create();
  const count = f.rt.metadata.read().conversation.cell.length;
  await assert.rejects(f.create(), /limit/);
  assert.equal(f.rt.metadata.read().conversation.cell.length, count);
});

test('projection retains open request messages beyond conversation caps and reports native counts', async t => {
  const f = fixture(t), r = await f.create();
  const { publish } = await import('../server/conversation.js');
  f.rt.metadata.mutate(d => { for (let i = 0; i < 2000; i++) d.conversation.cell.push({ id: `old${i}`, author: 'session', text: 'routine', at: 1, threadId: r.threadId, n: i + 2 }); });
  await publish(f.rt, { sessionId: worker, cell: f.rt.metadata.cell('cell'), role: 'worker' }, { text: 'Newest routine', thread_id: r.threadId }, f.host);
  assert.ok(f.rt.metadata.read().conversation.cell.some(m => m.requestId === r.id));
  const { projectForGraph } = await import('../server/projection.js');
  Object.assign(f.rt, { beads: { status: { state: 'missing' } }, paths: {}, log() {} });
  const p = projectForGraph({ runtime: f.rt, snapshot: { graph: { beads: {}, edges: [] } } });
  assert.equal(p.cells.cell.requests[r.id], undefined);
  assert.equal(p.cells.cell.requestCounts.queen, 0);
  assert.equal(p.cells.cell.messages.some(m => m.requestId === r.id), false);
  assert.equal(p.cells.cell.threads.some(t => t.id === r.threadId), false);
  assert.equal(requests.requestContext(f.rt, { cell: f.rt.metadata.cell('cell'), role: 'queen', sessionId: queen }).input_requests[0].id, r.id);
  assert.equal(p.requestCount, 0);
});

test('native tools enforce caller identity and expose own recovery after leaving a hive', async t => {
  const f = fixture(t);
  const { workTools } = await import('../server/tools.js');
  const { hideTool } = await import('../server/manifest.js');
  const ask = workTools.find(x => x.name === 'hive_request_input');
  assert.ok(ask);
  const refused = await ask.handler({ host: f.host, caller: other }, { title: 'Question', body: 'Details', cell_id: 'cell' });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /request_human_input/);
  const response = await ask.handler({ host: f.host, caller: worker }, { title: 'Question', body: 'Details' });
  assert.equal(response.structuredContent.requesterSessionId, worker);
  assert.equal(hideTool({ host: f.host, caller: worker, tool: 'request_human_input' }), true);
  assert.equal(hideTool({ host: f.host, caller: other, tool: 'request_human_input' }), false);
  assert.equal(hideTool({ host: f.host, caller: other, tool: 'hive_request_input' }), true);
  f.members.get(worker).taskId = 'elsewhere';
  assert.equal(hideTool({ host: f.host, caller: worker, tool: 'hive_list_my_requests' }), false);
  assert.equal(hideTool({ host: f.host, caller: worker, tool: 'hive_withdraw_request' }), false);
  const mine = await workTools.find(x => x.name === 'hive_list_my_requests').handler({ host: f.host, caller: worker });
  assert.equal(mine.structuredContent.requests.length, 1);
});

test('human control handler fixes author identity; stale and competing submissions cannot overwrite answers', async t => {
  const f = fixture(t), r = await f.create(queen);
  const { configHandlers } = await import('../server/handlers.js');
  const handle = configHandlers.find(x => x.type === 'hive-request-answer');
  assert.ok(handle);
  let result;
  await handle.handler({ request_id: r.id, ...rev(r), text: 'Human says yes', receipt: 'browser-a', actor: 'queen' }, f.host, x => { result = x; });
  assert.equal(result.ok, true);
  assert.equal(result.request.answer.author, 'human');
  let second;
  await handle.handler({ request_id: r.id, ...rev(r), text: 'Competing answer', receipt: 'browser-b' }, f.host, x => { second = x; });
  assert.equal(second.ok, false);
  assert.equal(f.rt.metadata.read().requests[r.id].answer.text, 'Human says yes');
});

test('archived requester resolves explicitly, interrupted delivery becomes uncertain, and metadata reload retains request state', async t => {
  const f = fixture(t), r = await f.create();
  f.rt.metadata.mutate(d => { d.requests[r.id].queenNotification = { state: 'pending', attempts: [{ id: 'interrupted' }] }; });
  requests.reconcileRequests(f.rt, f.host, { startup: true });
  assert.equal(f.rt.metadata.read().requests[r.id].queenNotification.state, 'uncertain');
  const reopened = new MetadataStore({ file: f.rt.metadata.file });
  assert.equal(reopened.read().requests[r.id].body, 'Preserve the old API?');
  f.members.get(worker).archived = true;
  requests.reconcileRequests(f.rt, f.host);
  assert.equal(f.rt.metadata.read().requests[r.id].resolution.reason, 'requester-archived');
});

test('multi-cell ambiguity and unavailable membership refuse without writes', async t => {
  const f = fixture(t);
  f.rt.metadata.mutate(d => { d.cells.second = { ...d.cells.cell, id: 'second' }; });
  await assert.rejects(f.create(), /Several Hive/);
  assert.equal((await f.create(worker, { cell_id: 'cell' })).cellId, 'cell');
  f.host.tasks.forSession = () => { throw new Error('Assignment source unavailable'); };
  const version = f.rt.metadata.version;
  await assert.rejects(f.create(), /membership is unavailable/);
  assert.equal(f.rt.metadata.version, version);
});

test('corrupt native request map is unavailable rather than silently reset', t => {
  const f = fixture(t);
  fs.writeFileSync(f.rt.metadata.file, JSON.stringify({ schema: 1, requests: [] }));
  const reopened = new MetadataStore({ file: f.rt.metadata.file });
  assert.equal(reopened.available, false);
});

test('a concurrent delivery retry cannot dispatch the saved answer twice', async t => {
  const f = fixture(t), r = await f.create(queen);
  f.host.deliver = async () => ({ mode: 'error' });
  const answered = await requests.humanAnswer(f.rt, f.host, { request_id: r.id, ...rev(r), text: 'Yes', receipt: 'saved' });
  let finish;
  f.host.deliver = () => new Promise(resolve => { finish = resolve; });
  const first = requests.retryDelivery(f.rt, f.host, { request_id: r.id, ...rev(answered) });
  const pending = f.rt.metadata.read().requests[r.id];
  await assert.rejects(requests.retryDelivery(f.rt, f.host, { request_id: r.id, ...rev(pending), confirm_uncertain: true }), /progress/);
  finish({ mode: 'live' }); await first;
});

test('ordinary conversation comments leave native requests open and new requests apply conversation caps', async t => {
  const f = fixture(t), r = await f.create(queen);
  const { recordHumanInput } = await import('../server/conversation.js');
  await recordHumanInput(f.rt, { cellId: 'cell', text: 'An ordinary comment', threadId: r.threadId });
  assert.equal(f.rt.metadata.read().requests[r.id].state, 'open');
  f.rt.metadata.mutate(d => { for (let i = 0; i < 2100; i++) d.conversation.cell.push({ id: `extra${i}`, author: 'session', text: 'routine', at: 1, threadId: r.threadId }); });
  await f.create();
  assert.ok(f.rt.metadata.read().conversation.cell.length <= 2000);
  assert.ok(f.rt.metadata.read().conversation.cell.some(m => m.requestId === r.id));
});

test('dedupe edits preserve forwarded audience and invalidate the prior question revision', async t => {
  const f = fixture(t), r = await f.create(worker, { dedupe_key: 'api' });
  const forwarded = await requests.forwardRequest(f.rt, f.host, queen, { request_id: r.id, ...rev(r) });
  const edited = await f.create(worker, { dedupe_key: 'api', body: 'New question: keep both endpoints?' });
  assert.equal(edited.id, r.id);
  assert.equal(edited.audience, 'human');
  assert.equal(edited.body, 'New question: keep both endpoints?');
  assert.equal(edited.contentRevision, forwarded.contentRevision + 1);
  await assert.rejects(requests.humanAnswer(f.rt, f.host, { request_id: r.id, ...rev(forwarded), text: 'Old answer', receipt: 'stale' }), /changed/);
});

test('queen forward and answer replay recover the exact operation, without duplicated delivery', async t => {
  const f = fixture(t), r = await f.create();
  const args = { request_id: r.id, ...rev(r), recommendation: 'Keep it' };
  const forwarded = await requests.forwardRequest(f.rt, f.host, queen, args);
  assert.equal((await requests.forwardRequest(f.rt, f.host, queen, args)).revision, forwarded.revision);
  const second = await f.create(), answer = { request_id: second.id, ...rev(second), text: 'Keep it' };
  const answered = await requests.answerRequest(f.rt, f.host, queen, answer);
  const sent = f.sent.length;
  assert.equal((await requests.answerRequest(f.rt, f.host, queen, answer)).revision, answered.revision);
  assert.equal(f.sent.length, sent);
});

test('expiry and dismissal notify the requester that no approval was given', async t => {
  const f = fixture(t), r = await f.create(queen);
  await requests.dismissRequest(f.rt, f.host, { request_id: r.id, ...rev(r), receipt: 'dismissed' });
  assert.match(f.sent.at(-1).text, /dismissed/);
  assert.match(f.sent.at(-1).text, /no approval/i);
  const expiring = await f.create(worker, { expires_at: Date.now() + 1000, blocking: true });
  assert.match(expiring.next_step, /queen/);
  requests.reconcileRequests(f.rt, f.host, { now: Date.now() + 2000 });
  await requests.notifyResolution(f.rt, f.host, expiring.id);
  assert.match(f.sent.at(-1).text, /expired/);
  assert.equal(f.sent.at(-1).id, worker);
});


test('queen-only requests stay out of human history, paging, deep links and delivery-repair counts', async t => {
  const f = fixture(t), r = await f.create();
  const { threadList, threadHistory, resolveDeepLink, recordHumanInput, renameThread } = await import('../server/conversation.js');
  assert.deepEqual(threadList(f.rt, { cellId: 'cell' }).threads, []);
  assert.throws(() => threadHistory(f.rt, { cellId: 'cell', threadId: r.threadId }), /Unknown|unavailable/);
  assert.ok(resolveDeepLink(f.rt, { cellId: 'cell', threadId: r.threadId, messageId: r.messageId }).notice);
  await assert.rejects(recordHumanInput(f.rt, { cellId: 'cell', threadId: r.threadId, text: 'Secretly reply' }), /Unknown|unavailable/);
  assert.throws(() => renameThread(f.rt, { cellId: 'cell', threadId: r.threadId, title: 'Human rename' }), /Unknown|unavailable/);
  f.host.deliver = async () => ({ mode: 'error' });
  const answered = await requests.answerRequest(f.rt, f.host, queen, { request_id: r.id, ...rev(r), text: 'Queen guidance' });
  assert.equal(requests.needsHuman(answered), false);
  assert.equal(threadList(f.rt, { cellId: 'cell' }).threads.length, 0);
  assert.equal(requests.listMine(f.rt, f.host, worker)[0].answer.author, 'queen');
});

test('forwarding reveals the canonical topic and request without exposing other queen-stage questions', async t => {
  const f = fixture(t), privateRequest = await f.create();
  const shared = await f.create(worker, { thread_id: privateRequest.threadId, title: 'Second question', body: 'A public decision after forwarding' });
  const forwarded = await requests.forwardRequest(f.rt, f.host, queen, { request_id: shared.id, ...rev(shared) });
  const { threadList, threadHistory, resolveDeepLink } = await import('../server/conversation.js');
  const topics = threadList(f.rt, { cellId: 'cell' }).threads;
  assert.equal(topics.length, 1);
  assert.equal(topics[0].title, 'Second question');
  const history = threadHistory(f.rt, { cellId: 'cell', threadId: shared.threadId });
  assert.equal(history.messages.some(m => m.requestId === privateRequest.id), false);
  assert.equal(history.messages.some(m => m.requestId === forwarded.id), true);
  assert.deepEqual(history.messages.map(m => m.n), [1]);
  assert.equal(history.anchorN, 2);
  assert.ok(history.anchorN > history.messages.at(-1).n);
  const revealed = resolveDeepLink(f.rt, { cellId: 'cell', threadId: shared.threadId, messageId: shared.messageId });
  assert.ok(revealed.anchorN > revealed.messages.at(-1).n);
  assert.ok(resolveDeepLink(f.rt, { cellId: 'cell', threadId: shared.threadId, messageId: privateRequest.messageId }).notice);
});

test('disabling a hive does not promote private queen-stage requests into the human inbox', async t => {
  const f = fixture(t), r = await f.create();
  f.rt.metadata.mutate(d => { d.cells.cell.enabled = false; });
  requests.reconcileRequests(f.rt, f.host);
  const held = f.rt.metadata.read().requests[r.id];
  assert.equal(held.audience, 'queen');
  assert.equal(requests.needsHuman(held), false);
});

async function privacyFixture(t) {
  const f = fixture(t);
  f.members.get(other).taskId = 'task';
  f.rt.snapshots.graph.edges = [];
  f.rt.snapshots.refresh = async () => {};
  f.rt.beads = { status: { state: 'missing' } };
  f.host.tasks.get = () => ({ name: 'Fixture' });
  f.host.sessions.forTask = () => [...f.members.values()];
  f.actor = { sessionId: queen, role: 'queen', cell: f.rt.metadata.cell('cell') };
  f.conv = await import('../server/conversation.js');
  const { projectForGraph } = await import('../server/projection.js');
  f.projection = () => projectForGraph({ runtime: f.rt, snapshot: { graph: { beads: {}, edges: [] } } });
  return f;
}

test('forwarding an edited private draft exposes only canonical current text and title', async t => {
  const f = await privacyFixture(t);
  const secret = await f.create(worker, { title: 'SECRET DRAFT', dedupe_key: 'draft' });
  const revised = await f.create(worker, { title: 'Public revision', dedupe_key: 'draft' });
  await requests.forwardRequest(f.rt, f.host, queen, { request_id: revised.id, ...rev(revised) });
  const out = [f.conv.threadList(f.rt, { cellId: 'cell' }), f.conv.threadHistory(f.rt, { cellId: 'cell', threadId: secret.threadId }), f.projection(), f.conv.resolveDeepLink(f.rt, { cellId: 'cell', threadId: secret.threadId, messageId: secret.messageId })];
  assert.doesNotMatch(JSON.stringify(out), /SECRET DRAFT/);
  assert.equal(out[1].messages[0].text, 'Public revision');
});

test('public topic titles keep safe provenance after actual pruning and private request retention', async t => {
  const f = await privacyFixture(t), secret = await f.create(worker, { title: 'SECRET ORIGINAL TITLE' });
  const publicRequest = await f.create(worker, { thread_id: secret.threadId, title: 'Public decision' });
  await requests.forwardRequest(f.rt, f.host, queen, { request_id: publicRequest.id, ...rev(publicRequest) });
  await requests.answerRequest(f.rt, f.host, queen, { request_id: secret.id, ...rev(secret), text: 'Private answer' });
  f.rt.metadata.mutate(d => {
    for (let i = 0; i < 2000; i++) d.conversation.cell.push({ id: `msg_${(i + 1).toString(16).padStart(12, '0')}`, cellId: 'cell', author: 'session', role: 'worker', sessionId: worker, text: 'Routine', threadId: secret.threadId, at: Date.now(), n: i + 3 });
    Object.assign(d.threads.cell[secret.threadId], { count: 2002, lastAt: Date.now() });
  });
  await f.conv.publish(f.rt, f.actor, { text: 'Progress', thread_id: secret.threadId }, f.host);
  assert.equal(f.rt.metadata.read().conversation.cell.some(m => m.id === secret.messageId), false);
  const out = [f.conv.threadList(f.rt, { cellId: 'cell' }), f.projection(), f.conv.resolveDeepLink(f.rt, { cellId: 'cell', threadId: secret.threadId, messageId: publicRequest.messageId })];
  assert.doesNotMatch(JSON.stringify(out), /SECRET ORIGINAL TITLE/);
  assert.equal(out[0].threads[0].title, 'Public decision');
  assert.ok(f.conv.resolveDeepLink(f.rt, { cellId: 'cell', threadId: secret.threadId, messageId: secret.messageId, restore: true }).notice);
  f.rt.metadata.mutate(d => { delete d.requests[secret.id]; });
  assert.equal(f.conv.threadList(f.rt, { cellId: 'cell' }).threads[0].title, 'Public decision');
});

test('human sequence numbers, summaries and cursors depend only on visible rows', async t => {
  const f = await privacyFixture(t), first = await f.conv.publish(f.rt, f.actor, { text: 'Public start' }, f.host);
  await f.create(worker, { thread_id: first.thread_id });
  await f.create(worker, { thread_id: first.thread_id });
  const end = await f.conv.publish(f.rt, f.actor, { text: 'Public end', thread_id: first.thread_id }, f.host);
  await f.create(worker, { thread_id: first.thread_id });
  const history = f.conv.threadHistory(f.rt, { cellId: 'cell', threadId: first.thread_id });
  assert.deepEqual(history.messages.map(m => m.n), [1, 2]);
  assert.equal(history.anchorN, 3);
  const graph = f.projection().cells.cell;
  assert.deepEqual(graph.messages.map(m => m.n), [1, 2]);
  assert.equal(graph.threads[0].count, 2);
  assert.equal(graph.threads[0].waitingFrom.n, 1);
  assert.equal(graph.threads[0].earlierRemoved, false);
  const page = f.conv.inboxPage(f.rt, { cellId: 'cell', awaiting: 'human', limit: 1 });
  assert.deepEqual(page.messages.map(m => m.n), [1, 2]);
  const link = f.conv.resolveDeepLink(f.rt, { cellId: 'cell', threadId: first.thread_id, messageId: end.message_id });
  assert.deepEqual(link.messages.map(m => m.n), [1, 2]);
  assert.equal(link.anchorN, 3);
  const oldRevision = graph.conversationRevision;
  await f.create(worker, { thread_id: first.thread_id });
  assert.equal(f.projection().cells.cell.conversationRevision, oldRevision, 'private activity does not change visible paging');
  const request = requests.listMine(f.rt, f.host, worker)[0];
  await requests.forwardRequest(f.rt, f.host, queen, { request_id: request.id, ...rev(request) });
  assert.notEqual(f.projection().cells.cell.conversationRevision, oldRevision, 'forwarding invalidates cached visible numbering');
});

test('peer worker contexts omit private request topics and discussions but preserve public conversation', async t => {
  const f = await privacyFixture(t), secret = await f.create(worker, { title: 'SECRET OWNER QUESTION' });
  await f.conv.publish(f.rt, f.actor, { text: 'SECRET QUEEN DISCUSSION', reply_to: secret.messageId }, f.host);
  await f.conv.publish(f.rt, f.actor, { text: 'Shared public update' }, f.host);
  const own = await f.create(other, { title: 'Peer own request' });
  const { buildContext } = await import('../server/tools.js');
  const peer = await buildContext(f.rt, f.host, { sessionId: other, role: 'worker', cell: f.actor.cell });
  assert.doesNotMatch(JSON.stringify(peer), /SECRET|"requesterSessionId":"22222222/);
  assert.match(JSON.stringify(peer), /Shared public update/);
  assert.equal(peer.my_requests[0].id, own.id);
  const owner = await f.conv.cellContextConversation(f.rt, f.host, { sessionId: worker, cell: f.actor.cell, role: 'worker' });
  assert.match(JSON.stringify(owner), /SECRET OWNER QUESTION/);
  assert.doesNotMatch(JSON.stringify(owner), /Peer own request/);
  const queenContext = await buildContext(f.rt, f.host, f.actor);
  assert.equal(queenContext.input_requests.length, 2);
  assert.match(JSON.stringify(queenContext.conversation), /SECRET QUEEN DISCUSSION/);
  const before = f.rt.metadata.version;
  await assert.rejects(f.conv.publish(f.rt, { sessionId: other, cell: f.actor.cell }, { text: 'Probe', reply_to: secret.messageId }, f.host), /unavailable/);
  await assert.rejects(f.create(other, { thread_id: secret.threadId }), /Unknown|unavailable/);
  assert.equal(f.rt.metadata.version, before);
});

test('hidden request discussions reject image, acknowledgement and native human actions without revealing existence', async t => {
  const f = await privacyFixture(t), secret = await f.create();
  const { attachmentsInbox } = await import('../server/attachments.js');
  const inbox = await attachmentsInbox(f.rt, 'cell');
  fs.writeFileSync(path.join(inbox, 'private.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP0cAAAAASUVORK5CYII=', 'base64'));
  const reply = await f.conv.publish(f.rt, f.actor, { text: 'Private discussion', reply_to: secret.messageId, attachments: [{ file: 'private.png' }] }, f.host);
  const { configHandlers } = await import('../server/handlers.js');
  const run = async (type, args) => { let out; await configHandlers.find(h => h.type === type).handler(args, f.host, x => { out = x; }); return out; };
  for (const full of [true, false]) {
    const image = await run('hive-image', { cellId: 'cell', messageId: reply.message_id, file: 'private.png', full });
    assert.equal(image.dataBase64, undefined);
  }
  for (const [type, args] of [
    ['hive-ack', { cellId: 'cell', messageId: reply.message_id, kind: 'read', rev: 0 }],
    ...['approve', 'decline'].map(reaction => ['hive-ack', { cellId: 'cell', messageId: reply.message_id, kind: 'reaction', reaction, rev: 0 }]),
    ['hive-ack-undo', { cellId: 'cell', messageId: reply.message_id, rev: 0 }],
    ['hive-auto-read', { cellId: 'cell', messages: [{ messageId: reply.message_id, rev: 0 }] }],
    ['hive-request-answer', { request_id: secret.id, ...rev(secret), text: 'Probe', receipt: 'probe' }],
    ['hive-request-dismiss', { request_id: secret.id, ...rev(secret), receipt: 'probe' }],
    ['hive-request-retry', { request_id: secret.id, ...rev(secret) }],
  ]) {
    const out = await run(type, args);
    assert.equal(out.ok, false, type);
    assert.match(out.error, /unavailable|Unknown/);
    assert.equal(out.threadId, undefined);
    const missing = type.startsWith('hive-request-') ? { ...args, request_id: 'hreq_000000000000' } : type === 'hive-auto-read' ? { ...args, messages: [{ messageId: 'msg_missing', rev: 0 }] } : { ...args, messageId: 'msg_missing' };
    const unavailable = await run(type, missing);
    assert.equal(out.error, unavailable.error);
    assert.equal(out.code, unavailable.code);
  }
  assert.equal(f.rt.metadata.read().conversation.cell.find(m => m.id === reply.message_id).ack.state, null);
  const publicRequest = await f.create(worker, { thread_id: secret.threadId, title: 'Visible question' });
  await requests.forwardRequest(f.rt, f.host, queen, { request_id: publicRequest.id, ...rev(publicRequest) });
  assert.equal((await run('hive-image', { cellId: 'cell', messageId: reply.message_id, file: 'private.png', full: true })).dataBase64, undefined, 'selective forwarding does not reveal private replies');
  assert.doesNotMatch(JSON.stringify(f.projection()), /Private discussion/);
  const current = requests.listMine(f.rt, f.host, worker).find(r => r.id === secret.id);
  await requests.forwardRequest(f.rt, f.host, queen, { request_id: secret.id, ...rev(current) });
  assert.ok((await run('hive-image', { cellId: 'cell', messageId: reply.message_id, file: 'private.png', full: true })).dataBase64);
  const pendingImage = run('hive-image', { cellId: 'cell', messageId: reply.message_id, file: 'private.png', full: true });
  f.rt.metadata.mutate(d => { delete d.requests[secret.id]; });
  assert.equal((await pendingImage).dataBase64, undefined, 'image visibility is rechecked after the read');
});

for (const action of ['ack', 'reply', 'auto-read', 'approve', 'decline']) test(`human ${action} cannot settle private rows in a shared public topic`, async t => {
  const f = await privacyFixture(t), start = await f.conv.publish(f.rt, f.actor, { text: 'Public start' }, f.host);
  const secret = await f.create(worker, { thread_id: start.thread_id });
  const hidden = await f.conv.publish(f.rt, f.actor, { text: 'Secret reply', reply_to: secret.messageId }, f.host);
  const end = await f.conv.publish(f.rt, f.actor, { text: 'Public end', thread_id: start.thread_id }, f.host);
  if (['approve', 'decline'].includes(action)) await f.conv.recordHumanReaction(f.rt, { cellId: 'cell', messageId: end.message_id, reaction: action, rev: 0 });
  if (action === 'ack') f.conv.acknowledgeMessage(f.rt, { cellId: 'cell', messageId: end.message_id, kind: 'read', rev: 0 });
  if (action === 'reply') await f.conv.recordHumanInput(f.rt, { cellId: 'cell', threadId: start.thread_id, text: 'Public answer', readThrough: end.message_id });
  if (action === 'auto-read') assert.throws(() => f.conv.autoReadMessages(f.rt, { cellId: 'cell', messages: [{ messageId: start.message_id, rev: 0 }, { messageId: hidden.message_id, rev: 0 }] }), /unavailable/);
  assert.equal(f.rt.metadata.read().conversation.cell.find(m => m.id === hidden.message_id).ack.state, null);
});

test('human inbox cursors ignore private discussion acknowledgement activity', async t => {
  const f = await privacyFixture(t), start = await f.conv.publish(f.rt, f.actor, { text: 'Public start' }, f.host);
  const before = f.conv.inboxPage(f.rt, { cellId: 'cell', awaiting: 'human' }).rev;
  const secret = await f.create(worker, { thread_id: start.thread_id });
  await f.conv.publish(f.rt, f.actor, { text: 'Private reply', reply_to: secret.messageId }, f.host);
  assert.equal(f.conv.inboxPage(f.rt, { cellId: 'cell', awaiting: 'human' }).rev, before);
});

test('topic renames retain audience provenance and public renames remain effective', async t => {
  const f = await privacyFixture(t), secret = await f.create(worker, { title: 'SECRET DRAFT', dedupe_key: 'rename' });
  f.conv.updateThread(f.rt, f.actor, { thread_id: secret.threadId, title: 'SECRET CURATED' });
  const revised = await f.create(worker, { dedupe_key: 'rename', title: 'Current public question' });
  await requests.forwardRequest(f.rt, f.host, queen, { request_id: revised.id, ...rev(revised) });
  assert.equal(f.conv.threadList(f.rt, { cellId: 'cell' }).threads[0].title, 'Current public question');
  f.conv.updateThread(f.rt, f.actor, { thread_id: secret.threadId, title: 'Public curated topic' });
  assert.equal(f.conv.threadList(f.rt, { cellId: 'cell' }).threads[0].title, 'Public curated topic');
});

test('human workstream summaries count only visible conversation obligations', async t => {
  const f = await privacyFixture(t);
  f.rt.metadata.mutate(d => { d.cells.cell.rootBeadId = 'hive-root'; });
  f.rt.snapshots.hierarchyCurrent = true;
  f.rt.snapshots.current.error = null;
  f.rt.snapshots.graph.beads = { 'hive-root': { id: 'hive-root', status: 'open' }, 'hive-work': { id: 'hive-work', parentId: 'hive-root', title: 'Work', status: 'closed' } };
  f.actor.cell = f.rt.metadata.cell('cell');
  const secret = await f.create(worker, { bead_id: 'hive-work' });
  await f.conv.publish(f.rt, f.actor, { text: 'Private work discussion', reply_to: secret.messageId }, f.host);
  const { checkWorkstream } = await import('../server/workstreams.js');
  assert.equal(checkWorkstream(f.rt, { cellId: 'cell', headId: 'hive-work' }).waitingMessages, 0);
  await f.conv.publish(f.rt, f.actor, { text: 'Public work update', bead_id: 'hive-work' }, f.host);
  assert.equal(checkWorkstream(f.rt, { cellId: 'cell', headId: 'hive-work' }).waitingMessages, 1);
});

test('request retention keeps public discussion visible without revealing a private topic origin', async t => {
  const f = await privacyFixture(t), secret = await f.create(worker, { title: 'SECRET ORIGIN' });
  const visible = await f.create(worker, { thread_id: secret.threadId, title: 'Public decision' });
  const forwarded = await requests.forwardRequest(f.rt, f.host, queen, { request_id: visible.id, ...rev(visible) });
  await f.conv.publish(f.rt, f.actor, { text: 'Public follow-up', reply_to: visible.messageId }, f.host);
  await requests.humanAnswer(f.rt, f.host, { request_id: visible.id, ...rev(forwarded), receipt: 'settled', text: 'Proceed' });
  f.rt.metadata.mutate(d => {
    for (let i = 0; i < 500; i++) {
      const id = `hreq_${(i + 1).toString(16).padStart(12, '0')}`;
      d.requests[id] = { ...d.requests[visible.id], id, threadId: 'thr_000000000000', messageId: `msg_${(i + 1).toString(16).padStart(12, '0')}`, updatedAt: Date.now() + 10000 + i };
    }
  });
  await f.create(worker, { title: 'New private request' });
  assert.equal(f.rt.metadata.read().requests[visible.id], undefined);
  const out = [f.conv.threadList(f.rt, { cellId: 'cell' }), f.conv.inboxPage(f.rt, { cellId: 'cell', awaiting: 'human' })];
  assert.match(JSON.stringify(out), /Public follow-up/);
  assert.doesNotMatch(JSON.stringify(out), /SECRET ORIGIN/);
});

for (const pruned of [false, true]) test(`first private request leaves ${pruned ? 'pruned' : 'ordinary'} public paging unchanged`, async t => {
  const f = await privacyFixture(t), start = await f.conv.publish(f.rt, f.actor, { text: 'Public topic' }, f.host);
  if (pruned) f.rt.metadata.mutate(d => {
    d.conversation.cell[0].n = 3;
    Object.assign(d.threads.cell[start.thread_id], { count: 3, earlierRemoved: true });
  });
  const read = () => [f.conv.threadHistory(f.rt, { cellId: 'cell', threadId: start.thread_id }), f.conv.threadList(f.rt, { cellId: 'cell' }), f.conv.inboxPage(f.rt, { cellId: 'cell', awaiting: 'human' })];
  const before = read(), projected = f.projection().cells.cell.conversationRevision;
  const link = () => f.conv.resolveDeepLink(f.rt, { cellId: 'cell', threadId: start.thread_id, messageId: start.message_id });
  const beforeLink = link();
  await f.create(worker, { thread_id: start.thread_id });
  assert.deepEqual(read(), before);
  assert.deepEqual(link(), beforeLink);
  assert.equal(f.projection().cells.cell.conversationRevision, projected);
  assert.deepEqual(before[0].messages.map(m => m.n), [pruned ? 3 : 1]);
});

for (const retained of [false, true]) test(`human send stays public and reaches queen in ${retained ? 'retired' : 'selectively forwarded'} request topic`, async t => {
  const f = await privacyFixture(t), secret = await f.create(worker, { title: 'SECRET ORIGIN' });
  const visible = retained ? secret : await f.create(worker, { thread_id: secret.threadId, title: 'Public question' });
  const forwarded = await requests.forwardRequest(f.rt, f.host, queen, { request_id: visible.id, ...rev(visible) });
  if (retained) {
    await f.conv.publish(f.rt, f.actor, { text: 'Retained public discussion', reply_to: visible.messageId }, f.host);
    await requests.humanAnswer(f.rt, f.host, { request_id: visible.id, ...rev(forwarded), receipt: 'retire', text: 'Proceed' });
    f.rt.metadata.mutate(d => {
      for (let i = 0; i < 500; i++) {
        const id = `hreq_${(i + 1).toString(16).padStart(12, '0')}`;
        d.requests[id] = { ...d.requests[visible.id], id, threadId: 'thr_000000000000', messageId: `msg_${(i + 1).toString(16).padStart(12, '0')}`, updatedAt: Date.now() + 10000 + i };
      }
    });
    await f.create(worker, { title: 'New private request' });
    assert.equal(f.rt.metadata.read().requests[visible.id], undefined);
  }
  const { configHandlers } = await import('../server/handlers.js');
  let result;
  await configHandlers.find(h => h.type === 'hive-send').handler({ cellId: 'cell', threadId: visible.threadId, text: 'Human public comment' }, f.host, out => { result = out; });
  assert.equal(result.ok, true);
  assert.equal(result.delivery.state, 'delivered');
  const history = () => f.conv.threadHistory(f.rt, { cellId: 'cell', threadId: visible.threadId });
  assert.ok(history().messages.some(m => m.text === 'Human public comment'));
  assert.equal(f.sent.filter(m => m.id === queen && m.text.includes('Human public comment')).length, 1);
  assert.equal(f.rt.metadata.read().conversation.cell.find(m => m.id === result.messageId).requestScopeId, null);
  f.rt.metadata.mutate(d => { delete d.conversation.cell.find(m => m.id === result.messageId).requestScopeId; });
  assert.ok(history().messages.some(m => m.text === 'Human public comment'), 'legacy human messages also stay public');
  if (!retained) {
    assert.doesNotMatch(JSON.stringify(history()), /SECRET ORIGIN/);
    f.rt.metadata.mutate(d => {
      delete d.requests[visible.id];
      d.conversation.cell.find(m => m.id === result.messageId).requestScopeId = secret.id;
    });
    assert.ok(history().messages.some(m => m.text === 'Human public comment'), 'human authorship overrides stale private provenance');
    assert.doesNotMatch(JSON.stringify(history()), /SECRET ORIGIN/);
  }
  await f.conv.deliver(f.rt, f.host, { cellId: 'cell', messageId: result.messageId });
  assert.equal(f.sent.filter(m => m.id === queen && m.text.includes('Human public comment')).length, 1);
});

for (const destination of ['reply_to', 'thread_id']) test(`private ${destination} publication refuses public answer links atomically`, async t => {
  const f = await privacyFixture(t);
  const first = await f.conv.recordHumanInput(f.rt, { cellId: 'cell', text: 'Public question one' });
  const second = await f.conv.recordHumanInput(f.rt, { cellId: 'cell', text: 'Public question two' });
  const secret = await f.create(worker, { title: 'Private worker question' });
  if (destination === 'reply_to') {
    const publicSibling = await f.create(worker, { thread_id: secret.threadId, title: 'Visible sibling' });
    await requests.forwardRequest(f.rt, f.host, queen, { request_id: publicSibling.id, ...rev(publicSibling) });
  }
  const { attachmentsInbox } = await import('../server/attachments.js');
  const inbox = await attachmentsInbox(f.rt, 'cell');
  fs.writeFileSync(path.join(inbox, 'private.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP0cAAAAASUVORK5CYII=', 'base64'));
  const args = { text: 'Private discussion answer', attachments: [{ file: 'private.png' }], [destination]: destination === 'reply_to' ? secret.messageId : secret.threadId };
  const before = structuredClone(f.rt.metadata.read()), version = f.rt.metadata.version;
  const disk = fs.readFileSync(f.rt.metadata.file, 'utf8');
  await assert.rejects(f.conv.publish(f.rt, f.actor, { ...args, answers: [first.id, second.id] }, f.host), /private.*separate.*visible/i);
  assert.deepEqual(f.rt.metadata.read(), before);
  assert.equal(f.rt.metadata.version, version);
  assert.equal(fs.readFileSync(f.rt.metadata.file, 'utf8'), disk);
  assert.deepEqual(fs.readdirSync(path.dirname(inbox)), ['inbox'], 'rejected publication leaves no adopted attachment directory');
  assert.equal(fs.existsSync(path.join(inbox, 'private.png')), true);
  assert.deepEqual(f.conv.inboxPage(f.rt, { cellId: 'cell', awaiting: 'queen' }).ids.sort(), [first.id, second.id].sort());
  const queenContext = await f.conv.cellContextConversation(f.rt, f.host, f.actor);
  assert.equal(queenContext.awaiting_response_total, 2);
  assert.equal(queenContext.unacknowledged_input.length, 2);
  const privatePublication = await f.conv.publish(f.rt, f.actor, args, f.host);
  assert.deepEqual(privatePublication.answered, []);
  assert.doesNotMatch(JSON.stringify(f.projection()), /Private discussion answer/);
  const publicPublication = await f.conv.publish(f.rt, f.actor, { text: 'Visible answer to both', reply_to: first.id, answers: [second.id] }, f.host);
  assert.deepEqual(publicPublication.answered.sort(), [first.id, second.id].sort());
  assert.equal(f.conv.inboxPage(f.rt, { cellId: 'cell', awaiting: 'queen' }).count, 0);
  assert.equal((await f.conv.cellContextConversation(f.rt, f.host, f.actor)).awaiting_response_total, 0);
});

const choices = [{ id: 'keep', label: 'Keep API (Recommended)', description: 'Preserve compatibility.' }, { id: 'replace', label: 'Replace API' }];
test('options preserve Needs You shape, derived ids, explicit reservations and free text compatibility', async t => {
  const f = fixture(t);
  const r = await f.create(worker, { options: [{ label: 'Keep API' }, { id: 'keep-api', label: 'Explicit' }, { label: '☃' }, { label: 'Keep API' }], allow_free_text: false });
  assert.deepEqual(r.options.map(o => o.id), ['option-1', 'keep-api', 'option-3', 'option-4']);
  assert.equal(r.allowFreeText, true);
  assert.match(f.sent[0].text, /option-1.*Keep API/);
  const forwarded = await requests.forwardRequest(f.rt, f.host, queen, { request_id: r.id, ...rev(r), recommendation: 'Choose option-1.' });
  assert.deepEqual(forwarded.options, r.options);
  const out = await requests.humanAnswer(f.rt, f.host, { request_id: r.id, ...rev(forwarded), text: 'A different approach', receipt: 'free' });
  assert.equal(out.answer.optionId, null);
  assert.equal(out.answer.text, 'A different approach');
});

test('option validation rejects malformed choices before creating a conversation', async t => {
  const f = fixture(t);
  for (const options of [null, {}, Array(7).fill({ label: 'A' }), [{ label: ' ' }], [{ label: 'a'.repeat(81) }], [{ id: 'UPPER', label: 'A' }], [{ id: 'x', label: 'A' }, { id: 'x', label: 'B' }], [{ label: 'A', description: 'd'.repeat(301) }], [{ label: 'A', surprise: true }]]) {
    await assert.rejects(f.create(worker, { options }), /option/i);
  }
  await assert.rejects(f.create(worker, { allow_free_text: 'yes' }), /allow_free_text/);
  assert.equal(Object.keys(f.rt.metadata.read().requests).length, 0);
  assert.equal((f.rt.metadata.read().conversation.cell || []).length, 0);
});

for (const author of ['human', 'queen']) test(`${author} option answer stores choice and note, delivers id and label, and rejects competing choices`, async t => {
  const f = fixture(t), r = await f.create(author === 'human' ? queen : worker, { options: choices });
  const args = { request_id: r.id, ...rev(r), option_id: 'keep', text: ' after lunch ', ...(author === 'human' ? { receipt: 'option' } : {}) };
  const run = a => author === 'human' ? requests.humanAnswer(f.rt, f.host, a) : requests.answerRequest(f.rt, f.host, queen, a);
  const out = await run(args);
  assert.equal(out.answer.optionId, 'keep');
  assert.equal(out.answer.text, 'after lunch');
  assert.match(f.sent.at(-1).text, /Choice: Keep API \(Recommended\) \(keep\)/);
  assert.match(f.sent.at(-1).text, /Note: after lunch/);
  await run(args);
  const deliveries = f.sent.length;
  await assert.rejects(run({ ...args, option_id: 'replace' }), /answered|closed|conflict/);
  assert.equal(f.sent.length, deliveries);
});

test('option-only answers validate ids and retain revision guards across dedupe option changes', async t => {
  const f = fixture(t), r = await f.create(queen, { dedupe_key: 'options', options: choices });
  await assert.rejects(requests.humanAnswer(f.rt, f.host, { request_id: r.id, ...rev(r), option_id: 'missing', receipt: 'bad' }), /option/);
  const revised = await f.create(queen, { dedupe_key: 'options', options: [{ id: 'new', label: 'New choice' }] });
  assert.equal(revised.contentRevision, r.contentRevision + 1);
  await assert.rejects(requests.humanAnswer(f.rt, f.host, { request_id: r.id, ...rev(r), option_id: 'keep', receipt: 'stale' }), /revision|changed/);
  const results = await Promise.allSettled([
    requests.humanAnswer(f.rt, f.host, { request_id: r.id, ...rev(revised), option_id: 'new', receipt: 'first' }),
    requests.humanAnswer(f.rt, f.host, { request_id: r.id, ...rev(revised), text: 'Competing answer', receipt: 'second' }),
  ]);
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
  const saved = requests.listMine(f.rt, f.host, queen)[0];
  assert.equal(saved.answer.optionId, 'new');
  assert.equal(saved.answer.text, null);
});

test('native request tools reject unknown fields including nested option fields', async t => {
  const f = fixture(t), { workTools } = await import('../server/tools.js');
  const ask = workTools.find(tool => tool.name === 'hive_request_input');
  for (const args of [{ title: 'Q', body: 'B', surprise: true }, { title: 'Q', body: 'B', options: [{ label: 'A', surprise: true }] }]) {
    const out = await ask.handler({ host: f.host, caller: worker }, args);
    assert.equal(out.isError, true);
    assert.match(out.content[0].text, /surprise/);
  }
  assert.equal(requests.listMine(f.rt, f.host, worker).length, 0);
  const created = await ask.handler({ host: f.host, caller: worker }, { title: 'Q', body: 'B', options: choices });
  assert.notEqual(created.isError, true);
  const r = created.structuredContent;
  assert.deepEqual(r.options, choices);
  const answer = workTools.find(tool => tool.name === 'hive_answer_request');
  assert.equal((await answer.handler({ host: f.host, caller: queen }, { request_id: r.id, ...rev(r), option_id: 'keep', surprise: true })).isError, true);
  const ok = await answer.handler({ host: f.host, caller: queen }, { request_id: r.id, ...rev(r), option_id: 'keep' });
  assert.ok(!ok.isError);
  assert.equal(ok.structuredContent.answer.optionId, 'keep');
});

test('lazy relations exclude queen-only messages and do not trigger a rebuild', async t => {
  const f = fixture(t);
  const secret = await f.create(worker, { title: 'Private reference hive-secret' });
  const { topicRelations } = await import('../server/conversation.js');
  assert.throws(() => topicRelations(f.rt, { cellId: 'cell', threadId: secret.threadId }), /Unknown topic/);
  const shared = await f.create(worker, { thread_id: secret.threadId, title: 'Shared reference hive-public' });
  await requests.forwardRequest(f.rt, f.host, queen, { request_id: shared.id, ...rev(shared) });
  let rebuilds = 0;
  f.rt.changed = () => rebuilds++;
  const { configHandlers } = await import('../server/handlers.js');
  const handler = configHandlers.find(h => h.type === 'hive-thread-relations');
  let reply;
  await handler.handler({ cellId: 'cell', threadId: shared.threadId }, f.host, frame => { reply = frame; });
  assert.equal(reply.ok, true);
  assert.deepEqual(reply.relations.references, ['hive-public']);
  assert.equal(rebuilds, 0);
  await handler.handler({ cellId: 'cell', threadId: 'thr_000000000000' }, f.host, frame => { reply = frame; });
  assert.equal(reply.ok, false);
  assert.equal(rebuilds, 0, 'failed relation reads must also stay quiet');
});

test('human Inbox acknowledgement baselines exclude private discussion messages', async t => {
  const f = await privacyFixture(t);
  const visible = await f.conv.publish(f.rt, f.actor, { text: 'Visible update' }, f.host);
  const secret = await f.create(worker, { thread_id: visible.thread_id });
  const hidden = await f.conv.publish(f.rt, f.actor, { text: 'Hidden update', reply_to: secret.messageId }, f.host);
  const baseline = () => f.projection().cells.cell.inbox.human.acknowledgements;
  assert.equal(baseline()[visible.message_id].waiting, true);
  assert.equal(baseline()[hidden.message_id], undefined);
  assert.equal(baseline()[secret.messageId], undefined);
  f.conv.acknowledgeMessage(f.rt, { cellId: 'cell', messageId: visible.message_id, kind: 'read', rev: 0 });
  assert.equal(baseline()[visible.message_id].waiting, false);
  assert.equal(baseline()[visible.message_id].rev, 1);
  assert.equal(baseline()[hidden.message_id], undefined);
});

for (const action of ['human-answer', 'forward-answer', 'queen-answer', 'dismiss', 'withdraw', 'answer-delivery-fails']) test(`${action} keeps legacy request cards settled across reload without settling queen discussion`, async t => {
  const f = fixture(t);
  const conv = await import('../server/conversation.js');
  let r = await f.create(action === 'queen-answer' || action === 'forward-answer' ? worker : queen);
  if (action === 'forward-answer') r = await requests.forwardRequest(f.rt, f.host, queen, { request_id: r.id, ...rev(r) });
  const ordinary = await conv.publish(f.rt, { sessionId: queen, cell: f.rt.metadata.cell('cell'), role: 'queen' }, { text: 'Separate queen discussion', thread_id: r.threadId }, f.host);
  f.rt.metadata.mutate(d => { d.conversation.cell.find(m => m.id === r.messageId).ack = { required: true, rev: 0, state: null }; });
  const check = () => {
    const raw = f.rt.metadata.read();
    const d = conv.humanConversationDoc(raw, 'cell');
    const card = d.conversation.cell.find(m => m.id === r.messageId);
    if (card) assert.equal(card.ack, undefined);
    assert.deepEqual(conv.inboxSlice(d, 'cell', 'human').ids, action === 'queen-answer' ? [] : [ordinary.message_id]);
    assert.equal(raw.conversation.cell.find(m => m.id === ordinary.message_id).ack.state, null);
  };
  check();
  if (action === 'answer-delivery-fails') f.host.deliver = async () => ({ mode: 'error', outcome: 'unknown', error: 'Timeout' });
  const args = { request_id: r.id, ...rev(r), text: 'Approved', receipt: `settle-${action}` };
  if (action === 'queen-answer') await requests.answerRequest(f.rt, f.host, queen, args);
  else if (action === 'dismiss') await requests.dismissRequest(f.rt, f.host, args);
  else if (action === 'withdraw') await requests.withdrawRequest(f.rt, f.host, queen, args);
  else await requests.humanAnswer(f.rt, f.host, args);
  check();
  f.rt.metadata = new MetadataStore({ file: path.join(f.rt.paths.root, 'metadata.json') });
  check();
  assert.equal(f.rt.metadata.read().requests[r.id].state, ['dismiss', 'withdraw'].includes(action) ? 'resolved' : 'answered');
});

test('reaction replies preserve native request state, public revisions and private answer boundaries', async t => {
  const f = await privacyFixture(t);
  const source = await f.conv.publish(f.rt, f.actor, { text: 'Public proposal' }, f.host);
  const secret = await f.create(worker, { thread_id: source.thread_id });
  const hidden = await f.conv.publish(f.rt, f.actor, { text: 'Private request discussion', reply_to: secret.messageId }, f.host);
  const args = { cellId: 'cell', messageId: source.message_id, reaction: 'approve', rev: 0 };
  const reaction = await f.conv.recordHumanReaction(f.rt, args);
  assert.equal(reaction.inboxRev, f.conv.inboxPage(f.rt, { cellId: 'cell', awaiting: 'human' }).rev);
  const revision = reaction.inboxRev;
  await f.conv.publish(f.rt, f.actor, { text: 'Private follow-up', reply_to: secret.messageId }, f.host);
  const repeat = await f.conv.recordHumanReaction(f.rt, args);
  assert.equal(repeat.created, false);
  assert.equal(repeat.inboxRev, revision);
  await assert.rejects(f.conv.publish(f.rt, f.actor, { text: 'Private answer', reply_to: hidden.message_id, answers: [reaction.reactionMessageId] }, f.host), /private.*separate.*visible/i);
  const doc = f.rt.metadata.read();
  assert.deepEqual(doc.conversation.cell.find(m => m.id === reaction.reactionMessageId).response.answers, []);
  assert.equal(doc.requests[secret.id].state, 'open');
  assert.equal(doc.conversation.cell.find(m => m.id === hidden.message_id).ack.state, null);
  assert.doesNotMatch(JSON.stringify(f.projection()), /Private request discussion|Private follow-up/);
  const native = await f.create(queen, { thread_id: source.thread_id, title: 'Native human request' });
  await assert.rejects(f.conv.recordHumanReaction(f.rt, { ...args, messageId: native.messageId }), /Only queen messages/);
  assert.equal(f.rt.metadata.read().requests[native.id].state, 'open');
});

test('a decision without options, or a body listing options in prose, is refused with a pointer to options', async t => {
  const f = fixture(t);
  await assert.rejects(f.create(worker, { kind: 'decision' }), /pass .*options/i);
  for (const body of ['Options: A (recommended) … B … C: something else', 'Which way?\n**Options:** keep or replace', 'Which way?\n- Option A: keep\n- Option B: replace', 'Which way?\nChoices: keep / replace']) {
    await assert.rejects(f.create(worker, { kind: 'question', body }), /pass .*options.*even if/i);
    await assert.rejects(f.create(worker, { kind: 'approval', body }), /pass .*options/i);
  }
  assert.equal(Object.keys(f.rt.metadata.read().requests).length, 0);
  const ok = await f.create(worker, { kind: 'decision', options: choices, body: 'Options: keep or replace' });
  assert.equal(ok.options.length, 2);
});

test('free-text questions that merely mention options still pass', async t => {
  const f = fixture(t);
  for (const body of ['Option: we could just restart it. Is that OK?', 'What options do we have for caching?', 'Do you have any options in mind? Tell me more.', 'The options page is broken; how should it look?', 'Please describe the approach.\nA short list of steps is fine.']) {
    await f.create(worker, { kind: 'question', body, dedupe_key: `k${body.length}` });
  }
  await f.create(worker, { kind: 'manual-action', body: 'Run the installer, then say done.' });
  await f.create(worker, { kind: 'approval', body: 'Approve the merge?' });
});

test('the option guard also applies when a dedupe update drops the options', async t => {
  const f = fixture(t), r = await f.create(worker, { kind: 'decision', dedupe_key: 'd', options: choices });
  await assert.rejects(f.create(worker, { kind: 'decision', dedupe_key: 'd' }), /options/i);
  assert.deepEqual((await f.create(worker, { kind: 'decision', dedupe_key: 'd', options: choices })).options, r.options);
});

test('request session references validate board existence and survive dedupe edits', async t => {
  const f = fixture(t);
  const r = await f.create(queen, { session_id: other, session_label: 'Release worker', dedupe_key: 'session-action' });
  assert.deepEqual(r.sessionLink, { sessionId: other, label: 'Release worker' });
  const edited = await f.create(queen, { session_id: worker, session_label: 'Builder', dedupe_key: 'session-action' });
  assert.equal(edited.id, r.id);
  assert.deepEqual(edited.sessionLink, { sessionId: worker, label: 'Builder' });
  assert.ok(edited.contentRevision > r.contentRevision);
  const repeated = await f.create(queen, { dedupe_key: 'session-action' });
  assert.deepEqual(repeated.sessionLink, edited.sessionLink);
  await assert.rejects(f.create(queen, { session_id: '44444444-4444-4444-8444-444444444444' }), /session.*board|Unknown session/i);
  await assert.rejects(f.create(queen, { session_label: 'Without session' }), /session_id/);
});

for (const role of ['worker', 'reviewer']) test(`forwarded ${role} requests carry the requester session as well as an explicit target`, async t => {
  const f = fixture(t);
  f.rt.metadata.mutate(d => { d.bindings.cell = [{ active: true, sessionId: worker, role }]; });
  const r = await f.create(worker, { session_id: other });
  const forwarded = await requests.forwardRequest(f.rt, f.host, queen, { request_id: r.id, ...rev(r) });
  assert.deepEqual(forwarded.requesterSessionLink, { sessionId: worker, label: 'Open requester session' });
  assert.equal(forwarded.sessionLink.sessionId, other);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].id, queen);
});

test('published session references are stored separately from author identity and reject unknown targets', async t => {
  const f = fixture(t);
  const { publish } = await import('../server/conversation.js');
  const actor = { sessionId: queen, cell: f.rt.metadata.cell('cell'), role: 'queen' };
  const out = await publish(f.rt, actor, { text: 'Approve the command in this session.', session_id: worker, session_label: 'Build session' }, f.host);
  const m = f.rt.metadata.read().conversation.cell.find(m => m.id === out.message_id);
  assert.equal(m.sessionId, queen);
  assert.deepEqual(m.sessionLink, { sessionId: worker, label: 'Build session' });
  await assert.rejects(publish(f.rt, actor, { text: 'Unknown target', session_id: '44444444-4444-4444-8444-444444444444' }, f.host), /session.*board|Unknown session/i);
  assert.equal(f.sent.length, 0);
});
