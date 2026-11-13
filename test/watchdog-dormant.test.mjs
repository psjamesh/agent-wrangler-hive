import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HiveRuntime } from '../server/runtime.js';
import { archiveSuggestions, collectWatchdog, createWatchdog, waitDeadline } from '../server/watchdog.js';

const MIN = 60000;
const T0 = Date.parse('2026-11-12T10:00:00Z');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-watchdog-dormant-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const rt = new HiveRuntime({ env: { AW_DATA_DIR: dir } });
  let now = T0;
  const sessions = { queen: {}, worker: { status: 'idle', lastActivity: now } };
  const sent = [];
  const host = { stores: { hive: rt }, sessions: { get: id => sessions[id] }, deliver: async (id, text) => { sent.push({ id, text }); return { mode: 'live' }; } };
  rt.metadata.lifetime.attach(rt, host);
  const beads = { root: { id: 'root', status: 'open', kind: 'goal' } };
  rt.snapshots = { current: { loadedAt: now, error: null, graph: { beads, edges: [] } }, get graph() { return this.current.graph; } };
  rt.beads.status.state = 'ready';
  rt.metadata.mutate(d => { d.cells.cell = { id: 'cell', rootBeadId: 'root', enabled: true, queenSessionId: 'queen' }; });
  const watchdog = createWatchdog({ runtime: rt, host, now: () => now });
  const flags = () => collectWatchdog(rt, host, rt.metadata.cell('cell'), now);
  const bead = (id, extra = {}) => (beads[id] = { id, parentId: 'root', kind: 'work', status: 'in_progress', updatedAt: new Date(now).toISOString(), evidence: [], ...extra });
  return { rt, host, sessions, beads, sent, watchdog, flags, bead, advance: ms => { now += ms; }, now: () => now };
}
const kinds = f => f.flags().map(x => x.kind).sort();

test('a dormant claimant with no wait, request or review flags at the worker threshold', t => {
  const f = fixture(t);
  f.bead('work', { ownerSessionId: 'worker' });
  f.sessions.worker.dormant = true;
  f.advance(30 * MIN - 1); assert.deepEqual(kinds(f), []);
  f.advance(1);
  const [flag] = f.flags();
  assert.equal(flag.kind, 'dormant_claim'); assert.equal(flag.bead_id, 'work'); assert.equal(flag.session_id, 'worker');
  assert.match(flag.reason, /no recorded wait/);
  for (const wait of [{ waitingFor: 'Final check later' }, { status: 'blocked' }]) {
    Object.assign(f.beads.work, wait); assert.deepEqual(kinds(f).filter(k => k === 'dormant_claim'), []);
    f.beads.work.waitingFor = ''; f.beads.work.status = 'in_progress';
  }
  f.sessions.worker = { status: 'idle', lastActivity: f.now() }; assert.deepEqual(kinds(f), []);
});

test('a clock-time wait keeps its first-seen anchor when the bead is touched again', async t => {
  const f = fixture(t);
  f.bead('work', { status: 'blocked', waitingFor: 'Final check 16:11Z' });
  await f.watchdog.run();
  f.advance(8 * 60 * MIN);
  f.beads.work.updatedAt = new Date(f.now()).toISOString();
  await f.watchdog.run();
  assert.equal(f.flags().filter(x => x.kind === 'overdue_wait').length, 1);
  f.beads.work.waitingFor = ''; await f.watchdog.run();
  assert.equal(f.rt.metadata.cell('cell').waitAnchors.work, undefined);
});

test('an open input request holds back the dormant flag', t => {
  const f = fixture(t);
  f.bead('work', { ownerSessionId: 'worker' });
  f.sessions.worker.dormant = true;
  f.rt.metadata.mutate(d => { d.requests.q = { id: 'q', cellId: 'cell', state: 'open', requesterSessionId: 'worker' }; });
  f.advance(60 * MIN); assert.deepEqual(kinds(f), []);
});

test('a dormant claimant with an open review or a closed bead does not flag, and an exited one keeps its own flag', t => {
  const f = fixture(t);
  f.bead('work', { ownerSessionId: 'worker' });
  Object.assign(f.sessions.worker, { dormant: true });
  f.rt.metadata.mutate(d => { d.reviews.r = { id: 'r', cellId: 'cell', workBeadId: 'work', reviewerSessionId: 'rev', state: 'in_review', createdAt: f.now() }; });
  f.advance(45 * MIN); assert.deepEqual(kinds(f), []);
  f.rt.metadata.mutate(d => { d.reviews.r.state = 'approved'; });
  f.sessions.worker.status = 'exited'; assert.deepEqual(kinds(f), ['stalled_worker']);
  f.sessions.worker.status = 'idle'; assert.deepEqual(kinds(f), ['dormant_claim']);
  f.beads.work.status = 'closed'; assert.deepEqual(kinds(f), []);
});

