import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import { workTools } from '../server/tools.js';

const valid = {
  hive_request_input: { title: 'Choose an option', body: 'Which option?', kind: 'decision', bead_id: 'a', thread_id: 'thread', blocking: true, dedupe_key: 'choice', expires_at: 2000000000000 },
  hive_list_my_requests: {},
  hive_withdraw_request: { request_id: 'hreq_123456789abc', reason: 'Answered in chat' },
  hive_answer_request: { request_id: 'hreq_123456789abc', revision: 1, route_revision: 1, text: 'Proceed' },
  hive_forward_request: { request_id: 'hreq_123456789abc', revision: 1, route_revision: 1, recommendation: 'Proceed' },
  hive_report_pr_wait: { bead_id: 'a', url: 'https://github.com/example/repo/pull/1', head_sha: 'a'.repeat(40), state: 'ready', reason: 'Reviewed this head' },
  hive_context: {}, hive_ready: { limit: 10 },
  hive_create_beads: { beads: [{ ref: 'api', title: 'API', parent: 'root', goal: 'Build API', summary: 'Ready' }, { ref: 'test', title: 'Test', parent: 'api' }], links: [{ dependent: 'test', prerequisite: 'api' }] },
  hive_update_bead: { bead_id: 'a', parent_id: 'root', add_evidence: [{ label: 'Tests', kind: 'test', detail: 'Passed', url: 'https://example.com' }] },
  hive_link_beads: { links: [{ dependent: 'a', prerequisite: 'b', remove: true }] },
  hive_claim_bead: { bead_id: 'a' }, hive_release_bead: { bead_id: 'a', force: true, reason: 'Handoff' },
  hive_bind_session: { bead_id: 'a', role: 'worker' },
  hive_finish_bead: { bead_id: 'a', outcome: 'done', summary: 'Done', evidence: [{ label: 'Tests' }] },
  hive_delete_beads: { bead_ids: ['a'], reason: 'Mistake' },
  hive_publish: { text: 'Result', attachments: [{ file: 'result.png', alt: 'Result' }] },
  hive_acknowledge_input: { message_ids: ['msg'] }, hive_reconcile_operation: { op_id: 'op' },
  hive_update_thread: { thread_id: 'thread', bead_id: '' },
  hive_spawn_worker: { bead_id: 'a', intent: 'Build', worktree: { auto: true, base: 'main', branch: 'work', folderName: 'work' } },
  hive_request_review: { bead_id: 'a', intent: 'Review', worktree: { auto: true } },
  hive_reconcile_worker_launch: { launch_id: 'launch' },
  hive_review_verdict: { bead_id: 'a', verdict: 'approved', summary: 'Clean' },
  hive_cancel_review: { bead_id: 'a', reason: 'Cancel' },
};
const schemaFor = (tool) => tool.inputSchema instanceof z.ZodObject ? tool.inputSchema : z.object(tool.inputSchema);

for (const tool of workTools) {
  test(`${tool.name} preserves valid calls and rejects unknown root fields before runtime access`, async () => {
    const schema = schemaFor(tool);
    const args = { ...(schema.shape.cell_id ? { cell_id: 'cell' } : {}), ...valid[tool.name] };
    assert.deepEqual(schema.parse(args), args);
    const bad = { ...args, unknown_field: true };
    assert.equal(schema.safeParse(bad).success, false);
    const host = { get stores() { assert.fail('Rejected input reached runtime'); } };
    const out = await tool.handler({ host, caller: 'queen' }, bad);
    assert.equal(out.isError, true);
    assert.match(out.content[0].text, /unknown_field/);
  });
}

const nested = [
  ['hive_create_beads', 'beads', { title: 'Valid' }, { key: 'wrong', parent_id: 'root', parent_key: 'root', description: 'Goal' }, /ref.*parent.*parent.*summary or goal/],
  ['hive_create_beads', 'links', { dependent: 'a', prerequisite: 'b' }],
  ['hive_link_beads', 'links', { dependent: 'a', prerequisite: 'b' }],
  ['hive_update_bead', 'add_evidence', { label: 'Tests' }],
  ['hive_finish_bead', 'evidence', { label: 'Tests' }],
  ['hive_publish', 'attachments', { file: 'image.png' }],
  ['hive_spawn_worker', 'worktree', { auto: true }],
  ['hive_request_review', 'worktree', { auto: true }],
];
for (const [name, field, item, unknown = { misspelled: true }, hints] of nested) {
  test(`${name} rejects unknown keys in ${field} atomically`, async () => {
    const tool = workTools.find((t) => t.name === name);
    const value = { ...item, ...unknown };
    const args = { ...valid[name], [field]: field === 'worktree' ? value : [item, value] };
    const parsed = schemaFor(tool).safeParse(args);
    assert.equal(parsed.success, false);
    for (const key of Object.keys(unknown)) assert.match(parsed.error.message, new RegExp(key));
    if (hints) assert.match(parsed.error.message, hints);
    const host = { get stores() { assert.fail('Rejected input reached runtime'); } };
    const out = await tool.handler({ host }, args);
    assert.equal(out.isError, true);
    for (const key of Object.keys(unknown)) assert.match(out.content[0].text, new RegExp(key));
    assert.match(out.content[0].text, new RegExp(field));
  });
}

for (const name of ['hive_finish_bead', 'hive_review_verdict']) {
  test(`${name} description correction suggests only accepted fields`, async () => {
    const tool = workTools.find((t) => t.name === name);
    const args = { ...valid[name], description: 'Details' };
    const parsed = schemaFor(tool).safeParse(args);
    assert.equal(parsed.success, false);
    assert.match(parsed.error.message, /use summary/);
    assert.doesNotMatch(parsed.error.message, /goal/);
    const out = await tool.handler({}, args);
    assert.match(out.content[0].text, /use summary/);
    assert.doesNotMatch(out.content[0].text, /goal/);
  });
}

for (const field of ['constructor', 'toString', '__proto__']) {
  test(`unknown prototype-like field ${field} gets an ordinary validation error`, async () => {
    const tool = workTools.find((t) => t.name === 'hive_context');
    const args = JSON.parse(`{"${field}": true}`);
    assert.equal(tool.inputSchema.safeParse(args).success, false);
    const out = await tool.handler({}, args);
    assert.equal(out.isError, true);
    assert.ok(out.content[0].text.includes(field));
  });
}

test('hive_request_input advertises options and tells agents to pass them', () => {
  const tool = workTools.find(t => t.name === 'hive_request_input');
  const { shape } = schemaFor(tool);
  assert.ok(shape.options && shape.allow_free_text);
  assert.match(tool.description, /Offer 2-4 options/);
});

test('hive skills tell agents to pass options and never list choices only in the body', async () => {
  const { readFile } = await import('node:fs/promises');
  for (const skill of ['hive-queen', 'hive-worker']) {
    const text = await readFile(new URL(`../skills/${skill}/SKILL.md`, import.meta.url), 'utf8');
    assert.match(text, /always pass `options` and never list the choices only in the body/);
  }
});
