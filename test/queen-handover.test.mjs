import test from 'node:test';
import assert from 'node:assert/strict';
import { launchQueen, onBeforeDispatch, reconcileLaunch } from '../server/sessions.js';
import { configHandlers } from '../server/handlers.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MetadataStore } from '../server/metadata-store.js';
import { createManifest, skillsFor, hideTool } from '../server/manifest.js';

function fixture() {
  let doc = { cells: { cell: { id: 'cell', taskId: 'task', enabled: true, queenSessionId: 'old', queens: [{ sessionId: 'old', via: 'nominated' }], queenGeneration: 1 } }, launches: {}, bindings: {} };
  const board = new Map([['old', { sessionId: 'old', taskId: 'task', name: 'Old queen', agent: 'codex', runtime: 'local', mailCapable: true }], ['cross', { sessionId: 'cross', taskId: 'other', name: 'Context', agent: 'claude', runtime: 'local', mailCapable: true }]]);
  const rt = { pendingParticipants: new Map(), metadata: { read: () => doc, cell: (id) => doc.cells[id], mutate(fn) { const d = structuredClone(doc); fn(d); doc = d; } }, changed() {}, log() {}, projection: () => ({}) };
  let spawned;
  const host = { stores: { hive: rt }, tasks: { get: (id) => ({ name: id }) }, sessions: { get: (id) => board.get(id), list: () => [...board.values()], spawn: async (opts) => { spawned = opts; onBeforeDispatch({ sessionId: 'fresh', ext: opts.ext.hive, host }); assert.equal(doc.cells.cell.queenSessionId, 'fresh'); assert(skillsFor({ sessionId: 'fresh', host }).includes('hive-queen')); assert.equal(hideTool({ host, caller: 'fresh', tool: 'hive_context' }), false); return { sessionId: 'fresh' }; } } };
  return { rt, host, board, doc: () => doc, spawned: () => spawned };
}
const handle = async (f, type, msg) => { let out; await configHandlers.find(h => h.type === type).handler(msg, f.host, r => { out = r; }); return out; };

