import * as hiddenPlacement from '../public/hidden-placement.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as hex from '../public/hex-layout.js';
import * as search from '../public/hex-search.js';
import * as attachments from '../public/region-attachments.js';

const source = fs.readFileSync(new URL('../public/region-growth.js', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '').replaceAll('export function', 'function');
const grow = vm.runInNewContext(`${source}\ngrowAttachedRegion`, { ...hex, ...search, ...attachments, preservesAttachments: () => false });

test('an exhausted attachment frontier places new work without moving existing tiles', () => {
  const positions = { parent: { q: 0, r: 0 }, child: { q: 1, r: 0 } };
  const taken = new Set(Object.values(positions).map(hex.key));
  const layout = { positions, order: ['parent', 'child', 'new'], regionParents: { parent: null, child: 'parent' }, groupHeads: ['parent', 'child'], parentHead: { parent: 'parent', child: 'child', new: 'parent' } };
  const kids = new Map([['parent', [{ id: 'child' }, { id: 'new' }]]]);
  assert.equal(grow({ members: ['parent', 'new'], todo: ['new'], layout, kids, taken, aspect: 1.1, carried: {}, automatic: new Set(), hidden: new Set() }), true);
  assert.deepEqual(positions.parent, { q: 0, r: 0 });
  assert.deepEqual(positions.child, { q: 1, r: 0 });
  assert.ok(search.inRange(positions.new));
  assert.equal(new Set(Object.values(positions).map(hex.key)).size, 3);
});

test('a new workstream with no valid attachment still receives free geometry', () => {
  const positions = { parent: { q: 0, r: 0 } };
  const layout = { positions, order: ['parent', 'child'], regionParents: { parent: null, child: 'parent' }, groupHeads: ['parent', 'child'], parentHead: { parent: 'parent', child: 'child' } };
  const kids = new Map([['parent', [{ id: 'child' }]]]);
  assert.equal(grow({ members: ['child'], todo: ['child'], layout, kids, taken: new Set(['0,0']), aspect: 1.1, carried: {}, automatic: new Set(), hidden: new Set() }), true);
  assert.ok(search.inRange(positions.child));
  assert.notEqual(hex.key(positions.child), '0,0');
});

const projectionSource = fs.readFileSync(new URL('../server/projection.js', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '').replaceAll('export function', 'function');
const dependencies = Object.assign({}, ...await Promise.all(['../server/admission.js', '../server/review-state.js', '../server/bead-detail.js', '../server/tracking.js', '../public/cell-layout.js', '../public/layout-base.js', '../server/bead-model.js', '../server/beads.js', '../public/archive-layout.js', '../server/conversation.js', '../server/requests.js', '../server/waiting.js', '../public/legacy-cell-layout.js'].map(p => import(p))));

test('a per-cell layout error yields fallback geometry and does not break the board', () => {
  const project = vm.runInNewContext(`${projectionSource}\nprojectForGraph`, { ...dependencies, layoutCell: args => {
    if (args.rootId === 'root' && !args.fallback) throw new Error('injected layout failure');
    return dependencies.layoutCell(args);
  } });
  const beads = { root: { id: 'root' }, work: { id: 'work', parentId: 'root', status: 'open' }, other: { id: 'other' } };
  const doc = { cells: { broken: { id: 'broken', rootBeadId: 'root', enabled: true }, healthy: { id: 'healthy', rootBeadId: 'other', enabled: true } }, beadLayout: { broken: { work: { q: 2, r: 3 } } }, arrangeAspect: {}, archived: {}, bindings: {}, restoreNotices: {}, conversation: {}, threads: {}, inbox: {}, operations: {}, launches: {} };
  const warnings = [];
  const runtime = { metadata: { read: () => doc, cells: () => Object.values(doc.cells) }, beads: { status: {} }, paths: {}, log: message => warnings.push(message) };
  const result = project({ runtime, snapshot: { graph: { beads, edges: [] } } });
  assert.equal(Object.keys(result.cells).length, 2);
  assert.equal(result.cells.broken.beadLayout.work.q, 2);
  assert.equal(result.cells.broken.beadLayout.work.r, 3);
  assert.match(result.cells.broken.layoutWarning, /injected layout failure/);
  assert.ok(warnings.some(message => message.includes('broken') && message.includes('injected layout failure')));
  assert.equal(result.cells.healthy.layoutWarning, undefined);
});

function enclosed(center = 0) {
  const beads = { root: { id: 'root' }, parent: { id: 'parent', parentId: 'root', kind: 'workstream' }, child: { id: 'child', parentId: 'parent', kind: 'workstream' }, new: { id: 'new', parentId: 'child' } };
  const saved = { child: { q: center, r: 0 } };
  let i = 0;
  for (let q = -2; q <= 2; q++) for (let r = -2; r <= 2; r++) {
    const radius = search.span({ q, r });
    if (radius === 2) {
      const id = i++ ? `parent-${i}` : 'parent';
      beads[id] ||= { id, parentId: 'parent' };
      saved[id] = { q: q + center, r };
    } else if (radius === 1) {
      const id = `child-${i++}`;
      beads[id] = { id, parentId: 'child' };
      saved[id] = { q: q + center, r };
    }
  }
  return { beads, saved };
}

test('a nested region enclosed by its own parent can grow beyond the enclosure', async () => {
  const { layoutCell } = await import('../public/cell-layout.js');
  const { activeKids } = await import('../public/archive-layout.js');
  const { beads, saved } = enclosed();
  const result = layoutCell({ kids: activeKids(beads), rootId: 'root', saved });
  for (const [id, p] of Object.entries(saved)) assert.deepEqual(result.positions[id], p);
  assert.equal(new Set(Object.values(result.positions).map(hex.key)).size, result.order.length);
  assert.ok(search.inRange(result.positions.new));
  assert.ok(search.span(result.positions.new) > 2);
});

test('detached growth stays bounded at the coordinate edge', async () => {
  const { layoutCell } = await import('../public/cell-layout.js');
  const { activeKids } = await import('../public/archive-layout.js');
  const { beads, saved } = enclosed(search.MAX_COORD - 2);
  const result = layoutCell({ kids: activeKids(beads), rootId: 'root', saved, aspect: 2 });
  assert.ok(search.inRange(result.positions.new), JSON.stringify(result.positions.new));
  for (const [id, p] of Object.entries(saved)) assert.deepEqual(result.positions[id], p);
});

test('projection fallback preserves canonical positions and accepts a browser move', async () => {
  const { moveBeads } = await import('../server/ops.js');
  const { layoutBase } = await import('../public/layout-base.js');
  const project = vm.runInNewContext(`${projectionSource}\nprojectForGraph`, { ...dependencies, layoutCell: args => {
    if (!args.fallback) throw new Error('injected failure');
    return dependencies.layoutCell(args);
  } });
  const beads = { root: { id: 'root' }, parent: { id: 'parent', parentId: 'root', kind: 'workstream' }, new: { id: 'new', parentId: 'parent' } };
  const saved = { parent: { q: 0, r: 0 } };
  for (let i = 0; i < 6; i++) {
    beads[`loose-${i}`] = { id: `loose-${i}`, parentId: 'root' };
    saved[`loose-${i}`] = hex.neighbour(saved.parent, i);
  }
  let doc = { cells: { cell: { id: 'cell', rootBeadId: 'root', enabled: true } }, beadLayout: { cell: saved }, arrangeAspect: {}, archived: {}, bindings: {}, restoreNotices: {}, conversation: {}, threads: {}, inbox: {}, operations: {}, launches: {} };
  const metadata = { read: () => doc, cells: () => Object.values(doc.cells), cell: id => doc.cells[id], mutate: fn => { doc = structuredClone(doc); fn(doc); } };
  const runtime = { metadata, snapshots: { hierarchyCurrent: true, graph: { beads } }, beads: { status: {} }, paths: {}, log() {} };
  const result = project({ runtime, snapshot: { graph: { beads, edges: [] } } });
  const cell = result.cells.cell;
  const base = layoutBase({ beads, rootId: 'root', saved: cell.beadLayout });
  assert.doesNotThrow(() => moveBeads(runtime, { cellId: 'cell', positions: { new: { q: 4, r: 0 } }, base }));
  assert.equal(cell.beadLayout.parent.q, 0);
  assert.equal(cell.beadLayout.new, undefined);
  const shown = dependencies.layoutCell({ kids: dependencies.activeKids(beads), rootId: 'root', saved: cell.beadLayout, fallback: Boolean(cell.layoutWarning) });
  for (const [id, pos] of Object.entries(saved)) assert.deepEqual(shown.positions[id], pos);
});

test('fallback mode survives move, hide and reveal planner recalculations', () => {
  const moveSource = fs.readFileSync(new URL('../public/cell-move.js', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '').replaceAll('export function', 'function').replaceAll('export const', 'const');
  const calls = [];
  const planners = vm.runInNewContext(`${moveSource}\n({ planMove, planHide, planReveal })`, { ...hex, ...search, ...attachments, ...hiddenPlacement, performance, layoutCell: args => {
    calls.push(args.fallback);
    if (!args.fallback) throw new Error('injected persistent layout failure');
    return dependencies.layoutCell(args);
  } });
  const beads = { root: { id: 'root' }, parent: { id: 'parent', parentId: 'root', kind: 'workstream' }, new: { id: 'new', parentId: 'parent', status: 'closed' } };
  const saved = { parent: { q: 0, r: 0 } };
  for (let i = 0; i < 6; i++) {
    beads[`loose-${i}`] = { id: `loose-${i}`, parentId: 'root' };
    saved[`loose-${i}`] = hex.neighbour(saved.parent, i);
  }
  const kids = dependencies.activeKids(beads);
  const layout = dependencies.layoutCell({ kids, rootId: 'root', saved, fallback: true });
  const args = { layout, kids, rootId: 'root', saved };
  const moved = planners.planMove({ ...args, id: 'loose-0', target: { q: 5, r: 5 } });
  assert.ok(moved.ok);
  const round = dependencies.layoutCell({ kids, rootId: 'root', saved: { ...saved, ...moved.positions }, fallback: layout.fallback });
  for (const id of layout.order) assert.equal(hex.key(round.positions[id]), hex.key(moved.moves[id] || layout.positions[id]));
  const hidden = new Set(['new']), yieldIds = new Set(['new']);
  assert.ok(planners.planHide({ ...args, hidden, yieldIds }).ok);
  assert.ok(planners.planReveal({ ...args, headId: 'parent', back: hidden, hidden, yieldIds }).ok);
  assert.ok(calls.length >= 2);
  assert.ok(calls.every(Boolean));
  assert.equal(layout.fallback, true);
});
