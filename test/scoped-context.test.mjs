import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { launchQueen, onBeforeDispatch } from '../server/sessions.js';
import { buildContext, contextTool, hiveTool, workTools } from '../server/tools.js';
import { buildGraph } from '../server/bead-model.js';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-scoped-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const raw = (id, parent, extra = {}) => ({ id, title: id, status: 'open', dependencies: parent ? [{ issue_id: id, depends_on_id: parent, type: 'parent-child' }] : [], ...extra });
  const issues = [raw('root'), raw('parent', 'root'), raw('work', 'parent', { assignee: 'aw:worker', status: 'in_progress' }), raw('linked', 'root'), raw('unrelated', 'root')];
  const cell = { id: 'cell', taskId: 'task', rootBeadId: 'root', enabled: true, queenSessionId: 'queen' };
  const doc = { cells: { cell }, bindings: { cell: [{ active: true, sessionId: 'worker', beadId: 'work', role: 'worker' }, { active: true, sessionId: 'reviewer', beadId: 'work', role: 'reviewer' }] }, operations: {}, workerLaunches: {}, reviews: {}, requests: {}, conversation: { cell: [] }, threads: { cell: {} }, inbox: {} };
  const board = ['queen', 'worker', 'reviewer', 'peer'].map(sessionId => ({ sessionId, taskId: 'task', status: 'working' }));
  const rt = { paths: { root: dir }, metadata: { read: () => doc, cell: () => cell, cells: () => [cell], cellForTask: () => cell }, snapshots: { graph: buildGraph(issues), refresh: async () => {}, current: { loadedAt: 1, error: null } }, beads: { status: { state: 'ready' } }, pendingParticipants: new Map(), log() {} };
  const host = { stores: { hive: rt }, tasks: { get: () => ({ name: 'Fixture' }), forSession: () => ({ taskId: 'task' }) }, sessions: { get: id => board.find(s => s.sessionId === id), forTask: () => board } };
  rt.host = host;
  rt.snapshots.graph.edges.push({ dependent: 'work', prerequisite: 'linked', type: 'related', blocking: false });
  let n = 0;
  function topic(beadId, text, request = null) {
    const threadId = `thr_${(++n).toString(16).padStart(12, '0')}`;
    const id = `msg_${n}`;
    doc.threads.cell[threadId] = { id: threadId, beadId, title: text, count: 1, lastAt: n, createdAt: n, ...(request ? { origin: 'request' } : {}) };
    doc.conversation.cell.push({ id, threadId, beadId, author: 'session', sessionId: request?.requesterSessionId || 'queen', role: 'worker', text, at: n, ...(request ? { requestId: request.id } : {}) });
    if (request) doc.requests[request.id] = { cellId: 'cell', beadId, threadId, messageId: id, title: text, state: 'open', audience: 'queen', ...request };
    return threadId;
  }
  const actor = (sessionId = 'worker') => ({ sessionId, cell, role: sessionId === 'queen' ? 'queen' : sessionId === 'reviewer' ? 'reviewer' : 'worker' });
  return { rt, host, doc, topic, actor };
}
const scoped = (f, args = {}, sessionId) => buildContext(f.rt, f.host, f.actor(sessionId), { scope: 'bead', ...args });

test('bead scope keeps focus, parent chain, direct links and only own topics, requests and reviews', async t => {
  const f = fixture(t);
  f.topic('work', 'Work discussion');
  f.rt.snapshots.graph.beads.parent.summary = 'UNRELATED parent details';
  f.rt.snapshots.graph.beads.linked.summary = 'UNRELATED linked details';
  f.rt.snapshots.graph.edges.push({ dependent: 'linked', prerequisite: 'unrelated', type: 'related', blocking: false });
  f.topic('parent', 'UNRELATED parent conversation');
  f.topic('linked', 'UNRELATED linked conversation');
  f.topic('unrelated', 'UNRELATED discussion');
  f.topic('work', 'Own question', { id: 'own', requesterSessionId: 'worker' });
  f.topic('unrelated', 'UNRELATED own question', { id: 'elsewhere', requesterSessionId: 'worker' });
  f.doc.reviews.good = { workBeadId: 'work', state: 'approved', summary: 'Work review' };
  f.doc.reviews.bad = { workBeadId: 'unrelated', state: 'approved', summary: 'UNRELATED review' };
  const out = await scoped(f);
  assert.equal(out.focus.bead_id, 'work');
  assert.equal(out.focus.review.summary, 'Work review');
  assert.deepEqual(out.parents.map(b => b.bead_id), ['parent', 'root']);
  assert.deepEqual(out.linked_beads.map(b => b.bead_id), ['linked']);
  assert.equal(out.links.length, 1);
  assert.deepEqual(out.threads.map(t => t.bead_id), ['work', 'work']);
  assert.deepEqual(out.my_requests.map(r => r.id), ['own']);
  assert.deepEqual(out.you.claims, ['work']);
  assert.deepEqual(out.you.bindings, [{ bead_id: 'work', role: 'worker' }]);
  assert.doesNotMatch(JSON.stringify(out), /UNRELATED|unrelated/);
  assert.equal(out.sessions, undefined);
  assert.equal(out.attention, undefined);
  assert.equal((await scoped(f, { include_closed: true })).closed_beads, undefined);
  const full = await buildContext(f.rt, f.host, f.actor());
  assert.ok(full.beads.some(b => b.bead_id === 'unrelated'));
  assert.match(JSON.stringify(full), /UNRELATED/);
});

