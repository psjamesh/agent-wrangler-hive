import test from 'node:test';
import assert from 'node:assert/strict';
import { beadTile, primaryKind, legend } from '../public/cell-view.js';
import { primaryMark } from '../public/hex-grid.js';
import { childrenMap } from '../public/model.js';

function fixture(extra = {}, sessions = [{ sessionId: 'builder', name: 'Builder', status: 'idle' }]) {
  const bead = { id: 'work', title: 'Build feature', kind: 'work', status: 'in_progress', ownerSessionId: 'builder', ...extra };
  const hive = { cells: { cell: {} }, beads: { work: bead }, edges: [] };
  const tile = { cellId: 'cell', x: 0, y: 0, layout: { groupHeads: [], parentHead: {}, halo: {}, rootId: 'root' } };
  return { bead, hive, tile, render: () => beadTile({ hive, graph: { sessions } }, bead, tile, childrenMap(hive.beads)) };
}

test('idle live claim has an accessible progress mark distinct from Untracked', () => {
  const f = fixture();
  const tile = f.render();
  assert.equal(tile.mark?.kind, 'in-progress');
  for (const text of [tile.title, tile.ariaLabel, tile.mark.title]) assert.match(text, /In progress; agent idle/);
  assert.equal(primaryKind({ ...f.bead, untracked: true }, [], ['idle'], 0, 'idle'), 'untracked');
  for (const session of [[], [{ sessionId: 'builder', status: 'exited' }], [{ sessionId: 'builder', status: 'idle', archived: true }]]) {
    assert.equal(fixture({}, session).render().mark, null);
  }
  const snapshot = fixture(); snapshot.hive.cells.cell.snapshot = {};
  assert.equal(snapshot.render().mark, null);
  assert.equal(fixture({ status: 'open' }).render().mark, null);
});

test('working bound agents take precedence over an idle owner and all agents are named', () => {
  for (const role of ['worker', 'reviewer']) {
    const f = fixture({}, [
      { sessionId: 'builder', name: 'Builder', status: 'idle' },
      { sessionId: 'helper', name: 'Active helper', status: 'working' },
    ]);
    f.hive.cells.cell.bindings = [{ beadId: 'work', sessionId: 'helper', role }];
    const tile = f.render();
    assert.equal(tile.mark.kind, 'busy');
    assert.match(tile.title, /Builder idle/);
    assert.match(tile.title, /Active helper working/);
    assert.doesNotMatch(tile.ariaLabel, /In progress; agent idle/);
    if (role === 'reviewer') {
      Object.assign(f.bead, { reviewState: 'in_review', reviewWorking: true });
      const reviewTile = f.render();
      assert.equal(reviewTile.mark.kind, 'review-working');
      assert.match(reviewTile.title, /reviewer working/);
      assert.match(reviewTile.title, /Active helper working/);
      assert.doesNotMatch(reviewTile.ariaLabel, /In progress; agent idle/);
      f.bead.reviewWorking = false;
      assert.equal(f.render().mark.kind, 'review-pending');
    }
  }
});

test('recorded wait shows its reason on idle work and preserves higher priority marks', () => {
  const f = fixture({ waitingFor: 'Release after review approval' });
  let tile = f.render();
  assert.equal(tile.mark?.kind, 'in-progress');
  for (const text of [tile.title, tile.ariaLabel, tile.mark.title]) assert.match(text, /Release after review approval/);
  f.bead.reviewState = 'requested';
  f.bead.review = { waitingFor: 'Reviewer replacement required', summary: 'Check admission races' };
  tile = f.render();
  assert.equal(tile.mark.kind, 'review-pending');
  assert.match(tile.title, /Reviewer replacement required/);
  assert.match(tile.mark.title, /Check admission races/);
  assert.equal(primaryKind(f.bead, [], ['needs'], 0, 'needs'), 'person');
  assert.equal(primaryKind({ status: 'closed', outcome: 'done', waitingFor: 'old wait' }, [], ['idle'], 0, 'idle'), 'done');
});

test('blocking prerequisite is named in tile tooltip and accessible mark', () => {
  const f = fixture();
  f.hive.beads.prereq = { id: 'prereq', title: 'Approve interface', status: 'open' };
  f.hive.edges.push({ prerequisite: 'prereq', dependent: 'work', blocking: true });
  const tile = f.render();
  assert.equal(tile.mark.kind, 'waiting');
  for (const text of [tile.title, tile.ariaLabel, tile.mark.title]) assert.match(text, /Approve interface/);
});

test('workstream tooltip counts nested in-progress work', () => {
  const f = fixture({ kind: 'workstream' });
  f.tile.layout.groupHeads = ['work'];
  f.hive.beads.child = { id: 'child', parentId: 'work', status: 'in_progress', occupiesCapacity: true };
  f.hive.beads.done = { id: 'done', parentId: 'work', status: 'closed' };
  assert.match(f.render().title, /1 in progress/);
  assert.match(f.render().ariaLabel, /1 in progress/);
});

test('idle progress has a rendered glyph and Key entry', (t) => {
  const previousDocument = globalThis.document; const previousNode = globalThis.Node;
  class Element {
    constructor(text = '') { this.text = text; this.children = []; this.dataset = {}; this.style = {}; }
    setAttribute() {}
    append(child) { this.children.push(child); }
    addEventListener() {}
  }
  globalThis.Node = Element;
  globalThis.document = { createElement: () => new Element(), createElementNS: () => new Element(), createTextNode: (text) => new Element(text) };
  t.after(() => { globalThis.document = previousDocument; globalThis.Node = previousNode; });
  const words = (node) => node.text + node.children.map(words).join(' ');
  assert(primaryMark('in-progress', 'In progress; agent idle'));
  assert.match(words(legend()), /in progress; agent idle/i);
});
