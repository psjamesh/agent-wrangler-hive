import { schema } from './helpers/host-schema.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MetadataStore } from '../server/metadata-store.js';
import * as requests from '../server/requests.js';
import { attachmentsInbox, messageDir, readAttachment, MAX_IMAGE_BYTES, cleanupOrphanAttachments } from '../server/attachments.js';
import { cellContextConversation, humanConversationDoc } from '../server/conversation.js';
import { resolveCaller } from '../server/access.js';
import { configHandlers } from '../server/handlers.js';

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
  const host = { schema, stores: { hive: rt }, sessions: { get: id => members.get(id) }, tasks: { forSession: id => ({ taskId: members.get(id)?.taskId }) }, deliver: async (id, text) => { sent.push({ id, text }); return { mode: 'live' }; } };
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
  const { workTools } = await import('./helpers/tools.mjs');
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
  const { buildContext } = await import('./helpers/tools.mjs');
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
  const inbox = await attachmentsInbox(f.rt, 'cell', queen);
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
  const inbox = await attachmentsInbox(f.rt, 'cell', queen);
  fs.writeFileSync(path.join(inbox, 'private.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP0cAAAAASUVORK5CYII=', 'base64'));
  const args = { text: 'Private discussion answer', attachments: [{ file: 'private.png' }], [destination]: destination === 'reply_to' ? secret.messageId : secret.threadId };
  const before = structuredClone(f.rt.metadata.read()), version = f.rt.metadata.version;
  const disk = fs.readFileSync(f.rt.metadata.file, 'utf8');
  await assert.rejects(f.conv.publish(f.rt, f.actor, { ...args, answers: [first.id, second.id] }, f.host), /private.*separate.*visible/i);
  assert.deepEqual(f.rt.metadata.read(), before);
  assert.equal(f.rt.metadata.version, version);
  assert.equal(fs.readFileSync(f.rt.metadata.file, 'utf8'), disk);
  assert.deepEqual(fs.readdirSync(path.dirname(path.dirname(inbox))), ['inbox'], 'rejected publication leaves no adopted attachment directory');
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
  const f = fixture(t), { workTools } = await import('./helpers/tools.mjs');
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

async function routingFixture(t) {
  const f = await privacyFixture(t);
  f.rt.metadata.mutate(d => { d.cells.cell.rootBeadId = 'hive-root'; });
  f.rt.snapshots.hierarchyCurrent = true;
  f.rt.snapshots.current.error = null;
  f.rt.snapshots.graph.beads = {
    'hive-root': { id: 'hive-root', status: 'open' },
    'hive-work': { id: 'hive-work', parentId: 'hive-root', title: 'Work', status: 'open' },
    'hive-other': { id: 'hive-other', parentId: 'hive-root', title: 'Other', status: 'open' },
  };
  f.actor.cell = f.rt.metadata.cell('cell');
  return f;
}

for (const source of ['topic', 'message']) test(`request reply_to inherits the ${source} bead and a queen request answers the human`, async t => {
  const f = await routingFixture(t);
  const human = await f.conv.recordHumanInput(f.rt, { cellId: 'cell', text: 'Please clarify the scope', beadId: 'hive-work' });
  if (source === 'message') f.rt.metadata.mutate(d => { d.threads.cell[human.threadId].beadId = null; });
  const before = f.conv.inboxRev(f.rt.metadata.read(), 'cell');
  const r = await f.create(queen, { reply_to: human.id });
  assert.equal(r.threadId, human.threadId);
  assert.equal(r.beadId, 'hive-work');
  const doc = f.rt.metadata.read(), h = doc.conversation.cell.find(m => m.id === human.id);
  const m = doc.conversation.cell.find(m => m.id === r.messageId);
  assert.equal(m.replyTo, human.id);
  assert.deepEqual(m.answers, [human.id]);
  assert.deepEqual(h.response.answers, [{ messageId: r.messageId, sessionId: queen, at: m.at }]);
  assert.equal(h.acknowledgedBy, queen);
  assert.equal(f.conv.awaitingQueen(h), false);
  assert.ok(f.conv.inboxRev(doc, 'cell') > before);
  assert.ok(f.conv.threadHistory(f.rt, { cellId: 'cell', threadId: human.threadId }).messages.some(m => m.id === r.messageId));
});

test('request reply_to accepts its matching thread and rejects conflicting or unavailable targets atomically', async t => {
  const f = await routingFixture(t);
  const a = await f.conv.recordHumanInput(f.rt, { cellId: 'cell', text: 'First question' });
  const b = await f.conv.recordHumanInput(f.rt, { cellId: 'cell', text: 'Second question' });
  const before = structuredClone(f.rt.metadata.read());
  await assert.rejects(f.create(queen, { reply_to: a.id, thread_id: b.threadId }), /reply.*another topic|reply_to.*thread_id/i);
  await assert.rejects(f.create(queen, { reply_to: 'msg_000000000000' }), /Unknown|unavailable/);
  assert.deepEqual(f.rt.metadata.read(), before);
  assert.equal((await f.create(queen, { reply_to: a.id, thread_id: a.threadId })).threadId, a.threadId);
});

