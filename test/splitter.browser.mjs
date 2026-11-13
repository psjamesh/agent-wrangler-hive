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
installPanelSplit(root, root.querySelector('.hive-divider'), { getItem: k => store.get(k), setItem: (k, v) => store.set(k, v) });
const rect = s => root.querySelector(s).getBoundingClientRect();
const line = () => { const c = getComputedStyle(root.querySelector('.hive-divider'), '::before'); return { width: c.width, background: c.backgroundColor }; };
const out = {};
const divider = root.querySelector('.hive-divider');
out.gap = rect('.hive-tabs').left - rect('.hive-stage').right;
out.dividerWidth = rect('.hive-divider').width;
out.rest = line();
out.hit = getComputedStyle(divider, '::after').width;
const before = rect('.hive-tabs').width;
divider.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }));
out.keyDelta = rect('.hive-tabs').width - before;
divider.dataset.dragging = '';
out.active = line();
delete divider.dataset.dragging;
divider.focus();
out.focused = divider.matches(':focus-visible') ? line() : null;
const el = document.createElement('pre'); el.id = 'result'; el.textContent = JSON.stringify(out); document.body.append(el);
</script></body></html>`;

test('splitter is a 12px hairline that thickens when dragged, and keyboard resize still works', { skip: chrome ? false : 'Set HIVE_TEST_CHROME to a headless-capable Chrome binary' }, async (t) => {
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
  t.after(async () => { server.close(); await rm(profile, { recursive: true, force: true }); });
  const dom = await new Promise((resolve, reject) => {
    let out = '';
    const child = spawn(chrome, ['--headless=new', `--user-data-dir=${profile}`, '--disable-gpu', '--window-size=1000,500', '--virtual-time-budget=3000', '--dump-dom', `http://127.0.0.1:${server.address().port}/`], { stdio: ['ignore', 'pipe', 'ignore'] });
    child.stdout.on('data', d => { out += d; });
    child.on('error', reject);
    child.on('exit', () => resolve(out));
  });
  const result = JSON.parse(dom.match(/<pre id="result">(.*?)<\/pre>/s)[1].replace(/&quot;/g, '"'));
  assert.equal(result.gap, 12);
  assert.equal(result.dividerWidth, 12);
  assert.equal(result.rest.width, '1px');
  assert.equal(result.hit, '20px');
  assert.equal(result.active.width, '3px');
  assert.notEqual(result.active.background, result.rest.background);
  assert.equal(result.keyDelta, 20);
});
