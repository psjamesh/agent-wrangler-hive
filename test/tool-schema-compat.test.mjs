import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { schema } from './helpers/host-schema.mjs';
import { workTools } from '../server/tools.js';

const core = process.env.HIVE_TEST_CORE;
// Captured before the fix through MCP SDK 1.32.0 with host Zod 3.25.76.
const baseline = JSON.parse(readFileSync(new URL('./fixtures/tool-schema-hashes.json', import.meta.url)));

function canonical(value) {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonical);
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}

test('all Hive tools retain their baseline JSON through the host MCP SDK', { skip: !core }, async t => {
  const load = file => import(pathToFileURL(path.resolve(core, 'node_modules', file)).href);
  const [{ normalizeObjectSchema }, { toJsonSchemaCompat }] = await Promise.all([
    load('@modelcontextprotocol/sdk/dist/esm/server/zod-compat.js'),
    load('@modelcontextprotocol/sdk/dist/esm/server/zod-json-schema-compat.js'),
  ]);
  const { toolInputSchema } = await import(pathToFileURL(path.resolve(core, 'server/extensions/tool-schema.js')).href);
  const { version } = JSON.parse(readFileSync(path.resolve(core, 'node_modules/zod/package.json')));
  t.diagnostic(`Host Zod ${version}; ${workTools.length} Hive tools`);
  assert.deepEqual(workTools.map(tool => tool.name).sort(), Object.keys(baseline).sort());
  for (const tool of workTools) {
    await t.test(tool.name, () => {
      const converted = toolInputSchema({ ...tool, extId: 'hive' }, () => ({ schema }));
      assert.ok(converted, 'core must register the factory without a schema failure');
      const normalized = normalizeObjectSchema(tool.inputSchema({ host: { schema } }));
      assert.ok(normalized);
      const json = toJsonSchemaCompat(normalized);
      assert.deepEqual(JSON.parse(JSON.stringify(json)), converted.jsonSchema);
      assert.equal(json.type, 'object');
      assert.equal(json.additionalProperties, false);
      const hash = createHash('sha256').update(JSON.stringify(canonical(json))).digest('hex');
      assert.equal(hash, baseline[tool.name], 'JSON differs from the pre-fix Zod 3.25.76 host output');
    });
  }
});

test('factories and handlers use the supplied host Zod on every invocation', async () => {
  let objects = 0;
  const host = { schema: { z: new Proxy({ ...schema.z }, {
    get(target, key) {
      if (key === 'object') return (...args) => { objects++; return target.object(...args); };
      return Reflect.get(target, key);
    },
  }) }, get stores() { assert.fail('Invalid input reached runtime'); } };
  for (const tool of workTools) {
    assert.equal(typeof tool.inputSchema, 'function');
    const first = tool.inputSchema({ host });
    const second = tool.inputSchema({ host });
    assert.notEqual(first, second);
    assert.equal(first.safeParse({ unknown_field: true }).success, false);
    const before = objects;
    const out = await tool.handler({ host }, { unknown_field: true });
    assert.ok(objects > before, tool.name);
    assert.equal(out.isError, true);
    assert.ok(JSON.parse(out.content[0].text.slice('Hive: invalid input: '.length)).some(issue => issue.message === 'Unknown field "unknown_field"'));
  }
});
