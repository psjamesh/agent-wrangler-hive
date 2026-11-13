import assert from 'node:assert/strict';
import { test } from 'node:test';
import { performance } from 'node:perf_hooks';
import { archiveHidden, activeKids, planReturn } from '../public/archive-layout.js';
import { layoutCell } from '../public/cell-layout.js';
import { landscapeOffsets } from '../public/hex-layout.js';
import { layoutBase } from '../public/layout-base.js';
import { nearestFree, MAX_COORD } from '../public/hex-search.js';
import { planMove } from '../public/cell-move.js';
import { reopenUnfinished, reopenWorkstream, archiveWorkstream, showWorkstream } from '../server/workstreams.js';
import { withLocks, settleOne, moveBeads } from '../server/ops.js';
import { archiveReply } from '../public/workstream-view.js';

const p = (q, r) => ({ q, r });
const bead = (id, parentId, extra = {}) => ({ id, parentId, title: id, kind: 'workstream', status: 'closed', closedAt: '2026-11-01', summary: 'kept', outcome: 'dropped', ...extra });
const raw = (b) => ({ id: b.id, title: b.title, status: b.status, closed_at: b.closedAt, notes: b.summary, metadata: { hive_outcome: b.outcome, hive_kind: b.kind }, dependencies: b.parentId ? [{ type: 'parent-child', issue_id: b.id, depends_on_id: b.parentId }] : [] });
const lay = (beads, saved, hidden = new Set(), rootId = 'root') => layoutCell({ kids: activeKids(beads, hidden), rootId, saved });
const offset = (l, a, b) => p(l.positions[b].q - l.positions[a].q, l.positions[b].r - l.positions[a].r);
const ring = [p(1, 0), p(0, 1), p(-1, 1), p(-1, 0), p(0, -1), p(1, -1)];

function fixture(beads, saved = {}) {
  let doc = { cells: { cell: { id: 'cell', rootBeadId: 'root', enabled: true } }, archived: {}, beadLayout: { cell: structuredClone(saved) }, arrangeAspect: {}, workstreamColours: {}, conversation: {}, operations: {}, restoreNotices: {}, restoring: {} };
  const live = structuredClone(beads);
  const calls = [];
  const logs = [];
  const snapshot = () => ({ beads: structuredClone(live), edges: [] });
  const rt = {
    metadata: {
      read: () => doc,
      cell: (id) => doc.cells[id],
      cells: () => Object.values(doc.cells),
      mutate: (fn) => {
        const next = structuredClone(doc);
        const result = fn(next);
        doc = next;
        return result;
      },
    },
    snapshots: { graph: snapshot(), hierarchyCurrent: true, refresh: async () => { rt.snapshots.graph = snapshot(); }, invalidate() {} },
    beads: {
      status: { state: 'ready' },
      show: async (id) => (live[id] ? raw(live[id]) : null),
      reopen: async (ids, reason, actor, check) => {
        check?.({ issues: Object.values(live).map(raw), errors: [] });
        calls.push({ ids, reason, actor });
        for (const id of ids) live[id] = { ...live[id], status: 'open', closedAt: null };
      },
    },
    log: (s) => logs.push(s),
    changed() {},
  };
  return { rt, live, calls, logs, doc: () => doc, refresh: () => rt.snapshots.refresh() };
}
const hidden = (f) => archiveHidden({ beads: f.rt.snapshots.graph.beads, rootId: 'root', archived: f.doc().archived });

test('fenced reopen refuses a changed parent and writes nothing', async () => {
  const f = fixture({ root: bead('root'), a: bead('a', 'root'), z: bead('z', 'root'), n: bead('n', 'a') });
  f.live.n.parentId = 'z';
  await assert.rejects(reopenWorkstream(f.rt, { cellId: 'cell', headId: 'n', reason: 'more', confirmAncestors: ['a'] }), /workstreams around n changed/);
  assert.equal(f.calls.length, 0);
});

test('only top-level workstreams are archived, and reopening work inside one brings the whole group back in shape', async () => {
  const f = fixture({ root: bead('root'), a: bead('a', 'root'), n: bead('n', 'a'), b: bead('b', 'n'), s: bead('s', 'a') }, { a: p(0, 0), n: p(1, 0), b: p(2, 0), s: p(0, 1) });
  await assert.rejects(archiveWorkstream(f.rt, { cellId: 'cell', headId: 'n' }), /Only top-level workstreams/);
  await archiveWorkstream(f.rt, { cellId: 'cell', headId: 'a' });
  const out = await reopenWorkstream(f.rt, { cellId: 'cell', headId: 'n', reason: 'more', confirmAncestors: ['a'] });
  const l = lay(f.rt.snapshots.graph.beads, f.doc().beadLayout.cell);
  assert.equal(out.placed, 'restored');
  for (const [id, at] of Object.entries({ a: p(0, 0), n: p(1, 0), b: p(2, 0), s: p(0, 1) })) assert.deepEqual(l.positions[id], at);
  assert.equal(f.live.b.status, 'closed');
  assert.deepEqual(f.doc().archived, {});
});

test('a group returns to its former hexes when they are free', () => {
  const beads = { root: bead('root'), a: bead('a', 'root'), n: bead('n', 'root') };
  const r = planReturn({ beads, rootId: 'root', saved: { a: p(100, 0) }, hiddenBefore: new Set(['n']), hiddenAfter: new Set(), headId: 'n', positions: { n: p(1, 0) } });
  assert.equal(r.shift, 0);
  const l = lay(beads, r.saved);
  assert.deepEqual(l.positions.a, p(100, 0));
  assert.deepEqual(l.positions.n, p(1, 0));
});

