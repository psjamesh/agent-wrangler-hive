import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture } from './ownership.test.mjs';
import { createManifest } from '../server/manifest.js';
import { capacity } from '../server/admission.js';
import { attachmentsFor } from '../server/bead-sessions.js';

async function setup(limit = 3) {
  const f = fixture(limit);
  f.live.a.assignee = 'aw:parent';
  f.live.a.status = 'in_progress';
  f.board.set('parent', { sessionId: 'parent', taskId: 'task', status: 'working' });
  f.rt.metadata.mutate(d => { d.bindings.cell = [{ sessionId: 'parent', beadId: 'a', role: 'worker', active: true }]; });
  await f.rt.snapshots.refresh();
  const briefs = [];
  f.host.deliver = async (sid, body) => { briefs.push({ sid, body }); return { mode: 'live' }; };
  const manifest = createManifest({ dir: '.' });
  const args = { spawnedBy: 'parent', parentSession: null, source: 'agent', agent: 'codex', taskId: 'task', host: f.host };
  return { ...f, briefs, manifest, args, before: input => manifest.hooks['session.beforeSpawn']({ ...args, ...input }), spawned: input => manifest.hooks['session.spawned']({ ...args, ...input }) };
}

test('ordinary spawns and forks from every provider attach a charged helper and send Hive rules', async () => {
  for (const agent of ['claude', 'codex', 'gemini']) for (const source of ['agent', 'workflow', 'schedule', 'fork']) {
    const f = await setup();
    const input = { agent, source, ...(source === 'fork' ? { spawnedBy: null, parentSession: 'parent' } : {}) };
    const admission = await f.before(input);
    assert.ok(admission.data);
    f.board.set('child', { sessionId: 'child', taskId: 'elsewhere', status: 'working' });
    await f.spawned({ ...input, sessionId: 'child', data: admission.data });
    assert.equal(f.live.a.assignee, 'aw:parent');
    assert.equal(attachmentsFor(f.rt, f.host, 'a').find(a => a.session_id === 'child').role, 'helper');
    assert.equal(capacity(f.rt).used, 2);
    assert.match(f.briefs[0].body, /hive_context.*a/s);
    assert.match(f.briefs[0].body, /hive_request_input/);
    assert.match(f.briefs[0].body, /hive-worker/);
    f.board.get('child').archived = true;
    assert.equal(capacity(f.rt).used, 1);
  }
});

test('full capacity refuses before a launch and simultaneous admissions reserve separate slots', async () => {
  const f = await setup(2);
  const [one, two] = await Promise.all([f.before(), f.before()]);
  assert.ok(one.data);
  assert.match(two.refuse, /Hive.*(capacity|limit).*2/i);
  assert.equal(capacity(f.rt).used, 2);
  assert.equal(f.briefs.length, 0);
});

test('unrelated parents and Hive extension launches are left to their existing admission path', async () => {
  const f = await setup(1);
  assert.equal(await f.before({ spawnedBy: 'outsider', parentSession: 'parent' }), undefined);
  assert.equal(await f.before({ spawnedBy: null, spawner: 'hive', source: 'extension', parentSession: 'parent' }), undefined);
  assert.equal(await f.before({ spawnedBy: null, source: 'board', parentSession: 'parent' }), undefined);
  assert.equal(capacity(f.rt).used, 1);
});

test('a host without spawn hooks keeps the existing launch context and preparation behaviour', async () => {
  const f = await setup();
  await f.manifest.hooks['session.prepare']({ sessionId: 'legacy', taskId: 'task', spawnedBy: 'parent', host: f.host });
  assert.ok(f.rt.pendingParticipants.get('legacy'));
  assert.equal(await f.manifest.hooks['session.launchContext']({ sid: 'legacy', task: { id: 'task' }, reason: 'spawn', host: f.host }), undefined);
  assert.equal(capacity(f.rt).used, 1);
});

test('aborted launch admissions expire because core has no failed-launch notification', async () => {
  const f = await setup(2);
  const { data } = await f.before();
  f.rt.spawnAdmissions.get(data.id).at -= 10 * 60 * 1000;
  assert.equal(capacity(f.rt).used, 1);
  assert.ok((await f.before()).data);
});

test('unlimited capacity, missing bindings and ambiguous parent beads are handled explicitly', async () => {
  const f = await setup(0);
  f.rt.metadata.mutate(d => { d.bindings = {}; });
  assert.equal((await f.before()).data.beadId, 'a', 'the parent claim identifies its bead');
  f.live.b.assignee = 'aw:parent';
  f.live.b.status = 'in_progress';
  await f.rt.snapshots.refresh();
  assert.match((await f.before()).refuse, /one parent bead/);
});

test('duplicate completion callbacks neither charge nor brief a helper twice', async () => {
  const f = await setup();
  const { data } = await f.before();
  f.board.set('child', { sessionId: 'child', status: 'idle', dormant: true });
  await f.spawned({ sessionId: 'child', data });
  await f.spawned({ sessionId: 'child', data });
  assert.equal(capacity(f.rt).used, 2);
  assert.equal(f.briefs.length, 1);
  f.rt.metadata.mutate(d => { d.bindings.cell.find(b => b.sessionId === 'child').active = false; });
  assert.equal(capacity(f.rt).used, 1);
});

test('a slow successful launch is enrolled even after its transient capacity reservation expires', async () => {
  const f = await setup();
  const { data } = await f.before();
  f.rt.spawnAdmissions.get(data.id).at -= 10 * 60 * 1000;
  assert.equal(capacity(f.rt).used, 1);
  f.board.set('slow', { sessionId: 'slow', status: 'working' });
  await f.spawned({ sessionId: 'slow', data });
  assert.equal(attachmentsFor(f.rt, f.host, 'a').find(a => a.session_id === 'slow')?.role, 'helper');
  assert.equal(capacity(f.rt).used, 2);
});
