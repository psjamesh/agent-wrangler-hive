import { subtreeMembers } from '../public/region-attachments.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { layoutCell, groupOutlines, workstreamClasses } from '../public/cell-layout.js';
import { archiveHidden, activeKids } from '../public/archive-layout.js';
import { membersOf, previewMove, planMove, planGroupArrange, planReveal, createDragPlanner, planHide } from '../public/cell-move.js';
import { layoutBase, stackable } from '../public/layout-base.js';
import { hiddenWork } from '../public/region-visibility.js';
import { mapInputs } from '../public/view-inputs.js';
import { relationsFor, describeRelations } from '../public/cell-view.js';
import { toPixel, pixelBounds, key, normalAspect } from '../public/hex-layout.js';

import * as movePlanners from '../public/cell-move.js';
const planHiveReveal = movePlanners.planHiveReveal;

const source = fs.readFileSync(new URL('../public/hive-view.js', import.meta.url), 'utf8');
const start = source.indexOf('function cellMap(');
const conversationSource = fs.readFileSync(new URL('../public/conversation.js', import.meta.url), 'utf8');
const relatedCode = conversationSource.slice(conversationSource.indexOf('export function renderRelatedBeads('), conversationSource.indexOf('export function relatedBeads(')).replace('export ', '');
const code = relatedCode + source.slice(source.indexOf('function placedLayout('), source.indexOf('function focusTile(')) + source.slice(start, source.indexOf('\nexport function renderHive(', start + 1));
function mapFixture({contact=false,enclosed=false,hiveHidingStart=true,related=null,cached=false}={}) {
  const beads = Object.fromEntries([
    ['root', null, 'goal'], ['parent', 'root', 'workstream'], ['a', 'parent', 'work'], ['child', 'parent', 'workstream'], ['b', 'child', 'work'], ['block', 'root', 'work'],
  ].map(([id, parentId, kind]) => [id, { id, parentId, kind, status: id === 'b' ? 'closed' : 'open', title: id }]));
  const saved = { parent: { q: 20, r: 0 }, a: { q: 21, r: 0 }, child: { q: 0, r: 0 }, b: { q: 1, r: 0 }, block: { q: 1, r: 0 } };
  if(contact) {
    Object.assign(saved,{parent:{q:0,r:0},a:{q:1,r:0},child:{q:2,r:0},b:{q:3,r:0},block:{q:30,r:0}});
    beads.a.status='closed';beads.b.status='open';
  }
  if (enclosed) {
    Object.assign(saved, { parent: { q:0,r:0 }, a: { q:1,r:0 }, child: { q:2,r:0 }, b: { q:2,r:1 }, block: { q:30,r:1 } });
    beads.a.status = 'closed'; beads.b.status = 'open';
    const own = new Set(Object.values(saved).map(key));
    for (let q=-4;q<=4;q++) for(let r=-4;r<=4;r++) {
      if(Math.max(Math.abs(q),Math.abs(r),Math.abs(q+r))>4 || own.has(`${q},${r}`)) continue;
      const id=`wall_${q}_${r}`; beads[id]={id,parentId:'root',kind:'work',status:'open'}; saved[id]={q,r};
    }
  }
  const cell = { id: 'cell', rootBeadId: 'root', beadLayout: saved, enabled: true };
  const form = { cellId: 'cell', headId: contact?'parent':'child', at: { x: 0, y: 0 } };
  if (cached) for (const k of Object.keys(form)) delete form[k];
  const sent = [], callbacks=[], located=[];
  let detached = new Set(), hiveHiding = hiveHidingStart;
  const ctx = {
    hive: { beads, cells: { cell }, edges: [] }, busy: () => false, notice: () => {},
    ui: {
      cellId: () => cell.id, pane: () => 'conversation',
      hideDoneForHive: () => hiveHiding, setHideDoneForHive: (cellId, on) => { hiveHiding = on; },
      detachedRegions: () => detached, setDetachedRegions: (cellId, ids) => { detached = new Set(ids); },
      placements: () => [], selectedBeadId: () => null,
      form: (name) => name === 'wsMenu' && Object.keys(form).length ? form : null,
      setForm: (name, next) => { if (name === 'wsMenu') { for (const k of Object.keys(form)) delete form[k]; if (next) Object.assign(form, next); } },
      sendPlacement: (msg,placement,options) => {sent.push(msg);callbacks.push(options?.onSaved);},
    },
  };
  let options, menu;
  let mapRenders = 0;
  let tileNodes = [];
  const element = { classList: { add() {} }, addEventListener() {}, querySelectorAll: () => tileNodes };
  const sandbox = {
    mapInputs, hiveViews: new WeakMap(), automaticPlacements: new WeakMap(), cellPanels: () => ({ header: [], related: null }),
    syncChildren: (el, children) => {
      for (const child of el.children || []) if (child && !children.includes(child)) child.parentNode = null;
      el.children = children;
      for (const child of children) if (child) child.parentNode = el;
      return el;
    },
    bindMapSearch() {}, searchReveals: () => false,
    ctx, cell, related, BEAD_SIZE: 60, BACK_EDGE: 48, layoutCell, groupOutlines, workstreamClasses,
    archiveHidden, activeKids, membersOf, subtreeMembers, previewMove, planMove, planGroupArrange, planReveal, createDragPlanner, planHide, planHiveReveal,
    layoutBase, stackable, hiddenWork, toPixel, pixelBounds, key, normalAspect,
    beadTile: (ctx, bead, tile) => ({ id: bead.id, ...tile }), relationsFor, describeRelations,
    h: (...args) => Object.assign(args, { querySelector: () => element }), renderHexMap: (o) => {
      mapRenders++;
      options = o;
      tileNodes = o.items.map(it => {
        const classes = new Set((it.classes || '').split(' '));
        return { dataset: { tileId: it.id }, attributes: { 'aria-label': it.ariaLabel },
          classList: { contains: name => classes.has(name), toggle: (name, on) => on ? classes.add(name) : classes.delete(name) },
          setAttribute(name, value) { this.attributes[name] = value; } };
      });
      return { el: element };
    },
    workstreamMenu: (o) => { menu = o; return []; }, groupClosed: () => false,
    focusTile(id) { located.push(id); }, revealWarning: () => 'Move this region?',
    document: { querySelector: () => null },
  };
  const renderCode = source.slice(source.indexOf('export function renderHive('), source.indexOf('\nexport function disposeHiveView')).replace('export ', '');
  const call = cached ? 'renderHive(ctx);' : 'cellMap(ctx, cell, related);';
  vm.runInNewContext(`${code}\n${renderCode}\n${call}`, sandbox);
  const hiveToggle = () => options.overlay.flat(Infinity).find((item) => item?.['data-focus-key'] === 'hide-done:cell');
  return { element, hiveToggle, saved, beads, cell, ctx, located, tileNodes: () => tileNodes, mapRenders: () => mapRenders, detached: () => detached, options: () => options, menu: () => menu, form, sent, callbacks, render: () => vm.runInNewContext(call, sandbox) };
}

