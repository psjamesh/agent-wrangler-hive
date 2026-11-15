import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const cdp = process.env.HIVE_TEST_CDP;
test('intro geometry, pages, focus and responsive layouts', { skip: !cdp && 'CI browser harness only' }, async t => {
  const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/public/styles.css"><style>
  *{box-sizing:border-box}body{margin:0;--bg:#181b20;--surface:#22262d;--surface-2:#2c323b;--fg:#e4e7ec;--fg-muted:#a0aaba;--border:#525e70;font-family:system-ui}body.light{--bg:#f4f5f7;--surface:#fff;--surface-2:#e9ecf0;--fg:#202631;--fg-muted:#555f70;--border:#b7bfcc}
  </style></head><body><main class="hive-root" style="height:100dvh"><button id="opener">About Hive</button></main><script type="module">
  import {createPromo} from '/public/promo-dialog.js';
  const values=new Map();window.promo=createPromo({root:()=>document.querySelector('main'),storage:{get:k=>values.get(k),set:(k,v)=>values.set(k,v),remove:k=>values.delete(k)},buildVersion:()=>null});window.values=values;
  window.openIntro=()=>promo.open(document.querySelector('#opener'));openIntro();</script></body></html>`;
  const server = http.createServer(async (req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (path === '/') { res.setHeader('Content-Type', 'text/html'); res.end(html); return; }
    if (!/^\/public\/(?:promo\/)?[\w.-]+$/.test(path)) { res.writeHead(404).end(); return; }
    try {
      res.setHeader('Content-Type', path.endsWith('.css') ? 'text/css' : path.endsWith('.svg') ? 'image/svg+xml' : 'text/javascript');
      res.end(await readFile(new URL(`..${path}`, import.meta.url)));
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  assert.notEqual(server.address().port, 7777);
  const target = await (await fetch(`http://127.0.0.1:${cdp}/json/new?about:blank`, { method: 'PUT' })).json();
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }));
  t.after(() => socket.close());
  let id = 0; const pending = new Map();
  socket.addEventListener('message', event => { const m = JSON.parse(event.data), p = pending.get(m.id); if (p) { pending.delete(m.id); m.error ? p.reject(m.error) : p.resolve(m.result); } });
  const call = (method, params = {}) => new Promise((resolve, reject) => { const key = ++id; pending.set(key, { resolve, reject }); socket.send(JSON.stringify({ id: key, method, params })); });
  const run = async expression => { const out = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); assert.equal(out.exceptionDetails, undefined, JSON.stringify(out.exceptionDetails)); return out.result.value; };
  for (const [width, height] of [[1440, 1000], [1200, 820], [390, 844], [320, 640]]) {
    await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await call('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/` });
    for (let i = 0; i < 100; i++) { if (await run('Boolean(window.promo?.isOpen())')) break; await new Promise(resolve => setTimeout(resolve, 25)); }
    assert.equal(await run('promo.isOpen()'), true);
    for (const theme of ['dark', 'light']) {
      await run(`document.body.className=${JSON.stringify(theme)}`);
      for (const page of ['welcome', 'map', 'people', 'inbox', 'needs-you', 'delivery']) {
        await run(`document.querySelector('[data-page="${page}"]').click()`);
        await run('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
        assert.equal(await run(`document.querySelector('.hive-promo-page').dataset.page`), page);
        assert.equal(await run(`document.querySelectorAll('.hive-promo-page h2').length`), 1);
        const bounds = await run(`(()=>{const r=document.querySelector('dialog').getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom}})()`);
        assert.ok(bounds.left >= 0 && bounds.right <= width + 1 && bounds.top >= 0 && bounds.bottom <= height + 1);
        const edges = await run(`(()=>{const svg=document.querySelector('.hive-promo-shape');if(getComputedStyle(svg).display==='none')return [];const p=[...svg.querySelector('polygon').points],m=svg.getScreenCTM();return p.map((v,i)=>{const a=new DOMPoint(v.x,v.y).matrixTransform(m),w=p[(i+1)%6],b=new DOMPoint(w.x,w.y).matrixTransform(m);return Math.hypot(a.x-b.x,a.y-b.y)})})()`);
        if (width >= 1200 && await run(`getComputedStyle(document.querySelector('.hive-promo-shape')).display!=='none'`)) assert.ok(Math.max(...edges) - Math.min(...edges) < .01);
        if (width < 1200) assert.equal(await run(`getComputedStyle(document.querySelector('.hive-promo-jump')).display`), 'flex');
        if (process.env.HIVE_SCREENSHOT_DIR) {
          const shot = await call('Page.captureScreenshot', { format: 'png' });
          await writeFile(join(process.env.HIVE_SCREENSHOT_DIR, `intro-${width}-${theme}-${page}.png`), Buffer.from(shot.data, 'base64'));
        }
      }
    }
    await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    assert.equal(await run(`getComputedStyle(document.querySelector('.hive-promo-page h2')).animationName`), 'none');
    await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
    assert.equal(await run(`promo.isOpen()`), false);
    assert.equal(await run(`document.activeElement.id`), 'opener');
    assert.equal(await run(`JSON.parse(values.get('promoState')).dismissedContentVersion`), 1);
  }
  await fetch(`http://127.0.0.1:${cdp}/json/close/${target.id}`);
});