test('scope infers reviewer bindings, rejects ambiguous or missing focus and rejects other cells', async t => {
  const f = fixture(t);
  assert.equal((await scoped(f, {}, 'reviewer')).focus.bead_id, 'work');
  await assert.rejects(scoped(f, {}, 'peer'), /needs bead_id/);
  f.doc.bindings.cell.push({ active: true, sessionId: 'worker', beadId: 'linked', role: 'investigator' });
  await assert.rejects(scoped(f), /needs bead_id/);
  assert.equal((await scoped(f, { bead_id: 'work' })).focus.bead_id, 'work');
  await assert.rejects(scoped(f, { bead_id: 'missing' }), /Unknown cell/);
  f.rt.snapshots.graph.beads.outside = { id: 'outside', parentId: null };
  await assert.rejects(scoped(f, { bead_id: 'outside' }), /Unknown cell/);
  f.rt.snapshots.graph.beads.work.status = 'closed';
  assert.equal((await scoped(f, { bead_id: 'work' })).focus.status, 'closed');
});

test('scoping preserves private request visibility for owner, peer, reviewer and queen', async t => {
  const f = fixture(t);
  f.topic('work', 'Private owner', { id: 'own', requesterSessionId: 'worker' });
  f.topic('work', 'Private peer', { id: 'peer', requesterSessionId: 'peer' });
  f.topic('work', 'Shared public');
  f.doc.conversation.cell.push({ id: 'reply', threadId: f.doc.requests.own.threadId, author: 'session', sessionId: 'queen', role: 'queen', replyTo: 'msg_1', text: 'Private owner discussion', at: 4 });
  for (const who of ['worker', 'peer', 'reviewer', 'queen']) {
    const full = await buildContext(f.rt, f.host, f.actor(who));
    const out = await scoped(f, { bead_id: 'work' }, who);
    assert.deepEqual(out.conversation, full.conversation);
    assert.deepEqual(out.threads, full.threads);
    assert.deepEqual(out.my_requests, full.my_requests);
    if (who !== 'queen') assert.equal(out.input_requests, undefined);
    else assert.equal(out.input_requests.length, 2);
  }
  const peer = await scoped(f, { bead_id: 'work' }, 'peer');
  assert.doesNotMatch(JSON.stringify(peer), /Private owner/);
  const reviewer = await scoped(f, {}, 'reviewer');
  assert.doesNotMatch(JSON.stringify(reviewer), /Private owner|Private peer/);
  f.doc.requests.own.audience = 'human';
  f.doc.requests.own.title = 'Forwarded canonical title';
  f.doc.requests.own.contentRevision = 2;
  const forwarded = await scoped(f, {}, 'reviewer');
  const fullForwarded = await buildContext(f.rt, f.host, f.actor('reviewer'));
  assert.deepEqual(forwarded.conversation, fullForwarded.conversation);
  assert.match(JSON.stringify(forwarded), /Forwarded canonical title|Private owner discussion/);
  assert.doesNotMatch(JSON.stringify(forwarded.threads), /Private owner/);
  assert.doesNotMatch(JSON.stringify(forwarded), /Private peer/);
});

test('bead guidance in hive-wide topics is retained without unrelated messages or private references', async t => {
  const f = fixture(t);
  const expected = [];
  for (const reference of [{ beadId: 'work' }, { context: { beadId: 'work' } }, { relatedBeadIds: ['work'] }]) {
    const threadId = f.topic(null, 'UNRELATED earlier message');
    const message = { id: `guidance-${expected.length}`, threadId, author: 'session', sessionId: 'queen', role: 'queen', text: 'Queen guidance for work', at: 20 + expected.length, ...reference };
    f.doc.conversation.cell.push(message);
    expected.push(message.id);
  }
  const hiddenTopic = f.topic(null, 'PRIVATE peer request', { id: 'hidden', requesterSessionId: 'peer' });
  f.doc.conversation.cell.push({ id: 'hidden-guidance', threadId: hiddenTopic, author: 'session', sessionId: 'queen', role: 'queen', relatedBeadIds: ['work'], replyTo: f.doc.conversation.cell.at(-1).id, text: 'PRIVATE reference', at: 30 });
  const full = await buildContext(f.rt, f.host, f.actor());
  const out = await scoped(f);
  assert.deepEqual(out.conversation.map(m => m.message_id), expected);
  assert.equal(out.threads.length, expected.length);
  for (const message of out.conversation) {
    assert.deepEqual(message, full.conversation.find(m => m.message_id === message.message_id));
    assert.ok(out.threads.some(t => t.thread_id === message.thread_id));
  }
  assert.doesNotMatch(JSON.stringify(out.conversation), /UNRELATED|PRIVATE/);
  assert.doesNotMatch(JSON.stringify(out), /PRIVATE/);
});

