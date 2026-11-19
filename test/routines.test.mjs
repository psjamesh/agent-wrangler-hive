import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { nextRunAt } from '../server/schedule-time.js';
import { validateSchedule } from '../public/schedule.js';
import { MetadataStore } from '../server/metadata-store.js';
import { buildGraph } from '../server/bead-model.js';
import { setRoutine, runRoutines, routineState } from '../server/routines.js';
import { awaitingQueen, publish } from '../server/conversation.js';
import { projectForGraph } from '../server/projection.js';
import { missedInput } from '../server/missed-input.js';

const config = { name: 'Daily check-in', days: [1, 2, 3, 4, 5], time: '09:00', timeZone: 'Europe/London', message: 'Run the daily check-in.' };
const iso = n => new Date(n).toISOString();

test('validation rejects malformed schedules and preserves a normalized IANA schedule', () => {
  assert.deepEqual(validateSchedule({ ...config, name: ' Daily check-in ', days: [5, 1] }), { ...config, days: [1, 5], enabled: true });
  for (const patch of [{ days: [] }, { days: [1, 1] }, { days: [7] }, { days: ['1'] }, { time: '9:00' }, { time: '24:00' }, { timeZone: 'Invalid/Zone' }, { timeZone: '+01:00' }, { message: '' }, { name: '' }, { enabled: 'yes' }]) assert.throws(() => validateSchedule({ ...config, ...patch }));
});

test('next run obeys weekdays, a strict boundary and fractional-offset time zones', () => {
  assert.equal(iso(nextRunAt(config, Date.parse('2026-11-20T09:00:00Z'))), '2026-11-23T09:00:00.000Z');
  assert.equal(iso(nextRunAt({ ...config, timeZone: 'Asia/Kathmandu' }, Date.parse('2026-11-18T00:00:00Z'))), '2026-11-18T03:15:00.000Z');
});

test('DST skips missing local times and runs repeated local times only at their first occurrence', () => {
  const s = { ...config, days: [0], time: '01:30' };
  assert.equal(iso(nextRunAt(s, Date.parse('2026-03-28T00:00:00Z'))), '2026-04-05T00:30:00.000Z');
  assert.equal(iso(nextRunAt(s, Date.parse('2026-10-24T00:00:00Z'))), '2026-10-25T00:30:00.000Z');
  assert.equal(iso(nextRunAt(s, Date.parse('2026-10-25T00:30:00Z'))), '2026-11-01T01:30:00.000Z');
  assert.equal(iso(nextRunAt({ ...s, timeZone: 'America/New_York' }, Date.parse('2026-11-01T05:30:00Z'))), '2026-11-08T06:30:00.000Z');
  assert.equal(iso(nextRunAt({ ...s, time: '02:15', timeZone: 'Australia/Lord_Howe' }, Date.parse('2026-10-03T00:00:00Z'))), '2026-10-10T15:15:00.000Z');
});

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-routines-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'metadata.json');
  const metadata = new MetadataStore({ file });
  const cell = { id: 'cell_test', taskId: 'task', enabled: true, rootBeadId: 'root', queenSessionId: 'queen', queens: [] };
  metadata.mutate(d => { d.cells[cell.id] = cell; });
  const raws = { root: { id: 'root', title: 'Goal', status: 'open', metadata: { hive_kind: 'goal' } } };
  const sent = [], errors = [];
  const host = { tasks: { get: () => ({ name: 'Example' }), forSession: () => null }, sessions: { get: id => ({ sessionId: id, status: 'working' }) }, deliver: async (id, text) => { sent.push({ id, text }); return { mode: 'live' }; } };
  const rt = { metadata, pendingParticipants: new Map(), host, log: e => errors.push(e), changed() {}, snapshots: {}, beads: {
    status: { state: 'ready' },
  } };
  rt.snapshots.refresh = async () => {
    rt.snapshots.graph = buildGraph(Object.values(raws));
    rt.snapshots.hierarchyCurrent = true;
    rt.snapshots.current = { graph: rt.snapshots.graph, loadedAt: Date.now(), error: null };
    return rt.snapshots.current;
  };
  rt.snapshots.invalidate = () => {};
  rt.snapshots.refresh();
  host.stores = { hive: rt };
  const actor = { role: 'human', sessionId: null, cell, cells: [{ cell, role: 'human' }] };
  return { rt, host, cell, actor, raws, sent, errors, file, create: schedule => setRoutine(rt, host, actor, { action: 'create', schedule: { ...config, ...schedule } }) };
}

