import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function launch(chrome, origin, extraOrigins = []) {
  if (!/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin || '') || /:7777$/.test(origin)) throw new Error('launch(chrome, origin) needs one exact disposable http://localhost:PORT origin (not 7777).');
  const profile = mkdtempSync(join(tmpdir(), 'promo-capture-'));
  const child = spawn(chrome, ['--headless=new', '--no-default-browser-check', `--user-data-dir=${profile}`, '--disable-gpu', '--no-first-run', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-default-apps', '--no-pings', '--disable-features=OptimizationHints,MediaRouter,Translate', '--remote-debugging-port=0',
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = ''; child.stderr.on('data', d => { err += d; });
  let port;
  for (let i = 0; i < 150 && !port; i++) {
    const m = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(err);
    if (m) port = Number(m[1]); else await new Promise(r => setTimeout(r, 100));
  }
  if (!port) { child.kill(); throw new Error(`browser did not start: ${err}`); }
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = targets.find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pending = new Map(); const listeners = [];
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); } else listeners.forEach(l => l(m)); };
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; const t = setTimeout(() => { pending.delete(i); rej(new Error(`${method} timed out after 20s`)); }, 20000); pending.set(i, { res: v => { clearTimeout(t); res(v); }, rej: e => { clearTimeout(t); rej(e); } }); ws.send(JSON.stringify({ id: i, method, params })); });
  const evaluate = async (expression) => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; };
  const violations = [];
  const blocked = [];
  const EXPECTED_BLOCKED = /^https:\/\/(cdn\.jsdelivr\.net|fonts\.googleapis\.com|fonts\.gstatic\.com)\//;
  const origins = [origin, ...extraOrigins];
  const allowed = (url) => origins.some(o => url === o || url.startsWith(`${o}/`)) || /^(about:blank|data:|blob:)/.test(url);
  listeners.push((m) => {
    if (m.method === 'Fetch.requestPaused') {
      const url = m.params.request.url;
      if (allowed(url)) send('Fetch.continueRequest', { requestId: m.params.requestId }).catch(() => {});
      else { (EXPECTED_BLOCKED.test(url) ? blocked : violations).push(url); send('Fetch.failRequest', { requestId: m.params.requestId, errorReason: 'BlockedByClient' }).catch(() => {}); }
    } else if (m.method === 'Network.webSocketCreated') {
      const u = new URL(m.params.url);
      if (!['localhost', '127.0.0.1'].includes(u.hostname) || !origins.some(o => new URL(o).port === u.port)) violations.push(m.params.url);
    }
  });
  await send('Network.enable');
  await send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
  const close = async () => { try { ws.close(); } catch {} child.kill(); await new Promise(r => setTimeout(r, 300)); rmSync(profile, { recursive: true, force: true }); };
  return { send, evaluate, close, violations, blocked, on: (l) => listeners.push(l) };
}
export const sleep = (ms) => new Promise(r => setTimeout(r, ms));
export async function shot(b, file, clip) {
  const r = await b.send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { ...clip, scale: 1 } } : {}) });
  writeFileSync(file, Buffer.from(r.data, 'base64'));
}