test('inverse and duplicate multi-lock requests finish', async () => {
  let n = 0;
  const out = await Promise.race([
    Promise.all([withLocks(['bead:z2', 'bead:a2', 'bead:z2'], () => n++), withLocks(['bead:a2', 'bead:z2'], () => n++)]).then(() => true),
    new Promise((r) => setTimeout(() => r(false), 30)),
  ]);
  assert.equal(out, true);
  assert.equal(n, 2);
});

test('reconciler reopens only the needed ancestors, restores rigidly and is idempotent', async () => {
  const f = fixture({ root: bead('root'), a: bead('a', 'root'), n: bead('n', 'a'), b: bead('b', 'n'), s: bead('s', 'a') }, { a: p(10, 0), n: p(11, 0), b: p(12, 0), s: p(10, 1) });
  await archiveWorkstream(f.rt, { cellId: 'cell', headId: 'a' });
  f.live.b.status = 'open';
  f.live.b.closedAt = null;
  f.live.x = bead('x', 'root', { status: 'open', closedAt: null });
  await f.refresh();
  const pre = lay(f.rt.snapshots.graph.beads, f.doc().beadLayout.cell, hidden(f));
  await reopenUnfinished(f.rt);
  assert.equal(f.live.a.status, 'open');
  assert.equal(f.live.n.status, 'open');
  assert.equal(f.live.s.status, 'closed');
  assert.equal(f.live.root.status, 'closed');
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].actor, 'hive');
  assert.equal(f.doc().archived.a, undefined);
  const l = lay(f.rt.snapshots.graph.beads, f.doc().beadLayout.cell);
  assert.deepEqual(l.positions.x, pre.positions.x);
  assert.deepEqual(offset(l, 'n', 'b'), p(1, 0));
  assert.equal(f.doc().restoreNotices.cell.length, 1);
  f.live.b.status = 'closed';
  await f.refresh();
  await reopenUnfinished(f.rt);
  assert.equal(f.calls.length, 1);
  assert(!hidden(f).has('a'));
});

test('a record for a heading that is no longer top-level hides nothing', async () => {
  const f = fixture({ root: bead('root'), a: bead('a', 'root', { status: 'open', closedAt: null }), n: bead('n', 'a'), b: bead('b', 'n') });
  f.doc().archived.n = { closedAt: '2026-11-01', ids: ['n', 'b'], positions: { n: p(1, 0), b: p(2, 0) } };
  assert.equal(hidden(f).size, 0);
});

test('reconciler skips disabled and captured hives, the goal and ancestors outside the root', async () => {
  for (const change of [(c) => { c.enabled = false; }, (c) => { c.snapshot = {}; }, () => {}]) {
    const f = fixture({ outside: bead('outside'), root: bead('root', 'outside', { status: 'open' }), b: bead('b', 'root', { status: 'open' }) });
    change(f.doc().cells.cell);
    await reopenUnfinished(f.rt);
    assert.equal(f.calls.length, 0);
    assert.equal(f.live.outside.status, 'closed');
  }
});

test('reconciler skips headings with deletes or reopens in flight', async () => {
  for (const kind of ['delete-beads', 'reopen']) {
    const f = fixture({ root: bead('root'), a: bead('a', 'root'), b: bead('b', 'a', { status: 'open' }) });
    f.doc().operations.old = { id: 'old', cellId: 'cell', kind, state: 'uncertain', intent: { beadIds: ['b'] } };
    await reopenUnfinished(f.rt);
    assert.equal(f.calls.length, 0);
  }
});

test('a partial multi-id reopen reports and settles every id', async () => {
  const f = fixture({ root: bead('root'), a: bead('a', 'root'), n: bead('n', 'a') });
  f.rt.beads.reopen = async (ids, reason, actor, check) => {
    check({ issues: Object.values(f.live).map(raw), errors: [] });
    f.live.a.status = 'open';
    throw Object.assign(new Error('native failure'), { code: 'refused' });
  };
  await assert.rejects(reopenWorkstream(f.rt, { cellId: 'cell', headId: 'n', reason: 'more', confirmAncestors: ['a'] }), (e) => e.code === 'partial' && /a was reopened/.test(e.message) && /n is still closed/.test(e.message));
  const op = Object.values(f.doc().operations)[0];
  assert.equal((await settleOne(f.rt, op.id)).settled, false);
  f.live.n.status = 'open';
  assert.equal((await settleOne(f.rt, op.id)).settled, true);
});

test('archive reply names waiting messages without acknowledging them', () => {
  const notices = [];
  archiveReply({ notice: (t) => notices.push(t) })({ ok: true, waitingMessages: 2 });
  assert.match(notices[0], /2 messages/);
  assert.match(notices[0], /does not answer or dismiss/);
});

test('backoff stops repeat failures; an uncertain reopen stays unsettled and is not replayed', async () => {
  for (const code of ['refused', 'uncertain']) {
    const id = `fail${code}`;
    const f = fixture({ root: bead('root'), [id]: bead(id, 'root'), b: bead('b', id, { status: 'open' }) });
    let calls = 0;
    f.rt.beads.reopen = async (ids, reason, actor, check) => {
      calls += 1;
      check({ issues: Object.values(f.live).map(raw), errors: [] });
      throw Object.assign(new Error(`mock ${code}`), { code });
    };
    await reopenUnfinished(f.rt);
    await reopenUnfinished(f.rt);
    assert.equal(calls, 1);
    assert.equal(Object.values(f.doc().operations)[0].state, code === 'uncertain' ? 'uncertain' : 'error');
    assert.equal(f.live[id].status, 'closed');
  }
});

