import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { normalizeIssue } from '../server/bead-model.js';
import { projectForGraph } from '../server/projection.js';
import * as model from '../public/model.js';
import { beadTile, legend } from '../public/cell-view.js';
import { h } from '../public/dom.js';
import { primaryMark, renderHexMap } from '../public/hex-grid.js';

function fixture() {
  const cell = { id: 'cell', enabled: true, rootBeadId: 'root', bindings: [] };
  const beads = Object.fromEntries([['root', null, 'goal'], ['ws', 'root', 'workstream'], ['a', 'ws', 'work']].map(([id, parentId, kind]) => [id, { id, parentId, kind, title: id, status: 'open', waitingFor: '', evidence: [] }]));
  const doc = { cells: { cell }, bindings: {}, reviews: {}, beadLayout: {}, arrangeAspect: {}, archived: {}, restoreNotices: {}, conversation: {}, threads: {}, operations: {}, launches: {} };
  const runtime = { metadata: { read: () => doc, cells: () => Object.values(doc.cells) }, beads: { status: {} }, paths: {}, host: {} };
  const project = () => projectForGraph({ runtime, snapshot: { graph: { beads, edges: [] }, revision: 1, loadedAt: 1 } });
  return { cell, beads, doc, runtime, project };
}
const tileFor = (hive, bead = hive.beads.a, graph = {}) => beadTile({ hive, graph }, bead, { cellId: 'cell', x: 0, y: 0, layout: { groupHeads: [], parentHead: {}, halo: {}, rootId: 'root' } }, model.childrenMap(hive.beads));

for (const terminal of ['approved', 'changes_requested', 'cancelled']) test(`projection and counts clear after ${terminal}`, () => {
  const f = fixture();
  f.doc.reviews.review = { id: 'review', workBeadId: 'a', state: 'requested' };
  f.beads.a.waitingFor = 'Outside fix';
  let hive = f.project();
  assert.equal(hive.beads.a.reviewState, 'requested');
  assert.equal(hive.beads.a.waitingFor, 'Outside fix');
  assert.match(tileFor(hive).title, /In review/);
  assert.doesNotMatch(tileFor(hive).title, /\bOpen\b/);
  for (const c of [model.cellCounts(hive, f.cell), model.workCounts(hive, model.childrenMap(hive.beads), 'ws')]) {
    assert.equal(c.in_review, 1);
    assert.equal(c.in_progress, hive.capacity.used);
    assert.match(model.countsSentence(c), /1 in review/);
  }
  f.doc.reviews.review = { ...f.doc.reviews.review, state: terminal };
  f.beads.a.waitingFor = '';
  hive = f.project();
  const tile = tileFor(hive);
  assert.equal(model.cellCounts(hive, f.cell).in_review, 0);
  assert.equal(model.cellCounts(hive, f.cell).in_progress, 0);
  assert.equal(tile.marks.length, 0);
  assert.match(tile.title, /Open/);
  assert.doesNotMatch(tile.ariaLabel, /Outside fix|In review/);
});

class Element {
  constructor(tag, text = '') { this.tag = tag; this.text = text; this.children = []; this.attributes = {}; this.dataset = {}; this.style = {}; this.events = {}; }
  setAttribute(k, v) { this.attributes[k] = v; }
  removeAttribute(k) { delete this.attributes[k]; }
  append(...nodes) { this.children.push(...nodes); }
  addEventListener(k, fn) { (this.events[k] ||= []).push(fn); }
  fire(k, event = {}) { for (const fn of this.events[k] || []) fn(event); }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
}
const walk = el => [el, ...el.children.flatMap(walk)];
const words = el => walk(el).map(n => n.text).join(' ');
function dom(t) {
  const prev = { document: globalThis.document, Node: globalThis.Node };
  globalThis.Node = Element;
  globalThis.document = { createElement: tag => new Element(tag), createElementNS: (ns, tag) => new Element(tag), createTextNode: text => new Element('#text', text) };
  t.after(() => Object.assign(globalThis, prev));
}

