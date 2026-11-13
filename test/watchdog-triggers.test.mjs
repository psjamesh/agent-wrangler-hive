import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HiveRuntime } from '../server/runtime.js';
import { collectWatchdog, createWatchdog, setWatchdogSettings, WATCHDOG_DEFAULTS } from '../server/watchdog.js';

const MIN = 60000, DAY = 24 * 60 * MIN;
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-watchdog-triggers-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const rt = new HiveRuntime({ env: { AW_DATA_DIR: dir } });
  let now = 2000000000;
  const sessions = { queen: {}, worker: { status: 'working', lastActivity: now } };
  const sent = [];
  const host = { stores: { hive: rt }, sessions: { get: id => sessions[id] }, deliver: async (id, text) => { sent.push({ id, text }); return { mode: 'live' }; } };
  rt.metadata.lifetime.attach(rt, host);
  const beads = { root: { id: 'root', status: 'open', kind: 'goal' } };
  const edges = [];
  rt.snapshots = { current: { loadedAt: now, error: null, graph: { beads, edges } }, get graph() { return this.current.graph; } };
  rt.beads.status.state = 'ready';
  rt.metadata.mutate(d => { d.cells.cell = { id: 'cell', rootBeadId: 'root', enabled: true, queenSessionId: 'queen' }; });
  const watchdog = createWatchdog({ runtime: rt, host, now: () => now });
  const flags = () => collectWatchdog(rt, host, rt.metadata.cell('cell'), now);
  const bead = (id, extra = {}) => (beads[id] = { id, parentId: 'root', kind: 'work', status: 'open', updatedAt: now, evidence: [], ...extra });
  return { rt, sessions, beads, edges, sent, watchdog, flags, bead, now: () => now, advance: ms => { now += ms; } };
}
const kinds = f => f.flags().map(x => x.kind).sort();

test('defaults include the deferred review age and the untracked threshold', () => {
  assert.equal(WATCHDOG_DEFAULTS.deferredDays, 7);
  assert.equal(WATCHDOG_DEFAULTS.untrackedMinutes, 30);
});

test('a deferred bead flags once its review date has passed', t => {
  const f = fixture(t);
  f.bead('later', { status: 'deferred', resume: { reviewAt: new Date(f.now() + 2 * DAY).toISOString() } });
  f.advance(2 * DAY - 1); assert.deepEqual(f.flags(), []);
  f.advance(1);
  const [flag] = f.flags();
  assert.equal(flag.kind, 'deferred_due'); assert.equal(flag.bead_id, 'later'); assert.match(flag.reason, /review date/i);
  assert.equal(flag.age_ms, 0);
  f.advance(MIN); assert.equal(f.flags()[0].age_ms, MIN);
});

test('a deferred bead flags when its prerequisite closes, and not before', t => {
  const f = fixture(t);
  f.bead('pre', { status: 'in_progress', ownerSessionId: 'worker' });
  f.bead('later', { status: 'deferred', resume: { afterBead: 'pre' } });
  f.advance(3 * DAY); f.sessions.worker.lastActivity = f.now(); f.beads.pre.updatedAt = f.now();
  assert.deepEqual(f.flags(), []);
  f.beads.pre.status = 'closed';
  const [flag] = f.flags();
  assert.equal(flag.kind, 'deferred_due'); assert.equal(flag.bead_id, 'later'); assert.match(flag.reason, /pre/);
});

test('either resume condition triggers; a future review date is not overridden by the default age', t => {
  const f = fixture(t);
  f.bead('pre', { status: 'closed' });
  f.bead('both', { status: 'deferred', resume: { reviewAt: new Date(f.now() + 30 * DAY).toISOString(), afterBead: 'pre' } });
  f.bead('dated', { status: 'deferred', resume: { reviewAt: new Date(f.now() + 30 * DAY).toISOString() } });
  f.advance(8 * DAY);
  assert.deepEqual(f.flags().map(x => x.bead_id), ['both']);
});

