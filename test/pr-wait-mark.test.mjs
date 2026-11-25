import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { beadTile } from '../public/cell-view.js';
import { cellMetrics } from '../public/cell-metrics.js';
import { primaryMark, renderHexMap } from '../public/hex-grid.js';
import * as model from '../public/model.js';
import { installDom, walk } from './helpers/dom.mjs';

function fixture() {
  const bead = { id: 'work', parentId: 'root', title: 'Ship change', status: 'open', kind: 'work', reviewState: 'approved' };
  const cell = { id: 'cell', enabled: true, taskId: 'task', rootBeadId: 'root', queenSessionId: 'queen', bindings: [], requests: {}, pullRequests: [] };
  const pr = { url: 'https://github.com/example/repo/pull/7', number: 7, title: 'Ship change', beadIds: ['work'], state: 'OPEN', headSha: 'a'.repeat(40), checks: 'green', isDraft: false, stateCheckedAt: Date.now(), humanAttention: { state: 'ready', headSha: 'a'.repeat(40), reason: 'Please review and merge' } };
  cell.pullRequests.push(pr);
  const hive = { cells: { cell }, beads: { root: { id: 'root', kind: 'goal' }, work: bead }, edges: [] };
  const ctx = { hive, graph: { sessions: [{ sessionId: 'queen', status: 'idle' }] } };
  const tile = () => beadTile({ ...ctx }, bead, { cellId: 'cell', x: 0, y: 0, layout: { groupHeads: [], parentHead: {}, halo: {}, rootId: 'root' } }, model.childrenMap(hive.beads));
  const request = () => { cell.requests.input = { id: 'input', audience: 'human', state: 'open', beadId: 'work', title: 'Choose policy', kind: 'approval', subjectPin: { kind: 'pr', url: pr.url, revision: pr.headSha } }; };
  return { bead, cell, pr, ctx, tile, request };
}

test('PR ready handoffs use their own mark, while native requests retain Needs You', () => {
  const f = fixture();
  assert.deepEqual(f.tile().marks.map(m => m.kind), ['pr']);
  for (const words of [f.tile().mark.title, f.tile().title, f.tile().ariaLabel]) assert.match(words, /PR needs review or merge/);
  f.request();
  assert.deepEqual(f.tile().marks.map(m => m.kind), ['person', 'pr']);
  assert.equal(f.tile().marks[0].count, 1);
  assert.equal(f.tile().marks[1].count, 1);
  f.cell.pullRequests = [];
  assert.deepEqual(f.tile().marks.map(m => m.kind), ['person']);
});

test('PR badge clears on stale, changed, terminal, failing, evidence-only or cleared handoffs', () => {
  for (const patch of [{ stateCheckedAt: 0 }, { headSha: 'b'.repeat(40) }, { state: 'MERGED' }, { state: 'CLOSED' }, { checks: 'failing' }, { isDraft: true }, { evidenceOnly: true }, { humanAttention: null }]) {
    const f = fixture();
    Object.assign(f.pr, patch);
    assert.deepEqual(f.tile().marks.map(m => m.kind), ['approved'], JSON.stringify(patch));
  }
  const f = fixture();
  f.pr.humanAttention.state = 'cannot-fix';
  assert.equal(f.tile().mark.kind, 'person');
});

test('agent input and PR review waits coexist and use separate mark geometry', t => {
  installDom(t);
  const f = fixture();
  f.bead.ownerSessionId = 'builder';
  f.ctx.graph.sessions.push({ sessionId: 'builder', status: 'needs-you' });
  assert.deepEqual(f.tile().marks.map(m => m.kind), ['person', 'pr']);
  const pr = primaryMark('pr', 'PR needs review or merge');
  const person = primaryMark('person', 'Needs You');
  assert.ok(walk(pr).some(n => n.attributes.class === 'hive-pm-bg'));
  assert.notDeepEqual(walk(pr).filter(n => n.tagName === 'path').map(n => n.attributes.d), walk(person).filter(n => n.tagName === 'path').map(n => n.attributes.d));
});

test('overview counters split PR review waits from Needs You without losing total waits', t => {
  installDom(t);
  const previous = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = () => 1;
  t.after(() => { globalThis.requestAnimationFrame = previous; });
  const source = readFileSync(new URL('../public/hive-view.js', import.meta.url), 'utf8');
  const cellTile = vm.runInNewContext(`(${source.match(/function cellTile\([\s\S]*?\n}\n/)[0]})`, { ...model, cellMetrics, launchState: () => null, toPixel: () => ({ x: 0, y: 0 }), CELL_SIZE: 92 });
  const f = fixture();
  const draw = () => renderHexMap({ viewKey: 'pr-counter', size: 92, items: [cellTile(f.ctx, f.cell)], bounds: { x: -100, y: -100, w: 200, h: 200 } }).el;
  const counters = () => walk(draw()).filter(n => n.dataset.counter).map(n => n.dataset.counter);
  assert.deepEqual(counters(), ['pr']);
  f.request();
  assert.equal(cellMetrics(f.ctx, f.cell).needs, 2);
  assert.deepEqual(counters(), ['needs', 'pr']);
  const badge = walk(draw()).find(n => n.attributes.class === 'hive-pm hive-pm-pr');
  assert.match(badge.textContent, /PR needs review or merge/);
  f.cell.pullRequests = [];
  assert.deepEqual(counters(), ['needs']);
});
