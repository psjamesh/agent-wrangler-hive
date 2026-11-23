import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';

const darkTheme = '--bg:#15171b;--surface:#202329;--surface-2:#292d35;--fg:#eceef3;--fg-muted:#a7aebb;--border:#535b6a;--hive-tile:#403820';

const page = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/public/styles.css"><style>*{transition:none!important;box-sizing:border-box}body{margin:0}:root{--bg:#f4f5f7;--surface-2:#f4f5f7;--surface:#ffffff;--fg:#202631;--fg-muted:#555f70;--border:#c9ced8;--hive-tile:#f2e3b3}</style></head><body><div class="hive-root" id="root" style="width:100vw;height:100vh"></div><script type="module">
import client from '/public/client.js';
let view, receive;
const send = frame => {
  if (frame.type !== 'hive-deep-link') return;
  const cell = cells[frame.cellId];
  const thread = cell?.threads.find(t => t.id === frame.threadId);
  const messages = cell?.messages.filter(m => m.threadId === frame.threadId) || [];
  queueMicrotask(() => receive({ op: frame.type, requestId: frame.requestId, ok: Boolean(thread), cellId: frame.cellId, thread, messages, messageId: frame.messageId, more: false }));
};
client.register({ onMessage(fn) { receive = fn; }, api: { state: () => ({ hive: graph.hive }), act: (type, args) => { send({ type, ...args }); return new Promise(() => {}); }, storage: { get: k => localStorage.getItem("hive:" + k), set: (k, v) => localStorage.setItem("hive:" + k, v), remove: k => localStorage.removeItem("hive:" + k) } }, register(kind, v) { view = v; } });
const base = { launches: [], bindings: [], beadLayout: {}, arrangeAspect: null, workstreamColours: {}, workstreamShades: {}, archived: {}, restoreNotices: [], regionAttachments: {}, detachedWorkstreams: [], threads: [], messages: [], threadsTruncated: false, threadsAfter: null, inbox: { human: { ids: [], count: 0 }, queen: { ids: [], count: 0 } }, requestCounts: {} };
const req = (id, title, body, at, extra = {}) => ({ id, audience: 'human', state: 'open', title, body, createdAt: at, threadId: 't_' + id, messageId: 'm_' + id, requesterSessionId: 's1', sessionLink: { sessionId: 'archived', label: 'Archived worker' }, ...extra });
const cells = {
  alpha: { ...base, id: 'alpha', taskId: 't1', enabled: true, rootBeadId: 'r1', queenSessionId: 's1', position: { q: 0, r: 0 }, beadCount: 1, requests: { a: req('a', 'Which database should the importer use?', 'Postgres or SQLite for the local cache?', Date.now() - 600000, { blocking: true }), b: req('b', 'Approve the retry policy', 'Three retries with backoff.', Date.now() - 3600000) } },
  beta: { ...base, id: 'beta', taskId: 't2', enabled: true, rootBeadId: 'r2', queenSessionId: 's1', position: { q: 2, r: 0 }, beadCount: 1, requests: { c: req('c', 'Rename the export flag?', 'It clashes with the new option.', Date.now() - 7200000) } },
};
const waiting = { required: true, rev: 1, state: null };
cells.alpha.threads = [{ id: 't_a', title: 'Importer database' }, { id: 'read', title: 'Release summary' }];
cells.alpha.messages = [{ id: 'm_a', threadId: 't_a', at: Date.now() - 800000, text: 'Choose the cache database. #session=s2 #session=unnamed', author: 'session', sessionId: 's1', ack: waiting }, { id: 'm_a2', threadId: 't_a', at: Date.now() - 700000, text: 'The importer is ready for your decision.', author: 'session', sessionId: 's1', ack: waiting }, { id: 'read1', threadId: 'read', at: Date.now() - 86400000, text: 'The release notes are ready.', author: 'session', sessionId: 's1', ack: waiting }];
cells.alpha.inbox = { human: { ids: ['m_a', 'm_a2', 'read1'], count: 3, rev: 1 }, queen: { ids: [], count: 0 } };
const beads = { r1: { id: 'r1', title: 'Importer rewrite', goal: 'A detailed description\\nWith another line', kind: 'goal', status: 'in_progress', evidence: [] }, r2: { id: 'r2', title: 'Export cleanup', kind: 'goal', status: 'in_progress', evidence: [] } };
const hive = { cells, beads, edges: [], launches: [], operations: [], backend: { state: 'ready', snapshotComplete: true, snapshotBeadIds: Object.keys(beads) }, capacity: { limit: 8, used: 0, claimed: 0, reserved: 0, available: 8 }, metaEpoch: 'e', metaVersion: 1 };
const graph = { hive, sessions: [{ sessionId: 's1', name: 'Importer queen' }, { sessionId: 's2', name: 'Importer worker' }, { sessionId: 'unnamed' }, { sessionId: 'archived', archived: true }], tasks: { tasks: [{ id: 't1', name: 'Importer hive' }, { id: 't2', name: 'Export hive' }] } };
const root = document.getElementById('root');
window.t = { client, root, graph, redraw: () => { view.update(root, null, { ...graph }); } };
view.mount(root, null);
view.update(root, null, graph);
</script></body></html>`;


test('Hive tile details open independently and dismiss accessibly (isolated Chrome, synthetic store)', { skip: !process.env.HIVE_TEST_CHROME ? 'Set HIVE_TEST_CHROME to a Chrome binary' : !process.env.HIVE_TEST_CDP ? 'Set HIVE_TEST_CDP to an isolated Chrome port' : false }, async (t) => {
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
  const viewport = (width, height) => call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 500 });
  const shot = async name => {
    const dir = process.env.HIVE_SHOT_DIR;
    if (!dir) return;
    const { data } = await call('Page.captureScreenshot', { format: 'png' });
    await writeFile(`${dir}/${name}.png`, Buffer.from(data, 'base64'));
  };
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
    const r = await call('Runtime.evaluate', { expression: `(async()=>{const readyDeadline=Date.now()+5000;while(!window.t&&Date.now()<readyDeadline)await new Promise(r=>setTimeout(r,25));${expression}})()`, awaitPromise: true, returnByValue: true });
    assert.equal(r.exceptionDetails, undefined, JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };
  await call('Page.enable');
  const loaded = new Promise(resolve => socket.addEventListener('message', function onLoad(event) {
    if (JSON.parse(event.data).method !== 'Page.loadEventFired') return;
    socket.removeEventListener('message', onLoad);
    resolve();
  }));
  await call('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/` });
  await loaded;
  await viewport(1280, 800);
  const dismissed = async () => {
    const state = await run(`
      const deadline = Date.now() + 2000;
      while (document.querySelector('.hive-overview-popover') && Date.now() < deadline) await new Promise(r => setTimeout(r, 20));
      const dialog = document.querySelector('.hive-overview-popover');
      return { removed: !dialog, open: dialog?.open, focus: document.activeElement?.outerHTML?.slice(0, 400) };
    `);
    assert.equal(state.removed, true, JSON.stringify(state));
    assert.equal(await run(`return document.activeElement.dataset.hiveInfo;`), 'alpha');
  };
  const inspect = () => run(`
    const tile = document.querySelector('[data-tile-id="alpha"]');
    return { sub: [...tile.querySelectorAll('.hive-hex-sub')].map(e => e.textContent),
      tooltip: [...tile.children].some(e => e.tagName === 'title'), aria: tile.getAttribute('aria-label') };
  `);
  const initial = await inspect();
  assert.deepEqual(initial.sub, []);
  assert.equal(initial.tooltip, false);
  assert.match(initial.aria, /A detailed description/);
  const infoPoint = () => run(`
    const b = document.querySelector('[data-hive-info="alpha"]').getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
  `);
  const click = async p => {
    await call('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...p });
    await call('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...p });
  };
  const press = async key => {
    await call('Input.dispatchKeyEvent', { type: 'keyDown', key });
    await call('Input.dispatchKeyEvent', { type: 'keyUp', key });
  };
  await run(`await new Promise(r => setTimeout(r, 300));`);
  const point = await infoPoint();
  await click(point);
  assert.equal(await run(`return !!document.querySelector('.hive-overview');`), true);
  const details = await run(`return document.querySelector('.hive-overview-popover').textContent;`);
  for (const text of ['Importer hive', 'A detailed description', 'With another line', 'Queen']) assert.ok(details.includes(text), text);
  await shot('tile-and-details-light');
  assert.equal(await run(`
    const dialog = document.querySelector('.hive-overview-popover');
    t.graph.sessions[0].status = 'working';
    t.redraw();
    return document.querySelector('.hive-overview-popover') === dialog && dialog.open && dialog.textContent.includes('working');
  `), true);
  await press('Escape');
  await dismissed();
  for (const key of ['Enter', ' ']) {
    await press(key);
    assert.equal(await run(`return !!document.querySelector('.hive-overview-popover[open]');`), true, `keyboard activation: ${key}`);
    await run(`document.querySelector('.hive-overview-popover button').click();`);
    await dismissed();
  }
  await click(await infoPoint());
  await click({ x: 2, y: 2 });
  await dismissed();
  await run(`document.documentElement.style.cssText = ${JSON.stringify(darkTheme)};`);
  await click(await infoPoint());
  await shot('tile-and-details-dark');
  await press('Escape');
  await dismissed();
  const placement = await run(`return document.querySelector('[data-tile-id="alpha"]').getAttribute('transform');`);
  const start = await infoPoint();
  await call('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...start });
  await call('Input.dispatchMouseEvent', { type: 'mouseMoved', button: 'left', buttons: 1, x: start.x + 100, y: start.y + 100 });
  await call('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, x: start.x + 100, y: start.y + 100 });
  assert.equal(await run(`return document.querySelector('[data-tile-id="alpha"]').getAttribute('transform');`), placement);
  assert.equal(await run(`return !!document.querySelector('.hive-overview');`), true);
  assert.equal(await run(`
    const map = document.querySelector('.hive-canvas');
    const info = document.querySelector('[data-hive-info="alpha"]');
    map.focus();
    map.hiveRestoreView({ k: 0.5, tx: -3000, ty: -3000 });
    info.focus();
    const r = info.getBoundingClientRect(), c = map.getBoundingClientRect();
    return r.width >= 24 && r.height >= 24 && r.left >= c.left && r.right <= c.right && r.top >= c.top && r.bottom <= c.bottom;
  `), true);
  await run(`document.querySelector('.hive-canvas').hiveRestoreView({ k: 0.1, tx: 500, ty: 350 });`);
  assert.equal(await run(`return document.activeElement.classList.contains('hive-canvas');`), true);
  assert.equal(await run(`return getComputedStyle(document.querySelector('[data-hive-info="alpha"]')).visibility;`), 'hidden');
});
