import test from 'node:test';
import assert from 'node:assert/strict';
import { beadTile } from '../public/cell-view.js';

function tileFor(prerequisites, status = 'open', snapshot = false) {
  const work = { id: 'work', title: 'Ship feature', kind: 'work', status };
  const beads = { work, ...Object.fromEntries(prerequisites.map(p => [p.id, p])) };
  const hive = {
    cells: { cell: { snapshot: snapshot ? {} : null } }, beads,
    edges: prerequisites.map(p => ({ dependent: 'work', prerequisite: p.id, blocking: p.blocking !== false })),
  };
  return beadTile({ hive, graph: { sessions: [] } }, work, {
    cellId: 'cell', layout: { groupHeads: [], parentHead: {}, halo: {} },
  }, new Map());
}

test('waiting on open external prerequisites shows only the cross', () => {
  for (const snapshot of [false, true]) {
    const tile = tileFor([
      { id: 'external', kind: 'external', status: 'open' },
      { id: 'another', kind: 'external', status: 'in_progress' },
      { id: 'internal', kind: 'work', status: 'open' },
    ], 'deferred', snapshot);
    assert.deepEqual(tile.marks.map(m => m.kind), ['waiting']);
    assert.match(tile.title, /Waiting on something outside this hive/i);
    assert.match(tile.ariaLabel, /Waiting on something outside this hive/i);
  }
});

test('internal, closed and nonblocking external prerequisites do not add a chain mark', () => {
  const prerequisites = [
    { id: 'internal', kind: 'work', status: 'open' },
    { id: 'finished', kind: 'external', status: 'closed' },
    { id: 'related', kind: 'external', status: 'open', blocking: false },
  ];
  assert.deepEqual(tileFor(prerequisites).marks.map(m => m.kind), ['waiting']);
  assert.deepEqual(tileFor(prerequisites, 'closed').marks.map(m => m.kind), ['closed']);
});