test('100 returns keep every other tile and the shape', () => {
  for (let i = 0; i < 100; i += 1) {
    const beads = { root: bead('root'), a: bead('a', 'root'), n: bead('n', 'root'), b: bead('b', 'n'), x: bead('x', 'root'), y: bead('y', 'x') };
    const saved = { a: p((i % 2 ? 1 : -1) * (100 + i), i % 7), x: p(0, 0) };
    const hiddenBefore = new Set(['n', 'b']);
    const before = lay(beads, saved, hiddenBefore);
    const input = JSON.stringify(saved);
    const r = planReturn({ beads, rootId: 'root', saved, hiddenBefore, hiddenAfter: new Set(), headId: 'n', positions: { n: p(1, 0), b: p(2, 0) } });
    const after = lay(beads, r.saved);
    for (const id of ['a', 'x', 'y']) assert.deepEqual(after.positions[id], before.positions[id]);
    assert.deepEqual(offset(after, 'n', 'b'), p(1, 0));
    assert.equal(JSON.stringify(saved), input);
  }
});

test('a manual reopen whose former hexes are taken puts the group at the nearest free spot', async () => {
  const f = fixture({ root: bead('root'), a: bead('a', 'root'), n: bead('n', 'a'), b: bead('b', 'n') });
  for (const [i, pos] of ring.entries()) {
    f.live[`wall${i}`] = bead(`wall${i}`, 'root');
    f.doc().beadLayout.cell[`wall${i}`] = pos;
  }
  f.doc().archived = { a: { closedAt: '2026-11-01', ids: ['a', 'n', 'b'], positions: { a: p(0, 0), n: p(1, 0), b: p(2, 0) } }, n: { closedAt: '2026-11-01', ids: ['n', 'b'], positions: { n: p(1, 0), b: p(2, 0) } } };
  await f.refresh();
  const out = await reopenWorkstream(f.rt, { cellId: 'cell', headId: 'n', reason: 'more', confirmAncestors: ['a'] });
  assert.equal(out.placed, 'restored');
  const l = lay(f.rt.snapshots.graph.beads, f.doc().beadLayout.cell);
  for (const [i, pos] of ring.entries()) assert.deepEqual(l.positions[`wall${i}`], pos);
  assert.notDeepEqual(l.positions.a, p(0, 0));
  assert.deepEqual(offset(l, 'a', 'n'), p(1, 0));
  assert.deepEqual(offset(l, 'n', 'b'), p(1, 0));
  assert.deepEqual(f.doc().archived, {});
  assert.deepEqual(f.doc().restoring, {});
});

test('a deletion or a disable queued during the reopen refuses before the native write', async () => {
  for (const race of ['disable', 'delete']) {
    const id = `gate${race}`;
    const f = fixture({ root: bead('root'), [id]: bead(id, 'root'), b: bead('b', id, { status: 'open' }) });
    const original = f.rt.beads.reopen;
    f.rt.beads.reopen = async (...args) => {
      if (race === 'disable') f.doc().cells.cell.enabled = false;
      else f.doc().operations.race = { id: 'race', cellId: 'cell', kind: 'delete-beads', state: 'pending', intent: { beadIds: ['b'] } };
      return original(...args);
    };
    await reopenUnfinished(f.rt);
    assert.equal(f.calls.length, 0);
    assert.equal(f.live[id].status, 'closed');
    assert.equal(Object.keys(f.doc().restoring).length, 0);
  }
});

test('a durable intent survives a failed restore and recovers without replaying the reopen', async () => {
  const id = 'crash';
  const f = fixture({ root: bead('root'), [id]: bead(id, 'root'), b: bead('b', id) }, { [id]: p(10, 0), b: p(13, 0) });
  await archiveWorkstream(f.rt, { cellId: 'cell', headId: id });
  f.live.x = bead('x', 'root', { status: 'open' });
  f.live.b.status = 'open';
  await f.refresh();
  const xBefore = lay(f.rt.snapshots.graph.beads, f.doc().beadLayout.cell, hidden(f)).positions.x;
  const mutate = f.rt.metadata.mutate;
  f.rt.metadata.mutate = (fn) => mutate((d) => {
    fn(d);
    if (!d.archived[id]) throw new Error('mock restore persistence failure');
  });
  await reopenUnfinished(f.rt);
  assert.equal(f.live[id].status, 'open');
  assert(f.doc().restoring[`cell:${id}`]);
  assert(f.doc().archived[id]);
  assert.equal(f.calls.length, 1);
  f.rt.metadata.mutate = mutate;
  await f.refresh();
  await reopenUnfinished(f.rt);
  assert.equal(f.doc().restoring[`cell:${id}`], undefined);
  assert.equal(f.doc().archived[id], undefined);
  assert.equal(f.calls.length, 1);
  const l = lay(f.rt.snapshots.graph.beads, f.doc().beadLayout.cell);
  assert.equal(offset(l, id, 'b').q, 3);
  assert.deepEqual(l.positions.x, xBefore);
  assert.equal(f.doc().restoreNotices.cell.length, 1);
});

