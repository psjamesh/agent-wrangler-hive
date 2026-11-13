import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MetadataStore } from './metadata-store.js';
import { projectForGraph } from './projection.js';
import { publish, recordHumanInput, acknowledgeMessage, undoAcknowledge, inboxSlice, inboxRev, inboxPage, threadIndex, threadSummary } from './conversation.js';

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-inbox-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const metadata = new MetadataStore({ file: path.join(root, 'metadata.json') });
  const cell = { id: 'cell_test', enabled: true, queenSessionId: '11111111-1111-4111-8111-111111111111' };
  metadata.mutate((d) => { d.cells[cell.id] = cell; });
  const rt = { host: { tasks: { forSession: () => null } }, pendingParticipants: new Map(), paths: { root }, metadata, changed() {}, snapshots: { graph: { beads: {} } } };
  const actor = { cell, role: 'queen', sessionId: '11111111-1111-4111-8111-111111111111' };
  return { rt, cell, actor, list: () => metadata.read().conversation[cell.id] };
}

test('Q0 pins H while later answers are pruned, then all answer proof becomes individually bounded ledger records', async (t) => {
  const f = (await fixture(t));
  const h = (await recordHumanInput(f.rt, { cellId: f.cell.id, text: 'Please explain' }));
  const first = (await publish(f.rt, f.actor, { text: 'First answer', reply_to: h.id }));
  f.rt.metadata.mutate((d) => {
    for (let i = 0; i < 1998; i++) d.conversation[f.cell.id].push({ id: `old_${i}`, author: 'session', text: 'old', at: 1, threadId: h.threadId, n: i + 3 });
  });
  const answers = [first.message_id];
  const total = 80;
  for (let i = 1; i <= total; i++) {
    const actor = { ...f.actor, sessionId: `33333333-3333-4333-8333-${String(i).padStart(12, '0')}` };
    f.rt.metadata.mutate(d => { d.cells[f.cell.id].queenSessionId = actor.sessionId; });
    const answer = (await publish(f.rt, actor, { text: `Answer ${i}`, reply_to: h.id }));
    answers.push(answer.message_id);
    f.rt.metadata.mutate((d) => { const m = d.conversation[f.cell.id].find((x) => x.id === answer.message_id); m.ack.state = { kind: 'read', by: 'aw:human', at: 2 }; m.ack.rev += 1; });
  }
  f.rt.metadata.mutate(d => { d.bindings[f.cell.id] = [{ sessionId: f.actor.sessionId, active: true, role: 'worker' }]; });
  for (let i = 0; i < 2000; i++) (await publish(f.rt, { ...f.actor, role: 'worker' }, { text: 'Routine update', thread_id: h.threadId }));
  assert.ok(f.list().some((m) => m.id === h.id));
  assert.ok(f.list().some((m) => m.id === first.message_id));
  assert.equal(f.list().filter((m) => answers.slice(1).includes(m.id)).length, 0);
  const retained = f.list().find((m) => m.id === h.id);
  assert.equal(retained.response.answers.length, total + 1);
  acknowledgeMessage(f.rt, { cellId: f.cell.id, messageId: first.message_id, kind: 'read', rev: 0 });
  (await publish(f.rt, { ...f.actor, role: 'worker' }, { text: 'Allow H to prune', thread_id: h.threadId }));
  assert.equal(f.list().some((m) => m.id === h.id), false);
  const ledger = f.rt.metadata.read().inbox[f.cell.id].ledger;
  const proof = ledger.filter((r) => r.id === h.id && r.kind === 'response');
  assert.equal(proof.length, total + 1);
  assert.deepEqual(proof.map((r) => r.answerMessageId), answers);
  assert.deepEqual(proof.map((r) => r.sessionId), ['11111111-1111-4111-8111-111111111111', ...Array.from({ length: total }, (_, i) => `33333333-3333-4333-8333-${String(i + 1).padStart(12, '0')}`)]);
  for (const rec of proof) {
    assert.deepEqual(Object.keys(rec).filter((key) => key !== 'attachmentCount').sort(), ['answerMessageId', 'answeredAt', 'at', 'id', 'kind', 'sessionId']);
    assert.ok(JSON.stringify(rec).length < 250);
    assert.ok(Number.isInteger(rec.answeredAt));
  }
  const ackProof = ledger.filter((r) => r.kind === 'ack');
  assert.equal(ackProof.length, total);
  assert.ok(ackProof.every((r) => r.role === 'queen' && r.state.by === 'aw:human'));
});

const awaiting = (f, id) => !f.list().find((m) => m.id === id).ack.state;

async function autoRead(f, messages) {
  const { configHandlers } = await import('./handlers.js');
  const handler = configHandlers.find(h => h.type === 'hive-auto-read');
  assert.ok(handler, 'the human UI supports batched exact-message reads');
  let result;
  await handler.handler({ cellId: f.cell.id, messages }, { stores: { hive: f.rt } }, frame => { result = frame; });
  return result;
}

