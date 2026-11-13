import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HiveRuntime } from '../server/runtime.js';
import { collectWatchdog, createWatchdog, setWatchdogSettings } from '../server/watchdog.js';

const MIN = 60000;
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-watchdog-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const rt = new HiveRuntime({ env: { AW_DATA_DIR: dir } });
  let now = 200000000;
  const sessions = { queen: {}, worker: { status: 'working', lastActivity: now } };
  const sent = [];
  const host = { stores: { hive: rt }, sessions: { get: id => sessions[id] }, deliver: async (id, text) => { sent.push({ id, text }); return { mode: 'live' }; } };
  rt.metadata.lifetime.attach(rt, host);
  const beads = { root: { id: 'root', status: 'open' }, work: { id: 'work', parentId: 'root', status: 'in_progress', ownerSessionId: 'worker', updatedAt: now } };
  rt.snapshots = { current: { loadedAt: now, error: null, graph: { beads, edges: [] } }, get graph() { return this.current.graph; } };
  rt.beads.status.state = 'ready';
  rt.metadata.mutate(d => { d.cells.cell = { id: 'cell', rootBeadId: 'root', enabled: true, queenSessionId: 'queen' }; });
  const watchdog = createWatchdog({ runtime: rt, host, now: () => now });
  const flags = () => collectWatchdog(rt, host, rt.metadata.cell('cell'), now);
  return { rt, host, sessions, beads, sent, watchdog, flags, now: () => now, advance: ms => { now += ms; } };
}

test('each timed condition flags at its boundary and carries subject, reason and age', t => {
  const f = fixture(t);
  f.rt.metadata.mutate(d => {
    d.reviews.r = { id: 'r', cellId: 'cell', workBeadId: 'work', reviewerSessionId: 'reviewer', state: 'requested', createdAt: f.now() };
    d.conversation.cell = [{ id: 'message', author: 'human', at: f.now(), response: { required: true }, beadId: 'work' }];
  });
  f.beads.work.waitingFor = 'prerequisite';
  assert.deepEqual(f.flags(), []);
  f.advance(30 * MIN);
  assert.deepEqual(f.flags().map(x => x.kind), ['unanswered_message']);
  f.advance(30 * MIN);
  assert.deepEqual(f.flags().map(x => x.kind).sort(), ['stuck_review', 'unanswered_message']);
  f.advance(23 * 60 * MIN);
  assert.deepEqual(f.flags().map(x => x.kind).sort(), ['stale_wait', 'stuck_review', 'unanswered_message']);
  const wait = f.flags().find(x => x.kind === 'stale_wait');
  assert.equal(wait.bead_id, 'work'); assert.equal(wait.session_id, 'worker');
  assert.equal(wait.age_ms, 24 * 60 * MIN); assert.match(wait.reason, /wait/i);
  f.rt.metadata.mutate(d => { d.reviews.r.state = 'approved'; d.conversation.cell[0].response.answers = [{ messageId: 'answer' }]; d.conversation.cell.push({ id: 'answer', author: 'session', sessionId: 'queen', at: f.now() }); });
  f.beads.work.waitingFor = '';
  assert.deepEqual(f.flags(), []);
});

test('idle workers, exited and errored claims flag; handoffs suppress idle only', t => {
  const f = fixture(t);
  f.sessions.worker.status = 'idle';
  f.advance(30 * MIN - 1); assert.deepEqual(f.flags(), []);
  f.advance(1); assert.equal(f.flags()[0].kind, 'stalled_worker');
  f.sessions.worker.status = 'working'; assert.deepEqual(f.flags(), []);
  f.sessions.worker.status = 'idle';
  for (const status of ['blocked', 'deferred']) { f.beads.work.status = status; f.beads.work.waitingFor = 'prerequisite'; assert.deepEqual(f.flags(), []); }
  f.beads.work.status = 'in_progress'; f.beads.work.waitingFor = 'Waiting for merge'; assert.deepEqual(f.flags(), []);
  for (const status of ['exited', 'error']) { f.sessions.worker.status = status; assert.equal(f.flags()[0].kind, 'stalled_worker'); }
  f.beads.work.status = 'closed'; assert.deepEqual(f.flags(), []);
});