test('the search finds a free shift far beyond any fixed window', () => {
  const rows = new Set(landscapeOffsets(4096).filter((o) => o.q === 0).map((o) => o.r));
  const beads = { root: bead('root'), n: bead('n', 'root'), b: bead('b', 'n') };
  const saved = {};
  for (const r of rows) {
    const id = `x${String(r).replace('-', 'm')}`;
    beads[id] = bead(id, 'root');
    saved[id] = p(-500, r);
  }
  const r = planReturn({ beads, rootId: 'root', saved, hiddenBefore: new Set(['n', 'b']), hiddenAfter: new Set(), headId: 'n', positions: { n: p(-500, 0), b: p(500, 0) } });
  const l = lay(beads, r.saved);
  assert.equal(offset(l, 'n', 'b').q, 1000);
  for (const id of Object.keys(saved)) assert.deepEqual(l.positions[id], saved[id]);
});

test('a delayed recovery keeps unrelated work where it is drawn now', async () => {
  const id = 'late';
  const f = fixture({ root: bead('root'), parent: bead('parent', 'root', { status: 'open', closedAt: null }), [id]: bead(id, 'root'), b: bead('b', id) }, { parent: p(0, 0), [id]: p(1, 0), b: p(2, 0) });
  await archiveWorkstream(f.rt, { cellId: 'cell', headId: id });
  f.live.b.status = 'open';
  await f.refresh();
  const mutate = f.rt.metadata.mutate;
  f.rt.metadata.mutate = (fn) => mutate((d) => {
    fn(d);
    if (!d.archived[id]) throw new Error('mock restore persistence failure');
  });
  await reopenUnfinished(f.rt);
  f.rt.metadata.mutate = mutate;
  assert(f.doc().restoring[`cell:${id}`]);
  f.live.x = bead('x', 'root', { status: 'open' });
  await f.refresh();
  const before = lay(f.rt.snapshots.graph.beads, f.doc().beadLayout.cell, hidden(f));
  await reopenUnfinished(f.rt);
  assert.equal(f.doc().restoring[`cell:${id}`], undefined);
  const after = lay(f.rt.snapshots.graph.beads, f.doc().beadLayout.cell, hidden(f));
  for (const o of ['parent', 'x']) assert.deepEqual(after.positions[o], before.positions[o]);
  assert.deepEqual(offset(after, id, 'b'), p(1, 0));
});

test('recovery after a move to another hive restores there and keeps the shape', async () => {
  const f = fixture({ root: bead('root'), other: bead('other'), moved: bead('moved', 'other', { status: 'open', closedAt: null }), b: bead('b', 'moved', { status: 'open' }) });
  f.doc().cells.other = { id: 'othercell', rootBeadId: 'other', enabled: true };
  f.doc().beadLayout.othercell = {};
  f.doc().archived.moved = { closedAt: 'old', ids: ['moved', 'b'], positions: { moved: p(10, 0), b: p(13, 0) } };
  f.doc().restoring['cell:moved'] = { cellId: 'cell', headId: 'moved', ids: ['moved'], stages: ['moved'], by: 'hive', notice: { title: 'moved', triggers: ['b'] } };
  await reopenUnfinished(f.rt);
  assert.equal(f.doc().archived.moved, undefined);
  assert.equal(f.doc().restoring['cell:moved'], undefined);
  const l = lay(f.rt.snapshots.graph.beads, f.doc().beadLayout.othercell, new Set(), 'other');
  assert.deepEqual(offset(l, 'moved', 'b'), p(3, 0));
  assert.equal(f.doc().restoreNotices.othercell[0].placed, 'restored');
  assert.equal(f.doc().restoreNotices.cell, undefined);
});

test('recovery keeps the record and intent while the heading is in no live hive', async () => {
  for (const where of ['nowhere', 'disabled']) {
    const f = fixture({ root: bead('root'), other: bead('other'), moved: bead('moved', 'other', { status: 'open', closedAt: null }) });
    if (where === 'disabled') f.doc().cells.other = { id: 'othercell', rootBeadId: 'other', enabled: false };
    f.doc().archived.moved = { closedAt: 'old', ids: ['moved'], positions: { moved: p(10, 0) } };
    f.doc().restoring['cell:moved'] = { cellId: 'cell', headId: 'moved', ids: ['moved'], stages: ['moved'], by: 'hive' };
    await reopenUnfinished(f.rt);
    assert(f.doc().archived.moved);
    assert(f.doc().restoring['cell:moved']);
  }
});

test('a group whose shape spans the old map edge still finds a free spot', async () => {
  for (const action of ['show', 'reopen']) {
    const f = fixture({ root: bead('root'), n: bead('n', 'root'), b: bead('b', 'n'), x: bead('x', 'root') }, { n: p(-500, -500), b: p(500, 500), x: p(0, 0) });
    await archiveWorkstream(f.rt, { cellId: 'cell', headId: 'n' });
    const base = layoutBase({ beads: f.rt.snapshots.graph.beads, rootId: 'root', saved: f.doc().beadLayout.cell, aspect: null, hidden: [...hidden(f)] });
    moveBeads(f.rt, { cellId: 'cell', positions: { x: p(-500, -500) }, base });
    if (action === 'show') showWorkstream(f.rt, { cellId: 'cell', headId: 'n' });
    else assert.equal((await reopenWorkstream(f.rt, { cellId: 'cell', headId: 'n', reason: 'more', confirmAncestors: [] })).placed, 'restored');
    const l = lay(f.rt.snapshots.graph.beads, f.doc().beadLayout.cell, hidden(f));
    assert.deepEqual(l.positions.x, p(-500, -500));
    assert.deepEqual(offset(l, 'n', 'b'), p(1000, 1000));
    assert.equal(Math.max(Math.abs(l.positions.n.q + 500), Math.abs(l.positions.n.r + 500), Math.abs(l.positions.n.q + l.positions.n.r + 1000)), 2);
  }
});

