import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HiveRuntime } from '../server/runtime.js';
import { MetadataStore } from '../server/metadata-store.js';
import { buildGraph } from '../server/bead-model.js';
import { releaseArchivedClaims } from '../server/archived-claims.js';
import { recoverReviews } from '../server/reviews.js';
import { spawnWorker } from '../server/workers.js';
import { createPrLabelSweep } from '../server/pr-label-discovery.js';
import { recover } from '../server/recovery.js';
import { safeDeliver } from '../server/sessions.js';
import { journaled, settleOne, moveCell, moveBeads } from '../server/ops.js';
import { migrateRegions } from '../server/region-migration.js';
import { renameThread, resolveDeepLink } from '../server/conversation.js';

const queen = '11111111-1111-4111-8111-111111111111';
const worker = '22222222-2222-4222-8222-222222222222';
const pr = 'https://github.com/example/repo/pull/42';
const raw = (id, parent, extra = {}) => ({ id, title: id, status: 'open', metadata: { hive_kind: parent ? 'work' : 'goal' }, dependencies: parent ? [{ issue_id: id, depends_on_id: parent, type: 'parent-child' }] : [], ...extra });
const graph = buildGraph([raw('hive-root'), raw('hive-work', 'hive-root')]);
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-lifetime-'));
  const env = { AW_DATA_DIR: dir, AW_PORT: '0' };
  const rt = new HiveRuntime({ env });
  rt.metadata.mutate(d => { d.cells.cell = { id: 'cell', taskId: 'task', enabled: true, rootBeadId: 'hive-root', queenSessionId: queen }; });
  Object.defineProperty(rt.beads, 'status', { value: { state: 'ready' } });
  rt.beads.probe = async () => ({ state: 'ready' });
  rt.beads.loadSnapshot = async () => graph;
  rt.snapshots = { graph, current: { error: null }, refresh: async () => ({}), invalidate() {} };
  rt.recheck = async () => ({});
  const host = { version: '1.70.0', stores: { hive: rt }, tasks: { forSession: () => ({ taskId: 'task' }) }, sessions: { list: () => [{ sessionId: queen }], get: sid => ({ sessionId: sid, taskId: 'task', archived: sid === worker }) }, links: { get: () => [{ type: 'pr', url: pr }] } };
  rt.attach(host);
  await Promise.resolve();
  await rt.recover();
  t.after(() => { rt.detach(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { rt, host, env, actor: { sessionId: queen, cell: rt.metadata.cell('cell'), role: 'queen' } };
}

async function replace(f) {
  f.rt.detach();
  const replacement = new HiveRuntime({ env: f.env });
  const host = { ...f.host, stores: { hive: replacement } };
  const sweep = createPrLabelSweep({ runtime: replacement, host, labeler: { stop() {}, apply: async () => 'present' }, tracker: { stop() {}, search: async () => [], state: async () => ({ state: 'OPEN', checkedAt: 123 }) } });
  await sweep.run();
  replacement.metadata.mutate(d => { d.cells.replacement = { id: 'replacement', enabled: false }; });
  assert.equal(replacement.metadata.read().prLabels[pr].status, 'labelled');
  return replacement;
}

function survives(f, replacement) {
  const actual = new MetadataStore({ file: f.rt.paths.metadataFile }).read();
  assert.equal(actual.prLabels[pr]?.status, 'labelled');
  assert.deepEqual(actual.cells.replacement, { id: 'replacement', enabled: false });
  assert.deepEqual(actual, replacement.metadata.read());
}

for (const stage of ['archived-launch-cleanup', 'review-verdict-recovery', 'spawn-preflight']) test(`detached ${stage} preserves replacement PRs and unrelated cells`, async t => {
  const f = await fixture(t);
  const entered = deferred(), resume = deferred();
  let job, dispatches = 0;
  if (stage === 'archived-launch-cleanup') {
    f.rt.metadata.mutate(d => { d.workerLaunches.launch = { id: 'launch', beadId: 'hive-work', cellId: 'cell', state: 'binding', sessionId: worker }; });
    f.rt.beads.loadSnapshot = async () => { entered.resolve(); await resume.promise; return graph; };
    job = releaseArchivedClaims(f.rt, f.host);
  } else if (stage === 'review-verdict-recovery') {
    const at = Date.now();
    f.rt.metadata.mutate(d => {
      d.reviews.review = { id: 'review', cellId: 'cell', workBeadId: 'hive-work', state: 'in_review', reviewerSessionId: queen, verdictOpId: 'verdict', verdict: { by: queen, value: 'approved', summary: 'review passed', at } };
      d.operations.verdict = { id: 'verdict', kind: 'review-verdict', actor: `aw:${queen}`, state: 'uncertain', intent: { reviewId: 'review', beadId: 'hive-work', verdict: 'approved' } };
    });
    f.rt.beads.show = async () => { entered.resolve(); await resume.promise; return raw('hive-work', 'hive-root', { metadata: { hive_evidence: [{ label: 'Review review: approved', kind: 'review', detail: 'review passed', by: `aw:${queen}`, at: new Date(at).toISOString() }] } }); };
    job = recoverReviews(f.rt, f.host);
  } else {
    f.rt.beads.loadSnapshot = async () => { entered.resolve(); await resume.promise; return graph; };
    f.host.sessions.spawn = async () => { dispatches++; throw new Error('synthetic dispatch failure'); };
    job = spawnWorker(f.rt, f.host, f.actor, { bead_id: 'hive-work', intent: 'build' });
  }
  const outcome = job.catch(e => e);
  await entered.promise;
  const replacement = await replace(f);
  resume.resolve();
  await outcome;
  assert.equal(dispatches, 0);
  survives(f, replacement);
  if (stage === 'review-verdict-recovery') {
    Object.defineProperty(replacement.beads, 'status', { value: { state: 'ready' } });
    replacement.beads.show = f.rt.beads.show;
    await recoverReviews(replacement, { ...f.host, stores: { hive: replacement } });
    assert.equal(replacement.metadata.read().reviews.review.state, 'approved');
    survives(f, replacement);
  }
});

test('a detached actual runtime snapshot cannot reconcile colours over replacement metadata', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-snapshot-lifetime-'));
  const env = { AW_DATA_DIR: dir, AW_PORT: '0' };
  const rt = new HiveRuntime({ env });
  const f = { rt, env, host: { version: '1.70.0', stores: { hive: rt }, sessions: { list: () => [{ sessionId: queen }], get: sid => ({ sessionId: sid, taskId: 'task' }) }, tasks: { forSession: () => ({ taskId: 'task' }) }, links: { get: () => [{ type: 'pr', url: pr }] } } };
  t.after(() => { rt.detach(); fs.rmSync(dir, { recursive: true, force: true }); });
  rt.metadata.mutate(d => { d.cells.cell = { id: 'cell', taskId: 'task', enabled: true, queenSessionId: queen, rootBeadId: 'hive-root' }; });
  Object.defineProperty(rt.beads, 'status', { value: { state: 'ready' } });
  rt.beads.probe = async () => ({ state: 'ready' });
  const entered = deferred(), resume = deferred();
  let reads = 0;
  rt.beads.loadSnapshot = async () => { reads++; entered.resolve(); await resume.promise; return buildGraph([raw('hive-root'), raw('hive-group', 'hive-root', { metadata: { hive_kind: 'workstream' } })]); };
  rt.attach(f.host);
  await entered.promise;
  const pending = rt.snapshots.refresh();
  const replacement = await replace(f);
  resume.resolve();
  await pending.catch(() => {});
  await Promise.resolve();
  await rt.snapshots.refresh();
  assert.equal(reads, 1);
  survives(f, replacement);
  assert.equal(new MetadataStore({ file: rt.paths.metadataFile }).read().workstreamColours.cell, undefined);
});

for (const failed of [false, true]) test(`a ${failed ? 'failed' : 'successful'} dispatch completing after detach leaves its reservation recoverable`, async t => {
  const f = await fixture(t), entered = deferred(), resume = deferred();
  f.host.sessions.spawn = async () => { entered.resolve(); await resume.promise; if (failed) throw new Error('late dispatch failure'); return { sessionId: worker }; };
  const job = spawnWorker(f.rt, f.host, f.actor, { bead_id: 'hive-work', intent: 'build' }).catch(e => e);
  await entered.promise;
  const replacement = await replace(f);
  resume.resolve();
  await job;
  survives(f, replacement);
  assert.equal(Object.values(replacement.metadata.read().workerLaunches)[0].state, 'reserved');
});

test('detaching during a changes-requested work read prevents delivery and preserves the replacement', async t => {
  const f = await fixture(t), entered = deferred(), resume = deferred();
  let delivered = 0;
  f.host.deliver = async () => { delivered++; return { mode: 'live' }; };
  f.rt.metadata.mutate(d => { d.reviews.review = { id: 'review', cellId: 'cell', workBeadId: 'hive-work', state: 'changes_requested', summary: 'fix it', verdict: { by: queen } }; });
  f.rt.beads.show = async () => { entered.resolve(); await resume.promise; return raw('hive-work', 'hive-root', { assignee: `aw:${worker}` }); };
  const job = recoverReviews(f.rt, f.host);
  await entered.promise;
  const replacement = await replace(f);
  resume.resolve();
  await job;
  assert.equal(delivered, 0);
  await assert.rejects(safeDeliver(f.host, queen, 'late delivery', f.rt), { code: 'runtime-stopped' });
  assert.equal(delivered, 0);
  survives(f, replacement);
});

test('a retired runtime cannot be reattached to revive its old writers with the same host', async t => {
  const f = await fixture(t);
  const replacement = await replace(f);
  assert.throws(() => f.rt.attach(f.host), { code: 'runtime-stopped' });
  assert.throws(() => f.rt.metadata.mutate(d => { d.cells.bad = {}; }), { code: 'runtime-stopped' });
  survives(f, replacement);
});

test('a replaced runtime stops its pending PR sweep even without a sweep stop callback', async t => {
  const f = await fixture(t), entered = deferred(), resume = deferred();
  let reads = 0;
  f.rt.metadata.mutate(d => { d.prLabels[pr] = { url: pr, source: 'session-link', status: 'labelled' }; });
  const sweep = createPrLabelSweep({ runtime: f.rt, host: f.host, labeler: { stop() {}, apply: async () => 'present' }, tracker: { stop() {}, search: async () => { entered.resolve(); await resume.promise; return []; }, state: async () => { reads++; return { state: 'OPEN', checkedAt: 123 }; } } });
  const job = sweep.run();
  await entered.promise;
  const replacement = new HiveRuntime({ env: f.env });
  f.host.stores.hive = replacement;
  replacement.metadata.mutate(d => { d.cells.replacement = { id: 'replacement', enabled: false }; });
  resume.resolve();
  await job;
  assert.equal(reads, 0);
  survives(f, replacement);
});

test('replacement recovery does not share the detached runtime pending pass', async t => {
  const f = await fixture(t), entered = deferred(), resume = deferred();
  f.rt.beads.loadSnapshot = async () => { entered.resolve(); await resume.promise; return graph; };
  const pending = recover(f.rt, f.host);
  await entered.promise;
  const replacement = await replace(f);
  Object.defineProperty(replacement.beads, 'status', { value: { state: 'ready' } });
  let checked = false;
  replacement.beads.loadSnapshot = async () => { checked = true; return graph; };
  const host = { ...f.host, stores: { hive: replacement } };
  replacement.host = host;
  const next = recover(replacement, host);
  const shared = pending === next;
  resume.resolve();
  await Promise.all([pending, next]);
  assert.equal(shared, false);
  assert.equal(checked, true);
  survives(f, replacement);
});

test('replacement recovery observes a started native outcome whose old receipt was retired', async t => {
  const f = await fixture(t), entered = deferred(), resume = deferred();
  let nativeClaim = false;
  const job = journaled(f.rt, { kind: 'claim', beadIds: ['hive-work'], actor: `aw:${worker}`, intent: { beadId: 'hive-work', assignee: `aw:${worker}` } }, async (_id, phase) => {
    phase.attempted = true;
    entered.resolve();
    await resume.promise;
    nativeClaim = true;
    phase.applied = true;
  }).catch(e => e);
  await entered.promise;
  const replacement = await replace(f);
  const op = Object.values(replacement.metadata.read().operations)[0];
  resume.resolve();
  await job;
  assert.equal(nativeClaim, true);
  survives(f, replacement);
  assert.equal(replacement.metadata.read().operations[op.id].state, 'pending');
  replacement.beads.show = async () => raw('hive-work', 'hive-root', { assignee: `aw:${worker}`, status: 'in_progress' });
  t.mock.method(Date, 'now', () => op.updatedAt + 20 * 60000);
  assert.equal((await settleOne(replacement, op.id)).settled, true);
  assert.equal(replacement.metadata.read().operations[op.id].state, 'applied');
  survives(f, replacement);
});

test('detachment inside a metadata callback refuses the whole stale save', async t => {
  const f = await fixture(t);
  const bytes = fs.readFileSync(f.rt.paths.metadataFile, 'utf8');
  assert.throws(() => f.rt.metadata.mutate(d => { d.cells.bad = {}; f.rt.detach(); }), { code: 'runtime-stopped' });
  assert.equal(fs.readFileSync(f.rt.paths.metadataFile, 'utf8'), bytes);
  assert.equal(f.rt.metadata.read().cells.bad, undefined);
});

for (const write of ['region migration', 'overview layout', 'bead layout', 'conversation topic']) test(`retired ${write} cannot replace current PR, region or conversation records`, async t => {
  const f = await fixture(t);
  const replacement = await replace(f);
  replacement.metadata.mutate(d => {
    d.regionLayout.cell = 1;
    d.beadLayout.cell = { 'hive-work': { q: 7, r: 9 } };
    d.conversation.cell = [{ id: 'message', text: 'replacement message' }];
  });
  const run = write === 'region migration' ? () => migrateRegions(f.rt.metadata, graph.beads)
    : write === 'overview layout' ? () => moveCell(f.rt, { cellId: 'cell', position: { q: 1, r: 2 } })
      : write === 'bead layout' ? () => moveBeads(f.rt, { cellId: 'cell', positions: { 'hive-work': null } })
        : () => renameThread(f.rt, { cellId: 'cell', threadId: 'thr_123456789abc', title: 'stale title' });
  assert.throws(run, { code: 'runtime-stopped' });
  resolveDeepLink(f.rt, { cellId: 'cell' });
  survives(f, replacement);
});
