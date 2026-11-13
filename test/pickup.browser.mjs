import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pickupFixture } from './helpers/pickup.mjs';
import { setPickup, pickupState, createPickupDispatcher } from '../server/pickup.js';

const run = promisify(execFile);
const page = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/public/styles.css"><style>
:root{--fg:#222;--bg:#fafafa;--muted:#667;--border:#ddd;--input-bg:#fff}body{background:#edf0f2;color:#222;font:16px system-ui;margin:0}main{background:#fafafa;max-width:760px;margin:35px auto;padding:28px;border-radius:12px}.hive-legend{display:flex;flex-wrap:wrap;gap:12px}.hive-field input,.hive-field select{padding:7px}h1{font-size:24px}.hive-pickup details{margin-top:16px}
</style></head><body><main class="hive-root"><h1>Automatic pickup · fake work</h1><p>Isolated browser fixture. Throwaway work store. No real agents.</p><div id="details"></div><div id="key"></div></main><script type="module">
import { pickupDetails } from '/public/pickup.js';
import { legend, primaryKind, markWords } from '/public/cell-view.js';
const forms = new Map(); let state;
const ui = {form:k=>forms.get(k),setForm:(k,v)=>forms.set(k,v),patchForm:(k,v)=>{forms.set(k,{...forms.get(k),...v});render();}};
const api = {agents:()=>[{id:'claude',label:'Claude',models:[{value:'sonnet',resolved:'claude-sonnet-fixed',default:true,autoEffort:'medium',efforts:['medium']}]}]};
const send = async (msg,opts)=>{const response=await fetch('/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(msg)});const reply=await response.json();state=await(await fetch('/state')).json();opts.onReply(reply);render();window.saved=true;};
function render(){if(!state)return;document.querySelector('#details').replaceChildren(pickupDetails({ui,api,send},state.cell,state.bead));document.querySelector('#key').replaceChildren(legend());}
state=await(await fetch('/state')).json();render();
const mode=new URL(location).searchParams.get('mode');
if(mode==='ready'){
 document.querySelector('details').open=true;
 const input=document.querySelector('input[name="cwd"]');input.value='/tmp/fake-repo';input.dispatchEvent(new Event('input',{bubbles:true}));
 document.querySelector('details').open=true;
 document.querySelector('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
 const end=Date.now()+5000;while(!window.saved&&Date.now()<end)await new Promise(r=>setTimeout(r,20));
}
if(mode==='remove'){
 document.querySelector('details').open=true;
 [...document.querySelectorAll('button')].find(b=>b.textContent==='Remove readiness').click();
 const end=Date.now()+5000;while(!window.saved&&Date.now()<end)await new Promise(r=>setTimeout(r,20));
}
const expected={ready:'ready',waiting:'queued',attention:'attention',launched:'consumed',remove:'unmarked'}[mode];
const kind=primaryKind(state.bead,mode==='waiting'?['b']:[],[]);
const valid=state.bead.pickup.state===expected && document.querySelector('[role="status"]').textContent===state.bead.pickup.reason && document.querySelector('[aria-label="Key"]').textContent.includes('ready for automatic pickup') && (mode!=='ready'||kind==='pickup'&&markWords(kind,state.bead).includes('Ready for pickup'));
document.body.dataset.verification=valid?'passed':'failed';
</script></body></html>`;

test('pickup UI with real readiness handlers and fake workers in isolated Chrome', async t => {
  const output = process.env.HIVE_SCREENSHOT_DIR ? path.resolve(process.env.HIVE_SCREENSHOT_DIR) : await fs.mkdtemp(path.join(os.tmpdir(), 'hive-pickup-shots-'));
  t.diagnostic(`Screenshots: ${output}`);
  await fs.mkdir(output, { recursive: true });
  let fixture;
  const state = () => ({ cell: fixture.doc().cells.cell, bead: { ...fixture.graph().beads.a, pickup: pickupState(fixture.rt, fixture.host, fixture.doc().cells.cell, fixture.graph().beads.a, fixture.graph(), { now: fixture.now() }) } });
  const server = http.createServer(async (req, res) => {
    try {
      if (req.url.startsWith('/?')) { res.setHeader('Content-Type', 'text/html'); res.end(page); return; }
      if (req.url === '/state') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(state())); return; }
      if (req.url === '/action') {
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        const msg = JSON.parse(Buffer.concat(chunks).toString());
        const result = await setPickup(fixture.rt, fixture.host, { sessionId: null, cell: fixture.doc().cells.cell, role: 'human', cells: [{ cell: fixture.doc().cells.cell, role: 'human' }] }, { bead_id: msg.beadId, ready: msg.ready, profile: msg.profile, rearm: msg.rearm, expected_token: msg.expectedToken, reason: msg.reason });
        res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: true, ...result })); return;
      }
      if (!/^\/public\/[\w.-]+$/.test(req.url)) { res.writeHead(404).end(); return; }
      res.setHeader('Content-Type', req.url.endsWith('.css') ? 'text/css' : 'text/javascript'); res.end(await fs.readFile(new URL(`..${req.url}`, import.meta.url)));
    } catch (err) { res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: false, error: err.message })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  assert.notEqual(server.address().port, 7777);
  for (const mode of ['ready', 'waiting', 'attention', 'launched', 'remove']) {
    fixture = pickupFixture();
    if (mode !== 'ready') await setPickup(fixture.rt, fixture.host, fixture.actor(), { bead_id: 'a', ready: true, profile: fixture.profile });
    if (mode === 'waiting') fixture.live.a.dependencies.push({ issue_id: 'a', depends_on_id: 'b', type: 'blocks' });
    if (mode === 'attention') fixture.host.sessions.spawn = async () => { throw new Error('Fake host launch receipt missing; reconcile this worker'); };
    if (['attention', 'launched'].includes(mode)) await createPickupDispatcher({ runtime: fixture.rt, host: fixture.host, now: fixture.now }).run();
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'hive-pickup-chrome-'));
    t.after(() => fs.rm(profile, { recursive: true, force: true }));
    let stdout;
    try {
      ({ stdout } = await run(process.env.HIVE_TEST_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', `--user-data-dir=${profile}`, '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--window-size=1100,1100', '--virtual-time-budget=6000', `--screenshot=${path.join(output, `${mode}.png`)}`, '--dump-dom', `http://127.0.0.1:${server.address().port}/?mode=${mode}`], { timeout: 25000, maxBuffer: 2 * 1024 * 1024 }));
    } catch (err) {
      if (err.code === 'ENOENT') { t.skip('Chrome is not installed; set HIVE_TEST_CHROME to its executable'); return; }
      throw err;
    }
    assert.match(stdout, /data-verification="passed"/, `${mode}: ${stdout}`);
    assert.ok((await fs.stat(path.join(output, `${mode}.png`))).size > 10000);
  }
});
