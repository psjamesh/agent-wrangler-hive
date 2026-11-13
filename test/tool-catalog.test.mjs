import assert from 'node:assert/strict';
import test from 'node:test';
import { workTools } from '../server/tools.js';

const catalog = Object.fromEntries(workTools.map((t) => [t.name, t.inputSchema._zod.toJSONSchema()]));

test('every tool publishes a self-contained JSON Schema for hosts with an older Zod converter', () => {
  assert.equal(workTools.length, 25);
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
  const revision = catalog.hive_answer_request.properties.revision;
  assert.equal(revision.type, 'integer');
  assert.equal(revision.exclusiveMinimum, 0);
  assert.ok(revision.description);
  const link = catalog.hive_link_beads.properties.links.items.properties;
  assert.equal(link.prerequisite.type, 'string');
  assert.equal(link.prerequisite.$ref, undefined);
});
