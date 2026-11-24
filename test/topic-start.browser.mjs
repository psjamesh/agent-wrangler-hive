import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

const page = `<!doctype html><html><head><link rel="stylesheet" href="/public/styles.css"><style>*{box-sizing:border-box}body{margin:0}.hive-message{min-height:180px}</style></head><body><div class="hive-root" id="root" style="width:100vw;height:100vh"></div><script type="module">
import client from '/public/client.js';
import { openHiveLink, hiveLink } from '/public/deep-links.js';
import { createRequestNotifications } from '/public/requests.js';
const store = new Map([['cell', JSON.stringify('alpha')]]);
let view, receive;
const messages = Array.from({length:60}, (_,i) => ({id:'m'+(i+1), n:i+1, at:i+1, threadId:'topic', author:'session', sessionId:'queen', text:'Message '+(i+1), ack:{required:true, rev:0, state:i+1===12 || i+1===55 ? null : {kind:'read'}}}));
messages[3].requestId = 'decision';
const thread = {id:'topic', title:'A long topic', beads:[], retained:60, count:60, lastAt:60, windowFrom:'m41', waitingFrom:{id:'m12',n:12,rev:0}};
const cell = {id:'alpha', taskId:'task', rootBeadId:'root', enabled:true, queenSessionId:'queen', threads:[thread], messages:messages.slice(40), requests:{decision:{id:'decision', cellId:'alpha', audience:'human', state:'open', title:'Choose a database', body:'Which database?', createdAt:4, threadId:'topic', messageId:'m4', requesterSessionId:'queen', revision:1, routeRevision:1}}, requestCounts:{human:1,queen:0}, inbox:{human:{ids:['m12','m55'],count:2,rev:1,messages:[messages[11],messages[54]]},queen:{ids:[],count:0}}, launches:[],bindings:[],beadLayout:{},workstreamColours:{},workstreamShades:{},archived:{},restoreNotices:[],regionAttachments:{},detachedWorkstreams:[]};
const hive = {cells:{alpha:cell},beads:{root:{id:'root',title:'Demo',kind:'goal',status:'open',evidence:[]}},edges:[],launches:[],operations:[],metaEpoch:'e',metaVersion:1,backend:{state:'ready',snapshotComplete:true,snapshotBeadIds:['root']}};
const graph = {hive,sessions:[{sessionId:'queen',name:'Demo queen'}],tasks:{tasks:[{id:'task',name:'Demo'}]}};
const frames = [];
function send(frame) {
  frames.push(frame);
  let reply;
  if(frame.type==='hive-deep-link') reply={cellId:'alpha',thread,messageId:frame.messageId,messages:messages.slice(40),more:true,anchorN:61};
  if(frame.type==='hive-thread-history') { const end=frame.before ? messages.findIndex(m=>m.id===frame.before) : messages.length; const start=Math.max(0,end-(frame.limit||40)); reply={messages:messages.slice(start,end),more:start>0,anchorN:end+1}; }
  if(reply) setTimeout(()=>receive({op:frame.type,requestId:frame.requestId,ok:true,...reply}),20);
}
client.register({onMessage(fn){receive=fn},api:{state:()=>graph,act:(type,args)=>{send({type,...args});return new Promise(()=>{})},storage:{get:k=>store.get(k),set:(k,v)=>store.set(k,v),remove:k=>store.delete(k)}},register(kind,v){view=v}});
const root=document.getElementById('root');
window.t={cell,messages,frames,search:query=>{root.querySelector('[data-focus-key="map-search-open"]').click();const input=root.querySelector('[data-focus-key="global-inbox-search"]');input.value=query;input.dispatchEvent(new Event('input',{bubbles:true}));},route:async kind=>{
 if(kind==='global'){root.querySelector('.hive-back').click();await new Promise(r=>setTimeout(r,50));if(!root.querySelector('.hive-global-inbox'))root.querySelector('[data-focus-key="global-inbox-toggle"]').click();}
 else if(kind==='inbox'){root.querySelector('.hive-inbox-filter').click();}
 else if(kind==='needs'){root.querySelector('[data-focus-key="waiting-header"]').click();document.querySelector('dialog [data-wait-action="reply"]').click();return;}
 else if(kind==='notification'){let answer;const notify=createRequestNotifications({ui:{notify:()=>new Promise(r=>answer=r)}});notify({cells:{}});notify(hive);answer('open');return;}
 if(kind==='link')return t.open();
 const row=root.querySelector('.hive-topic-btn');if(!row)throw Error('missing topic row for '+kind);
 (kind==='needs'?row.querySelector('.hive-needs-count'):row).click();
},open:()=>openHiveLink(window,hiveLink('alpha','topic')),exact:()=>openHiveLink(window,hiveLink('alpha','topic','m55')),redraw:()=>{hive.metaVersion++;view.update(root,null,{...graph})}};
view.mount(root,null);view.update(root,null,graph);
</script></body></html>`;

