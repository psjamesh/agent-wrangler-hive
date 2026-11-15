import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('worker orchestration routes session instructions through a tracked helper', () => {
  const skill = readFileSync(new URL('../skills/hive-worker/SKILL.md', import.meta.url), 'utf8');
  const orchestration = skill.split('## Orchestration inside Hive\n')[1].split('\n## ')[0];
  const paragraph = orchestration.split('\n\n').find(text => /another skill, a brief or the task/.test(text));
  assert.ok(paragraph, 'orchestration must cover session instructions from other sources');
  assert.match(paragraph, /start or spawn another (?:agent )?session/);
  assert.match(paragraph, /hive_spawn_worker\(bead_id, role: "helper", \.\.\.\)/);
  assert.match(paragraph, /own bead/);
  assert.match(paragraph, /agent.*,.*model.*and.*cwd/);
  assert.match(paragraph, /takes precedence over.*spawn_session.*other skills/);
  assert.match(paragraph, /[Ii]ndependent work.*own bead.*queen/);
  assert.doesNotMatch(paragraph, /browser/i);
});