test('ordinary nomination and adoption reuse are refused before any mutation', async () => {
  const f = fixture(); const before = structuredClone(f.doc());
  for (const [type, msg] of [['hive-queen-nominate', { cellId: 'cell', sessionId: 'cross', instructions: 'changed' }], ['hive-cell-adopt', { taskId: 'other', queenSessionId: 'cross' }]]) {
    const out = await handle(f, type, msg);
    assert.equal(out.ok, false); assert.match(out.error, /launch.*new queen/i); assert.deepEqual(f.doc(), before);
  }
});
for (const archive of [undefined, false]) test(`launch persists source and archive ${archive} and briefs the bound queen`, async () => {
  const f = fixture();
  const out = await handle(f, 'hive-queen-launch', { cellId: 'cell', handoverSourceSessionId: 'old', archiveSourceAfterHandover: archive });
  assert.equal(out.ok, true);
  const rec = f.doc().launches[out.launchId];
  assert.equal(rec.handoverSourceSessionId, 'old'); assert.equal(rec.archiveSourceAfterHandover, archive !== false);
  assert.match(f.spawned().intent, /send_message/); assert(f.spawned().intent.includes(out.launchId)); assert(f.spawned().intent.includes('old'));
  assert.match(f.spawned().intent, new RegExp(`Archive-after-handover: ${archive === false ? 'NO' : 'YES'}`));
  assert.equal(f.doc().cells.cell.queens[0].via, 'nominated');
  assert.equal(f.doc().cells.cell.queenSessionId, 'fresh');
});
test('no-source launch cannot request archival', async () => {
  const f = fixture(); const out = await launchQueen(f.rt, f.host, { cellId: 'cell', archiveSourceAfterHandover: true });
  assert.equal(f.doc().launches[out.launchId].handoverSourceSessionId, null);
  assert.equal(f.doc().launches[out.launchId].archiveSourceAfterHandover, false);
  assert.doesNotMatch(f.spawned().intent, /Request a handover from session/);
  assert(f.spawned().intent.includes(out.launchId));
  assert.match(f.spawned().intent, /no handover, no archive/);
});
for (const [name, patch] of [['archived', { archived: true }], ['unnamed', { name: '', lastLabel: '' }], ['non-mail', { mailCapable: false, runtime: 'remote' }]]) test(`source validation rejects ${name} without changing nomination or spawning`, async () => {
  const f = fixture(); Object.assign(f.board.get('old'), patch);
  await assert.rejects(launchQueen(f.rt, f.host, { cellId: 'cell', handoverSourceSessionId: 'old' }), /handover source/i);
  assert.equal(f.doc().cells.cell.queenSessionId, 'old'); assert.equal(f.spawned(), undefined); assert.deepEqual(f.doc().launches, {});
});
test('unknown and cross-task replacement sources are rejected', async () => {
  for (const id of ['unknown', 'cross']) {
    const f = fixture(); await assert.rejects(launchQueen(f.rt, f.host, { cellId: 'cell', handoverSourceSessionId: id }), /handover source/i);
  }
});
test('explicit new-hive context allows cross-task source without moving it', async () => {
  const f = fixture(); await launchQueen(f.rt, f.host, { cellId: 'cell', handoverSourceSessionId: 'cross', allowCrossTaskSource: true });
  assert.equal(f.board.get('cross').taskId, 'other');
});
test('source is revalidated on create before creating a task', async () => {
  const f = fixture(); const out = await handle(f, 'hive-cell-create', { name: 'New', queen: { handoverSourceSessionId: 'unknown' } });
  assert.equal(out.ok, false); assert.match(out.error, /handover source/i);
});
test('uncertain launch preserves the selected source and reconciles without a second spawn', async () => {
  const f = fixture(); f.host.sessions.spawn = async () => { onBeforeDispatch({ sessionId: 'fresh', ext: { launchId: Object.keys(f.doc().launches)[0] }, host: f.host }); throw new Error('interrupted'); };
  await assert.rejects(launchQueen(f.rt, f.host, { cellId: 'cell', handoverSourceSessionId: 'old' }), /Reconcile/);
  const rec = Object.values(f.doc().launches)[0]; assert.equal(rec.state, 'uncertain'); assert.equal(rec.handoverSourceSessionId, 'old');
  f.board.set('fresh', { sessionId: 'fresh', taskId: 'task' });
  assert.equal(reconcileLaunch(f.rt, f.host, { launchId: rec.id }).state, 'launched');
});
test('graph offers eligible sources with task labels through existing session reads', () => {
  const f = fixture(); const g = createManifest({ dir: '.' }).graph({ host: f.host });
  assert.equal(g.hive.handoverSources.length, 2); assert.equal(g.hive.handoverSources[1].taskName, 'other');
});

test('source and archive selection survives a metadata reload', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-4gh-record-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'metadata.json');
  const f = fixture(), metadata = new MetadataStore({ file });
  metadata.mutate(d => { d.cells = f.doc().cells; });
  f.rt.metadata = metadata;
  f.host.sessions.spawn = async opts => {
    onBeforeDispatch({ sessionId: 'fresh', ext: opts.ext.hive, host: f.host });
    return { sessionId: 'fresh' };
  };
  const out = await launchQueen(f.rt, f.host, { cellId: 'cell', handoverSourceSessionId: 'old', archiveSourceAfterHandover: false });
  const reloaded = new MetadataStore({ file }).read();
  assert.equal(reloaded.launches[out.launchId].handoverSourceSessionId, 'old');
  assert.equal(reloaded.launches[out.launchId].archiveSourceAfterHandover, false);
  assert.equal(reloaded.cells.cell.queenSessionId, 'fresh');
});
test('malformed source and archive settings fail without creating a task or changing instructions', async () => {
  for (const queen of [{ handoverSourceSessionId: {} }, { archiveSourceAfterHandover: 'false' }]) {
    const f = fixture();
    const out = await handle(f, 'hive-cell-create', { name: 'New', instructions: 'Do not save', queen });
    assert.equal(out.ok, false); assert.match(out.error, /source|checkbox/i);
    assert.equal(f.doc().cells.cell.queenInstructions, undefined);
  }
});
