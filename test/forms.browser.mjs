import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';

const page = `<!doctype html><html><head><link rel="stylesheet" href="/public/styles.css"></head><body><div class="hive-root" id="root" style="width:1000px;height:700px"></div><script type="module">
import client, { createUi } from '/public/client.js';
import { retireDrawer } from '/public/retire-view.js';
import { workstreamDrawer, completeKey } from '/public/workstream-view.js';
import { queenInstructions } from '/public/cell-view.js';
const store = new Map();
client.register({ api: { storage: { get: k => store.get(k), set: (k, v) => store.set(k, v), remove: k => store.delete(k) } }, register() {} });
const ui = createUi();
const sent = [], replies = [], notices = [];
const hive = { beads: { ws: { id: 'ws', title: 'Stream', parentId: 'root', status: 'closed' } } };
const ctx = { ui, hive, api: {}, send: (m, o) => { sent.push(m); replies.push(o.onReply); }, notice: (...a) => notices.push(a) };
const root = document.getElementById('root');
const mount = (node) => { root.replaceChildren(node || ''); return root; };
window.t = { ui, ctx, sent, replies, notices, mount, retireDrawer, workstreamDrawer, completeKey, queenInstructions };
</script></body></html>`;

test('retire, reopen, complete-workstream and queen-instructions forms validate, submit, fail and succeed in a real browser (isolated Chrome, synthetic data)', async (t) => {
  const port = Number(process.env.HIVE_TEST_CDP);
  assert.ok(Number.isInteger(port) && port > 0 && port !== 7777, 'Set HIVE_TEST_CDP to an explicitly allocated isolated headless Chrome port');
  const server = http.createServer(async (req, res) => {
    if (req.url === '/') { res.setHeader('Content-Type', 'text/html'); res.end(page); return; }
    if (!/^\/public\/[\w.-]+$/.test(req.url)) { res.writeHead(404).end(); return; }
    try {
      res.setHeader('Content-Type', req.url.endsWith('.css') ? 'text/css' : 'text/javascript');
      res.end(await readFile(new URL(`..${req.url}`, import.meta.url)));
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${port}`;
  const target = await (await fetch(`${origin}/json/new?http://127.0.0.1:${server.address().port}/`, { method: 'PUT' })).json();
  t.after(() => fetch(`${origin}/json/close/${target.id}`));
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  t.after(() => socket.close());
  await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }));
  let sequence = 0;
  const pending = new Map();
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (!message.id) return;
    const promise = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) promise.reject(message.error); else promise.resolve(message.result);
  });
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const run = async (expression) => {
    const r = await call('Runtime.evaluate', { expression: `(async()=>{const deadline=Date.now()+20000;while(!window.t&&Date.now()<deadline)await new Promise(r=>setTimeout(r,25));${expression}})()`, awaitPromise: true, returnByValue: true });
    assert.equal(r.exceptionDetails, undefined, JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };
  const submit = `document.querySelector('form button[type="submit"]').click();`;
  const retire = await run(`
    const cell = { id: 'c1', enabled: true };
    const key = 'retire:c1';
    t.ui.setForm(key, { mode: 'retire', outcome: 'done', summary: '', override: false, archiveSessions: false, check: { problems: [], sessions: [{ session_id: 's1' }] }, error: null, pending: null });
    t.mount(t.retireDrawer(t.ctx, cell));
    ${submit}
    t.mount(t.retireDrawer(t.ctx, cell));
    const validation = document.querySelector('.hive-dialog-error')?.textContent;
    const sentBefore = t.sent.length;
    const textarea = document.querySelector('textarea');
    textarea.value = 'All done';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    t.mount(t.retireDrawer(t.ctx, cell));
    ${submit}
    t.mount(t.retireDrawer(t.ctx, cell));
    const pendingLabel = document.querySelector('form button[type="submit"]').textContent;
    const pendingDisabled = document.querySelector('form button[type="submit"]').disabled;
    t.replies.at(-1)({ ok: false, error: 'Nope.' });
    t.mount(t.retireDrawer(t.ctx, cell));
    const failure = document.querySelector('.hive-dialog-error')?.textContent;
    const keptSummary = document.querySelector('textarea').value;
    ${submit}
    t.replies.at(-1)({ ok: true, archived: ['s1'] });
    return { validation, sentBefore, msg: t.sent[0], pendingLabel, pendingDisabled, failure, keptSummary, count: t.sent.length, form: t.ui.form(key), notices: t.notices };
  `);
  assert.equal(retire.validation, 'Write a short summary of what the hive achieved, or why it ended.');
  assert.equal(retire.sentBefore, 0);
  assert.deepEqual(retire.msg, { type: 'hive-cell-retire', cellId: 'c1', outcome: 'done', summary: 'All done', override: false, archiveSessions: false, sessionIds: ['s1'] });
  assert.equal(retire.pendingLabel, 'Retiring…');
  assert.equal(retire.pendingDisabled, true);
  assert.equal(retire.failure, 'Nope.');
  assert.equal(retire.keptSummary, 'All done');
  assert.equal(retire.count, 2);
  assert.equal(retire.form, null);
  assert.match(retire.notices[0][0], /retired and 1 session was archived/);

  const reopen = await run(`
    t.sent.length = 0; t.notices.length = 0;
    const cell = { id: 'c1', retired: { outcome: 'done' } };
    const key = 'retire:c1';
    t.ui.setForm(key, { mode: 'reopen', reason: '', error: null, pending: null });
    t.mount(t.retireDrawer(t.ctx, cell));
    ${submit}
    t.mount(t.retireDrawer(t.ctx, cell));
    const validation = document.querySelector('.hive-dialog-error')?.textContent;
    t.ui.patchForm(key, { reason: 'More to do' });
    t.mount(t.retireDrawer(t.ctx, cell));
    ${submit}
    t.mount(t.retireDrawer(t.ctx, cell));
    const pendingLabel = document.querySelector('form button[type="submit"]').textContent;
    t.replies.at(-1)({ ok: false, error: 'Busy.' });
    t.mount(t.retireDrawer(t.ctx, cell));
    const failure = document.querySelector('.hive-dialog-error')?.textContent;
    ${submit}
    t.replies.at(-1)({ ok: true });
    return { validation, msg: t.sent[0], pendingLabel, failure, form: t.ui.form(key) };
  `);
  assert.equal(reopen.validation, 'Say why the hive is being reopened.');
  assert.deepEqual(reopen.msg, { type: 'hive-cell-reopen', cellId: 'c1', reason: 'More to do' });
  assert.equal(reopen.pendingLabel, 'Reopening…');
  assert.equal(reopen.failure, 'Busy.');
  assert.equal(reopen.form, null);

  const complete = await run(`
    t.sent.length = 0; t.notices.length = 0;
    const cell = { id: 'c1', enabled: true, rootBeadId: 'root' };
    const key = t.completeKey('c1');
    t.ui.setForm(key, { headId: 'ws', outcome: 'done', summary: '', archive: true, check: { problems: [] }, error: null, pending: null });
    t.mount(t.workstreamDrawer(t.ctx, cell));
    ${submit}
    t.mount(t.workstreamDrawer(t.ctx, cell));
    const validation = document.querySelector('.hive-dialog-error')?.textContent;
    t.ui.patchForm(key, { summary: 'Shipped' });
    t.mount(t.workstreamDrawer(t.ctx, cell));
    ${submit}
    t.mount(t.workstreamDrawer(t.ctx, cell));
    const pendingLabel = document.querySelector('form button[type="submit"]').textContent;
    t.replies.at(-1)({ ok: false, error: 'Stale.' });
    t.mount(t.workstreamDrawer(t.ctx, cell));
    const failure = document.querySelector('.hive-dialog-error')?.textContent;
    ${submit}
    t.replies.at(-1)({ ok: true, archiveError: 'Could not archive.' });
    return { validation, msg: t.sent[0], pendingLabel, failure, form: t.ui.form(key), notices: t.notices };
  `);
  assert.equal(complete.validation, 'Write a summary of what it achieved, or why it ended.');
  assert.deepEqual(complete.msg, { type: 'hive-ws-complete', cellId: 'c1', headId: 'ws', outcome: 'done', summary: 'Shipped', archive: true });
  assert.equal(complete.pendingLabel, 'Completing…');
  assert.equal(complete.failure, 'Stale.');
  assert.equal(complete.form, null);
  assert.deepEqual(complete.notices, [['Could not archive.', { severity: 'error' }]]);

  const instructions = await run(`
    t.sent.length = 0; t.notices.length = 0;
    const cell = { id: 'c1', queenSessionId: 'q1' };
    const key = 'instructions:c1';
    t.ui.setForm(key, { id: 'e7', text: 'Be brief', error: null, pending: null });
    t.mount(t.queenInstructions(t.ctx, cell));
    const textarea = document.querySelector('textarea');
    textarea.value = 'Be very brief';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    ${submit}
    t.mount(t.queenInstructions(t.ctx, cell));
    const pendingLabel = document.querySelector('form button[type="submit"]').textContent;
    const pendingId = t.ui.form(key).pending;
    t.replies.at(-1)({ ok: false, error: 'Denied.' });
    t.mount(t.queenInstructions(t.ctx, cell));
    const failure = document.querySelector('.hive-dialog-error')?.textContent;
    const kept = document.querySelector('textarea').value;
    ${submit}
    t.replies.at(-1)({ ok: true });
    return { msg: t.sent[0], pendingLabel, pendingId, failure, kept, form: t.ui.form(key) };
  `);
  assert.deepEqual(instructions.msg, { type: 'hive-cell-instructions', cellId: 'c1', instructions: 'Be very brief' });
  assert.equal(instructions.pendingLabel, 'Saving…');
  assert.match(instructions.pendingId, /^e7:[0-9a-z]+$/);
  assert.equal(instructions.failure, 'Denied.');
  assert.equal(instructions.kept, 'Be very brief');
  assert.equal(instructions.form, null);
});
