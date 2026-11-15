import test from 'node:test';
import assert from 'node:assert/strict';
import { queenResponseState } from '../server/projection.js';
import { queenNeedsAttention, queenNotResponding } from '../public/model.js';
import { needsRows } from '../public/global-inbox.js';
import { cellWaitingItems } from '../public/waiting-model.js';

const now = Date.parse('2026-01-01T12:00:00Z');
const old = now - 31 * 60000;
function fixture() {
  const cell = { id: 'cell', enabled: true, rootBeadId: 'root', queenSessionId: 'queen', taskId: 'task' };
  const doc = { conversation: { cell: [] }, requests: {}, operations: {} };
  const graph = { sessions: [{ sessionId: 'queen', status: 'idle', lastActivity: old }] };
  return { cell, doc, graph };
}

test('pending human input survives receipt but clears on response or withdrawal', () => {
  const { cell, doc, graph } = fixture();
  const message = { author: 'human', at: old, acknowledgedAt: old, response: { required: true, answers: [] } };
  doc.conversation.cell.push(message);
  cell.queenResponse = queenResponseState(doc, cell);
  assert.equal(queenNotResponding(graph, cell, now - 2 * 60000), false);
  assert.equal(queenNotResponding(graph, cell, now), true);
  for (const response of [{ required: true, answers: [{ messageId: 'answer' }] }, { required: true, withdrawn: { at: now } }]) {
    message.response = response;
    cell.queenResponse = queenResponseState(doc, cell);
    assert.equal(queenNotResponding(graph, cell, now), false);
  }
});

test('private queen requests contribute only timing and stop contributing when settled or forwarded', () => {
  const { cell, doc, graph } = fixture();
  doc.requests.secret = { cellId: 'cell', audience: 'queen', state: 'open', createdAt: old, title: 'Private title', body: 'Private body' };
  cell.queenResponse = queenResponseState(doc, cell);
  assert.deepEqual(cell.queenResponse, { pendingSince: old, lastActivity: 0 });
  assert.equal(queenNotResponding(graph, cell, now), true);
  for (const patch of [{ state: 'answered' }, { state: 'withdrawn' }, { state: 'open', audience: 'human' }]) {
    Object.assign(doc.requests.secret, patch);
    cell.queenResponse = queenResponseState(doc, cell);
    assert.equal(queenNotResponding(graph, cell, now), false);
  }
});

test('queen activity resets the timeout and the per-hive threshold is respected', () => {
  const { cell, doc, graph } = fixture();
  doc.conversation.cell.push({ author: 'human', at: old, response: { required: true } });
  cell.queenResponse = queenResponseState(doc, cell);
  cell.watchdogSettings = { queenResponseMinutes: 40 };
  assert.equal(queenNotResponding(graph, cell, now), false);
  cell.watchdogSettings.queenResponseMinutes = 1;
  for (const source of ['session', 'message', 'operation']) {
    const recent = now - 30000;
    graph.sessions[0].lastActivity = source === 'session' ? recent : old;
    doc.conversation.cell = doc.conversation.cell.filter(m => m.author === 'human');
    doc.operations = {};
    if (source === 'message') doc.conversation.cell.push({ sessionId: 'queen', at: recent });
    if (source === 'operation') doc.operations.op = { actor: 'aw:queen', state: 'applied', updatedAt: new Date(recent).toISOString() };
    cell.queenResponse = queenResponseState(doc, cell);
    assert.equal(queenNotResponding(graph, cell, now), false, source);
    assert.equal(queenNotResponding(graph, cell, now + 60000), true, source);
  }
});

test('Needs you row, session link and waiting marker agree without leaking private input', t => {
  const realNow = Date.now;
  Date.now = () => now;
  t.after(() => { Date.now = realNow; });
  const { cell, doc, graph } = fixture();
  doc.requests.secret = { cellId: 'cell', audience: 'queen', state: 'open', createdAt: old, title: 'Private title' };
  cell.queenResponse = queenResponseState(doc, cell);
  const ctx = { graph, hive: { beads: { root: { id: 'root' } }, edges: [] } };
  const rows = needsRows(ctx, [cell]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, 'Queen not responding');
  assert.equal(rows[0].link, '#session=queen');
  assert.equal(JSON.stringify(rows).includes('Private title'), false);
  assert.equal(cellWaitingItems(ctx, cell)[0].title, 'Queen not responding');
  graph.sessions[0].lastActivity = now;
  assert.deepEqual(needsRows(ctx, [cell]), []);
  assert.deepEqual(cellWaitingItems(ctx, cell), []);
  graph.sessions[0].lastActivity = old;
  for (const patch of [{ enabled: false }, { snapshot: {} }, { retired: {} }]) {
    assert.equal(queenNeedsAttention(graph, { ...cell, ...patch }), false);
  }
  graph.sessions[0].archived = true;
  assert.equal(queenNotResponding(graph, cell), false);
});