test('worker request replies stay private and do not answer human messages', async t => {
  const f = await routingFixture(t);
  const h = await f.conv.recordHumanInput(f.rt, { cellId: 'cell', text: 'Public question' });
  const r = await f.create(worker, { reply_to: h.id });
  assert.equal(r.threadId, h.threadId);
  assert.equal(f.conv.awaitingQueen(f.rt.metadata.read().conversation.cell.find(m => m.id === h.id)), true);
  assert.ok(!f.conv.threadHistory(f.rt, { cellId: 'cell', threadId: h.threadId }).messages.some(m => m.id === r.messageId));
  f.members.get(other).taskId = 'task';
  await assert.rejects(f.create(other, { reply_to: r.messageId }), /Unknown|unavailable/);
});

test('thread-only request takes the topic bead while an explicit conflicting bead is rejected', async t => {
  const f = await routingFixture(t);
  const h = await f.conv.recordHumanInput(f.rt, { cellId: 'cell', text: 'Scope question', beadId: 'hive-work' });
  const r = await f.create(queen, { thread_id: h.threadId });
  assert.equal(r.beadId, 'hive-work');
  assert.equal(r.threadId, h.threadId);
  await assert.rejects(f.create(queen, { thread_id: h.threadId, bead_id: 'hive-other' }), /Topic and cell context disagree/);
});

test('bead-only request reuses its sole visible topic in the cell', async t => {
  const f = await routingFixture(t);
  const h = await f.conv.recordHumanInput(f.rt, { cellId: 'cell', text: 'Scope question', beadId: 'hive-work' });
  await f.conv.recordHumanInput(f.rt, { cellId: 'cell', text: 'Other work', beadId: 'hive-other' });
  const r = await f.create(queen, { bead_id: 'hive-work' });
  assert.equal(r.threadId, h.threadId);
  assert.equal(Object.keys(f.rt.metadata.read().threads.cell).length, 2);
});

for (const count of [0, 2]) test(`bead-only request starts a new topic when ${count} match`, async t => {
  const f = await routingFixture(t), topics = [];
  for (let i = 0; i < count; i++) topics.push((await f.conv.recordHumanInput(f.rt, { cellId: 'cell', text: `Question ${i}`, beadId: 'hive-work' })).threadId);
  const r = await f.create(queen, { bead_id: 'hive-work' });
  assert.equal(topics.includes(r.threadId), false);
  assert.equal(Object.keys(f.rt.metadata.read().threads.cell).length, count + 1);
});

test('dedupe reply_to cannot move an existing request to another topic', async t => {
  const f = await routingFixture(t);
  const h = await f.conv.recordHumanInput(f.rt, { cellId: 'cell', text: 'Scope question' });
  const r = await f.create(queen, { dedupe_key: 'scope' });
  await assert.rejects(f.create(queen, { dedupe_key: 'scope', reply_to: h.id }), /dedupe.*context/i);
  assert.equal(f.rt.metadata.read().requests[r.id].threadId, r.threadId);
});

for (const action of ['read', 'reaction', 'reply']) test(`${action} acknowledges queen FYIs independently of human waits and request badges`, async t => {
  const f = await privacyFixture(t);
  f.rt.metadata.mutate(d => { d.cells.cell.rootBeadId = 'hive-root'; });
  f.rt.snapshots.graph.beads = { 'hive-root': { id: 'hive-root', kind: 'goal' } };
  const { projectForGraph } = await import('../server/projection.js');
  f.projection = () => projectForGraph({ runtime: f.rt, snapshot: { graph: f.rt.snapshots.graph } });
  const { cellWaitingItems } = await import('../public/waiting-model.js');
  const { inboxRows } = await import('../public/global-inbox.js');
  const { default: client, createUi } = await import('../public/client.js');
  let view;
  client.register({ api: { state: () => ({ hive: f.projection() }) }, register: (kind, value) => { if (kind === 'view') view = value; } });
  const ui = createUi();
  const update = await f.conv.publish(f.rt, f.actor, { text: 'FYI: the build is running.' }, f.host);
  const check = (unread, needs) => {
    const hive = f.projection(), cell = hive.cells.cell;
    const ctx = { hive, graph: { sessions: [] }, ui };
    assert.equal(cell.inbox.human.count, unread);
    assert.equal(cell.threads.find(t => t.id === update.thread_id).awaiting.human?.count || 0, unread);
    assert.equal(inboxRows(ctx, [cell], 'human').some(r => r.unreadCount > 0), Boolean(unread));
    assert.deepEqual(cell.waits, []);
    assert.equal(cellWaitingItems(ctx, cell).length, needs);
    assert.equal(cell.requestCounts.human, needs);
    assert.equal(hive.requestCount, needs);
    assert.equal(view.badge({ hive }), needs);
  };
  check(1, 0);
  const r = await f.create(queen);
  check(1, 1);
  if (action === 'reply') {
    await f.conv.recordHumanInput(f.rt, { cellId: 'cell', text: 'Thanks', replyTo: update.message_id, ackRev: 0 });
  } else {
    f.conv.acknowledgeMessage(f.rt, { cellId: 'cell', messageId: update.message_id, kind: action, emoji: action === 'reaction' ? '👍' : undefined, rev: 0 });
  }
  const ack = f.rt.metadata.read().conversation.cell.find(m => m.id === update.message_id).ack;
  assert.equal(ack.state.kind, action);
  assert.equal(ack.rev, 1);
  check(0, 1);
  await requests.humanAnswer(f.rt, f.host, { request_id: r.id, ...rev(r), text: 'Yes', receipt: `fyi-${action}` });
  check(0, 0);
});


