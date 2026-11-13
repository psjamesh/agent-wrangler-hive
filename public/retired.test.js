import assert from 'node:assert/strict';
import { test } from 'node:test';
import { visibleCells, overviewPlaces, outcomeMark } from './retired.js';

const active = (id, q, r) => ({ id, enabled: true, position: { q, r } });
const retired = (id, q, r, outcome = 'done') => ({ id, enabled: false, position: { q, r }, retired: { outcome, summary: 'shipped\nmore', position: { q, r } } });

test('retired hives are hidden unless shown', () => {
  const cells = [active('a', 0, 0), retired('b', 1, 0)];
  assert.deepEqual(visibleCells(cells, false).map((c) => c.id), ['a']);
  assert.deepEqual(visibleCells(cells, true).map((c) => c.id), ['a', 'b']);
});

test('a shown retired hive keeps its old place when free and an active hive never moves', () => {
  const places = overviewPlaces([active('a', 0, 0), retired('b', 2, 0)]);
  assert.deepEqual(places.get('a'), { q: 0, r: 0 });
  assert.deepEqual(places.get('b'), { q: 2, r: 0 });
});

test('a shown retired hive goes to the nearest free place when its old one is now taken', () => {
  const places = overviewPlaces([active('a', 2, 0), retired('b', 2, 0), retired('c', 2, 0)]);
  assert.deepEqual(places.get('a'), { q: 2, r: 0 });
  const dist = (p) => Math.max(Math.abs(p.q - 2), Math.abs(p.r), Math.abs(p.q - 2 + p.r));
  assert.equal(dist(places.get('b')), 1);
  assert.equal(dist(places.get('c')), 1);
  assert.notDeepEqual(places.get('b'), places.get('c'));
});

test('the outcome mark follows closed work: a tick for done, a dash otherwise', () => {
  assert.equal(outcomeMark({ outcome: 'done', summary: 's' }).kind, 'done');
  assert.equal(outcomeMark({ outcome: 'dropped', summary: 's' }).kind, 'closed');
  assert.match(outcomeMark({ outcome: 'superseded', summary: 'x\ny' }).title, /Retired, superseded: x$/);
});