test('moves accept positions beyond the old map edge', () => {
  const f = fixture({ root: bead('root'), x: bead('x', 'root') }, { x: p(0, 0) });
  const base = layoutBase({ beads: f.rt.snapshots.graph.beads, rootId: 'root', saved: f.doc().beadLayout.cell, aspect: null, hidden: [] });
  moveBeads(f.rt, { cellId: 'cell', positions: { x: p(2000, -3000) }, base });
  assert.deepEqual(f.doc().beadLayout.cell.x, p(2000, -3000));
});

function movedAway(enabled) {
  const f = fixture({ root: bead('root'), other: bead('other'), a: bead('a', 'root'), n: bead('n', 'a'), b: bead('b', 'n') }, { a: p(10, 0), n: p(11, 0), b: p(14, 0) });
  f.doc().cells.other = { id: 'othercell', rootBeadId: 'other', enabled };
  f.doc().beadLayout.othercell = {};
  const reopen = f.rt.beads.reopen;
  f.rt.beads.reopen = async (...args) => {
    await reopen(...args);
    f.live.n.parentId = 'other';
  };
  return f;
}

test('a reopened group whose inner workstream moved to another hive is put back in both hives', async () => {
  const f = movedAway(true);
  await archiveWorkstream(f.rt, { cellId: 'cell', headId: 'a' });
  assert.equal(f.doc().archived.n, undefined);
  const out = await reopenWorkstream(f.rt, { cellId: 'cell', headId: 'n', reason: 'more', confirmAncestors: ['a'] });
  assert.equal(out.placed, 'restored');
  assert.deepEqual(f.doc().restoring, {});
  assert.deepEqual(f.doc().archived, {});
  assert.deepEqual(lay(f.rt.snapshots.graph.beads, f.doc().beadLayout.cell).positions.a, p(10, 0));
  const l = lay(f.rt.snapshots.graph.beads, f.doc().beadLayout.othercell, new Set(), 'other');
  assert.deepEqual(l.positions.n, p(11, 0));
  assert.deepEqual(offset(l, 'n', 'b'), p(3, 0));
});

test('a split restore keeps the part it cannot place yet and places it later', async () => {
  const f = movedAway(false);
  await archiveWorkstream(f.rt, { cellId: 'cell', headId: 'a' });
  const out = await reopenWorkstream(f.rt, { cellId: 'cell', headId: 'n', reason: 'more', confirmAncestors: ['a'] });
  assert.equal(out.placed, 'pending');
  assert.deepEqual(f.doc().restoring['cell:n'].geo, { n: p(11, 0), b: p(14, 0) });
  assert.deepEqual(lay(f.rt.snapshots.graph.beads, f.doc().beadLayout.cell).positions.a, p(10, 0));
  f.doc().cells.other.enabled = true;
  await reopenUnfinished(f.rt);
  assert.deepEqual(f.doc().restoring, {});
  assert.deepEqual(f.doc().archived, {});
  const l = lay(f.rt.snapshots.graph.beads, f.doc().beadLayout.othercell, new Set(), 'other');
  assert.deepEqual(l.positions.n, p(11, 0));
  assert.deepEqual(offset(l, 'n', 'b'), p(3, 0));
});

test('a drag saved during a reopen wins over the hex the work had before it', async () => {
  const f = fixture({ root: bead('root'), n: bead('n', 'root'), x: bead('x', 'root', { status: 'open', closedAt: null }), u: bead('u', 'x', { kind: 'work', status: 'open', closedAt: null }), v: bead('v', 'x', { kind: 'work', status: 'open', closedAt: null }), y: bead('y', 'root', { status: 'open', closedAt: null }) }, { n: p(10, 0), y: p(50, 0) });
  await archiveWorkstream(f.rt, { cellId: 'cell', headId: 'n' });
  const prior = lay(f.rt.snapshots.graph.beads, f.doc().beadLayout.cell, hidden(f));
  const refresh = f.rt.snapshots.refresh;
  let target;
  f.rt.snapshots.refresh = async () => {
    await refresh();
    const beads = f.rt.snapshots.graph.beads;
    const current = lay(beads, f.doc().beadLayout.cell, hidden(f));
    const occupied = new Set(Object.values(current.positions).map((t) => `${t.q},${t.r}`));
    const freed = ['x', 'u', 'v'].find((id) => !occupied.has(`${prior.positions[id].q},${prior.positions[id].r}`));
    assert(freed);
    target = prior.positions[freed];
    const move = planMove({ layout: current, kids: activeKids(beads), rootId: 'root', saved: f.doc().beadLayout.cell, id: 'y', target });
    assert.equal(move.ok, true);
    moveBeads(f.rt, { cellId: 'cell', positions: move.positions, base: layoutBase({ beads, rootId: 'root', saved: f.doc().beadLayout.cell, aspect: null, hidden: [...hidden(f)] }) });
  };
  const out = await reopenWorkstream(f.rt, { cellId: 'cell', headId: 'n', reason: 'more', confirmAncestors: [] });
  assert.equal(out.placed, 'restored');
  const saved = f.doc().beadLayout.cell;
  assert.deepEqual(saved.y, target);
  const keys = Object.values(saved).map((t) => `${t.q},${t.r}`);
  assert.equal(new Set(keys).size, keys.length);
  const after = lay(f.rt.snapshots.graph.beads, saved);
  assert.deepEqual(after.positions.y, target);
  const drawn = Object.values(after.positions).map((t) => `${t.q},${t.r}`);
  assert.equal(new Set(drawn).size, drawn.length);
});