test('waitDeadline parses only clear timestamps', () => {
  const anchor = Date.parse('2026-11-12T09:00:00Z');
  assert.equal(waitDeadline('Final check 16:11Z', anchor), Date.parse('2026-11-12T16:11:00Z'));
  assert.equal(waitDeadline('until 08:30Z', anchor), Date.parse('2026-11-13T08:30:00Z'));
  assert.equal(waitDeadline('after 2026-11-12T14:05:00Z', anchor), Date.parse('2026-11-12T14:05:00Z'));
  assert.equal(waitDeadline('at 2026-11-12 14:05+01:00', anchor), Date.parse('2026-11-12T13:05:00Z'));
  assert.equal(waitDeadline('2026-11-12T14:05:00', anchor), 0);
  assert.equal(waitDeadline('at 2026-11-12 14:05:00Z', anchor), Date.parse('2026-11-12T14:05:00Z'));
  assert.equal(waitDeadline('retry 2026-11-12T14:05:00.250Z', anchor), Date.parse('2026-11-12T14:05:00.250Z'));
  assert.equal(waitDeadline('merged 2026-11-12T08:00:00Z; waiting for human', anchor), 0);
  assert.equal(waitDeadline('09:00Z on 14 Nov', anchor), 0);
  assert.equal(waitDeadline('at 09:00Z Nov 14', anchor), 0);
  assert.equal(waitDeadline('merged 2026-11-14T10:00:00Z, waiting for human', anchor), 0);
  assert.equal(waitDeadline('released 16:11Z', anchor), 0);
  for (const text of ['waiting for PR #16', 'v1.16:11 build', 'port 16:11', '12:00', 'about 5 minutes', 'sha 1a16:11Zed', '']) assert.equal(waitDeadline(text, anchor), 0, text);
  assert.equal(waitDeadline('until 16:11Z or 2026-11-14T00:00:00Z', anchor), Date.parse('2026-11-14T00:00:00Z'));
});

test('overdue_wait flags once the named time is past the grace and clears when the wait changes', t => {
  const f = fixture(t);
  f.bead('work', { status: 'blocked', waitingFor: 'Final check 16:11Z' });
  f.advance(6 * 60 * MIN + 11 * MIN + 29 * MIN); assert.deepEqual(kinds(f).filter(k => k === 'overdue_wait'), []);
  f.advance(MIN);
  const flag = f.flags().find(x => x.kind === 'overdue_wait');
  assert.equal(flag.bead_id, 'work'); assert.equal(flag.age_ms, 30 * MIN); assert.match(flag.reason, /16:11Z/);
  f.beads.work.waitingFor = 'Final check 2026-11-13T09:00:00Z';
  assert.deepEqual(kinds(f).filter(k => k === 'overdue_wait'), []);
  f.beads.work.waitingFor = 'Final check 16:11Z'; f.beads.work.status = 'closed';
  assert.deepEqual(kinds(f), []);
});

test('a first-install backlog is one digest with at most ten items and no repeat', async t => {
  const f = fixture(t);
  for (let i = 0; i < 25; i++) {
    f.bead(`w${i}`, { ownerSessionId: `s${i}` });
    f.sessions[`s${i}`] = { status: 'idle', dormant: true, lastActivity: T0 };
    f.bead(`v${i}`, { status: 'blocked', waitingFor: 'check 10:05Z' });
  }
  f.advance(2 * 60 * MIN);
  assert.equal(f.flags().length, 50);
  await f.watchdog.run();
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].text.split('\n').filter(l => l.startsWith('- Cell')).length, 10);
  assert.match(f.sent[0].text, /dormant_claim: 25/); assert.match(f.sent[0].text, /overdue_wait: 25/);
  await f.watchdog.run(); f.advance(MIN); await f.watchdog.run();
  assert.equal(f.sent.length, 1);
});

test('digests suggest archiving idle sessions whose last bead is closed, once, and never wake on their own', async t => {
  const f = fixture(t);
  f.bead('done', { status: 'closed', closedAt: new Date(T0).toISOString() });
  f.bead('live', { ownerSessionId: 'busy' });
  f.sessions.finished = { status: 'idle', lastActivity: T0 };
  f.sessions.busy = { status: 'working', lastActivity: T0 };
  f.sessions.other = { status: 'idle', lastActivity: T0 };
  f.rt.metadata.mutate(d => { d.bindings.cell = [
    { id: 'b1', sessionId: 'finished', beadId: 'done', role: 'worker', active: true, at: T0 },
    { id: 'b2', sessionId: 'busy', beadId: 'live', role: 'worker', active: true, at: T0 },
    { id: 'b3', sessionId: 'other', beadId: 'live', role: 'worker', active: true, at: T0 },
    { id: 'b4', sessionId: 'other', beadId: 'done', role: 'worker', active: false, at: T0 - 1 },
  ]; });
  const cell = () => f.rt.metadata.cell('cell');
  f.advance(29 * MIN); assert.deepEqual(archiveSuggestions(f.rt, f.host, cell(), f.now()), []);
  f.advance(MIN);
  assert.deepEqual(archiveSuggestions(f.rt, f.host, cell(), f.now()).map(s => s.session_id), ['finished']);
  await f.watchdog.run(); assert.equal(f.sent.length, 0);
  f.bead('stuck', { status: 'blocked', updatedAt: new Date(T0 - 48 * 60 * MIN).toISOString(), waitingFor: 'x' });
  await f.watchdog.run();
  assert.equal(f.sent.length, 1); assert.match(f.sent[0].text, /consider archiving: finished \(done\)/);
  f.beads.stuck.updatedAt = new Date(T0 - 72 * 60 * MIN).toISOString(); f.beads.stuck.waitingFor = 'y';
  await f.watchdog.run();
  assert.equal(f.sent.length, 2); assert.doesNotMatch(f.sent[1].text, /archiving/);
});