const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nGQAAAAASUVORK5CYII=', 'base64');
async function imageFixture(t, caller = worker) {
  const f = fixture(t), inbox = await attachmentsInbox(f.rt, 'cell', caller);
  const put = (file, bytes = PNG) => fs.writeFileSync(path.join(inbox, file), bytes);
  put('screen.png');
  return { ...f, inbox, put };
}
async function humanImage(f, r) {
  let reply;
  await configHandlers.find(h => h.type === 'hive-image').handler({ cellId: 'cell', messageId: r.messageId, file: 'screen.png', full: true }, f.host, out => { reply = out; });
  return reply;
}

for (const role of ['queen', 'worker', 'reviewer', 'helper']) test(`${role} request stores original images, retains them on forwarding and survives restart`, async t => {
  const caller = role === 'queen' ? queen : worker, f = await imageFixture(t, caller);
  if (role === 'reviewer' || role === 'helper') f.rt.metadata.mutate(d => { d.bindings.cell = [{ sessionId: worker, role, active: true }]; });
  const r = await f.create(caller, { attachments: [{ file: 'screen.png', alt: 'Settings before the change' }] });
  const message = f.rt.metadata.read().conversation.cell.find(m => m.id === r.messageId);
  assert.deepEqual(r.attachments, [{ file: 'screen.png', alt: 'Settings before the change', mime: 'image/png' }]);
  assert.deepEqual(message.attachments, r.attachments);
  assert.deepEqual(fs.readFileSync(path.join(messageDir(f.rt, 'cell', r.messageId), 'screen.png')), PNG);
  fs.unlinkSync(path.join(f.inbox, 'screen.png'));
  if (role !== 'queen') {
    assert.equal((await humanImage(f, r)).missing, true);
    assert.equal(humanConversationDoc(f.rt.metadata.read(), 'cell').conversation.cell.length, 0);
    assert.deepEqual(requests.requestContext(f.rt, resolveCaller(f.rt, f.host, queen, 'cell')).input_requests[0].attachments, r.attachments);
    const forwarded = await requests.forwardRequest(f.rt, f.host, queen, { request_id: r.id, ...rev(r) });
    assert.equal(forwarded.id, r.id);
    assert.equal(forwarded.messageId, r.messageId);
    assert.deepEqual(forwarded.attachments, r.attachments);
  }
  f.rt.metadata = new MetadataStore({ file: f.rt.metadata.file });
  await cleanupOrphanAttachments(f.rt);
  const got = await humanImage(f, r);
  assert.equal(got.mime, 'image/png');
  assert.deepEqual(Buffer.from(got.dataBase64, 'base64'), PNG);
  assert.deepEqual(requests.listMine(f.rt, f.host, caller)[0].attachments, r.attachments);
});

test('request attachments reject invalid files atomically with the shared validation', async t => {
  const f = await imageFixture(t);
  f.put('bad.png', Buffer.from('<svg/>'));
  f.put('large.png', Buffer.alloc(MAX_IMAGE_BYTES + 1));
  fs.symlinkSync(path.join(f.inbox, 'screen.png'), path.join(f.inbox, 'link.png'));
  fs.mkdirSync(path.join(f.inbox, 'dir.png'));
  for (const [file, error] of [['../screen.png', /bare/], ['absent.png', /could not read/], ['bad.png', /magic/], ['large.png', /5 MB/], ['link.png', /regular/], ['dir.png', /regular/]]) {
    await assert.rejects(f.create(worker, { attachments: [{ file: 'screen.png' }, { file }] }), error);
    assert.deepEqual(Object.keys(f.rt.metadata.read().requests), []);
    assert.equal(f.rt.metadata.read().conversation.cell?.length || 0, 0);
    assert.deepEqual(fs.readdirSync(path.dirname(path.dirname(f.inbox))), ['inbox']);
  }
  for (const attachments of [null, {}, Array(5).fill({ file: 'screen.png' })]) await assert.rejects(f.create(worker, { attachments }), /at most 4/);
});

test('failed request metadata commit removes adopted files and leaves no request', async t => {
  const f = await imageFixture(t), mutate = f.rt.metadata.mutate.bind(f.rt.metadata);
  f.rt.metadata.mutate = fn => mutate(d => { fn(d); throw new Error('disk failed'); });
  await assert.rejects(f.create(worker, { attachments: [{ file: 'screen.png' }] }), /disk failed/);
  assert.deepEqual(Object.keys(f.rt.metadata.read().requests), []);
  assert.deepEqual(fs.readdirSync(path.dirname(path.dirname(f.inbox))), ['inbox']);
});

test('dedupe retries and text updates preserve request images without reopening inbox files', async t => {
  const f = await imageFixture(t), args = { dedupe_key: 'image', attachments: [{ file: 'screen.png' }] };
  const r = await f.create(worker, args);
  fs.unlinkSync(path.join(f.inbox, 'screen.png'));
  const same = await f.create(worker, args);
  assert.equal(same.revision, r.revision);
  const revised = await f.create(worker, { dedupe_key: 'image', title: 'Updated question' });
  assert.deepEqual(revised.attachments, r.attachments);
  assert.deepEqual((await readAttachment(f.rt, 'cell', r.messageId, 'screen.png')).bytes, PNG);
  await assert.rejects(f.create(worker, { ...args, attachments: [{ file: 'other.png' }] }), /new request/);
});

