import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const cdp = process.env.HIVE_TEST_CDP;
test('intro geometry, pages, focus and responsive layouts', { skip: !cdp && 'CI browser harness only' }, async t => {
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/public/styles.css"><style>
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
      res.setHeader('Content-Type', path.endsWith('.css') ? 'text/css' : path.endsWith('.png') ? 'image/png' : path.endsWith('.svg') ? 'image/svg+xml' : 'text/javascript');
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
  await call('Page.bringToFront');
  for (const [width, height] of [[1440, 1000], [1366, 768], [1280, 720], [1024, 650], [900, 600], [390, 844], [320, 640]]) {
    await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await call('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/` });
    for (let i = 0; i < 100; i++) { if (await run('Boolean(window.promo?.isOpen())')) break; await new Promise(resolve => setTimeout(resolve, 25)); }
    assert.equal(await run('promo.isOpen()'), true);
    for (const theme of ['dark', 'light']) {
      await run(`document.body.className=${JSON.stringify(theme)}`);
      for (const page of ['welcome', 'map', 'people', 'inbox', 'needs-you', 'delivery']) {
        await run(`(()=>{const stop=document.querySelector('[data-page="${page}"]');stop.focus();stop.click()})()`);
        await run('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
        assert.equal(await run(`document.querySelector('.hive-promo-page').dataset.page`), page);
        assert.equal(await run(`document.querySelectorAll('.hive-promo-page h2').length`), 1);
        assert.equal(await run(`Promise.all([...document.querySelectorAll('.hive-promo-page img')].map(async img=>{try{await img.decode();return img.naturalWidth>=600&&img.naturalHeight>=300}catch{return false}})).then(results=>results.length===2&&results.every(Boolean))`), true, 'both real scene captures must load');
        if (width >= 900) {
          assert.equal(await run(`document.querySelector('dialog').hasAttribute('data-rectangle')`), false, 'desktop must show the hexagon at this viewport');
          assert.notEqual(await run(`getComputedStyle(document.querySelector('.hive-promo-shape')).display`), 'none');
        }
        await run(`document.querySelectorAll('.hive-promo-nav button').forEach(button=>{if(!button.textContent.endsWith(' · New'))button.textContent+=' · New'})`);
        const stopChecks = await run(`(() => {
          const nav=document.querySelector('.hive-promo-nav');
          if(getComputedStyle(nav).display==='none')return [];
          const inner=document.querySelector('.hive-promo-inner').getBoundingClientRect();
          return [...nav.querySelectorAll('button')].map(button=>{
            const r=button.getBoundingClientRect();
            const overlap=r.left<inner.right&&r.right>inner.left&&r.top<inner.bottom&&r.bottom>inner.top;
            const hits=[[r.left+3,r.top+r.height/2],[r.right-3,r.top+r.height/2],[r.left+r.width/2,r.top+3],[r.left+r.width/2,r.bottom-3],[r.left+r.width/2,r.top+r.height/2]].every(([x,y])=>button.contains(document.elementFromPoint(x,y)));
            return {label:button.textContent,overlap,hits};
          });
        })()`);
        for (const stop of stopChecks) { assert.equal(stop.overlap, false, stop.label); assert.equal(stop.hits, true, stop.label); }
        assert.equal(await run(`(()=>{const el=document.querySelector('.hive-promo-page');return getComputedStyle(el).overflowY==='auto'})()`), true, 'page content scrolls within the shape');
        const fixed = await run(`(()=>{
          const page=document.querySelector('.hive-promo-page');page.scrollTop=0;
          const rect=el=>el.getBoundingClientRect();
          const inner=rect(document.querySelector('.hive-promo-inner'));
          const selectors=['.hive-promo-caption','.hive-promo-close','.hive-promo-footer'];
          const before=selectors.map(s=>rect(document.querySelector(s)).top);
          page.scrollTop=page.scrollHeight;
          return selectors.map((s,i)=>{const el=document.querySelector(s),r=rect(el);return {s,stable:Math.abs(r.top-before[i])<1,inside:r.top>=inner.top&&r.bottom<=inner.bottom+1&&r.left>=inner.left&&r.right<=inner.right+1,unclipped:el.scrollHeight<=el.clientHeight+1}});
        })()`);
        for(const el of fixed){assert.ok(el.stable,el.s);assert.ok(el.inside,el.s);assert.ok(el.unclipped,el.s);}
        await run(`document.querySelector('.hive-promo-page').scrollTop=0`);
        const bounds = await run(`(()=>{const r=document.querySelector('dialog').getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom}})()`);
        assert.ok(bounds.left >= 0 && bounds.right <= width + 1 && bounds.top >= 0 && bounds.bottom <= height + 1);
        const edges = await run(`(()=>{const svg=document.querySelector('.hive-promo-shape');if(getComputedStyle(svg).display==='none')return [];const p=[...svg.querySelector('polygon').points],m=svg.getScreenCTM();return p.map((v,i)=>{const a=new DOMPoint(v.x,v.y).matrixTransform(m),w=p[(i+1)%6],b=new DOMPoint(w.x,w.y).matrixTransform(m);return Math.hypot(a.x-b.x,a.y-b.y)})})()`);
        if (width >= 900 && await run(`getComputedStyle(document.querySelector('.hive-promo-shape')).display!=='none'`)) assert.ok(Math.max(...edges) - Math.min(...edges) < .01);
        if (width < 900) assert.equal(await run(`getComputedStyle(document.querySelector('.hive-promo-jump')).display`), 'flex');
        if (process.env.HIVE_SCREENSHOT_DIR) {
          const shot = await call('Page.captureScreenshot', { format: 'png' });
          await writeFile(join(process.env.HIVE_SCREENSHOT_DIR, `intro-${width}-${theme}-${page}.png`), Buffer.from(shot.data, 'base64'));
        }
      }
    }
    await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    assert.equal(await run(`getComputedStyle(document.querySelector('.hive-promo-page h2')).animationName`), 'none');
    await run(`document.querySelector('.hive-promo-close').focus()`);
    await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    assert.equal(await run(`promo.isOpen()`), false);
    assert.equal(await run(`document.activeElement.id`), 'opener');
    assert.equal(await run(`JSON.parse(values.get('promoState')).dismissedContentVersion`), 1);
  }
  await fetch(`http://127.0.0.1:${cdp}/json/close/${target.id}`);
});
