import test from 'node:test';
import assert from 'node:assert/strict';
import { pickupFixture } from './helpers/pickup.mjs';
import { createBeads, updateBead } from '../server/ops.js';
import { clusterAt, clusterCandidates, orphanIds } from '../server/clusters.js';

const node = (id, parentId, extra = {}) => ({ id, parentId, kind: 'work', status: 'open', title: id, ...extra });

test('orphans are non-cluster cells with no cluster below the goal, open or closed', () => {
  const beads = {
    root: node('root', null, { kind: 'goal' }),
    ws: node('ws', 'root', { kind: 'workstream' }),
    inside: node('inside', 'ws'),
    deep: node('deep', 'inside', { kind: 'decision' }),
    loose: node('loose', 'root'),
    under: node('under', 'loose', { kind: 'external' }),
    done: node('done', 'root', { status: 'closed' }),
    top: node('top', 'root', { kind: 'workstream' }),
  };
  assert.deepEqual(orphanIds(beads, 'root'), ['done', 'loose', 'under']);
  assert.equal(clusterAt(beads, 'root', 'deep'), 'ws');
  assert.equal(clusterAt(beads, 'root', 'root'), null);
});

test('candidates list open clusters before closed ones, newest first, with archive state and path', () => {
  const beads = {
    root: node('root', null, { kind: 'goal' }),
    old: node('old', 'root', { kind: 'workstream', updatedAt: '2026-01-01' }),
    fresh: node('fresh', 'root', { kind: 'workstream', updatedAt: '2026-06-01', title: 'Fresh' }),
    nested: node('nested', 'fresh', { kind: 'workstream', updatedAt: '2026-03-01' }),
    shut: node('shut', 'root', { kind: 'workstream', status: 'closed', updatedAt: '2026-12-01' }),
    work: node('work', 'old'),
  };
  const { shown, more } = clusterCandidates(beads, 'root', new Set(['shut']), 3);
  assert.deepEqual(shown.map(c => c.bead_id), ['fresh', 'nested', 'old']);
  assert.deepEqual(shown[1].path, ['Fresh']);
  assert.equal(more, 1);
  const all = clusterCandidates(beads, 'root', new Set(['shut'])).shown;
  assert.deepEqual(all.at(-1), { bead_id: 'shut', title: 'shut', status: 'closed', archived: true, path: [] });
});

function fixture() {
  const f = pickupFixture();
  under(f, 'ws', 'shut', 'root', { title: 'Shipped', status: 'closed' });
  under(f, 'a', 'loose', 'root');
  f.created = [];
  f.rt.beads.createMany = async ({ nodes }) => { f.created.push(...nodes); return { ids: Object.fromEntries(nodes.map(n => [n.key, `new-${n.key}`])) }; };
  return f;
}

const refresh = f => f.rt.snapshots.refresh();
const under = (f, from, id, parent, extra = {}) => (f.live[id] = { ...structuredClone(f.live[from]), id, title: id, dependencies: [{ issue_id: id, depends_on_id: parent, type: 'parent-child' }], ...extra });

test('creating a cell outside every cluster is refused with open and closed candidates', async () => {
  const f = fixture(); await refresh(f);
  for (const kind of ['work', 'decision', 'external', 'investigation', 'idea']) {
    await assert.rejects(createBeads(f.rt, f.actor(), { beads: [{ title: 'Stray', kind }] }), err => {
      assert.equal(err.code, 'refused');
      assert.match(err.message, /must sit inside a cluster/);
      assert.match(err.message, /- ws "ws" \(open\)/);
      assert.match(err.message, /- shut "Shipped" \(closed\)/);
      assert.match(err.message, /ref: "c", kind: "workstream"/);
      return true;
    });
    await assert.rejects(createBeads(f.rt, f.actor(), { beads: [{ title: 'Stray', kind, parent: 'loose' }] }), /must sit inside a cluster/);
  }
  assert.equal(f.created.length, 0);
});

test('a hive with no clusters says so and a new cluster with its work in one batch succeeds', async () => {
  const f = fixture();
  delete f.live.shut;
  f.live.ws.metadata.hive_kind = 'work'; f.live.ws.issue_type = 'task';
  await refresh(f);
  await assert.rejects(createBeads(f.rt, f.actor(), { beads: [{ title: 'Stray' }] }), /This hive has no clusters yet/);
  await createBeads(f.rt, f.actor(), { beads: [
    { ref: 'c', kind: 'workstream', title: 'Group' },
    { ref: 'mid', title: 'Step', parent: 'c' },
    { title: 'Sub-step', kind: 'decision', parent: 'mid' },
  ] });
  assert.deepEqual(f.created.map(n => [n.key, n.parentId ?? n.parentKey]), [['c', 'root'], ['mid', 'c'], ['n2', 'mid']]);
});

test('the queen may file under a closed cluster; a worker may not', async () => {
  const f = fixture(); await refresh(f);
  await createBeads(f.rt, f.actor(), { beads: [{ title: 'Follow-up', parent: 'shut' }] });
  assert.equal(f.created.at(-1).parentId, 'shut');
  f.live.a.assignee = 'aw:worker'; await refresh(f);
  await assert.rejects(createBeads(f.rt, f.actor('worker', 'worker'), { beads: [{ title: 'Follow-up', parent: 'shut' }] }), err => err.code === 'access' && /closed cluster shut "Shipped"/.test(err.message));
});