test('bead-scoped worker context exposes the attachments inbox', async t => {
  const f = await imageFixture(t);
  const context = await cellContextConversation(f.rt, f.host, resolveCaller(f.rt, f.host, worker, 'cell'), { bead_id: 'work' });
  assert.equal(context.attachments_inbox, f.inbox);
});

test('request attachment adoption rechecks membership and cleans up if the caller leaves', async t => {
  const f = await imageFixture(t);
  f.rt.attachmentHelperStarted = action => { if (action === 'adopt') f.members.get(worker).taskId = 'elsewhere'; };
  await assert.rejects(f.create(worker, { attachments: [{ file: 'screen.png' }] }), /not in that active Hive/);
  assert.deepEqual(Object.keys(f.rt.metadata.read().requests), []);
  assert.deepEqual(fs.readdirSync(path.dirname(path.dirname(f.inbox))), ['inbox']);
});


test('session inboxes isolate identical names for requests and queen publishing', async t => {
  const f = await imageFixture(t);
  const queenContext = await cellContextConversation(f.rt, f.host, resolveCaller(f.rt, f.host, queen, 'cell'));
  const workerContext = await cellContextConversation(f.rt, f.host, resolveCaller(f.rt, f.host, worker, 'cell'), { bead_id: 'work' });
  assert.equal(workerContext.attachments_inbox, f.inbox);
  assert.notEqual(queenContext.attachments_inbox, f.inbox);
  const queenBytes = Buffer.concat([PNG, Buffer.from('queen')]);
  fs.writeFileSync(path.join(queenContext.attachments_inbox, 'screen.png'), queenBytes);
  const r = await f.create(worker, { attachments: [{ file: 'screen.png' }] });
  const { publish } = await import('../server/conversation.js');
  const q = await publish(f.rt, resolveCaller(f.rt, f.host, queen, 'cell'), { text: 'Queen image', attachments: [{ file: 'screen.png' }] });
  assert.deepEqual((await readAttachment(f.rt, 'cell', r.messageId, 'screen.png')).bytes, PNG);
  assert.deepEqual((await readAttachment(f.rt, 'cell', q.message_id, 'screen.png')).bytes, queenBytes);
});

test('requests cannot adopt another session or legacy shared inbox files', async t => {
  const f = await imageFixture(t);
  const queenInbox = await attachmentsInbox(f.rt, 'cell', queen);
  fs.writeFileSync(path.join(queenInbox, 'queen.png'), PNG);
  const shared = path.dirname(f.inbox);
  fs.writeFileSync(path.join(shared, 'legacy.png'), PNG);
  for (const file of ['queen.png', 'legacy.png', `../${queen}/queen.png`]) {
    await assert.rejects(f.create(worker, { attachments: [{ file }] }), /could not read|bare/);
  }
  const { publish } = await import('../server/conversation.js');
  await assert.rejects(publish(f.rt, resolveCaller(f.rt, f.host, queen, 'cell'), { text: 'Another session image', attachments: [{ file: 'screen.png' }] }), /could not read/);
  assert.equal(fs.existsSync(path.join(shared, 'legacy.png')), true);
  assert.equal(fs.existsSync(path.join(queenInbox, 'queen.png')), true);
  assert.deepEqual(Object.keys(f.rt.metadata.read().requests), []);
});

const docPin = { kind: 'document', url: 'https://example.com/design', revision: 'revision-7' };
const prPin = { kind: 'pr', url: 'https://github.com/example/project/pull/1', revision: 'a'.repeat(40) };

test('approval subject pins survive forwarding, human receipt, delivery and reload', async t => {
  const f = fixture(t), r = await f.create(worker, { kind: 'approval', subject_pin: docPin });
  assert.deepEqual(r.subjectPin, docPin);
  const forwarded = await requests.forwardRequest(f.rt, f.host, queen, { request_id: r.id, ...rev(r) });
  const answered = await requests.humanAnswer(f.rt, f.host, { request_id: r.id, ...rev(forwarded), text: 'Approved', receipt: 'pin-answer' });
  assert.deepEqual(answered.answer.subjectPin, docPin);
  assert.match(f.sent.at(-1).text, /revision-7/);
  const loaded = new MetadataStore({ file: f.rt.metadata.file });
  assert.deepEqual(loaded.read().requests[r.id].answer.subjectPin, docPin);
});

test('subject pins validate exact revisions and cannot be silently retargeted by dedupe', async t => {
  const f = fixture(t);
  for (const subject_pin of [null, {}, { ...docPin, url: 'javascript:alert(1)' }, { ...docPin, revision: ' ' }, { ...prPin, revision: 'abc1234' }]) {
    await assert.rejects(f.create(queen, { kind: 'approval', subject_pin }), /subject_pin/);
  }
  const r = await f.create(queen, { kind: 'approval', subject_pin: docPin, dedupe_key: 'pin' });
  assert.equal((await f.create(queen, { kind: 'approval', dedupe_key: 'pin' })).id, r.id);
  await assert.rejects(f.create(queen, { kind: 'approval', subject_pin: { ...docPin, revision: 'revision-8' }, dedupe_key: 'pin' }), /new request/);
  assert.deepEqual(f.rt.metadata.read().requests[r.id].subjectPin, docPin);
});