function views() {
  const source = fs.readFileSync(new URL('../public/cell-view.js', import.meta.url), 'utf8').replace(/^import[\s\S]*?from .*;\n/gm, '').replaceAll('export ', '');
  return vm.runInNewContext(`${source}\n({ beadDetails, workstreamProgress, headProgress })`, { ...model, h, waitingSection: () => null, pullRequestsSection: () => null, markdown: (api, text) => h('p', {}, text), safeHref: url => url || null, sessionLabel: () => '' });
}

test('review and recorded waiting coexist with an agent mark and use circular badges and a bare blocked cross', t => {
  dom(t);
  const f = fixture();
  f.doc.reviews.review = { workBeadId: 'a', state: 'in_review' };
  f.beads.a.waitingFor = 'Needs <outside> fix';
  f.beads.a.ownerSessionId = 'agent';
  const hive = f.project();
  const tile = tileFor(hive, hive.beads.a, { sessions: [{ sessionId: 'agent', status: 'needs-you' }] });
  assert.match(tile.ariaLabel, /Waiting for: Needs <outside> fix/);
  assert.deepEqual(tile.marks.map(m => m.kind), ['person', 'review-pending', 'recorded-wait']);
  for (const mark of tile.marks) {
    const el = primaryMark(mark.kind, mark.title);
    assert(walk(el).some(n => n.tag === 'circle' && n.attributes.class === 'hive-pm-bg'));
    assert(!walk(el).some(n => n.tag === 'path' && n.attributes.class === 'hive-pm-bg'));
    assert.match(words(el), /In review|Waiting for|waiting for you/);
  }
  assert(!walk(primaryMark('waiting', 'Blocked')).some(n => n.attributes.class === 'hive-pm-bg'));
  const key = words(legend());
  assert.match(key, /in review/i);
  assert.match(key, /recorded wait/i);
});

for (const status of ['open', 'in_progress', 'blocked', 'deferred', 'closed']) test(`recorded wait survives ${status} and clears in details and tile`, t => {
  dom(t);
  const f = fixture();
  f.beads.a.status = status;
  f.beads.a.waitingFor = 'External approval';
  const { beadDetails: details } = views();
  const render = () => {
    const hive = f.project();
    return { tile: tileFor(hive), details: details({ hive, graph: {}, ui: { selectedBeadId: () => 'a', beadDetail: () => ({ bead: null, loading: false, error: null }) } }, hive.cells.cell) };
  };
  let out = render();
  assert(out.tile.marks.some(m => m.kind === 'recorded-wait'));
  assert.match(out.tile.title, /Waiting for: External approval/);
  assert.match(words(out.details), /Waiting for:.*External approval/);
  f.beads.a.waitingFor = '   ';
  out = render();
  assert(!out.tile.marks.some(m => m.kind === 'recorded-wait'));
  assert.doesNotMatch(words(out.details), /Waiting for:/);
});

test('native waiting metadata projects and clears without changing status', () => {
  const f = fixture();
  for (const reason of ['Outside dependency', '']) {
    f.beads.a = { ...f.beads.a, ...normalizeIssue({ id: 'a', status: 'open', metadata: { hive_waiting_for: reason }, dependencies: [{ type: 'parent-child', issue_id: 'a', depends_on_id: 'ws' }] }) };
    const bead = f.project().beads.a;
    assert.equal(bead.waitingFor, reason);
    assert.equal(bead.status, 'open');
  }
});

