import test from 'node:test';
import assert from 'node:assert/strict';
import { projectForGraph } from '../server/projection.js';
import { beadDetail, searchBeads } from '../server/bead-detail.js';

const long = 'Long paragraph of detail. '.repeat(200);

function fixture() {
  const beads = {
    root: { id: 'root', title: 'Root', kind: 'goal', status: 'open', parentId: null, goal: 'Root goal\nmore', acceptance: 'Root acceptance', summary: long, evidence: [], nextAction: '', waitingFor: '' },
    a: { id: 'a', title: 'Work A', kind: 'work', status: 'in_progress', parentId: 'root', ownerSessionId: 's1', assignee: 'aw:s1', goal: long, acceptance: long, summary: `\nFirst line of notes\n${long}`, nextAction: 'Ship it', waitingFor: 'Outside fix', evidence: [{ label: 'Proof', detail: 'findme-evidence', kind: 'test' }], nativeMetadataKeys: ['x'], updatedAt: 't1' },
    other: { id: 'other', title: 'Elsewhere', kind: 'goal', status: 'open', parentId: null, goal: 'findme-evidence also here', evidence: [] },
  };
  const doc = { cells: { c: { id: 'c', rootBeadId: 'root', enabled: true }, off: { id: 'off', rootBeadId: 'other', enabled: false } }, bindings: {}, reviews: { r: { id: 'r', workBeadId: 'a', state: 'requested', summary: 'Please look' } }, beadLayout: {}, arrangeAspect: {}, archived: {}, restoreNotices: {}, conversation: {}, threads: {}, operations: {}, launches: {}, requests: {}, workstreamColours: {}, workstreamShades: {}, inbox: {} };
  const graph = { beads, edges: [] };
  const runtime = { metadata: { read: () => doc, cells: () => Object.values(doc.cells) }, beads: { status: {} }, paths: {}, host: { sessions: { get: () => ({ status: 'working' }) } }, snapshots: { graph, current: { graph, revision: 7 } } };
  return { beads, doc, runtime, graph, project: () => projectForGraph({ runtime, snapshot: runtime.snapshots.current }) };
}

test('the projection sends a slim bead and leaves the long text out', () => {
  const f = fixture();
  const hive = f.project();
  const a = hive.beads.a;
  for (const key of ['goal', 'acceptance', 'summary', 'evidence', 'nextAction', 'nativeMetadataKeys']) assert.equal(key in a, false, key);
  assert.equal(a.summaryLine, 'First line of notes');
  assert.equal(a.waitingFor, 'Outside fix');
  assert.equal(a.reviewState, 'requested');
  assert.equal(a.review.summary, 'Please look');
  assert.equal(a.ownerSessionId, 's1');
  assert.equal(a.untracked, false);
  assert.equal(hive.beads.root.goal, 'Root goal\nmore');
  assert.equal(hive.beads.root.acceptance, 'Root acceptance');
  assert.equal('summary' in hive.beads.root, false);
  assert.ok(JSON.stringify(hive).length < JSON.stringify(f.beads).length / 4);
});

test('bead detail returns the full record and refuses beads the board does not show', () => {
  const f = fixture();
  const { bead } = beadDetail(f.runtime, { beadId: 'a' });
  assert.equal(bead.goal, long);
  assert.equal(bead.nextAction, 'Ship it');
  assert.deepEqual(bead.evidence.map(e => e.label), ['Proof']);
  assert.equal(bead.reviewState, 'requested');
  assert.throws(() => beadDetail(f.runtime, { beadId: 'other' }), { code: 'unknown-bead' });
  assert.throws(() => beadDetail(f.runtime, { beadId: 'nope' }), { code: 'unknown-bead' });
  assert.throws(() => beadDetail(f.runtime, { beadId: undefined }), { code: 'unknown-bead' });
});

test('body search runs on the server within one cell', () => {
  const f = fixture();
  const found = searchBeads(f.runtime, { cellId: 'c', query: 'FINDME' });
  assert.deepEqual(found.results, [{ id: 'a', field: 'evidence', rank: 6 }]);
  assert.equal(found.revision, 7);
  assert.deepEqual(searchBeads(f.runtime, { cellId: 'c', query: 'first line' }).results.map(r => r.field), ['summary']);
  assert.deepEqual(searchBeads(f.runtime, { cellId: 'c', query: '' }).results, []);
  assert.deepEqual(searchBeads(f.runtime, { cellId: 'off', query: 'findme' }).results, []);
});

test('closed reviews send no summary in the slim bead; open reviews do; detail carries it', () => {
  const f = fixture();
  f.doc.reviews.r = { id: 'r', workBeadId: 'a', state: 'approved', summary: long, history: [{ summary: long }], verdict: { summary: long }, reviewerSessionId: 's2' };
  const slim = f.project().beads.a;
  assert.equal(slim.review.state, 'approved');
  assert.equal(slim.review.reviewerSessionId, 's2');
  assert.deepEqual(Object.keys(slim.review).sort(), ['id', 'reviewerSessionId', 'state', 'workBeadId']);
  assert.equal(beadDetail(f.runtime, { beadId: 'a' }).bead.review.summary, long);
  f.doc.reviews.r = { ...f.doc.reviews.r, state: 'in_review' };
  assert.equal(f.project().beads.a.review.summary, long);
});
