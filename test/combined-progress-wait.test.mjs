import test from 'node:test';
import assert from 'node:assert/strict';
import { beadTile } from '../public/cell-view.js';
import { childrenMap } from '../public/model.js';

function fixture(extra = {}, agentStatus = 'idle') {
  const bead = { id: 'a', parentId: 'ws', title: 'Combined work', kind: 'work', status: 'in_progress', ownerSessionId: 'builder', waitingFor: 'External compatibility report', ...extra };
  const hive = { cells: { cell: {} }, beads: { a: bead }, edges: [] };
  const graph = { sessions: [{ sessionId: 'builder', name: 'Builder', status: agentStatus }] };
  const render = () => beadTile({ hive, graph }, bead, { cellId: 'cell', x: 0, y: 0, layout: { groupHeads: [], parentHead: {}, halo: {}, rootId: 'root' } }, childrenMap(hive.beads));
  return { bead, hive, render };
}
const kinds = tile => (tile.marks || []).map(m => m.kind);
function reasonOnce(tile) {
  for (const text of [tile.title, tile.ariaLabel]) assert.equal(text.split('External compatibility report').length - 1, 1);
  assert.equal(kinds(tile).filter(k => k === 'recorded-wait').length, 1);
}

test('idle owner and recorded wait show an arc and one hourglass, then clear independently', () => {
  const f = fixture();
  let tile = f.render();
  assert.deepEqual(kinds(tile), ['in-progress', 'recorded-wait']);
  assert.equal(tile.mark.kind, 'in-progress');
  reasonOnce(tile);
  f.bead.waitingFor = '';
  tile = f.render();
  assert.deepEqual(kinds(tile), ['in-progress']);
  assert.doesNotMatch(tile.title, /External compatibility report/);
});

test('recorded wait coexists with pending and active review while retaining review context', () => {
  const f = fixture({ reviewState: 'requested', review: { summary: 'Inspect release races', waitingFor: 'Reviewer replacement required' } });
  for (const working of [false, true]) {
    f.bead.reviewWorking = working;
    const tile = f.render();
    assert.deepEqual(kinds(tile), [working ? 'review-working' : 'review-pending', 'recorded-wait']);
    reasonOnce(tile);
    for (const text of [tile.title, tile.ariaLabel, tile.mark.title]) {
      assert.match(text, /Inspect release races/);
      assert.match(text, /Reviewer replacement required/);
    }
    assert.doesNotMatch(tile.ariaLabel, /In progress; agent idle/);
  }
  f.bead.reviewState = 'approved';
  assert.deepEqual(kinds(f.render()), ['approved', 'recorded-wait']);
});

test('prerequisite cross carries the waiting note without an hourglass', () => {
  const f = fixture();
  f.hive.beads.prereq = { id: 'prereq', title: 'Approve interface', status: 'open' };
  f.hive.edges.push({ prerequisite: 'prereq', dependent: 'a', blocking: true });
  const tile = f.render();
  assert.deepEqual(kinds(tile), ['waiting']);
  for (const text of [tile.title, tile.ariaLabel, tile.marks[0].title]) assert.match(text, /Waiting for: External compatibility report/);
  for (const text of [tile.title, tile.ariaLabel, tile.mark.title]) assert.match(text, /Approve interface/);
  assert.match(tile.mark.title, /Waiting on a prerequisite/);
});

test('blocked status puts the waiting note in the cross tooltip and aria-label', () => {
  const f = fixture({ status: 'blocked' });
  const tile = f.render();
  assert.deepEqual(kinds(tile), ['waiting']);
  assert.match(tile.marks[0].title, /Blocked.*Waiting for: External compatibility report/);
  assert.match(tile.ariaLabel, /Waiting for: External compatibility report/);
});

test('waiting note alone keeps its hourglass and tooltip', () => {
  const f = fixture({ status: 'open', ownerSessionId: null });
  const tile = f.render();
  assert.deepEqual(kinds(tile), ['recorded-wait']);
  assert.equal(tile.marks[0].title, 'Waiting for: External compatibility report');
  reasonOnce(tile);
});

test('closed and higher-priority work retain their mark alongside a stale recorded wait', () => {
  const cases = [
    [{ status: 'closed', outcome: 'done' }, 'idle', 'done'],
    [{ status: 'closed', outcome: 'dropped' }, 'idle', 'closed'],
    [{ status: 'closed', outcome: 'done' }, 'needs-you', 'person'],
    [{}, 'needs-you', 'person'],
    [{}, 'working', 'busy'],
    [{ untracked: true }, 'idle', 'untracked'],
    [{ status: 'deferred' }, 'idle', 'deferred'],
  ];
  for (const [extra, agentStatus, expected] of cases) {
    const f = fixture(extra, agentStatus);
    const tile = f.render();
    assert.deepEqual(kinds(tile), [expected, 'recorded-wait']);
    reasonOnce(tile);
    f.bead.waitingFor = '   ';
    assert.deepEqual(kinds(f.render()), [expected]);
  }
});

for (const kind of ['decision', 'investigation']) {
  test(`open ${kind} prerequisite labels the map waiting on design without changing status`, () => {
    const f = fixture({ status: 'open', ownerSessionId: null, waitingFor: '' });
    f.hive.beads.design = { id: 'design', title: 'Resolve interface design', kind, status: 'open' };
    f.hive.edges.push({ dependent: 'a', prerequisite: 'design', blocking: true });
    const tile = f.render();
    assert.equal(tile.badge, 'Waiting on design');
    assert.match(tile.title, /waiting on design/i);
    assert.match(tile.ariaLabel, /waiting on design/i);
    assert.equal(f.bead.status, 'open');
    f.hive.beads.design.status = 'closed';
    assert.notEqual(f.render().badge, 'Waiting on design');
    f.hive.beads.design.status = 'open'; f.hive.edges[0].blocking = false;
    assert.notEqual(f.render().badge, 'Waiting on design');
  });
}
