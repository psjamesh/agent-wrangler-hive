import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const browserScript = `<script type="module">
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
  canvas().style.width = '65%';
  await wait(500);
  check(view().tx !== before.tx || view().k !== before.k, 'resize refits');
  toggle().click();
  check(toggle().getAttribute('aria-pressed') === 'false', 'toggle off');
  document.body.dataset.autoFitTest = 'passed';
} catch (error) { document.body.dataset.autoFitTest = error.message; }
</script>`;

test('isolated Chrome verifies auto-fit controls in overview and cell views', { skip: process.env.HIVE_AUTO_FIT_BROWSER !== '1' }, async t => {
  const fixture = await readFile(new URL('./fixtures/ui-polish.html', import.meta.url), 'utf8');
  const server = http.createServer(async (req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (path === '/') { res.setHeader('Content-Type', 'text/html'); res.end(fixture + browserScript); return; }
    if (!/^\/public\/[\w.-]+$/.test(path)) { res.writeHead(404).end(); return; }
    try {
      res.setHeader('Content-Type', path.endsWith('.css') ? 'text/css' : 'text/javascript');
      res.end(await readFile(new URL(`..${path}`, import.meta.url)));
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  assert.notEqual(server.address().port, 7777);
  for (const view of ['overview', 'cell']) {
    const profile = await mkdtemp(join(tmpdir(), 'hive-kyl3-chrome-'));
    const child = spawn(process.env.HIVE_TEST_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
      '--headless=new', `--user-data-dir=${profile}`, '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--dump-dom', '--virtual-time-budget=5000', `http://127.0.0.1:${server.address().port}/?view=${view}`,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', errors = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { errors += data; });
    const timeout = setTimeout(() => child.kill(), 15000);
    const code = await new Promise(resolve => { child.once('exit', resolve); child.once('error', error => { errors += error.message; resolve(null); }); });
    clearTimeout(timeout);
    await rm(profile, { recursive: true, force: true });
    if (code !== 0) { t.skip(`Browser checks not run: isolated Chrome could not start (exit ${code}). ${errors.slice(-600)}. Run HIVE_AUTO_FIT_BROWSER=1 npm test`); return; }
    assert.match(output, /data-auto-fit-test="passed"/, `${view}: ${output.slice(-1500)}`);
  }
});