test('details and progress DOM show and clear the separate review bucket', t => {
  dom(t);
  const f = fixture();
  const view = views();
  f.doc.reviews.review = { workBeadId: 'a', state: 'in_review' };
  for (const inReview of [true, false]) {
    if (!inReview) f.doc.reviews.review = { workBeadId: 'a', state: 'cancelled' };
    const hive = f.project();
    const detail = view.beadDetails({ hive, graph: {}, ui: { selectedBeadId: () => 'a', beadDetail: () => ({ bead: null, loading: false, error: null }) } }, hive.cells.cell);
    const pill = walk(detail).find(el => el.attributes.class?.includes('hive-status-pill'));
    assert.equal(words(pill).trim(), inReview ? 'In review' : 'Open');
    const work = view.workstreamProgress(model.workCounts(hive, model.childrenMap(hive.beads), 'ws'));
    const head = view.headProgress(model.cellCounts(hive, f.cell));
    if (inReview) {
      assert.match(words(work), /1 in review/);
      assert.doesNotMatch(words(work), /1 open/);
      assert.match(head.attributes.title, /1 in review/);
    } else {
      assert.doesNotMatch(words(work), /in review/);
      assert.match(words(work), /1 open/);
      assert.doesNotMatch(head.attributes.title, /in review/);
    }
  }
});


test('map DOM renders separate badges and removes them on the next graph', t => {
  dom(t);
  const previousFrame = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = () => 1;
  t.after(() => { globalThis.requestAnimationFrame = previousFrame; });
  const f = fixture();
  f.doc.reviews.review = { workBeadId: 'a', state: 'requested' };
  f.beads.a.waitingFor = 'Outside fix';
  const render = () => renderHexMap({ viewKey: 'review-wait-dom', size: 60, items: [tileFor(f.project())], bounds: { x: -60, y: -60, w: 120, h: 120 }, ariaLabel: 'Work map' }).el;
  let map = render();
  const marks = walk(map).filter(el => el.attributes.class?.startsWith('hive-pm hive-pm-'));
  assert.equal(marks.length, 2);
  assert.notEqual(marks[0].attributes.transform, marks[1].attributes.transform);
  assert.match(words(map), /Waiting for: Outside fix/);
  assert.match(words(map), /In review/);
  f.doc.reviews.review = { workBeadId: 'a', state: 'cancelled' };
  f.beads.a.waitingFor = '';
  map = render();
  assert.equal(walk(map).filter(el => el.attributes.class?.startsWith('hive-pm hive-pm-')).length, 0);
  assert.doesNotMatch(words(map), /Waiting for:|In review/);
});


const visibleWords = el => el.tag === 'title' || el.hidden === true || (el.hidden === undefined && Object.hasOwn(el.attributes, 'hidden')) ? '' : [el.text, ...el.children.map(visibleWords)].join(' ');

for (const reviewing of [false, true]) test(`keyboard focus visibly explains ${reviewing ? 'review and waiting' : 'waiting'} and clears on a graph update`, t => {
  dom(t);
  const previousFrame = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = () => 1;
  t.after(() => { globalThis.requestAnimationFrame = previousFrame; });
  const f = fixture();
  f.beads.a.waitingFor = 'Outside compatibility report';
  if (reviewing) f.doc.reviews.review = { workBeadId: 'a', state: 'requested' };
  const render = () => renderHexMap({ viewKey: 'focus-reasons', size: 60, items: [tileFor(f.project())], bounds: { x: -60, y: -60, w: 120, h: 120 }, ariaLabel: 'Work map' }).el;
  let map = render();
  const tile = () => walk(map).find(el => el.attributes.tabindex === '0');
  assert.doesNotMatch(visibleWords(map), /Outside compatibility report/);
  assert.equal(tile().attributes['aria-describedby'], undefined);
  tile().fire('focus');
  assert(tile().attributes['aria-describedby']);
  assert.match(visibleWords(map), /Waiting for: Outside compatibility report/);
  if (reviewing) assert.match(visibleWords(map), /In review/);
  map.fire('keydown', { key: 'Escape', target: {}, preventDefault() {} });
  assert.doesNotMatch(visibleWords(map), /Outside compatibility report/);
  assert.equal(tile().attributes['aria-describedby'], undefined);
  tile().fire('blur');
  tile().fire('focus');
  assert.match(visibleWords(map), /Outside compatibility report/);
  tile().fire('blur');
  assert.equal(tile().attributes['aria-describedby'], undefined);
  assert.doesNotMatch(visibleWords(map), /Outside compatibility report/);
  f.beads.a.waitingFor = '';
  map = render();
  tile().fire('focus');
  assert.doesNotMatch(visibleWords(map), /Outside compatibility report/);
  if (reviewing) assert.match(visibleWords(map), /In review/);
  if (reviewing) f.doc.reviews.review = { workBeadId: 'a', state: 'approved' };
  map = render();
  tile().fire('focus');
  assert.doesNotMatch(visibleWords(map), /Outside compatibility report|In review/);
});