test('topic routes select unread messages or older decisions and preserve explicit links', { skip: !process.env.HIVE_TEST_CHROME || !process.env.HIVE_TEST_CDP ? 'CI-only isolated Chrome' : false }, async t => {
  const port = Number(process.env.HIVE_TEST_CDP);
  assert.ok(port > 0 && port !== 7777);
  const oldLinks = new Map(['conversation.js', 'global-inbox.js', 'waiting-view.js', 'requests.js'].map(file => [file,
    execFileSync('git', ['show', `05967355dc49e7f4e0d3995558a5d00b364b31a0:public/${file}`], { encoding: 'utf8' }),
  ]));
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/') { res.setHeader('Content-Type', 'text/html'); res.end(url.searchParams.has('old-links') ? page.replaceAll('/public/', '/old-links/public/') : page); return; }
    const old = url.pathname.startsWith('/old-links/');
    const file = old ? url.pathname.slice('/old-links'.length) : url.pathname;
    if (!/^\/public\/[\w.-]+$/.test(file)) { res.writeHead(404).end(); return; }
    try { res.setHeader('Content-Type', file.endsWith('.css') ? 'text/css' : 'text/javascript'); res.end(old && oldLinks.has(file.slice(8)) ? oldLinks.get(file.slice(8)) : await readFile(new URL(`..${file}`, import.meta.url))); }
    catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, {method:'PUT'})).json();
  t.after(() => fetch(`http://127.0.0.1:${port}/json/close/${target.id}`));
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise(resolve => socket.addEventListener('open', resolve, {once:true}));
  t.after(() => socket.close());
  let seq = 0;
  const pending = new Map();
  socket.addEventListener('message', event => { const m=JSON.parse(event.data), p=pending.get(m.id); if(!p)return; pending.delete(m.id); if(m.error)p.reject(m.error); else p.resolve(m.result); });
  const call = (method,params={}) => new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}));});
  const run = async expression => { const r=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});assert.equal(r.exceptionDetails,undefined,JSON.stringify(r.exceptionDetails));return r.result.value; };
  await call('Emulation.setDeviceMetricsOverride',{width:1280,height:800,deviceScaleFactor:1,mobile:false});
  await call('Page.enable');
  const boot = async (oldLinks = false) => {
    const loaded = new Promise(resolve => socket.addEventListener('message', function onLoad(event) {
      if (JSON.parse(event.data).method !== 'Page.loadEventFired') return;
      socket.removeEventListener('message', onLoad); resolve();
    }));
    await call('Page.navigate',{url:`http://127.0.0.1:${server.address().port}/${oldLinks ? '?old-links' : ''}`});
    await loaded;
    await run(`(async()=>{for(let i=0;i<100&&!window.t;i++)await new Promise(r=>setTimeout(r,25));if(!window.t)throw Error('fixture did not load');})()`);
  };
  const position = () => run(`(async()=>{await new Promise(r=>setTimeout(r,450));const list=document.querySelector('.hive-messages');if(!list)throw Error('topic did not open');const top=list.getBoundingClientRect().top;return {first:[...list.children].find(e=>e.dataset.id&&e.getBoundingClientRect().bottom>top+1)?.dataset.id,history:t.frames.filter(f=>f.type==='hive-thread-history').length,read:t.frames.filter(f=>f.type==='hive-auto-read').flatMap(f=>f.messages.map(m=>m.messageId)),bottom:Math.abs(list.scrollHeight-list.clientHeight-list.scrollTop)<2};})()`);
  for (const route of ['link','topic','inbox','global','needs','notification']) await t.test(route, async () => {
    await boot();
    await run(`t.route(${JSON.stringify(route)})`);
    const result = await position();
    assert.ok(result.history > 0, 'loaded history to resolve the opening position');
    assert.equal(result.first, 'm4', 'the older decision starts at the top, before unread m12');
    assert.ok(!result.read.includes('m12') && !result.read.includes('m55'), 'unseen messages below the decision stay unread');
  });
  for (const route of ['inbox', 'global', 'needs', 'notification']) await t.test(`${route}: unread before a newer decision discriminates old links`, async () => {
    const observed = [];
    for (const old of [true, false]) {
      await boot(old);
      await run(`delete t.messages[3].requestId;t.messages[53].requestId='decision';Object.assign(t.cell.requests.decision,{messageId:'m54',createdAt:54});t.redraw();t.route(${JSON.stringify(route)})`);
      const result = await position();
      observed.push(result.first);
      if (old) assert.notEqual(result.first, 'm12', 'pre-fix links bypass the earlier unread target');
      else assert.equal(result.first, 'm12', 'topic navigation chooses unread before the newer decision');
    }
    t.diagnostic(`${route}: pre-fix links opened ${observed[0]}; fixed links opened ${observed[1]}`);
  });
  for (const route of ['inbox', 'global', 'needs', 'notification']) await t.test(`${route}: delivery repair preserves its exact card`, async () => {
    await boot();
    await run(`Object.assign(t.cell.requests.decision,{messageId:'m54',createdAt:54,state:'answered',delivery:{state:'failed'}});delete t.messages[3].requestId;t.messages[53].requestId='decision';t.redraw();t.route(${JSON.stringify(route)})`);
    assert.equal((await position()).first, 'm54', 'repair action opens the request card rather than an unread message');
  });
  await t.test('unread only, followed by a fresh reopen with nothing waiting', async () => {
    await boot();
    await run(`t.cell.requests={};t.redraw();t.open()`);
    assert.equal((await position()).first, 'm12');
    await run(`for(const m of t.messages)m.ack={required:true,state:{kind:'read'},rev:1};t.cell.threads[0].waitingFrom=null;t.redraw();t.open()`);
    const result=await position();
    assert.equal(result.bottom,true,'reopening a read topic shows its newest message');
  });
  await t.test('search keeps filtering and opens the first matching waiting item', async () => {
    await boot();
    await run(`t.messages[54].text='Needle update';t.messages[59].text='Needle later';t.redraw();t.search('Needle');t.open()`);
    const result = await position();
    assert.equal(result.first, 'm55', 'hidden decision m4 and hidden unread m12 do not set the filtered start');
    assert.ok(!result.read.includes('m12'), 'hidden unread messages stay unread');
    assert.deepEqual(await run(`[...document.querySelectorAll('.hive-message')].map(m=>m.dataset.id)`), ['m55', 'm60']);
    assert.equal(await run(`document.querySelector('[data-focus-key="global-inbox-search"]').value`), 'Needle');
  });
  await t.test('specific message links keep their target ahead of open decisions', async () => {
    await boot();
    await run('t.exact()');
    const result=await position();
    assert.equal(result.first,'m55');
    assert.ok(!result.read.includes('m12'),'an exact link does not read earlier unseen messages');
  });
});