test('auto-read batches only observed messages and leaves earlier unseen messages waiting', async t => {
  const { f, q, other, inbox } = await topicOfThree(t);
  const before = inboxRev(f.rt.metadata.read(), f.cell.id);
  const out = await autoRead(f, [{ messageId: q[1], rev: 0 }, { messageId: q[2], rev: 0 }]);
  assert.equal(out.ok, true);
  assert.deepEqual(inbox(), [q[0], other]);
  assert.equal(inboxRev(f.rt.metadata.read(), f.cell.id), before + 1);
  assert.deepEqual(out.acks.map(x => [x.messageId, x.ack.state.kind, x.ack.rev]), [[q[1], 'read', 1], [q[2], 'read', 1]]);
});

test('auto-read preserves concurrent reactions, replies and Undo and is idempotent', async t => {
  const { f, q } = await topicOfThree(t);
  acknowledgeMessage(f.rt, { cellId: f.cell.id, messageId: q[0], kind: 'reaction', emoji: '👍', rev: 0 });
  await recordHumanInput(f.rt, { cellId: f.cell.id, text: 'Answer', replyTo: q[1], ackRev: 0 });
  acknowledgeMessage(f.rt, { cellId: f.cell.id, messageId: q[2], kind: 'read', rev: 0 });
  undoAcknowledge(f.rt, { cellId: f.cell.id, messageId: q[2], rev: 1 });
  const rev = inboxRev(f.rt.metadata.read(), f.cell.id);
  const out = await autoRead(f, q.map(messageId => ({ messageId, rev: 0 })));
  assert.equal(out.ok, true);
  assert.deepEqual(q.map(id => f.list().find(m => m.id === id).ack.state?.kind || null), ['reaction', 'reply', null]);
  assert.equal(inboxRev(f.rt.metadata.read(), f.cell.id), rev);
  assert.equal((await autoRead(f, [{ messageId: q[2], rev: 2 }])).ok, true);
  const settled = inboxRev(f.rt.metadata.read(), f.cell.id);
  await autoRead(f, [{ messageId: q[2], rev: 2 }]);
  assert.equal(inboxRev(f.rt.metadata.read(), f.cell.id), settled);
});

test('auto-read rejects malformed or oversized batches before changing any acknowledgements', async t => {
  const { f, q } = await topicOfThree(t);
  for (const messages of [[{ messageId: q[0], rev: 0 }, { messageId: q[1], rev: -1 }], Array.from({ length: 101 }, () => ({ messageId: q[0], rev: 0 }))]) {
    assert.equal((await autoRead(f, messages)).ok, false);
    assert.ok(q.every(id => awaiting(f, id)));
  }
});

test('sending in a topic marks its queen messages read up to the newest one shown', async (t) => {
  const f = await fixture(t);
  const h = await recordHumanInput(f.rt, { cellId: f.cell.id, text: 'Start' });
  const q1 = await publish(f.rt, f.actor, { text: 'One', thread_id: h.threadId });
  const q2 = await publish(f.rt, f.actor, { text: 'Two', thread_id: h.threadId });
  const other = await publish(f.rt, f.actor, { text: 'Elsewhere' });
  const out = await recordHumanInput(f.rt, { cellId: f.cell.id, text: 'Thanks', threadId: h.threadId, readThrough: q2.message_id });
  assert.equal(out.markedRead, 2);
  assert.equal(awaiting(f, q1.message_id), false);
  assert.equal(awaiting(f, q2.message_id), false);
  assert.equal(f.list().find((m) => m.id === q1.message_id).ack.state.kind, 'read');
  assert.equal(awaiting(f, other.message_id), true);
});

test('a reply marks the rest of its topic read as well as settling its target', async (t) => {
  const f = await fixture(t);
  const h = await recordHumanInput(f.rt, { cellId: f.cell.id, text: 'Start' });
  const q1 = await publish(f.rt, f.actor, { text: 'One', thread_id: h.threadId });
  const q2 = await publish(f.rt, f.actor, { text: 'Two', thread_id: h.threadId });
  const out = await recordHumanInput(f.rt, { cellId: f.cell.id, text: 'Re two', replyTo: q2.message_id, ackRev: 0, readThrough: q2.message_id });
  assert.equal(out.ackSettled, true);
  assert.equal(f.list().find((m) => m.id === q2.message_id).ack.state.kind, 'reply');
  assert.equal(f.list().find((m) => m.id === q1.message_id).ack.state.kind, 'read');
});

test('a reply whose target changed since it was seen leaves that target alone', async (t) => {
  const f = await fixture(t);
  const h = await recordHumanInput(f.rt, { cellId: f.cell.id, text: 'Start' });
  const q1 = await publish(f.rt, f.actor, { text: 'One', thread_id: h.threadId });
  acknowledgeMessage(f.rt, { cellId: f.cell.id, messageId: q1.message_id, kind: 'read', rev: 0 });
  undoAcknowledge(f.rt, { cellId: f.cell.id, messageId: q1.message_id, rev: 1 });
  const out = await recordHumanInput(f.rt, { cellId: f.cell.id, text: 'Re one', replyTo: q1.message_id, ackRev: 0, readThrough: q1.message_id });
  assert.equal(out.ackSettled, false);
  assert.equal(out.markedRead, 0);
  assert.equal(awaiting(f, q1.message_id), true);
});

