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
  assert.deepEqual(cell.queenResponse, { pendingSince: old });
  assert.equal(queenNotResponding(graph, cell, now), true);
  for (const patch of [{ state: 'answered' }, { state: 'withdrawn' }, { state: 'open', audience: 'human' }]) {
    Object.assign(doc.requests.secret, patch);
    cell.queenResponse = queenResponseState(doc, cell);
    assert.equal(queenNotResponding(graph, cell, now), false);
  }
});

test('only idle queens time out, measured from oldest unanswered input despite wake activity', () => {
  const { cell, doc, graph } = fixture();
  doc.conversation.cell.push({ author: 'human', at: old, response: { required: true } });
  doc.requests.newer = { cellId: 'cell', audience: 'queen', state: 'open', createdAt: now - 60000 };
  doc.workerActivity = { queen: now };
  doc.operations.wake = { actor: 'aw:queen', state: 'applied', updatedAt: new Date(now).toISOString() };
  graph.sessions[0].lastActivity = now;
  graph.sessions[0].relaunchedAt = now;
  cell.queenResponse = queenResponseState(doc, cell);
  cell.watchdogSettings = { queenResponseMinutes: 40 };
  assert.equal(queenNotResponding(graph, cell, now), false);
  cell.watchdogSettings.queenResponseMinutes = 30;
  assert.equal(queenNotResponding(graph, cell, now), true);
  for (const status of ['working', 'needs-input', 'needs-you', 'exited', undefined]) {
    graph.sessions[0].status = status;
    assert.equal(queenNotResponding(graph, cell, now), false, status);
  }
});

test('terminal attention wording takes priority over overdue unanswered input', t => {
  t.mock.method(Date, 'now', () => now);
  const { cell, doc, graph } = fixture();
  doc.conversation.cell.push({ author: 'human', at: old, response: { required: true } });
  cell.queenResponse = queenResponseState(doc, cell);
  const ctx = { graph, hive: { beads: { root: { id: 'root' } }, edges: [] } };
  for (const status of ['needs-input', 'needs-you']) {
    Object.assign(graph.sessions[0], { status, waitingReason: 'Approve the command' });
    assert.equal(needsRows(ctx, [cell])[0].title, 'Queen needs attention');
    assert.equal(needsRows(ctx, [cell])[0].preview, 'The queen is waiting for input at its terminal.');
    assert.equal(cellWaitingItems(ctx, cell)[0].title, 'Queen needs attention');
    assert.equal(cellWaitingItems(ctx, cell)[0].reason, 'Approve the command');
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
  doc.requests.secret.state = 'answered';
  cell.queenResponse = queenResponseState(doc, cell);
  assert.deepEqual(needsRows(ctx, [cell]), []);
  assert.deepEqual(cellWaitingItems(ctx, cell), []);
  graph.sessions[0].lastActivity = old;
  for (const patch of [{ enabled: false }, { snapshot: {} }, { retired: {} }]) {
    assert.equal(queenNeedsAttention(graph, { ...cell, ...patch }), false);
  }
  graph.sessions[0].archived = true;
  assert.equal(queenNotResponding(graph, cell), false);
});

for (const state of [{ status: 'idle', exitOutput: 'Process exited' }, { status: 'unknown', exitOutput: 'Process crashed' }, { status: 'idle', archived: true }]) {
  for (const input of ['human', 'request']) test(`stopped queen ${JSON.stringify(state)} with ${input} input appears once and clears on restart`, () => {
    const { cell, doc, graph } = fixture();
    if (input === 'human') doc.conversation.cell.push({ author: 'human', at: now, response: { required: true } });
    else doc.requests.secret = { cellId: 'cell', audience: 'queen', state: 'open', createdAt: now, title: 'Private title' };
    cell.queenResponse = queenResponseState(doc, cell);
    Object.assign(graph.sessions[0], state);
    const ctx = { graph, hive: { beads: { root: { id: 'root' } }, edges: [] } };
    assert.equal(queenNeedsAttention(graph, cell), true);
    assert.equal(queenNotResponding(graph, cell), false);
    const rows = needsRows(ctx, [cell]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].title, 'Queen stopped');
    assert.equal(rows[0].link, '#view=ext:hive:overview&cell=cell');
    assert.equal(rows[0].sessionLinks.length, state.archived ? 0 : 1);
    assert.equal(JSON.stringify(rows).includes('Private title'), false);
    assert.equal(cellWaitingItems(ctx, cell).length, 1);
    assert.equal(cellWaitingItems(ctx, cell)[0].title, 'Queen stopped');
    for (const patch of [{ enabled: false }, { snapshot: {} }, { retired: {} }, { queenResponse: {} }]) {
      assert.equal(queenNeedsAttention(graph, { ...cell, ...patch }), false);
    }
    Object.assign(graph.sessions[0], { status: 'working', archived: false, exitOutput: null });
    assert.deepEqual(needsRows(ctx, [cell]), []);
    assert.deepEqual(cellWaitingItems(ctx, cell), []);
  });
}