test('document changes retain human answer and notify the queen once per observed change', async t => {
  const f = fixture(t), r = await f.create(queen, { kind: 'approval', subject_pin: docPin });
  await requests.humanAnswer(f.rt, f.host, { request_id: r.id, ...rev(r), text: 'Approved', receipt: 'pin-answer' });
  f.sent.length = 0;
  const report = revision => requests.observeRequestSubject(f.rt, f.host, queen, { request_id: r.id, revision });
  const changed = await report('revision-8');
  assert.deepEqual(changed.answer.subjectPin, docPin);
  assert.equal(changed.subjectObservation.revision, 'revision-8');
  assert.equal(changed.state, 'answered');
  assert.equal(changed.answer.text, 'Approved');
  assert.equal(f.sent[0].id, queen);
  assert.match(f.sent[0].text, /Human answer was for revision-7, now revision-8/);
  await report('revision-8');
  assert.equal(f.sent.length, 1);
  assert.equal(requests.requestContext(f.rt, { cell: f.rt.metadata.cell('cell'), role: 'queen', sessionId: queen }).recent_input_requests[0].subjectObservation.revision, 'revision-8');
  await report('revision-7');
  assert.equal(f.rt.metadata.read().requests[r.id].subjectObservation.revision, 'revision-7');
});

test('only the requester or current queen can report a document revision', async t => {
  const f = fixture(t), r = await f.create(worker, { kind: 'approval', subject_pin: docPin });
  f.members.get(other).taskId = 'task';
  await assert.rejects(requests.observeRequestSubject(f.rt, f.host, other, { request_id: r.id, revision: 'revision-8' }), /requester|queen/);
  const changed = await requests.observeRequestSubject(f.rt, f.host, worker, { request_id: r.id, revision: 'revision-8' });
  const forwarded = await requests.forwardRequest(f.rt, f.host, queen, { request_id: r.id, ...rev(changed) });
  const answered = await requests.humanAnswer(f.rt, f.host, { request_id: r.id, ...rev(forwarded), text: 'Proceed', receipt: 'changed-before-answer' });
  assert.deepEqual(answered.answer.subjectPin, docPin);
  assert.equal(answered.subjectObservation.revision, 'revision-8');
});

test('shared PR observations report changed heads, ignore stale/errors and recover at startup', async t => {
  const f = fixture(t), r = await f.create(queen, { kind: 'approval', subject_pin: prPin });
  await requests.humanAnswer(f.rt, f.host, { request_id: r.id, ...rev(r), text: 'Approved', receipt: 'pr-answer' });
  const firstAt = Date.now() - 1000;
  let observed = { url: prPin.url, headSha: 'b'.repeat(40), fetchedAt: firstAt, state: 'open' };
  f.host.links = { prObservation: () => observed };
  const listeners = new Map();
  f.host.events = { on(name, fn) { listeners.set(name, fn); return () => listeners.delete(name); } };
  const stop = requests.startRequestSubjects(f.rt, f.host);
  await listeners.get('pr:observation')();
  const current = () => f.rt.metadata.read().requests[r.id];
  assert.equal(current().subjectObservation.revision, 'b'.repeat(40));
  assert.deepEqual(current().answer.subjectPin, prPin);
  const count = f.sent.length;
  await listeners.get('pr:observation')();
  assert.equal(f.sent.length, count);
  observed = { ...observed, headSha: 'c'.repeat(40), fetchedAt: Date.now() - 600000 };
  await listeners.get('pr:observation')();
  assert.equal(current().subjectObservation.revision, 'b'.repeat(40));
  observed = { ...observed, fetchedAt: firstAt + 1, lastError: 'offline' };
  await listeners.get('pr:observation')();
  assert.equal(current().subjectObservation.revision, 'b'.repeat(40));
  observed = { ...observed, lastError: null };
  await requests.reconcileRequestSubjects(f.rt, f.host);
  assert.equal(current().subjectObservation.revision, 'c'.repeat(40));
  stop();
  assert.equal(listeners.size, 0);
});

test('subject change delivery failures persist and a successor queen receives the mismatch', async t => {
  const f = fixture(t), r = await f.create(queen, { kind: 'approval', subject_pin: docPin });
  await requests.humanAnswer(f.rt, f.host, { request_id: r.id, ...rev(r), text: 'No', receipt: 'subject-declined' });
  f.host.deliver = async () => ({ mode: 'error', outcome: 'unknown', error: 'May have arrived' });
  const changed = await requests.observeRequestSubject(f.rt, f.host, queen, { request_id: r.id, revision: 'revision-8' });
  assert.equal(changed.subjectNotification.state, 'uncertain');
  const context = requests.requestContext(f.rt, { cell: f.rt.metadata.cell('cell'), role: 'queen', sessionId: queen });
  assert.equal(context.approval_subject_changes_total, 1);
  assert.equal(context.approval_subject_changes[0].notification.state, 'uncertain');
  assert.equal(changed.answer.text, 'No');
  f.rt.metadata.mutate(d => { d.cells.cell.queenSessionId = worker; d.cells.cell.queenGeneration++; });
  const sent = [];
  f.host.deliver = async (id, text) => { sent.push({ id, text }); return { mode: 'live' }; };
  await requests.reconcileRequestSubjects(f.rt, f.host);
  await requests.reconcileRequestSubjects(f.rt, f.host);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].id, worker);
});

test('native request tools accept optional pins and document observation reports', async t => {
  const f = fixture(t), { workTools } = await import('./helpers/tools.mjs');
  const ask = workTools.find(x => x.name === 'hive_request_input');
  const result = await ask.handler({ host: f.host, caller: queen }, { title: 'Review design', body: 'Approve this revision?', kind: 'approval', subject_pin: docPin });
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent.subjectPin, docPin);
  const report = workTools.find(x => x.name === 'hive_observe_request_subject');
  assert.ok(report);
  const changed = await report.handler({ host: f.host, caller: queen }, { request_id: result.structuredContent.id, revision: 'revision-8' });
  assert.equal(changed.structuredContent.subjectObservation.revision, 'revision-8');
});

