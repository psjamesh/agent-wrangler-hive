import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MetadataStore } from '../server/metadata-store.js';
import { deliver, recordHumanInput, cellContextConversation } from '../server/conversation.js';

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-anchor-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const metadata = new MetadataStore({ file: path.join(root, 'metadata.json') });
  const cell = { id: 'cell_test', enabled: true, queenSessionId: '11111111-1111-4111-8111-111111111111' };
  metadata.mutate((d) => { d.cells[cell.id] = cell; });
  const rt = { host: { tasks: { forSession: () => null } }, pendingParticipants: new Map(), paths: { root }, metadata, changed() {}, snapshots: { graph: { beads: {} } } };
  const actor = { cell, role: 'queen', sessionId: '11111111-1111-4111-8111-111111111111' };
  return { rt, cell, actor };
}

async function anchored(t) {
  const f = await fixture(t);
  f.rt.metadata.mutate((d) => { d.cells[f.cell.id].rootBeadId = 'hive-root'; });
  f.rt.snapshots.graph.beads = { 'hive-root': { id: 'hive-root', title: 'Goal' }, 'hive-one': { id: 'hive-one', parentId: 'hive-root', title: 'One' } };
  return f;
}

test('a new topic about a bead stores it on the message and thread, and the queen sees it in context and the notification', async (t) => {
  const f = await anchored(t);
  const sentText = [];
  const host = { tasks: { get: () => ({ name: 'Task' }) }, deliver: async (_to, text) => { sentText.push(text); return { mode: 'live' }; } };
  const a = await recordHumanInput(f.rt, { cellId: f.cell.id, text: 'About this', beadId: 'hive-one', newThread: { beadId: 'hive-one' } });
  assert.equal(a.beadId, 'hive-one');
  assert.equal(f.rt.metadata.read().threads[f.cell.id][a.threadId].beadId, 'hive-one');
  await deliver(f.rt, host, { cellId: f.cell.id, messageId: a.id });
  assert.match(sentText[0], /^bead_id: hive-one$/m);
  const ctx = await cellContextConversation(f.rt, host, f.actor);
  assert.equal(ctx.conversation.find((m) => m.message_id === a.id).bead_id, 'hive-one');
});

test('a reply inside a topic about a bead tells the queen the bead even when the message names none', async (t) => {
  const f = await anchored(t);
  const sentText = [];
  const host = { tasks: { get: () => ({ name: 'Task' }) }, deliver: async (_to, text) => { sentText.push(text); return { mode: 'live' }; } };
  const a = await recordHumanInput(f.rt, { cellId: f.cell.id, text: 'Start', newThread: { beadId: 'hive-one' } });
  const b = await recordHumanInput(f.rt, { cellId: f.cell.id, text: 'Follow up', threadId: a.threadId });
  await deliver(f.rt, host, { cellId: f.cell.id, messageId: b.id });
  assert.match(sentText[0], /^bead_id: hive-one$/m);
});

test('a hive-wide message has no bead line', async (t) => {
  const f = await anchored(t);
  const sentText = [];
  const host = { tasks: { get: () => ({ name: 'Task' }) }, deliver: async (_to, text) => { sentText.push(text); return { mode: 'live' }; } };
  const a = await recordHumanInput(f.rt, { cellId: f.cell.id, text: 'General' });
  await deliver(f.rt, host, { cellId: f.cell.id, messageId: a.id });
  assert.doesNotMatch(sentText[0], /bead_id:/);
});
