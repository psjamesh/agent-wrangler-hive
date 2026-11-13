import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const modes = ['request', 'message', 'inbox', 'inbox-markdown', 'inbox-bare'];
const worker = '22222222-2222-4222-8222-222222222222';
const queen = '11111111-1111-4111-8111-111111111111';
const page = mode => `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/public/styles.css">
<style>:root{--fg:#1b1d21;--bg:#fcfcfb;--border:#d4d7dc;--muted:#68707c;--accent:#4f46e5;--input-bg:#fff}body{margin:0;background:#eceef1;color:var(--fg);font:16px system-ui}main{max-width:800px;margin:60px auto;background:#fcfcfb;padding:32px;border:1px solid #d4d7dc;border-radius:12px}h1{font-size:23px;margin-top:0}.hive-message{list-style:none}.hive-request{margin:0}#fixture .hive-global-dock{height:520px}.fixture-caption{color:#68707c;font-size:14px}</style>
<script src="/core/markdown-it.min.js"></script></head><body><main class="hive-root"><h1>${mode === 'request' ? 'Build command needs approval' : 'Message from the queen'}</h1><p class="fixture-caption">Isolated fixture · Hive session navigation</p><div id="fixture"></div></main>
<script type="module">
import { requestCard } from '/public/requests.js';
import { globalInbox } from '/public/global-inbox.js';
import { renderConversation } from '/public/conversation.js';
import client, { createUi } from '/public/client.js';
import { createRenderer } from '/core/markdown-preview.js';
import { setSessionLinkGuard } from '/public/dom.js';
const values = new Map();
client.register({api:{storage:{get:k=>values.get(k),set:(k,v)=>values.set(k,v),remove:k=>values.delete(k)}},register(){}});
const ui = createUi(), ctx = {busy:()=>false,send(){},notice(){}};
const graph = {sessions:[{sessionId:'${worker}',name:'Build worker'},{sessionId:'${queen}',name:'Coordinator'},{sessionId:'old',archived:true}]};
setSessionLinkGuard(id => graph.sessions.some(s => s.sessionId === id && !s.archived));
const api = {ui:{markdownPreview:createRenderer(window.markdownit)}};
const cell = {id:'cell_fixture',rootBeadId:'root',enabled:true,queenSessionId:'${queen}'};
let body = 'The build is waiting for approval. Open the worker session to review the command.\\n\\n[Worker session](#session=${worker}) · [Archived session](#session=old) · [Unknown session](#session=missing)';
if (${JSON.stringify(mode)} === 'inbox-bare') body = '#session=${worker} · #session=old · #session=missing';
const r = {id:'r',title:'Approve the build command',body,audience:'human',state:'open',createdAt:Date.now(),requesterSessionId:'${worker}',sessionLink:{sessionId:'${worker}',label:'Open session'},requesterSessionLink:{sessionId:'${worker}',label:'Open requester session'},forwarded:{recommendation:'The command runs the repository test suite.'}};
const inboxMode = ${JSON.stringify(mode.startsWith('inbox'))};
if (inboxMode && ${JSON.stringify(mode)} !== 'inbox') { delete r.sessionLink; delete r.requesterSessionLink; delete r.requesterSessionId; }
let node;
if (${JSON.stringify(mode)} === 'request') node = requestCard(r,{cell,graph,api,ui,ctx});
else {
 cell.messages = [{id:'m',author:'session',role:'queen',sessionId:'${queen}',text:body,at:Date.now(),sessionLink:{sessionId:'${worker}',label:'Open session'}}];
 if (inboxMode) {
   if (${JSON.stringify(mode)} !== 'inbox') delete cell.messages[0].sessionLink;
   cell.threads = [{id:'topic',title:'Review the build'}];
   cell.messages[0].threadId = 'topic';
   cell.messages[0].ack = {required:true,rev:1,state:null};
   cell.inbox = {human:{ids:['m'],count:1,rev:1},queen:{ids:[],count:0}};
   cell.requests = {r:{...r,threadId:'topic',messageId:'m'}};
   node = globalInbox({hive:{cells:{[cell.id]:cell}},graph,api,ui},[cell]);
 } else node = renderConversation({cell,hive:{beads:{root:{id:'root'}}},graph,api,ui,ctx}).list;
}
document.getElementById('fixture').append(node);
const anchors = [...node.querySelectorAll('a[href]')].filter(a=>a.getAttribute('href').startsWith('#session='));
const valid = anchors.length === (inboxMode ? 1 : 2) && anchors.every(a=>a.getAttribute('href')==='#session=${worker}' && !a.target) && (inboxMode ? !node.querySelector('.hive-topic-btn a') && node.querySelector('.hive-inbox-item .hive-needs-hex').textContent === '1' : node.textContent.includes('Archived session') && node.textContent.includes('Unknown session'));
anchors[0]?.click();
const markdownNavigated = location.hash === '#session=${worker}';
location.hash = '';
const expectedLabel = ${JSON.stringify(mode === 'inbox-bare' ? 'Build worker' : mode === 'inbox-markdown' ? 'Worker session' : 'Open session')};
anchors.find(a=>a.textContent===expectedLabel)?.click();
const unavailableVisible = !inboxMode || ${JSON.stringify(mode)} === 'inbox' || (() => { const strip = node.querySelector('.hive-inbox-session-links'); return strip.querySelectorAll('span.hive-muted').length === 2 && (${JSON.stringify(mode)} === 'inbox-bare' ? strip.textContent.includes('Open session') : strip.textContent.includes('Archived session') && strip.textContent.includes('Unknown session')); })();
const rowVisible = !inboxMode || (() => { const row = node.querySelector('.hive-inbox-item').getBoundingClientRect(); const dock = node.getBoundingClientRect(); return row.height > 0 && row.top >= dock.top && row.bottom <= dock.bottom; })();
setTimeout(()=>{document.body.dataset.verification = valid && unavailableVisible && rowVisible && markdownNavigated && location.hash === '#session=${worker}' ? 'passed' : 'failed';},0);
</script></body></html>`;

