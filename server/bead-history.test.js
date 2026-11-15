import test from 'node:test';
import assert from 'node:assert/strict';
import { beadHistory } from './bead-history.js';

const bead = { id: 'a', evidence: [] };

test('history combines recorded attempts, review rounds, handoff, merge and close in time order', () => {
  const doc = {
    workerLaunches: {
      first: { id: 'first', beadId: 'a', sessionId: 'w1', role: 'worker', state: 'abandoned', createdAt: 1000, updatedAt: 3000, reason: 'Host restarted\nNeeds replacement' },
      second: { id: 'second', beadId: 'a', sessionId: 'w2', role: 'worker', state: 'launched', createdAt: 4000 },
      other: { id: 'other', beadId: 'b', state: 'refused', createdAt: 2000 },
    },
    reviews: { r: { id: 'r', workBeadId: 'a', reviewerSessionId: 'reviewer', round: 2, state: 'approved', createdAt: 5000, history: [{ round: 1, verdict: { by: 'reviewer', value: 'changes_requested', summary: 'Fix race', at: 6000 } }], verdict: { by: 'reviewer', value: 'approved', summary: 'Ready', at: 8000 } } },
  };
  const history = beadHistory(doc, { ...bead, status: 'closed', outcome: 'done', closedAt: 10000, closeReason: 'Delivered', evidence: [{ kind: 'handoff', label: 'Replacement', detail: 'New worker owns delivery', by: 'aw:w1', at: 3500 }, { kind: 'merge', label: 'Merged', by: 'aw:w2', at: 9000 }] });
  assert.deepEqual(history.map(e => e.outcome), ['Worker launch: abandoned', 'Handoff', 'Worker launch: launched', 'Review round 1: changes requested', 'Review round 2: approved', 'Merged', 'Closed: done']);
  assert.equal(history[0].reason, 'Host restarted');
  assert.equal(history[3].by, 'reviewer');
  assert.equal(history[3].reason, 'Fix race');
  assert.equal(history.at(-1).at, new Date(10000).toISOString());
});

test('standalone bindings, claims, releases, pickup refusals and recovered launches remain visible', () => {
  const doc = {
    workerLaunches: { l: { id: 'l', beadId: 'a', state: 'launched', createdAt: 1000, recoveredAt: 2000 }, refused: { id: 'refused', beadId: 'a', state: 'refused', armToken: 't', error: 'No capacity' } },
    bindings: { c: [{ id: 'b', beadId: 'a', sessionId: 'w', role: 'worker', at: 3000, active: false, unboundAt: 7000, note: 'Replacement' }] },
    operations: {
      claim: { id: 'claim', kind: 'claim', beadIds: ['a'], actor: 'aw:w', state: 'applied', createdAt: 4000 },
      release: { id: 'release', kind: 'release', beadIds: ['a'], actor: 'aw:w', state: 'applied', updatedAt: 6000, reason: 'unused', result: { reason: 'Handed over' } },
      pending: { id: 'pending', kind: 'claim', beadIds: ['a'], state: 'uncertain', createdAt: 5000 },
    },
    pickupAttempts: { t: { beadId: 'a', at: 8000, launchId: 'refused' } },
  };
  const before = JSON.stringify(doc);
  const history = beadHistory(doc, bead);
  assert.deepEqual(history.map(e => e.outcome), ['Worker launch: launched', 'Launch recovered', 'Bound: worker', 'Claimed', 'Released', 'Unbound', 'Worker launch: refused']);
  assert.equal(history.find(e => e.outcome === 'Released').reason, 'Handed over');
  assert.equal(JSON.stringify(doc), before);
});

test('legacy missing fields are honest, deterministic and unrelated records stay out', () => {
  const doc = { bindings: { c: [{ id: 'b', beadId: 'b', at: 1000 }] }, workerLaunches: { l: { id: 'l', beadId: 'a', state: 'refused', error: 'No model' } } };
  assert.deepEqual(beadHistory({}, bead), []);
  assert.deepEqual(beadHistory(doc, bead), [{ id: 'launch:l', at: null, by: null, outcome: 'Worker launch: refused', reason: 'No model' }]);
});

test('an unsettled verdict is shown as a review in progress, not an approval', () => {
  const history = beadHistory({ reviews: { r: { id: 'r', workBeadId: 'a', state: 'in_review', createdAt: 1000, verdict: { value: 'approved', at: 2000, summary: 'Still being written' } } } }, bead);
  assert.equal(history[0].outcome, 'Review round 1: in review');
  assert.equal(history[0].at, new Date(1000).toISOString());
});

test('automatic unbinds show the persisted recovery actor and stop reason', () => {
  const history = beadHistory({ bindings: { c: [{ id: 'b', beadId: 'a', sessionId: 'worker', at: 1000, active: false, unboundAt: 2000, unboundBy: 'aw:hive-recovery', unboundBecause: 'Session archived', note: 'Original brief' }] } }, bead);
  assert.equal(history.at(-1).by, 'aw:hive-recovery');
  assert.equal(history.at(-1).reason, 'Session archived');
});

test('a later review round in progress uses its recorded update time', () => {
  const history = beadHistory({ reviews: { r: { id: 'r', workBeadId: 'a', state: 'in_review', round: 2, createdAt: 1000, startedAt: 2000, updatedAt: 5000, history: [{ round: 1, verdict: { value: 'changes_requested', at: 3000 } }] } } }, bead);
  assert.equal(history[1].at, new Date(5000).toISOString());
});

test('recorded closes survive reopening without duplicating the current close', () => {
  const doc = { operations: {
    f1: { id: 'f1', kind: 'finish', beadIds: ['a'], state: 'applied', actor: 'aw:w', updatedAt: 1000, intent: { outcome: 'done' } },
    r: { id: 'r', kind: 'reopen', beadIds: ['a'], state: 'applied', actor: 'aw:human', updatedAt: 2000 },
    f2: { id: 'f2', kind: 'finish', beadIds: ['a'], state: 'applied', actor: 'aw:w2', updatedAt: 3000, intent: { outcome: 'done' } },
  } };
  assert.deepEqual(beadHistory(doc, { ...bead, status: 'open' }).map(e => e.outcome), ['Closed: done', 'Reopened', 'Closed: done']);
  const closed = beadHistory(doc, { ...bead, status: 'closed', closedAt: 2900, outcome: 'done', closeReason: 'Delivered' });
  assert.equal(closed.filter(e => e.outcome === 'Closed: done').length, 2);
  assert.equal(closed.at(-1).reason, 'Delivered');
});
