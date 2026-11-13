import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkRetire, retireCell, reopenCell } from '../server/retire.js';
import { setCellEnabled, moveCell } from '../server/ops.js';

const bead = (id, parentId, extra = {}) => ({ id, parentId, title: id, kind: 'task', status: 'closed', ...extra });

function fixture({ beads, sessions = {}, archiveFails = [], ops = {}, cells = {} } = {}) {
  let doc = {
    cells: { c1: { id: 'c1', taskId: 't1', rootBeadId: 'root', enabled: true, queenSessionId: 'q1', position: { q: 2, r: 0 } }, ...cells },
    operations: ops, bindings: { c1: [{ active: true, sessionId: 'w1', role: 'builder' }] },
  };
  const live = beads || { root: bead('root', null), a: bead('a', 'root') };
  const archived = [];
  const rt = {
    metadata: { read: () => doc, error: null, cell: (id) => doc.cells[id], mutate: (fn) => { const next = structuredClone(doc); const r = fn(next); doc = next; return r; } },
    snapshots: { graph: { beads: live, edges: [] }, hierarchyCurrent: true },
  };
  const all = { a1: { sessionId: 'a1', name: 'gone', taskId: 't1', archived: true }, ...sessions };
  const host = { sessions: {
    get: (id) => all[id] || null,
    forTask: () => Object.values(all),
    archive: async (id) => { if (archiveFails.includes(id)) throw new Error('refused'); archived.push(id); },
  } };
  return { rt, host, doc: () => doc, archived };
}
const sid = (n) => `00000000-0000-4000-8000-00000000000${n}`;

test('a finished hive retires with an outcome and record, and turns off', async () => {
  const f = fixture();
  const out = await retireCell(f.rt, f.host, { cellId: 'c1', outcome: 'done', summary: ' all shipped ' });
  assert.equal(out.retired, true);
  const c = f.doc().cells.c1;
  assert.equal(c.enabled, false);
  assert.equal(c.retired.outcome, 'done');
  assert.equal(c.retired.summary, 'all shipped');
  assert.equal(c.retired.by, 'aw:human');
  assert.deepEqual(c.retired.position, { q: 2, r: 0 });
  assert.ok(c.retired.at > 0);
  assert.equal(f.archived.length, 0);
});

test('open work, claims and unsettled writes refuse without the override and are listed', async () => {
  const f = fixture({ beads: { root: bead('root', null), a: bead('a', 'root', { status: 'in_progress', assignee: 'aw:x' }) }, ops: { o1: { id: 'o1', cellId: 'c1', state: 'uncertain' } } });
  const check = checkRetire(f.rt, f.host, { cellId: 'c1' });
  assert.equal(check.openCount, 1);
  assert.equal(check.claimCount, 1);
  assert.equal(check.unsettledCount, 1);
  assert.equal(check.problems.length, 3);
  await assert.rejects(retireCell(f.rt, f.host, { cellId: 'c1', outcome: 'dropped', summary: 'x' }), /not retired/);
  assert.equal(f.doc().cells.c1.retired, undefined);
  await retireCell(f.rt, f.host, { cellId: 'c1', outcome: 'dropped', summary: 'x', override: true });
  assert.equal(f.doc().cells.c1.retired.overridden, true);
});

test('retire validates outcome and summary', async () => {
  const f = fixture();
  await assert.rejects(retireCell(f.rt, f.host, { cellId: 'c1', outcome: 'duplicate', summary: 'x' }), /outcome/);
  await assert.rejects(retireCell(f.rt, f.host, { cellId: 'c1', outcome: 'done', summary: '  ' }), /summary/);
});

test('the check lists live sessions only, and retiring leaves them alone by default', async () => {
  const f = fixture();
  assert.deepEqual(checkRetire(f.rt, f.host, { cellId: 'c1' }).sessions.map((s) => s.session_id).sort(), []);
  const g = fixture({ sessions: { [sid(1)]: { sessionId: sid(1), name: 'one', taskId: 't1' } } });
  assert.deepEqual(checkRetire(g.rt, g.host, { cellId: 'c1' }).sessions.map((s) => s.session_id), [sid(1)]);
  await retireCell(g.rt, g.host, { cellId: 'c1', outcome: 'done', summary: 's' });
  assert.equal(g.archived.length, 0);
});

test('archive sessions too archives each live session and lists failures without blocking', async () => {
  const f = fixture({ sessions: { [sid(1)]: { sessionId: sid(1), name: 'one', taskId: 't1' }, [sid(2)]: { sessionId: sid(2), name: 'two', taskId: 't1' } }, archiveFails: [sid(2)] });
  const out = await retireCell(f.rt, f.host, { cellId: 'c1', outcome: 'done', summary: 's', archiveSessions: true });
  assert.deepEqual(f.archived, [sid(1)]);
  assert.equal(out.archiveFailed.length, 1);
  assert.equal(out.archiveFailed[0].sessionId, sid(2));
  assert.equal(f.doc().cells.c1.retired.outcome, 'done');
});

test('a retired hive keeps its record and cannot retire twice', async () => {
  const f = fixture();
  await retireCell(f.rt, f.host, { cellId: 'c1', outcome: 'done', summary: 's' });
  assert.equal(f.doc().cells.c1.rootBeadId, 'root');
  await assert.rejects(retireCell(f.rt, f.host, { cellId: 'c1', outcome: 'done', summary: 's' }), /already retired/);
});