test('a manual reopen keeps unrelated work where it was before the reopen', async () => {
  const f = fixture({ root: bead('root'), n: bead('n', 'root'), b: bead('b', 'n') }, { n: p(10, 0), b: p(13, 0) });
  await archiveWorkstream(f.rt, { cellId: 'cell', headId: 'n' });
  f.live.x = bead('x', 'root', { status: 'open', closedAt: null });
  await f.refresh();
  const before = lay(f.rt.snapshots.graph.beads, f.doc().beadLayout.cell, hidden(f));
  await reopenWorkstream(f.rt, { cellId: 'cell', headId: 'n', reason: 'more', confirmAncestors: [] });
  const after = lay(f.rt.snapshots.graph.beads, f.doc().beadLayout.cell, hidden(f));
  assert.deepEqual(after.positions.x, before.positions.x);
  assert.deepEqual(after.positions.n, p(10, 0));
  assert.deepEqual(offset(after, 'n', 'b'), p(3, 0));
});

function counted(reads) {
  return (q, r) => ({ get q() { reads.n += 1; return q; }, get r() { reads.n += 1; return r; } });
}

function typedEntries(run) {
  const NativeI = globalThis.Int32Array;
  const NativeU = globalThis.Uint8Array;
  const total = { n: 0 };
  globalThis.Int32Array = class extends NativeI { constructor(n) { super(n); total.n += this.length; } };
  globalThis.Uint8Array = class extends NativeU { constructor(n) { super(n); total.n += this.length; } };
  try {
    return { result: run(), entries: total.n };
  } finally {
    globalThis.Int32Array = NativeI;
    globalThis.Uint8Array = NativeU;
  }
}

function benchRestore(far) {
  const beads = { root: { id: 'root' }, n: { id: 'n', parentId: 'root', kind: 'workstream' } };
  const saved = {};
  const positions = { n: p(-50, 0) };
  const hiddenBefore = new Set(['n']);
  for (let i = 1; i <= 100; i += 1) {
    const id = `member${i}`;
    beads[id] = { id, parentId: 'n', kind: 'work' };
    positions[id] = p(-50 + i, 0);
    hiddenBefore.add(id);
  }
  for (let q = -450; q <= 450; q += 100) {
    for (let r = -500; r <= 500; r += 1) {
      const id = `x${q}_${r}`;
      beads[id] = { id, parentId: 'root', kind: 'work' };
      saved[id] = p(q, r);
    }
  }
  if (far) {
    beads.far = { id: 'far', parentId: 'root', kind: 'work' };
    saved.far = far;
  }
  const args = { beads, rootId: 'root', saved, hiddenBefore, hiddenAfter: new Set(), headId: 'n', positions };
  const reads = { n: 0 };
  const cp = counted(reads);
  for (const id of Object.keys(saved)) saved[id] = cp(saved[id].q, saved[id].r);
  const { result: r, entries } = typedEntries(() => planReturn(args));
  for (const id of Object.keys(saved)) saved[id] = p(saved[id].q, saved[id].r);
  const l = layoutCell({ kids: activeKids(beads), rootId: 'root', saved: r.saved });
  for (let i = 1; i <= 100; i += 1) assert.deepEqual(offset(l, 'n', `member${i}`), p(i, 0));
  for (const id of Object.keys(saved)) assert.deepEqual(l.positions[id], saved[id]);
  return { reads: reads.n, entries };
}

test('the restore search does bounded work on a full ten-thousand-tile map and finds a spot beyond it', () => {
  const { reads, entries } = benchRestore(null);
  assert(reads <= 400000, `read ${reads} coordinates`);
  assert(entries <= 1000000, `allocated ${entries} typed-array entries`);
});

test('one far-off tile does not add work to the restore search however far it is', () => {
  const a = benchRestore(p(1000000, 1000000));
  const b = benchRestore(p(-MAX_COORD, 5));
  assert(a.reads <= 400000, `read ${a.reads} coordinates`);
  assert(a.entries <= 1000000, `allocated ${a.entries} typed-array entries`);
  assert(Math.abs(a.reads - b.reads) <= 1000, `read ${a.reads} then ${b.reads} coordinates`);
  assert.equal(a.entries, b.entries);
});

test('the nearest free spot never depends on how far apart the work is', () => {
  const shape = [p(0, 0), p(1, 0), p(2, 0)];
  const near = [p(0, 0), p(1, 0), p(5, 0), p(-3, 2)];
  assert.deepEqual(nearestFree(shape, near), nearestFree(shape, [...near, p(MAX_COORD, MAX_COORD), p(-MAX_COORD, 7)]));
});

function nearestFreeWork(far) {
  const reads = { n: 0 };
  const cp = counted(reads);
  const shape = [];
  const taken = [];
  for (let i = -256; i <= 256; i += 1) {
    shape.push(cp(i, 0));
    taken.push(cp(0, i));
  }
  taken.push(cp(far, far), cp(-far, -far));
  const { result, entries } = typedEntries(() => nearestFree(shape, taken));
  return { result, reads: reads.n, entries };
}

test('the nearest free shift does the same bounded work however far the distant tiles are', () => {
  const near = nearestFreeWork(10000);
  const limit = nearestFreeWork(MAX_COORD);
  assert.deepEqual(limit.result, near.result);
  assert.equal(limit.reads, near.reads);
  assert.equal(limit.entries, near.entries);
  assert(near.reads <= 40000, `read ${near.reads} coordinates`);
  assert(near.entries <= 2 * 1024 * 1024, `allocated ${near.entries} typed-array entries`);
});

