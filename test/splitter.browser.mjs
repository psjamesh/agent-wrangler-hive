import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const chrome = process.env.HIVE_TEST_CHROME;

const page = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/public/styles.css"><style>:root{--bg:#fff;--surface:#fff;--border:#ccc;--fg:#111}body{margin:0}*,*::before,*::after{transition:none!important}.hive-root{width:1000px;height:500px}</style></head><body><div class="hive-root" id="root" data-view="cell" data-panels="open"></div><script type="module">
import { installPanelSplit } from '/public/panel-split.js';
const root = document.getElementById('root');
root.innerHTML = '<div class="hive-cellhead" style="grid-area:head">head</div><div class="hive-stage" style="grid-area:map">map</div><div class="hive-tabs" style="grid-area:tabs">tabs</div><div class="hive-dock" style="grid-area:rail">rail</div><div class="hive-divider" role="separator" tabindex="0"></div>';
const store = new Map();
const divider = root.querySelector('.hive-divider');
installPanelSplit(root, divider, { getItem: k => store.get(k), setItem: (k, v) => store.set(k, v) });
const rect = s => root.querySelector(s).getBoundingClientRect();
const line = () => { const c = getComputedStyle(divider, '::before'); return { width: c.width, background: c.backgroundColor }; };
window.t = {
  snapshot: () => ({
    gap: rect('.hive-tabs').left - rect('.hive-stage').right,
    dividerWidth: rect('.hive-divider').width,
    hit: getComputedStyle(divider, '::after').width,
    panelWidth: rect('.hive-tabs').width,
    line: line(),
    dragging: divider.hasAttribute('data-dragging'),
    focused: document.activeElement === divider,
    focusVisible: divider.matches(':focus-visible'),
    captured: divider.hasPointerCapture(1),
    hovered: divider.matches(':hover'),
    bounds: (r => ({ x: r.left, y: r.top, width: r.width, height: r.height }))(divider.getBoundingClientRect())
  })
};
</script></body></html>`;

test('splitter is a 12px hairline; real keyboard and mouse input resize it, and a drag released outside the hit area still ends cleanly', { skip: chrome ? false : 'Set HIVE_TEST_CHROME to a Chrome binary' }, async (t) => {
  const server = http.createServer(async (req, res) => {
    if (req.url === '/') { res.setHeader('Content-Type', 'text/html'); res.end(page); return; }
    if (!/^\/public\/[\w.-]+$/.test(req.url)) { res.writeHead(404).end(); return; }
    try {
      res.setHeader('Content-Type', req.url.endsWith('.css') ? 'text/css' : 'text/javascript');
      res.end(await readFile(new URL(`..${req.url}`, import.meta.url)));
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const profile = await mkdtemp(join(tmpdir(), 'hive-splitter-'));
  const child = spawn(chrome, ['--headless=new', `--user-data-dir=${profile}`, '--disable-gpu', '--remote-debugging-port=0', '--window-size=1000,600', 'about:blank'], { stdio: 'ignore' });
  t.after(async () => {
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill();
    await exited;
    server.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  let port;
  for (let i = 0; i < 200 && !port; i++) {
    try { port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); } catch { await new Promise(r => setTimeout(r, 100)); }
  }
  assert.ok(Number.isInteger(port) && port > 0 && port !== 7777, 'isolated Chrome exposed a debugging port');
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?http://127.0.0.1:${server.address().port}/`, { method: 'PUT' })).json();
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
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const snapshot = async () => {
    for (let attempt = 0; ; attempt++) {
      try {
        const r = await call('Runtime.evaluate', { expression: `(async()=>{const d=Date.now()+20000;while(!window.t&&Date.now()<d)await new Promise(r=>setTimeout(r,25));return window.t.snapshot()})()`, awaitPromise: true, returnByValue: true });
        assert.equal(r.exceptionDetails, undefined, JSON.stringify(r.exceptionDetails));
        return r.result.value;
      } catch (error) {
        if (attempt > 40 || !/context was destroyed|Cannot find context/.test(error?.message ?? '')) throw error;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
  };
  const mouse = (type, x, y, extra = {}) => call('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, ...extra });
  const key = async (name, code, vk) => {
    await call('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: name, code, windowsVirtualKeyCode: vk });
    await call('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code, windowsVirtualKeyCode: vk });
  };

  const rest = await snapshot();
  assert.equal(rest.gap, 12);
  assert.equal(rest.dividerWidth, 12);
  assert.equal(rest.line.width, '1px');
  assert.equal(rest.hit, '20px');

  await key('Tab', 'Tab', 9);
  const focused = await snapshot();
  assert.equal(focused.focused, true);
  assert.equal(focused.focusVisible, true);
  assert.equal(focused.line.width, '3px');
  assert.notEqual(focused.line.background, rest.line.background);

  await key('ArrowLeft', 'ArrowLeft', 37);
  assert.equal((await snapshot()).panelWidth, focused.panelWidth + 20);
  await key('ArrowRight', 'ArrowRight', 39);
  await call('Runtime.evaluate', { expression: 'document.activeElement.blur()' });
  const blurred = await snapshot();
  assert.equal(blurred.line.width, '1px');
  assert.equal(blurred.panelWidth, rest.panelWidth);

  const { x, y, width, height } = blurred.bounds;
  const cx = x + width / 2, cy = y + height / 2;
  await mouse('mouseMoved', cx, cy, { buttons: 0 });
  assert.equal((await snapshot()).line.width, '3px');
  await mouse('mousePressed', cx, cy);
  const during = await snapshot();
  assert.equal(during.dragging, true);
  assert.equal(during.captured, true);
  await mouse('mouseMoved', cx - 60, cy);
  await mouse('mouseMoved', cx - 150, cy + 80);
  const outside = await snapshot();
  assert.equal(outside.dragging, true);
  assert.equal(outside.panelWidth, rest.panelWidth + 150);
  await mouse('mouseReleased', cx - 150, cy + 80);
  const released = await snapshot();
  assert.equal(released.dragging, false);
  assert.equal(released.captured, false);
  assert.equal(released.panelWidth, rest.panelWidth + 150);
  await mouse('mouseMoved', cx - 300, cy, { buttons: 0 });
  assert.equal((await snapshot()).panelWidth, rest.panelWidth + 150);
});
