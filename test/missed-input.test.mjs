import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MetadataStore } from '../server/metadata-store.js';
import { recordHumanInput, deliver, acknowledgeInput, publish } from '../server/conversation.js';
import { notifyMissedInput } from '../server/missed-input.js';
import { createManifest } from '../server/manifest.js';
import { buildContext } from '../server/tools.js';
import { buildGraph } from '../server/bead-model.js';
import * as requests from '../server/requests.js';

const queen = '11111111-1111-4111-8111-111111111111';
const worker = '22222222-2222-4222-8222-222222222222';
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-missed-input-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'metadata.json');
  const metadata = new MetadataStore({ file });
  metadata.mutate(d => { d.cells.cell = { id: 'cell', taskId: 'task', rootBeadId: 'root', enabled: true, queenSessionId: queen, queenGeneration: 1 }; });
  const graph = buildGraph([{ id: 'root', title: 'Root', status: 'open' }]);
  const rt = { metadata, paths: { root, attachmentDir: root }, changed() {}, log() {}, recover: async () => {}, workerRestores: new Map(), pendingParticipants: new Map(), snapshots: { graph, current: { loadedAt: 1 }, refresh: async () => {}, maybeRefresh() {} }, beads: { status: { state: 'ready' } } };
  const sent = [], members = new Map([queen, worker].map(sessionId => [sessionId, { sessionId, taskId: 'task', status: 'idle' }]));
  const host = { stores: { hive: rt }, sessions: { get: id => members.get(id), forTask: () => [...members.values()] }, tasks: { get: () => ({ name: 'Example' }), forSession: () => ({ taskId: 'task' }) }, deliver: async (id, text) => { sent.push({ id, text }); return { mode: 'live' }; } };
  rt.host = host;
  const actor = { cell: metadata.cell('cell'), sessionId: queen, role: 'queen' };
  const sweep = () => createManifest({ dir: root }).sweeps.find(s => s.id === 'refresh').run({ host });
  const input = (text = 'Please recover this message', extra = {}) => recordHumanInput(rt, { cellId: 'cell', text, ...extra });
  const failDelivery = async m => {
    host.deliver = async () => { throw new Error("Cannot read properties of undefined (reading 'ref')"); };
    const out = await deliver(rt, host, { cellId: 'cell', messageId: m.id });
    assert.equal(out.state, 'uncertain');
    host.deliver = async (id, text) => { sent.push({ id, text }); return { mode: 'live' }; };
  };
  return { rt, host, sent, actor, members, file, input, failDelivery, sweep };
}

test('watchdog pass consolidates outage messages and persists receipts without repeating original attempts', async t => {
  const f = fixture(t), messages = [];
  for (let i = 0; i < 3; i++) {
    const m = await f.input(`Outage message ${i}`, { newThread: { title: `Topic ${i}` } });
    await f.failDelivery(m);
    if (i === 2) f.rt.metadata.mutate(d => { d.conversation.cell.find(x => x.id === m.id).delivery.state = 'failed'; });
    messages.push(m);
  }
  await assert.rejects(deliver(f.rt, f.host, { cellId: 'cell', messageId: messages[0].id }), /unknown outcome/);
  await f.sweep();
  assert.equal(f.sent.length, 1);
  for (const m of messages) {
    assert.ok(f.sent[0].text.includes(m.id));
    assert.ok(f.sent[0].text.includes(m.text));
    assert.ok(f.sent[0].text.includes(f.rt.metadata.read().threads.cell[m.threadId].title));
    const saved = f.rt.metadata.read().conversation.cell.find(x => x.id === m.id);
    assert.equal(saved.delivery.state, m === messages[2] ? 'failed' : 'uncertain');
    assert.equal(saved.delivery.attempts.length, 1);
    assert.equal(saved.delivery.recoveryNotices[`${queen}:1`].state, 'delivered');
  }
  f.rt.metadata = new MetadataStore({ file: f.file });
  await f.sweep();
  assert.equal(f.sent.length, 1);
  const context = await buildContext(f.rt, f.host, f.actor);
  assert.equal(context.attention.missed_input.length, 3);
});