test('a queen reply that arrives just after the send stays unread', async (t) => {
  const f = await fixture(t);
  const h = await recordHumanInput(f.rt, { cellId: f.cell.id, text: 'Start' });
  const q1 = await publish(f.rt, f.actor, { text: 'Seen', thread_id: h.threadId });
  const unseen = await publish(f.rt, f.actor, { text: 'Landed before the send, never shown', thread_id: h.threadId });
  const [sent, late] = await Promise.all([
    recordHumanInput(f.rt, { cellId: f.cell.id, text: 'Reply', threadId: h.threadId, readThrough: q1.message_id }),
    publish(f.rt, f.actor, { text: 'Just after', thread_id: h.threadId }),
  ]);
  assert.equal(sent.markedRead, 1);
  assert.equal(awaiting(f, q1.message_id), false);
  assert.equal(awaiting(f, unseen.message_id), true);
  assert.equal(awaiting(f, late.message_id), true);
  const ids = f.list().map((m) => m.id);
  assert.ok(ids.indexOf(late.message_id) > ids.indexOf(sent.id));
});

test('a new topic, or a send with nothing shown, marks nothing read', async (t) => {
  const f = await fixture(t);
  const h = await recordHumanInput(f.rt, { cellId: f.cell.id, text: 'Start' });
  const q1 = await publish(f.rt, f.actor, { text: 'One', thread_id: h.threadId });
  assert.equal((await recordHumanInput(f.rt, { cellId: f.cell.id, text: 'Fresh', newThread: {}, readThrough: q1.message_id })).markedRead, 0);
  assert.equal((await recordHumanInput(f.rt, { cellId: f.cell.id, text: 'Old page', threadId: h.threadId })).markedRead, 0);
  assert.equal(awaiting(f, q1.message_id), true);
});

async function topicOfThree(t) {
  const f = await fixture(t);
  const h = await recordHumanInput(f.rt, { cellId: f.cell.id, text: 'Start' });
  const q = [];
  for (const text of ['One', 'Two', 'Three']) q.push((await publish(f.rt, f.actor, { text, thread_id: h.threadId })).message_id);
  const other = (await publish(f.rt, f.actor, { text: 'Elsewhere' })).message_id;
  const inbox = () => inboxSlice(f.rt.metadata.read(), f.cell.id, 'human').ids;
  return { f, h, q, other, inbox };
}

test('reacting to the last message of a topic reads all of it and takes the topic out of the inbox', async (t) => {
  const { f, q, other, inbox } = await topicOfThree(t);
  const out = acknowledgeMessage(f.rt, { cellId: f.cell.id, messageId: q[2], kind: 'reaction', emoji: '👍', rev: 0 });
  assert.deepEqual(out.marked.map((x) => x.messageId), [q[0], q[1]]);
  assert.ok(out.marked.every((x) => x.ack.state.kind === 'read' && x.ack.rev === 1));
  assert.equal(f.list().find((m) => m.id === q[2]).ack.state.kind, 'reaction');
  assert.deepEqual(inbox(), [other]);
});

test('marking a middle message read reads the topic up to it and leaves later messages waiting', async (t) => {
  const { f, q, other, inbox } = await topicOfThree(t);
  const out = acknowledgeMessage(f.rt, { cellId: f.cell.id, messageId: q[1], kind: 'read', rev: 0 });
  assert.deepEqual(out.marked.map((x) => x.messageId), [q[0]]);
  assert.equal(awaiting(f, q[2]), true);
  assert.deepEqual(inbox(), [q[2], other]);
  acknowledgeMessage(f.rt, { cellId: f.cell.id, messageId: q[2], kind: 'reaction', emoji: '👍', rev: 0 });
  assert.deepEqual(inbox(), [other]);
});

test('a message arriving after the read mark stays unread, and undo puts back only its own message', async (t) => {
  const { f, h, q, other, inbox } = await topicOfThree(t);
  acknowledgeMessage(f.rt, { cellId: f.cell.id, messageId: q[2], kind: 'read', rev: 0 });
  const late = (await publish(f.rt, f.actor, { text: 'Later', thread_id: h.threadId })).message_id;
  assert.deepEqual(inbox(), [other, late]);
  undoAcknowledge(f.rt, { cellId: f.cell.id, messageId: q[2], rev: 1 });
  assert.equal(awaiting(f, q[0]), false);
  assert.equal(awaiting(f, q[1]), false);
  assert.deepEqual(inbox(), [q[2], other, late]);
});