test('PR subject changes ignore out-of-order observations and stop with retired runtime', async t => {
  const f = fixture(t), r = await f.create(queen, { kind: 'approval', subject_pin: prPin });
  const at = Date.now() - 10000;
  let observed = { url: prPin.url, headSha: 'b'.repeat(40), fetchedAt: at, state: 'open' };
  f.host.links = { prObservation: () => observed };
  await requests.reconcileRequestSubjects(f.rt, f.host);
  observed = { ...observed, headSha: 'c'.repeat(40), fetchedAt: at - 1 };
  await requests.reconcileRequestSubjects(f.rt, f.host);
  assert.equal(f.rt.metadata.read().requests[r.id].subjectObservation.revision, 'b'.repeat(40));
  const version = f.rt.metadata.version;
  f.rt.metadata.lifetime.stop();
  observed = { ...observed, fetchedAt: Date.now() };
  await requests.reconcileRequestSubjects(f.rt, f.host);
  assert.equal(f.rt.metadata.version, version);
});

test('answering an already changed subject neither repins nor repeats the change notice', async t => {
  const f = fixture(t), r = await f.create(queen, { kind: 'approval', subject_pin: docPin });
  const changed = await requests.observeRequestSubject(f.rt, f.host, queen, { request_id: r.id, revision: 'revision-8' });
  const notices = () => f.sent.filter(m => /approval subject changed/.test(m.text));
  assert.equal(notices().length, 1);
  const answered = await requests.humanAnswer(f.rt, f.host, { request_id: r.id, ...rev(changed), text: 'Proceed', receipt: 'observed-before-answer' });
  assert.deepEqual(answered.answer.subjectPin, docPin);
  assert.equal(notices().length, 1);
  const returned = await requests.observeRequestSubject(f.rt, f.host, queen, { request_id: r.id, revision: 'revision-7' });
  assert.equal(returned.subjectObservation.revision, 'revision-7');
  await requests.observeRequestSubject(f.rt, f.host, queen, { request_id: r.id, revision: 'revision-8' });
  assert.equal(notices().length, 2);
});

test('local document path pins retain their revision without fetching or linking a file URL', async t => {
  const f = fixture(t), subject_pin = { kind: 'document', path: 'docs/design.md', revision: 'revision-3' };
  const r = await f.create(queen, { kind: 'approval', subject_pin });
  const answered = await requests.humanAnswer(f.rt, f.host, { request_id: r.id, ...rev(r), text: 'Approved', receipt: 'path-answer' });
  assert.deepEqual(answered.answer.subjectPin, subject_pin);
  assert.match(f.sent.at(-1).text, /docs\/design.md/);
  const changed = await requests.observeRequestSubject(f.rt, f.host, queen, { request_id: r.id, revision: 'revision-4' });
  assert.equal(changed.subjectObservation.revision, 'revision-4');
});

test('unchanged PR observations do not invalidate an outstanding human answer revision', async t => {
  const f = fixture(t), r = await f.create(queen, { kind: 'approval', subject_pin: prPin });
  let fetchedAt = Date.now() - 1000;
  f.host.links = { prObservation: () => ({ url: prPin.url, headSha: prPin.revision, fetchedAt, state: 'open' }) };
  await requests.reconcileRequestSubjects(f.rt, f.host);
  fetchedAt++;
  await requests.reconcileRequestSubjects(f.rt, f.host);
  assert.equal(f.rt.metadata.read().requests[r.id].revision, r.revision);
  const answered = await requests.humanAnswer(f.rt, f.host, { request_id: r.id, ...rev(r), text: 'Approved', receipt: 'unchanged-pin' });
  assert.deepEqual(answered.answer.subjectPin, prPin);
});

test('subject reconciliation through raw and proxied runtimes shares one notification in flight', async t => {
  const f = fixture(t), r = await f.create(queen, { kind: 'approval', subject_pin: docPin });
  let release, count = 0;
  f.host.deliver = async () => { count++; await new Promise(resolve => { release = resolve; }); return { mode: 'live' }; };
  const first = requests.observeRequestSubject(f.rt, f.host, queen, { request_id: r.id, revision: 'revision-8' });
  const proxy = new Proxy(f.rt, {});
  const second = requests.observeRequestSubject(proxy, f.host, queen, { request_id: r.id, revision: 'revision-8' });
  release();
  await Promise.all([first, second]);
  assert.equal(count, 1);
});

test('forwarding during a subject notification retains its delivery receipt', async t => {
  const f = fixture(t), r = await f.create(worker, { kind: 'approval', subject_pin: docPin });
  let release;
  f.host.deliver = async () => { await new Promise(resolve => { release = resolve; }); return { mode: 'live' }; };
  const report = requests.observeRequestSubject(f.rt, f.host, worker, { request_id: r.id, revision: 'revision-8' });
  const current = f.rt.metadata.read().requests[r.id];
  await requests.forwardRequest(f.rt, f.host, queen, { request_id: r.id, ...rev(current) });
  release();
  const changed = await report;
  assert.equal(changed.subjectNotification.state, 'delivered');
});