test('a deferred bead without a resume condition flags at the per-hive default age', t => {
  const f = fixture(t);
  f.bead('parked', { status: 'deferred' });
  f.advance(7 * DAY - 1); assert.deepEqual(f.flags(), []);
  f.advance(1);
  assert.equal(f.flags()[0].kind, 'deferred_due'); assert.match(f.flags()[0].reason, /7 days/);
  setWatchdogSettings(f.rt, { cellId: 'cell', settings: { deferredDays: 10 } });
  assert.deepEqual(f.flags(), []);
  f.advance(3 * DAY); assert.equal(f.flags().length, 1);
  setWatchdogSettings(f.rt, { cellId: 'cell', settings: { deferredDays: 1 / 24 } });
  assert.equal(f.flags().length, 1);
  assert.throws(() => setWatchdogSettings(f.rt, { cellId: 'cell', settings: { deferredDays: 0 } }));
  assert.throws(() => setWatchdogSettings(f.rt, { cellId: 'cell', settings: { untrackedMinutes: -1 } }));
});

test('re-deferring with a new date starts a new episode and closed deferred beads never flag', async t => {
  const f = fixture(t);
  f.bead('later', { status: 'deferred', resume: { reviewAt: new Date(f.now() + MIN).toISOString() } });
  f.advance(MIN); await f.watchdog.run(); assert.equal(f.sent.length, 1);
  await f.watchdog.run(); assert.equal(f.sent.length, 1);
  f.beads.later.resume = { reviewAt: new Date(f.now() + MIN).toISOString() }; f.beads.later.updatedAt = f.now();
  await f.watchdog.run(); assert.deepEqual(f.flags(), []);
  f.advance(MIN); await f.watchdog.run(); assert.equal(f.sent.length, 2);
  f.beads.later.status = 'closed'; assert.deepEqual(f.flags(), []);
});

test('in-progress work with no live claimant flags as untracked after the threshold', t => {
  const f = fixture(t);
  f.bead('nobody', { status: 'in_progress' });
  f.bead('gone', { status: 'in_progress', ownerSessionId: 'missing' });
  f.bead('archived', { status: 'in_progress', ownerSessionId: 'old' }); f.sessions.old = { status: 'idle', archived: true };
  f.advance(30 * MIN - 1); assert.deepEqual(f.flags(), []);
  f.advance(1);
  assert.deepEqual(f.flags().map(x => [x.kind, x.bead_id]).sort(), [['untracked_work', 'archived'], ['untracked_work', 'gone'], ['untracked_work', 'nobody']]);
  assert.match(f.flags()[0].reason, /no live claimant/i);
});

test('untracked ignores live claimants, goals, blocking prerequisites, open reviews and closed work', t => {
  const f = fixture(t);
  f.bead('live', { status: 'in_progress', ownerSessionId: 'worker' });
  f.bead('group', { status: 'in_progress', kind: 'workstream' });
  f.bead('pre', { status: 'open' }); f.bead('blocked', { status: 'in_progress' });
  f.edges.push({ dependent: 'blocked', prerequisite: 'pre', type: 'blocks', blocking: true });
  f.bead('reviewed', { status: 'in_progress' });
  f.rt.metadata.mutate(d => { d.reviews.r = { id: 'r', state: 'in_review', cellId: 'cell', workBeadId: 'reviewed', createdAt: f.now() }; });
  f.bead('done', { status: 'closed' });
  f.advance(DAY); f.sessions.worker.lastActivity = f.now();
  assert.deepEqual(kinds(f), ['stuck_review']);
});

test('an exited claimant raises stalled_worker only, not a second untracked flag', t => {
  const f = fixture(t);
  f.bead('work', { status: 'in_progress', ownerSessionId: 'worker' }); f.sessions.worker.status = 'exited';
  f.advance(DAY);
  assert.deepEqual(kinds(f), ['stalled_worker']);
});