test('successful later delivery reports old failures, excluding acknowledged, answered and withdrawn messages', async t => {
  const f = fixture(t);
  const missed = await f.input('Still waiting'); await f.failDelivery(missed);
  for (const state of ['acknowledged', 'answered', 'withdrawn', 'delivered']) {
    const m = await f.input(state); await f.failDelivery(m);
    f.rt.metadata.mutate(d => {
      const x = d.conversation.cell.find(x => x.id === m.id);
      if (state === 'acknowledged') x.acknowledgedAt = Date.now();
      if (state === 'answered') x.response.answers.push({ messageId: 'reply', at: Date.now() });
      if (state === 'withdrawn') x.response.withdrawn = { at: Date.now() };
      if (state === 'delivered') x.delivery.state = 'delivered';
    });
  }
  const next = await f.input('New successful message');
  await deliver(f.rt, f.host, { cellId: 'cell', messageId: next.id });
  assert.equal(f.sent.length, 2);
  assert.ok(f.sent[1].text.includes(missed.id));
  const context = await buildContext(f.rt, f.host, f.actor);
  assert.deepEqual(context.attention.missed_input.map(x => x.message_id), [missed.id]);
  acknowledgeInput(f.rt, f.actor, { message_ids: [missed.id] });
  assert.deepEqual((await buildContext(f.rt, f.host, f.actor)).attention.missed_input, []);
});

test('failed summaries can recover on another pass; concurrent passes send one summary', async t => {
  const f = fixture(t), m = await f.input(); await f.failDelivery(m);
  f.host.deliver = async () => ({ mode: 'error', error: 'Unavailable' });
  await f.sweep();
  let release, started;
  const ready = new Promise(resolve => { started = resolve; });
  f.host.deliver = async (id, text) => { f.sent.push({ id, text }); started(); await new Promise(resolve => { release = resolve; }); return { mode: 'live' }; };
  const first = f.sweep();
  await ready;
  const second = f.sweep();
  assert.equal(f.sent.length, 1);
  release(); await Promise.all([first, second]);
  await f.sweep();
  assert.equal(f.sent.length, 1);
});

test('human request answers to the queen join the summary without redelivering the answer', async t => {
  const f = fixture(t), m = await f.input(); await f.failDelivery(m);
  const r = await requests.createRequest(f.rt, f.host, queen, { title: 'Approve action?', body: 'May we proceed?' });
  f.host.deliver = async () => ({ mode: 'error', outcome: 'unknown', error: 'Outage' });
  await requests.humanAnswer(f.rt, f.host, { request_id: r.id, revision: r.revision, route_revision: r.routeRevision, text: 'Proceed carefully', receipt: 'human-reply' });
  f.host.deliver = async (id, text) => { f.sent.push({ id, text }); return { mode: 'live' }; };
  await f.sweep();
  assert.equal(f.sent.length, 1);
  assert.ok(f.sent[0].text.includes(r.id));
  assert.match(f.sent[0].text, /Approve action\?|Proceed carefully/);
  const saved = f.rt.metadata.read().requests[r.id];
  assert.equal(saved.delivery.state, 'uncertain');
  assert.equal(saved.delivery.attempts.length, 1);
  const context = await buildContext(f.rt, f.host, f.actor);
  assert.ok(context.attention.missed_input.some(x => x.request_id === r.id));
  await f.sweep();
  assert.equal(f.sent.length, 1);
});

test('disabled and snapshot hives send no recovery; worker context does not reveal recovery input', async t => {
  const f = fixture(t), m = await f.input(); await f.failDelivery(m);
  for (const field of ['enabled', 'snapshot']) {
    f.rt.metadata.mutate(d => { d.cells.cell[field] = field === 'snapshot'; });
    await f.sweep();
    assert.equal(f.sent.length, 0);
    f.rt.metadata.mutate(d => { d.cells.cell[field] = field === 'enabled'; });
  }
  const context = await buildContext(f.rt, f.host, { ...f.actor, role: 'worker', sessionId: worker });
  assert.equal(context.attention.missed_input, undefined);
});

