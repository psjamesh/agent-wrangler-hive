import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { statusDot, STATUS_TEXT, workCounts, childrenMap } from '../public/model.js';

const source = fs.readFileSync(new URL('../public/cell-view.js', import.meta.url), 'utf8');
const h = (tag, attrs, ...children) => ({ tag, attrs, style: {}, children: children.flat(Infinity).filter(n => n != null) });
const all = node => [node, ...(node.children || []).filter(n => typeof n === 'object').flatMap(all)];
const text = node => typeof node === 'string' ? node : node.children.map(text).join('');
const load = (name, deps = {}) => vm.runInNewContext(`(${source.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n}\\n`))[0]})`, { h, ...deps });
const bar = () => h('span', { class: 'hive-progress-inline' });
const progress = load('headProgress', { countsSentence: () => 'Full progress tooltip', progressBar: bar });
const queen = load('queenPill', { statusDot, STATUS_TEXT, sessionLabel: () => 'Coordinator', launchState: () => null, relativeTime: () => 'earlier' });

test('header orders identity, capacity, progress, needs, queen and settings', () => {
  const header = load('cellHeader', {
    childrenMap, workCounts, cellWaitingItems: () => [{ id: 'wait' }], cellTitle: () => 'Title',
    queenPill: () => h('button', {}, 'Queen'), headProgress: progress,
    capacityControl: () => h('button', {}, '5/8 slots'), settingsButton: () => h('button', {}, 'Settings'),
    settingsModal: () => null, attentionEl: () => null, noticesEl: () => null, isRetired: () => false,
  });
  const cell = { id: 'c', enabled: true };
  const ctx = { hive: { beads: { done: { id: 'done', parentId: 'root', status: 'closed' } }, edges: [] }, ui: {}, graph: {} };
  assert.match(text(header(ctx, cell, { id: 'root' })), /All hives\/Title5\/8 slots1\/1 closed1 need youQueenSettings/);
  assert.equal(all(header(ctx, cell, { id: 'root' })).filter(n => n.attrs?.class === 'hive-progress-inline').length, 1);
});

test('progress keeps its tooltip and empty state with shorter labels', () => {
  assert.equal(text(progress({ total: 20, closed: 12 })), '12/20 closed');
  assert.equal(progress({ total: 20, closed: 12 }).attrs.title, 'Full progress tooltip');
  assert.equal(text(progress({ total: 0, closed: 0 })), 'No work yet');
  assert.equal(progress(null), null);
});

for (const [status, expected] of [['working', 'Queen'], ['idle', 'Queen'], ['needs-you', 'Queen waiting for input'], ['exited', 'Queen stopped'], ['archived', 'Queen archived'], ['missing', 'Queen not on the board']]) {
  test(`queen pill represents ${status}`, () => {
    const cell = { id: 'c', enabled: true, queenSessionId: 'q' };
    const graph = { sessions: status === 'missing' ? [] : [{ sessionId: 'q', status, archived: status === 'archived' }] };
    const pill = queen({ graph, hive: {} }, cell, () => {});
    assert.equal(text(pill), expected);
    assert.match(pill.attrs.title, new RegExp(STATUS_TEXT[statusDot(graph, 'q')]));
    assert.ok(all(pill).some(n => n.attrs?.['aria-hidden'] === 'true'));
  });
}

test('queen brief and missing-queen warnings remain visible', () => {
  const cell = { id: 'c', enabled: true, queenSessionId: 'q' };
  const ctx = { graph: { sessions: [{ sessionId: 'q', status: 'working' }] }, hive: {} };
  for (const [state, label] of [['failed', 'brief not delivered'], ['uncertain', 'brief unconfirmed']]) {
    cell.activation = { sessionId: 'q', state };
    assert.equal(text(queen(ctx, cell, () => {})), `Queen · ${label}`);
  }
  cell.queenSessionId = null;
  assert.match(text(queen(ctx, cell, () => {})), /no queen/);
});

test('history lives beside Show done with a Details fallback when the map is absent', () => {
  const map = fs.readFileSync(new URL('../public/hive-view.js', import.meta.url), 'utf8');
  const controls = map.slice(map.indexOf('viewControls:', map.indexOf('function cellMap(')), map.indexOf('overlay:', map.indexOf('function cellMap(')));
  assert.match(controls, /'Show done'\),\s*cell.enabled && !cell.snapshot \? closedButton\(ctx, cell/);
  const header = source.match(/function cellHeader\([\s\S]*?\n}\n/)[0];
  assert.doesNotMatch(header, /closedButton/);
  assert.match(source, /cell.enabled && !cell.snapshot && \(!root \|\| ui.inspecting\(\)\) \? closedButton\(ctx, cell\)/);
});

test('closed workstream menu entry preserves its drawer action and tooltip', () => {
  const src = fs.readFileSync(new URL('../public/workstream-view.js', import.meta.url), 'utf8');
  const forms = new Map();
  const closedButton = vm.runInNewContext(`(${src.match(/function closedButton\([\s\S]*?\n}\n/)[0]})`, {
    h, closedWorkstreams: () => [['closed', {}]], closedKey: id => `closed:${id}`,
    completeKey: id => `wscomplete:${id}`, focusKey() {},
  });
  const ctx = { hive: {}, ui: { form: key => forms.get(key), setForm: (key, value) => forms.set(key, value) } };
  const button = closedButton(ctx, { id: 'c' }, 'hive-zoom-btn');
  assert.equal(text(button), 'Closed workstreams (1)');
  assert.equal(button.attrs.class, 'hive-zoom-btn');
  assert.match(button.attrs.title, /history.*reopening/);
  button.attrs.onclick();
  assert.ok(forms.get('closed:c'));
  assert.equal(closedButton(ctx, { id: 'c' }).attrs['aria-expanded'], 'true');
});

test('header uses wrapping groups and matching shorter bars at narrow widths', () => {
  const css = fs.readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.hive-cellhead-top \{ flex-wrap: wrap; min-width: 0; font-size: 12\.5px; }/);
  assert.match(css, /\.hive-cellstate \{[^}]*flex-wrap: wrap;/);
  assert.match(css, /\.hive-cellhead \.hive-progress-inline,\s*\.hive-capacity-count \.hive-progress-inline \{ width: 56px; flex: 0 0 56px;/);
});


test('off and captured hives preserve their queen labels', () => {
  assert.equal(text(queen({ graph: {}, hive: {} }, { id: 'c', enabled: false }, () => {})), 'Queen');
  assert.equal(text(queen({ graph: {}, hive: {} }, { id: 'c', snapshot: { capturedAt: 'capture' } }, () => {})), 'Captured snapshot, earlier: read only');
});

test('header text shares one size while pills retain theme colours and geometry', () => {
  const css = fs.readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  const declarations = selector => rules.filter(([, selectors]) => selectors.split(',').some(s => s.trim() === selector)).map(([, , body]) => body).join('\n');
  for (const selector of ['.hive-celltitle', ...['hive-counts', 'hive-queen-pill', 'hive-pill-btn', 'hive-setup-pill', 'hive-badge', 'hive-capacity-note'].map(name => `.hive-cellhead-top .${name}`)]) {
    assert.match(declarations(selector), /font-size: inherit;/, selector);
  }
  assert.match(declarations('.hive-queen-pill'), /border-radius: 999px;/);
  assert.match(declarations('.hive-queen-pill'), /background: var\(--hive-wax\);/);
  assert.match(declarations('.hive-dot-inline.hive-dot-needs'), /background: var\(--red\);/);
});
