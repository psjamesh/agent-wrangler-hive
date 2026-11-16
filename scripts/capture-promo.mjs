#!/usr/bin/env node
// Captures the Hive introduction screenshots from a real, disposable Agent Wrangler
// instance running this checkout, seeded with a fictional "Launch a field guide"
// hive. It never touches a live board: it uses a fresh temporary data directory, a
// loopback port, no provider binaries, and a browser that can only reach localhost.
//
//   node scripts/capture-promo.mjs --core <agent-wrangler checkout> [--chrome <path>]
//        [--port 65384] [--out <dir>] [--install-to public/promo] [--keep-server]
//
// Run it on a machine where launching a headless browser is permitted. Repository
// policy keeps browsers out of ordinary agent runs; use the project's opt-in route.
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, shot, sleep } from './capture-promo/cdp.mjs';
import { SESSIONS, writeFixtureFiles } from './capture-promo/fixture.mjs';
import { createGuard, guardLog, verifyGuard } from './capture-promo/inert.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : fallback; };
const flag = name => process.argv.includes(`--${name}`);

const CORE = arg('core') && resolve(arg('core'));
const PORT = Number(arg('port', 0)) || 0;
const OUT = resolve(arg('out', join(ROOT, '.scratch', 'promo-capture')));
const INSTALL = arg('install-to') && resolve(arg('install-to'));
const CHROME = arg('chrome', process.env.HIVE_CAPTURE_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
const VIEWPORT = { width: 1120, height: 630 };
const SCALE = 1.3;
if (!CORE || !existsSync(join(CORE, 'server', 'index.js'))) throw new Error('Pass --core <agent-wrangler checkout>.');
if (!existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME}; pass --chrome.`);

const freePort = () => new Promise((res, rej) => {
  import('node:net').then(({ createServer }) => {
    const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); s.on('error', rej);
  });
});
const board = PORT || await freePort();
if (board === 7777) throw new Error('Refusing to use port 7777.');
const deck = await freePort();
const api = await freePort();

const data = mkdtempSync('/tmp/aw-promo-');
const hiveDir = join(data, 'extensions', 'hive');
writeFixtureFiles(data, flag('check-guard') ? join(data, 'work', 'field-guide') : undefined);
writeFileSync(join(data, 'config.json'), JSON.stringify({ extensions: { hive: true } }));
const guard = createGuard(data);
const guardChecks = verifyGuard(guard);
const guardBaseline = guardLog(guard).length;
cpSync(ROOT, hiveDir, { recursive: true, filter: src => !/(^|\/)(\.git|\.scratch|node_modules)(\/|$)/.test(src.slice(ROOT.length)) });
cpSync(join(ROOT, 'scripts', 'capture-promo', 'seed.js'), join(hiveDir, 'server', 'capture-seed.js'));
const manifestFile = join(hiveDir, 'server', 'manifest.js');
let manifest = readFileSync(manifestFile, 'utf8');
manifest = manifest.replace("import { setupHandlers, configHandlers } from './handlers.js';", "$&\nimport { seedHandler } from './capture-seed.js';")
  .replace('handlers: [...setupHandlers, ...configHandlers]', 'handlers: [...setupHandlers, ...configHandlers, seedHandler]');
if (!manifest.includes('seedHandler]')) throw new Error('Could not patch the disposable manifest.');
writeFileSync(manifestFile, manifest);
execFileSync('npm', ['ci', '--omit=dev', '--ignore-scripts'], { cwd: hiveDir, stdio: 'ignore' });

let server, browser, keep = flag('keep-server');
const stop = async () => {
  await browser?.close().catch(() => {});
  if (server && !keep) { server.kill(); await sleep(1000); rmSync(data, { recursive: true, force: true }); }
};
process.on('SIGINT', () => stop().finally(() => process.exit(130)));

const log = join(data, 'server.log');
server = spawn(process.execPath, ['server/index.js'], {
  cwd: CORE, stdio: ['ignore', 'ignore', 'ignore'],
  env: { ...guard.env, AW_DEV: '1', AW_DEV_IDLE_SHUTDOWN_MIN: '0', AW_DATA_DIR: data, AW_PORT: String(board), AW_DECK_PORT: String(deck), AW_SESSION_API_PORT: String(api), AW_EXTENSION_INSTALLS_OFF: '1' },
});
writeFileSync(join(data, 'pid.txt'), String(server.pid));
const BASE = `http://localhost:${board}/`;
const sh = (cmd, args, cwd) => { try { return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } };

async function until(fn, tries = 80, ms = 500) { for (let i = 0; i < tries; i++) { try { const v = await fn(); if (v) return v; } catch { } await sleep(ms); } throw new Error('Timed out waiting for the instance.'); }
const deckCall = (action, args = {}) => new Promise((res, rej) => {
  const ws = new WebSocket(`ws://127.0.0.1:${deck}/ws?api=1`);
  let done = false;
  const finish = (fn, v) => { if (done) return; done = true; clearTimeout(t); try { ws.close(); } catch { } fn(v); };
  const t = setTimeout(() => finish(rej, new Error(`${action} timed out`)), 120000);
  ws.onopen = () => ws.send(JSON.stringify({ type: 'action', id: 1, action, args }));
  ws.onmessage = e => { const f = JSON.parse(e.data); if (f.type === 'result' && f.id === 1) f.ok ? finish(res, f.data) : finish(rej, new Error(JSON.stringify(f.error))); };
  ws.onerror = () => finish(rej, new Error(`${action}: connection failed`));
  ws.onclose = () => finish(rej, new Error(`${action}: connection closed`));
});
const hiveState = () => new Promise((res, rej) => {
  const ws = new WebSocket(`ws://127.0.0.1:${deck}/ws?api=1`);
  let done = false;
  const finish = (fn, v) => { if (done) return; done = true; clearTimeout(t); try { ws.close(); } catch { } fn(v); };
  const t = setTimeout(() => finish(rej, new Error('no state')), 20000);
  ws.onmessage = e => { const f = JSON.parse(e.data); if (f.type === 'state') finish(res, f.ext.hive.hive); };
  ws.onerror = () => finish(rej, new Error('state: connection failed'));
  ws.onclose = () => finish(rej, new Error('state: connection closed'));
});

const shots = [];
try {
  await until(async () => (await fetch(BASE)).ok);
  if (flag('check-guard')) {
    const results = [];
    for (const s of Object.values(SESSIONS)) {
      const r = await deckCall('session.resume', { sessionId: s.id, recreateDir: true }).then(v => ({ ok: true, v }), e => ({ ok: false, e: String(e.message).slice(0, 160) }));
      results.push({ session: s.name, ...r });
    }
    for (const agent of ['claude', 'codex']) {
      mkdirSync(join(data, 'work', 'spawn'), { recursive: true });
      const r = await deckCall('session.dispatch', { agent, cwd: join(data, 'work', 'spawn'), intent: 'guard probe' }).then(v => ({ ok: true, v: JSON.stringify(v).slice(0, 120) }), e => ({ ok: false, e: String(e.message).slice(0, 200) }));
      results.push({ session: `new ${agent} dispatch`, ...r });
    }
    await sleep(4000);
    const providers = sh('sh', ['-c', "ps -axo command | grep -E '(^|/)(claude|codex|gemini)( |$)' | grep -v grep | grep -c \"$1\" || true", '_', data]);
    console.log(JSON.stringify({ selfChecks: guardChecks, resumeAttempts: results, deniedLog: guardLog(guard), providerProcessesForThisDataDir: providers }, null, 1));
    keep = false;
    await stop();
    process.exit(0);
  }
  if (flag('serve-fixture')) {
    const first = await until(() => deckCall('ext.hive.hive-capture-seed').catch(e => (/connection/.test(e.message) ? null : Promise.reject(e))), 40, 1000);
    if (!first.ok) throw new Error(`Seeding failed: ${first.error}`);
    const done = await deckCall('ext.hive.hive-capture-seed', { phase: 'finish' });
    if (!done.ok) throw new Error(`Finishing Build search failed: ${done.error}`);
    keep = true;
    console.log(`Fixture served: ${BASE} board ${board} deck ${deck} api ${api} pid ${server.pid} data ${data} (no browser launched; stop: kill ${server.pid}, then remove the data directory)`);
    await new Promise(resolve => server.on('exit', resolve));
    process.exit(0);
  }
  const seeded = await until(() => deckCall('ext.hive.hive-capture-seed').catch(e => (/connection/.test(e.message) ? null : Promise.reject(e))), 40, 1000);
  if (!seeded.ok) throw new Error(`Seeding failed: ${seeded.error}\n${(seeded.log || []).join('\n')}`);
  const cellId = seeded.cellId;
  const bead = title => seeded.beads[{ 'Build search': 'search', 'Choose the cover': 'cover' }[title]];
  const link = (extra = '') => `${BASE}#view=ext:hive:overview&cell=${cellId}${extra}`;

  if (BASE.replace(/\/$/, '') !== (arg('approved-origin') || 'http://localhost:65384')) throw new Error(`Browser capture is approved only for ${arg('approved-origin') || 'http://localhost:65384'}; got ${BASE}.`);
  browser = await launch(CHROME, BASE.replace(/\/$/, ''), [`http://127.0.0.1:${deck}`, `http://localhost:${deck}`]);
  const b = browser;
  await b.send('Page.enable'); await b.send('Runtime.enable');
  await b.send('Emulation.setDeviceMetricsOverride', { ...VIEWPORT, deviceScaleFactor: SCALE, mobile: false });
  const text = () => b.evaluate('document.body.innerText');
  const need = async (...phrases) => {
    for (let i = 0; i < 30; i++) { const t = await text(); if (phrases.every(p => t.includes(p))) return; await sleep(300); }
    throw new Error(`Expected on screen: ${phrases.join(' | ')}\nHash: ${await hashNow()}\nBlocked: ${browser.violations.concat(browser.blocked).join(",")}\nPage text: ${(await text()).replace(/\s+/g, ' ').slice(0, 700)}`);
  };
  const press = key => Promise.all(['keyDown', 'keyUp'].map(type => b.send('Input.dispatchKeyEvent', { type, key, code: key, windowsVirtualKeyCode: key === 'Escape' ? 27 : 0 })));
  const click = (selector, label) => b.evaluate(`(() => { const e = [...document.querySelectorAll(${JSON.stringify(selector)})].find(x => x.textContent.trim().startsWith(${JSON.stringify(label)})); if (!e) return false; e.click(); return true; })()`);
  const resetScroll = () => b.evaluate(`(() => { for (const e of document.querySelectorAll('*')) { if (e.getBoundingClientRect().x > 600 && e.scrollHeight > e.clientHeight + 4 && /auto|scroll/.test(getComputedStyle(e).overflowY)) e.scrollTop = 0; } })()`);
  const bringToView = (label, block) => b.evaluate(`(() => { const e = [...document.querySelectorAll('*')].find(x => x.children.length === 0 && x.getBoundingClientRect().x > 600 && x.textContent.trim().startsWith(${JSON.stringify(label)})); e?.scrollIntoView({ block: ${JSON.stringify(block)} }); return !!e; })()`);
  const clickChip = label => b.evaluate(`(() => { const e = [...document.querySelectorAll('button, span, div')].find(x => x.children.length <= 1 && x.textContent.trim() === ${JSON.stringify(label)} && x.getBoundingClientRect().y < 60); if (!e) return false; e.click(); return true; })()`);
  const inView = label => b.evaluate(`(() => { const e = [...document.querySelectorAll('body *')].reverse().find(x => x.children.length <= 1 && x.textContent.trim().startsWith(${JSON.stringify(label)}) && x.getBoundingClientRect().width > 0); if (!e) return 'missing'; const r = e.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth ? 'ok' : 'clipped ' + Math.round(r.top) + '..' + Math.round(r.bottom) + ' of ' + innerHeight; })()`);
  const hashNow = () => b.evaluate('location.hash');
  const assertVisible = async (...labels) => { for (const l of labels) { const v = await inView(l); if (v !== 'ok') throw new Error(`"${l}" is not fully on screen (${v}).`); } };
  const scrollTo = (label, block) => b.evaluate(`(() => { const e = [...document.querySelectorAll('body *')].reverse().find(x => x.children.length <= 1 && x.textContent.trim().startsWith(${JSON.stringify(label)}) && x.getBoundingClientRect().width > 0); e?.scrollIntoView({ block: ${JSON.stringify(block)} }); return !!e; })()`);
  const scrollPaneEnd = () => b.evaluate(`(() => { const c = [...document.querySelectorAll('body *')].filter(e => e.getBoundingClientRect().x > 600 && e.scrollHeight > e.clientHeight + 40 && /auto|scroll/.test(getComputedStyle(e).overflowY)); const e = c.sort((a, z) => (z.scrollHeight - z.clientHeight) - (a.scrollHeight - a.clientHeight))[0]; if (!e) return false; e.scrollTop = e.scrollHeight; return true; })()`);
  const noPromo = async () => { for (let i = 0; i < 10; i++) { if (!(await b.evaluate('!!document.querySelector(".hive-promo[open]")'))) return; await press('Escape'); await sleep(400); } throw new Error('The introduction would not close.'); };

  const scenes = [
    { id: 'welcome', url: () => `${BASE}#view=ext:hive:overview`, ready: ['Launch a field guide', 'Plan the communit', 'Redesign the repai', '3 hives'], after: async () => { await noPromo(); await resetScroll(); if (/cell=|bead=/.test(await hashNow())) throw new Error('Welcome must show the All hives overview, not a hive.'); await need('3 hives', 'Plan the communit', 'Redesign the repai'); await assertVisible('Launch a field guide', 'Plan the communit', 'Redesign the repai'); } },
    { id: 'map', url: () => link(`&bead=${bead('Build search')}`), ready: ['Build search', 'Publish the guide'], after: async () => { await noPromo(); await click('button', 'Details'); await need('Claimed by', 'Needed by'); await resetScroll(); } },
    { id: 'people', url: () => link(`&bead=${bead('Build search')}`), ready: ['Build search'], after: async () => { await noPromo(); await click('button', 'Details'); await need('Claimed by', 'Also bound'); await resetScroll(); if (!await clickChip('Queen')) throw new Error('Queen chip not found.'); await need('Guide coordinator'); await bringToView('Claimed by', 'center'); } },
    { id: 'inbox', url: () => link(), ready: ['Cover choice and launch date'], after: async () => { await noPromo(); await click('button, a, div', 'Cover choice and launch date'); await need('Thanks. Can we keep the launch', 'The venue holds that Saturday'); await resetScroll(); await bringToView('Thanks. Can we keep', 'start'); } },
    { id: 'needs-you', viewport: { width: 1318, height: 741, scale: 1.105 }, url: () => link(`&bead=${bead('Choose the cover')}`), ready: ['Choose the cover'], after: async () => { await noPromo(); await click('button, a, div', 'Which cover should'); await need('Hedgerow (Recommended)', 'Meadow', 'Foxglove'); await resetScroll(); await scrollPaneEnd(); await sleep(500); await assertVisible('Meadow', 'Hedgerow (Recommended)', 'Foxglove', 'Your answer, or a note with your choice', 'Dismiss request'); } },
    { id: 'delivery', phase: 'finish', url: () => link(`&bead=${bead('Build search')}`), ready: ['Build search'], after: async () => { await noPromo(); await click('button', 'Details'); await need('Delivery boundary'); await resetScroll(); await bringToView('Evidence', 'start'); } },
  ];

  mkdirSync(OUT, { recursive: true });
  const capture = async (scene, theme) => {
    const vp = scene.viewport || { ...VIEWPORT, scale: SCALE };
    await b.send('Emulation.setDeviceMetricsOverride', { width: vp.width, height: vp.height, deviceScaleFactor: vp.scale, mobile: false });
    await b.send('Page.navigate', { url: BASE });
    await sleep(2500);
    await b.evaluate(`(() => { localStorage.clear(); sessionStorage.clear(); localStorage.setItem('cm-style', '${theme}'); })()`);
    await b.send('Page.navigate', { url: 'about:blank' });
    await b.send('Page.navigate', { url: scene.url() });
    await need(...scene.ready);
    await sleep(800);
    try { await scene.after(); } catch (error) { await shot(b, join(OUT, `failed-${scene.id}-${theme}.png`)).catch(() => {}); throw error; }
    await sleep(1200);
    const lightNow = await b.evaluate('document.body.classList.contains("light")');
    if (lightNow !== (theme === 'light')) throw new Error(`Theme ${theme} did not apply for ${scene.id}.`);
    const name = `${scene.id}${theme === 'light' ? '-light' : ''}.png`;
    await shot(b, join(OUT, name));
    const bytes = readFileSync(join(OUT, name));
    shots.push({ file: name, scene: scene.id, theme, viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: vp.scale, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    console.log(`captured ${scene.id} (${theme})`);
  };
  const captureWithRetry = async (scene, theme) => {
    for (let attempt = 1; ; attempt++) {
      try { return await capture(scene, theme); } catch (error) {
        if (attempt >= 3 || !/timed out after/.test(error.message)) throw error;
        console.log(`retrying ${scene.id} (${theme}) after: ${error.message}`);
        await b.send('Page.navigate', { url: 'about:blank' }).catch(() => {});
        await sleep(1500);
      }
    }
  };
  for (const phase of [undefined, 'finish']) {
    if (phase) {
      const done = await deckCall('ext.hive.hive-capture-seed', { phase });
      if (!done.ok) throw new Error(`Finishing Build search failed: ${done.error}`);
    }
    for (const theme of ['dark', 'light']) for (const scene of scenes.filter(x => x.phase === phase)) await captureWithRetry(scene, theme);
  }

  if (b.violations.length) throw new Error(`Browser tried to reach disallowed URLs: ${b.violations.join(', ')}`);
  const version = await b.evaluate('navigator.userAgent');
  const state = await hiveState();
  const dirtyDiff = sh('git', ['diff', 'HEAD', '--', '.', ':!public/promo', ':!.scratch'], ROOT);
  const manifestJson = JSON.stringify({
    scenario: 'launch-a-field-guide',
    viewport: VIEWPORT, deviceScaleFactor: SCALE,
    hive: {
      sha: sh('git', ['rev-parse', 'HEAD'], ROOT), dirty: dirtyDiff !== '',
      dirtySourceDigest: dirtyDiff ? createHash('sha256').update(dirtyDiff).digest('hex') : null,
      packageVersion: JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version, buildVersion: state.buildVersion,
    },
    core: { sha: sh('git', ['rev-parse', 'HEAD'], CORE) },
    beads: { version: sh('bd', ['--version']) },
    browser: version,
    sessions: Object.fromEntries(Object.entries(SESSIONS).map(([k, v]) => [k, v.name])),
    isolation: {
      browserOrigin: BASE.replace(/\/$/, ''),
      requestsOutsideOrigin: 'blocked',
      blockedExternalHosts: [...new Set(b.blocked.map(u => new URL(u).host))].sort(),
      unexpectedBlockedRequests: b.violations.length,
      guardSelfChecks: guardChecks,
      guardBlockedDuringCapture: guardLog(guard).slice(guardBaseline).filter(l => !l.includes('\tredirect\t')).map(l => l.split('\t').slice(1, 3).join(' ').split(' ').slice(0, 3).join(' ')).filter(Boolean),
    },
    shots,
  }, null, 2) + '\n';
  writeFileSync(join(OUT, 'manifest.json'), manifestJson);
  if (INSTALL) {
    mkdirSync(INSTALL, { recursive: true });
    for (const s of shots) cpSync(join(OUT, s.file), join(INSTALL, s.file));
    writeFileSync(join(INSTALL, 'manifest.json'), manifestJson);
    if (keep) { mkdirSync(join(hiveDir, 'public', 'promo'), { recursive: true }); for (const s of shots) cpSync(join(OUT, s.file), join(hiveDir, 'public', 'promo', s.file)); writeFileSync(join(hiveDir, 'public', 'promo', 'manifest.json'), manifestJson); }
  }
  if (keep) console.log(`Instance kept: ${BASE} pid ${server.pid} data ${data} (stop: kill ${server.pid}, then remove the data directory)`);
} catch (error) {
  keep = false;
  throw error;
} finally {
  await stop();
}