test('schedules are durable records with dedicated topics and leave the work graph unchanged', async t => {
  const f = fixture(t);
  const before = structuredClone(f.rt.snapshots.graph);
  const [a, b] = await Promise.all([f.create(), f.create({ name: 'Other' })]);
  assert.ok(a.schedule_id);
  assert.notEqual(a.schedule_id, b.schedule_id);
  assert.deepEqual(f.rt.snapshots.graph, before);
  f.rt.metadata = new MetadataStore({ file: f.file });
  const record = f.rt.metadata.read().routines[a.schedule_id];
  assert.equal(record.timeZone, config.timeZone);
  assert.ok(record.threadId);
  const topic = f.rt.metadata.read().threads[f.cell.id][record.threadId];
  assert.equal(topic.scheduleId, record.id);
  assert.equal(topic.beadId, null);
});

test('catch-up fires once, concurrent ticks and restart cannot double fire, next cadence follows local time', async t => {
  const f = fixture(t);
  const { schedule_id } = await f.create();
  f.rt.metadata.mutate(d => { d.routines[schedule_id].nextRunAt = Date.parse('2026-11-16T09:00:00Z'); });
  await f.rt.snapshots.refresh();
  const now = Date.parse('2026-11-18T12:00:00Z');
  await Promise.all([runRoutines(f.rt, f.host, now), runRoutines(f.rt, f.host, now)]);
  f.rt.metadata = new MetadataStore({ file: f.file });
  await runRoutines(f.rt, f.host, now);
  const messages = f.rt.metadata.read().conversation[f.cell.id];
  assert.equal(messages.length, 1);
  assert.equal(iso(routineState(f.rt, f.rt.metadata.read().routines[schedule_id]).nextRunAt), '2026-11-19T09:00:00.000Z');
  assert.equal(f.sent.length, 1);
  assert.equal(messages[0].text, 'Scheduled: Daily check-in\n\nRun the daily check-in.');
  assert.equal(awaitingQueen(messages[0]), true);
  assert.equal(messages[0].delivery.attempts.length, 1);
  assert.equal(f.errors.length, 0);
});

test('fires target the replacement queen and reuse one dedicated topic, and queen replies settle scheduled input', async t => {
  const f = fixture(t);
  const { schedule_id } = await f.create();
  f.rt.metadata.mutate(d => { d.cells[f.cell.id].queenSessionId = 'replacement'; });
  await setRoutine(f.rt, f.host, f.actor, { schedule_id, action: 'run-now' });
  await setRoutine(f.rt, f.host, f.actor, { schedule_id, action: 'run-now' });
  assert.deepEqual(f.sent.map(s => s.id), ['replacement', 'replacement']);
  const list = f.rt.metadata.read().conversation[f.cell.id];
  assert.equal(new Set(list.map(m => m.threadId)).size, 1);
  assert.equal(f.rt.metadata.read().threads[f.cell.id][list[0].threadId].scheduleId, schedule_id);
  await publish(f.rt, { role: 'queen', sessionId: 'replacement', cell: f.rt.metadata.cell(f.cell.id), cells: [{ cell: f.cell, role: 'queen' }] }, { text: 'Done.', reply_to: list[0].id });
  assert.equal(awaitingQueen(f.rt.metadata.read().conversation[f.cell.id][0]), false);
});

test('no queen retains the message; recovery delivers it once to a later queen and interrupted delivery joins missed-input recovery', async t => {
  const f = fixture(t);
  const { schedule_id } = await f.create();
  f.rt.metadata.mutate(d => { d.cells[f.cell.id].queenSessionId = null; });
  await setRoutine(f.rt, f.host, f.actor, { schedule_id, action: 'run-now' });
  assert.equal(f.sent.length, 0);
  f.rt.metadata.mutate(d => { d.cells[f.cell.id].queenSessionId = 'later'; });
  await runRoutines(f.rt, f.host, 0);
  assert.equal(f.sent[0].id, 'later');
  await runRoutines(f.rt, f.host, 0);
  assert.equal(f.sent.length, 1);
  f.rt.metadata.mutate(d => { d.conversation[f.cell.id][0].delivery.state = 'pending'; });
  await runRoutines(f.rt, f.host, 0);
  assert.equal(f.rt.metadata.read().conversation[f.cell.id][0].delivery.state, 'pending', 'a delivery from the current runtime is left alone');
  f.rt.metadata = new MetadataStore({ file: f.file });
  await runRoutines(f.rt, f.host, 0);
  assert.equal(missedInput(f.rt.metadata.read(), f.rt.metadata.cell(f.cell.id)).length, 1);
  assert.equal(f.sent.length, 1);
});

