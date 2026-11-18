import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { nextRunAt } from '../server/schedule-time.js';
import { validateSchedule } from '../public/schedule.js';
import { MetadataStore } from '../server/metadata-store.js';
import { buildGraph, HIVE_META, encodeMeta } from '../server/bead-model.js';
import { setRoutine, runRoutines, routineState } from '../server/routines.js';
import { capacity, checkAdmission } from '../server/admission.js';
import { readyBeads, updateBead, createBeads, assessCompletion } from '../server/ops.js';
import { isUntracked } from '../server/tracking.js';
import { pickupState } from '../server/pickup.js';
import { collectWatchdog } from '../server/watchdog.js';
import { awaitingQueen, publish } from '../server/conversation.js';
import { missedInput } from '../server/missed-input.js';
import { reconcileColours } from '../server/colours.js';
import { workstreamColour, SCHEDULE_COLOUR } from '../public/workstream-colours.js';
import { cellCounts } from '../public/model.js';

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
  let seq = 0;
  const sent = [], errors = [];
  const host = { tasks: { get: () => ({ name: 'Example' }), forSession: () => null }, sessions: { get: id => ({ sessionId: id, status: 'working' }) }, deliver: async (id, text) => { sent.push({ id, text }); return { mode: 'live' }; } };
  const rt = { metadata, pendingParticipants: new Map(), host, log: e => errors.push(e), changed() {}, snapshots: {}, beads: {
    status: { state: 'ready' },
    async createMany({ nodes }) {
      const ids = Object.fromEntries(nodes.map(n => [n.key, `hive-${++seq}`]));
      for (const n of nodes) {
        const id = ids[n.key];
        raws[id] = { id, title: n.title, issue_type: n.issueType, status: 'open', metadata: {}, dependencies: [{ issue_id: id, depends_on_id: n.parentId || ids[n.parentKey], type: 'parent-child' }] };
        for (const [key, meta] of Object.entries(HIVE_META)) if (n[key] !== undefined) raws[id].metadata[meta] = encodeMeta(n[key]);
      }
      return { ids };
    },
    async update(id, patch) {
      for (const [key, value] of Object.entries(patch)) {
        if (HIVE_META[key]) raws[id].metadata[HIVE_META[key]] = encodeMeta(value);
        else raws[id][key] = value;
      }
    },
    async show(id) { return structuredClone(raws[id]); },
    async close(id) { raws[id].status = 'closed'; },
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

test('creation is serialized into one reserved cluster; configuration and operational state survive restart', async t => {
  const f = fixture(t);
  const [a, b] = await Promise.all([f.create(), f.create({ name: 'Other' })]);
  assert.equal(a.cluster_id, b.cluster_id);
  assert.equal(Object.values(f.rt.snapshots.graph.beads).filter(b => b.system === 'schedules').length, 1);
  const raw = f.raws[a.bead_id];
  assert.equal(JSON.parse(raw.metadata.hive_schedule).timeZone, config.timeZone);
  const due = Date.parse('2026-11-18T09:00:00Z');
  raw.metadata.hive_schedule = encodeMeta({ ...JSON.parse(raw.metadata.hive_schedule), nextRunAt: due });
  await f.rt.snapshots.refresh();
  await runRoutines(f.rt, f.host, due);
  f.rt.metadata = new MetadataStore({ file: f.file });
  assert.equal(routineState(f.rt, f.rt.snapshots.graph.beads[a.bead_id]).lastRunAt, due);
});

test('catch-up fires once, concurrent ticks and restart cannot double fire, next cadence follows local time', async t => {
  const f = fixture(t);
  const { bead_id } = await f.create();
  f.raws[bead_id].metadata.hive_schedule = encodeMeta({ ...config, enabled: true, revision: 'rev', nextRunAt: Date.parse('2026-11-16T09:00:00Z') });
  await f.rt.snapshots.refresh();
  const now = Date.parse('2026-11-18T12:00:00Z');
  await Promise.all([runRoutines(f.rt, f.host, now), runRoutines(f.rt, f.host, now)]);
  f.rt.metadata = new MetadataStore({ file: f.file });
  await runRoutines(f.rt, f.host, now);
  const messages = f.rt.metadata.read().conversation[f.cell.id];
  assert.equal(messages.length, 1);
  assert.equal(iso(routineState(f.rt, f.rt.snapshots.graph.beads[bead_id]).nextRunAt), '2026-11-19T09:00:00.000Z');
  assert.equal(f.sent.length, 1);
  assert.equal(messages[0].text, 'Scheduled: Daily check-in\n\nRun the daily check-in.');
  assert.equal(awaitingQueen(messages[0]), true);
  assert.equal(messages[0].delivery.attempts.length, 1);
  assert.equal(f.errors.length, 0);
});

test('fires target the replacement queen and reuse one anchored topic, and queen replies settle scheduled input', async t => {
  const f = fixture(t);
  const { bead_id } = await f.create();
  f.rt.metadata.mutate(d => { d.cells[f.cell.id].queenSessionId = 'replacement'; });
  await setRoutine(f.rt, f.host, f.actor, { bead_id, action: 'run-now' });
  await setRoutine(f.rt, f.host, f.actor, { bead_id, action: 'run-now' });
  assert.deepEqual(f.sent.map(s => s.id), ['replacement', 'replacement']);
  const list = f.rt.metadata.read().conversation[f.cell.id];
  assert.equal(new Set(list.map(m => m.threadId)).size, 1);
  assert.equal(f.rt.metadata.read().threads[f.cell.id][list[0].threadId].beadId, bead_id);
  await publish(f.rt, { role: 'queen', sessionId: 'replacement', cell: f.rt.metadata.cell(f.cell.id), cells: [{ cell: f.cell, role: 'queen' }] }, { text: 'Done.', reply_to: list[0].id });
  assert.equal(awaitingQueen(f.rt.metadata.read().conversation[f.cell.id][0]), false);
});

test('no queen retains the message; recovery delivers it once to a later queen and interrupted delivery joins missed-input recovery', async t => {
  const f = fixture(t);
  const { bead_id } = await f.create();
  f.rt.metadata.mutate(d => { d.cells[f.cell.id].queenSessionId = null; });
  await setRoutine(f.rt, f.host, f.actor, { bead_id, action: 'run-now' });
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

test('pause, resume, run now and end retain history; disabled, retired and captured hives never fire', async t => {
  const f = fixture(t);
  const { bead_id } = await f.create();
  await setRoutine(f.rt, f.host, f.actor, { bead_id, action: 'pause' });
  await runRoutines(f.rt, f.host, Date.now() + 86400000);
  assert.equal(f.sent.length, 0);
  await setRoutine(f.rt, f.host, f.actor, { bead_id, action: 'run-now' });
  assert.equal(routineState(f.rt, f.rt.snapshots.graph.beads[bead_id]).nextRunAt, null);
  await setRoutine(f.rt, f.host, f.actor, { bead_id, action: 'resume' });
  for (const patch of [{ enabled: false }, { snapshot: {} }, { retired: {} }]) {
    f.rt.metadata.mutate(d => { Object.assign(d.cells[f.cell.id], patch); });
    await runRoutines(f.rt, f.host, Date.now() + 86400000);
    f.rt.metadata.mutate(d => { Object.assign(d.cells[f.cell.id], { enabled: true }); delete d.cells[f.cell.id].snapshot; delete d.cells[f.cell.id].retired; });
  }
  assert.equal(f.sent.length, 1);
  await setRoutine(f.rt, f.host, f.actor, { bead_id, action: 'end' });
  await runRoutines(f.rt, f.host, Date.now() + 86400000);
  assert.equal(f.sent.length, 1);
  assert.equal(routineState(f.rt, f.rt.snapshots.graph.beads[bead_id]).lastOutcome, 'delivered');
});

test('routines and their cluster cannot be claimed, picked up, moved or converted, do not count as work, and reserve a colour', async t => {
  const f = fixture(t);
  const { bead_id, cluster_id } = await f.create();
  const graph = f.rt.snapshots.graph;
  for (const id of [bead_id, cluster_id]) {
    assert.throws(() => checkAdmission(f.rt, graph, id), /never claimable/);
    assert.equal(isUntracked(f.host, graph, graph.beads[id]), false);
    assert.equal(pickupState(f.rt, f.host, f.cell, graph.beads[id]).eligible, false);
    await assert.rejects(updateBead(f.rt, f.actor, { bead_id: id, kind: 'work' }), /keep their kind/);
    await assert.rejects(updateBead(f.rt, f.actor, { bead_id: id, parent_id: 'root' }), /keep their kind/);
  }
  assert.equal(capacity(f.rt).used, 0);
  assert.deepEqual(readyBeads(f.rt, f.actor, {}).ready, []);
  assert.equal(cellCounts({ beads: graph.beads, edges: [] }, f.cell).total, 0);
  assert.deepEqual(collectWatchdog(f.rt, f.host, f.cell, Date.now() + 30 * 86400000).filter(flag => [bead_id, cluster_id].includes(flag.bead_id)), []);
  await assert.rejects(createBeads(f.rt, f.actor, { beads: [{ kind: 'routine', title: 'Bypass' }] }), /hive_set_routine/);
  await assert.rejects(createBeads(f.rt, f.actor, { beads: [{ title: 'Wrong child', parent: cluster_id }] }), /only contains routines/);
  assert.ok(assessCompletion(f.rt, f.cell, cluster_id, graph, 'aw:human').problems.some(s => /only when empty/.test(s)));
  reconcileColours(f.rt.metadata, graph.beads);
  assert.equal(workstreamColour(cluster_id, f.rt.metadata.read().workstreamColours[f.cell.id]), SCHEDULE_COLOUR);
  for (let i = 0; i < 50; i++) assert.notEqual(workstreamColour(`ordinary-${i}`), SCHEDULE_COLOUR);
});

test('renaming or editing a message keeps the due occurrence, and pause/resume are idempotent', async t => {
  const f = fixture(t);
  const { bead_id } = await f.create();
  const due = Date.parse('2026-11-16T09:00:00Z');
  f.raws[bead_id].metadata.hive_schedule = encodeMeta({ ...config, enabled: true, revision: 'old', nextRunAt: due });
  await f.rt.snapshots.refresh();
  await setRoutine(f.rt, f.host, f.actor, { bead_id, action: 'update', schedule: { name: 'Renamed', message: 'New prompt' } });
  assert.equal(routineState(f.rt, f.rt.snapshots.graph.beads[bead_id]).nextRunAt, due);
  await setRoutine(f.rt, f.host, f.actor, { bead_id, action: 'resume' });
  assert.equal(routineState(f.rt, f.rt.snapshots.graph.beads[bead_id]).nextRunAt, due);
  await runRoutines(f.rt, f.host, Date.parse('2026-11-18T12:00:00Z'));
  assert.match(f.sent[0].text, /Scheduled: Renamed\n\nNew prompt/);
});
