#!/usr/bin/env node
// Browser QA for the Hive introduction against a running disposable instance.
//   node scripts/capture-promo/qa.mjs --url http://localhost:65384/ --out <dir> [--chrome <path>]
// Exits non-zero when any assertion fails.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { launch, shot, sleep } from './cdp.mjs';

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : fallback; };
const URL_ = arg('url');
const OUT = arg('out');
const CHROME = arg('chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
if (!URL_ || !OUT) throw new Error('Pass --url and --out.');
const ORIGIN = new URL(URL_).origin;
const APPROVED = arg('approved-origin', 'http://localhost:65384');
if (ORIGIN !== APPROVED) throw new Error(`QA is approved only for ${APPROVED}; got ${ORIGIN}.`);
mkdirSync(OUT, { recursive: true });
const MANIFEST = arg('manifest') ? JSON.parse(readFileSync(arg('manifest'), 'utf8')) : null;
const EXPECTED_SHA = Object.fromEntries((MANIFEST?.shots || []).map(x => [x.file, x.sha256]));
const servedSha = `(async () => { const d = document.querySelector('.hive-promo'); const art = [...d.querySelectorAll('.hive-promo-art > div')].find(x => getComputedStyle(x).display !== 'none'); const img = (art || d.querySelector('.hive-promo-image'))?.querySelector('img'); if (!img) return null; const buf = await (await fetch(img.currentSrc, { cache: 'reload' })).arrayBuffer(); const h = await crypto.subtle.digest('SHA-256', buf); return [...new Uint8Array(h)].map(x => x.toString(16).padStart(2, '0')).join(''); })()`;

const SIZES = [[1366, 768], [1280, 720], [1024, 650], [390, 844], [320, 640]];
const PAGES = ['welcome', 'map', 'people', 'inbox', 'needs-you', 'delivery'];
const EXTRA = (arg('deck-port', '')).split(',').filter(Boolean).flatMap(p => [`http://127.0.0.1:${p}`, `http://localhost:${p}`]);
const b = await launch(CHROME, ORIGIN, EXTRA);
const ev = e => b.evaluate(e);
const key = k => Promise.all(['keyDown', 'keyUp'].map(type => b.send('Input.dispatchKeyEvent', { type, key: k, code: k, windowsVirtualKeyCode: 27 })));
const clickAt = async (x, y) => { for (const type of ['mousePressed', 'mouseReleased']) await b.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }); };
const failures = [];
const checksums = {};
let tag = '';
const check = (ok, what, detail) => { if (!ok) { failures.push(`${tag}: ${what}${detail === undefined ? '' : ` (${JSON.stringify(detail)})`}`); } return ok; };

