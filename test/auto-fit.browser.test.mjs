import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const browserScript = `(async () => {
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
  await wait(600);
  const check = (value, message) => { if (!value) throw Error(message); };
  const canvas = () => document.querySelector('.hive-canvas');
  const toggle = () => [...canvas().querySelectorAll('button')].find(b => b.textContent.startsWith('Auto-fit'));
  const view = () => canvas().hiveCaptureView();
  check(toggle()?.getAttribute('aria-pressed') === 'true', 'default on');
  canvas().dispatchEvent(new WheelEvent('wheel', { deltaX: 80, cancelable: true }));
  check(toggle().textContent === 'Auto-fit paused', 'manual pan pauses');
  const paused = JSON.stringify(view());
  window.t.graph.hive.beads.extra = { id: 'extra', parentId: 'r1', title: 'Extra work', status: 'open', kind: 'work' };
  window.t.redraw();
  await wait(500);
  check(JSON.stringify(view()) === paused, 'board update preserves paused view');
  toggle().click();
  await wait(600);
  check(view().auto && toggle().textContent === 'Auto-fit', 'toggle resumes');
  const before = view();
  const stage = document.querySelector('.hive-stage');
  const width = canvas().clientWidth;
  stage.style.flex = 'none';
  stage.style.width = '65%';
  for (let i = 0; i < 40 && view().tx === before.tx && view().k === before.k; i++) await wait(50);
  check(canvas().clientWidth !== width, 'stage resize changes canvas width');
  check(view().tx !== before.tx || view().k !== before.k, 'resize refits');
  toggle().click();
  check(toggle().getAttribute('aria-pressed') === 'false', 'toggle off');
  return 'passed';
} catch (error) { return error.message; }
})()`;

for (const view of ['overview', 'cell']) {
  test(`isolated Chrome verifies auto-fit controls in ${view}`, { skip: process.env.HIVE_AUTO_FIT_BROWSER !== '1' }, async t => {
    const fixture = await readFile(new URL('./fixtures/ui-polish.html', import.meta.url), 'utf8');
    const server = http.createServer(async (req, res) => {
      const path = new URL(req.url, 'http://localhost').pathname;
      if (path === '/') { res.setHeader('Content-Type', 'text/html'); res.end(fixture); return; }
      if (!/^\/public\/[\w.-]+$/.test(path)) { res.writeHead(404).end(); return; }
      try {
        res.setHeader('Content-Type', path.endsWith('.css') ? 'text/css' : 'text/javascript');
        res.end(await readFile(new URL(`..${path}`, import.meta.url)));
      } catch { res.writeHead(404).end(); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => server.close());
    assert.notEqual(server.address().port, 7777);
    const profile = await mkdtemp(join(tmpdir(), 'hive-kyl3-chrome-'));
    const child = spawn(process.env.HIVE_TEST_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
      '--headless=new', `--user-data-dir=${profile}`, '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--remote-debugging-port=0', 'about:blank',
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    let errors = '', launchError, socket;
    child.stderr.on('data', data => { errors += data; });
    child.on('error', error => { launchError = error; });
    const exited = new Promise(resolve => { child.once('exit', resolve); child.once('error', resolve); });
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    try {
      let port;
      for (let i = 0; i < 100; i++) {
        try { port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); break; } catch { }
        if (launchError || child.exitCode !== null || child.signalCode !== null) break;
        await wait(100);
      }
      if (!port) {
        t.skip(`Browser checks not run: isolated Chrome could not start (exit ${child.exitCode}, signal ${child.signalCode}). ${launchError || errors.slice(-600)}. Run HIVE_AUTO_FIT_BROWSER=1 npm test`);
        return;
      }
      assert.notEqual(port, 7777);
      const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT', signal: AbortSignal.timeout(5000) })).json();
      socket = new WebSocket(target.webSocketDebuggerUrl);
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(Error('CDP connection timed out')), 5000);
        socket.addEventListener('open', () => { clearTimeout(timeout); resolve(); }, { once: true });
        socket.addEventListener('error', () => { clearTimeout(timeout); reject(Error('CDP connection failed')); }, { once: true });
      });
      let id = 0;
      const pending = new Map();
      socket.addEventListener('message', event => {
        const message = JSON.parse(event.data);
        const request = pending.get(message.id);
        if (!request) return;
        pending.delete(message.id);
        clearTimeout(request.timeout);
        if (message.error) request.reject(Error(JSON.stringify(message.error)));
        else request.resolve(message.result);
      });
      const call = (method, params = {}) => new Promise((resolve, reject) => {
        const key = ++id;
        const timeout = setTimeout(() => { pending.delete(key); reject(Error(`${method} timed out`)); }, 10000);
        pending.set(key, { resolve, reject, timeout });
        socket.send(JSON.stringify({ id: key, method, params }));
      });
      const run = async expression => {
        const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
        assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails));
        return result.result.value;
      };
      await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
      await call('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/?view=${view}` });
      let ready = false;
      for (let i = 0; i < 100; i++) {
        try { ready = await run("Boolean(window.t && document.querySelector('.hive-canvas'))"); } catch { }
        if (ready) break;
        await wait(50);
      }
      assert.ok(ready, `${view} rendered`);
      assert.equal(await run(browserScript), 'passed', `${view} auto-fit checks`);
    } finally {
      socket?.close();
      if (child.exitCode === null && child.signalCode === null && !launchError) child.kill();
      await exited;
      await rm(profile, { recursive: true, force: true });
    }
  });
}