test('map relations ignore hidden done prerequisites and dependents and restore them on Show done', () => {
  const f = mapFixture();
  f.ctx.hive.edges = [
    { prerequisite: 'b', dependent: 'a', blocking: true },
    { prerequisite: 'block', dependent: 'a', blocking: true },
    { prerequisite: 'a', dependent: 'b', blocking: true },
  ];
  f.render();
  assert.deepEqual(f.options().relations.get('a'), { prereq: ['block'], dependents: [], outside: 0 });
  assert.equal(f.options().relations.has('b'), false);
  assert.equal(f.options().describe('a'), 'a. needed first: block.');
  f.ctx.ui.setHideDoneForHive('cell', false);
  f.render();
  assert.deepEqual(f.options().relations.get('a'), { prereq: ['b', 'block'], dependents: ['b'], outside: 0 });
  assert.match(f.options().describe('a'), /needed first: b; block/);
});

test('hidden-only map links leave both relation bands empty', () => {
  const f = mapFixture();
  f.ctx.hive.edges = [{ prerequisite: 'b', dependent: 'a', blocking: true }];
  f.render();
  assert.deepEqual(f.options().relations.get('a'), { prereq: [], dependents: [], outside: 0 });
  assert.match(f.options().describe('a'), /Nothing it needs first or that waits on it/);
});

test('hidden endpoints never become outside links while real cross-hive links remain', () => {
  const hive = { beads: { a: { title: 'Visible' }, done: { title: 'Hidden' } }, edges: [
    { prerequisite: 'done', dependent: 'a', blocking: true },
    { prerequisite: 'a', dependent: 'done', blocking: true },
    { prerequisite: 'remote', dependent: 'a', blocking: true },
  ] };
  const rel = relationsFor(hive, ['a'], new Set(['done']));
  assert.deepEqual(rel.get('a'), { prereq: [], dependents: [], outside: 1 });
  assert.doesNotMatch(describeRelations(hive, rel, 'a'), /Hidden/);
  assert.match(describeRelations(hive, rel, 'a'), /1 blocking link to work in another hive/);
});

