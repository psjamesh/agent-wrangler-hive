import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { cellMetrics } from '../public/cell-metrics.js';

test('the cell-wide wait action includes unbound waits and remains available in responsive layouts', () => {
  const source = fs.readFileSync(new URL('../public/cell-view.js', import.meta.url), 'utf8');
  const h = (tag, attrs, ...children) => ({ tag, attrs, children: children.flat(Infinity).filter(Boolean) });
  const name = 'A long hive name that must remain readable when the header is narrow';
  let opened;
  const header = vm.runInNewContext(`(${source.match(/function cellHeader\([\s\S]*?\n}\n/)[0]})`, {
    h, cellMetrics, openWaitingMenu: (...args) => { opened = args; }, cellTitle: () => h('button', { class: 'hive-title-btn', title: `Rename hive: ${name}` }, name), queenPill: () => null, headProgress: () => null,
    hasPanels: () => false, closedButton: () => null,
    capacityControl: () => null, settingsModal: () => null, settingsButton: () => null, isRetired: () => false, retireKey: (id) => `retire:${id}`, openReopen() {},
    attentionEl: () => null, restoreNotices: () => null, noticesEl: () => null,
  });
  const cell = { id: 'c', enabled: true, rootBeadId: 'root', taskId: 't', bindings: [], waits: [{ id: 'message:fyi', kind: 'message', beadIds: ['root'] }], inbox: { human: { count: 1 } }, requests: { native: { id: 'native', cellId: 'c', audience: 'human', state: 'open', title: 'Hive-wide decision' } } };
  const ctx = { hive: { cells: { c: cell }, edges: [], beads: { root: { id: 'root' } } }, graph: {
    sessions: [{ sessionId: 'unbound', status: 'needs-you' }], tasks: { assignments: { unbound: 't' } },
  }, ui: { form: () => null }, send: () => {} };
  const all = node => [node, ...(node.children || []).filter(n => typeof n === 'object').flatMap(all)];
  const title = all(header(ctx, cell, null)).find(n => n.attrs?.class === 'hive-title-btn');
  assert.ok(title.attrs.title.includes(name));
  assert.equal(title.children[0], name);
  const action = all(header(ctx, cell, null)).find(n => n.attrs?.['data-focus-key'] === 'waiting-header');
  assert.equal(action.tag, 'button');
  assert.equal(action.children[1], '2 need you');
  assert.equal(action.attrs.class, 'hive-queen-pill hive-waiting');
  assert.equal(action.children[0].attrs.class, 'hive-dot-inline hive-dot-needs');
  assert.equal(action.children[0].attrs['aria-hidden'], 'true');
  assert.equal(typeof action.attrs.onclick, 'function');
  assert.equal(action.attrs['aria-haspopup'], 'dialog');
  action.attrs.onclick({ currentTarget: action });
  assert.equal(opened[0], ctx);
  assert.equal(opened[1].length, 2);
  assert.equal(opened[2], action);
  assert.equal(opened[3].cellId, cell.id);
  cell.requests = {};
  ctx.graph.sessions = [];
  assert.equal(all(header(ctx, cell, null)).some(n => n.attrs?.['data-focus-key'] === 'waiting-header'), false);
  const css = fs.readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
  const titleStyle = css.match(/\.hive-title-btn \{([^}]+)\}/)[1];
  for (const rule of ['display: block', 'max-width: 100%', 'overflow: hidden', 'text-overflow: ellipsis', 'white-space: nowrap']) assert.ok(titleStyle.includes(rule), rule);
  const hidden = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(([, , declarations]) => /display\s*:\s*none\b/.test(declarations));
  const classes = action.attrs.class.split(/\s+/);
  for (const [, selectors] of hidden) {
    assert.equal(selectors.split(',').some(selector => /data-layout/.test(selector) && classes.some(name => selector.includes(`.${name}`))), false, `Waiting action is hidden by ${selectors.trim()}`);
  }
});
