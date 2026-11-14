import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile, writeFile, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { spawn, execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const chrome = process.env.HIVE_TEST_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const output = resolve(process.env.HIVE_SHOT_DIR || '/private/tmp/hive-kgez-screenshots');
const baseline = execFileSync('git', ['show', '90610a9:public/styles.css'], { encoding: 'utf8' });
const page = await readFile(new URL('./fixtures/ui-polish.html', import.meta.url), 'utf8');
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/') {
    res.setHeader('Content-Type', 'text/html');
    res.end(url.searchParams.get('phase') === 'before' ? page.replace('/public/styles.css', '/baseline.css') : page);
    return;
  }
  if (url.pathname === '/baseline.css') { res.setHeader('Content-Type', 'text/css'); res.end(baseline); return; }
  if (!/^\/public\/[\w.-]+$/.test(url.pathname)) { res.writeHead(404).end(); return; }
  try {
    res.setHeader('Content-Type', url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript');
    res.end(await readFile(new URL(`..${url.pathname}`, import.meta.url)));
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
assert.notEqual(server.address().port, 7777);
const profile = await mkdtemp(join(tmpdir(), 'hive-kgez-chrome-'));
const child = spawn(chrome, ['--headless=new', `--user-data-dir=${profile}`, '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
let logs = '';
child.stderr.on('data', data => { logs += data; });
let launchError;
child.on('error', error => { launchError = error; });
const exited = new Promise(resolve => { child.once('exit', resolve); child.once('error', resolve); });
let socket;
try {
  let port;
  for (let i = 0; i < 100; i++) {
    try { port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); break; } catch { }
    if (launchError || child.exitCode !== null || child.signalCode !== null) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(port && port !== 7777, `Isolated Chrome did not launch (exit ${child.exitCode}, signal ${child.signalCode}): ${launchError || logs}`);
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }));
  let id = 0;
  const pending = new Map();
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    const promise = pending.get(message.id);
    if (!promise) return;
    pending.delete(message.id);
    if (message.error) promise.reject(message.error); else promise.resolve(message.result);
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const key = ++id; pending.set(key, { resolve, reject }); socket.send(JSON.stringify({ id: key, method, params }));
  });
  const run = async expression => {
    const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await mkdir(output, { recursive: true });
  const measurements = [];
  for (const phase of ['before', 'after']) for (const theme of ['light', 'dark']) for (const view of ['overview', 'cell']) {
    await call('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/?phase=${phase}&theme=${theme}&view=${view}` });
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { ready = await run(`Boolean(window.t && document.querySelector('.hive-ghost') && document.querySelector('.hive-divider'))`); } catch { }
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(ready, `${phase} ${theme} ${view} rendered`);
    await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 0, y: 0 });
    const measure = await run(`(() => {
      const root = document.getElementById('root'), divider = root.querySelector('.hive-divider');
      const line = getComputedStyle(divider, '::before'), ghost = getComputedStyle(root.querySelector('.hive-ghost'));
      const map = root.querySelector('.hive-stage').getBoundingClientRect(), dock = root.querySelector('.hive-dock').getBoundingClientRect();
      const box = divider.getBoundingClientRect();
      return { view: root.dataset.view, gap: dock.left - map.right, width: line.width, stroke: ghost.stroke, opacity: ghost.strokeOpacity, dash: ghost.strokeDasharray, fill: ghost.fill, x: box.x + box.width / 2, y: box.y + box.height / 2 };
    })()`);
    assert.equal(measure.view, view);
    if (phase === 'after') { assert.equal(measure.gap, 12); assert.equal(measure.width, '0px'); }
    measurements.push({ phase, theme, view, ...measure });
    const shot = async suffix => {
      const { data } = await call('Page.captureScreenshot', { format: 'png' });
      await writeFile(join(output, `${phase}-${theme}-${view}${suffix}.png`), Buffer.from(data, 'base64'));
    };
    await shot('');
    if (phase === 'after') {
      await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: measure.x, y: measure.y });
      assert.equal(await run(`getComputedStyle(document.querySelector('.hive-divider'),'::before').width`), '3px');
      await shot('-hover');
    }
  }
  for (const theme of ['light', 'dark']) {
    const pair = measurements.filter(m => m.phase === 'after' && m.theme === theme);
    for (const property of ['stroke', 'opacity', 'dash', 'fill']) assert.equal(pair[0][property], pair[1][property], `${theme} ghost ${property}`);
  }
  await writeFile(join(output, 'measurements.json'), JSON.stringify(measurements, null, 2) + '\n');
  console.log(`Screenshots and measurements: ${output}`);
} finally {
  socket?.close();
  if (child.exitCode === null && child.signalCode === null) child.kill();
  await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 3000))]);
  await new Promise(resolve => server.close(resolve));
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
