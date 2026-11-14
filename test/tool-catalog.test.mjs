import assert from 'node:assert/strict';
import test from 'node:test';
import { workTools, publishTool } from '../server/tools.js';

const catalog = Object.fromEntries(workTools.map((t) => [t.name, t.inputSchema._zod.toJSONSchema()]));

test('every tool publishes a self-contained JSON Schema for hosts with an older Zod converter', () => {
  assert.equal(workTools.length, 27);
  for (const [name, schema] of Object.entries(catalog)) {
    assert.equal(schema.type, 'object', name);
    assert.equal(schema.additionalProperties, false, name);
    assert.equal(schema.$schema, undefined, name);
    if (schema.properties.cell_id) {
      assert.equal(schema.properties.cell_id.maxLength, 80, name);
      assert.match(schema.properties.cell_id.description, /exactly one enabled cell/, name);
    }
  }
});

test('catalog keeps constraints and descriptions agents rely on', () => {
  const input = catalog.hive_request_input.properties;
  assert.equal(input.options.maxItems, 6);
  assert.equal(input.options.items.properties.id.pattern, '^[a-z0-9][a-z0-9-]{0,31}$');
  assert.match(input.options.items.properties.label.description, /\(Recommended\)/);
  assert.equal(input.options.items.properties.label.maxLength, 80);
  assert.equal(input.title.maxLength, 200);
  assert.equal(input.reply_to.maxLength, 80);
  assert.match(input.reply_to.description, /message/i);
  const revision = catalog.hive_answer_request.properties.revision;
  assert.equal(revision.type, 'integer');
  assert.equal(revision.exclusiveMinimum, 0);
  assert.ok(revision.description);
  const link = catalog.hive_link_beads.properties.links.items.properties;
  assert.equal(link.prerequisite.type, 'string');
  assert.equal(link.prerequisite.$ref, undefined);
});

for (const tool of [publishTool, workTools.find(t => t.name === 'hive_request_input')]) test(`${tool.name} accepts optional session links with bounded labels`, () => {
  const base = tool.name === 'hive_publish' ? { text: 'Inspect the session.' } : { title: 'Inspect session', body: 'Approve the command there.' };
  assert.equal(tool.inputSchema.safeParse(base).success, true);
  assert.equal(tool.inputSchema.safeParse({ ...base, session_id: '22222222-2222-4222-8222-222222222222', session_label: 'Build session' }).success, true);
  assert.equal(tool.inputSchema.safeParse({ ...base, session_id: 'not-a-session' }).success, false);
  assert.equal(tool.inputSchema.safeParse({ ...base, session_label: 'x'.repeat(201) }).success, false);
});


test('request images share publish schema limits and describe private forwarding', () => {
  const images = catalog.hive_request_input.properties.attachments;
  const published = publishTool.inputSchema._zod.toJSONSchema().properties.attachments;
  assert.equal(images.maxItems, 4);
  assert.deepEqual(images.items, published.items);
  assert.match(images.description, /All requesters/);
  assert.match(images.description, /shared staging/);
  assert.match(images.description, /session-prefixed filename with a random suffix/);
  assert.match(images.description, /Never overwrite/);
  assert.match(images.description, /forwarding/);
});
