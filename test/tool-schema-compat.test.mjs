import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { workTools } from '../server/tools.js';

const core = process.env.HIVE_TEST_CORE;
// Captured before the fix through MCP SDK 1.32.0 with host Zod 3.25.76.
const baseline = JSON.parse(readFileSync(new URL('./fixtures/tool-schema-hashes.json', import.meta.url)));

function canonical(value) {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonical);
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}

test('all Hive tools retain their Zod 3 host JSON through the host MCP SDK', { skip: !core }, async t => {
  const load = file => import(pathToFileURL(path.resolve(core, 'node_modules', file)).href);
  const [{ normalizeObjectSchema }, { toJsonSchemaCompat }] = await Promise.all([
    load('@modelcontextprotocol/sdk/dist/esm/server/zod-compat.js'),
    load('@modelcontextprotocol/sdk/dist/esm/server/zod-json-schema-compat.js'),
  ]);
  const { version } = JSON.parse(readFileSync(path.resolve(core, 'node_modules/zod/package.json')));
  t.diagnostic(`Host Zod ${version}; ${workTools.length} Hive tools`);
  assert.deepEqual(workTools.map(tool => tool.name).sort(), Object.keys(baseline).sort());
  for (const tool of workTools) {
    await t.test(tool.name, () => {
      const normalized = normalizeObjectSchema(tool.inputSchema);
      assert.ok(normalized);
      const json = toJsonSchemaCompat(normalized);
      assert.equal(json.type, 'object');
      assert.equal(json.additionalProperties, false);
      const hash = createHash('sha256').update(JSON.stringify(canonical(json))).digest('hex');
      assert.equal(hash, baseline[tool.name], 'JSON differs from the pre-fix Zod 3.25.76 host output');
    });
  }
});