test('map drag preview carries all descendant regions and their outlines', () => {
  const f = mapFixture();
  const drag = f.options().dragGroup('parent');
  assert.deepEqual(Array.from(drag.ids).sort(), ['a','b','child','parent']);
  assert.deepEqual(Array.from(drag.outlines), ['parent','child']);
  const child = f.options().dragGroup('child');
  assert.deepEqual(Array.from(child.ids), ['child', 'b']);
  assert.deepEqual(Array.from(child.outlines),['child']);
  assert.deepEqual(Array.from(f.options().outlines, (o) => o.headId), ['parent', 'child']);
});

test('pointer preview and drop save the same snapped subtree, while keyboard remains exact', () => {
  const f=mapFixture();
  f.options().onDragStart('child');
  const target={q:1,r:0};
  const preview=f.options().movePreview('child',target);
  assert.equal(preview.ok,true,preview.reason);
  assert.equal(preview.snapped,true);
  f.options().onMove('child',target);
  assert.equal(f.sent.length,0);
  f.options().onDrop('child',target);
  assert.equal(f.sent.length,1);
  assert.deepEqual(f.sent[0].positions,preview.positions);
});

test('hive hiding a contact saves the smallest child translation before toggling closed work off', () => {
  const f=mapFixture({contact:true,hiveHidingStart:false});
  f.hiveToggle().onclick({ clientX: 10, clientY: 10 });
  assert.equal(f.sent.length,1);
  assert.equal(f.ctx.ui.hideDoneForHive('cell'),false);
  assert.deepEqual(f.sent[0].positions.child,{q:1,r:0});
  assert.deepEqual(f.sent[0].positions.b,{q:2,r:0});
  assert.equal(f.sent[0].positions.parent,undefined);
  assert.ok(f.sent[0].stack.includes('a'));
  f.callbacks[0]();
  assert.equal(f.ctx.ui.hideDoneForHive('cell'),true);
});


test('map rerenders retain a no-fit detached child after unrelated space is freed', () => {
  const f = mapFixture({ enclosed: true });
  assert.equal(f.detached().has('child'), true);
  f.options().onMove('wall_1_-1', { q:30,r:0 });
  assert.equal(f.sent.length, 1);
  Object.assign(f.saved, f.sent[0].positions);
  f.render();
  assert.equal(f.detached().has('child'), true);
  const child = f.options().items.find((tile) => tile.id === 'child');
  assert.deepEqual(child.local, { q:2,r:0 });
  f.options().onMove('child', { q:1,r:-1 });
  assert.equal(f.sent.length, 2);
  Object.assign(f.saved, f.sent[1].positions);
  f.render();
  assert.equal(f.detached().has('child'), false);
});

test('no-fit detachment survives a browser UI restart and is scoped to its cell', () => {
  const source = fs.readFileSync(new URL('../public/client.js', import.meta.url), 'utf8');
  const code = source.slice(source.indexOf('export function createUi'), source.indexOf('function openInspector')).replace('export ', '');
  const storage = new Map();
  const createUi = vm.runInNewContext(`${code}\ncreateUi;`, {
    load: (key, fallback) => storage.get(key) ?? fallback,
    save: (key, value) => storage.set(key, JSON.parse(JSON.stringify(value))), sendPlacement() {}, DRAFT_TEXT_MAX: 50000,
  });
  const first = createUi();
  first.setDetachedRegions('cell', new Set(['child']));
  const restarted = createUi();
  assert.deepEqual(Array.from(restarted.detachedRegions('cell')), ['child']);
  assert.equal(restarted.detachedRegions('other-cell').size, 0);
  restarted.setDetachedRegions('cell', new Set());
  assert.equal(createUi().detachedRegions('cell').size, 0);
});


