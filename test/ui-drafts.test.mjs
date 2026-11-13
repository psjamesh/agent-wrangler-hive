import test from 'node:test';
import assert from 'node:assert/strict';
import { createDrafts, DRAFT_PREFIX } from '../public/ui-drafts.js';

function setup({ withRemove = true } = {}) {
  const values = new Map();
  const io = {
    load: (key, fallback) => (values.has(key) ? JSON.parse(values.get(key)) : fallback),
    save: (key, value) => values.set(key, JSON.stringify(value)),
    remove: withRemove ? (key) => values.delete(key) : null,
  };
  return { values, drafts: createDrafts(io), mem: { drafts: new Map() } };
}

test('an edit is kept in memory and storage with a new revision', () => {
  const { values, drafts, mem } = setup();
  drafts.editDraft(mem, 'c:t', { text: 'hello' });
  const d = drafts.draftOf(mem, 'c:t');
  assert.equal(d.text, 'hello');
  assert.ok(d.rev);
  assert.equal(JSON.parse(values.get(`${DRAFT_PREFIX}c:t`)).text, 'hello');
});

test('an emptied draft is removed from storage, or nulled when storage cannot remove', () => {
  for (const withRemove of [true, false]) {
    const { values, drafts, mem } = setup({ withRemove });
    drafts.editDraft(mem, 'k', { text: 'x' });
    drafts.editDraft(mem, 'k', { text: '' });
    assert.equal(withRemove ? values.has(`${DRAFT_PREFIX}k`) : values.get(`${DRAFT_PREFIX}k`), withRemove ? false : 'null');
  }
});

test('a new-topic composer with nothing saved takes the single-stream text', () => {
  const { values, drafts, mem } = setup();
  drafts.editDraft(mem, 'c', { text: 'carried' });
  mem.drafts.clear();
  assert.equal(drafts.draftOf(mem, 'c:new').text, 'carried');
  assert.equal(values.has(`${DRAFT_PREFIX}c`), false);
  assert.equal(JSON.parse(values.get(`${DRAFT_PREFIX}c:new`)).text, 'carried');
});

test('sameRev trusts the stored draft over memory', () => {
  const { values, drafts, mem } = setup();
  drafts.editDraft(mem, 'k', { text: 'a' });
  const rev = drafts.draftOf(mem, 'k').rev;
  assert.equal(drafts.sameRev(mem, 'k', rev), true);
  assert.equal(drafts.sameRev(mem, 'k', ''), false);
  values.set(`${DRAFT_PREFIX}k`, JSON.stringify({ text: 'b', rev: 'other' }));
  assert.equal(drafts.sameRev(mem, 'k', rev), false);
});

test('stored fields are clamped and coerced on read', () => {
  const { values, drafts, mem } = setup();
  values.set(`${DRAFT_PREFIX}k`, JSON.stringify({ text: 'x'.repeat(50000), title: 7, reply: 'r', about: '', aboutAuto: true }));
  const d = drafts.draftOf(mem, 'k');
  assert.equal(d.text.length, 40000);
  assert.equal(d.title, '');
  assert.equal(d.reply, 'r');
  assert.equal(d.about, null);
});