test('large-cell comparison counts returned items deterministically and scopes before recent limits', async t => {
  const f = fixture(t);
  f.topic('work', 'Retained own topic');
  const baseline = await scoped(f);
  for (let i = 0; i < 500; i++) {
    const id = `noise-${i}`;
    f.rt.snapshots.graph.beads[id] = { ...f.rt.snapshots.graph.beads.unrelated, id, title: id };
    f.topic(id, 'UNRELATED large cell');
    f.doc.requests[id] = { id, cellId: 'cell', beadId: id, messageId: `request-message-${i}`, requesterSessionId: 'worker', title: 'UNRELATED request', state: 'open', audience: 'queen' };
  }
  const full = await buildContext(f.rt, f.host, f.actor());
  const out = await scoped(f);
  const count = obj => Object.values(obj).reduce((n, value) => n + (Array.isArray(value) ? value.length : value && typeof value === 'object' ? count(value) : 0), 0);
  assert.equal(full.beads.length, 505);
  assert.equal(full.conversation.length, 20);
  assert.equal(out.conversation.length, 1);
  assert.equal(out.threads.length, 1);
  assert.deepEqual(out.my_requests, []);
  assert.doesNotMatch(JSON.stringify(out), /UNRELATED|noise-/);
  assert.equal(count(out), count(baseline));
  assert.ok(count(full) > count(out) * 20);
  t.diagnostic(`Synthetic returned array items: full=${count(full)}, scoped=${count(out)}`);
});

test('cross-cell links include endpoints without exposing the other cell bead contents', async t => {
  const f = fixture(t);
  f.rt.snapshots.graph.beads.outside = { id: 'outside', title: 'UNRELATED external title', parentId: null };
  f.rt.snapshots.graph.edges.push({ dependent: 'work', prerequisite: 'outside', type: 'blocks', blocking: true });
  const out = await scoped(f);
  assert.ok(out.links.some(e => e.prerequisite === 'outside'));
  assert.ok(!out.linked_beads.some(b => b.bead_id === 'outside'));
  assert.doesNotMatch(JSON.stringify(out), /UNRELATED/);
});

test('context tool publishes scope in its schema and validates values', () => {
  const schema = contextTool.inputSchema._zod.toJSONSchema();
  assert.deepEqual(schema.properties.scope.enum, ['cell', 'bead']);
  assert.equal(contextTool.inputSchema.safeParse({ scope: 'invalid' }).success, false);
});

test('current queen launch retains explicit no-handover decision beyond bounded history', async t => {
  const f = fixture(t);
  f.doc.launches = {
    previous: { id: 'previous', cellId: 'cell', sessionId: 'old', handoverSourceSessionId: 'source', archiveSourceAfterHandover: true },
    current: { id: 'current', cellId: 'cell', sessionId: 'queen', handoverSourceSessionId: null, archiveSourceAfterHandover: false },
  };
  for (let i = 0; i < 22; i++) f.doc.launches[`later${i}`] = { id: `later${i}`, cellId: 'cell', sessionId: `other${i}` };
  let out = await buildContext(f.rt, f.host, f.actor('queen'));
  assert.equal(out.queen_launch.id, 'current');
  assert.equal(out.queen_launch.handoverSourceSessionId, null);
  assert.equal(out.queen_launch.archiveSourceAfterHandover, false);
  assert(out.queen_launches.every(l => l.historical));
  f.doc.launches.current.handoverSourceSessionId = 'source';
  out = await buildContext(f.rt, f.host, f.actor('queen'));
  assert.equal(out.queen_launch.handoverSourceSessionId, 'source');
  assert.equal(out.queen_launch.archiveSourceAfterHandover, false);
  delete f.doc.launches.current.handoverSourceSessionId;
  delete f.doc.launches.current.archiveSourceAfterHandover;
  out = await buildContext(f.rt, f.host, f.actor('queen'));
  assert.equal(out.queen_launch.handoverSourceSessionId, null);
  assert.equal(out.queen_launch.archiveSourceAfterHandover, false);
  f.doc.cells.cell.queenSessionId = 'legacy';
  assert.equal((await buildContext(f.rt, f.host, f.actor('legacy'))).queen_launch, null);
});


