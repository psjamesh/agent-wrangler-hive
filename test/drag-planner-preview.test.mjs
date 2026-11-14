import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as hex from '../public/hex-layout.js';
import * as search from '../public/hex-search.js';
import * as attachments from '../public/region-attachments.js';
import * as hiddenPlacement from '../public/hidden-placement.js';
import { layoutCell } from '../public/cell-layout.js';

const source = fs.readFileSync(new URL('../public/cell-move.js', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '').replaceAll('export function', 'function').replaceAll('export const', 'const');

test('drag previews never rebuild saved layouts; drop planning still validates the saved batch', () => {
  let rebuilds = 0;
  const planner = vm.runInNewContext(source + '\n({ createDragPlanner, planMove })', {
    ...hex, ...search, ...attachments, ...hiddenPlacement, performance,
    layoutCell: args => { rebuilds++; return layoutCell(args); },
  });
  const kids = new Map([['root', [{ id: 'head', parentId: 'root', kind: 'workstream' }]],
    ['head', [{ id: 'work', parentId: 'head' }, { id: 'done', parentId: 'head' }]]]);
  const saved = { head: { q: 0, r: 0 }, work: { q: 1, r: 0 }, done: { q: 2, r: 0 } };
  const hidden = new Set(['done']);
  const args = { kids, rootId: 'root', saved, hidden, yieldIds: hidden, id: 'head' };
  args.layout = layoutCell(args);
  const preview = planner.createDragPlanner(args, { previewOnly: true });
  for (let q = 8; q < 20; q++) assert.equal(preview({ q, r: 0 }).ok, true);
  assert.equal(rebuilds, 0, 'pointer movement must not run the save-layout planner');
  const shown = preview({ q: 20, r: 0 });
  const drop = planner.planMove({ ...args, target: shown.target });
  assert.equal(drop.ok, true);
  assert.deepEqual(drop.moves, shown.moves);
  assert.ok(drop.positions.done, 'drop carries the hidden saved position');
  assert.ok(rebuilds > 0, 'drop still validates that unaffected beads keep their places');
});

test('366 beads with mostly hidden closed work keep layout rebuilding out of drag previews', () => {
  let rebuilds = 0;
  const planner = vm.runInNewContext(source + '\n({ createDragPlanner, planMove })', {
    ...hex, ...search, ...attachments, ...hiddenPlacement, performance,
    layoutCell: args => { rebuilds++; return layoutCell(args); },
  });
  const kids = new Map([['root', []]]), saved = {}, hidden = new Set();
  for (let group = 0; group < 6; group++) {
    const head = `stream-${group}`;
    kids.get('root').push({ id: head, parentId: 'root', kind: 'workstream' });
    kids.set(head, []);
    saved[head] = { q: group * 24, r: 0 };
    for (let item = 0; item < 60; item++) {
      const id = `${head}-work-${item}`;
      const closed = item >= 8;
      kids.get(head).push({ id, parentId: head, kind: 'work', status: closed ? 'closed' : 'open' });
      saved[id] = { q: group * 24 + (item + 1) % 8, r: Math.floor((item + 1) / 8) };
      if (closed) hidden.add(id);
    }
  }
  const args = { kids, rootId: 'root', saved, hidden, yieldIds: hidden, id: 'stream-0' };
  args.layout = layoutCell(args);
  assert.equal(args.layout.order.length, 366);
  assert.equal(hidden.size, 312);
  const preview = planner.createDragPlanner(args, { previewOnly: true });
  for (let q = 200; q < 220; q++) assert.equal(preview({ q, r: 0 }).ok, true);
  assert.equal(rebuilds, 0, 'hidden closed work must not trigger full layout validation during movement');
  const shown = preview({ q: 220, r: 0 });
  const dropped = planner.planMove({ ...args, target: shown.target });
  assert.equal(dropped.ok, true, dropped.reason);
  assert.deepEqual(dropped.moves, shown.moves);
  assert.ok(rebuilds > 0);
  assert.equal(dropped.positions['stream-0-work-59'].q, saved['stream-0-work-59'].q + 220);
});
