import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const page = `<!doctype html><html><head><link rel="stylesheet" href="/public/styles.css"><style>
:root{--surface:#fff;--fg:#222;--fg-muted:#666;--border:#bbb;--red:#c33;--bar-on:#fff}body{margin:0}.hive-root{width:100vw;height:100vh}
</style></head><body><div class="hive-root" id="root"></div><script type="module">
import client from '/public/client.js';
let view;
const store=new Map();
const cell={id:'cell',taskId:'task',enabled:true,rootBeadId:'root',queenSessionId:'queen',bindings:[],requests:{},pullRequests:[],launches:[],threads:[],messages:[],beadLayout:{},workstreamColours:{},archived:{},restoreNotices:[],inbox:{human:{ids:[],count:0},queen:{ids:[],count:0}}};
const pr={url:'https://github.com/example/repo/pull/7',cellId:'cell',number:7,title:'Ship change',beadIds:['work'],state:'OPEN',headSha:'a'.repeat(40),checks:'green',isDraft:false,stateCheckedAt:Date.now(),humanAttention:{state:'ready',headSha:'a'.repeat(40),reason:'Please review and merge'}};
const hive={cells:{cell},beads:{root:{id:'root',title:'Demo',kind:'goal',status:'open'},work:{id:'work',parentId:'root',title:'Ship change',kind:'work',status:'open'}},edges:[],launches:[],operations:[],metaEpoch:'e',metaVersion:1,backend:{state:'ready',snapshotComplete:true,snapshotBeadIds:['root','work']}};
const graph={hive,sessions:[{sessionId:'queen',name:'Queen',status:'idle'}],tasks:{tasks:[{id:'task',name:'Demo hive'}]}};
client.register({api:{state:()=>graph,settings:()=>({beeLevel:0,showBees:false}),storage:{get:k=>store.get(k),set:(k,v)=>store.set(k,v),remove:k=>store.delete(k)}},register(kind,v){if(kind==='view')view=v}});
const root=document.getElementById('root');
window.t={crowded:()=>{Object.assign(hive.beads.work,{title:'Review pull request and approve merge policy',reviewState:'in_review',waitingFor:'External report'});t.state(true,true)},state:(prs,input)=>{cell.pullRequests=prs?[{...pr,stateCheckedAt:Date.now()}]:[];cell.requests=input?{input:{id:'input',audience:'human',state:'open',beadId:'work',title:'Choose policy'}}:{};hive.metaVersion++;view.update(root,null,{...graph});}};
view.mount(root,null);t.state(true,false);
</script></body></html>`;

