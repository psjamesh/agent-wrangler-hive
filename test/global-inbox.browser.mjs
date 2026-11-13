import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';

const darkTheme = '--bg:#15171b;--surface:#202329;--surface-2:#292d35;--fg:#eceef3;--fg-muted:#a7aebb;--border:#535b6a;--hive-tile:#403820';

const page = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/public/styles.css"><style>*{transition:none!important;box-sizing:border-box}body{margin:0}:root{--bg:#f4f5f7;--surface-2:#f4f5f7;--surface:#ffffff;--fg:#202631;--fg-muted:#555f70;--border:#c9ced8;--hive-tile:#f2e3b3}</style></head><body><div class="hive-root" id="root" style="width:100vw;height:100vh"></div><script type="module">
import client from '/public/client.js';
const store = new Map();
let view;
client.register({ api: { storage: { get: k => store.get(k), set: (k, v) => store.set(k, v), remove: k => store.delete(k) } }, register(kind, v) { view = v; } });
const base = { launches: [], bindings: [], beadLayout: {}, arrangeAspect: null, workstreamColours: {}, workstreamShades: {}, archived: {}, restoreNotices: [], regionAttachments: {}, detachedWorkstreams: [], threads: [], messages: [], threadsTruncated: false, threadsAfter: null, inbox: { human: { ids: [], count: 0 }, queen: { ids: [], count: 0 } }, requestCounts: {} };
const req = (id, title, body, at, extra = {}) => ({ id, audience: 'human', state: 'open', title, body, createdAt: at, threadId: 't_' + id, messageId: 'm_' + id, requesterSessionId: 's1', ...extra });
const cells = {
  alpha: { ...base, id: 'alpha', taskId: 't1', enabled: true, rootBeadId: 'r1', queenSessionId: 's1', position: { q: 0, r: 0 }, beadCount: 1, requests: { a: req('a', 'Which database should the importer use?', 'Postgres or SQLite for the local cache?', Date.now() - 600000, { blocking: true }), b: req('b', 'Approve the retry policy', 'Three retries with backoff.', Date.now() - 3600000) } },
  beta: { ...base, id: 'beta', taskId: 't2', enabled: true, rootBeadId: 'r2', queenSessionId: 's1', position: { q: 2, r: 0 }, beadCount: 1, requests: { c: req('c', 'Rename the export flag?', 'It clashes with the new option.', Date.now() - 7200000) } },
};
const waiting = { required: true, rev: 1, state: null };
cells.alpha.threads = [{ id: 't_a', title: 'Importer database' }, { id: 'read', title: 'Release summary' }];
cells.alpha.messages = [{ id: 'm_a', threadId: 't_a', at: Date.now() - 800000, text: 'Choose the cache database.', author: 'session', sessionId: 's1', ack: waiting }, { id: 'm_a2', threadId: 't_a', at: Date.now() - 700000, text: 'The importer is ready for your decision.', author: 'session', sessionId: 's1', ack: waiting }, { id: 'read1', threadId: 'read', at: Date.now() - 86400000, text: 'The release notes are ready.', author: 'session', sessionId: 's1', ack: waiting }];
cells.alpha.inbox = { human: { ids: ['m_a', 'm_a2', 'read1'], count: 3, rev: 1 }, queen: { ids: [], count: 0 } };
const beads = { r1: { id: 'r1', title: 'Importer rewrite', kind: 'goal', status: 'in_progress', evidence: [] }, r2: { id: 'r2', title: 'Export cleanup', kind: 'goal', status: 'in_progress', evidence: [] } };
const hive = { cells, beads, edges: [], launches: [], operations: [], backend: { state: 'ready', snapshotComplete: true, snapshotBeadIds: Object.keys(beads) }, capacity: { limit: 8, used: 0, claimed: 0, reserved: 0, available: 8 }, metaEpoch: 'e', metaVersion: 1 };
const graph = { hive, sessions: [{ sessionId: 's1', name: 'Importer queen' }], tasks: { tasks: [{ id: 't1', name: 'Importer hive' }, { id: 't2', name: 'Export hive' }] } };
const root = document.getElementById('root');
window.t = { client, root, graph, redraw: () => { view.update(root, null, { ...graph }); } };
view.mount(root, null);
view.update(root, null, graph);
</script></body></html>`;


test('All hives shows the global inbox as a side panel that matches the cell page (isolated Chrome, synthetic store)', async (t) => {
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
    const r = await call('Runtime.evaluate', { expression: `(async()=>{const deadline=Date.now()+5000;while(!window.t&&Date.now()<deadline)await new Promise(r=>setTimeout(r,25));${expression}})()`, awaitPromise: true, returnByValue: true });
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
  const wide = await run(`
    await new Promise(r => setTimeout(r, 150));
    const root = document.getElementById('root');
    const box = s => { const e = root.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right }; };
    return { view: root.dataset.view, panels: root.dataset.panels, layout: root.dataset.layout, panel: box('.hive-global-inbox'), map: box('.hive-overview'), divider: box('.hive-divider'), rows: root.querySelectorAll('.hive-global-inbox .hive-inbox-item').length, on: root.querySelector('.hive-inbox-filter.is-on')?.textContent, links: [...root.querySelectorAll('.hive-global-inbox a.hive-topic-btn')].map(a => a.getAttribute('href')), width: root.style.getPropertyValue('--hive-panel-width'), docOverflow: document.documentElement.scrollWidth > innerWidth };
  `);
  assert.equal(wide.view, 'overview');
  assert.equal(wide.panels, 'open');
  assert.equal(wide.layout, 'split');
  assert.ok(wide.panel.x > wide.map.x + wide.map.w - 1, 'inbox sits to the right of the map');
  assert.ok(wide.panel.right <= 1280 + 1 && wide.panel.h > 400, 'inbox runs down the side');
  assert.ok(Math.abs(wide.panel.w - parseFloat(wide.width)) < 2, 'inbox uses the shared panel width');
  assert.ok(wide.divider.w >= 6);
  assert.equal(wide.rows, 4);
  assert.match(wide.on, /Inbox/);
  assert.ok(wide.links.every(l => l.startsWith('#') || l.includes('hive')));
  assert.equal(wide.docOverflow, false);
  const merged = await run(`
    const panel = document.querySelector('.hive-global-inbox');
    return { filters: [...panel.querySelectorAll('.hive-inbox-filter')].map(e => e.textContent), totals: panel.querySelector('.hive-inbox-totals').textContent, rows: [...panel.querySelectorAll('.hive-inbox-item')].map(e => ({ title: e.querySelector('strong').textContent, count: e.querySelector('.hive-unread')?.textContent || null, needs: e.querySelector('.hive-needs-hex')?.textContent })) };
  `);
  assert.equal(merged.filters.length, 2);
  assert.ok(!merged.filters.some(f => f.includes('Needs you')));
  assert.match(merged.totals, /3 needs you.*3 messages/);
  assert.deepEqual(merged.rows.map(r => r.needs || '0'), ['1', '1', '1', '0']);
  assert.deepEqual(merged.rows.map(r => r.count), [null, null, '2', null]);
  const theme = async dark => run(`document.documentElement.style.cssText = ${JSON.stringify(dark ? darkTheme : '')};`);
  await shot('all-hives-desktop-light');
  await theme(true);
  await shot('all-hives-desktop-dark');
  await run(`document.documentElement.style.cssText = '';`);


  const collapsed = await run(`
    const root = document.getElementById('root');
    document.querySelector('[data-focus-key="global-inbox-toggle"]').click();
    await new Promise(r => setTimeout(r, 150));
    return { panels: root.dataset.panels, inbox: Boolean(root.querySelector('.hive-global-inbox')), label: document.querySelector('[data-focus-key="global-inbox-toggle"]').textContent };
  `);
  assert.equal(collapsed.panels, 'closed');
  assert.equal(collapsed.inbox, false);
  assert.match(collapsed.label, /Show inbox/);
  const reopened = await run(`
    document.querySelector('[data-focus-key="global-inbox-toggle"]').click();
    await new Promise(r => setTimeout(r, 150));
    return document.getElementById('root').dataset.panels;
  `);
  assert.equal(reopened, 'open');

  const resized = await run(`
    const root = document.getElementById('root');
    const d = root.querySelector('.hive-divider');
    d.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    await new Promise(r => setTimeout(r, 100));
    return { w: root.querySelector('.hive-global-inbox').getBoundingClientRect().width, now: Number(d.getAttribute('aria-valuenow')) };
  `);
  assert.ok(resized.w > wide.panel.w, 'divider keyboard resize widens the inbox');
  assert.ok(Math.abs(resized.w - resized.now) < 2);

  await viewport(390, 780);
  const narrow = await run(`
    await new Promise(r => setTimeout(r, 200));
    const root = document.getElementById('root');
    const r = s => { const e = root.querySelector(s); const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; };
    return { layout: root.dataset.layout, panel: r('.hive-global-inbox'), map: r('.hive-overview'), divider: getComputedStyle(root.querySelector('.hive-divider')).display, docOverflow: document.documentElement.scrollWidth > innerWidth };
  `);
  assert.equal(narrow.layout, 'small');
  assert.equal(narrow.divider, 'none');
  assert.ok(narrow.panel.y >= narrow.map.y + narrow.map.h - 1, 'inbox stacks below the map on a phone');
  assert.ok(narrow.panel.w <= 390 && narrow.docOverflow === false);
  await shot('all-hives-phone-light');
  await theme(true);
  await shot('all-hives-phone-dark');
  for (const [dark, forced] of [[false, false], [true, false], [false, true], [true, true]]) {
    await theme(dark);
    await call('Emulation.setEmulatedMedia', { features: [{ name: 'forced-colors', value: forced ? 'active' : 'none' }] });
    const badge = await run(`const e = document.querySelector('.hive-inbox-item .hive-needs-hex'); const s = getComputedStyle(e); const r = e.getBoundingClientRect(); return { bg: s.backgroundColor, fg: s.color, clip: s.clipPath, width: r.width, height: r.height, scroll: e.scrollWidth, label: e.getAttribute('aria-label') };`);
    const luminance = color => {
      const channels = color.match(/[\d.]+/g).slice(0, 3).map(Number).map(n => { const s = n / 255; return s <= .04045 ? s / 12.92 : ((s + .055) / 1.055) ** 2.4; });
      return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
    };
    const a = luminance(badge.bg), b = luminance(badge.fg);
    assert.ok((Math.max(a, b) + .05) / (Math.min(a, b) + .05) >= 4.5, `badge contrast: dark=${dark}, forced=${forced}`);
    assert.match(badge.clip, /polygon/);
    assert.ok(badge.width >= 28 && badge.height >= 26 && badge.scroll <= badge.width);
    assert.equal(badge.label, '1 needs you');
  }
  await call('Emulation.setEmulatedMedia', { features: [] });
  const searched = await run(`const e = document.querySelector('.hive-inbox-search-input'); e.value = 'SQLite'; e.dispatchEvent(new Event('input', { bubbles: true })); await new Promise(r => setTimeout(r, 200)); return { rows: document.querySelectorAll('.hive-inbox-item').length, needs: document.querySelector('.hive-inbox-item .hive-needs-hex')?.textContent, count: document.querySelector('.hive-inbox-item .hive-unread')?.textContent, mark: document.querySelector('.hive-search-hit')?.textContent };`);
  assert.deepEqual(searched, { rows: 1, needs: '1', count: '2', mark: 'SQLite' });

});
