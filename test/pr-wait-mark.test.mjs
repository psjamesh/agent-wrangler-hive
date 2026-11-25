import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { beadTile } from '../public/cell-view.js';
import { cellMetrics } from '../public/cell-metrics.js';
import { primaryMark, renderHexMap, MARK_R, MARK_STROKE } from '../public/hex-grid.js';
import { prSummary } from '../public/pr-view.js';
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
  assert.match(f.tile().ariaLabel, /PR needs review or merge/);
  assert.equal(f.tile().marks[0].count, 1);
  assert.equal(f.tile().marks[1].count, 1);
  f.cell.pullRequests = [];
  assert.deepEqual(f.tile().marks.map(m => m.kind), ['person']);
});

test('PR summaries distinguish review or merge from general help', () => {
  const f = fixture();
  assert.match(prSummary([f.pr]), /1 PR needs review or merge/);
  assert.match(prSummary([f.pr, { ...f.pr, url: `${f.pr.url}0` }]), /2 PRs need review or merge/);
  assert.doesNotMatch(prSummary([f.pr]), /waiting for you/);
  assert.match(prSummary([{ ...f.pr, humanAttention: { ...f.pr.humanAttention, state: 'cannot-fix' } }]), /1 waiting for you/);
});

test('four simultaneous marks fit inside the hex content and expose PR text on focus', t => {
  installDom(t);
  const previous = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = () => 1;
  t.after(() => { globalThis.requestAnimationFrame = previous; });
  const f = fixture();
  f.request();
  Object.assign(f.bead, { title: 'Review pull request and approve merge policy', reviewState: 'in_review', waitingFor: 'External report' });
  assert.deepEqual(f.tile().marks.map(m => m.kind), ['person', 'pr', 'review-pending', 'recorded-wait']);
  for (const size of [60, 90]) {
    const map = renderHexMap({ viewKey: `pr-four-${size}`, size, items: [f.tile()], bounds: { x: -size, y: -size, w: size * 2, h: size * 2 } }).el;
    const marks = walk(map).filter(n => n.attributes.class?.startsWith('hive-pm hive-pm-'));
    assert.equal(marks.length, 4);
    for (const mark of marks) {
      const [, x, y, scale] = mark.attributes.transform.match(/translate\(([-\d.]+) ([-\d.]+)\) scale\(([\d.]+)\)/).map(Number);
      const apothem = (size * 0.945 - 1) * Math.sqrt(3) / 2;
      for (let edge = 0; edge < 6; edge++) {
        const angle = edge * Math.PI / 3;
        const clearance = apothem - x * Math.cos(angle) - y * Math.sin(angle);
        assert.ok(clearance >= (MARK_R + MARK_STROKE / 2) * scale, `${mark.attributes.class} crosses edge ${edge} at size ${size}`);
      }
    }
    const title = walk(map).filter(n => n.attributes.class === 'hive-hex-title');
    assert.ok(title.length >= 3, 'Crowded tile retains a multiline title');
    const markY = Number(marks[0].attributes.transform.match(/translate\([-\d.]+ ([-\d.]+)/)[1]);
    assert.ok(Number(title.at(-1).attributes.y) + 9.5 * 0.24 < markY - (MARK_R + MARK_STROKE / 2) * Math.max(1, size / 60), 'Title ends above the marks');
    const tile = walk(map).find(n => n.dataset.tileId === 'work');
    tile.dispatchEvent({ type: 'focus' });
    assert.match(walk(map).find(n => n.attributes.class === 'hive-mark-tooltip').textContent, /PR needs review or merge/);
  }
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
  f.cell.pullRequests.push({ ...f.pr, url: `${f.pr.url}0` });
  assert.match(cellTile(f.ctx, f.cell).ariaLabel, /2 PRs need review or merge/);
  f.cell.pullRequests = [];
  assert.deepEqual(counters(), ['needs']);
});