test('PR review badges and Needs You remain distinct in cell and overview maps', { skip: !process.env.HIVE_TEST_CHROME || !process.env.HIVE_TEST_CDP ? 'CI-only isolated Chrome' : false }, async t => {
  const port = Number(process.env.HIVE_TEST_CDP);
  assert.ok(port > 0 && port !== 7777);
  const server = http.createServer(async (req, res) => {
    if (req.url === '/') { res.setHeader('Content-Type', 'text/html'); res.end(page); return; }
    if (!/^\/public\/[\w.-]+$/.test(req.url)) { res.writeHead(404).end(); return; }
    try { res.setHeader('Content-Type', req.url.endsWith('.css') ? 'text/css' : 'text/javascript'); res.end(await readFile(new URL(`..${req.url}`, import.meta.url))); }
    catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
  t.after(() => fetch(`http://127.0.0.1:${port}/json/close/${target.id}`));
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }));
  t.after(() => socket.close());
  let seq = 0;
  const pending = new Map();
  const exceptions = [];
  socket.addEventListener('message', event => { const m = JSON.parse(event.data), p = pending.get(m.id); if (m.method === 'Runtime.exceptionThrown') exceptions.push(m.params.exceptionDetails); if (!p) return; pending.delete(m.id); if (m.error) p.reject(m.error); else p.resolve(m.result); });
  const call = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
  const run = async expression => { const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); assert.equal(r.exceptionDetails, undefined, JSON.stringify(r.exceptionDetails)); return r.result.value; };
  await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await call('Page.enable');
  await call('Runtime.enable');
  const loaded = new Promise(resolve => socket.addEventListener('message', function onLoad(event) { if (JSON.parse(event.data).method !== 'Page.loadEventFired') return; socket.removeEventListener('message', onLoad); resolve(); }));
  await call('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/` });
  await loaded;
  await run(`(async()=>{for(let i=0;i<100&&!window.t;i++)await new Promise(r=>setTimeout(r,25));})()`);
  assert.equal(await run(`!!window.t`), true, `Fixture did not load: ${JSON.stringify(exceptions)}`);
  const overview = () => run(`[...document.querySelector('[data-tile-id="cell"]').querySelectorAll('[data-counter]')].map(n=>n.dataset.counter)`);
  assert.deepEqual(await overview(), ['pr']);
  await run(`t.state(true,true)`);
  assert.deepEqual(await overview(), ['needs', 'pr']);
  assert.match(await run(`document.querySelector('[data-counter="pr"] title').textContent`), /PR needs review or merge/);
  assert.equal(await run(`getComputedStyle(document.querySelector('[data-counter="pr"] .hive-pm-bg')).fill`), 'rgb(204, 51, 51)');
  await run(`document.querySelector('[data-tile-id="cell"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}))`);
  assert.deepEqual(exceptions, [], 'Opening the cell raised an exception');
  const marks = () => run(`[...document.querySelector('[data-tile-id="work"]').querySelectorAll('.hive-pm')].map(n=>n.getAttribute('class'))`);
  assert.deepEqual(await marks(), ['hive-pm hive-pm-person', 'hive-pm hive-pm-pr']);
  assert.match(await run(`document.querySelector('[data-tile-id="work"]').getAttribute('aria-label')`), /PR needs review or merge/);
  assert.match(await run(`document.querySelector('[data-tile-id="work"] .hive-pm-pr title').textContent`), /PR needs review or merge/);
  assert.equal(await run(`getComputedStyle(document.querySelector('[data-tile-id="work"] .hive-pm-pr .hive-pm-bg')).fill`), 'rgb(204, 51, 51)');
  assert.equal(await run(`getComputedStyle(document.querySelector('[data-tile-id="work"] .hive-pm-pr path')).fill`), 'rgb(255, 255, 255)');
  await run(`document.querySelector('[data-tile-id="work"] .hive-pm-pr').dispatchEvent(new MouseEvent('click',{bubbles:true}))`);
  await run(`t.state(true,true)`);
  assert.equal(await run(`document.querySelectorAll('dialog[open] .hive-pr').length`), 1);
  assert.equal(await run(`document.querySelectorAll('dialog[open] [data-wait-id="request:input"]').length`), 0);
  await run(`t.state(false,true)`);
  assert.equal(await run(`document.querySelectorAll('dialog[open]').length`), 0);
  assert.deepEqual(await marks(), ['hive-pm hive-pm-person']);
  await run(`t.state(true,false)`);
  assert.deepEqual(await marks(), ['hive-pm hive-pm-pr']);
  await run(`t.crowded();document.querySelector('[data-tile-id="work"]').focus()`);
  assert.deepEqual(await marks(), ['hive-pm hive-pm-person', 'hive-pm hive-pm-pr', 'hive-pm hive-pm-review-pending', 'hive-pm hive-pm-recorded-wait']);
  assert.match(await run(`document.querySelector('.hive-mark-tooltip:not([hidden])').textContent`), /PR needs review or merge/);
  assert.equal(await run(`(()=>{const tile=document.querySelector('[data-tile-id="work"]');const title=tile.querySelector('.hive-hex-text').getBBox();const marks=[...tile.querySelectorAll('.hive-pm')].map(m=>m.transform.baseVal.consolidate().matrix.f-8.1);return title.y+title.height<=Math.min(...marks)})()`), true, 'Title stays above four badges');
  if (process.env.HIVE_SHOT_DIR) {
    const shot = await call('Page.captureScreenshot', { format: 'png' });
    await writeFile(join(process.env.HIVE_SHOT_DIR, 'pr-review-badge.png'), Buffer.from(shot.data, 'base64'));
  }
});
