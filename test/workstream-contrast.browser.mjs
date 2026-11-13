import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';

const html = `<!doctype html><html><head><link rel="stylesheet" href="/public/styles.css"><style>*{transition:none!important}</style></head><body><svg class="hive-root"><g id="tile" class="hive-hex hive-bead has-ws"><rect class="hive-hex-shape" width="100" height="100"/><text class="hive-hex-text">Heading</text><text class="hive-hex-sub">In parent</text></g></svg><script type="module">
import {workstreamClasses} from '/public/workstream-colours.js';
window.measure=dark=>{
 document.documentElement.style.cssText=dark?'--surface:#202329;--fg:#eceef3;--fg-muted:#a7aebb;--blue:#7aa2f7;--green:#66bc88;--purple:#bb9af7;--cyan:#73c6ce':'--surface:#ffffff;--fg:#202631;--fg-muted:#555f70;--blue:#3467bd;--green:#277c48;--purple:#7950b5;--cyan:#1a7e8c';
 const ctx=document.createElement('canvas').getContext('2d');
 const luminance=color=>{ctx.clearRect(0,0,1,1);ctx.fillStyle=color;ctx.fillRect(0,0,1,1);const v=Array.from(ctx.getImageData(0,0,1,1).data).slice(0,3).map(x=>{x/=255;return x<=0.04045?x/12.92:((x+0.055)/1.055)**2.4});return v[0]*0.2126+v[1]*0.7152+v[2]*0.0722};
 const samples=[];
 for(let palette=0;palette<6;palette++)for(let shade=0;shade<5;shade++){
  const tile=document.querySelector('#tile');tile.setAttribute('class','hive-hex hive-bead has-ws '+workstreamClasses('child',{parent:palette},{parent:null,child:'parent'},{child:shade}));
  const background=luminance(getComputedStyle(tile.querySelector('.hive-hex-shape')).fill);
  for(const selector of ['.hive-hex-text','.hive-hex-sub']){
   const foreground=luminance(getComputedStyle(tile.querySelector(selector)).fill);
   samples.push({palette,shade,selector,fill:getComputedStyle(tile.querySelector(selector)).fill,bg:getComputedStyle(tile.querySelector('.hive-hex-shape')).fill,ratio:(Math.max(background,foreground)+0.05)/(Math.min(background,foreground)+0.05)});
  }
 }
 return samples;
};
</script></body></html>`;

test('all nested heading and parent labels exceed 4.5:1 across both themes and every palette/shade', async t => {
  const port = Number(process.env.HIVE_TEST_CDP);
  assert.ok(Number.isInteger(port) && port > 0 && port !== 7777, 'Set HIVE_TEST_CDP to an explicitly allocated isolated headless Chrome port');
  const server = http.createServer(async (req, res) => {
    if (req.url === '/') { res.setHeader('Content-Type', 'text/html'); res.end(html); return; }
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
  const result = await call('Runtime.evaluate', { expression: `new Promise((resolve,reject)=>{const deadline=Date.now()+5000;const check=()=>{if(window.measure)resolve([window.measure(false),window.measure(true)]);else if(Date.now()>deadline)reject(Error('Preview did not load'));else setTimeout(check,25)};check()})`, awaitPromise: true, returnByValue: true });
  assert.equal(result.exceptionDetails, undefined);
  for (const [index, samples] of result.result.value.entries()) {
    assert.equal(samples.length, 60);
    for (const sample of samples) assert.ok(sample.ratio >= 4.5, `${index ? 'dark' : 'light'} ${JSON.stringify(sample)}`);
    t.diagnostic(`${index ? 'dark' : 'light'} minimum contrast ${Math.min(...samples.map(s => s.ratio)).toFixed(2)}:1`);
  }
});