const probe = `(() => {
  const d = document.querySelector('.hive-promo');
  if (!d || !d.open) return { open: false };
  const rect = e => { const x = e?.getBoundingClientRect(); return x && { x: x.x, y: x.y, w: x.width, h: x.height, t: x.top, b: x.bottom, l: x.left, r: x.right }; };
  const shape = d.querySelector('.hive-promo-shape');
  const hexShown = !!shape && getComputedStyle(shape).display !== 'none';
  let rendered = null;
  if (hexShown) {
    const poly = shape.querySelector('polygon');
    const m = poly.getScreenCTM();
    const pts = [...poly.points].map(p => { const q = shape.createSVGPoint(); q.x = p.x; q.y = p.y; const t = q.matrixTransform(m); return [t.x, t.y]; });
    const edges = pts.map((p, i) => Math.hypot(p[0] - pts[(i + 1) % pts.length][0], p[1] - pts[(i + 1) % pts.length][1]));
    rendered = { vertices: pts.length, minEdge: Math.min(...edges), maxEdge: Math.max(...edges) };
  }
  const inner = d.querySelector('.hive-promo-inner');
  const page = d.querySelector('.hive-promo-page');
  const cap = d.querySelector('.hive-promo-caption');
  const footer = d.querySelector('.hive-promo-footer');
  const enlarge = d.querySelector('.hive-promo-enlarge');
  const close = d.querySelector('.hive-promo-close');
  const art = [...d.querySelectorAll('.hive-promo-art > div')].find(x => getComputedStyle(x).display !== 'none');
  const img = (art || d.querySelector('.hive-promo-image'))?.querySelector('img');
  const cr = rect(close);
  const top = cr && document.elementFromPoint(cr.x + cr.w / 2, cr.y + cr.h / 2);
  const board = [...document.querySelectorAll('button, a, select')].filter(e => !d.contains(e)).map(e => rect(e)).filter(r => r && r.w > 0 && r.h > 0 && r.t < 120);
  const overlapsBoard = cr ? board.some(o => cr.l < o.r && cr.r > o.l && cr.t < o.b && cr.b > o.t) : null;
  const jump = d.querySelector('.hive-promo-jump');
  return {
    open: true, hexShown, rendered, dialog: rect(d), inner: rect(inner), page: rect(page), caption: rect(cap), captionText: cap?.textContent.trim(), footer: rect(footer), enlarge: rect(enlarge),
    pageId: page?.getAttribute('data-page'), counter: d.querySelector('.hive-promo-counter')?.textContent, closeButton: cr, closeInEyebrow: !!close?.closest('.hive-promo-eyebrow'), closeTopmost: top ? close.contains(top) : null, closeOverlapsBoard: overlapsBoard,
    image: img && { src: (img.getAttribute('src') || '').split('/').pop().split('?')[0], natural: img.naturalWidth, shown: getComputedStyle(img).display !== 'none' && img.getBoundingClientRect().width > 0 },
    jumpShown: !!jump && getComputedStyle(jump).display !== 'none', pageScrollable: page ? page.scrollHeight > page.clientHeight + 1 : null, vp: [innerWidth, innerHeight],
  };
})()`;
const geometry = `(() => {
  const d = document.querySelector('.hive-promo'); const page = d.querySelector('.hive-promo-page'); const out = {};
  for (const [name, top] of [['atTop', true], ['atMax', false]]) {
    page.scrollTop = top ? 0 : page.scrollHeight;
    const inner = d.querySelector('.hive-promo-inner').getBoundingClientRect();
    const cap = d.querySelector('.hive-promo-caption').getBoundingClientRect();
    const footer = d.querySelector('.hive-promo-footer').getBoundingClientRect();
    const enlarge = d.querySelector('.hive-promo-enlarge').getBoundingClientRect();
    const sep = (o) => cap.bottom <= o.top + 1 || cap.top >= o.bottom - 1 || cap.right <= o.left + 1 || cap.left >= o.right - 1;
    const el = d.querySelector('.hive-promo-caption');
    out[name] = { insideInner: cap.top >= inner.top - 1 && cap.bottom <= inner.bottom + 1 && cap.left >= inner.left - 1 && cap.right <= inner.right + 1, clearOfFooter: sep(footer), clearOfEnlarge: sep(enlarge), notTruncated: el.scrollHeight <= el.clientHeight + 1, height: Math.round(cap.height), footerInInner: footer.bottom <= inner.bottom + 1 && footer.top >= inner.top - 1 };
  }
  page.scrollTop = 0; return out;
})()`;
const buttons = `[...document.querySelectorAll('.hive-promo button')].map(x => { const r = x.getBoundingClientRect(); return { t: x.textContent.trim(), cls: x.className, x: r.x + r.width / 2, y: r.y + r.height / 2, vis: getComputedStyle(x).display !== 'none' && getComputedStyle(x).visibility !== 'hidden' && r.width > 0 && r.height > 0 && !x.disabled }; })`;
const mouse = async (match) => { const hit = (await ev(buttons)).find(x => x.vis && match(x)); if (!hit) return false; await clickAt(hit.x, hit.y); await sleep(450); return true; };
const jumpTo = async (index) => { await ev(`(() => { const s = document.querySelector('#hive-promo-jump'); s.value = '${index}'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`); await sleep(450); };

