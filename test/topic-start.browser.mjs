import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';

const page = `<!doctype html><html><head><link rel="stylesheet" href="/public/styles.css"><style>*{box-sizing:border-box}body{margin:0}.hive-message{min-height:180px}</style></head><body><div class="hive-root" id="root" style="width:100vw;height:100vh"></div><script type="module">
import client from '/public/client.js';
import { openHiveLink, hiveLink } from '/public/deep-links.js';
const store = new Map([['cell', JSON.stringify('alpha')]]);
let view, receive;
const messages = Array.from({length:60}, (_,i) => ({id:'m'+(i+1), n:i+1, at:i+1, threadId:'topic', author:'session', sessionId:'queen', text:'Message '+(i+1), ack:{required:true, rev:0, state:i+1===12 || i+1===55 ? null : {kind:'read'}}}));
messages[3].requestId = 'decision';
const thread = {id:'topic', title:'A long topic', beads:[], retained:60, count:60, lastAt:60, windowFrom:'m41', waitingFrom:{id:'m12',n:12,rev:0}};
const cell = {id:'alpha', taskId:'task', rootBeadId:'root', enabled:true, queenSessionId:'queen', threads:[thread], messages:messages.slice(40), requests:{decision:{id:'decision', audience:'human', state:'open', title:'Choose a database', body:'Which database?', createdAt:4, threadId:'topic', messageId:'m4', requesterSessionId:'queen', revision:1, routeRevision:1}}, requestCounts:{human:1,queen:0}, inbox:{human:{ids:['m12','m55'],count:2,rev:1,messages:[messages[11],messages[54]]},queen:{ids:[],count:0}}, launches:[],bindings:[],beadLayout:{},workstreamColours:{},workstreamShades:{},archived:{},restoreNotices:[],regionAttachments:{},detachedWorkstreams:[]};
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
window.t={cell,messages,frames,open:()=>openHiveLink(window,hiveLink('alpha','topic')),exact:()=>openHiveLink(window,hiveLink('alpha','topic','m55')),redraw:()=>{hive.metaVersion++;view.update(root,null,{...graph})}};
view.mount(root,null);view.update(root,null,graph);
</script></body></html>`;

test('topic opening starts at the older unanswered decision, including paged history', { skip: !process.env.HIVE_TEST_CHROME || !process.env.HIVE_TEST_CDP ? 'CI-only isolated Chrome' : false }, async t => {
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
  await call('Page.navigate',{url:`http://127.0.0.1:${server.address().port}/`});
  await run(`(async()=>{for(let i=0;i<100&&!window.t;i++)await new Promise(r=>setTimeout(r,25));if(!window.t)throw Error('fixture did not load');t.open();})()`);
  const result = await run(`(async()=>{for(let i=0;i<100&&!document.querySelector('.hive-message[data-id="m12"]');i++)await new Promise(r=>setTimeout(r,25));await new Promise(r=>setTimeout(r,300));const list=document.querySelector('.hive-messages'),top=list.getBoundingClientRect().top;return {first:[...list.children].find(e=>e.dataset.id&&e.getBoundingClientRect().bottom>top+1)?.dataset.id,history:t.frames.filter(f=>f.type==='hive-thread-history').length};})()`);
  assert.ok(result.history > 0, 'loaded history to resolve the opening position');
  assert.equal(result.first, 'm4', 'the older decision starts at the top, before unread m12');
});
