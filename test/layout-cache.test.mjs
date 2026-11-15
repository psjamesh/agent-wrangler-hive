import * as hiddenPlacement from '../public/hidden-placement.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as growth from '../public/region-growth.js';
import * as attachments from '../public/region-attachments.js';
import * as hex from '../public/hex-layout.js';
import * as patch from '../public/hex-growth.js';
import * as search from '../public/hex-search.js';
import { syntheticCell } from '../benchmarks/layout-cell.mjs';

const source = name => fs.readFileSync(new URL(`../public/${name}.js`, import.meta.url), 'utf8').replace(/^import .*;\n/gm, '').replace(/^export \{.*;\n/gm, '').replaceAll('export function', 'function').replaceAll('export const', 'const');
function cachedLayout() {
  let calls = 0;
  const layout = vm.runInNewContext(`${source('cell-layout')}\nlayoutCell`, {
    ...growth, ...attachments, ...hex, ...patch, ...search, ...hiddenPlacement,
    attachmentState: (...args) => { calls++; return attachments.attachmentState(...args); },
    growAttachedRegion: args => { calls++; return growth.growAttachedRegion(args); },
  });
  return { layout, calls: () => calls };
}
const small = () => {
  const input = syntheticCell('cache-root');
  for (const list of input.kids.values()) if (list[0]?.kind === 'work') list.splice(2);
  return input;
};

test('cold and added-bead layouts match the original exhaustive full layout', () => {
  const expected = JSON.parse(fs.readFileSync(new URL('./fixtures/layout-growth-positions.json', import.meta.url)));
  const { layout } = cachedLayout(), input = syntheticCell('equivalence-root');
  const points = result => result.order.map(id => [result.positions[id].q, result.positions[id].r]);
  assert.equal(JSON.stringify(points(layout(input))), JSON.stringify(expected.cold));
  const parent = `${input.rootId}-stream-1-nested-1`;
  input.kids.get(parent).push({ id: `${parent}-new`, parentId: parent, kind: 'work', createdAt: '2026-11-02' });
  const changed = layout(input);
  assert.equal(JSON.stringify(points(changed)), JSON.stringify(expected.structural));
  const full = cachedLayout().layout(input);
  assert.equal(JSON.stringify(changed), JSON.stringify(full));
});

test('open boundary growth stops checking attachments after the preferred valid placement', () => {
  let checks = 0;
  const grow = vm.runInNewContext(`${source('region-growth')}\ngrowAttachedRegion`, {
    ...hex, ...search, ...attachments,
    preservesAttachments: (...args) => { checks++; return attachments.preservesAttachments(...args); },
  });
  const positions = { parent: { q: 0, r: 0 }, child: { q: 1, r: 0 } };
  const layout = { positions, order: ['parent', 'child', 'new', 'next'], groupHeads: ['parent', 'child'], regionParents: { parent: null, child: 'parent' }, parentHead: { parent: 'parent', child: 'child', new: 'parent', next: 'parent' } };
  grow({ members: ['parent', 'new', 'next'], todo: ['new', 'next'], layout, kids: new Map([['parent', [{ id: 'child' }, { id: 'new' }, { id: 'next' }]]]), taken: new Set(['0,0', '1,0']), aspect: 1.6, carried: {}, automatic: new Set(), hidden: new Set() });
  assert.equal(checks, 2, 'only the first valid candidate per bead needs a full attachment check');
  assert.equal(attachments.attachmentState(layout, new Map()).attachments.child.status, 'direct');
});

test('candidate checks reuse subtree membership from their attachment baseline', () => {
  let reads = 0;
  class Children extends Map {
    get(id) { reads++; return super.get(id); }
  }
  const kids = new Children([['parent', [{ id: 'child' }, { id: 'new' }]]]);
  const positions = { parent: { q: 0, r: 0 }, child: { q: 1, r: 0 } };
  const layout = { positions, order: ['parent', 'child', 'new'], groupHeads: ['parent', 'child'], regionParents: { parent: null, child: 'parent' }, parentHead: { parent: 'parent', child: 'child', new: 'parent' } };
  const baseline = attachments.attachmentState(layout, kids);
  reads = 0;
  for (let i = 0; i < 10; i++) {
    assert.equal(attachments.preservesAttachments(layout, kids, { ...positions, new: { q: -1, r: 0 } }, new Set(), null, new Set(), baseline), true);
  }
  assert.equal(reads, 0, 'the hierarchy is unchanged between candidates');
});

test('growth in one family does not traverse unrelated workstreams', () => {
  const reads = [];
  class Children extends Map {
    get(id) { reads.push(id); return super.get(id); }
  }
  const kids = new Children([['parent', [{ id: 'child' }, { id: 'new' }]], ['other', [{ id: 'other-child' }]]]);
  const positions = { parent: { q: 0, r: 0 }, child: { q: 1, r: 0 }, other: { q: 100, r: 100 }, 'other-child': { q: 101, r: 100 } };
  const layout = { positions, order: ['parent', 'child', 'new', 'other', 'other-child'], groupHeads: ['parent', 'child', 'other', 'other-child'], regionParents: { parent: null, child: 'parent', other: null, 'other-child': 'other' }, parentHead: { parent: 'parent', child: 'child', new: 'parent', other: 'other', 'other-child': 'other-child' } };
  growth.growAttachedRegion({ members: ['parent', 'new'], todo: ['new'], layout, kids, taken: new Set(['0,0', '1,0', '100,100', '101,100']), aspect: 1.6, carried: {}, automatic: new Set(), hidden: new Set() });
  assert.equal(reads.some(id => id.startsWith('other')), false);
  assert.equal(attachments.attachmentState(layout, kids).attachments['other-child'].status, 'direct');
});

test('standalone workstreams need no subtree traversal for attachments', () => {
  let reads = 0;
  class Children extends Map {
    get(id) { reads++; return super.get(id); }
  }
  const layout = { positions: { only: { q: 0, r: 0 } }, order: ['only'], groupHeads: ['only'], regionParents: { only: null }, parentHead: { only: 'only' } };
  assert.deepEqual(attachments.attachmentState(layout, new Children()).attachments, {});
  assert.equal(reads, 0);
});

test('unchanged value inputs reuse automatic placements across pushes and thread renders', () => {
  const { layout, calls } = cachedLayout(), input = small();
  const first = layout(input), count = calls();
  const next = layout({ ...input, kids: new Map([...input.kids].map(([id, list]) => [id, list.map(b => ({ ...b, title: 'new title', status: 'in_progress' }))])), saved: structuredClone(input.saved) });
  assert.equal(calls(), count, 'unchanged map must not grow its unsaved beads again');
  assert.equal(JSON.stringify(next.positions), JSON.stringify(first.positions));
  first.positions[first.order[0]].q = 999;
  first.order.length = 0;
  first.detachedPinned.add('poison');
  const fresh = layout(input);
  assert.equal(fresh.order.length, next.order.length);
  assert.equal(JSON.stringify(fresh.positions), JSON.stringify(next.positions));
  assert.equal(fresh.detachedPinned.has('poison'), false);
});

test('cache invalidates on every geometry input, including in-place saved moves', () => {
  const { layout, calls } = cachedLayout(), input = small();
  layout(input);
  const invalidate = change => {
    const before = calls();
    change();
    const result = layout(input);
    assert.ok(calls() > before, 'changed map must grow again');
    return result;
  };
  const head = Object.keys(input.saved)[0];
  const moved = invalidate(() => { input.saved[head].q = 70; });
  assert.equal(moved.positions[head].q, 70);
  invalidate(() => { input.aspect = 2; });
  invalidate(() => { input.yieldIds = new Set([head]); });
  invalidate(() => { input.hidden = new Set([head]); });
  invalidate(() => { input.detachedPinned = new Set([head]); });
  invalidate(() => { input.snapshotComplete = false; });
  invalidate(() => { input.fallback = true; });
  input.fallback = false;
  layout(input);
  const list = [...input.kids.values()].find(list => list[0]?.kind === 'work');
  invalidate(() => { list[0].createdAt = '2026-10-01'; });
  invalidate(() => { list[0].kind = 'workstream'; });
  invalidate(() => { list[0].id += '-new'; });
  const entry = [...input.kids].find(([, children]) => children === list);
  invalidate(() => { input.kids.delete(entry[0]); input.kids.set('other-parent', list); });
});

test('growth passes one attachment baseline for all candidates of each placement', () => {
  const baselines = [], before = [];
  const grow = vm.runInNewContext(`${source('region-growth')}\ngrowAttachedRegion`, {
    ...hex, ...search, ...attachments,
    attachmentState: (...args) => { const state = attachments.attachmentState(...args); before.push(state); return state; },
    preservesAttachments: (...args) => { baselines.push(args[6]); return true; },
  });
  const positions = { parent: { q: 0, r: 0 }, child: { q: 1, r: 0 } };
  const layout = { positions, order: ['parent', 'child', 'new', 'next'], groupHeads: ['parent', 'child'], regionParents: { parent: null, child: 'parent' }, parentHead: { parent: 'parent', child: 'child', new: 'parent', next: 'parent' } };
  grow({ members: ['parent', 'new', 'next'], todo: ['new', 'next'], layout, kids: new Map([['parent', [{ id: 'child' }, { id: 'new' }, { id: 'next' }]]]), taken: new Set(['0,0', '1,0']), aspect: 1.6, carried: {}, automatic: new Set(), hidden: new Set() });
  assert.ok(baselines.length >= 2);
  assert.equal(before.length, 2, 'one baseline per bead placement');
  assert.ok(baselines.every(state => state && before.includes(state)));
  assert.equal(new Set(baselines).size, 2);
});

test('visible and hidden layouts remain cached independently', () => {
  const { layout, calls } = cachedLayout(), input = small();
  const visible = layout(input);
  const hidden = new Set([visible.order.at(-1)]);
  layout({ ...input, hidden, yieldIds: hidden });
  const count = calls();
  const rerendered = layout(input);
  layout({ ...input, hidden: new Set(hidden), yieldIds: new Set(hidden) });
  assert.equal(calls(), count);
  assert.equal(JSON.stringify(rerendered.positions), JSON.stringify(visible.positions));
  layout({ ...input, rootId: [...input.kids.keys()][1] });
  assert.ok(calls() > count, 'changing roots must invalidate');
});

test('an unsaved child workstream reuses its attachment-search baseline', () => {
  const baselines = [], states = [];
  const grow = vm.runInNewContext(`${source('region-growth')}\ngrowAttachedRegion`, {
    ...hex, ...search, ...attachments,
    attachmentState: (...args) => { const state = attachments.attachmentState(...args); states.push(state); return state; },
    preservesAttachments: (...args) => { baselines.push(args[6]); return true; },
  });
  const positions = { parent: { q: 0, r: 0 } };
  const layout = { positions, order: ['parent', 'child'], groupHeads: ['parent', 'child'], regionParents: { parent: null, child: 'parent' }, parentHead: { parent: 'parent', child: 'child' } };
  grow({ members: ['child'], todo: ['child'], layout, kids: new Map([['parent', [{ id: 'child' }]]]), taken: new Set(['0,0']), aspect: 1.6, carried: {}, automatic: new Set(), hidden: new Set() });
  assert.ok(baselines.length > 1);
  assert.equal(states.length, 1);
  assert.ok(baselines.every(state => state === states[0]));
});
