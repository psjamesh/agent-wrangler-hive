import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom, byTag, walk, fire } from './helpers/dom.mjs';
import { retireDrawer } from '../public/retire-view.js';
import { workstreamDrawer, completeKey } from '../public/workstream-view.js';
import { retireKey } from '../public/retired.js';

function harness(t, forms) {
  installDom(t);
  const sent = [], notices = [], closed = [];
  const ui = {
    form: (key) => forms[key] ?? null,
    setForm: (key, value) => { forms[key] = value; },
    patchForm: (key, patch) => { forms[key] = { ...forms[key], ...patch }; },
    closeCell: () => closed.push(true),
  };
  const ctx = { ui, hive: { beads: { ws: { id: 'ws', title: 'Stream', parentId: 'root' } } }, send: (msg, { onReply }) => sent.push([msg, onReply]), notice: (...a) => notices.push(a) };
  return { ctx, sent, notices, closed, forms };
}

const submit = (drawer) => fire(byTag(drawer, 'form')[0], 'submit');
const note = (drawer) => walk(drawer).find((e) => e.getAttribute('class') === 'hive-dialog-error')?.textContent;

test('the retire form validates the summary, sends the retire request and closes the hive on success', (t) => {
  const cell = { id: 'c1', enabled: true };
  const check = { problems: [], sessions: [{ session_id: 's1' }] };
  const s = harness(t, { [retireKey('c1')]: { mode: 'retire', outcome: 'done', summary: ' ', check, archiveSessions: true } });
  submit(retireDrawer(s.ctx, cell));
  assert.deepEqual(s.sent, []);
  assert.equal(note(retireDrawer(s.ctx, cell)), 'Write a short summary of what the hive achieved, or why it ended.');
  s.forms[retireKey('c1')].summary = 'All done';
  submit(retireDrawer(s.ctx, cell));
  assert.deepEqual(s.sent[0][0], { type: 'hive-cell-retire', cellId: 'c1', outcome: 'done', summary: 'All done', override: false, archiveSessions: true, sessionIds: ['s1'] });
  assert.equal(s.forms[retireKey('c1')].pending !== null, true);
  s.sent[0][1]({ ok: true, archived: ['s1'] });
  assert.equal(s.forms[retireKey('c1')], null);
  assert.deepEqual(s.closed, [true]);
  assert.match(s.notices[0][0], /retired and 1 session was archived/);
});

test('the retire form does not send while open work blocks it unless overridden, and shows a failed reply', (t) => {
  const cell = { id: 'c1', enabled: true };
  const check = { problems: ['2 open'], sessions: [] };
  const s = harness(t, { [retireKey('c1')]: { mode: 'retire', outcome: 'done', summary: 'x', check } });
  submit(retireDrawer(s.ctx, cell));
  assert.deepEqual(s.sent, []);
  s.forms[retireKey('c1')].override = true;
  submit(retireDrawer(s.ctx, cell));
  s.sent[0][1]({ ok: false, error: 'Nope.' });
  assert.equal(note(retireDrawer(s.ctx, cell)), 'Nope.');
  assert.equal(s.forms[retireKey('c1')].pending, null);
  assert.deepEqual(s.closed, []);
});

test('the reopen form requires a reason, then sends and clears itself, noting a reply that arrives after it closed', (t) => {
  const cell = { id: 'c1', retired: true };
  const key = retireKey('c1');
  const s = harness(t, { [key]: { mode: 'reopen', reason: '' } });
  submit(retireDrawer(s.ctx, cell));
  assert.equal(note(retireDrawer(s.ctx, cell)), 'Say why the hive is being reopened.');
  s.forms[key].reason = 'More to do';
  submit(retireDrawer(s.ctx, cell));
  assert.deepEqual(s.sent[0][0], { type: 'hive-cell-reopen', cellId: 'c1', reason: 'More to do' });
  s.forms[key] = null;
  s.sent[0][1]({ ok: false, error: 'Busy.' });
  assert.deepEqual(s.notices, [['The hive was not reopened: Busy.']]);
});

test('the complete-workstream form sends the completion and reports an archive error after success', (t) => {
  const cell = { id: 'c1', enabled: true, rootBeadId: 'root' };
  const key = completeKey('c1');
  const s = harness(t, { [key]: { headId: 'ws', outcome: 'done', summary: 'Shipped', archive: false, check: { problems: [] } } });
  submit(workstreamDrawer(s.ctx, cell));
  assert.deepEqual(s.sent[0][0], { type: 'hive-ws-complete', cellId: 'c1', headId: 'ws', outcome: 'done', summary: 'Shipped', archive: false });
  s.sent[0][1]({ ok: true, archiveError: 'Could not archive.' });
  assert.equal(s.forms[key], null);
  assert.deepEqual(s.notices, [['Could not archive.', { severity: 'error' }]]);
});

test('a failed complete reply after the form changed is raised as an error notice', (t) => {
  const cell = { id: 'c1', enabled: true, rootBeadId: 'root' };
  const key = completeKey('c1');
  const s = harness(t, { [key]: { headId: 'ws', outcome: 'done', summary: 'Shipped', check: { problems: [] } } });
  submit(workstreamDrawer(s.ctx, cell));
  s.forms[key] = null;
  s.sent[0][1]({ ok: false, error: 'Stale.' });
  assert.deepEqual(s.notices, [['The workstream was not completed: Stale.', { severity: 'error' }]]);
});

test('the queen-instructions form sends the text with an id built from the editor id and handles stale replies', async (t) => {
  const { queenInstructions } = await import('../public/cell-view.js');
  const cell = { id: 'c1', queenSessionId: 'q1' };
  const key = 'instructions:c1';
  const s = harness(t, { [key]: { id: 'e7', text: 'Be brief' } });
  submit(queenInstructions(s.ctx, cell));
  assert.deepEqual(s.sent[0][0], { type: 'hive-cell-instructions', cellId: 'c1', instructions: 'Be brief' });
  assert.match(s.forms[key].pending, /^e7:[0-9a-z]+$/);
  s.sent[0][1]({ ok: false, error: 'Denied.' });
  assert.equal(note(queenInstructions(s.ctx, cell)), 'Denied.');
  submit(queenInstructions(s.ctx, cell));
  s.forms[key] = null;
  s.sent[1][1]({ ok: false });
  assert.deepEqual(s.notices, [['Queen instructions were not saved: Could not save the instructions.', { severity: 'error' }]]);
  s.forms[key] = { id: 'e8', text: 'x' };
  submit(queenInstructions(s.ctx, cell));
  s.forms[key] = null;
  s.sent[2][1]({ ok: true });
  assert.match(s.notices[1][0], /Earlier queen instructions were saved/);
});
