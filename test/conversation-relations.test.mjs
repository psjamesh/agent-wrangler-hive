import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as conversation from '../server/conversation.js';
import { needsHuman } from '../server/requests.js';

const source = fs.readFileSync(new URL('../server/projection.js', import.meta.url), 'utf8');
const start = source.indexOf('function projectConversation(');
const end = source.indexOf('\n// What the browser', start);
const projectConversation = vm.runInNewContext(`${source.slice(start, end)}\nprojectConversation`, { ...conversation, needsHuman, THREAD_WINDOW: 40 });

test('projection does not scan or broadcast topic reference indexes', () => {
  const topic = 'thr_000000000001';
  const doc = { threads: { cell: { [topic]: { id: topic, title: 'Work', count: 2 } } }, inbox: {},
    conversation: { cell: [{ id: 'old', threadId: topic, text: 'hive-one', at: 1 }, { id: 'new', threadId: topic, text: 'hive-two', at: 2 }] } };
  const projected = projectConversation(doc, 'cell');
  assert.equal(projected.topicRelations, undefined);
  assert.equal(projected.threads[0].references, undefined);
  let reads = 0;
  conversation.threadIndex([{ threadId: topic, get text() { reads++; return 'hive-one'; } }]);
  assert.equal(reads, 0, 'ordinary indexing must not read message text');
});

test('lazy topic relations cover all retained messages and drop pruned references', () => {
  const topic = 'thr_000000000001';
  const doc = { cells: { cell: { id: 'cell', enabled: true } }, requests: {}, inbox: {},
    threads: { cell: { [topic]: { id: topic, title: 'Work', beadId: 'hive-anchor', count: 100 } } },
    conversation: { cell: Array.from({ length: 100 }, (_, i) => ({ id: `msg${i}`, threadId: topic, text: i ? 'hive-two' : 'hive-one', n: i+1, at: i })) } };
  const rt = { metadata: { read: () => doc, cell: id => doc.cells[id] } };
  assert.deepEqual(conversation.topicRelations(rt, { cellId: 'cell', threadId: topic }).relations.references, ['hive-one', 'hive-two']);
  doc.conversation.cell.shift();
  assert.deepEqual(conversation.topicRelations(rt, { cellId: 'cell', threadId: topic }).relations.references, ['hive-two']);
  delete doc.threads.cell[topic];
  assert.throws(() => conversation.topicRelations(rt, { cellId: 'cell', threadId: topic }), /Unknown topic/);
});
