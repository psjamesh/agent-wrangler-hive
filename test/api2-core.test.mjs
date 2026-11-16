import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createManifest } from '../server/manifest.js';
import client, { send } from '../public/client.js';

const core = process.env.HIVE_TEST_CORE;
const load = file => import(pathToFileURL(path.resolve(core, file)).href);

test('Hive loads on core API 2 and uses state and actions without deprecation reports', { skip: !core }, async t => {
  const [{ loadExtensions }, deckLegacy, boardLegacy, { createSlots }] = await Promise.all([
    load('server/extensions/index.js'), load('server/deck/legacy.js'),
    load('public/legacy-surface.js'), load('public/slots.js'),
  ]);
  const warnings = [], reports = [], errors = [];
  t.mock.method(console, 'warn', message => warnings.push(String(message)));
  deckLegacy.resetLegacyWarnings();
  boardLegacy.resetLegacyWarnings();
  deckLegacy.setLegacyReporter((...args) => reports.push(args));
  boardLegacy.setLegacyReporter((...args) => { reports.push(args); return true; });
  t.after(() => { deckLegacy.setLegacyReporter(null); boardLegacy.resetLegacyWarnings(); });
  const manifest = createManifest({ dir: path.resolve('.') });
  const loaded = loadExtensions({ cfg: { extensions: { hive: { enabled: true } } }, builtin: [{ ...manifest, defaultEnabled: true }] });
  assert.equal(loaded.list.find(e => e.id === 'hive').quarantine, null);
  assert.equal(loaded.clientManifest[0].boardApi, '^2.0.0');
  const element = () => ({ dataset: {}, children: [], appendChild(child) { this.children.push(child); }, removeChild(child) { this.children = this.children.filter(c => c !== child); } });
  const slots = createSlots({ document: { createElement: element }, storage: null, onError: error => errors.push(error), handlerTypesFor: () => manifest.handlers.map(h => h.type) });
  const calls = [];
  const base = { act: async (...args) => { calls.push(args); return { ok: true, data: { ok: true, bead: { id: 'a' } } }; } };
  const registrar = slots.forExtension('hive', base);
  client.register({ ...registrar, register(kind, contribution) {
    registrar.register(kind, { ...contribution, mount() {}, update(_el, session, graph) { contribution.update(null, session, graph); } });
  } });
  const graph = { sessions: [], hive: { metadataError: 'unavailable' } };
  slots.setExtState({ hive: { hive: graph.hive } });
  let badge;
  slots.syncHosts('view', [{ host: element() }], base, graph, row => { badge = row.count; });
  assert.equal(badge, 0);
  let reply;
  send({ type: 'hive-bead-detail', beadId: 'a' }, { quiet: true, onReply: value => { reply = value; } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls[0][0], 'hive');
  assert.equal(calls[0][1], 'hive-bead-detail');
  assert.deepEqual(reply.bead, { id: 'a' });
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
  assert.deepEqual(reports, []);
});
