import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';

const page = `<!doctype html><html><head><link rel="stylesheet" href="/public/styles.css"><style>*{transition:none!important}:root{--surface:#ffffff;--fg:#202631;--fg-muted:#555f70;--border:#c9ced8;--hive-tile:#f2e3b3}</style></head><body><div class="hive-root" id="root" style="width:1000px;height:700px"></div><script type="module">
import client, { createUi } from '/public/client.js';
import { renderHive } from '/public/hive-view.js';
const store = new Map();
client.register({ api: { storage: { get: k => store.get(k), set: (k, v) => store.set(k, v), remove: k => store.delete(k) } }, register() {} });
const base = { launches: [], bindings: [], beadLayout: {}, arrangeAspect: null, workstreamColours: {}, workstreamShades: {}, archived: {}, restoreNotices: [], regionAttachments: {}, detachedWorkstreams: [], threads: [], messages: [], threadsTruncated: false, threadsAfter: null, inbox: { human: { count: 0 }, queen: { count: 0 } }, requests: {}, requestCounts: {} };
const cells = {
  live: { ...base, id: 'live', taskId: 't1', enabled: true, rootBeadId: 'r1', queenSessionId: 'q', position: { q: 0, r: 0 }, beadCount: 1 },
  gone: { ...base, id: 'gone', taskId: 't2', enabled: false, rootBeadId: 'r2', position: { q: 2, r: 0 }, beadCount: 2, retired: { outcome: 'done', summary: 'shipped it', at: Date.now(), by: 'aw:human', position: { q: 2, r: 0 } } },
};
const beads = { r1: { id: 'r1', title: 'Live', kind: 'goal', status: 'in_progress', evidence: [] }, r2: { id: 'r2', title: 'Gone', kind: 'goal', status: 'closed', outcome: 'done', evidence: [] }, w2: { id: 'w2', title: 'Old work', parentId: 'r2', kind: 'task', status: 'closed', outcome: 'done', evidence: [] } };
const hive = { cells, beads, edges: [], launches: [], operations: [], backend: { state: 'ready', snapshotComplete: true, snapshotBeadIds: Object.keys(beads) }, capacity: { limit: 8, used: 0, claimed: 0, reserved: 0, available: 8 }, metaEpoch: 'e', metaVersion: 1 };
const ui = createUi();
const sent = [];
const draw = () => { const out = renderHive({ ui, hive, graph: { sessions: [], tasks: { tasks: [{ id: 't1' }, { id: 't2' }] } }, api: {}, notices: [], busy: () => false, send: m => sent.push(m), notice() {}, bees: { slider: () => document.createElement('div') }, uiVersion: 0 }); const root = document.getElementById('root'); root.replaceChildren(out.top); return root; };
window.t = { ui, draw, sent };
</script></body></html>`;

test('retired hives toggle on All hives, show grey with an outcome mark, open read-only and offer Reopen (isolated Chrome, synthetic store)', async (t) => {
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
    const r = await call('Runtime.evaluate', { expression: `(async()=>{const deadline=Date.now()+5000;while(!window.t&&Date.now()<deadline)await new Promise(r=>setTimeout(r,25));${expression}})()`, awaitPromise: true, returnByValue: true });
    assert.equal(r.exceptionDetails, undefined, JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };
  const overview = await run(`
    t.draw();
    const hiddenByDefault = !document.querySelector('[data-tile-id="gone"]');
    const toggle = document.querySelector('[data-focus-key="show-retired"]');
    const label1 = toggle.textContent;
    toggle.click();
    t.draw();
    const tile = document.querySelector('[data-tile-id="gone"]');
    const live = document.querySelector('[data-tile-id="live"]');
    const fill = el => getComputedStyle(el.querySelector('.hive-hex-shape')).fill;
    return { hiddenByDefault, label1, label2: document.querySelector('[data-focus-key="show-retired"]').textContent, remembered: t.ui.showRetired(), retiredFill: fill(tile), liveFill: fill(live), mark: Boolean(tile.querySelector('.hive-pm-done')), cls: tile.getAttribute('class') };
  `);
  assert.equal(overview.hiddenByDefault, true);
  assert.match(overview.label1, /Show retired \(1\)/);
  assert.match(overview.label2, /Hide retired \(1\)/);
  assert.equal(overview.remembered, true);
  assert.match(overview.cls, /is-retired/);
  assert.equal(overview.mark, true);
  assert.notEqual(overview.retiredFill, overview.liveFill, 'retired fill is grey, different from a live hive');
  const opened = await run(`
    t.ui.openCell('gone');
    const root = t.draw();
    const text = root.textContent;
    return { badge: /Retired · done/.test(text), reopen: /Reopen hive…/.test(text), tiles: [...root.querySelectorAll('[data-tile-id]')].map(e => e.getAttribute('data-tile-id')), turnOn: /Turn on/.test(text), arrangeDisabled: root.querySelector('[data-focus-key="arrange:gone"]')?.disabled };
  `);
  assert.equal(opened.badge, true);
  assert.equal(opened.reopen, true);
  assert.ok(opened.tiles.includes('w2'));
  assert.equal(opened.turnOn, false);
  assert.equal(opened.arrangeDisabled, true);
  const reopening = await run(`
    document.querySelector('[data-focus-key="reopen-open:gone"]').click();
    const root = t.draw();
    return { form: Boolean(root.querySelector('[data-focus-key="reopen-reason:gone"]')) };
  `);
  assert.equal(reopening.form, true);
});
