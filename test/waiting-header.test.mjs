import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { cellWaitingItems } from '../public/waiting-model.js';

test('the cell-wide wait action includes unbound waits and remains available in responsive layouts', () => {
  const source = fs.readFileSync(new URL('../public/cell-view.js', import.meta.url), 'utf8');
  const h = (tag, attrs, ...children) => ({ tag, attrs, children: children.flat(Infinity).filter(Boolean) });
  const header = vm.runInNewContext(`(${source.match(/function cellHeader\([\s\S]*?\n}\n/)[0]})`, {
    h, cellWaitingItems, cellName: () => 'Example', queenPill: () => null, headProgress: () => null,
    hasPanels: () => false, closedButton: () => null, needsYouIncomplete: () => false,
    capacityControl: () => null, allSettings: () => null, isRetired: () => false, retireKey: (id) => `retire:${id}`, openReopen() {},
    attentionEl: () => null, restoreNotices: () => null, noticesEl: () => null,
  });
  const cell = { id: 'c', enabled: true, rootBeadId: 'root', taskId: 't', bindings: [], requests: { native: { id: 'native', cellId: 'c', audience: 'human', state: 'open', title: 'Hive-wide decision' } } };
  const ctx = { hive: { cells: { c: cell }, beads: { root: { id: 'root' } } }, graph: {
    sessions: [{ sessionId: 'unbound', status: 'needs-you' }], tasks: { assignments: { unbound: 't' } },
  }, ui: { form: () => null }, send: () => {} };
  const all = node => [node, ...(node.children || []).filter(n => typeof n === 'object').flatMap(all)];
  const action = all(header(ctx, cell, null)).find(n => n.attrs?.['data-focus-key'] === 'waiting-header');
  assert.equal(action.tag, 'button');
  assert.equal(action.children[0], '2 waiting for you');
  assert.equal(typeof action.attrs.onclick, 'function');
  assert.equal(action.attrs['aria-haspopup'], 'dialog');
  const css = fs.readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
  const hidden = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(([, , declarations]) => /display\s*:\s*none\b/.test(declarations));
  const classes = action.attrs.class.split(/\s+/);
  for (const [, selectors] of hidden) {
    assert.equal(selectors.split(',').some(selector => /data-layout/.test(selector) && classes.some(name => selector.includes(`.${name}`))), false, `Waiting action is hidden by ${selectors.trim()}`);
  }
});