test('open input and review suppress idle; approval grants a bounded grace', t => {
  const f = fixture(t); f.sessions.worker.status = 'idle'; f.advance(90 * MIN);
  f.rt.metadata.mutate(d => { d.requests.r = { state: 'open', cellId: 'cell', requesterSessionId: 'worker' }; });
  assert.deepEqual(f.flags(), []);
  f.rt.metadata.mutate(d => { d.requests.r.state = 'answered'; d.reviews.r = { id: 'r', state: 'in_review', cellId: 'cell', workBeadId: 'work', createdAt: f.now() }; });
  assert.deepEqual(f.flags(), []);
  f.rt.metadata.mutate(d => { Object.assign(d.reviews.r, { state: 'approved', completedAt: f.now() }); });
  f.advance(30 * MIN - 1); assert.deepEqual(f.flags(), []);
  f.advance(1); assert.equal(f.flags()[0].kind, 'stalled_worker');
  f.sessions.worker.lastActivity = f.now(); assert.deepEqual(f.flags(), []);
});

test('one durable wake per flag state; clearing allows a fresh episode; queen changes get current flags', async t => {
  const f = fixture(t); f.sessions.worker.status = 'idle'; f.advance(30 * MIN);
  await Promise.all([f.watchdog.run(), f.watchdog.run()]); assert.equal(f.sent.length, 1);
  const version = f.rt.metadata.version;
  f.advance(MIN); await f.watchdog.run(); assert.equal(f.sent.length, 1); assert.equal(f.rt.metadata.version, version);
  const restarted = createWatchdog({ runtime: f.rt, host: f.host, now: f.now });
  await restarted.run(); assert.equal(f.sent.length, 1);
  f.sessions.worker.status = 'working'; await restarted.run();
  assert.deepEqual(f.rt.metadata.cell('cell').watchdogFlags, {});
  f.sessions.worker.status = 'idle'; await restarted.run(); assert.equal(f.sent.length, 2);
  f.sessions.otherQueen = {};
  f.rt.metadata.mutate(d => { d.cells.cell.queenSessionId = 'otherQueen'; });
  await restarted.run(); assert.equal(f.sent.length, 3); assert.equal(f.sent[2].id, 'otherQueen');
  f.sessions.worker.status = 'error'; await restarted.run(); assert.equal(f.sent.length, 4);
});

test('quiet hives never wake, invalid snapshots do not clear receipts, stopped runtime never sends', async t => {
  const f = fixture(t); await f.watchdog.run(); assert.equal(f.sent.length, 0);
  f.sessions.worker.status = 'exited'; await f.watchdog.run(); assert.equal(f.sent.length, 1);
  f.rt.snapshots.current.error = 'unavailable'; f.sessions.worker.status = 'working'; await f.watchdog.run();
  assert.equal(Object.keys(f.rt.metadata.cell('cell').watchdogFlags).length, 1);
  f.rt.snapshots.current.error = null;
  f.rt.metadata.mutate(d => { d.cells.cell.enabled = false; }); await f.watchdog.run(); assert.deepEqual(f.flags(), []);
  f.rt.metadata.mutate(d => { d.cells.cell.enabled = true; d.cells.cell.snapshot = {}; }); await f.watchdog.run(); assert.deepEqual(f.flags(), []);
  f.watchdog.stop(); f.rt.metadata.lifetime.stop(); await f.watchdog.run(); assert.equal(f.sent.length, 1);
});

test('per-hive thresholds are validated, persisted and affect only that hive', t => {
  const f = fixture(t); f.sessions.worker.status = 'idle'; f.advance(MIN);
  setWatchdogSettings(f.rt, { cellId: 'cell', settings: { idleMinutes: 1, reviewMinutes: 2, messageMinutes: 3, waitHours: 4 } });
  assert.equal(f.flags()[0].kind, 'stalled_worker');
  assert.equal(f.rt.metadata.cell('cell').watchdogSettings.waitHours, 4);
  for (const settings of [{ workerMinutes: 0 }, { waitHours: -1 }, { reviewMinutes: NaN }, { messageMinutes: '1' }, { other: 1 }]) {
    assert.throws(() => setWatchdogSettings(f.rt, { cellId: 'cell', settings }));
  }
});