const results = [];
try {
  await b.send('Page.enable'); await b.send('Runtime.enable');
  const runCase = async (w, h, theme) => {
    tag = `${w}x${h}-${theme}`;
    await b.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 500 });
    await b.send('Page.navigate', { url: 'about:blank' });
    await b.send('Page.navigate', { url: `${URL_}#view=ext:hive:overview` });
    await sleep(2500);
    await ev(`localStorage.clear(); localStorage.setItem('cm-style', '${theme}')`);
    await b.send('Page.reload'); await sleep(4500);
    const wantHex = w >= 900 && h >= 600;
    const rec = { tag, wantHex };
    const first = await ev(probe);
    rec.first = first;
    if (!check(first.open, 'intro opens on the overview')) { results.push(rec); return; }
    check(first.hexShown === wantHex, wantHex ? 'hexagon not shown' : 'fallback not used', { hexShown: first.hexShown });
    if (wantHex && first.rendered) {
      check(first.rendered.vertices === 6, 'silhouette is not a hexagon', first.rendered.vertices);
      check(first.rendered.maxEdge / first.rendered.minEdge < 1.005, 'rendered hexagon edges unequal', first.rendered);
    }
    check(first.pageId === 'welcome' && /Page 1 of 6/.test(first.counter), 'first page is Welcome', [first.pageId, first.counter]);
    check(first.closeInEyebrow && first.closeTopmost === true, 'Close is in the header and topmost', { inEyebrow: first.closeInEyebrow, topmost: first.closeTopmost });
    if (wantHex) check(first.closeOverlapsBoard === false, 'Close overlaps a board header control');
    check(first.closeButton.l >= first.dialog.l && first.closeButton.r <= first.dialog.r && first.closeButton.t >= first.dialog.t && first.closeButton.b <= first.dialog.b, 'Close is outside the dialog', first.closeButton);
    check(first.dialog.l >= 0 && first.dialog.r <= w && first.dialog.t >= 0 && first.dialog.b <= h, 'dialog leaves the viewport', first.dialog);
    await shot(b, `${OUT}/${tag}-1-welcome.png`);

    rec.visited = [];
    for (let n = 0; n < 6; n++) {
      if (wantHex) check(await mouse(x => x.t.startsWith(`${n + 1} ·`)), `stop ${n + 1} is clickable`);
      else { check(first.jumpShown, 'Jump select is shown on narrow screens'); await jumpTo(n); }
      const p = await ev(probe);
      const wantImg = `${PAGES[n]}${theme === 'light' ? '-light' : ''}.png`;
      check(p.pageId === PAGES[n] && p.counter === `Page ${n + 1} of 6`, `stop ${n + 1} shows ${PAGES[n]}`, [p.pageId, p.counter]);
      check(p.image?.src === wantImg && p.image.natural > 800 && p.image.shown, `stop ${n + 1} shows the real ${wantImg}`, p.image);
      check(!!p.captionText, `stop ${n + 1} has a caption`);
      if (MANIFEST) { const served = await ev(servedSha); check(served === EXPECTED_SHA[wantImg], `served ${wantImg} bytes match the manifest checksum`, served); if (served) checksums[wantImg] = served; }
      const g = await ev(geometry);
      for (const where of ['atTop', 'atMax']) {
        const v = g[where];
        check(v.insideInner && v.clearOfFooter && v.clearOfEnlarge && v.notTruncated && v.footerInInner, `caption/footer geometry at ${where} on ${PAGES[n]}`, v);
      }
      rec.visited.push({ stop: n + 1, pageId: p.pageId, image: p.image?.src, caption: g });
      if (n === 3) await shot(b, `${OUT}/${tag}-4-inbox.png`);
    }

    if (wantHex) await mouse(x => x.t.startsWith('1 ·')); else await jumpTo(0);
    check((await ev(probe)).pageId === 'welcome', 'back at page 1');
    check(!(await ev(buttons)).some(x => /Back$/.test(x.t) && x.vis), 'Back is hidden on page 1');
    check(await mouse(x => /\bhive-promo-next\b/.test(x.cls)), 'Next is clickable');
    const afterNext = await ev(probe);
    check(afterNext.pageId === 'map', 'Next goes to Map', afterNext.pageId);
    check(await mouse(x => x.t === '← Back'), 'Back is clickable');
    const afterBack = await ev(probe);
    check(afterBack.pageId === 'welcome', 'Back returns to Welcome', afterBack.pageId);

    if (wantHex) await mouse(x => x.t.startsWith('6 ·')); else await jumpTo(5);
    const nextLabel = await ev(`document.querySelector('.hive-promo-next')?.textContent`);
    check(nextLabel === 'Close intro', 'last page Next label is Close intro', nextLabel);
    await key('Escape'); await sleep(700);
    const closedByEsc = !(await ev(probe)).open;
    check(closedByEsc, 'Escape closes the intro');
    rec.stored = await ev(`Object.entries(localStorage).filter(([k]) => /hive|promo/i.test(k)).map(([k, v]) => k + '=' + String(v).slice(0, 60))`);
    check(rec.stored.some(s => /promoState/i.test(s)), 'dismissal is stored', rec.stored);
    const clicked = await ev(`(() => { const e = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'About Hive'); if (!e) return false; e.click(); return true; })()`);
    check(clicked, 'About Hive button exists');
    await sleep(900);
    const replay = await ev(probe);
    check(replay.open && replay.pageId === 'welcome', 'About Hive replays the intro from page 1', replay.pageId);
    await mouse(x => x.t === 'Close intro');
    check(!(await ev(probe)).open, 'footer Close intro closes the intro');
    results.push(rec);
    console.log(tag, failures.filter(f => f.startsWith(tag)).length ? `FAIL (${failures.filter(f => f.startsWith(tag)).length})` : 'ok');
  };
  for (const [w, h] of SIZES) for (const theme of ['dark', 'light']) {
    for (let attempt = 1; ; attempt++) {
      const before = failures.length;
      try { await runCase(w, h, theme); break; } catch (error) {
        failures.length = before;
        if (attempt >= 3 || !/timed out after/.test(error.message)) throw error;
        console.log(`retrying ${w}x${h}-${theme}: ${error.message}`);
        await b.send('Page.navigate', { url: 'about:blank' }).catch(() => {});
        await sleep(2000);
      }
    }
  }
  check(b.violations.length === 0, 'browser reached only the approved origin', b.violations);
  writeFileSync(`${OUT}/qa.json`, JSON.stringify({ origin: ORIGIN, servedChecksums: checksums, failures, violations: b.violations, results }, null, 1));
} finally { await b.close(); }
if (failures.length) { console.error(`\n${failures.length} QA failure(s):\n${failures.join('\n')}`); process.exit(1); }
console.log('QA passed: all assertions held on all viewports and themes.');
