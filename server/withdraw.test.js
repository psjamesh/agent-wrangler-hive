import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MetadataStore } from './metadata-store.js';
import { deliver, publish, recordHumanInput, withdrawMessage, undoWithdraw, inboxSlice, inboxRev, inboxPage, threadIndex, cellContextConversation, awaitingQueen } from './conversation.js';

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-withdraw-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const metadata = new MetadataStore({ file: path.join(root, 'metadata.json') });
  const cell = { id: 'cell_test', enabled: true, queenSessionId: '11111111-1111-4111-8111-111111111111' };
  metadata.mutate((d) => { d.cells[cell.id] = cell; });
  const rt = { host: { tasks: { forSession: () => null } }, pendingParticipants: new Map(), paths: { root }, metadata, changed() {}, snapshots: { graph: { beads: {} } } };
  const actor = { cell, role: 'queen', sessionId: '11111111-1111-4111-8111-111111111111' };
  return { rt, cell, actor, list: () => metadata.read().conversation[cell.id], doc: () => metadata.read() };
}
const waiting = (f) => inboxSlice(f.doc(), f.cell.id, 'queen');

test('withdrawing a waiting message settles it for the human and leaves every waiting count', async (t) => {
  const f = await fixture(t);
  const a = await recordHumanInput(f.rt, { cellId: f.cell.id, text: 'Oops, wrong hive' });
  const b = await recordHumanInput(f.rt, { cellId: f.cell.id, text: 'Real question', threadId: a.threadId });
  assert.equal(waiting(f).count, 2);
  const before = inboxRev(f.doc(), f.cell.id);
  const out = withdrawMessage(f.rt, { cellId: f.cell.id, messageId: a.id });
  assert.equal(out.messageId, a.id);
  assert.equal(out.response.withdrawn.by, 'aw:human');
  assert.ok(out.inboxRev > before);
  assert.equal(awaitingQueen(f.list().find((m) => m.id === a.id)), false);
  const slice = waiting(f);
  assert.equal(slice.count, 1);
  assert.deepEqual(slice.ids, [b.id]);
  const topic = threadIndex(f.list()).get(a.threadId);
  assert.equal(topic.awaiting.queen.count, 1);
  assert.equal((await inboxPage(f.rt, { cellId: f.cell.id, awaiting: 'queen' })).count, 1);
});

test('withdrawing is idempotent and Undo puts the message back', async (t) => {
  const f = await fixture(t);
  const a = await recordHumanInput(f.rt, { cellId: f.cell.id, text: 'Ignore me' });
  withdrawMessage(f.rt, { cellId: f.cell.id, messageId: a.id });
  const again = withdrawMessage(f.rt, { cellId: f.cell.id, messageId: a.id });
  assert.equal(again.response.withdrawn.by, 'aw:human');
  const undone = undoWithdraw(f.rt, { cellId: f.cell.id, messageId: a.id });
  assert.equal(undone.response.withdrawn, undefined);
  assert.equal(waiting(f).count, 1);
  assert.equal(undoWithdraw(f.rt, { cellId: f.cell.id, messageId: a.id }).response.withdrawn, undefined);
  assert.equal(waiting(f).count, 1);
});

test('only the human\'s own unanswered messages can be withdrawn', async (t) => {
  const f = await fixture(t);
  const a = await recordHumanInput(f.rt, { cellId: f.cell.id, text: 'Question' });
  const q = await publish(f.rt, f.actor, { text: 'Reply', reply_to: a.id });
  assert.throws(() => withdrawMessage(f.rt, { cellId: f.cell.id, messageId: a.id }), /already answered/);
  assert.throws(() => withdrawMessage(f.rt, { cellId: f.cell.id, messageId: q.message_id }), /your own/);
  assert.throws(() => withdrawMessage(f.rt, { cellId: f.cell.id, messageId: 'nope' }), /your own/);
  assert.throws(() => undoWithdraw(f.rt, { cellId: f.cell.id, messageId: q.message_id }), /your own/);
});