test('runtime sweep checks watchdog without any queen schedule', async () => {
  const { createManifest } = await import('../server/manifest.js');
  const calls = [];
  const rt = { snapshots: { maybeRefresh() { calls.push('refresh'); } }, async recover() { calls.push('recover'); }, watchdog: { async run() { calls.push('watchdog'); } } };
  await createManifest({ dir: '.' }).sweeps.find(s => s.id === 'refresh').run({ host: { stores: { hive: rt } } });
  assert.ok(calls.includes('watchdog'));
});

test('settings handler persists validated thresholds and refuses snapshots', async t => {
  const { configHandlers } = await import('../server/handlers.js');
  const f = fixture(t), replies = [];
  const handler = configHandlers.find(h => h.type === 'hive-watchdog-settings');
  assert.ok(handler);
  await handler.handler({ cellId: 'cell', settings: { workerMinutes: 5 } }, f.host, r => replies.push(r));
  assert.equal(replies.at(-1).ok, true); assert.equal(f.rt.metadata.cell('cell').watchdogSettings.workerMinutes, 5);
  f.rt.metadata.mutate(d => { d.cells.cell.snapshot = {}; });
  await handler.handler({ cellId: 'cell', settings: { workerMinutes: 6 } }, f.host, r => replies.push(r));
  assert.equal(replies.at(-1).ok, false); assert.equal(f.rt.metadata.cell('cell').watchdogSettings.workerMinutes, 5);
});

test('hive_context exposes current flags with the per-hive thresholds', async t => {
  const { buildContext } = await import('../server/tools.js');
  const f = fixture(t), queen = '11111111-1111-4111-8111-111111111111';
  f.sessions[queen] = { sessionId: queen, taskId: 'task' };
  f.host.tasks = { get: () => ({ name: 'Synthetic task' }), forSession: () => ({ taskId: 'task' }) };
  f.host.sessions.forTask = () => [];
  f.rt.metadata.mutate(d => { Object.assign(d.cells.cell, { queenSessionId: queen, taskId: 'task' }); });
  f.rt.snapshots.refresh = async () => f.rt.snapshots.current;
  for (const bead of Object.values(f.beads)) bead.evidence = [];
  f.sessions.worker.status = 'exited';
  const context = await buildContext(f.rt, f.host, { sessionId: queen, role: 'queen', cell: f.rt.metadata.cell('cell') });
  assert.equal(context.attention.watchdog[0].bead_id, 'work');
  assert.equal(context.attention.watchdog[0].session_id, 'worker');
  assert.equal(context.cell.watchdog_settings.workerMinutes, 30);
});

test('failed and uncertain delivery are attempted once and persisted across restart', async t => {
  for (const mode of ['error', 'unknown']) {
    const f = fixture(t); let attempts = 0;
    f.sessions.worker.status = 'exited';
    f.host.deliver = async () => { attempts++; return mode === 'error' ? { mode: 'error', error: 'failed' } : { outcome: 'unknown' }; };
    await f.watchdog.run(); await f.watchdog.run();
    await createWatchdog({ runtime: f.rt, host: f.host, now: f.now }).run();
    assert.equal(attempts, 1);
    assert.ok(Object.values(f.rt.metadata.cell('cell').watchdogFlags)[0].noticed['queen:0'].state);
  }
});

test('a new activity episode gets a new flag; an available queen receives flags discovered while absent', async t => {
  const f = fixture(t); f.sessions.worker.status = 'idle'; f.advance(30 * MIN);
  delete f.sessions.queen; await f.watchdog.run(); assert.equal(f.sent.length, 0);
  f.sessions.queen = {}; await f.watchdog.run(); assert.equal(f.sent.length, 1);
  f.sessions.worker.lastActivity = f.now(); await f.watchdog.run(); assert.deepEqual(f.flags(), []);
  f.advance(30 * MIN); await f.watchdog.run(); assert.equal(f.sent.length, 2);
});