test('pause, resume, run now and delete retain history; disabled, retired and captured hives never fire', async t => {
  const f = fixture(t);
  const { schedule_id } = await f.create();
  await setRoutine(f.rt, f.host, f.actor, { schedule_id, action: 'pause' });
  await runRoutines(f.rt, f.host, Date.now() + 86400000);
  assert.equal(f.sent.length, 0);
  await setRoutine(f.rt, f.host, f.actor, { schedule_id, action: 'run-now' });
  assert.equal(routineState(f.rt, f.rt.metadata.read().routines[schedule_id]).nextRunAt, null);
  await setRoutine(f.rt, f.host, f.actor, { schedule_id, action: 'resume' });
  for (const patch of [{ enabled: false }, { snapshot: {} }, { retired: {} }]) {
    f.rt.metadata.mutate(d => { Object.assign(d.cells[f.cell.id], patch); });
    await runRoutines(f.rt, f.host, Date.now() + 86400000);
    f.rt.metadata.mutate(d => { Object.assign(d.cells[f.cell.id], { enabled: true }); delete d.cells[f.cell.id].snapshot; delete d.cells[f.cell.id].retired; });
  }
  assert.equal(f.sent.length, 1);
  await setRoutine(f.rt, f.host, f.actor, { schedule_id, action: 'delete' });
  await runRoutines(f.rt, f.host, Date.now() + 86400000);
  assert.equal(f.sent.length, 1);
  assert.equal(f.rt.metadata.read().routines[schedule_id], undefined);
  assert.equal(f.rt.metadata.read().conversation[f.cell.id].length, 1);
});

test('schedule actions enforce hive ownership and queen authority', async t => {
  const f = fixture(t);
  const { schedule_id } = await f.create();
  await assert.rejects(setRoutine(f.rt, f.host, { ...f.actor, role: 'worker', sessionId: 'worker' }, { schedule_id, action: 'pause' }), /queen/i);
  f.rt.metadata.mutate(d => { d.cells.other = { ...f.cell, id: 'other' }; });
  await assert.rejects(setRoutine(f.rt, f.host, { ...f.actor, cell: f.rt.metadata.cell('other') }, { schedule_id, action: 'delete' }), /schedule/i);
  assert.equal(f.rt.metadata.read().routines[schedule_id].enabled, true);
});

test('renaming or editing a message keeps the due occurrence, and pause/resume are idempotent', async t => {
  const f = fixture(t);
  const { schedule_id } = await f.create();
  const due = Date.parse('2026-11-16T09:00:00Z');
  f.rt.metadata.mutate(d => { d.routines[schedule_id].nextRunAt = due; });
  await f.rt.snapshots.refresh();
  await setRoutine(f.rt, f.host, f.actor, { schedule_id, action: 'update', schedule: { name: 'Renamed', message: 'New prompt' } });
  assert.equal(routineState(f.rt, f.rt.metadata.read().routines[schedule_id]).nextRunAt, due);
  await setRoutine(f.rt, f.host, f.actor, { schedule_id, action: 'resume' });
  assert.equal(routineState(f.rt, f.rt.metadata.read().routines[schedule_id]).nextRunAt, due);
  await runRoutines(f.rt, f.host, Date.parse('2026-11-18T12:00:00Z'));
  assert.match(f.sent[0].text, /Scheduled: Renamed\n\nNew prompt/);
});

test('legacy operational state and absent routine fields are ignored safely', async t => {
  const f = fixture(t);
  f.rt.metadata.mutate(d => { d.routines.old = { cellId: f.cell.id, revision: 'legacy', nextRunAt: 0 }; d.routines.bad = null; });
  await runRoutines(f.rt, f.host, Date.now());
  assert.equal(f.sent.length, 0);
  assert.equal(f.errors.length, 0);
});

test('one failed queued-message recovery leaves it retryable and still recovers the next message', async t => {
  const f = fixture(t);
  const { schedule_id } = await f.create();
  f.rt.metadata.mutate(d => { d.cells[f.cell.id].queenSessionId = null; });
  await setRoutine(f.rt, f.host, f.actor, { schedule_id, action: 'run-now' });
  await setRoutine(f.rt, f.host, f.actor, { schedule_id, action: 'run-now' });
  const firstId = f.rt.metadata.read().conversation[f.cell.id][0].id;
  f.rt.metadata.mutate(d => { d.cells[f.cell.id].queenSessionId = 'later'; });
  const mutate = f.rt.metadata.mutate.bind(f.rt.metadata);
  let failOnce = true;
  f.rt.metadata.mutate = fn => mutate(d => {
    const out = fn(d);
    if (failOnce && d.conversation[f.cell.id].find(m => m.id === firstId).delivery.attempts.length) {
      failOnce = false;
      throw new Error('Temporary receipt failure.');
    }
    return out;
  });
  await runRoutines(f.rt, f.host, 0);
  assert.equal(f.sent.length, 1);
  assert.equal(f.errors.length, 1);
  assert.match(f.errors[0], /Temporary receipt failure/);
  assert.equal(f.rt.metadata.read().conversation[f.cell.id][0].delivery.attempts.length, 0);
  await runRoutines(f.rt, f.host, 0);
  assert.equal(f.sent.length, 2);
  assert.ok(f.rt.metadata.read().conversation[f.cell.id].every(m => m.delivery.state === 'delivered'));
});