for (const transition of ['archive', 'partial export']) test(`Detached latch survives ${transition} and recovery`, () => {
  const f = mapFixture({ enclosed:true,hiveHidingStart:true });
  assert.equal(f.detached().has('child'), true);
  if (transition === 'archive') {
    for (const id of ['parent','a','child','b']) Object.assign(f.beads[id], { status:'closed',closedAt:'old' });
    f.cell.archived = { parent: { closedAt:'old',ids:['parent','a','child','b'],positions:Object.fromEntries(['parent','a','child','b'].map((id)=>[id,f.saved[id]])) } };
  } else {
    f.ctx.hive.backend = { snapshotComplete:false,snapshotError:'Incomplete export' };
    delete f.beads.child; delete f.beads.b;
  }
  f.render();
  assert.equal(f.detached().has('child'), true);
  if (transition === 'archive') assert.equal(f.options().items.some((item)=>item.id==='child'), false);
  else assert.equal(f.ctx.hive.backend.snapshotComplete, false);
  f.saved['wall_1_-1'] = { q:30,r:0 };
  if (transition === 'archive') delete f.cell.archived;
  else {
    f.beads.child={id:'child',parentId:'parent',kind:'workstream',status:'open'};
    f.beads.b={id:'b',parentId:'child',kind:'work',status:'open'};
    f.ctx.hive.backend={snapshotComplete:true,snapshotBeadIds:Object.keys(f.beads)};
  }
  f.render();
  assert.equal(f.detached().has('child'), true);
  if (transition === 'archive') {
    assert.equal(f.options().items.some((item)=>item.id==='child'), false);
    f.beads.child.status='open';
    f.render();
  }
  assert.deepEqual(f.options().items.find((item)=>item.id==='child').local,{q:2,r:0});
  f.beads.parent.status='open';
  f.render();
  assert.equal(f.detached().has('child'), true);
});

test('only a complete snapshot confirms deletion of an absent latched region', () => {
  const f = mapFixture({ enclosed:true,hiveHidingStart:true });
  delete f.beads.child; delete f.beads.b;
  f.ctx.hive.backend = { snapshotComplete:false,snapshotError:'Incomplete export',snapshotBeadIds:Object.keys(f.beads) };
  f.render();
  assert.equal(f.detached().has('child'), true);
  f.ctx.hive.backend = { snapshotComplete:true,snapshotBeadIds:Object.keys(f.beads) };
  f.render();
  assert.equal(f.detached().has('child'), false);
});

test('hive toggle hides every region and restores all done work', () => {
  const f = mapFixture({ hiveHidingStart: false });
  f.beads.a.status = 'closed';
  f.beads.child.status = 'closed';
  f.beads.block.status = 'closed';
  f.render();
  assert.equal(typeof f.hiveToggle()?.onclick, 'function');
  f.hiveToggle().onclick({ clientX: 10, clientY: 10 });
  for (const callback of f.callbacks.splice(0)) callback?.();
  f.render();
  assert.deepEqual(Array.from(f.options().items, (item) => item.id), ['parent']);
  assert.equal(f.hiveToggle()['aria-pressed'], 'true');
  f.hiveToggle().onclick({ clientX: 10, clientY: 10 });
  if (f.form.confirm) { f.render(); f.menu().onConfirm(); }
  for (const callback of f.callbacks.splice(0)) callback?.();
  f.render();
  assert.equal(f.hiveToggle()['aria-pressed'], 'false');
  assert.deepEqual(Array.from(f.options().items, (item) => item.id).sort(), ['a', 'b', 'block', 'child', 'parent']);
});

test('hive Hide done preference survives restart and is scoped to the cell', () => {
  const source = fs.readFileSync(new URL('../public/client.js', import.meta.url), 'utf8');
  const code = source.slice(source.indexOf('export function createUi'), source.indexOf('function openInspector')).replace('export ', '');
  const storage = new Map([['hideDone:cell', ['child']]]);
  const state = { uiVersion: 0 };
  const createUi = vm.runInNewContext(`${code}\ncreateUi;`, {
    state, rerender() {}, load: (key, fallback) => storage.get(key) ?? fallback,
    save: (key, value) => storage.set(key, JSON.parse(JSON.stringify(value))), sendPlacement() {}, DRAFT_TEXT_MAX: 50000,
  });
  const first = createUi();
  assert.equal(first.hideDoneForHive('cell'), false);
  first.setHideDoneForHive('cell', true);
  assert.equal(createUi().hideDoneForHive('cell'), true);
  assert.equal(createUi().hideDoneForHive('other'), false);
  first.setHideDoneForHive('cell', false);
  assert.equal(createUi().hideDoneForHive('cell'), false);
  assert.deepEqual(storage.get('hideDone:cell'), ['child']);
});