for (const input of ['human', 'request']) test(`dormant queen grace and failed ${input} delivery`, t => {
  let clock = now;
  t.mock.method(Date, 'now', () => clock);
  const { cell, doc, graph } = fixture();
  const pending = input === 'human'
    ? { author: 'human', at: now, response: { required: true }, delivery: { state: 'delivered', sessionId: 'queen' } }
    : { cellId: 'cell', audience: 'queen', state: 'open', createdAt: now, queenSessionId: 'queen', queenNotification: { state: 'delivered' } };
  if (input === 'human') doc.conversation.cell.push(pending);
  else doc.requests.secret = pending;
  Object.assign(graph.sessions[0], { status: 'idle', managed: false, dormant: true });
  cell.queenResponse = queenResponseState(doc, cell);
  const ctx = { graph, hive: { beads: { root: { id: 'root' } }, edges: [] } };
  assert.deepEqual(needsRows(ctx, [cell]), []);
  clock = now + 119999;
  assert.deepEqual(needsRows(ctx, [cell]), []);
  clock++;
  assert.equal(needsRows(ctx, [cell])[0].title, 'Queen stopped or suspended');
  assert.equal(needsRows(ctx, [cell])[0].link, '#session=queen');
  assert.equal(cellWaitingItems(ctx, cell)[0].title, 'Queen stopped or suspended');
  assert.equal(queenNotResponding(graph, cell, now + 3600000), false);
  clock = now;
  const delivery = input === 'human' ? pending.delivery : pending.queenNotification;
  delivery.state = 'failed';
  cell.queenResponse = queenResponseState(doc, cell);
  assert.equal(needsRows(ctx, [cell])[0].title, 'Queen stopped or suspended');
  Object.assign(graph.sessions[0], { status: 'working', managed: true, dormant: false });
  assert.deepEqual(needsRows(ctx, [cell]), []);
  Object.assign(graph.sessions[0], { status: 'idle', managed: false });
  assert.deepEqual(needsRows(ctx, [cell]), []);
});

test('unresolved idle-ready watchdog attention reaches Needs you if queen stays idle', t => {
  t.mock.method(Date, 'now', () => now);
  const { cell, doc, graph } = fixture();
  cell.watchdogFlags = { ready: { kind: 'idle_ready_work', episodeAt: old, bead_id: 'work', since: old - 15 * 60000 } };
  cell.queenResponse = queenResponseState(doc, cell);
  assert.equal(queenNotResponding(graph, cell, now), true);
  const ctx = { graph, hive: { beads: { root: { id: 'root' } }, edges: [] } };
  assert.equal(needsRows(ctx, [cell])[0].title, 'Queen not responding');
  delete cell.watchdogFlags.ready;
  cell.queenResponse = queenResponseState(doc, cell);
  assert.deepEqual(needsRows(ctx, [cell]), []);
});