test('idle arc and hourglass render separately with one focused waiting reason', t => {
  dom(t);
  const previousFrame = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = () => 1;
  t.after(() => { globalThis.requestAnimationFrame = previousFrame; });
  const f = fixture();
  Object.assign(f.beads.a, { status: 'in_progress', ownerSessionId: 'builder', waitingFor: 'Outside compatibility report' });
  const graph = { sessions: [{ sessionId: 'builder', status: 'idle' }] };
  f.runtime.host.sessions = { get: id => graph.sessions.find(session => session.sessionId === id) };
  const render = () => {
    const hive = f.project();
    return renderHexMap({ viewKey: 'idle-and-wait-dom', size: 60, items: [tileFor(hive, hive.beads.a, graph)], bounds: { x: -60, y: -60, w: 120, h: 120 }, ariaLabel: 'Work map' }).el;
  };
  let map = render();
  const badges = () => walk(map).filter(el => el.attributes.class?.startsWith('hive-pm hive-pm-'));
  assert.deepEqual(badges().map(el => el.attributes.class), ['hive-pm hive-pm-in-progress', 'hive-pm hive-pm-recorded-wait']);
  assert.notEqual(badges()[0].attributes.transform, badges()[1].attributes.transform);
  walk(map).find(el => el.attributes.tabindex === '0').fire('focus');
  assert.equal(visibleWords(map).split('Outside compatibility report').length - 1, 1);
  assert.match(visibleWords(map), /In progress; agent idle/);
  f.beads.a.waitingFor = '';
  map = render();
  assert.deepEqual(badges().map(el => el.attributes.class), ['hive-pm hive-pm-in-progress']);
  const idleTile = walk(map).find(el => el.attributes.tabindex === '0');
  idleTile.fire('focus');
  assert.doesNotMatch(visibleWords(map), /Outside compatibility report/);
  assert.match(visibleWords(map), /In progress; agent idle/);
  assert(idleTile.attributes['aria-describedby']);
  map.fire('keydown', { key: 'Escape', target: {}, preventDefault() {} });
  assert.equal(idleTile.attributes['aria-describedby'], undefined);
  assert.doesNotMatch(visibleWords(map), /agent idle/);
});

test('details panel loads the long text on demand, with loading and error states', t => {
  dom(t);
  const f = fixture();
  const view = views();
  const hive = f.project();
  const draw = detail => walk(view.beadDetails({ hive, graph: {}, api: {}, send() {}, notice() {}, ui: { selectedBeadId: () => 'a', beadDetail: () => detail, retryBeadDetail: id => { retried = id; } } }, hive.cells.cell));
  let retried = null;
  const text = els => els.map(el => words(el)).join(' ');
  assert.match(text(draw({ bead: null, loading: true, error: null })), /Loading details/);
  const failed = draw({ bead: null, loading: false, error: 'No reply' });
  assert.match(text(failed), /Could not load the full details: No reply/);
  failed.find(el => el.attributes['data-focus-key'] === 'detail-retry:a').fire('click');
  assert.equal(retried, 'a');
  const loaded = draw({ bead: { goal: 'Ship the thing', acceptance: 'It ships', summary: 'Nearly', nextAction: 'Wait for review', evidence: [{ label: 'PR 5', kind: 'pr' }], nativeMetadataKeys: ['x'] }, loading: false, error: null });
  const shown = text(loaded);
  for (const part of ['Ship the thing', 'It ships', 'Nearly', 'Wait for review', 'PR 5', 'Other metadata: x']) assert.ok(shown.includes(part), part);
  assert.doesNotMatch(shown, /Loading details/);
});