test('hive reveal confirmation can be cancelled without changing visibility', () => {
  const f = mapFixture({ hiveHidingStart: false });
  f.beads.child.status = 'closed';
  f.render();
  f.hiveToggle().onclick({ clientX: 20, clientY: 20 });
  for (const callback of f.callbacks.splice(0)) callback?.();
  f.render();
  Object.assign(f.form, { cellId: 'cell', headId: 'parent' });
  f.render();
  f.beads.block.status = 'open';
  f.saved.block = { ...f.saved.child };
  f.render();
  f.hiveToggle().onclick({ clientX: 20, clientY: 20 });
  assert.equal(f.form.globalDone, true);
  const sent = f.sent.length;
  f.render();
  f.menu().onClose();
  f.render();
  assert.equal(f.sent.length, sent);
  assert.equal(f.hiveToggle()['aria-pressed'], 'true');
});

test('conversation relations mark visible tiles and label hidden beads without revealing them', () => {
  const nodes = [];
  const related = { ids: new Set(['a', 'b']), el: { replaceChildren: (...children) => nodes.splice(0, nodes.length, ...children), append: (...children) => nodes.push(...children) } };
  const f = mapFixture({ related });
  const tiles = f.options().items;
  assert.match(tiles.find(t => t.id === 'a').classes, /is-conversation-related/);
  assert.equal(tiles.some(t => t.id === 'b'), false);
  assert.equal(tiles.find(t => t.id === 'parent').classes, undefined);
  assert.match(JSON.stringify(nodes), /b \(hidden by Hide done\)/);
  const chip = nodes.find(node => node[0] === 'button');
  chip[1].onclick({ stopPropagation() {} });
  assert.deepEqual(f.located, ['a']);
  assert.equal(f.options().selectedId, null);
  assert.equal(f.sent.length, 0);
});


test('changing related beads updates rings and chips without rebuilding the map', () => {
  const nodes = [];
  let ids = new Set(['a']);
  const related = { ids, refresh() { this.ids = ids; }, el: { append: (...children) => nodes.push(...children), replaceChildren: (...children) => nodes.splice(0, nodes.length, ...children) } };
  const f = mapFixture({ related });
  const original = f.tileNodes();
  ids = new Set(['parent', 'b']);
  assert.equal(typeof related.el.hiveSelectMessage, 'function');
  related.el.hiveSelectMessage();
  assert.equal(f.mapRenders(), 1);
  assert.equal(f.tileNodes(), original);
  assert.equal(original.find(t => t.dataset.tileId === 'a').classList.contains('is-conversation-related'), false);
  assert.equal(original.find(t => t.dataset.tileId === 'parent').classList.contains('is-conversation-related'), true);
  assert.match(original.find(t => t.dataset.tileId === 'parent').attributes['aria-label'], /Related to conversation/);
  assert.match(JSON.stringify(nodes), /b \(hidden by Hide done\)/);
  assert.equal(f.options().items.some(t => t.id === 'b'), false);
  ids = new Set();
  related.el.hiveSelectMessage();
  assert.doesNotMatch(original.find(t => t.dataset.tileId === 'parent').attributes['aria-label'], /Related to conversation/);
  assert.match(JSON.stringify(nodes), /No related beads/);
});

test('a retained map reconnects new conversation relations and clears them on leaving a thread', () => {
  const first = { ids: new Set(['a']), el: { replaceChildren() {} } };
  const f = mapFixture({ related: first });
  const tiles = f.tileNodes();
  const next = { ids: new Set(['parent']), el: { replaceChildren() {} }, refresh() {} };
  f.element.hiveConnectRelated(next);
  assert.equal(f.mapRenders(), 1);
  assert.equal(tiles.find(t => t.dataset.tileId === 'a').classList.contains('is-conversation-related'), false);
  assert.equal(tiles.find(t => t.dataset.tileId === 'parent').classList.contains('is-conversation-related'), true);
  f.element.hiveConnectRelated(null);
  assert.equal(tiles.some(t => t.classList.contains('is-conversation-related')), false);
});

