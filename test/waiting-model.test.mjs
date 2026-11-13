import test from 'node:test';
import assert from 'node:assert/strict';
import * as model from '../public/waiting-model.js';
import { waitingItems } from '../public/waiting-view.js';
const URL = 'https://github.com/example/repo/pull/7', SHA = 'a'.repeat(40);
function fixture() {
  const cell = { id: 'c', enabled: true, taskId: 't', rootBeadId: 'root', bindings: [{ sessionId: 's', beadId: 'a' }, { sessionId: 's', beadId: 'b' }], waits: [{ id: 'message:m', kind: 'message', beadIds: ['a'], cellId: 'c' }], pullRequests: [] };
  const hive = { cells: { c: cell }, beads: { root: { id: 'root' }, a: { id: 'a', parentId: 'root' }, b: { id: 'b', parentId: 'root' } } };
  const graph = { sessions: [{ sessionId: 's', status: 'needs-you', waitingReason: 'permission' }], tasks: { assignments: { s: 't', u: 't' } }, inbox: { rev: 1, items: [{ id: 'status', source: 'status', state: 'open', sessionId: 's' }, { id: 'explicit', source: 'agent', state: 'open', sessionId: 's', title: 'Decision' }] } };
  return { cell, hive, graph };
}
test('unique header waits deduplicate passive status but keep separate explicit requests, with many bead labels', () => {
  const f = fixture(), waits = model.cellWaitingItems(f, f.cell) || [];
  assert.deepEqual(waits.map(x => x.id), ['message:m', 'agent:s', 'needsyou:explicit']);
  assert.deepEqual(waits[1].beadIds, ['a', 'b']);
  assert.equal(waitingItems(f, f.hive.beads.a).length, 3);
  assert.equal(waitingItems(f, f.hive.beads.b).length, 2);
  f.graph.sessions[0].archived = true;
  assert.equal(model.cellWaitingItems(f, f.cell).some(x => x.id === 'agent:s'), false);
});
test('native human requests join the unified waits with exact bead and topic attribution', () => {
  const f = fixture();
  f.cell.requests = {
    human: { id: 'human', cellId: 'c', audience: 'human', state: 'open', beadId: 'b', requesterSessionId: 's', title: 'Pick the API', threadId: 'topic', messageId: 'message' },
    unbound: { id: 'unbound', cellId: 'c', audience: 'human', state: 'open', title: 'Hive decision' },
    private: { id: 'private', cellId: 'c', audience: 'queen', state: 'open', beadId: 'b', title: 'Private question' },
  };
  const items = model.cellWaitingItems(f, f.cell);
  const request = items.find(x => x.id === 'request:human');
  assert.deepEqual(request?.beadIds, ['b']);
  assert.equal(request?.threadId, 'topic');
  assert.equal(request?.messageId, 'message');
  assert.equal(request?.title, 'Pick the API');
  assert.deepEqual(items.find(x => x.id === 'request:unbound')?.beadIds, ['root']);
  assert.equal(items.some(x => x.id === 'request:private'), false);
  assert.ok(items.some(x => x.id === 'agent:s'));
  assert.equal(items.length, 5);
  f.cell.enabled = false;
  assert.deepEqual(model.cellWaitingItems(f, f.cell), []);
});
test('native human routing and answer repair follow the existing Needs you predicate', () => {
  const f = fixture();
  for (const [patch, expected] of [
    [{ audience: 'queen' }, false], [{ audience: 'route-repair' }, false],
    [{ audience: 'route-repair', forwarded: {} }, true], [{ audience: 'route-repair', routeReason: 'no-queen' }, true],
    [{ state: 'answered', delivery: { state: 'delivered' } }, false],
    [{ state: 'answered', delivery: { state: 'failed' } }, true],
    [{ state: 'answered', delivery: { state: 'pending' } }, true], [{ state: 'resolved' }, false],
  ]) {
    f.cell.requests = { native: { id: 'native', cellId: 'c', audience: 'human', state: 'open', title: 'Native request', ...patch } };
    assert.equal(model.cellWaitingItems(f, f.cell).some(x => x.id === 'request:native'), expected, JSON.stringify(patch));
  }
});
test('explicit Hive links narrow request attribution; unbound task sessions go to root; answered requests vanish', () => {
  const f = fixture();
  f.graph.inbox.items[1].body = 'See [message](#view=ext:hive:overview&cell=c&bead=b&topic=topic)';
  f.graph.sessions.push({ sessionId: 'u', status: 'needs-you' });
  let items = model.cellWaitingItems(f, f.cell) || [];
  assert.deepEqual(items.find(x => x.id === 'needsyou:explicit')?.beadIds, ['b']);
  assert.deepEqual(items.find(x => x.id === 'agent:u')?.beadIds, ['root']);
  f.graph.inbox.items[1].state = 'answered';
  assert.equal(model.cellWaitingItems(f, f.cell).some(x => x.id === 'needsyou:explicit'), false);
  f.cell.snapshot = {};
  assert.deepEqual(model.cellWaitingItems(f, f.cell), []);
});
test('PR human waits require exact head reports and observations; failing worker checks stay quiet', () => {
  const classify = model.prState;
  const pr = { url: URL, state: 'OPEN', headSha: SHA, checks: 'green', isDraft: false, stateCheckedAt: 100, humanAttention: { state: 'ready', headSha: SHA, reason: 'Approved independently' } };
  assert.equal(classify(pr, 101), 'ready');
  for (const patch of [{ checks: 'pending' }, { checks: 'failing' }, { checks: 'unknown' }, { isDraft: true }, { reviewDecision: 'CHANGES_REQUESTED' }, { headSha: 'b'.repeat(40) }, { humanAttention: null }, { mergeable: 'CONFLICTING' }]) assert.equal(classify({ ...pr, ...patch }, 101), 'working');
  assert.equal(classify(pr, 400000), 'stale');
  assert.equal(classify({ ...pr, humanAttention: { ...pr.humanAttention, state: 'cannot-fix' }, checks: 'failing' }, 101), 'stuck');
  assert.equal(classify({ ...pr, state: 'MERGED' }, 101), 'merged');
});
test('capped Needs You graphs report incomplete coverage without claiming an exact queue total', () => {
  const incomplete = model.needsYouIncomplete;
  assert.equal(incomplete({ inbox: { items: Array(200).fill({}) } }), true);
  assert.equal(incomplete({ inbox: { items: Array(199).fill({}) } }), false);
  assert.equal(incomplete({}), false);
});

