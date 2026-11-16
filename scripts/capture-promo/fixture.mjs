import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const SESSIONS = {
  queen: { id: '11111111-1111-4111-8111-111111111111', name: 'Guide coordinator', agent: 'claude', model: 'opus', intent: 'Coordinate the field guide launch.' },
  search: { id: '22222222-2222-4222-8222-222222222222', name: 'Search builder', agent: 'codex', model: 'gpt-6.1-sol', intent: 'Build the species search page.' },
  cover: { id: '33333333-3333-4333-8333-333333333333', name: 'Cover designer', agent: 'claude', model: 'sonnet', intent: 'Prepare cover options.' },
  reviewer: { id: '44444444-4444-4444-8444-444444444444', name: 'Reviewer', agent: 'claude', model: 'opus', intent: 'Review the search page.' },
};

export const TASKS = [
  { id: 't_field001', name: 'Launch a field guide' },
  { id: 't_garden01', name: 'Plan the community garden' },
  { id: 't_cafe0001', name: 'Redesign the repair cafe site' },
];

export function writeFixtureFiles(dataDir, cwd = '/work/field-guide') {
  mkdirSync(dataDir, { recursive: true });
  const now = Date.now() - 3 * 3600_000;
  const mappings = {};
  for (const s of Object.values(SESSIONS)) {
    mappings[s.id] = { agent: s.agent, model: s.model, cwd, intent: s.intent, name: s.name, lastLabel: s.name, runtime: 'local', createdAt: now, lastActivity: now };
  }
  writeFileSync(join(dataDir, 'mappings.json'), JSON.stringify(mappings, null, 2));
  const assignments = Object.fromEntries(Object.values(SESSIONS).map(s => [s.id, 't_field001']));
  writeFileSync(join(dataDir, 'tasks.json'), JSON.stringify({
    tasks: TASKS.map(t => ({ ...t, links: [] })),
    order: [...TASKS.map(t => t.id), 'adhoc'],
    assignments,
    sessionOrder: {},
  }, null, 2));
}