for (const outcome of [{ mode: 'error', outcome: 'unknown' }, null]) test(`unconfirmed recovery summary leaves the original untouched and recovers at a later event: ${JSON.stringify(outcome)}`, async t => {
  const f = fixture(t), m = await f.input('x'.repeat(400)); await f.failDelivery(m);
  f.host.deliver = async () => outcome;
  await f.sweep();
  assert.equal(f.rt.metadata.read().conversation.cell[0].delivery.attempts.length, 1);
  f.host.deliver = async (id, text) => { f.sent.push({ id, text }); return { mode: 'live' }; };
  await f.sweep();
  assert.equal(f.sent.length, 1);
  assert.ok(!f.sent[0].text.includes('x'.repeat(161)));
  await f.sweep();
  assert.equal(f.sent.length, 1);
});

test('successor summary includes predecessor queen answers and excludes worker answers', async t => {
  const f = fixture(t);
  const q = await requests.createRequest(f.rt, f.host, queen, { title: 'Queen decision', body: 'Proceed?' });
  const w = await requests.createRequest(f.rt, f.host, worker, { title: 'Worker decision', body: 'Proceed?' });
  const forwarded = await requests.forwardRequest(f.rt, f.host, queen, { request_id: w.id, revision: w.revision, route_revision: w.routeRevision });
  f.host.deliver = async () => ({ mode: 'error', outcome: 'unknown' });
  for (const r of [q, forwarded]) await requests.humanAnswer(f.rt, f.host, { request_id: r.id, revision: r.revision, route_revision: r.routeRevision, text: 'Proceed', receipt: r.id });
  f.rt.metadata.mutate(d => { d.cells.cell.queenSessionId = worker; d.cells.cell.queenGeneration++; });
  f.sent.length = 0;
  f.host.deliver = async (id, text) => { f.sent.push({ id, text }); return { mode: 'live' }; };
  await f.sweep();
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].id, worker);
  assert.ok(f.sent[0].text.includes(q.id));
  assert.ok(f.sent[0].text.includes(queen));
  assert.match(f.sent[0].text, /successor queen owns acting/);
  assert.ok(!f.sent[0].text.includes(w.id));
  const actor = { cell: f.rt.metadata.cell('cell'), role: 'queen', sessionId: worker };
  const items = (await buildContext(f.rt, f.host, actor)).attention.missed_input;
  assert.equal(items.length, 1);
  assert.equal(items[0].answer.text, 'Proceed');
  assert.equal(items[0].answer.author, 'human');
  assert.equal(items[0].requester_session_id, queen);
  assert.deepEqual(acknowledgeInput(f.rt, actor, { message_ids: [w.id] }).unknown, [w.id]);
  assert.equal(f.rt.metadata.read().requests[w.id].delivery.state, 'uncertain');
  await f.sweep();
  assert.equal(f.sent.length, 1);
});

for (const method of ['request-id', 'message-id', 'topic-reply']) test(`successor receipt settles a recovered answer via ${method} without another delivery`, async t => {
  const f = fixture(t);
  const r = await requests.createRequest(f.rt, f.host, queen, { title: 'Queen decision', body: 'Proceed?' });
  f.host.deliver = async () => ({ mode: 'error', outcome: 'unknown' });
  await requests.humanAnswer(f.rt, f.host, { request_id: r.id, revision: r.revision, route_revision: r.routeRevision, text: 'Proceed', receipt: r.id });
  f.rt.metadata.mutate(d => { d.cells.cell.queenSessionId = worker; d.cells.cell.queenGeneration++; });
  const actor = { cell: f.rt.metadata.cell('cell'), role: 'queen', sessionId: worker };
  if (method === 'topic-reply') await publish(f.rt, actor, { thread_id: r.threadId, text: 'I have taken this decision on board.' });
  else acknowledgeInput(f.rt, actor, { message_ids: [method === 'request-id' ? r.id : r.messageId] });
  const saved = f.rt.metadata.read().requests[r.id];
  assert.equal(saved.delivery.state, 'delivered');
  assert.equal(saved.delivery.confirmedByQueen.sessionId, worker);
  assert.equal(saved.delivery.attempts.length, 1);
  assert.deepEqual(acknowledgeInput(f.rt, actor, { message_ids: [r.id] }).acknowledged, [r.id]);
  assert.deepEqual((await buildContext(f.rt, f.host, actor)).attention.missed_input, []);
  f.host.deliver = async (id, text) => { f.sent.push({ id, text }); return { mode: 'live' }; };
  await f.sweep();
  assert.equal(f.sent.length, 0);
});