test('schedules keep working while the work graph is unavailable', async t => {
  const f = fixture(t);
  f.rt.beads.status.state = 'unavailable';
  f.rt.snapshots.hierarchyCurrent = false;
  f.rt.snapshots.refresh = () => { throw new Error('Work graph should not be read.'); };
  const { schedule_id } = await f.create();
  f.rt.metadata.mutate(d => { d.routines[schedule_id].nextRunAt = 1; });
  await runRoutines(f.rt, f.host, 2);
  assert.equal(f.sent.length, 1);
  assert.equal(f.errors.length, 0);
});

test('a failed atomic fire leaves it due and does not starve another schedule or hive', async t => {
  const f = fixture(t);
  const first = await f.create();
  const second = await f.create({ name: 'Second' });
  f.rt.metadata.mutate(d => {
    for (const id of [first.schedule_id, second.schedule_id]) d.routines[id].nextRunAt = 1;
    d.cells.other = { ...f.cell, id: 'other' };
  });
  await setRoutine(f.rt, f.host, { ...f.actor, cell: f.rt.metadata.cell('other') }, { action: 'create', schedule: config });
  f.rt.metadata.mutate(d => { Object.values(d.routines).find(r => r.cellId === 'other').nextRunAt = 1; });
  const mutate = f.rt.metadata.mutate.bind(f.rt.metadata);
  let failOnce = true;
  f.rt.metadata.mutate = fn => mutate(d => {
    fn(d);
    if (failOnce && d.routines[first.schedule_id].lastRunAt) {
      failOnce = false;
      throw new Error('Temporary write failure.');
    }
  });
  await runRoutines(f.rt, f.host, 2);
  assert.equal(f.sent.length, 2);
  assert.equal(f.rt.metadata.read().routines[first.schedule_id].nextRunAt, 1);
  assert.equal(f.rt.metadata.read().conversation[f.cell.id].length, 1);
  assert.equal(f.rt.metadata.read().conversation.other.length, 1);
  assert.match(f.errors[0], /Temporary write failure/);
  await runRoutines(f.rt, f.host, 2);
  assert.equal(f.sent.length, 3);
});

test('deleting a schedule preserves its topic and already queued prompt recovery', async t => {
  const f = fixture(t);
  const { schedule_id, schedule } = await f.create();
  f.rt.metadata.mutate(d => { d.cells[f.cell.id].queenSessionId = null; });
  await setRoutine(f.rt, f.host, f.actor, { schedule_id, action: 'run-now' });
  await setRoutine(f.rt, f.host, f.actor, { schedule_id, action: 'delete' });
  assert.ok(f.rt.metadata.read().threads[f.cell.id][schedule.threadId]);
  f.rt.metadata.mutate(d => { d.cells[f.cell.id].queenSessionId = 'later'; });
  await runRoutines(f.rt, f.host, Date.now());
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].id, 'later');
  assert.equal(f.rt.metadata.read().routines[schedule_id], undefined);
});

test('projection exposes each hive schedules with their topic identity and never adds map items', async t => {
  const f = fixture(t);
  const { schedule_id, schedule } = await f.create();
  f.rt.metadata.mutate(d => { d.cells.other = { ...f.cell, id: 'other', rootBeadId: null }; });
  f.rt.paths = {};
  const graph = projectForGraph({ runtime: f.rt, snapshot: f.rt.snapshots.current });
  assert.deepEqual(graph.cells[f.cell.id].schedules.map(r => r.id), [schedule_id]);
  assert.deepEqual(graph.cells.other.schedules, []);
  assert.equal(graph.cells[f.cell.id].threads[0].scheduleId, schedule_id);
  assert.equal(graph.cells[f.cell.id].threads[0].id, schedule.threadId);
  assert.deepEqual(Object.keys(graph.beads), ['root']);
});