test('a worker follow-up without a parent goes in the cluster around its own cell', async () => {
  const f = fixture();
  under(f, 'a', 'inner', 'a', { assignee: 'aw:worker' });
  await refresh(f);
  await createBeads(f.rt, f.actor('worker', 'worker'), { beads: [{ title: 'Follow-up', kind: 'decision' }, { ref: 'g', kind: 'workstream', title: 'New group' }] });
  assert.equal(f.created[0].parentId, 'ws');
  assert.equal(f.created[1].parentId, 'root');
});

test('a worker with no clustered cell, or cells in several clusters, must name the parent', async () => {
  const f = fixture(); await refresh(f);
  await assert.rejects(createBeads(f.rt, f.actor('worker', 'worker'), { beads: [{ title: 'Follow-up' }] }), /ask the queen which cluster/);
  f.live.loose.assignee = 'aw:worker'; await refresh(f);
  await assert.rejects(createBeads(f.rt, f.actor('worker', 'worker'), { beads: [{ title: 'Follow-up' }] }), /must sit inside a cluster/);
  under(f, 'ws', 'other', 'root');
  under(f, 'a', 'c', 'other', { assignee: 'aw:worker' });
  f.live.a.assignee = 'aw:worker'; await refresh(f);
  await assert.rejects(createBeads(f.rt, f.actor('worker', 'worker'), { beads: [{ title: 'Follow-up' }] }), /must sit inside a cluster/);
  await createBeads(f.rt, f.actor('worker', 'worker'), { beads: [{ title: 'Follow-up', parent: 'other' }] });
  assert.equal(f.created.at(-1).parentId, 'other');
  f.live.c.status = 'closed'; f.live.loose.assignee = null; await refresh(f);
  f.rt.metadata.mutate(d => { d.bindings.cell = [{ active: true, sessionId: 'worker', beadId: 'other', role: 'coordinator' }]; });
  await assert.rejects(createBeads(f.rt, f.actor('worker', 'worker'), { beads: [{ title: 'Follow-up' }] }), /must sit inside a cluster/);
  f.live.a.assignee = null; await refresh(f);
  await createBeads(f.rt, f.actor('worker', 'coordinator'), { beads: [{ title: 'Follow-up' }] });
  assert.equal(f.created.at(-1).parentId, 'other');
});

test('moving a cell out of every cluster is refused; clusters may move under the goal', async () => {
  const f = fixture(); await refresh(f);
  await assert.rejects(updateBead(f.rt, f.actor(), { bead_id: 'a', parent_id: '' }), /Cell a "a" must sit inside a cluster/);
  await assert.rejects(updateBead(f.rt, f.actor(), { bead_id: 'a', parent_id: 'loose' }), /must sit inside a cluster/);
  await updateBead(f.rt, f.actor(), { bead_id: 'a', parent_id: 'shut' });
  under(f, 'ws', 'nested', 'ws');
  await refresh(f);
  await updateBead(f.rt, f.actor(), { bead_id: 'nested', parent_id: '' });
});

test('turning a cluster into ordinary work needs a cluster around it', async () => {
  const f = fixture();
  under(f, 'ws', 'nested', 'ws');
  await refresh(f);
  await assert.rejects(updateBead(f.rt, f.actor(), { bead_id: 'ws', kind: 'work' }), /Cell ws "ws" must sit inside a cluster/);
  await updateBead(f.rt, f.actor(), { bead_id: 'nested', kind: 'work' });
  await assert.rejects(updateBead(f.rt, f.actor(), { bead_id: 'loose', kind: 'decision' }), /must sit inside a cluster/);
  await updateBead(f.rt, f.actor(), { bead_id: 'loose', kind: 'decision', parent_id: 'ws' });
  await updateBead(f.rt, f.actor(), { bead_id: 'a', title: 'Renamed' });
  await updateBead(f.rt, f.actor(), { bead_id: 'loose', title: 'Still loose' }).catch(() => assert.fail('unrelated edits of an existing orphan stay allowed'));
});

test('the write fence rechecks the cluster against the store', async () => {
  const f = fixture(); await refresh(f);
  f.live.ws.metadata.hive_kind = 'work';
  await assert.rejects(updateBead(f.rt, f.actor(), { bead_id: 'loose', parent_id: 'ws' }), /must sit inside a cluster/);
});

test('a worker cannot move open work under a closed cluster; closed work may go there', async () => {
  const f = fixture();
  f.live.loose.assignee = 'aw:worker'; await refresh(f);
  await assert.rejects(updateBead(f.rt, f.actor('worker', 'worker'), { bead_id: 'loose', parent_id: 'shut' }), /Only the queen or human/);
  f.live.loose.status = 'closed'; await refresh(f);
  await updateBead(f.rt, f.actor('worker', 'worker'), { bead_id: 'loose', parent_id: 'shut' });
});