test('a topic names its earliest message awaiting acknowledgement, which settling moves later and undo moves back', async (t) => {
  const { f, h, q } = await topicOfThree(t);
  const from = () => {
    const doc = f.rt.metadata.read();
    const thread = doc.threads[f.cell.id][h.threadId];
    return threadSummary(thread, threadIndex(f.list()).get(h.threadId)).waitingFrom;
  };
  assert.equal(from().id, q[0]);
  assert.equal(from().n, f.list().find((m) => m.id === q[0]).n);
  acknowledgeMessage(f.rt, { cellId: f.cell.id, messageId: q[1], kind: 'read', rev: 0 });
  assert.equal(from().id, q[2]);
  undoAcknowledge(f.rt, { cellId: f.cell.id, messageId: q[0], rev: 1 });
  assert.deepEqual(from(), { id: q[0], n: f.list().find((m) => m.id === q[0]).n, rev: 2 });
  acknowledgeMessage(f.rt, { cellId: f.cell.id, messageId: q[2], kind: 'read', rev: 0 });
  assert.equal(from(), null);
});

test('acknowledging an earlier message leaves later ones and an already settled one as they are', async (t) => {
  const { f, q } = await topicOfThree(t);
  acknowledgeMessage(f.rt, { cellId: f.cell.id, messageId: q[0], kind: 'reaction', emoji: '👍', rev: 0 });
  const out = acknowledgeMessage(f.rt, { cellId: f.cell.id, messageId: q[1], kind: 'read', rev: 0 });
  assert.deepEqual(out.marked, []);
  assert.equal(f.list().find((m) => m.id === q[0]).ack.state.kind, 'reaction');
  assert.equal(awaiting(f, q[2]), true);
});

test('a readThrough from another topic, or no longer kept, marks nothing; one in the topic marks up to it', async (t) => {
  const f = await fixture(t);
  const a = await recordHumanInput(f.rt, { cellId: f.cell.id, text: 'Topic A' });
  const a1 = await publish(f.rt, f.actor, { text: 'A1', thread_id: a.threadId });
  const a2 = await publish(f.rt, f.actor, { text: 'A2', thread_id: a.threadId });
  const b1 = await publish(f.rt, f.actor, { text: 'B1' });
  const send = (readThrough) => recordHumanInput(f.rt, { cellId: f.cell.id, text: 'Hi', threadId: a.threadId, readThrough });
  assert.equal((await send(b1.message_id)).markedRead, 0);
  assert.equal((await send('msg_gone')).markedRead, 0);
  assert.equal(awaiting(f, a1.message_id), true);
  assert.equal((await send(a1.message_id)).markedRead, 1);
  assert.equal(awaiting(f, a2.message_id), true);
  assert.equal(awaiting(f, b1.message_id), true);
});

test('a late repeat of a reaction leaves a newer Undo on an earlier message alone', async (t) => {
  const { f, q, inbox, other } = await topicOfThree(t);
  acknowledgeMessage(f.rt, { cellId: f.cell.id, messageId: q[2], kind: 'reaction', emoji: '👍', rev: 0 });
  undoAcknowledge(f.rt, { cellId: f.cell.id, messageId: q[0], rev: 1 });
  const again = acknowledgeMessage(f.rt, { cellId: f.cell.id, messageId: q[2], kind: 'reaction', emoji: '👍', rev: 0 });
  assert.deepEqual(again.marked, []);
  assert.equal(awaiting(f, q[0]), true);
  assert.deepEqual(inbox(), [q[0], other]);
  const current = acknowledgeMessage(f.rt, { cellId: f.cell.id, messageId: q[2], kind: 'reaction', emoji: '👍', rev: 1 });
  assert.deepEqual(current.marked.map((x) => x.messageId), [q[0]]);
});

test('R11: settling or undoing a message reports the Inbox revision it was saved at', async (t) => {
  const f = await fixture(t);
  const h = await recordHumanInput(f.rt, { cellId: f.cell.id, text: 'Start' });
  const q1 = await publish(f.rt, f.actor, { text: 'One', thread_id: h.threadId });
  const rev = () => inboxPage(f.rt, { cellId: f.cell.id, awaiting: 'human' }).rev;
  const read = acknowledgeMessage(f.rt, { cellId: f.cell.id, messageId: q1.message_id, kind: 'read', rev: 0 });
  assert.equal(read.inboxRev, rev());
  const undone = undoAcknowledge(f.rt, { cellId: f.cell.id, messageId: q1.message_id, rev: 1 });
  assert.equal(undone.inboxRev, rev());
  assert.notEqual(undone.inboxRev, read.inboxRev);
});

