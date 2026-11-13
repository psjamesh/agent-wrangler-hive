import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom } from './helpers/dom.mjs';
import { h, syncChildren } from '../public/dom.js';
import { keepMessageList } from '../public/conversation.js';

const ids = el => [...el.children].map(c => c.dataset.id ?? c.textContent);
const row = (id, text = id, revision = 1) => Object.assign(h('li', { dataset: { id } }, text), { hiveRevision: revision });
const list = (label, ...rows) => h('ul', { 'aria-label': label }, ...rows);

test('syncChildren inserts, removes and reorders while keeping surviving nodes', t => {
  installDom(t);
  const [a, b, c, d] = ['a', 'b', 'c', 'd'].map(x => h('i', {}, x));
  const parent = h('div', {}, a, b, c);
  assert.equal(syncChildren(parent, [d, c, a]), parent);
  assert.deepEqual(ids(parent), ['d', 'c', 'a']);
  assert.equal(parent.children[1], c);
  assert.equal(b.parentNode, null);
});

test('syncChildren flattens nested arrays and skips null, undefined and false', t => {
  installDom(t);
  const [a, b] = ['a', 'b'].map(x => h('i', {}, x));
  const parent = h('div', {}, h('i', {}, 'old'));
  syncChildren(parent, [null, [a, [false, b]], undefined]);
  assert.deepEqual(ids(parent), ['a', 'b']);
});

test('syncChildren reports each removed node before removing it and leaves a stable list untouched', t => {
  installDom(t);
  const [a, b] = ['a', 'b'].map(x => h('i', {}, x));
  const parent = h('div', {}, a, b);
  const removed = [];
  syncChildren(parent, [a], node => removed.push([node, node.parentNode]));
  assert.deepEqual(removed, [[b, parent]]);
  let mutations = 0;
  for (const name of ['insertBefore', 'removeChild']) {
    const original = parent[name];
    parent[name] = (...args) => { mutations++; return original.apply(parent, args); };
  }
  syncChildren(parent, [a]);
  assert.equal(mutations, 0);
});

test('keepMessageList returns the fresh list on first render and when the key changes', t => {
  installDom(t);
  const ui = {};
  const first = list('one', row('m1'));
  assert.equal(keepMessageList(ui, 'k1', first, {}), first);
  const other = list('two', row('m1'));
  assert.equal(keepMessageList(ui, 'k2', other, {}), other);
});

test('keepMessageList keeps the live list and reuses rows whose revision and content are unchanged', t => {
  installDom(t);
  const ui = {};
  const live = keepMessageList(ui, 'k', list('first', row('m1'), row('m2')), {});
  const [m1, m2] = live.children;
  const kept = keepMessageList(ui, 'k', list('second', row('m1'), row('m2', 'edited'), row('m3')), {});
  assert.equal(kept, live);
  assert.equal(live.children[0], m1);
  assert.notEqual(live.children[1], m2);
  assert.deepEqual(ids(live), ['m1', 'm2', 'm3']);
  assert.equal(live.children[1].textContent, 'edited');
  assert.equal(live.getAttribute('aria-label'), 'second');
  assert.equal(live.hiveRebuilt, true);
});

test('keepMessageList rebuilds a row when its revision changes even if the markup is equal', t => {
  installDom(t);
  const ui = {};
  const live = keepMessageList(ui, 'k', list('x', row('m1', 'same', 1)), {});
  const old = live.children[0];
  keepMessageList(ui, 'k', list('x', row('m1', 'same', 2)), {});
  assert.notEqual(live.children[0], old);
});

test('keepMessageList copies or clears startAt on the live list', t => {
  installDom(t);
  const ui = {};
  const live = keepMessageList(ui, 'k', list('x', row('m1')), {});
  keepMessageList(ui, 'k', h('ul', { 'aria-label': 'x', dataset: { startAt: 'm1' } }, row('m1')), {});
  assert.equal(live.dataset.startAt, 'm1');
  keepMessageList(ui, 'k', list('x', row('m1')), {});
  assert.equal('startAt' in live.dataset, false);
});

test('keepMessageList captures scroll on the live parent before the old rows change', t => {
  installDom(t);
  const ui = {}, seen = [];
  const live = keepMessageList(ui, 'k', list('x', row('m1'), row('m2')), {});
  const parent = h('section', {}, live);
  const ctx = { beforeReplace: el => seen.push([el, ids(live)]) };
  keepMessageList(ui, 'k', list('x', row('m2'), row('m3')), ctx);
  assert.deepEqual(seen, [[parent, ['m1', 'm2']]]);
  assert.deepEqual(ids(live), ['m2', 'm3']);
});

test('keepMessageList captures scroll on the live list itself when it has no parent', t => {
  installDom(t);
  const ui = {}, seen = [];
  const live = keepMessageList(ui, 'k', list('x', row('m1')), {});
  keepMessageList(ui, 'k', list('x', row('m2')), { beforeReplace: el => seen.push(el) });
  assert.deepEqual(seen, [live]);
});