test('hive Hide done removes completed sub-workstream relation markers and Show done restores them', () => {
  const f = mapFixture({ hiveHidingStart: false });
  f.beads.child.status = 'closed';
  f.form.headId = 'parent';
  f.ctx.hive.edges = [
    { prerequisite: 'child', dependent: 'a', blocking: true },
    { prerequisite: 'b', dependent: 'a', blocking: true },
    { prerequisite: 'block', dependent: 'a', blocking: true },
    { prerequisite: 'a', dependent: 'child', blocking: true },
    { prerequisite: 'a', dependent: 'b', blocking: true },
  ];
  const markers = () => {
    const relation = f.options().relations.get('a');
    return { '▲': relation.prereq.length, '▼': relation.dependents.length };
  };
  const toggle = () => {
    f.hiveToggle().onclick({ clientX: 10, clientY: 10 });
    if (f.form.confirm) { f.render(); f.menu().onConfirm(); }
    for (const callback of f.callbacks.splice(0)) callback?.();
    f.render();
  };
  f.render();
  assert.deepEqual(markers(), { '▲': 3, '▼': 2 });
  toggle();
  assert.equal(f.options().items.some(item => item.id === 'child' || item.id === 'b'), false);
  assert.deepEqual(markers(), { '▲': 1, '▼': 0 });
  assert.equal(f.options().relations.has('child'), false);
  assert.equal(f.options().relations.has('b'), false);
  assert.equal(f.options().describe('a'), 'a. needed first: block.');
  toggle();
  assert.deepEqual(markers(), { '▲': 3, '▼': 2 });
  assert.equal(f.options().items.some(item => item.id === 'child'), true);
  assert.equal(f.options().items.some(item => item.id === 'b'), true);
});

test('retained hive map redraws global Hide done and Show done without placement or menu changes', () => {
  const f = mapFixture({ hiveHidingStart: false, cached: true });
  for (const id of ['a', 'child', 'b']) { delete f.beads[id]; delete f.saved[id]; }
  f.beads.parent.status = 'closed';
  f.saved.parent = { q: 0, r: 0 };
  f.saved.block = { q: 10, r: 0 };
  f.render();
  const builds = f.mapRenders();
  f.render();
  assert.equal(f.mapRenders(), builds, 'unchanged maps remain cached');
  assert.equal(f.options().items.some(item => item.id === 'parent'), true);
  f.hiveToggle().onclick({ clientX: 10, clientY: 10 });
  assert.equal(f.ctx.ui.hideDoneForHive('cell'), true);
  assert.equal(f.sent.length, 0);
  assert.equal(f.ctx.ui.form('wsMenu'), null);
  f.render();
  assert.equal(f.options().items.some(item => item.id === 'parent'), false);
  assert.equal(f.hiveToggle()['aria-pressed'], 'true');
  assert.equal(f.mapRenders(), builds + 1);
  f.hiveToggle().onclick({ clientX: 10, clientY: 10 });
  assert.equal(f.ctx.ui.hideDoneForHive('cell'), false);
  assert.equal(f.sent.length, 0);
  assert.equal(f.ctx.ui.form('wsMenu'), null);
  f.render();
  assert.equal(f.options().items.some(item => item.id === 'parent'), true);
  assert.equal(f.hiveToggle()['aria-pressed'], 'false');
  assert.equal(f.mapRenders(), builds + 2);
});

test('fitting displaced closed work still confirms before saving', () => {
  const f = mapFixture({ hiveHidingStart: false });
  assert.equal(f.menu().fitLabel, 'Fit closed work back');
  f.menu().onFit();
  assert.equal(f.sent.length, 0);
  assert.equal(f.form.confirm.kind, 'fit');
  f.render();
  f.menu().onConfirm();
  assert.equal(f.sent.length, 1);
  assert.ok(f.sent[0].positions.b);
  for (const id of ['parent', 'a', 'block']) assert.equal(f.sent[0].positions[id], undefined);
});

test('formerly hidden completed regions yield reused hexes to live work immediately', () => {
  const f = mapFixture({ hiveHidingStart: false });
  f.beads.child.status = 'closed';
  f.saved.block = { ...f.saved.child };
  f.saved.a = { ...f.saved.b };
  f.render();
  const tiles = f.options().items;
  assert.equal(tiles.length, 5);
  assert.equal(new Set(tiles.map(tile => key(tile.local))).size, tiles.length);
  for (const id of ['a', 'block']) assert.deepEqual(tiles.find(tile => tile.id === id).local, f.saved[id]);
  const positions = tiles.map(tile => key(tile.local));
  f.render();
  assert.deepEqual(f.options().items.map(tile => key(tile.local)), positions);
  assert.equal(f.sent.length, 0, 'restoring visibility does not silently write placements');
});