test('V2: a topic reports how many of its messages wait and the newest of them, whose body is sent even outside its newest run', async (t) => {
  const f = await fixture(t);
  const h = await recordHumanInput(f.rt, { cellId: f.cell.id, text: 'Start' });
  f.rt.metadata.mutate((d) => { d.conversation[f.cell.id][0].acknowledgedAt = 1; });
  const ids = [];
  for (let i = 0; i < 100; i += 1) ids.push((await publish(f.rt, f.actor, { text: `q${i + 1}`, thread_id: h.threadId })).message_id);
  for (let i = 0; i < 45; i += 1) await publish(f.rt, f.actor, { text: `later ${i}`, thread_id: h.threadId });
  f.rt.metadata.mutate((d) => { for (const m of d.conversation[f.cell.id].slice(101)) m.ack.state = { kind: 'read' }; });
  const doc = f.rt.metadata.read();
  const summary = threadSummary(doc.threads[f.cell.id][h.threadId], threadIndex(f.list()).get(h.threadId));
  assert.deepEqual(summary.awaiting.human, { count: 100, newest: { id: ids[99], n: summary.awaiting.human.newest.n } });
  assert.equal(summary.awaiting.queen.count, 1);
  assert.equal(summary.awaiting.queen.newest.id, h.id);
  const cell = projectForGraph({ runtime: { ...f.rt, beads: { status: {} } }, snapshot: { graph: { beads: {}, edges: [] } } }).cells[f.cell.id];
  assert.equal(cell.inbox.human.ids.includes(ids[99]), false);
  assert.ok(cell.messages.some((m) => m.id === ids[99]));
  assert.equal(cell.threads.find((x) => x.id === h.threadId).awaiting.human.count, 100);
  const page = inboxPage(f.rt, { cellId: f.cell.id, awaiting: 'human', after: { id: ids[9], at: 0 }, limit: 5 });
  assert.ok(page.messages.some((m) => m.id === ids[99]));
});

test('deep links resolve retained history and fall back without changing read or acknowledgement state', async (t) => {
  const { resolveDeepLink } = await import('./conversation.js');
  const f = await fixture(t);
  const first = await publish(f.rt, f.actor, { text: 'First' });
  for (let i = 0; i < 55; i++) await publish(f.rt, f.actor, { text: `Later ${i}`, thread_id: first.thread_id });
  const before = JSON.stringify(f.rt.metadata.read());
  const route = resolveDeepLink(f.rt, { cellId: f.cell.id, threadId: first.thread_id, messageId: first.message_id });
  assert.equal(route.thread.id, first.thread_id);
  assert.ok(route.messages.some(m => m.id === first.message_id));
  assert.ok(route.messages.length <= 40);
  assert.equal(route.anchorN, route.messages.at(-1).n + 1);
  const topic = resolveDeepLink(f.rt, { cellId: f.cell.id, threadId: first.thread_id });
  assert.equal(topic.thread.id, first.thread_id);
  for (const target of [{ threadId: 'missing' }, { threadId: first.thread_id, messageId: 'missing' }, { messageId: first.message_id }]) {
    const fallback = resolveDeepLink(f.rt, { cellId: f.cell.id, ...target });
    assert.equal(fallback.cellId, f.cell.id);
    assert.equal(fallback.thread, undefined);
    assert.ok(fallback.notice);
  }
  assert.equal(resolveDeepLink(f.rt, { cellId: 'missing' }).cellId, null);
  assert.equal(JSON.stringify(f.rt.metadata.read()), before);
  f.rt.metadata.error = 'Unavailable';
  assert.equal(resolveDeepLink(f.rt, { cellId: f.cell.id }).cellId, null);
});

test('hive_publish returns the relative hash link for its posted message', async (t) => {
  const { publishTool } = await import('./tools.js');
  const f = await fixture(t);
  const response = await publishTool.handler({ host: { ...f.rt.host, stores: { hive: f.rt } }, caller: f.actor.sessionId }, { text: 'Link me' });
  assert.equal(response.isError, undefined);
  const result = response.structuredContent;
  assert.deepEqual(JSON.parse(response.content[0].text), result);
  assert.equal(result.link, `#view=ext:hive:overview&cell=${f.cell.id}&topic=${result.thread_id}&message=${result.message_id}`);
  assert.equal(publishTool.name, 'hive_publish');
  assert.ok(result.next_step.includes('Needs You request'));
  assert.ok(result.next_step.includes(`[Open Hive message](${result.link})`));
});

test('context provides links for topics and other authors’ messages, including waiting input', async (t) => {
  const { cellContextConversation } = await import('./conversation.js');
  const f = await fixture(t);
  const human = await recordHumanInput(f.rt, { cellId: f.cell.id, text: 'A question' });
  const reply = await publish(f.rt, f.actor, { text: 'Another topic' });
  const context = await cellContextConversation(f.rt, f.rt.host, f.actor);
  const messageLink = m => `#view=ext:hive:overview&cell=${f.cell.id}&topic=${m.thread_id}&message=${m.message_id}`;
  assert.equal(context.conversation.length, 2);
  for (const m of context.conversation) assert.equal(m.link, messageLink(m));
  assert.ok(context.conversation.some(m => m.message_id === human.id));
  assert.ok(context.conversation.some(m => m.message_id === reply.message_id));
  for (const topic of context.threads) assert.equal(topic.link, `#view=ext:hive:overview&cell=${f.cell.id}&topic=${topic.thread_id}`);
  for (const key of ['unacknowledged_input', 'awaiting_response']) {
    assert.equal(context[key].length, 1);
    assert.equal(context[key][0].link, messageLink(context[key][0]));
  }
});

