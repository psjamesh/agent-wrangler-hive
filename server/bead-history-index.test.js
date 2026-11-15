import test from 'node:test';
import assert from 'node:assert/strict';
import { indexBeadHistory, beadHistory } from './bead-history.js';

test('projection indexes retained history once rather than rescanning all records for each bead', () => {
  let visits = 0;
  const doc = { workerLaunches: {}, bindings: { c: [] }, operations: {}, reviews: {} };
  for (let i = 0; i < 500; i++) {
    const beadId = `b${i}`;
    doc.workerLaunches[i] = { id: `l${i}`, get beadId() { visits++; return beadId; }, createdAt: 1000, state: 'launched' };
    doc.bindings.c.push({ id: `binding${i}`, beadId, sessionId: `worker${i}`, at: 2000 });
    doc.operations[i] = { id: `op${i}`, kind: 'claim', beadIds: [beadId], state: 'applied', createdAt: 3000 };
    doc.reviews[i] = { id: `r${i}`, workBeadId: beadId, createdAt: 4000, state: 'requested' };
  }
  const index = indexBeadHistory(doc);
  const afterIndex = visits;
  for (let i = 0; i < 500; i++) {
    const bead = { id: `b${i}` };
    assert.equal(beadHistory(index.get(bead.id), bead).length, 4);
  }
  assert.ok(visits - afterIndex <= 500, `Visited ${visits - afterIndex} launch records during projection`);
  assert.deepEqual(beadHistory(index.get('missing') || {}, { id: 'missing' }), []);
});
