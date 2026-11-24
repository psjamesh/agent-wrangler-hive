import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HiveRuntime } from '../server/runtime.js';
import { capacity, helperSlots } from '../server/admission.js';
import { liveClaimant, reconcileInactiveBindings } from '../server/tracking.js';
import { cellCounts } from '../public/model.js';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-activity-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const rt = new HiveRuntime({ env: { AW_DATA_DIR: dir } });
  const sessions = { builder: { status: 'working' }, reviewer: { status: 'working' }, helper: { status: 'working' } };
  const host = { stores: { hive: rt }, sessions: { get: id => sessions[id] } };
  rt.metadata.lifetime.attach(rt, host);
  const beads = { root: { id: 'root', kind: 'goal', status: 'open' }, work: { id: 'work', kind: 'work', status: 'in_progress', parentId: 'root', ownerSessionId: 'builder', assignee: 'aw:builder' } };
  const graph = { beads, edges: [] };
  rt.snapshots = { graph, current: { graph, revision: 1, loadedAt: 1 } };
  rt.metadata.mutate(d => { d.cells.cell = { id: 'cell', rootBeadId: 'root', enabled: true }; });
  const edit = fn => rt.metadata.mutate(fn);
  const project = () => rt.projection();
  const cell = () => project().cells.cell;
  return { rt, host, sessions, beads, graph, edit, project, cell };
}

const counts = cell => [cell.workingCount, cell.heldCount];

test('cached working, idle, input and dormant activity preserve retained claims and capacity', t => {
  const f = fixture(t);
  const original = capacity(f.rt);
  for (const state of [
    [{ status: 'working' }, [1, 0], 'working'],
    [{ status: 'idle' }, [0, 1], 'idle'],
    [{ status: 'needs-you' }, [0, 1], 'needs-you'],
    [{ status: 'needs-input' }, [0, 1], 'needs-input'],
    [{ status: 'working', dormant: true }, [0, 1], 'dormant'],
    [{ status: 'working', dormant: false, exitOutput: 'Exited' }, [0, 1], 'exited'],
    [{ status: 'errored', exitOutput: null }, [0, 1], 'errored'],
    [{ status: 'working' }, [1, 0], 'working'],
  ]) {
    Object.assign(f.sessions.builder, state[0]);
    assert.deepEqual(counts(f.cell()), state[1]);
    assert.equal(f.cell().workActivity[0].participants[0].state, state[2]);
    assert.equal(liveClaimant(f.host, 'builder'), true);
    assert.deepEqual(capacity(f.rt), original);
    assert.equal(f.beads.work.assignee, 'aw:builder');
    assert.equal(f.project(), f.project(), 'unchanged activity reuses projection');
  }
  f.sessions.builder.archived = true;
  assert.deepEqual(counts(f.cell()), [0, 0]);
  f.sessions.builder.archived = false;
  assert.deepEqual(counts(f.cell()), [1, 0]);
  f.sessions.builder.status = 'exited';
  assert.deepEqual(counts(f.cell()), [0, 0]);
});

test('one slot with idle owner, open reviewer and helpers counts working once', t => {
  const f = fixture(t);
  f.sessions.builder.status = 'idle';
  f.edit(d => {
    d.reviews.r = { id: 'r', cellId: 'cell', workBeadId: 'work', state: 'in_review', reviewerSessionId: 'reviewer' };
    d.bindings.cell = [
      { active: true, role: 'reviewer', beadId: 'work', sessionId: 'reviewer' },
      { active: true, role: 'investigator', helper: true, beadId: 'work', sessionId: 'helper' },
    ];
  });
  assert.deepEqual(counts(f.cell()), [1, 0]);
  assert.equal(f.cell().occupiedCount, 1);
  assert.deepEqual(f.cell().workActivity[0].sources.toSorted(), ['claim', 'helper', 'review']);
  f.sessions.reviewer.status = 'idle';
  f.sessions.helper.dormant = true;
  assert.deepEqual(counts(f.cell()), [0, 1]);
  f.sessions.reviewer.dormant = true;
  f.sessions.reviewer.status = 'working';
  assert.deepEqual(counts(f.cell()), [0, 1]);
  f.sessions.reviewer.dormant = false;
  assert.deepEqual(counts(f.cell()), [1, 0]);
  f.edit(d => { d.reviews.r.state = 'approved'; });
  assert.deepEqual(counts(f.cell()), [0, 1], 'completed reviewer binding cannot count activity elsewhere');
  f.edit(d => { d.reviews.r.state = 'requested'; });
  f.sessions.reviewer.archived = true;
  assert.deepEqual(counts(f.cell()), [0, 1]);
});