test('a bead whose worker is gone and whose summary asks the queen to close it flags as finished-but-open', t => {
  const f = fixture(t);
  f.bead('x1u0', { status: 'open', summary: 'Work is complete. Queen must reconcile/close; the global limit refused the claim.' });
  f.advance(30 * MIN - 1); assert.deepEqual(f.flags(), []);
  f.advance(1);
  const [flag] = f.flags();
  assert.equal(flag.kind, 'finished_open'); assert.equal(flag.bead_id, 'x1u0'); assert.match(flag.reason, /close/i);
});

test('finished-but-open also reads the latest evidence and next action, and covers in-progress beads', t => {
  const f = fixture(t);
  f.bead('byEvidence', { status: 'in_progress', ownerSessionId: 'gone', evidence: [{ label: 'old', detail: 'started' }, { label: 'PR merged', detail: 'Acceptance met; ready to close.' }] });
  f.bead('byNext', { status: 'open', nextAction: 'Please close this bead, nothing left to do.' });
  f.bead('earlierOnly', { status: 'open', evidence: [{ label: 'Acceptance met; ready to close.' }, { label: 'Reopened', detail: 'Found another defect' }] });
  f.advance(DAY);
  const flagged = f.flags().filter(x => x.kind === 'finished_open').map(x => x.bead_id).sort();
  assert.deepEqual(flagged, ['byEvidence', 'byNext']);
});

test('finished-but-open is quiet while a live worker holds the bead, for ordinary text and for closed work', t => {
  const f = fixture(t);
  f.bead('held', { status: 'in_progress', ownerSessionId: 'worker', summary: 'Done. Queen should close.' });
  f.bead('plain', { status: 'open', summary: 'Implementing the parser; tests next.' });
  f.bead('closed', { status: 'closed', summary: 'Done. Queen should close.' });
  f.advance(DAY); f.sessions.worker.lastActivity = f.now();
  assert.deepEqual(f.flags().filter(x => x.kind === 'finished_open'), []);
});

test('first install over a backlog sends one digest, never a wake storm, and stays quiet afterwards', async t => {
  const f = fixture(t);
  for (let i = 0; i < 30; i++) f.bead(`d${i}`, { status: 'deferred', updatedAt: f.now() - 20 * DAY });
  for (let i = 0; i < 30; i++) f.bead(`u${i}`, { status: 'in_progress', updatedAt: f.now() - DAY });
  for (let i = 0; i < 30; i++) f.bead(`f${i}`, { status: 'open', updatedAt: f.now() - DAY, summary: 'Finished; queen to close.' });
  await f.watchdog.run(); assert.equal(f.sent.length, 1);
  assert.match(f.sent[0].text, /deferred_due: 30/); assert.match(f.sent[0].text, /untracked_work: 30/); assert.match(f.sent[0].text, /finished_open: 30/);
  assert.ok(f.sent[0].text.length < 4000);
  f.advance(DAY); await f.watchdog.run(); await f.watchdog.run(); assert.equal(f.sent.length, 1);
});

test('cleared flags re-arm: resolving then repeating a condition wakes again', async t => {
  const f = fixture(t);
  f.bead('nobody', { status: 'in_progress' });
  f.advance(30 * MIN); await f.watchdog.run(); assert.equal(f.sent.length, 1);
  f.beads.nobody.ownerSessionId = 'worker'; f.sessions.worker.lastActivity = f.now(); await f.watchdog.run();
  assert.deepEqual(f.rt.metadata.cell('cell').watchdogFlags, {});
  f.beads.nobody.ownerSessionId = null; f.beads.nobody.updatedAt = f.now(); f.advance(30 * MIN);
  await f.watchdog.run(); assert.equal(f.sent.length, 2);
});