test('positions beyond the shared coordinate limit are refused', () => {
  const f = fixture({ root: bead('root'), x: bead('x', 'root') }, { x: p(0, 0) });
  const base = layoutBase({ beads: f.rt.snapshots.graph.beads, rootId: 'root', saved: f.doc().beadLayout.cell, aspect: null, hidden: [] });
  assert.throws(() => moveBeads(f.rt, { cellId: 'cell', positions: { x: p(MAX_COORD + 1, 0) }, base }), /whole numbers/);
  assert.throws(() => moveBeads(f.rt, { cellId: 'cell', positions: { x: p(0, -Number.MAX_SAFE_INTEGER) }, base }), /whole numbers/);
  moveBeads(f.rt, { cellId: 'cell', positions: { x: p(MAX_COORD, -MAX_COORD) }, base });
  assert.deepEqual(f.doc().beadLayout.cell.x, p(MAX_COORD, -MAX_COORD));
});

test('finishing a heading already put back does not drop a part still owed to another hive', async () => {
  const f = movedAway(false);
  await archiveWorkstream(f.rt, { cellId: 'cell', headId: 'a' });
  assert.equal((await reopenWorkstream(f.rt, { cellId: 'cell', headId: 'n', reason: 'more', confirmAncestors: ['a'] })).placed, 'pending');
  f.live.a = { ...f.live.a, status: 'closed', closedAt: '2026-11-10' };
  await f.refresh();
  await reopenUnfinished(f.rt);
  assert.deepEqual(f.doc().restoring['cell:n'].geo, { n: p(11, 0), b: p(14, 0) });
  await archiveWorkstream(f.rt, { cellId: 'cell', headId: 'a' });
  f.doc().cells.other.enabled = true;
  await reopenUnfinished(f.rt);
  assert.deepEqual(f.doc().restoring, {});
  assert.equal(f.doc().archived.a.closedAt, '2026-11-10');
  assert(hidden(f).has('a'));
  const l = lay(f.rt.snapshots.graph.beads, f.doc().beadLayout.othercell, new Set(), 'other');
  assert.deepEqual(l.positions.n, p(11, 0));
  assert.deepEqual(offset(l, 'n', 'b'), p(3, 0));
});

test('a restore with no free shift left in range keeps its geometry instead of landing on other work', async () => {
  const M = MAX_COORD;
  const f = fixture({ root: bead('root'), n: bead('n', 'root'), b: bead('b', 'n'), x: bead('x', 'root') }, { n: p(-M, -M), b: p(M, M), x: p(0, 0) });
  await archiveWorkstream(f.rt, { cellId: 'cell', headId: 'n' });
  const base = layoutBase({ beads: f.rt.snapshots.graph.beads, rootId: 'root', saved: f.doc().beadLayout.cell, aspect: null, hidden: [...hidden(f)] });
  moveBeads(f.rt, { cellId: 'cell', positions: { x: p(-M, -M) }, base });
  assert.throws(() => showWorkstream(f.rt, { cellId: 'cell', headId: 'n' }), /no free spot/);
  const out = await reopenWorkstream(f.rt, { cellId: 'cell', headId: 'n', reason: 'more', confirmAncestors: [] });
  assert.equal(out.placed, 'pending');
  assert.deepEqual(f.doc().restoring['cell:n'].geo, { n: p(-M, -M), b: p(M, M) });
  assert.deepEqual(f.doc().beadLayout.cell.x, p(-M, -M));
  assert.notDeepEqual(f.doc().beadLayout.cell.n, p(-M, -M));
});

function allocations(run) {
  const NativeI = globalThis.Int32Array;
  const NativeU = globalThis.Uint8Array;
  let largest = 0;
  globalThis.Int32Array = class extends NativeI { constructor(n) { super(n); largest = Math.max(largest, this.byteLength); } };
  globalThis.Uint8Array = class extends NativeU { constructor(n) { super(n); largest = Math.max(largest, this.byteLength); } };
  try {
    const result = run();
    return { result, largest };
  } finally {
    globalThis.Int32Array = NativeI;
    globalThis.Uint8Array = NativeU;
  }
}

test('a search whose only shift in range is taken ends at once', () => {
  const M = MAX_COORD;
  const { result, largest } = allocations(() => nearestFree([p(-M, -M), p(M, M)], [p(-M, -M)]));
  assert.equal(result, null);
  assert(largest <= 64, `allocated ${largest} bytes`);
});

test('a search past its window ceiling stays small and still finds a free spot', () => {
  const shape = [];
  const taken = [];
  for (let i = -1024; i <= 1024; i += 1) {
    shape.push(p(i, 0));
    taken.push(p(0, i));
  }
  const { result, largest } = allocations(() => nearestFree(shape, taken));
  assert(result);
  const busy = new Set(taken.map((t) => `${t.q},${t.r}`));
  assert(shape.every((s) => !busy.has(`${s.q + result.q},${s.r + result.r}`)));
  assert(largest <= 2 * 1024 * 1024, `allocated ${largest} bytes`);
});

for (const [name, far] of [['two distant tiles', 10000], ['tiles at the coordinate limit', MAX_COORD]]) {
  test(`past the window ceiling the nearest free shift still wins over ${name}`, () => {
    const shape = [];
    const taken = [];
    for (let i = -256; i <= 256; i += 1) {
      shape.push(p(i, 0));
      taken.push(p(0, i));
    }
    taken.push(p(far, far), p(-far, -far));
    const at = nearestFree(shape, taken);
    assert.equal(Math.max(Math.abs(at.q), Math.abs(at.r), Math.abs(at.q + at.r)), 257);
    const busy = new Set(taken.map((t) => `${t.q},${t.r}`));
    assert.ok(shape.every((s) => !busy.has(`${s.q + at.q},${s.r + at.r}`)));
  });
}