test('a pruned restore anchor keeps its valid topic while a fresh missing-message link stays strict', async t => {
  const { resolveDeepLink } = await import('./conversation.js');
  const f = await fixture(t);
  const posted = await publish(f.rt, f.actor, { text: 'Still retained' });
  const args = { cellId: f.cell.id, threadId: posted.thread_id, messageId: 'msg_pruned' };
  const restored = resolveDeepLink(f.rt, { ...args, restore: true });
  assert.equal(restored.thread?.id, posted.thread_id);
  assert.equal(restored.messages.at(-1).id, posted.message_id);
  assert.equal(restored.messageId, null);
  const { configHandlers } = await import('./handlers.js');
  let response;
  await configHandlers.find(h => h.type === 'hive-deep-link').handler({ ...args, restore: true }, { stores: { hive: f.rt } }, frame => { response = frame; });
  assert.equal(response.ok, true);
  assert.equal(response.thread.id, posted.thread_id);
  const strict = resolveDeepLink(f.rt, args);
  assert.equal(strict.thread, undefined);
  assert.equal(strict.cellId, f.cell.id);
});

test('restoration loads a saved anchor outside both the original link page and the recent window', async t => {
  const { resolveDeepLink } = await import('./conversation.js');
  const f = await fixture(t);
  const posted = await publish(f.rt, f.actor, { text: 'Original topic' });
  f.rt.metadata.mutate(d => {
    d.conversation[f.cell.id] = Array.from({ length: 150 }, (_, i) => ({ id: `msg_${i}`, threadId: posted.thread_id, text: `Message ${i}`, n: i + 1, at: i + 1, author: 'session' }));
    d.threads[f.cell.id][posted.thread_id].count = 150;
  });
  const restored = resolveDeepLink(f.rt, { cellId: f.cell.id, threadId: posted.thread_id, messageId: 'msg_60', restore: true });
  assert.ok(restored.messages.some(m => m.id === 'msg_60'));
  assert.ok(!restored.messages.some(m => m.id === 'msg_0'));
  assert.ok(!restored.messages.some(m => m.id === 'msg_149'));
});

test('an explicit reaction can supersede just the automatic read that raced its observed revision', async t => {
  const { f, q } = await topicOfThree(t);
  await autoRead(f, [{ messageId: q[0], rev: 0 }]);
  const reaction = acknowledgeMessage(f.rt, { cellId: f.cell.id, messageId: q[0], kind: 'reaction', emoji: '👍', rev: 0 });
  assert.equal(reaction.ack.state.kind, 'reaction');
  assert.equal(reaction.ack.rev, 2);
  assert.throws(() => acknowledgeMessage(f.rt, { cellId: f.cell.id, messageId: q[0], kind: 'reaction', emoji: '✅', rev: 0 }), { code: 'stale' });
  await autoRead(f, [{ messageId: q[1], rev: 0 }]);
  undoAcknowledge(f.rt, { cellId: f.cell.id, messageId: q[1], rev: 1 });
  assert.throws(() => acknowledgeMessage(f.rt, { cellId: f.cell.id, messageId: q[1], kind: 'reaction', emoji: '👍', rev: 0 }), { code: 'stale' });
  acknowledgeMessage(f.rt, { cellId: f.cell.id, messageId: q[2], kind: 'read', rev: 0 });
  assert.throws(() => acknowledgeMessage(f.rt, { cellId: f.cell.id, messageId: q[2], kind: 'reaction', emoji: '👍', rev: 0 }), { code: 'stale' });
});

test('a reaction without an observed revision cannot supersede an automatic read', async t => {
  const { f, q } = await topicOfThree(t);
  await autoRead(f, [{ messageId: q[0], rev: 0 }]);
  for (const rev of [null, undefined, '0']) {
    assert.throws(() => acknowledgeMessage(f.rt, { cellId: f.cell.id, messageId: q[0], kind: 'reaction', emoji: '👍', rev }), { code: 'stale' });
  }
});

test('manual read-through supersedes an in-flight automatic read only once', async t => {
  const { f, q } = await topicOfThree(t);
  await autoRead(f, [{ messageId: q[2], rev: 0 }]);
  assert.ok(awaiting(f, q[0]) && awaiting(f, q[1]));
  const read = acknowledgeMessage(f.rt, { cellId: f.cell.id, messageId: q[2], kind: 'read', rev: 0 });
  assert.deepEqual(read.marked.map(m => m.messageId), [q[0], q[1]]);
  assert.equal(read.ack.rev, 2);
  assert.equal(read.ack.state.automatic, undefined);
  undoAcknowledge(f.rt, { cellId: f.cell.id, messageId: q[0], rev: 1 });
  const repeat = acknowledgeMessage(f.rt, { cellId: f.cell.id, messageId: q[2], kind: 'read', rev: 0 });
  assert.deepEqual(repeat.marked, []);
  assert.equal(awaiting(f, q[0]), true, 'a stale read-through cannot override a newer Undo');
  undoAcknowledge(f.rt, { cellId: f.cell.id, messageId: q[2], rev: 2 });
  assert.throws(() => acknowledgeMessage(f.rt, { cellId: f.cell.id, messageId: q[2], kind: 'read', rev: 0 }), { code: 'stale' });
});

