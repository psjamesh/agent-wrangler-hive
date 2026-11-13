import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MetadataStore } from '../server/metadata-store.js';
import { publish, threadList, threadRelations, threadIndex } from '../server/conversation.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-publish-mentions-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const metadata = new MetadataStore({ file: path.join(root, 'metadata.json') });
  const cell = { id: 'cell_test', rootBeadId: 'hive-abc', enabled: true, queenSessionId: 'queen' };
  metadata.mutate(d => {
    d.cells[cell.id] = cell;
    d.cells.other = { id: 'other', rootBeadId: 'hive-xyz', enabled: true };
  });
  const beads = Object.fromEntries([
    ['hive-abc', null], ['hive-demo2', 'hive-abc'], ['hive-123', 'hive-abc'],
    ['hive-demo2.1', 'hive-demo2'], ['hive-xyz', null], ['hive-9zzz', 'hive-xyz'],
  ].map(([id, parentId]) => [id, { id, parentId, title: id }]));
  const rt = { metadata, paths: { root }, host: { tasks: { forSession: () => null } }, pendingParticipants: new Map(), changed() {}, snapshots: { graph: { beads } } };
  const actor = { cell, role: 'queen', sessionId: 'queen' };
  const list = () => metadata.read().conversation[cell.id] || [];
  const relations = tid => {
    const topic = metadata.read().threads[cell.id][tid];
    return threadRelations(topic, threadIndex(list()).get(tid));
  };
  return { rt, actor, cell, list, relations };
}

test('publish rejects all unknown Hive ids before saving a message or topic', async t => {
  const f = fixture(t);
  await assert.rejects(publish(f.rt, f.actor, { text: 'See hive-demo2, **hive-zzzz**, hive-xxx and hive-zzzz.' }), err => {
    assert.match(err.message, /Unknown bead ids/);
    assert.match(err.message, /hive-zzzz/);
    assert.match(err.message, /hive-xxx/);
    assert.doesNotMatch(err.message, /hive-demo2/);
    return true;
  });
  assert.deepEqual(f.list(), []);
  assert.deepEqual(f.rt.metadata.read().threads[f.cell.id] || {}, {});
});

test('publish records deduplicated mentions as topic relations, excluding its anchor', async t => {
  const f = fixture(t);
  const out = await publish(f.rt, f.actor, { bead_id: 'hive-demo2', text: 'hive-demo2, (hive-123), hive-demo2.1, hive-123.' });
  assert.deepEqual(f.list()[0].relatedBeadIds, ['hive-123', 'hive-demo2.1']);
  assert.deepEqual(f.relations(out.thread_id).beads, ['hive-demo2', 'hive-123', 'hive-demo2.1']);
  await publish(f.rt, f.actor, { thread_id: out.thread_id, text: 'Again hive-123, hive-demo2.' });
  assert.deepEqual(f.relations(out.thread_id).beads, ['hive-demo2', 'hive-123', 'hive-demo2.1']);
  assert.deepEqual(threadList(f.rt, { cellId: f.cell.id }).threads[0].beads, ['hive-demo2', 'hive-123', 'hive-demo2.1']);
});

test('publish allows real ids belonging to another cell without requiring membership there', async t => {
  const f = fixture(t);
  const out = await publish(f.rt, f.actor, { text: 'Related work: hive-9zzz.' });
  assert.deepEqual(f.relations(out.thread_id).beads, ['hive-9zzz']);
});

test('publish leaves messages without bead ids unchanged and ignores skill names and embedded ids', async t => {
  const f = fixture(t);
  const body = 'Use hive-worker and hive-queen with hive_publish; see ABC-123, nothive-zzzz, hive-zzzz_extra, hive-zzzz-suffix.';
  await publish(f.rt, f.actor, { text: body });
  assert.equal(f.list()[0].text, body);
  assert.equal(Object.hasOwn(f.list()[0], 'relatedBeadIds'), false);
});

test('verified mentions in a private request reply do not become public topic relations', async t => {
  const f = fixture(t);
  const { createRequest } = await import('../server/requests.js');
  const { topicRelations } = await import('../server/conversation.js');
  const out = await publish(f.rt, f.actor, { text: 'Public topic' });
  f.rt.metadata.mutate(d => { d.bindings[f.cell.id] = [{ sessionId: 'worker', active: true, role: 'worker' }]; });
  f.rt.host.sessions = { get: () => ({}) };
  f.rt.host.deliver = async () => ({ mode: 'live' });
  const request = await createRequest(f.rt, f.rt.host, 'worker', { title: 'Private question', body: 'Question for queen', thread_id: out.thread_id });
  await publish(f.rt, f.actor, { text: 'Private relation hive-123', reply_to: request.messageId });
  assert.deepEqual(f.list().at(-1).relatedBeadIds, ['hive-123']);
  assert.deepEqual(topicRelations(f.rt, { cellId: f.cell.id, threadId: out.thread_id }).relations.beads, []);
});

test('publish rejects guessed ids of any length, including child ids', async t => {
  const f = fixture(t);
  for (const id of ['hive-abcde', 'hive-abcdefgh1234', 'hive-abcde.12', 'hive-abcde.12.3']) {
    await assert.rejects(publish(f.rt, f.actor, { text: `See ${id}.` }), err => {
      assert.ok(err.message.includes(id));
      assert.match(err.message, /wait for their returned ids/);
      assert.match(err.message, /If this isn.t a bead id, wrap it in backticks/);
      return true;
    });
  }
  assert.deepEqual(f.list(), []);
});

test('ordinary Hive terms publish unchanged unless they name an existing bead', async t => {
  const f = fixture(t);
  const body = 'hive-wide hive-docs hive-cell hive-core hive-mind hive-name hive-api hive-queen hive-worker';
  await publish(f.rt, f.actor, { text: body });
  assert.equal(f.list()[0].text, body);
  assert.equal(Object.hasOwn(f.list()[0], 'relatedBeadIds'), false);
  f.rt.snapshots.graph.beads['hive-wide'] = { id: 'hive-wide', parentId: 'hive-abc', title: 'Existing id' };
  const out = await publish(f.rt, f.actor, { text: 'Actual bead hive-wide' });
  assert.deepEqual(f.relations(out.thread_id).beads, ['hive-wide']);
});


test('inline and block code are plain text rather than bead mentions', async t => {
  const f = fixture(t);
  const bodies = [
    '`hive-abcde hive-123`',
    '``hive-abcde ` hive-123``',
    '```text\nhive-abcde hive-123\n```',
    '~~~text\nhive-abcde hive-123\n~~~',
    '```\nhive-abcde hive-123',
  ];
  const { topicRelations } = await import('../server/conversation.js');
  for (const body of bodies) {
    const out = await publish(f.rt, f.actor, { text: body });
    assert.equal(f.list().at(-1).text, body);
    assert.equal(Object.hasOwn(f.list().at(-1), 'relatedBeadIds'), false);
    assert.deepEqual(topicRelations(f.rt, { cellId: f.cell.id, threadId: out.thread_id }).relations.references, []);
  }
});