test('unknown and missing reservation sessions stay held with reconciliation provenance', t => {
  const f = fixture(t);
  delete f.beads.work.ownerSessionId;
  delete f.beads.work.assignee;
  for (const collection of ['reviews', 'workerLaunches', 'operations']) {
    f.edit(d => {
      d.reviews = {}; d.workerLaunches = {}; d.operations = {};
      d[collection].reservation = collection === 'reviews'
        ? { id: 'reservation', cellId: 'cell', workBeadId: 'work', state: 'requested', reviewerSessionId: 'missing' }
        : collection === 'workerLaunches' ? { id: 'reservation', cellId: 'cell', beadId: 'work', state: 'uncertain', sessionId: 'missing' }
          : { id: 'reservation', cellId: 'cell', kind: 'claim', state: 'partial', intent: { beadId: 'work', assignee: 'aw:missing' } };
    });
    assert.deepEqual(counts(f.cell()), [0, 1], collection);
    assert.equal(f.cell().workActivity[0].reconciliationNeeded, true);
    assert.match(f.cell().workActivity[0].reason, /reconcil/i);
  }
  f.sessions.missing = { status: 'unknown' };
  assert.deepEqual(counts(f.cell()), [0, 1]);
  assert.equal(f.cell().workActivity[0].participants[0].state, 'unknown');
});

test('helper eligibility rejects invalid targets and retains a released leaf slot', t => {
  const f = fixture(t);
  delete f.beads.work.ownerSessionId;
  delete f.beads.work.assignee;
  f.beads.work.status = 'open';
  Object.assign(f.beads, {
    closed: { id: 'closed', parentId: 'root', kind: 'work', status: 'closed' },
    group: { id: 'group', parentId: 'root', kind: 'workstream', status: 'open' },
    external: { id: 'external', parentId: 'root', kind: 'external', status: 'open' },
    outside: { id: 'outside', kind: 'work', status: 'open' },
  });
  for (const pending of [false, true]) for (const id of ['work', 'missing', 'closed', 'root', 'group', 'external', 'outside']) {
    f.edit(d => { d.bindings.cell = pending ? [] : [{ active: true, autoEnrolled: true, role: 'investigator', beadId: id, sessionId: 'helper' }]; });
    f.rt.spawnAdmissions = pending ? new Map([['a', { cellId: 'cell', beadId: id, at: Date.now() }]]) : new Map();
    assert.equal(helperSlots(f.rt).size, Number(id === 'work'), `${pending}: ${id}`);
    assert.equal(capacity(f.rt).used, Number(id === 'work'));
    assert.deepEqual(counts(f.cell()), id === 'work' ? pending ? [0, 1] : [1, 0] : [0, 0]);
  }
});

test('disabled, retired and nested hives keep activity attributed once; snapshots are historical', t => {
  const f = fixture(t);
  for (const extra of [{ enabled: false }, { enabled: false, retired: { outcome: 'done' } }, { enabled: true }]) {
    f.edit(d => { Object.assign(d.cells.cell, extra); });
    assert.deepEqual(counts(f.cell()), [1, 0]);
  }
  f.edit(d => { d.cells.cell.snapshot = {}; });
  assert.deepEqual(counts(f.cell()), [0, 0]);
  f.edit(d => { delete d.cells.cell.snapshot; d.cells.nested = { id: 'nested', rootBeadId: 'nested', enabled: true }; });
  f.beads.nested = { id: 'nested', parentId: 'root', kind: 'goal', status: 'open' };
  f.beads.work.parentId = 'nested';
  f.rt.snapshots.current.revision++;
  assert.deepEqual(counts(f.cell()), [0, 0]);
  assert.deepEqual(counts(f.project().cells.nested), [1, 0]);
});

test('unowned in-progress clusters are grouping state, not missing work; totals retain every descendant', t => {
  const f = fixture(t);
  f.beads.cluster = { id: 'cluster', kind: 'workstream', status: 'in_progress', parentId: 'root' };
  const summary = cellCounts(f.project(), f.cell());
  assert.equal(summary.not_active, 0);
  assert.equal(summary.open, 1);
  assert.equal(summary.total, 2);
});