test('a queen answer after a withdrawal still records, and Undo of a since-answered message leaves it answered', async (t) => {
  const f = await fixture(t);
  const a = await recordHumanInput(f.rt, { cellId: f.cell.id, text: 'Never mind' });
  withdrawMessage(f.rt, { cellId: f.cell.id, messageId: a.id });
  await publish(f.rt, f.actor, { text: 'Noted, ignoring it', answers: [a.id] });
  undoWithdraw(f.rt, { cellId: f.cell.id, messageId: a.id });
  assert.equal(awaitingQueen(f.list().find((m) => m.id === a.id)), false);
  assert.equal(waiting(f).count, 0);
});

test('the queen sees a withdrawn message as withdrawn, not awaiting an answer', async (t) => {
  const f = await fixture(t);
  const a = await recordHumanInput(f.rt, { cellId: f.cell.id, text: 'Mistake' });
  const b = await recordHumanInput(f.rt, { cellId: f.cell.id, text: 'Keep this' });
  withdrawMessage(f.rt, { cellId: f.cell.id, messageId: a.id });
  const ctx = await cellContextConversation(f.rt, f.rt.host, f.actor);
  assert.deepEqual(ctx.awaiting_response.map((m) => m.message_id), [b.id]);
  assert.equal(ctx.awaiting_response_total, 1);
  const shown = ctx.conversation.find((m) => m.message_id === a.id);
  assert.equal(shown.withdrawn_by_human, true);
  assert.equal(shown.awaiting_answer, false);
  assert.equal(ctx.conversation.find((m) => m.message_id === b.id).withdrawn_by_human, undefined);
  assert.deepEqual(ctx.withdrawn_by_human.map((m) => m.message_id), [a.id]);
});

test('a withdrawn message is kept as withdrawn when pruned into the ledger', async (t) => {
  const f = await fixture(t);
  const a = await recordHumanInput(f.rt, { cellId: f.cell.id, text: 'Mistake' });
  withdrawMessage(f.rt, { cellId: f.cell.id, messageId: a.id });
  f.rt.metadata.mutate((d) => {
    for (let i = 0; i < 2100; i++) d.conversation[f.cell.id].push({ id: `old_${i}`, author: 'session', text: 'old', at: 1, threadId: a.threadId, n: i + 3 });
  });
  await recordHumanInput(f.rt, { cellId: f.cell.id, text: 'Trigger prune', threadId: a.threadId });
  assert.equal(f.list().some((m) => m.id === a.id), false);
  const rec = f.doc().inbox[f.cell.id].ledger.find((r) => r.id === a.id);
  assert.equal(rec.kind, 'withdrawn');
  assert.equal(rec.by, 'aw:human');
});

test('a withdrawn message is never delivered to the queen, and delivers again once Undo restores it', async (t) => {
  const f = await fixture(t);
  const sent = [];
  const host = { tasks: { get: () => ({ name: 'Fixture task' }) }, deliver: async (...args) => { sent.push(args); return { mode: 'live' }; } };
  const a = await recordHumanInput(f.rt, { cellId: f.cell.id, text: 'Mistake' });
  withdrawMessage(f.rt, { cellId: f.cell.id, messageId: a.id });
  assert.equal((await deliver(f.rt, host, { cellId: f.cell.id, messageId: a.id })).state, 'withdrawn');
  assert.equal((await deliver(f.rt, host, { cellId: f.cell.id, messageId: a.id, force: true })).state, 'withdrawn');
  assert.equal(sent.length, 0);
  assert.equal(f.list().find((m) => m.id === a.id).delivery.attempts.length, 0);
  undoWithdraw(f.rt, { cellId: f.cell.id, messageId: a.id });
  assert.notEqual((await deliver(f.rt, host, { cellId: f.cell.id, messageId: a.id })).state, 'withdrawn');
  assert.equal(sent.length, 1);
});
