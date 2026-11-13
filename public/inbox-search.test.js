import test from 'node:test';
import assert from 'node:assert/strict';
import { searchTerms, textMatches, topicMatches, highlightParts, snippetFor, filterRows } from './inbox-search.js';

test('terms are lowercased, split on whitespace and deduplicated', () => {
  assert.deepEqual(searchTerms('  Foo  BAR foo '), ['foo', 'bar']);
  assert.deepEqual(searchTerms('   '), []);
});

test('a topic matches case-insensitively on title, message text or bead id, every term required', () => {
  const topic = { title: 'Deploy Pipeline', texts: ['Waiting on REVIEW'], beadIds: ['hive-QSDF'] };
  assert.equal(topicMatches(topic, 'deploy'), true);
  assert.equal(topicMatches(topic, 'review'), true);
  assert.equal(topicMatches(topic, 'qsdf'), true);
  assert.equal(topicMatches(topic, 'pipeline review'), true);
  assert.equal(topicMatches(topic, 'pipeline nope'), false);
  assert.equal(topicMatches(topic, ''), true);
  assert.equal(textMatches('Hello', 'HELL'), true);
  assert.equal(textMatches('Hello', ''), false);
});

test('highlight parts cover the text and merge overlapping hits', () => {
  const parts = highlightParts('Fix the Fixture', 'fix fixt');
  assert.equal(parts.map(p => p.text).join(''), 'Fix the Fixture');
  assert.deepEqual(parts.filter(p => p.hit).map(p => p.text), ['Fix', 'Fixt']);
  assert.deepEqual(highlightParts('abc', ''), [{ text: 'abc', hit: false }]);
  assert.deepEqual(highlightParts('a<b>&', 'b'), [{ text: 'a<', hit: false }, { text: 'b', hit: true }, { text: '>&', hit: false }]);
});

test('snippets centre on the first matching message and clip long text', () => {
  assert.equal(snippetFor(['nothing', 'the needle is here'], 'needle'), 'the needle is here');
  assert.equal(snippetFor(['nothing'], 'needle'), null);
  const long = `${'x'.repeat(300)} needle ${'y'.repeat(300)}`;
  const s = snippetFor([long], 'needle', 60);
  assert.ok(s.includes('needle') && s.startsWith('…') && s.endsWith('…') && s.length <= 62);
});

test('filtering keeps matching rows, drops overflow rows and adds a snippet', () => {
  const rows = [
    { key: 'a', title: 'Alpha', texts: ['one'], beadIds: [] },
    { key: 'b', title: 'Beta', texts: ['has Needle'], beadIds: [] },
    { key: 'c', title: 'Gamma', texts: [], beadIds: ['hive-abc'] },
    { key: 'more', title: '3 more', more: 3 },
  ];
  assert.deepEqual(filterRows(rows, 'needle').map(r => [r.key, r.snippet]), [['b', 'has Needle']]);
  assert.deepEqual(filterRows(rows, 'ABC').map(r => r.key), ['c']);
  assert.equal(filterRows(rows, ''), rows);
  assert.deepEqual(filterRows(rows, 'zzz'), []);
});