test('finished-but-open ignores hedged, negated and unrelated wording and never-claimed backlog beads', t => {
  const f = fixture(t);
  const quiet = [
    'The queen should not close this until PR #51 is merged', 'Waiting for PR to be merged', 'Rebased on merged main', 'Builds on merged hive-tmp3',
    'Acceptance not met: missing tests', 'Acceptance criteria are not yet met', 'Implementation is complete except for tests', 'Done: step 1 of 3',
    'Completed the spike; implementation next', 'should be finished by tomorrow', 'needs to be closed once release ships',
    'Queen: please decide whether to close or split', 'Awaiting review by coordinator; will finish after', 'branch queen-close is pushed', 'Please close the gap in the tests first', 'Reported by the queen on 12 Nov: unseen deferred beads, finished-but-open work',
  ];
  quiet.forEach((summary, i) => f.bead(`q${i}`, { status: 'in_progress', ownerSessionId: 'gone', summary }));
  f.bead('backlog', { status: 'open', summary: 'Work is complete.' });
  f.bead('waiting', { status: 'blocked', ownerSessionId: 'gone', summary: 'Work is complete.' });
  f.advance(DAY);
  assert.deepEqual(f.flags().filter(x => x.kind === 'finished_open'), []);
});

test('an unclaimed bead flags only on an explicit request to the queen; a departed claimant also on completion text', t => {
  const f = fixture(t);
  f.bead('asked', { status: 'open', summary: 'Queen must reconcile/close; the claim was refused.' });
  f.bead('unclaimedDone', { status: 'open', summary: 'Work is complete.' });
  f.bead('claimedDone', { status: 'in_progress', ownerSessionId: 'gone', summary: 'Implementation is complete. Acceptance criteria met.' });
  f.advance(DAY);
  assert.deepEqual(f.flags().filter(x => x.kind === 'finished_open').map(x => x.bead_id).sort(), ['asked', 'claimedDone']);
});

test('a bead waiting on the human flags after the grace period and names the waiting text', t => {
  const f = fixture(t);
  f.bead('ask', { status: 'blocked', waitingFor: 'Human: pick the approach' });
  f.advance(10 * MIN - 1); assert.deepEqual(f.flags(), []);
  f.advance(1);
  const [flag] = f.flags();
  assert.equal(flag.kind, 'human_wait_unasked'); assert.equal(flag.bead_id, 'ask'); assert.match(flag.reason, /Human: pick the approach/);
  f.beads.ask.waitingFor = 'Waiting for the human to confirm';
  assert.equal(f.flags()[0].kind, 'human_wait_unasked');
  f.beads.ask.waitingFor = 'Waiting on the merge queue'; f.beads.ask.status = 'in_progress';
  assert.deepEqual(f.flags(), []);
});

test('the grace period is a per-hive setting', t => {
  const f = fixture(t);
  assert.equal(WATCHDOG_DEFAULTS.humanWaitMinutes, 10);
  f.bead('ask', { status: 'open', waitingFor: 'human decision' });
  setWatchdogSettings(f.rt, { cellId: 'cell', settings: { humanWaitMinutes: 30 } });
  f.advance(29 * MIN); assert.deepEqual(f.flags(), []);
  f.advance(MIN); assert.equal(f.flags().length, 1);
  assert.throws(() => setWatchdogSettings(f.rt, { cellId: 'cell', settings: { humanWaitMinutes: 0 } }));
});

test('a blocked bead with no reason, prerequisite or review counts as waiting on the human', t => {
  const f = fixture(t);
  f.bead('bare', { status: 'blocked' });
  f.bead('reasoned', { status: 'blocked', waitingFor: 'Waiting for CI' });
  f.bead('pre', { status: 'open' });
  f.bead('dependent', { status: 'blocked' });
  f.edges.push({ dependent: 'dependent', prerequisite: 'pre', blocking: true });
  f.bead('reviewed', { status: 'blocked' });
  f.rt.metadata.mutate(d => { d.reviews.r = { id: 'r', cellId: 'cell', workBeadId: 'reviewed', state: 'requested', createdAt: f.now() }; });
  f.advance(10 * MIN);
  assert.deepEqual(f.flags().filter(x => x.kind === 'human_wait_unasked').map(x => x.bead_id), ['bare']);
});