test('all thresholds are hive-specific and review/message/wait clear before their next episode', async t => {
  const f = fixture(t);
  f.rt.metadata.mutate(d => {
    d.cells.other = { id: 'other', rootBeadId: 'root', enabled: true };
    d.reviews.r = { id: 'r', cellId: 'cell', workBeadId: 'work', state: 'requested', createdAt: f.now() };
    d.conversation.cell = [{ id: 'm', author: 'human', at: f.now(), response: { required: true } }];
  });
  f.beads.work.status = 'blocked';
  setWatchdogSettings(f.rt, { cellId: 'cell', settings: { workerMinutes: 1, reviewMinutes: 1, messageMinutes: 1, waitHours: 1 / 60 } });
  f.advance(MIN - 1); assert.deepEqual(f.flags(), []);
  f.advance(1); assert.equal(f.flags().length, 3);
  assert.deepEqual(collectWatchdog(f.rt, f.host, f.rt.metadata.cell('other'), f.now()), []);
  await f.watchdog.run(); assert.equal(f.sent.length, 1);
  await f.watchdog.run(); assert.equal(f.sent.length, 1);
  f.beads.work.updatedAt = f.now();
  f.rt.metadata.mutate(d => { d.reviews.r.state = 'cancelled'; d.conversation.cell[0].response.required = false; });
  await f.watchdog.run(); assert.deepEqual(f.flags(), []);
  f.advance(MIN); await f.watchdog.run(); assert.equal(f.sent.length, 2);
});

test('retiring during delivery stops later wakes and does not write a retired store', async t => {
  const f = fixture(t); f.sessions.worker.status = 'exited';
  f.rt.metadata.mutate(d => { d.conversation.cell = [{ id: 'm', author: 'human', at: f.now() - 31 * MIN, response: { required: true } }]; });
  let count = 0;
  f.host.deliver = async () => { count++; f.rt.metadata.lifetime.stop(); return { mode: 'live' }; };
  await f.watchdog.run(); assert.equal(count, 1);
  assert.equal(Object.values(f.rt.metadata.cell('cell').watchdogFlags).filter(flag => Object.keys(flag.noticed).length).length, 2);
});

test('notification dedup survives reloading metadata from disk', async t => {
  const { MetadataStore } = await import('../server/metadata-store.js');
  const f = fixture(t); f.sessions.worker.status = 'exited'; await f.watchdog.run();
  const metadata = new MetadataStore({ file: f.rt.metadata.file });
  const rt = { metadata, snapshots: f.rt.snapshots, beads: f.rt.beads, log() {}, changed() {} };
  const host = { ...f.host, stores: { hive: rt } };
  metadata.lifetime.attach(rt, host);
  await createWatchdog({ runtime: rt, host, now: f.now }).run();
  assert.equal(f.sent.length, 1);
});

test('store failures and an unsettled hierarchy neither notify nor clear prior receipts', async t => {
  const f = fixture(t); f.sessions.worker.status = 'exited'; await f.watchdog.run();
  f.sessions.worker.status = 'working';
  for (const unavailable of ['hierarchy', 'backend', 'metadata']) {
    if (unavailable === 'hierarchy') f.rt.snapshots.hierarchyCurrent = false;
    if (unavailable === 'backend') f.rt.beads.status.state = 'error';
    if (unavailable === 'metadata') f.rt.metadata.error = 'unreadable';
    await f.watchdog.run();
    assert.equal(Object.keys(f.rt.metadata.cell('cell').watchdogFlags).length, 1);
    f.rt.snapshots.hierarchyCurrent = true; f.rt.beads.status.state = 'ready'; f.rt.metadata.error = null;
  }
  await f.watchdog.run(); assert.deepEqual(f.rt.metadata.cell('cell').watchdogFlags, {}); assert.equal(f.sent.length, 1);
});

test('touching an exited or errored claim does not repeat its unchanged state', async t => {
  const f = fixture(t); f.sessions.worker.status = 'exited'; await f.watchdog.run();
  f.advance(MIN); f.beads.work.updatedAt = f.now(); await f.watchdog.run(); assert.equal(f.sent.length, 1);
  assert.equal(f.flags()[0].age_ms, MIN);
  f.sessions.worker.lastActivity = f.now(); await f.watchdog.run(); assert.equal(f.sent.length, 1);
  f.sessions.worker.status = 'error'; await f.watchdog.run(); assert.equal(f.sent.length, 2);
  f.advance(MIN); f.beads.work.updatedAt = f.now(); await f.watchdog.run(); assert.equal(f.sent.length, 2);
});

