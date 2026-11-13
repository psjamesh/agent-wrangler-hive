import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { MetadataStore } from '../server/metadata-store.js';
import { recordHumanInput, withdrawMessage, undoWithdraw, inboxSlice, awaitingQueen } from '../server/conversation.js';

const CELL = 'cell_synth';
const page = `<!doctype html><html><head><link rel="stylesheet" href="/public/styles.css"></head><body><div id="root"></div><script type="module">
import client, { createUi } from '/public/client.js';
import { renderConversation } from '/public/conversation.js';
const values = new Map();
client.register({ api: { storage: { get: k => values.get(k), set: (k, v) => values.set(k, v), remove: k => values.delete(k) } }, register() {} });
const ui = createUi();
const hive = { metaEpoch: 'e', beads: {} };
let version = 0, cell = null;
const ctx = { busy: () => false, notice(m) { window.notices.push(m); }, send(frame, opts) {
  fetch('/act', { method: 'POST', body: JSON.stringify(frame) }).then(r => r.json()).then(async reply => { await load(); opts?.onReply?.(reply); draw(); });
} };
window.notices = [];
async function load() { cell = await (await fetch('/state')).json(); }
function draw() {
  ctx.uiVersion = ++version;
  const out = renderConversation({ cell, hive, graph: { sessions: [] }, api: { markdown: s => s }, ui, ctx });
  const root = document.getElementById('root');
  root.replaceChildren(...[out.head, out.list].filter(Boolean));
}
window.boot = async (mode, thread) => { await load(); ui.setAllTopics(cell.id, true); if (mode) ui.setInboxView(cell.id, mode); if (thread) ui.openThreadFor(cell.id, thread, cell.threads.find(t => t.id === thread)); draw(); return true; };
window.redraw = draw;
</script></body></html>`;

function synthetic() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-withdraw-browser-'));
  const metadata = new MetadataStore({ file: path.join(root, 'metadata.json') });
  const cell = { id: CELL, enabled: true, queenSessionId: '11111111-1111-4111-8111-111111111111', rootBeadId: 'hive-root' };
  metadata.mutate((d) => { d.cells[CELL] = cell; });
  const rt = { host: { tasks: { forSession: () => null } }, pendingParticipants: new Map(), paths: { root }, metadata, changed() {}, snapshots: { graph: { beads: {} } } };
  return { root, rt, metadata };
}

function state({ rt, metadata }) {
  const d = metadata.read();
  const list = d.conversation[CELL] || [];
  const slice = inboxSlice(d, CELL, 'queen');
  const human = inboxSlice(d, CELL, 'human');
  const threads = Object.values(d.threads[CELL] || {}).map((t) => {
    const mine = list.filter((m) => m.threadId === t.id);
    const waiting = mine.filter(awaitingQueen);
    return { id: t.id, title: t.title, beadId: null, beads: [], count: mine.length, retained: mine.length, lastAt: t.lastAt, windowFrom: mine[0]?.id, waitingFrom: null, awaiting: { human: null, queen: waiting.length ? { count: waiting.length, newest: { id: waiting.at(-1).id, n: waiting.at(-1).n ?? null } } : null } };
  });
  return { id: CELL, rootBeadId: 'hive-root', enabled: true, queenSessionId: '11111111-1111-4111-8111-111111111111', messages: list, threads, inbox: { queen: slice, human }, requests: {} };
}

