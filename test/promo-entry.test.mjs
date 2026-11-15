import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createManifest } from '../server/manifest.js';

const source = readFileSync(new URL('../public/client.js', import.meta.url), 'utf8');
const offerSource = source.match(/function offerPromo\(\) \{[\s\S]*?\n}/)[0];
function fixture(extra = {}) {
  const frames = [], offers = [];
  const state = { promoEntry: true, hiveShown: true, promoFrame: null, root: {}, promo: { offer: value => offers.push(value) }, ...extra };
  const document = { activeElement: { matches: () => false }, querySelector: () => null };
  const offer = vm.runInNewContext(`(${offerSource})`, { state, document, requestAnimationFrame: fn => { frames.push(fn); return frames.length; } });
  return { state, document, offer, offers, frames, flush: () => { while (frames.length) frames.shift()(); } };
}

test('an ordinary stable entry offers once; graph updates do not offer again', () => {
  const f = fixture();
  f.offer(); f.offer();
  assert.equal(f.frames.length, 1);
  f.flush(); f.offer(); f.flush();
  assert.equal(f.offers.length, 1);
  assert.equal(f.offers[0].blocked, false);
});

test('deep links, editing, dragging and another dialog defer for the entire entry', () => {
  for (const condition of ['promoDeepLink', 'linkRequest', 'linkMessage', 'dragging', 'editing', 'dialog']) {
    const f = fixture();
    if (condition === 'editing') f.document.activeElement.matches = () => true;
    else if (condition === 'dialog') f.document.querySelector = () => ({});
    else f.state[condition] = true;
    f.offer(); f.flush();
    assert.equal(f.offers[0].blocked, true, condition);
    f.state[condition] = false;
    f.offer(); f.flush();
    assert.equal(f.offers.length, 1, condition);
  }
});

test('an unmounted or unstable entry does not offer', () => {
  const f = fixture({ hiveShown: false });
  f.offer(); assert.equal(f.frames.length, 0);
  f.state.hiveShown = true; f.offer();
  f.state.root = null; f.state.promoEntry = false;
  f.flush(); assert.equal(f.offers.length, 0);
});

test('projection reports the executing extension build, independent of the host store', () => {
  const expected = JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version;
  const host = { sessions: { list: () => [] }, stores: { hive: { projection: () => ({}), metadata: { read: () => ({}) } } } };
  assert.equal(createManifest({ dir: '.' }).graph({ host }).hive.buildVersion, expected);
});