test('isolated Chrome renders request and message links and navigates their session fragments', { skip: !process.env.HIVE_SCREENSHOT_DIR }, async t => {
  assert.ok(process.env.HIVE_CORE_PUBLIC, 'Provide the core public directory to verify the real Markdown renderer.');
  const output = path.resolve(process.env.HIVE_SCREENSHOT_DIR);
  assert.ok(output.startsWith('/private/tmp/'), 'Screenshots must stay under /private/tmp.');
  await fs.mkdir(output, { recursive: true });
  const build = await fs.mkdtemp('/private/tmp/hive-session-build-');
  t.after(() => fs.rm(build, { recursive: true, force: true }));
  await fs.cp(new URL('../public/', import.meta.url), path.join(build, 'public'), { recursive: true });
  await fs.mkdir(path.join(build, 'core'));
  for (const name of ['markdown-preview.js', 'text-links.js', 'term-links.js']) await fs.copyFile(path.join(process.env.HIVE_CORE_PUBLIC, name), path.join(build, 'core', name));
  await fs.copyFile(path.join(process.env.HIVE_CORE_PUBLIC, 'vendor/markdown-it.min.js'), path.join(build, 'core/markdown-it.min.js'));
  const server = http.createServer(async (req, res) => {
    if (modes.some(mode => req.url === `/${mode}`)) { res.setHeader('Content-Type', 'text/html'); res.end(page(req.url.slice(1))); return; }
    const pathname = new URL(req.url, 'http://fixture').pathname;
    if (!/^\/(public|core)\/[a-zA-Z0-9_.-]+$/.test(pathname)) { res.writeHead(404); res.end(); return; }
    try { res.setHeader('Content-Type', pathname.endsWith('.css') ? 'text/css' : 'text/javascript'); res.end(await fs.readFile(path.join(build, pathname))); }
    catch { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  assert.notEqual(port, 7777);
  for (const mode of modes) {
    const profile = await fs.mkdtemp('/private/tmp/hive-session-chrome-');
    t.after(() => fs.rm(profile, { recursive: true, force: true }));
    const screenshot = path.join(output, `${mode}.png`);
    const { stdout } = await run(process.env.HIVE_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', `--user-data-dir=${profile}`, '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--window-size=1100,1000', '--virtual-time-budget=1800', `--screenshot=${screenshot}`, '--dump-dom', `http://127.0.0.1:${port}/${mode}`], { timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
    assert.match(stdout, /data-verification="passed"/, `${mode}: ${stdout}`);
    assert.ok((await fs.stat(screenshot)).size > 10000);
  }
});