test('large conversations and requests are traversed once rather than once per bead', t => {
  const f = fixture(t); let reads = 0;
  f.rt.metadata.mutate(d => {
    for (let i = 0; i < 100; i++) d.requests[`req${i}`] = { state: 'open', cellId: 'cell', requesterSessionId: `other${i}` };
    d.conversation.cell = Array.from({ length: 100 }, (_, i) => ({ id: `msg${i}`, author: 'session', at: f.now() }));
  });
  const requests = f.rt.metadata.read().requests;
  for (const key of Object.keys(requests)) {
    const value = requests[key]; Object.defineProperty(requests, key, { enumerable: true, get() { reads++; return value; } });
  }
  f.sessions.worker.status = 'idle'; f.advance(30 * MIN);
  for (let i = 0; i < 100; i++) f.beads[`work${i}`] = { ...f.beads.work, id: `work${i}` };
  assert.equal(f.flags().length, 101);
  assert.ok(reads <= 200, `request visits: ${reads}`);
});

test('backlogs and queen replacement send one readable digest with a receipt per item', async t => {
  const f = fixture(t);
  for (let i = 0; i < 50; i++) f.beads[`wait${i}`] = { id: `wait${i}`, parentId: 'root', status: 'blocked', waitingFor: 'dependency', updatedAt: f.now() - 25 * 3600000 };
  await f.watchdog.run(); assert.equal(f.sent.length, 1);
  assert.match(f.sent[0].text, /50/); assert.match(f.sent[0].text, /stale_wait/); assert.match(f.sent[0].text, /full list/i);
  assert.ok(f.sent[0].text.length < 4000);
  assert.equal(Object.values(f.rt.metadata.cell('cell').watchdogFlags).filter(flag => flag.noticed['queen:0']).length, 50);
  await f.watchdog.run(); assert.equal(f.sent.length, 1);
  f.rt.metadata.mutate(d => { d.cells.cell.queenGeneration = 1; });
  await f.watchdog.run(); assert.equal(f.sent.length, 2);
  assert.equal(Object.values(f.rt.metadata.cell('cell').watchdogFlags).filter(flag => flag.noticed['queen:1']).length, 50);
});

test('a pass groups multiple hives for one queen and caps other queen deliveries', async t => {
  const f = fixture(t); f.sessions.worker.status = 'exited';
  f.rt.metadata.mutate(d => {
    for (let i = 0; i < 25; i++) d.cells[`cell${i}`] = { ...d.cells.cell, id: `cell${i}`, queenSessionId: i < 2 ? 'queen' : `queen${i}` };
  });
  for (let i = 2; i < 25; i++) f.sessions[`queen${i}`] = {};
  await f.watchdog.run(); assert.ok(f.sent.length <= 10); assert.equal(f.sent.filter(m => m.id === 'queen').length, 1);
  assert.equal(Object.values(f.rt.metadata.read().cells).filter(c => Object.keys(c.watchdogFlags || {}).length).length, 26);
  await f.watchdog.run(); await f.watchdog.run(); assert.equal(f.sent.length, 24);
});

test('a hung delivery times out while all cells still flag and later clear', async t => {
  const f = fixture(t); f.sessions.worker.status = 'exited';
  f.rt.metadata.mutate(d => { d.cells.second = { ...d.cells.cell, id: 'second' }; });
  let timeout;
  f.host.deliver = () => new Promise(() => {});
  const watchdog = createWatchdog({ runtime: f.rt, host: f.host, now: f.now, setTimer: fn => { timeout = fn; return 1; }, clearTimer() {} });
  const pass = watchdog.run();
  await Promise.resolve();
  assert.ok(Object.keys(f.rt.metadata.cell('second').watchdogFlags || {}).length);
  assert.equal(typeof timeout, 'function'); timeout(); await pass;
  for (const cell of f.rt.metadata.cells()) assert.equal(Object.values(cell.watchdogFlags)[0].noticed['queen:0'].state, 'uncertain');
  f.sessions.worker.status = 'working'; await watchdog.run();
  for (const cell of f.rt.metadata.cells()) assert.deepEqual(cell.watchdogFlags, {});
});