test('a passive Needs You item without a matching live input still remains visible as a queue request', () => {
  const f = fixture();
  f.graph.sessions = [];
  const items = model.cellWaitingItems(f, f.cell);
  assert.equal(items.length, 3);
  assert.ok(items.some(x => x.id === 'needsyou:status'));
});

test('Needs You links to old paged messages use the server target index rather than guessing the root', () => {
  const f = fixture();
  f.cell.waitTargets = { messages: { old: 'b' }, topics: { oldtopic: 'a' } };
  f.graph.inbox.items[1].body = '[context](#view=ext:hive:overview&cell=c&topic=oldtopic&message=old)';
  assert.deepEqual(model.cellWaitingItems(f, f.cell).find(x => x.id === 'needsyou:explicit').beadIds, ['b']);
});

test('render keys change for session reassignment, input reason and a request edit without Hive metadata changes', () => {
  const f = fixture(), key = model.waitingGraphKey;
  let before = key(f.graph);
  f.graph.tasks.assignments.s = 'other-task';
  assert.notEqual(key(f.graph), before);
  before = key(f.graph);
  f.graph.sessions[0].waitingReason = 'sign-in';
  assert.notEqual(key(f.graph), before);
  before = key(f.graph);
  f.graph.inbox.items[1].body = 'Changed bead link';
  assert.notEqual(key(f.graph), before);
});

test('malformed and foreign absolute links in a request cannot break rendering or claim a different bead', t => {
  const previous = globalThis.location;
  globalThis.location = { origin: 'http://localhost:7984' };
  t.after(() => { globalThis.location = previous; });
  const f = fixture();
  f.graph.inbox.items[1].body = 'https://[invalid#view=ext:hive:overview&cell=c&bead=b and https://elsewhere.test/#view=ext:hive:overview&cell=c&bead=b';
  const item = model.cellWaitingItems(f, f.cell).find(x => x.id === 'needsyou:explicit');
  assert.deepEqual(item.beadIds, ['a', 'b']);
});
