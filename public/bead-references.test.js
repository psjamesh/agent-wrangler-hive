import test from 'node:test';
import assert from 'node:assert/strict';
import { beadReferences } from './bead-references.js';

test('bead mentions exclude code spans while keeping surrounding prose', () => {
  assert.deepEqual(beadReferences('hive-one `hive-two` hive-three ``hive-four ` quoted`` hive-five'), ['hive-one', 'hive-three', 'hive-five']);
  assert.deepEqual(beadReferences('\\`hive-one\\` and hive-two'), ['hive-one', 'hive-two']);
});

test('fenced blocks exclude mentions until a matching closing fence', () => {
  assert.deepEqual(beadReferences('hive-one\n````text\nhive-two\n```\nhive-three\n````\nhive-four'), ['hive-one', 'hive-four']);
  assert.deepEqual(beadReferences('~~~text\nhive-one\n~~~\nhive-two'), ['hive-two']);
  assert.deepEqual(beadReferences('```text\nhive-one'), []);
});
