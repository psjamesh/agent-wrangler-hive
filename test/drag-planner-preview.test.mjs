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
  const drop = preview.drop({ q: 20, r: 0 });
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
  const dropped = preview.drop({ q: 220, r: 0 });
  assert.equal(dropped.ok, true, dropped.reason);
  assert.deepEqual(dropped.moves, shown.moves);
  assert.ok(rebuilds > 0);
  assert.equal(dropped.positions['stream-0-work-59'].q, saved['stream-0-work-59'].q + 220);
});

function nestedFixture() {
  const kids = new Map([
    ['root', [{ id: 'parent', parentId: 'root', kind: 'workstream' }]],
    ['parent', [{ id: 'anchor', parentId: 'parent', kind: 'work' }, { id: 'child', parentId: 'parent', kind: 'workstream' }]],
    ['child', [{ id: 'work', parentId: 'child', kind: 'work' }, { id: 'done', parentId: 'child', kind: 'work', status: 'closed' }]],
  ]);
  const saved = { parent: { q: 0, r: 0 }, anchor: { q: 1, r: 0 }, child: { q: 2, r: 0 }, work: { q: 3, r: 0 }, done: { q: 3, r: -1 } };
  const hidden = new Set(['done']);
  const args = { kids, rootId: 'root', saved, hidden, yieldIds: hidden, id: 'child' };
  return { ...args, layout: layoutCell(args) };
}

function instrumentedPlanner({ refuseFirst = false } = {}) {
  const calls = [];
  const module = vm.runInNewContext(source + `
    const originalPlan = planMove, originalBatch = pinBatch;
    pinBatch = args => refuseFirst && calls.length === 1 ? null : originalBatch(args);
    planMove = args => {
      calls.push(args);
      return originalPlan(args);
    };
    ({ createDragPlanner, planMove });`, {
    ...hex, ...search, ...attachments, ...hiddenPlacement, performance, layoutCell, calls, refuseFirst,
  });
  return { ...module, calls };
}

test('nested snapped drop uses the prepared attachment context and saves hidden carried positions', () => {
  const f = nestedFixture(), module = instrumentedPlanner();
  const planner = module.createDragPlanner(f, { previewOnly: true, budgetMs: Infinity });
  const target = { q: 0, r: 0 }, shown = planner(target);
  assert.equal(shown.ok, true);
  assert.equal(shown.snapped, true);
  assert.equal(module.calls.length, 0);
  const dropped = planner.drop(target);
  assert.equal(dropped.ok, true);
  assert.deepEqual(dropped.target, shown.target);
  assert.ok(module.calls[0].attachmentBaseline);
  assert.equal(typeof module.calls[0].dragContext.check, 'function');
  const expected = module.planMove({ ...f, target: shown.target });
  assert.deepEqual(dropped.positions, expected.positions);
  assert.ok(dropped.positions.done);
});

test('nested snapped drop tries the next ranked candidate after saved-layout validation refuses the first', () => {
  const f = nestedFixture(), module = instrumentedPlanner({ refuseFirst: true });
  const planner = module.createDragPlanner(f, { previewOnly: true, budgetMs: Infinity });
  const target = { q: 0, r: 0 }, shown = planner(target);
  assert.equal(shown.ok, true);
  assert.equal(shown.snapped, true);
  const dropped = planner.drop(target);
  assert.equal(dropped.ok, true, dropped.reason);
  assert.ok(module.calls.length >= 2);
  assert.notEqual(hex.key(dropped.target), hex.key(shown.target));
  assert.equal(module.calls[0].attachmentBaseline, module.calls[1].attachmentBaseline);
  assert.equal(module.calls[0].dragContext, module.calls[1].dragContext);
});

test('single-bead preview defers saved-layout planning until its drop resolver', () => {
  const f = nestedFixture(), module = instrumentedPlanner();
  f.id = 'work';
  const planner = module.createDragPlanner(f, { previewOnly: true });
  const target = { q: 2, r: 1 }, shown = planner(target);
  assert.equal(shown.ok, true, shown.reason);
  assert.equal(module.calls.length, 0);
  const dropped = planner.drop(target);
  assert.equal(module.calls.length, 1);
  assert.deepEqual(dropped.positions, module.planMove({ ...f, target }).positions);
});

test('an exact nested drop refusal does not silently move to another attached candidate', () => {
  const f = nestedFixture(), module = instrumentedPlanner({ refuseFirst: true });
  const planner = module.createDragPlanner(f, { previewOnly: true });
  const target = { q: 0, r: 1 }, shown = planner(target);
  assert.equal(shown.ok, true, shown.reason);
  assert.equal(Boolean(shown.snapped), false);
  const dropped = planner.drop(target);
  assert.equal(dropped.ok, false);
  assert.equal(module.calls.length, 1);
});
