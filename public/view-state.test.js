import test from 'node:test';
import assert from 'node:assert/strict';
import { readScrollState, saveScrollState, readMapView, saveMapView, readSession, writeSession } from './view-state.js';

function storage(t) {
  const previous = globalThis.sessionStorage;
  const values = new Map();
  globalThis.sessionStorage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) };
  t.after(() => { globalThis.sessionStorage = previous; });
  return values;
}

test('scroll anchors and following state survive a reload only as restoration for the same URL', t => {
  storage(t);
  const hash = '#view=ext:hive:overview&cell=cell_one&topic=thr_one';
  const scroll = new Map([['messages:cell_one:thr_one', { left: 0, top: 321, anchor: { id: 'msg_old', offset: -12 } }]]);
  const follow = new Map([['messages:cell_one:thr_one', false]]);
  saveScrollState(hash, scroll, follow);
  const saved = readScrollState(hash);
  assert.equal(saved.restore, true);
  assert.deepEqual(saved.scroll, scroll);
  assert.deepEqual(saved.follow, follow);
  assert.equal(readScrollState('#view=ext:hive:overview&cell=cell_other').restore, false);
});

test('map pan and zoom persist independently for each map', t => {
  storage(t);
  const view = { k: 1.75, tx: -150, ty: 260, auto: false };
  saveMapView('cell:cell_one', view);
  assert.deepEqual(readMapView('cell:cell_one'), view);
  assert.equal(readMapView('overview'), null);
  for (const k of [0, 10, '1', null]) {
    saveMapView('overview', { ...view, k });
    assert.equal(readMapView('overview'), null);
  }
});

test('corrupt or unavailable session storage does not break viewing', t => {
  const values = storage(t);
  values.set('hive:view:scroll', '{broken');
  assert.equal(readScrollState('hash'), null);
  writeSession('scroll', { hash: 'hash', scroll: [null, 3, {}, ['bad', { left: 0, top: 'wrong' }]], follow: [null] });
  assert.equal(readScrollState('hash').scroll.size, 0);
  globalThis.sessionStorage = { getItem() { throw Error('blocked'); }, setItem() { throw Error('quota'); } };
  assert.equal(readSession('scroll'), null);
  assert.doesNotThrow(() => saveMapView('cell_one', {}));
  assert.doesNotThrow(() => saveScrollState('hash', new Map(), new Map()));
});