test('reopen needs a reason and returns to the old position when free', async () => {
  const f = fixture();
  await retireCell(f.rt, f.host, { cellId: 'c1', outcome: 'done', summary: 's' });
  assert.throws(() => reopenCell(f.rt, { cellId: 'c1', reason: '' }), /reason/);
  const out = reopenCell(f.rt, { cellId: 'c1', reason: 'more work' });
  assert.deepEqual(out.position, { q: 2, r: 0 });
  const c = f.doc().cells.c1;
  assert.equal(c.enabled, true);
  assert.equal(c.retired, undefined);
  assert.equal(c.reopened.reason, 'more work');
  assert.equal(c.reopened.was.outcome, 'done');
  assert.throws(() => reopenCell(f.rt, { cellId: 'c1', reason: 'again' }), /not retired/);
});

test('reopen goes to the nearest free place when the old one was taken, moving nothing else', async () => {
  const f = fixture({ cells: { c2: { id: 'c2', taskId: 't2', enabled: true, position: { q: 3, r: 0 } }, c3: { id: 'c3', taskId: 't3', enabled: true, position: { q: 0, r: 0 } } } });
  await retireCell(f.rt, f.host, { cellId: 'c1', outcome: 'done', summary: 's' });
  moveCell(f.rt, { cellId: 'c3', position: { q: 2, r: 0 } });
  assert.deepEqual(f.doc().cells.c3.position, { q: 2, r: 0 });
  const out = reopenCell(f.rt, { cellId: 'c1', reason: 'r' });
  assert.notDeepEqual(out.position, { q: 2, r: 0 });
  assert.notDeepEqual(out.position, { q: 3, r: 0 });
  const d = Math.max(Math.abs(out.position.q - 2), Math.abs(out.position.r), Math.abs(out.position.q - 2 + out.position.r));
  assert.equal(d, 1);
  assert.deepEqual(f.doc().cells.c3.position, { q: 2, r: 0 });
  assert.deepEqual(f.doc().cells.c2.position, { q: 3, r: 0 });
});

test('a retired hive does not hold its place against a move, and cannot be turned on without reopening', async () => {
  const f = fixture({ cells: { c2: { id: 'c2', taskId: 't2', enabled: true, position: { q: 0, r: 0 } } } });
  await retireCell(f.rt, f.host, { cellId: 'c1', outcome: 'done', summary: 's' });
  moveCell(f.rt, { cellId: 'c2', position: { q: 2, r: 0 } });
  assert.deepEqual(f.doc().cells.c1.position, { q: 2, r: 0 });
  assert.deepEqual(f.doc().cells.c2.position, { q: 2, r: 0 });
  assert.throws(() => setCellEnabled(f.rt, { cellId: 'c1', enabled: true }), /Reopen/);
});

import { configHandlers } from '../server/handlers.js';

const call = async (type, msg, f) => {
  f.rt.changed = () => {};
  const frames = [];
  await configHandlers.find((h) => h.type === type).handler(msg, { stores: { hive: f.rt }, ...f.host }, (r) => frames.push(r));
  return frames[0];
};

test('handlers check, retire and reopen, and report refusals', async () => {
  const f = fixture({ beads: { root: bead('root', null), a: bead('a', 'root', { status: 'open' }) } });
  const checked = await call('hive-cell-retire-check', { cellId: 'c1' }, f);
  assert.equal(checked.ok, true);
  assert.equal(checked.openCount, 1);
  const refused = await call('hive-cell-retire', { cellId: 'c1', outcome: 'done', summary: 's' }, f);
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'refused');
  const retired = await call('hive-cell-retire', { cellId: 'c1', outcome: 'dropped', summary: 's', override: true, archiveSessions: true }, f);
  assert.equal(retired.ok, true);
  assert.deepEqual(retired.archiveFailed, []);
  const bad = await call('hive-cell-reopen', { cellId: 'c1', reason: '' }, f);
  assert.equal(bad.ok, false);
  const reopened = await call('hive-cell-reopen', { cellId: 'c1', reason: 'back' }, f);
  assert.equal(reopened.ok, true);
  assert.equal(f.doc().cells.c1.enabled, true);
});

test('a retired hive refuses map moves and is no queen route', async () => {
  const f = fixture();
  await retireCell(f.rt, f.host, { cellId: 'c1', outcome: 'done', summary: 's' });
  const { moveBeads } = await import('../server/ops.js');
  assert.throws(() => moveBeads(f.rt, { cellId: 'c1', positions: { a: null } }), /retired/);
  assert.equal(f.doc().cells.c1.enabled, false);
});

test('adopting the task of a retired hive is refused, and only the shown sessions are archived', async () => {
  const { adoptTask } = await import('../server/ops.js');
  const f = fixture({ sessions: { [sid(1)]: { sessionId: sid(1), name: 'one', taskId: 't1' }, [sid(2)]: { sessionId: sid(2), name: 'late', taskId: 't1' } } });
  f.rt.beads = { status: { state: 'ready' } };
  const out = await retireCell(f.rt, f.host, { cellId: 'c1', outcome: 'done', summary: 's', archiveSessions: true, sessionIds: [sid(1)] });
  assert.deepEqual(f.archived, [sid(1)]);
  assert.deepEqual(out.archiveFailed, []);
  f.rt.metadata.cellForTask = (t) => Object.values(f.doc().cells).find((c) => c.taskId === t);
  f.rt.snapshots.hierarchyCurrent = true;
  f.host.tasks = { get: () => ({ id: 't1' }), adhocId: 'x' };
  await assert.rejects(adoptTask(f.rt, f.host, { taskId: 't1' }), /Reopen hive/);
  assert.equal(f.doc().cells.c1.enabled, false);
});