test('recovery lookup failure cannot reject an already delivered human message', async t => {
  const f = fixture(t), old = await f.input(); await f.failDelivery(old);
  const next = await f.input('Later input');
  const get = f.host.sessions.get;
  f.host.deliver = async () => { f.host.sessions.get = () => { throw new Error('Lookup unavailable'); }; return { mode: 'live' }; };
  assert.equal((await deliver(f.rt, f.host, { cellId: 'cell', messageId: next.id })).state, 'delivered');
  await notifyMissedInput(f.rt, f.host, queen);
  f.host.sessions.get = get;
  f.host.deliver = async (id, text) => { f.sent.push({ id, text }); return { mode: 'live' }; };
  await f.sweep();
  assert.equal(f.sent.length, 1);
});

test('watchdog recovery waits for a live queen and never wakes a dormant session', async t => {
  const f = fixture(t), m = await f.input(); await f.failDelivery(m);
  f.members.get(queen).dormant = true;
  await f.sweep();
  assert.equal(f.sent.length, 0);
  f.members.get(queen).dormant = false;
  f.members.get(queen).status = 'error';
  await f.sweep();
  assert.equal(f.sent.length, 0);
  f.members.get(queen).status = 'idle';
  await f.sweep();
  assert.equal(f.sent.length, 1);
});

test('onResume never delivers or joins its own in-flight resume', { timeout: 1000 }, async t => {
  const f = fixture(t), m = await f.input(); await f.failDelivery(m);
  const manifest = createManifest({ dir: f.rt.paths.root });
  let calls = 0, resume;
  f.host.deliver = async () => { calls++; await resume; return { mode: 'live' }; };
  resume = manifest.session.onResume({ sessionId: queen, host: f.host });
  await resume;
  assert.equal(calls, 0);
  await f.sweep();
  assert.equal(calls, 1);
});

test('successful human delivery returns while its recovery summary is still pending', { timeout: 1000 }, async t => {
  const f = fixture(t), m = await f.input(); await f.failDelivery(m);
  const next = await f.input('New input');
  let release;
  f.host.deliver = async (_id, text) => {
    if (text.includes('Recover human input')) await new Promise(resolve => { release = resolve; });
    return { mode: 'live' };
  };
  const result = await deliver(f.rt, f.host, { cellId: 'cell', messageId: next.id });
  assert.equal(result.state, 'delivered');
  assert.equal(typeof release, 'function');
  release();
  await f.sweep();
});

test('successful request answer returns while its recovery summary is still pending', { timeout: 1000 }, async t => {
  const f = fixture(t), m = await f.input(); await f.failDelivery(m);
  const r = await requests.createRequest(f.rt, f.host, queen, { title: 'Proceed?', body: 'May we proceed?' });
  let release;
  f.host.deliver = async (_id, text) => {
    if (text.includes('Recover human input')) await new Promise(resolve => { release = resolve; });
    return { mode: 'live' };
  };
  const result = await requests.humanAnswer(f.rt, f.host, { request_id: r.id, revision: r.revision, route_revision: r.routeRevision, text: 'Proceed', receipt: 'human-reply' });
  assert.equal(result.delivery.state, 'delivered');
  assert.equal(typeof release, 'function');
  release();
  await f.sweep();
});
