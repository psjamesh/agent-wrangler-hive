import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { openDescendants } from '../server/bead-model.js';

const bead = (id, parentId, status) => ({ id, parentId, status });
const beads = Object.fromEntries([
  bead('root', null, 'open'),
  bead('ws', 'root', 'in_progress'),
  bead('a', 'ws', 'open'),
  bead('b', 'ws', 'closed'),
  bead('c', 'b', 'blocked'),
  bead('done', 'root', 'closed'),
  bead('d', 'done', 'closed'),
  bead('leaf', 'root', 'open'),
].map((b) => [b.id, b]));

test('openDescendants lists unfinished beads at any depth, excluding the bead itself', () => {
  assert.deepEqual(openDescendants(beads, 'ws').sort(), ['a', 'c']);
  assert.deepEqual(openDescendants(beads, 'root').sort(), ['a', 'c', 'leaf', 'ws']);
});

test('openDescendants is empty for leaves and fully closed subtrees', () => {
  assert.deepEqual(openDescendants(beads, 'leaf'), []);
  assert.deepEqual(openDescendants(beads, 'done'), []);
});

test('hive-queen skill requires open descendants and demonstrated intent before proposing a close', () => {
  const skill = fs.readFileSync(new URL('../skills/hive-queen/SKILL.md', import.meta.url), 'utf8');
  assert.match(skill, /Before proposing to close a goal or workstream, list its open descendants/);
  assert.match(skill, /open_descendants/);
  assert.match(skill, /intent, not only its ticked criteria/);
});