test('an open request for the bead suppresses the flag and an answered one does not', t => {
  const f = fixture(t);
  f.bead('ask', { status: 'blocked', waitingFor: 'Human: decide' });
  f.advance(10 * MIN); assert.equal(f.flags().length, 1);
  f.rt.metadata.mutate(d => { d.requests = { q: { id: 'q', cellId: 'cell', beadId: 'ask', state: 'open' } }; });
  assert.deepEqual(f.flags(), []);
  f.rt.metadata.mutate(d => { d.requests.q.state = 'answered'; });
  assert.equal(f.flags().length, 1);
  f.rt.metadata.mutate(d => { d.requests.q = { id: 'q', cellId: 'cell', beadId: 'other', state: 'open' }; });
  assert.equal(f.flags().length, 1);
});

test('the flag wakes the queen once, naming the bead and waiting text, and not again while unchanged', async t => {
  const f = fixture(t);
  f.bead('ask', { status: 'blocked', waitingFor: 'Human: decide' });
  f.advance(10 * MIN);
  await f.watchdog.run(); assert.equal(f.sent.length, 1);
  assert.match(f.sent[0].text, /human_wait_unasked/); assert.match(f.sent[0].text, /Bead ask/); assert.match(f.sent[0].text, /Human: decide/);
  f.advance(MIN); await f.watchdog.run(); assert.equal(f.sent.length, 1);
});

test('only explicit human-wait clauses count; human-readable and negated mentions do not', async () => {
  const { waitsOnHuman } = await import('../server/human-wait.js');
  for (const yes of ['Human: pick one', 'human decision needed', 'Human approval required', 'Waiting for the human to confirm', 'Blocked on human', 'CI is slow. Awaiting human input', 'waiting on human', 'Human decision needed, not CI', 'Human approval required, CI is not needed', 'Waiting for the human to approve, another CI run is not required', 'Human approval needed but CI is unnecessary', 'Human: not sure which, pick one'])
    assert.equal(waitsOnHuman(yes), true, yes);
  for (const no of ['Waiting for CI to emit human-readable diagnostics', 'No human input needed; waiting for CI', 'Not waiting for the human', 'Human approval not required; waiting for CI', 'Human input is not needed; waiting for CI', 'Waiting for the human is not necessary; CI is the only prerequisite', 'Human input is no longer needed', 'Human approval not required, waiting for CI', 'Waiting for humane treatment', 'Waiting on the merge queue', '', undefined])
    assert.equal(waitsOnHuman(no), false, String(no));
});

test('human-readable waiting text does not flag', t => {
  const f = fixture(t);
  f.bead('ci', { status: 'blocked', waitingFor: 'Waiting for CI to emit human-readable diagnostics' });
  f.advance(10 * MIN); assert.deepEqual(f.flags(), []);
});

test('open requests are indexed once per collection, not rescanned per bead', t => {
  const f = fixture(t);
  for (let i = 0; i < 20; i++) f.bead(`b${i}`, { status: 'blocked' });
  const requests = {};
  let reads = 0;
  for (let i = 0; i < 20; i++) Object.defineProperty(requests, `r${i}`, { enumerable: true, get() { reads++; return { id: `r${i}`, cellId: 'cell', beadId: `x${i}`, state: 'open' }; } });
  const doc = f.rt.metadata.read();
  const original = f.rt.metadata.read;
  f.rt.metadata.read = () => ({ ...doc, requests });
  f.advance(10 * MIN);
  assert.equal(f.flags().length, 20);
  f.rt.metadata.read = original;
  assert.ok(reads <= 20, `request reads: ${reads}`);
});