test('a stale manual read cannot supersede a reaction after an automatic read', async t => {
  const { f, q } = await topicOfThree(t);
  await autoRead(f, [{ messageId: q[2], rev: 0 }]);
  acknowledgeMessage(f.rt, { cellId: f.cell.id, messageId: q[2], kind: 'reaction', emoji: '👍', rev: 1 });
  undoAcknowledge(f.rt, { cellId: f.cell.id, messageId: q[0], rev: 1 });
  assert.throws(() => acknowledgeMessage(f.rt, { cellId: f.cell.id, messageId: q[2], kind: 'read', rev: 0 }), { code: 'stale' });
  assert.equal(awaiting(f, q[0]), true);
});

for (const reaction of ['approve', 'decline']) test(`named ${reaction} persists and appears in agent context`, async t => {
  const { cellContextConversation } = await import('./conversation.js');
  const f = await fixture(t);
  const q = await publish(f.rt, f.actor, { text: 'Ready for review' });
  const args = { cellId: f.cell.id, messageId: q.message_id, kind: 'reaction', reaction, rev: 0 };
  const { recordHumanReaction } = await import('./conversation.js');
  const out = await recordHumanReaction(f.rt, args);
  assert.equal(out.ack.state.reaction, reaction);
  assert.equal((await recordHumanReaction(f.rt, args)).ack.rev, out.ack.rev);
  const file = path.join(f.rt.paths.root, 'metadata.json');
  const reloaded = new MetadataStore({ file });
  assert.equal(reloaded.read().conversation[f.cell.id][0].ack.state.reaction, reaction);
  const context = await cellContextConversation(f.rt, f.rt.host, f.actor);
  assert.equal(context.conversation[0].human_acknowledged, reaction);
  undoAcknowledge(f.rt, { cellId: f.cell.id, messageId: q.message_id, rev: out.ack.rev });
  assert.equal((await cellContextConversation(f.rt, f.rt.host, f.actor)).conversation[0].human_acknowledged, false);
  acknowledgeMessage(f.rt, { ...args, kind: 'read', reaction: undefined, rev: 2 });
  assert.equal((await cellContextConversation(f.rt, f.rt.host, f.actor)).conversation[0].human_acknowledged, 'seen');
});

test('unknown named reactions cannot fall back to a legacy emoji', async t => {
  const f = await fixture(t);
  const q = await publish(f.rt, f.actor, { text: 'Ready' });
  const { recordHumanReaction } = await import('./conversation.js');
  await assert.rejects(recordHumanReaction(f.rt, { cellId: f.cell.id, messageId: q.message_id, kind: 'reaction', reaction: 'install', emoji: '✅', rev: 0 }));
  assert.equal(f.list()[0].ack.state, null);
});

test('a named reaction atomically records a normal human reply once and switching creates a new reply', async t => {
  const { recordHumanReaction, awaitingQueen } = await import('./conversation.js');
  const { f, q, other } = await topicOfThree(t);
  const args = { cellId: f.cell.id, messageId: q[1], reaction: 'approve', rev: 0 };
  const [first, repeat] = await Promise.all([recordHumanReaction(f.rt, args), recordHumanReaction(f.rt, args)]);
  assert.equal(first.created, true);
  assert.equal(repeat.created, false);
  assert.equal(first.reactionMessageId, repeat.reactionMessageId);
  let replies = f.list().filter(m => m.author === 'human' && m.reaction);
  assert.equal(replies.length, 1);
  assert.equal(replies[0].reaction, 'approve');
  assert.equal(replies[0].replyTo, q[1]);
  assert.equal(replies[0].threadId, f.list().find(m => m.id === q[1]).threadId);
  assert.equal(replies[0].text, 'Yes');
  assert.equal(awaitingQueen(replies[0]), true);
  assert.equal(replies[0].delivery.state, 'pending');
  assert.deepEqual(first.marked.map(m => m.messageId), [q[0]]);
  assert.equal(awaiting(f, q[2]), true);
  assert.equal(awaiting(f, other), true);
  const declined = await recordHumanReaction(f.rt, { ...args, reaction: 'decline', rev: first.ack.rev });
  assert.equal(declined.ack.state.reaction, 'decline');
  assert.notEqual(declined.reactionMessageId, first.reactionMessageId);
  undoAcknowledge(f.rt, { ...args, rev: declined.ack.rev });
  replies = f.list().filter(m => m.author === 'human' && m.reaction);
  assert.deepEqual(replies.map(m => m.text), ['Yes', 'No']);
  assert.ok(replies.every(awaitingQueen));
  assert.equal(awaiting(f, q[1]), true);
});

