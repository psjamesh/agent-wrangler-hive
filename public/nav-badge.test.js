import test from 'node:test';
import assert from 'node:assert/strict';
import client from './client.js';
import { cellMetrics } from './cell-metrics.js';

function badge() {
  let view;
  client.register({ api: {}, register(slot, contribution) { if (slot === 'view') view = contribution; } });
  return graph => view.badge(graph);
}

function fixture() {
  const request = id => ({ id, beadId: 'root', audience: 'human', state: 'open' });
  const live = { id: 'live', taskId: 'task', enabled: true, rootBeadId: 'root', queenSessionId: 'queen', requests: { r: request('r'), private: { ...request('private'), audience: 'queen' } }, bindings: [{ sessionId: 'worker', beadId: 'root' }], pullRequests: [{ url: 'https://github.com/example/repo/pull/1', state: 'OPEN', headSha: 'a'.repeat(40), stateCheckedAt: Date.now(), isDraft: false, checks: 'green', beadIds: ['root'], humanAttention: { headSha: 'a'.repeat(40), state: 'ready' } }] };
  const off = { id: 'off', enabled: false, rootBeadId: 'root', requests: { o: request('o') }, bindings: [{ sessionId: 'off-worker', beadId: 'root' }] };
  const captured = { id: 'captured', rootBeadId: 'root', snapshot: {}, requestCounts: { human: 2 } };
  const retired = { ...live, id: 'retired', retired: { outcome: 'done' } };
  return { hive: { requestCount: 99, beads: { root: { id: 'root', status: 'in_progress' } }, cells: { live, off, captured, retired } }, sessions: [{ sessionId: 'queen', status: 'needs-you' }, { sessionId: 'worker', status: 'needs-you' }, { sessionId: 'off-worker', status: 'needs-you' }] };
}

function tileTotal(graph) {
  return Object.values(graph.hive.cells).reduce((total, cell) => total + cellMetrics({ hive: graph.hive, graph }, cell).needs, 0);
}

test('navigation badge sums tile needs across live, off, captured and retired hives', () => {
  const count = badge(), graph = fixture();
  assert.equal(tileTotal(graph), 7);
  assert.equal(count(graph), tileTotal(graph));
});

test('navigation badge follows request, worker input and PR graph changes', () => {
  const count = badge(), graph = fixture();
  const initial = tileTotal(graph);
  Object.assign(graph.hive.cells.live.requests.r, { state: 'answered', delivery: { state: 'delivered' } });
  graph.sessions[1].status = 'working';
  graph.hive.cells.live.pullRequests[0].state = 'MERGED';
  assert.equal(tileTotal(graph), initial - 3);
  assert.equal(count(graph), tileTotal(graph));
  graph.hive.cells.live.requests.r.state = 'open';
  graph.sessions[1].status = 'needs-you';
  graph.hive.cells.live.pullRequests[0].state = 'OPEN';
  assert.equal(count(graph), initial);
});

test('navigation badge handles absent or corrupt Hive metadata', () => {
  const count = badge();
  assert.equal(count(undefined), 0);
  assert.equal(count({ hive: { requestCount: 9 } }), 0);
  assert.equal(count({ ...fixture(), hive: { ...fixture().hive, metadataError: 'Corrupt metadata' } }), 0);
});