test('withdrawing and undoing in the Waiting for queen list and the conversation, on a synthetic store', async (t) => {
  const port = Number(process.env.HIVE_TEST_CDP);
  assert.ok(Number.isInteger(port) && port > 0 && port !== 7777, 'Set HIVE_TEST_CDP to an explicitly allocated isolated headless Chrome port');
  const s = synthetic();
  t.after(() => fs.rmSync(s.root, { recursive: true, force: true }));
  const first = await recordHumanInput(s.rt, { cellId: CELL, text: 'Wrong hive, ignore this' });
  const second = await recordHumanInput(s.rt, { cellId: CELL, text: 'Please plan the release', threadId: first.threadId });
  const server = http.createServer(async (req, res) => {
    if (req.url === '/') { res.setHeader('Content-Type', 'text/html'); res.end(page); return; }
    if (req.url === '/state') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(state(s))); return; }
    if (req.url === '/act') {
      let body = ''; for await (const c of req) body += c;
      const f = JSON.parse(body);
      try {
        const out = f.type === 'hive-withdraw' ? withdrawMessage(s.rt, f) : undoWithdraw(s.rt, f);
        res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: true, ...out }));
      } catch (err) { res.end(JSON.stringify({ ok: false, error: err.message })); }
      return;
    }
    if (!/^\/public\/[\w.-]+$/.test(req.url)) { res.writeHead(404).end(); return; }
    try {
      res.setHeader('Content-Type', req.url.endsWith('.css') ? 'text/css' : 'text/javascript');
      res.end(await readFile(new URL(`..${req.url}`, import.meta.url)));
    } catch { res.writeHead(404).end(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${port}`;
  const target = await (await fetch(`${origin}/json/new?http://127.0.0.1:${server.address().port}/`, { method: 'PUT' })).json();
  t.after(() => fetch(`${origin}/json/close/${target.id}`));
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  t.after(() => socket.close());
  await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }));
  let sequence = 0;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (!message.id) return;
    const p = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) p.reject(message.error); else p.resolve(message.result);
  });
  const call = (method, params) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
  const run = async (expression) => {
    const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    assert.equal(r.exceptionDetails, undefined, JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };
  const settle = () => run('new Promise(r => setTimeout(r, 600))');
  const click = async (label) => { assert.equal(await run(`(() => { const b = [...document.querySelectorAll('#root button')].find(x => x.textContent === ${JSON.stringify(label)}); if (!b) return false; b.click(); return true; })()`), true, `no ${label} button`); await settle(); };
  const count = (label) => run(`[...document.querySelectorAll('#root button')].filter(x => x.textContent === ${JSON.stringify(label)}).length`);
  const rows = () => run(`document.querySelectorAll('#root li.hive-inbox-item').length`);
  const loaded = async (mode, thread) => { await new Promise((r) => setTimeout(r, 300)); await run(`new Promise((resolve, reject) => { const t = Date.now(); const go = () => window.boot ? resolve(window.boot(${JSON.stringify(mode)}, ${JSON.stringify(thread)})) : Date.now() - t > 5000 ? reject(Error('no boot')) : setTimeout(go, 25); go(); })`); await settle(); };

  await loaded('queen', null);
  assert.equal(await rows(), 1);
  assert.equal(await run(`document.querySelector('#root .hive-unread').textContent`), '2');
  assert.equal(await count('Withdraw'), 1);
  await click('Withdraw');
  assert.deepEqual(s.metadata.read().conversation[CELL].filter(awaitingQueen).map((m) => m.id), [first.id]);
  assert.equal(inboxSlice(s.metadata.read(), CELL, 'queen').count, 1);
  assert.equal(await run(`document.querySelector('#root .hive-unread').textContent`), '1');
  assert.match(await run(`document.querySelector('#root .hive-inbox-withdrawn').textContent`), /Withdrawn: .*Undo/);
  const shot = await call('Page.captureScreenshot', { format: 'png' });
  if (process.env.HIVE_TEST_SHOT) fs.writeFileSync(process.env.HIVE_TEST_SHOT, Buffer.from(shot.data, 'base64'));
  await click('Undo');
  assert.equal(inboxSlice(s.metadata.read(), CELL, 'queen').count, 2);
  assert.equal(await run(`document.querySelector('#root .hive-unread').textContent`), '2');
  assert.equal(await count('Undo'), 0);

  const thread = s.metadata.read().conversation[CELL][0].threadId;
  await loaded(null, thread);
  assert.equal(await count('Withdraw'), 2);
  await click('Withdraw');
  assert.equal(await count('Withdraw'), 1);
  const msgs = s.metadata.read().conversation[CELL];
  assert.equal(msgs.filter((m) => m.response.withdrawn).length, 1);
  assert.equal(await count('Undo'), 1);
  assert.equal(await run(`[...document.querySelectorAll('#root .hive-badge-withdrawn')].map(x => x.textContent).join()`), 'Withdrawn');
  await click('Undo');
  assert.equal(s.metadata.read().conversation[CELL].filter((m) => m.response.withdrawn).length, 0);
  assert.deepEqual(await run('window.notices'), []);
});