async function closeSourceThenEnable(f) {
  f.live.a.status = 'closed';
  f.live.a.closedAt = '2026-11-10';
  await f.refresh();
  await reopenUnfinished(f.rt);
  assert.ok(f.doc().restoring['cell:n']);
  f.doc().cells.other.enabled = true;
  await reopenUnfinished(f.rt);
  assert.equal(f.doc().restoring['cell:n'], undefined);
  const placed = f.doc().beadLayout.othercell;
  assert.deepEqual(p(placed.b.q - placed.n.q, placed.b.r - placed.n.r), p(3, 0));
}

test('a reopen whose receipt fails to save keeps the geometry it owes once settled as applied', async () => {
  const f = movedAway(false);
  await archiveWorkstream(f.rt, { cellId: 'cell', headId: 'a' });
  const mutate = f.rt.metadata.mutate;
  f.rt.metadata.mutate = (fn) => mutate((d) => {
    const out = fn(d);
    if (Object.values(d.operations).some((op) => op.state === 'applied')) throw new Error('crash between saves');
    return out;
  });
  await assert.rejects(reopenWorkstream(f.rt, { cellId: 'cell', headId: 'n', reason: 'more', confirmAncestors: ['a'] }), (e) => e.code === 'partial');
  f.rt.metadata.mutate = mutate;
  const op = Object.values(f.doc().operations)[0];
  assert.equal(op.state, 'pending');
  assert.ok(!f.doc().restoring['cell:n'].opened);
  f.doc().operations[op.id] = { ...op, state: 'resolved', verdict: 'applied' };
  assert.equal(f.calls.length, 1);
  await closeSourceThenEnable(f);
  assert.equal(f.calls.length, 1);
});

test('an applied reopen receipt counts as opened even without the marker', async () => {
  const f = movedAway(false);
  await archiveWorkstream(f.rt, { cellId: 'cell', headId: 'a' });
  const out = await reopenWorkstream(f.rt, { cellId: 'cell', headId: 'n', reason: 'more', confirmAncestors: ['a'] });
  assert.equal(out.placed, 'pending');
  assert.ok(f.doc().restoring['cell:n'].opened);
  assert.equal(Object.values(f.doc().operations)[0].state, 'applied');
  const { opened, ...rest } = f.doc().restoring['cell:n'];
  f.doc().restoring['cell:n'] = rest;
  await closeSourceThenEnable(f);
});

for (const outcome of ['done', 'dropped', 'superseded', 'duplicate', null]) {
  test(`peer regions keep their gaps through migration, archive, show, hide and reopen (${outcome})`, async () => {
    const { migrateRegions } = await import('../server/region-migration.js');
    const { groupOutlines } = await import('../public/cell-layout.js');
    const positions = { a: p(0, 0), own: p(1, 0), n: p(40, 0), b: p(41, 0), deep: p(90, 0), c: p(91, 0) };
    const graph = {
      root: bead('root'), a: bead('a', 'root', { outcome }), own: bead('own', 'a', { kind: 'work', outcome }),
      n: bead('n', 'a', { outcome }), b: bead('b', 'n', { kind: 'work', outcome }),
      deep: bead('deep', 'n', { outcome }), c: bead('c', 'deep', { kind: 'work', outcome }),
      outsider: bead('outsider', 'root', { kind: 'work', status: 'open', closedAt: null }),
    };
    const f = fixture(graph, { ...positions, outsider: p(120, 0) });
    migrateRegions(f.rt.metadata, f.rt.snapshots.graph.beads);
    assert.deepEqual(f.doc().beadLayout.cell, { ...positions, outsider: p(120, 0) });
    await archiveWorkstream(f.rt, { cellId: 'cell', headId: 'a' });
    assert.equal(hidden(f).size, 6);
    f.doc().beadLayout.cell.outsider = p(40, 0);
    await showWorkstream(f.rt, { cellId: 'cell', headId: 'a' });
    const shown = lay(f.rt.snapshots.graph.beads, f.doc().beadLayout.cell);
    assert.equal(groupOutlines(shown, 60).length, 3);
    assert.deepEqual(shown.positions.outsider, p(40, 0));
    for (const id of Object.keys(positions)) assert.deepEqual(offset(shown, 'a', id), positions[id]);
    await archiveWorkstream(f.rt, { cellId: 'cell', headId: 'a' });
    await reopenWorkstream(f.rt, { cellId: 'cell', headId: 'n', reason: 'more', confirmAncestors: ['a'] });
    const reopened = lay(f.rt.snapshots.graph.beads, f.doc().beadLayout.cell);
    assert.deepEqual(reopened.positions, shown.positions);
    assert.equal(f.live.deep.status, 'closed');
    assert.equal(f.live.c.status, 'closed');
    assert.equal(f.live.b.status, 'closed');
    assert.deepEqual(f.calls[0].ids, ['a', 'n']);
  });
}

test('peer region boundaries do not let completion skip unfinished descendants', async () => {
  const { checkWorkstream } = await import('../server/workstreams.js');
  const f = fixture({ root: bead('root'), a: bead('a', 'root', { status: 'open' }), n: bead('n', 'a'), b: bead('b', 'n', { kind: 'work', status: 'open' }) });
  const out = checkWorkstream(f.rt, { cellId: 'cell', headId: 'a' });
  assert.equal(out.itemCount, 2);
  assert.ok(out.problems.some((s) => s.includes('b') && s.includes('not finished')));
});