test('pruning during a subject notice cannot turn committed requests or answers into failures', async t => {
  const f = fixture(t), logs = [];
  f.rt.log = message => logs.push(message);
  const pinned = await f.create(queen, { kind: 'approval', subject_pin: docPin });
  await requests.humanAnswer(f.rt, f.host, { request_id: pinned.id, ...rev(pinned), text: 'Approved', receipt: 'old-answer' });
  const pending = await f.create(queen);
  let release;
  f.host.deliver = async (_id, body) => {
    if (body.startsWith('[Hive approval subject changed:')) await new Promise(resolve => { release = resolve; });
    return { mode: 'live' };
  };
  const report = requests.observeRequestSubject(f.rt, f.host, queen, { request_id: pinned.id, revision: 'revision-8' });
  const created = f.create(queen, { title: 'Unrelated question' });
  const answered = requests.humanAnswer(f.rt, f.host, { request_id: pending.id, ...rev(pending), text: 'Saved answer', receipt: 'concurrent-answer' });
  f.rt.metadata.mutate(d => { delete d.requests[pinned.id]; });
  release();
  const results = await Promise.allSettled([report, created, answered]);
  assert.deepEqual(results.map(r => r.status), ['fulfilled', 'fulfilled', 'fulfilled']);
  assert.equal(results[1].value.title, 'Unrelated question');
  assert.equal(results[2].value.answer.text, 'Saved answer');
  assert.equal(f.rt.metadata.read().requests[pending.id].answer.text, 'Saved answer');
  assert.equal(logs.length, 0);
});

test('a failed shared subject pass is logged without rejecting an already committed answer', async t => {
  const f = fixture(t), logs = [];
  f.rt.log = message => logs.push(message);
  const pinned = await f.create(queen, { kind: 'approval', subject_pin: docPin });
  await requests.observeRequestSubject(f.rt, f.host, queen, { request_id: pinned.id, revision: 'revision-8' });
  const pending = await f.create(queen);
  const getSession = f.host.sessions.get;
  f.host.deliver = async () => {
    f.host.sessions.get = id => { if (id === queen) throw new Error('Queen lookup unavailable'); return getSession(id); };
    return { mode: 'live' };
  };
  const answered = await requests.humanAnswer(f.rt, f.host, { request_id: pending.id, ...rev(pending), text: 'Saved answer', receipt: 'lookup-failed' });
  assert.equal(answered.state, 'answered');
  assert.equal(answered.answer.text, 'Saved answer');
  assert.equal(logs.length, 1);
  assert.match(logs[0], /could not establish session availability/);
});

for (const state of ['failed', 'uncertain', 'pending']) test(`dismiss ${state} answer delivery preserves history and clears attention without sending`, async t => {
  const f = await privacyFixture(t), r = await f.create(queen);
  f.host.deliver = async () => ({ mode: 'error', outcome: 'unknown', error: 'Delivery unavailable' });
  const answered = await requests.humanAnswer(f.rt, f.host, { request_id: r.id, ...rev(r), text: 'Saved decision', receipt: 'answer' });
  f.rt.metadata.mutate(d => { d.requests[r.id].delivery.state = state; });
  const before = f.rt.metadata.read().requests[r.id];
  let sends = 0;
  f.host.deliver = async () => { sends++; return { mode: 'live' }; };
  assert.equal(f.projection().requestCount, 1);
  const args = { request_id: r.id, ...rev(before), receipt: 'dismiss-answer' };
  await assert.rejects(requests.dismissRequest(f.rt, f.host, { ...args, revision: before.revision - 1 }), /changed/);
  await assert.rejects(requests.dismissRequest(f.rt, f.host, { ...args, route_revision: before.routeRevision - 1 }), /changed/);
  const dismissed = await requests.dismissRequest(f.rt, f.host, args);
  assert.equal(dismissed.state, 'resolved');
  assert.equal(dismissed.resolution.reason, 'dismissed');
  assert.equal(dismissed.resolution.by, 'human');
  assert.ok(dismissed.resolution.at >= answered.answer.at);
  assert.deepEqual(dismissed.answer, before.answer);
  assert.deepEqual(dismissed.delivery, before.delivery);
  const reopened = new MetadataStore({ file: f.rt.metadata.file });
  assert.deepEqual(reopened.read().requests[r.id], dismissed);
  assert.equal(requests.needsHuman(dismissed), false);
  assert.deepEqual(await requests.dismissRequest(f.rt, f.host, args), dismissed);
  await assert.rejects(requests.retryDelivery(f.rt, f.host, { request_id: r.id, ...rev(dismissed), confirm_uncertain: true }), /current answered request/);
  await assert.rejects(requests.humanAnswer(f.rt, f.host, { request_id: r.id, ...rev(r), text: 'Saved decision', receipt: 'answer' }), /already answered or closed/);
  requests.reconcileRequests(f.rt, f.host, { startup: true });
  await requests.notifyResolution(f.rt, f.host, r.id);
  assert.equal(sends, 0);
  assert.deepEqual(requests.listMine(f.rt, f.host, queen)[0].answer, before.answer);
  const hive = f.projection(), cell = hive.cells.cell;
  assert.equal(hive.requestCount, 0);
  assert.equal(cell.requestCounts.human, 0);
  const { inboxRows } = await import('../public/global-inbox.js');
  const { cellWaitingItems } = await import('../public/waiting-model.js');
  const { createUi } = await import('../public/client.js');
  const ctx = { hive, graph: { sessions: [] }, ui: createUi() };
  assert.equal(inboxRows(ctx, [cell], 'needs').length, 0);
  assert.equal(cellWaitingItems(ctx, cell).length, 0);
});