test('reaction save failure leaves neither state nor human reply and a stale choice cannot add a reply', async t => {
  const { recordHumanReaction } = await import('./conversation.js');
  const f = await fixture(t);
  const q = await publish(f.rt, f.actor, { text: 'Review' });
  const args = { cellId: f.cell.id, messageId: q.message_id, reaction: 'approve', rev: 0 };
  const mutate = f.rt.metadata.mutate.bind(f.rt.metadata);
  f.rt.metadata.mutate = fn => { mutate(d => { fn(d); throw new Error('save failed'); }); };
  await assert.rejects(recordHumanReaction(f.rt, args), /save failed/);
  f.rt.metadata.mutate = mutate;
  assert.equal(f.list().length, 1);
  assert.equal(f.list()[0].ack.state, null);
  acknowledgeMessage(f.rt, { ...args, kind: 'read', reaction: undefined });
  await assert.rejects(recordHumanReaction(f.rt, args), { code: 'stale' });
  assert.equal(f.list().length, 1);
});

test('named reactions supersede only the immediately preceding automatic read and reject human and worker messages', async t => {
  const { recordHumanReaction } = await import('./conversation.js');
  const { f, q } = await topicOfThree(t);
  await autoRead(f, [{ messageId: q[0], rev: 0 }]);
  const reaction = await recordHumanReaction(f.rt, { cellId: f.cell.id, messageId: q[0], reaction: 'decline', rev: 0 });
  assert.equal(reaction.ack.rev, 2);
  const human = f.list().find(m => m.id === reaction.reactionMessageId);
  await assert.rejects(recordHumanReaction(f.rt, { cellId: f.cell.id, messageId: human.id, reaction: 'approve', rev: 0 }));
  f.rt.metadata.mutate(d => { d.conversation[f.cell.id].find(m => m.id === q[1]).role = 'worker'; });
  await assert.rejects(recordHumanReaction(f.rt, { cellId: f.cell.id, messageId: q[1], reaction: 'approve', rev: 0 }));
  assert.equal(f.list().filter(m => m.reaction).length, 1);
});

async function humanAction(f, type, msg, host = {}) {
  const { configHandlers } = await import('./handlers.js');
  let reply;
  await configHandlers.find(h => h.type === type).handler({ cellId: f.cell.id, ...msg }, { ...f.rt.host, ...host, stores: { hive: f.rt } }, frame => { reply = frame; });
  return reply;
}

test('reaction handler wakes the queen through normal delivery once; silent reads and undo never deliver', async t => {
  const f = await fixture(t);
  const q = await publish(f.rt, f.actor, { text: 'Ready to proceed' });
  const deliveries = [];
  const host = { tasks: { get: () => ({ name: 'Fixture task' }) }, deliver: async (...args) => { deliveries.push(args); return { mode: 'live' }; } };
  const input = { messageId: q.message_id, kind: 'reaction', reaction: 'approve', rev: 0 };
  const approved = await humanAction(f, 'hive-ack', input, host);
  assert.equal(approved.ok, true);
  assert.equal(approved.delivery.state, 'delivered');
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0][0], f.cell.queenSessionId);
  assert.ok(deliveries[0][1].includes(`reply_to: ${approved.reactionMessageId}`));
  assert.ok(deliveries[0][1].includes('Re your message: "Ready to proceed"'));
  assert.ok(deliveries[0][1].endsWith('\n\nYes'));
  const repeat = await humanAction(f, 'hive-ack', input, host);
  assert.equal(repeat.created, false);
  assert.equal(deliveries.length, 1);
  const undone = await humanAction(f, 'hive-ack-undo', { messageId: q.message_id, rev: approved.ack.rev }, host);
  const seen = await humanAction(f, 'hive-ack', { messageId: q.message_id, kind: 'read', rev: undone.ack.rev }, host);
  assert.equal(seen.ok, true);
  assert.equal(deliveries.length, 1);
  assert.equal(f.list().find(m => m.id === approved.reactionMessageId).delivery.state, 'delivered');
  assert.equal(f.list().find(m => m.id === approved.reactionMessageId).response.required, true);
  const answer = await publish(f.rt, f.actor, { text: 'Taken on board', reply_to: approved.reactionMessageId });
  assert.equal(f.list().find(m => m.id === approved.reactionMessageId).response.answers[0].messageId, answer.message_id);
});

test('failed and uncertain reaction delivery remain durable and are not retried by repeat reactions', async t => {
  for (const outcome of [{ mode: 'error', error: 'offline' }, { mode: 'error', outcome: 'unknown', error: 'unconfirmed' }]) {
    const f = await fixture(t);
    const q = await publish(f.rt, f.actor, { text: 'Ready' });
    let calls = 0;
    const host = { tasks: { get: () => null }, deliver: async () => { calls++; return outcome; } };
    const input = { messageId: q.message_id, kind: 'reaction', reaction: 'decline', rev: 0 };
    const first = await humanAction(f, 'hive-ack', input, host);
    const expected = outcome.outcome ? 'uncertain' : 'failed';
    assert.equal(first.ok, true);
    assert.equal(first.delivery.state, expected);
    const repeat = await humanAction(f, 'hive-ack', input, host);
    assert.equal(repeat.created, false);
    assert.equal(calls, 1);
    const saved = f.list().find(m => m.id === first.reactionMessageId);
    assert.equal(saved.delivery.state, expected);
    assert.equal(saved.response.required, true);
    assert.equal(f.list()[0].ack.state.reaction, 'decline');
  }
});