test('queen-owned claims are checked; archived and unknown claimants flag as untracked work', t => {
  const f = fixture(t);
  f.beads.work.ownerSessionId = 'queen'; f.sessions.queen = { status: 'idle', lastActivity: f.now() }; f.advance(30 * MIN);
  assert.equal(f.flags()[0].session_id, 'queen');
  f.sessions.queen.archived = true; assert.deepEqual(f.flags().map(x => x.kind), ['untracked_work']);
  delete f.sessions.queen; assert.deepEqual(f.flags().map(x => x.kind), ['untracked_work']);
});

test('watchdog attention and digest carry available session links and omit dead links', async t => {
  const f = fixture(t);
  f.sessions.worker.status = 'exited';
  assert.equal(f.flags()[0].session_link, '#session=worker');
  await f.watchdog.run();
  assert.match(f.sent[0].text, /\[Open session\]\(#session=worker\)/);
  f.sessions.reviewer = {};
  f.rt.metadata.mutate(d => { d.reviews.r = { id: 'r', cellId: 'cell', workBeadId: 'work', reviewerSessionId: 'reviewer', state: 'requested', createdAt: f.now() }; });
  f.advance(240 * MIN);
  assert.equal(f.flags().find(x => x.kind === 'stuck_review').session_link, '#session=reviewer');
  f.sessions.reviewer.archived = true;
  assert.equal(f.flags().find(x => x.kind === 'stuck_review').session_link, null);
  delete f.sessions.reviewer;
  assert.equal(f.flags().find(x => x.kind === 'stuck_review').session_link, null);
});

test('open PR linked to a closed-bead session flags and notifies until the link is removed', async t => {
  const f = fixture(t), url = 'https://github.com/example/repo/pull/42';
  let links = [{ type: 'pr', url }];
  f.host.links = { get: () => links };
  f.rt.metadata.mutate(d => {
    d.bindings.cell = [{ sessionId: 'worker', beadId: 'work', active: true }];
    d.prLabels[url] = { url, state: 'OPEN' };
  });
  f.beads.work.status = 'closed';
  const flag = f.flags().find(x => x.kind === 'closed_bead_pr');
  assert.ok(flag);
  assert.equal(flag.bead_id, 'work'); assert.equal(flag.session_id, 'worker'); assert.equal(flag.pr_url, url);
  await f.watchdog.run(); await f.watchdog.run();
  assert.equal(f.sent.length, 1);
  assert.ok(f.sent[0].text.includes(url));
  links = []; await f.watchdog.run(); assert.deepEqual(f.flags(), []);
  links = [{ type: 'pr', url }];
  for (const state of ['MERGED', 'CLOSED', null]) {
    f.rt.metadata.mutate(d => { d.prLabels[url].state = state; });
    assert.deepEqual(f.flags(), []);
  }
});

test('closed-bead PR flags require a current binding, live card, actual link and matching cell', t => {
  const f = fixture(t), url = 'https://github.com/example/repo/pull/42';
  f.beads.work.status = 'closed';
  f.host.links = { get: () => [{ type: 'pr', url }] };
  f.rt.metadata.mutate(d => {
    d.bindings.cell = [{ sessionId: 'worker', beadId: 'work', active: true }];
    d.prLabels[url] = { url, state: 'OPEN' };
    d.cells.other = { id: 'other', enabled: true, rootBeadId: 'other-root' };
  });
  f.beads['other-root'] = { id: 'other-root', status: 'open' };
  assert.equal(f.flags().length, 1);
  assert.deepEqual(collectWatchdog(f.rt, f.host, f.rt.metadata.cell('other'), f.now()), []);
  f.sessions.worker.archived = true; assert.deepEqual(f.flags(), []);
  f.sessions.worker.archived = false;
  f.rt.metadata.mutate(d => { d.bindings.cell[0].active = false; }); assert.deepEqual(f.flags(), []);
  f.rt.metadata.mutate(d => { d.bindings.cell[0].active = true; });
  f.host.links.get = () => [{ type: 'jira', url }]; assert.deepEqual(f.flags(), []);
});
