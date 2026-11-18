import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const section = name => readFileSync(new URL(`../skills/${name}/SKILL.md`, import.meta.url), 'utf8')
  .split('## Fixed PR review threads\n')[1]?.split('\n## ')[0];

test('worker hands fixed review threads to the queen with drafts and evidence', () => {
  const guidance = section('hive-worker');
  assert.ok(guidance, 'worker needs a fixed-thread handoff');
  for (const required of [/pushed/, /thread links/, /fix commit/, /verification/, /short draft reply/, /queen/, /send_message/, /hive_update_bead/, /queen posts.*resolves/, /every repository/, /PR batch/, /Do not post.*resolve.*human.*approval/s]) {
    assert.match(guidance, required);
  }
});

test('queen batches explicit human approval before posting or resolving fixed threads', () => {
  const guidance = section('hive-queen');
  assert.ok(guidance, 'queen needs a fixed-thread approval step');
  for (const required of [/pushed/, /worker/, /one.*hive_request_input.*PR batch/, /bead_id/, /thread links/, /draft replies/, /Post and resolve/, /Edit/, /Leave it/, /Answer once, in the same topic/, /reply_to.*thread_id/, /Do not also publish/, /explicit human approval/, /every repository/, /outside the human.s organization/, /queen posts.*resolves/, /thread_title/, /Edit.*does not authorize/s, /Leave it.*untouched/s]) {
    assert.match(guidance, required);
  }
});
