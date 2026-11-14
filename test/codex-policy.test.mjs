import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture } from './ownership.test.mjs';
import { createManifest } from '../server/manifest.js';
import { configHandlers } from '../server/handlers.js';

const choices = [[undefined, undefined], ['config', undefined], ['approve-for-me', { approveForMe: true }], ['on-request', { approval: 'on-request' }], ['never', { approval: 'never' }]];

for (const [setting, expected] of choices) for (const phase of ['dispatch', 'resume', 'fork']) {
  test(`${setting ?? 'missing'} Codex approvals apply at ${phase} to queens, workers and reviewers`, () => {
    const f = fixture(0);
    f.rt.metadata.mutate(d => {
      d.cells.cell.codexApprovals = setting;
      d.bindings.cell = ['worker', 'reviewer'].map(role => ({ sessionId: role, role, active: true, beadId: 'a' }));
    });
    const hook = createManifest({ dir: '.' }).codexPolicy;
    for (const sid of ['queen', 'worker', 'reviewer']) {
      const context = phase === 'fork' ? { sessionId: 'new-fork', parentId: sid } : { sessionId: sid };
      assert.deepEqual(hook({ ...context, phase, ext: f.host }), expected);
    }
    assert.equal(hook({ sessionId: 'outsider', phase, ext: f.host }), undefined);
  });
}

test('Codex policy uses current membership and setting, and ignores disabled or captured hives', () => {
  const f = fixture();
  const hook = createManifest({ dir: '.' }).codexPolicy;
  f.rt.metadata.mutate(d => { d.cells.cell.codexApprovals = 'never'; });
  f.rt.pendingParticipants.set('pending', { cellId: 'cell', taskId: 'task', at: Date.now() });
  assert.deepEqual(hook({ sessionId: 'pending', ext: f.host }), { approval: 'never' });
  f.rt.metadata.mutate(d => { d.cells.cell.codexApprovals = 'approve-for-me'; });
  assert.deepEqual(hook({ sessionId: 'pending', ext: f.host }), { approveForMe: true });
  for (const field of ['enabled', 'snapshot']) {
    f.rt.metadata.mutate(d => { d.cells.cell.enabled = field !== 'enabled'; d.cells.cell.snapshot = field === 'snapshot'; });
    assert.equal(hook({ sessionId: 'queen', ext: f.host }), undefined);
  }
  assert.equal(hook({ sessionId: 'queen', ext: {} }), undefined);
});

test('forks prefer their own hive membership over the parent and ambiguity leaves core defaults', () => {
  const f = fixture();
  const hook = createManifest({ dir: '.' }).codexPolicy;
  f.rt.metadata.mutate(d => { d.cells.cell.codexApprovals = 'never'; d.cells.other.codexApprovals = 'on-request'; });
  assert.deepEqual(hook({ phase: 'fork', sessionId: 'queen2', parentId: 'queen', ext: f.host }), { approval: 'on-request' });
  f.rt.metadata.mutate(d => { d.bindings.other = [{ sessionId: 'queen', active: true, beadId: 'c' }]; });
  assert.equal(hook({ phase: 'resume', sessionId: 'queen', ext: f.host }), undefined);
});

test('human settings handler validates and stores Codex approvals per cell', async () => {
  const f = fixture();
  const handler = configHandlers.find(h => h.type === 'hive-codex-approvals');
  for (const value of ['config', 'approve-for-me', 'on-request', 'never']) {
    let reply;
    await handler.handler({ cellId: 'cell', value }, f.host, r => { reply = r; });
    assert.equal(reply.ok, true);
    assert.equal(f.doc().cells.cell.codexApprovals, value);
    assert.equal(f.doc().cells.other.codexApprovals, undefined);
  }
  for (const value of [undefined, null, '', 'bypass', {}, 42]) {
    let reply;
    await handler.handler({ cellId: 'cell', value }, f.host, r => { reply = r; });
    assert.equal(reply.ok, false);
    assert.equal(f.doc().cells.cell.codexApprovals, 'never');
  }
  f.rt.metadata.mutate(d => { d.cells.cell.snapshot = true; });
  let reply;
  await handler.handler({ cellId: 'cell', value: 'config' }, f.host, r => { reply = r; });
  assert.equal(reply.ok, false);
});