test('missing and archived bindings end only in enabled non-snapshot hives', t => {
  const f = fixture(t);
  f.sessions.archived = { archived: true };
  f.sessions.exited = { status: 'exited' };
  f.edit(d => {
    for (const [id, extra] of Object.entries({ cell: {}, off: { enabled: false }, captured: { snapshot: {} } })) {
      d.cells[id] = { id, enabled: true, ...extra };
      d.bindings[id] = ['missing', 'archived', 'exited', 'helper'].map(sessionId => ({ sessionId, active: true, beadId: 'work' }));
    }
  });
  reconcileInactiveBindings(f.rt, f.host);
  const doc = f.rt.metadata.read();
  assert.deepEqual(doc.bindings.cell.map(b => b.active), [false, false, true, true]);
  assert.deepEqual(doc.bindings.cell.slice(0, 2).map(b => b.unboundBecause), ['Session missing', 'Session archived']);
  assert.ok(doc.bindings.cell[0].unboundAt);
  for (const id of ['off', 'captured']) assert.ok(doc.bindings[id].every(b => b.active));
  const version = f.rt.metadata.version;
  reconcileInactiveBindings(f.rt, f.host);
  assert.equal(f.rt.metadata.version, version);
});


test('cached helper activity follows session changes after its owner releases the leaf', t => {
  const f = fixture(t);
  delete f.beads.work.ownerSessionId; delete f.beads.work.assignee;
  f.beads.work.status = 'open';
  f.edit(d => { d.bindings.cell = [{ active: true, autoEnrolled: true, beadId: 'work', sessionId: 'helper', role: 'investigator' }]; });
  for (const [patch, expected] of [[{ status: 'working' }, [1, 0]], [{ status: 'idle' }, [0, 1]], [{ dormant: true }, [0, 1]], [{ dormant: false, status: 'needs-you' }, [0, 1]], [{ status: 'working' }, [1, 0]]]) {
    Object.assign(f.sessions.helper, patch);
    assert.deepEqual(counts(f.cell()), expected);
    assert.equal(capacity(f.rt).used, 1);
  }
  delete f.sessions.helper;
  assert.deepEqual(counts(f.cell()), [0, 0]);
  assert.equal(f.cell().workActivity.length, 0, 'automatic cleanup resolves the missing helper reservation');
  assert.equal(f.rt.metadata.read().bindings.cell[0].active, false);
  f.sessions.helper = { status: 'working' };
  assert.equal(f.cell().workActivity.length, 0, 'inactive missing binding is not a restored reservation');
});

test('launches and restores do not imply work, and transient expiry refreshes cached held counts', t => {
  const f = fixture(t);
  delete f.beads.work.ownerSessionId; delete f.beads.work.assignee;
  f.beads.work.status = 'open';
  f.rt.workerRestores = new Map([['builder', { beadId: 'work', cellId: 'cell', at: Date.now() }]]);
  assert.deepEqual(counts(f.cell()), [0, 1]);
  assert.deepEqual(f.cell().workActivity[0].sources, ['restore']);
  f.rt.workerRestores.get('builder').at -= 10 * 60 * 1000;
  assert.deepEqual(counts(f.cell()), [0, 0]);
  f.rt.spawnAdmissions = new Map([['launch', { id: 'launch', cellId: 'cell', beadId: 'work', at: Date.now() }]]);
  assert.deepEqual(counts(f.cell()), [0, 1]);
  assert.deepEqual(f.cell().workActivity[0].sources, ['launch']);
  f.rt.spawnAdmissions.get('launch').at -= 10 * 60 * 1000;
  assert.deepEqual(counts(f.cell()), [0, 0]);
});

test('an archived review session stops reserving capacity and never shows green activity', t => {
  const f = fixture(t);
  delete f.beads.work.ownerSessionId; delete f.beads.work.assignee;
  f.edit(d => { d.reviews.r = { id: 'r', cellId: 'cell', workBeadId: 'work', state: 'requested', reviewerSessionId: 'reviewer' }; });
  assert.deepEqual(counts(f.cell()), [1, 0]);
  f.sessions.reviewer.archived = true;
  assert.deepEqual(counts(f.cell()), [0, 0]);
  assert.equal(f.cell().workActivity[0].state, 'reconciliation');
  delete f.sessions.reviewer;
  assert.deepEqual(counts(f.cell()), [0, 1]);
  assert.equal(f.cell().workActivity[0].participants[0].state, 'missing');
});

test('a present session with no board status holds work without an unknown-reservation alarm', t => {
  const f = fixture(t);
  f.sessions.builder.status = null;
  assert.deepEqual(counts(f.cell()), [0, 1]);
  assert.equal(f.cell().workActivity[0].participants[0].state, 'unavailable');
  assert.equal(f.cell().workActivity[0].reconciliationNeeded, false);
  delete f.beads.work.ownerSessionId; delete f.beads.work.assignee;
  f.edit(d => { d.reviews.r = { id: 'r', cellId: 'cell', workBeadId: 'work', state: 'requested', reviewerSessionId: 'reviewer' }; });
  f.sessions.reviewer.status = null;
  f.rt.snapshots.current.revision++;
  assert.deepEqual(counts(f.cell()), [0, 1]);
  assert.equal(f.cell().workActivity[0].reconciliationNeeded, false);
});