test('delivered answers cannot be dismissed', async t => {
  const f = fixture(t), r = await f.create(queen);
  const answered = await requests.humanAnswer(f.rt, f.host, { request_id: r.id, ...rev(r), text: 'Received', receipt: 'answer' });
  await assert.rejects(requests.dismissRequest(f.rt, f.host, { request_id: r.id, ...rev(answered), receipt: 'dismiss' }), /already answered or closed/);
});

test('queen rewrite is human-facing while worker reads and answer delivery retain the original request', async t => {
  const f = fixture(t), r = await f.create(worker, { dedupe_key: 'rewrite' });
  const args = { request_id: r.id, ...rev(r), title: 'Keep existing integrations working?', body: 'Keeping compatibility avoids breaking existing integrations.', recommendation: 'Keep compatibility' };
  const forwarded = await requests.forwardRequest(f.rt, f.host, queen, args);
  assert.equal(forwarded.forwarded.title, args.title);
  assert.equal(forwarded.forwarded.body, args.body);
  assert.equal((await requests.forwardRequest(f.rt, f.host, queen, args)).revision, forwarded.revision);
  await assert.rejects(requests.forwardRequest(f.rt, f.host, queen, { ...args, title: 'Different' }), /queen|changed/);
  const visible = humanConversationDoc(f.rt.metadata.read(), 'cell');
  assert.equal(visible.conversation.cell[0].text, args.title);
  assert.equal(visible.threads.cell[r.threadId].title, args.title);
  const own = requests.listMine(f.rt, f.host, worker)[0];
  assert.equal(own.title, r.title);
  assert.equal(own.body, r.body);
  assert.equal(own.forwarded.body, args.body);
  const answered = await requests.humanAnswer(f.rt, f.host, { request_id: r.id, ...rev(forwarded), text: 'Yes', receipt: 'rewrite-answer' });
  assert.equal(answered.delivery.state, 'delivered');
  assert.equal(f.sent.at(-1).id, worker);
  assert.ok(f.sent.at(-1).text.includes(r.title));
  assert.ok(!f.sent.at(-1).text.includes(args.title));
});

for (const rewrite of [{ title: 'Plain title' }, { body: 'Plain body' }, {}]) test(`forward preserves choices, dedupe and revisions with ${JSON.stringify(rewrite)}`, async t => {
  const f = fixture(t);
  const options = [{ id: 'keep', label: 'Keep compatibility (Recommended)' }, { id: 'break', label: 'Remove compatibility' }];
  const r = await f.create(worker, { dedupe_key: 'choices', kind: 'decision', options });
  const forwarded = await requests.forwardRequest(f.rt, f.host, queen, { request_id: r.id, ...rev(r), ...rewrite });
  assert.deepEqual(forwarded.options, options);
  assert.equal(forwarded.contentRevision, r.contentRevision);
  assert.equal(forwarded.routeRevision, r.routeRevision + 1);
  assert.equal(forwarded.requesterSessionLink.sessionId, worker);
  const updated = await f.create(worker, { dedupe_key: 'choices', kind: 'decision', options, body: 'Updated compatibility context' });
  assert.equal(updated.id, r.id);
  assert.equal(updated.contentRevision, r.contentRevision + 1);
  assert.equal(updated.forwarded.title, rewrite.title);
  assert.equal(updated.forwarded.body, rewrite.body);
  const answered = await requests.humanAnswer(f.rt, f.host, { request_id: r.id, ...rev(updated), option_id: 'keep', text: 'Please keep it', receipt: 'choices-answer' });
  assert.equal(answered.answer.optionId, 'keep');
  assert.equal(f.sent.at(-1).id, worker);
  assert.match(f.sent.at(-1).text, /Keep compatibility/);
});

for (const rewrite of [{ title: '' }, { body: ' ' }, { title: 'x'.repeat(201) }, { body: 'x'.repeat(20001) }, { title: null }]) test('invalid forwarding rewrite leaves the request queued', async t => {
  const f = fixture(t), r = await f.create();
  await assert.rejects(requests.forwardRequest(f.rt, f.host, queen, { request_id: r.id, ...rev(r), ...rewrite }), /title|body/);
  assert.equal(requests.listMine(f.rt, f.host, worker)[0].audience, 'queen');
});

test('a worker edit makes a forwarded rewrite stale in human conversation and topic titles', async t => {
  const f = fixture(t), r = await f.create(worker, { dedupe_key: 'edited-forward' });
  const forwarded = await requests.forwardRequest(f.rt, f.host, queen, { request_id: r.id, ...rev(r), title: 'Earlier summary', body: 'Earlier explanation' });
  assert.equal(forwarded.forwarded.contentRevision, r.contentRevision);
  const edited = await f.create(worker, { dedupe_key: 'edited-forward', title: 'Current question', body: 'Current explanation' });
  const visible = humanConversationDoc(f.rt.metadata.read(), 'cell');
  assert.equal(visible.conversation.cell[0].text, edited.title);
  assert.equal(visible.threads.cell[r.threadId].title, edited.title);
  assert.equal(edited.audience, 'human');
  assert.equal(edited.routeRevision, forwarded.routeRevision);
  assert.equal(edited.forwarded.title, 'Earlier summary');
});