test('sequential fresh launches replace the recovery decision without changing the source', async t => {
  const f = fixture(t);
  f.doc.launches = {};
  f.doc.cells.cell.queens = [{ sessionId: 'queen', from: 1 }];
  f.rt.changed = () => {};
  f.rt.metadata.mutate = fn => fn(f.doc);
  const source = f.host.sessions.get('queen');
  Object.assign(source, { name: 'Source', agent: 'codex' });
  const briefs = [];
  let n = 0;
  f.host.sessions.spawn = async opts => {
    const sessionId = `fresh${++n}`;
    briefs.push(opts.intent);
    onBeforeDispatch({ sessionId, ext: opts.ext.hive, host: f.host });
    return { sessionId };
  };
  const first = await launchQueen(f.rt, f.host, { cellId: 'cell', handoverSourceSessionId: 'queen' });
  const second = await launchQueen(f.rt, f.host, { cellId: 'cell' });
  let out = await buildContext(f.rt, f.host, { ...f.actor(), sessionId: second.sessionId, role: 'queen' });
  assert.equal(out.queen_launch.id, second.launchId);
  assert.equal(out.queen_launch.handoverSourceSessionId, null);
  assert.equal(out.queen_launch.archiveSourceAfterHandover, false);
  assert(out.queen_launches.find(l => l.id === first.launchId).historical);
  assert.match(briefs[1], /no handover, no archive/);
  const third = await launchQueen(f.rt, f.host, { cellId: 'cell', handoverSourceSessionId: 'queen', archiveSourceAfterHandover: false });
  out = await buildContext(f.rt, f.host, { ...f.actor(), sessionId: third.sessionId, role: 'queen' });
  assert.equal(out.queen_launch.id, third.launchId);
  assert.equal(out.queen_launch.handoverSourceSessionId, 'queen');
  assert.equal(out.queen_launch.archiveSourceAfterHandover, false);
  assert.equal(source.archived, undefined);
});

test('hive_id and legacy cell_id select the same hive and expose both output identifiers', async t => {
  const f = fixture(t);
  f.host.stores = { hive: f.rt };
  for (const ids of [{ hive_id: 'cell' }, { cell_id: 'cell' }, { hive_id: 'cell', cell_id: 'cell' }]) {
    const out = await contextTool.handler({ host: f.host, caller: 'worker' }, { ...ids, scope: 'bead', bead_id: 'work' });
    assert.equal(out.isError, undefined, JSON.stringify(out));
    assert.equal(out.structuredContent.cell.hive_id, 'cell');
    assert.equal(out.structuredContent.cell.cell_id, 'cell');
    assert.deepEqual(JSON.parse(out.content[0].text), JSON.parse(JSON.stringify(out.structuredContent)));
  }
  const conflict = await contextTool.handler({ host: f.host, caller: 'worker' }, { hive_id: 'cell', cell_id: 'other' });
  assert.equal(conflict.isError, true);
  assert.match(conflict.content[0].text, /hive_id.*cell_id.*agree/);
});


test('request tools share hive alias validation, including after membership is lost', async t => {
  const f = fixture(t);
  f.host.stores = { hive: f.rt };
  const tool = workTools.find(tool => tool.name === 'hive_list_my_requests');
  for (const ids of [{ hive_id: 'cell' }, { cell_id: 'cell' }, { hive_id: 'cell', cell_id: 'cell' }]) {
    const out = await tool.handler({ host: f.host, caller: 'worker' }, ids);
    assert.equal(out.isError, undefined, JSON.stringify(out));
    assert.deepEqual(out.structuredContent.requests, []);
  }
  for (const tool of [contextTool, ...workTools]) {
    assert.equal(tool.inputSchema.safeParse({ hive_id: 'cell', cell_id: 'other' }).success, false, tool.name);
  }
  const conflict = await tool.handler({ host: f.host, caller: 'worker' }, { hive_id: 'cell', cell_id: 'other' });
  assert.equal(conflict.isError, true);
  assert.match(conflict.content[0].text, /hive_id and cell_id must agree/);
});

test('tool results keep legacy identifiers and add hive_id at each structured level', async t => {
  const f = fixture(t);
  f.host.stores = { hive: f.rt };
  const tool = hiveTool({ name: 'test_alias', inputSchema: {} }, () => ({ cell_id: 'cell', others: [{ cell_id: 'second' }], unchanged: 'cell_legacy' }));
  const out = await tool.handler({ host: f.host, caller: 'worker' }, { hive_id: 'cell' });
  assert.deepEqual(out.structuredContent, { hive_id: 'cell', cell_id: 'cell', others: [{ hive_id: 'second', cell_id: 'second' }], unchanged: 'cell_legacy' });
});
