import { createAutoFit, sameTransform } from './auto-fit.js';
import { readMapView, saveMapView } from './view-state.js';
import { h } from './dom.js';
import { fromPixel, toPixel, neighbour, DIRECTIONS, key } from './hex-layout.js';
import { MAX_COORD } from './hex-search.js';

const DRAG_THRESHOLD = 6;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 2.5;
const FIT_PAD = 40;
const views = new Map();
const TWEEN_MS = 320;
let uid = 0;

export function wrapLines(text, perLine, maxLines) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    const w = word.length > perLine ? `${word.slice(0, perLine - 1)}…` : word;
    if (!line) line = w;
    else if (`${line} ${w}`.length <= perLine) line = `${line} ${w}`;
    else {
      lines.push(line);
      line = w;
    }
    if (lines.length === maxLines) break;
  }
  if (line && lines.length < maxLines) lines.push(line);
  const used = lines.join(' ').length;
  if (used < String(text || '').trim().length && lines.length) {
    const last = lines[lines.length - 1];
    lines[lines.length - 1] = `${last.slice(0, Math.max(1, perLine - 1))}…`.replace(/……$/, '…');
  }
  return lines;
}

let measureCtx = null;
let measureFamily = '';

function textWidth(text, px, weight) {
  if (measureCtx === null) {
    try {
      measureCtx = document.createElement('canvas').getContext('2d') || false;
      measureFamily = getComputedStyle(document.body).fontFamily || 'system-ui, sans-serif';
    } catch {
      measureCtx = false;
    }
  }
  if (!measureCtx) return text.length * px * 0.58;
  measureCtx.font = `${weight} ${px}px ${measureFamily}`;
  return measureCtx.measureText(text).width;
}

// Wraps a title into at most `maxLines` lines, measured in the tile's font.
// `width` is one pixel width, or one per line (the hexagon narrows towards
// its top and bottom). Long identifiers break at - _ / . : rather than being
// cut, and only the last line ever ends in an ellipsis.
export function fitLines(text, { width, maxLines, px, weight = 600 }) {
  const widths = Array.isArray(width) ? width : [width];
  const at = (i) => widths[Math.min(i, widths.length - 1)];
  const narrowest = Math.min(...widths.slice(0, maxLines));
  let row = 0;
  const fitsIn = (t, w) => textWidth(t, px, weight) <= w;
  const fits = (t) => fitsIn(t, narrowest);
  const pieces = [];
  for (const word of String(text || '').split(/\s+/).filter(Boolean)) {
    if (fits(word)) { pieces.push({ t: word, join: ' ' }); continue; }
    let rest = word;
    let first = true;
    while (rest) {
      let cut = rest.length;
      while (cut > 1 && !fits(rest.slice(0, cut))) cut -= 1;
      if (cut < rest.length) {
        const soft = Math.max(...['-', '_', '/', '.', ':'].map((c) => rest.lastIndexOf(c, cut - 1)));
        if (soft >= Math.floor(cut / 2)) cut = soft + 1;
      }
      pieces.push({ t: rest.slice(0, cut), join: first ? ' ' : '' });
      rest = rest.slice(cut);
      first = false;
    }
  }
  const lines = [];
  let line = '';
  let i = 0;
  for (; i < pieces.length; i += 1) {
    const { t, join } = pieces[i];
    const next = line ? `${line}${join}${t}` : t;
    if (!line || fitsIn(next, at(row))) { line = next; continue; }
    lines.push(line);
    row += 1;
    if (lines.length === maxLines) break;
    line = t;
  }
  if (lines.length < maxLines && line) { lines.push(line); i = pieces.length; }
  if (i < pieces.length) {
    let last = lines[lines.length - 1];
    while (last.length > 1 && !fitsIn(`${last}…`, at(lines.length - 1))) last = last.slice(0, -1);
    lines[lines.length - 1] = `${last.replace(/[\s\-_/.:]+$/, '')}…`;
  }
  return lines;
}

// A hexagon with softened corners, centred on the origin: pointy-top by
// default, flat-top with rotate 0.
export function hexPath(radius, round = 0.14, rotate = -30) {
  const pts = [];
  for (let i = 0; i < 6; i += 1) {
    const a = (Math.PI / 180) * (60 * i + rotate);
    pts.push([radius * Math.cos(a), radius * Math.sin(a)]);
  }
  const t = round;
  let d = '';
  for (let i = 0; i < 6; i += 1) {
    const p = pts[i];
    const prev = pts[(i + 5) % 6];
    const next = pts[(i + 1) % 6];
    const a = [p[0] + (prev[0] - p[0]) * t, p[1] + (prev[1] - p[1]) * t];
    const b = [p[0] + (next[0] - p[0]) * t, p[1] + (next[1] - p[1]) * t];
    d += `${i ? 'L' : 'M'}${a[0].toFixed(2)},${a[1].toFixed(2)} Q${p[0].toFixed(2)},${p[1].toFixed(2)} ${b[0].toFixed(2)},${b[1].toFixed(2)} `;
  }
  return `${d}Z`;
}

export function reducedMotion() {
  return Boolean(globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
}

function clampZoom(k) {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k));
}

const ASCENT = 0.78;
const DESCENT = 0.24;
// The selection and focus ring sits just inside the rim, and text may use
// everything inside the ring's inner edge less TEXT_PAD.
const RING = 0.945;
const RING_STROKE = 2;
const TEXT_PAD = 1.5;

// Half the hexagon's width at height y, for a pointy-top hexagon of radius r.
function halfWidth(y, r) {
  const a = Math.abs(y);
  const flat = (Math.sqrt(3) / 2) * r;
  if (a <= r / 2) return flat;
  return Math.max(0, flat * ((r - a) / (r / 2)));
}

// Lays out a tile's text inside the hexagon: title rows, small label rows, a
// badge row and a progress bar, as one block centred in the band left free
// by the relationship mark above and the status mark below. Each title row
// is wrapped to the hexagon's width across that row's full glyph height, and
// the block uses as many title lines as the title needs and the band allows.
function tileText({ title = null, lines = [], sub = [], badge, counters, progress, size, lh = size * 0.21, half, bandTop, bandBottom }) {
  const barH = progress ? Math.max(4, size * 0.07) : 0;
  const px = title?.px || 12;
  const subPx = px * 0.85;
  const asc = px * ASCENT;
  const rowWidth = (base, p) => 2 * Math.min(half(base - p * ASCENT), half(base + p * DESCENT)) - TEXT_PAD * 2;
  const layout = (n) => {
    const rows = n + sub.length + (badge ? 1 : 0) + (counters ? 1 : 0);
    const height = asc + (rows - 1) * lh + px * DESCENT + (progress ? lh * 0.55 + barH : 0);
    const blockTop = (bandTop + bandBottom) / 2 - height / 2;
    const first = blockTop + asc;
    const titleWidths = Array.from({ length: n }, (_, i) => rowWidth(first + lh * i, px));
    const ok = blockTop >= bandTop - 0.01 && titleWidths.every((w) => w >= px * 3);
    return { first, titleWidths, ok };
  };
  let titleLines = lines;
  let geo = layout(lines.length);
  if (title) {
    let chosen = null;
    for (let n = title.maxLines; n >= 1 && !chosen; n -= 1) {
      const g = layout(n);
      if (!g.ok) continue;
      const got = fitLines(title.text, { width: g.titleWidths, maxLines: n, px });
      if (got.length < n && got.length) {
        const g2 = layout(got.length);
        const again = fitLines(title.text, { width: g2.titleWidths, maxLines: got.length, px });
        if (again.length <= got.length && !again.at(-1)?.endsWith('…')) chosen = { lines: again, geo: g2 };
      }
      if (!chosen) chosen = { lines: got, geo: g };
    }
    if (!chosen) {
      const g = layout(1);
      chosen = { lines: fitLines(title.text, { width: [Math.max(px * 3, g.titleWidths[0])], maxLines: 1, px }), geo: g };
    }
    titleLines = chosen.lines;
    geo = chosen.geo;
  }
  const spans = [];
  let y = geo.first;
  for (const line of titleLines) { spans.push(h('svg:tspan', { x: '0', y: y.toFixed(1), class: 'hive-hex-title' }, line)); y += lh; }
  for (const line of sub) { spans.push(h('svg:tspan', { x: '0', y: y.toFixed(1), class: 'hive-hex-sub' }, line)); y += lh; }
  const badgeEl = badge ? h('svg:tspan', { x: '0', y: y.toFixed(1), class: 'hive-hex-badge' }, badge) : null;
  if (badgeEl) { spans.push(badgeEl); y += lh; }
  const row = counters ? tileCounters(counters, y - 3) : null;
  if (counters) y += lh;
  const label = h('svg:text', { class: 'hive-hex-text', 'text-anchor': 'middle' }, spans);
  const text = counters ? h('svg:g', {}, label, row) : label;
  if (!progress) return { text, badgeEl };
  const barY = y - lh + subPx * DESCENT + lh * 0.55;
  const w = Math.max(barH * 4, Math.min(size * 0.92, 2 * Math.min(half(barY), half(barY + barH)) - TEXT_PAD * 4));
  const done = progress.total ? Math.max(0, Math.min(1, progress.done / progress.total)) : 0;
  const bar = h('svg:g', { class: 'hive-progress', 'aria-hidden': 'true' },
    h('svg:rect', { class: 'hive-progress-track', x: (-w / 2).toFixed(1), y: barY.toFixed(1), width: w.toFixed(1), height: barH.toFixed(1), rx: (barH / 2).toFixed(1) }),
    done > 0 ? h('svg:rect', { class: 'hive-progress-fill', x: (-w / 2).toFixed(1), y: barY.toFixed(1), width: Math.max(barH, w * done).toFixed(1), height: barH.toFixed(1), rx: (barH / 2).toFixed(1) }) : null);
  return { text: h('svg:g', {}, text, bar), badgeEl };
}

// Node-local marks for the focused item's immediate links. They sit on the
// linked tiles themselves; nothing is drawn between tiles, and where a tile
// sits says nothing about direction.
const REL_MARK = { prereq: '▲', dependent: '▼' };
const REL_Y = 0.8;
const REL_HALF = 7.5;
export const MARK_R = 7.5;
export const MARK_STROKE = 1.2;
// The robot and person are Lucide's `bot` and `user` glyphs (ISC licence; see
// the README), the same geometry as Agent Wrangler's robot and the Needs You
// person. They are drawn at their own 24-unit proportions, scaled uniformly so
// the whole stroke stays inside the disc with room to spare.
const LUCIDE_SCALE = 0.48;
const LUCIDE = {
  busy: [
    ['path', { d: 'M12 8V4H8' }],
    ['rect', { width: '16', height: '12', x: '4', y: '8', rx: '2' }],
    ['path', { d: 'M2 14h2' }],
    ['path', { d: 'M20 14h2' }],
    ['path', { d: 'M15 13v2' }],
    ['path', { d: 'M9 13v2' }],
  ],
  person: [
    ['circle', { cx: '12', cy: '7', r: '4' }],
    ['path', { d: 'M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2' }],
  ],
};
const PRIMARY_SHAPES = {
  external: [['path', { d: 'M-3,3 L3,-3 M-1,-3 H3 V1', class: 'hive-pm-line' }]],
  'in-progress': [['path', { d: 'M0,-4 A4,4 0 1,1 -4,0', class: 'hive-pm-line' }]],
  'review-working': [['circle', { cx: '-1', cy: '-1', r: '2.8', class: 'hive-pm-line' }], ['path', { d: 'M1,1 L4.4,4.4 M-2,-1 L-1,0 L0.5,-1.8', class: 'hive-pm-line' }]],
  'review-pending': [['circle', { cx: '-1', cy: '-1', r: '2.8', class: 'hive-pm-line' }], ['path', { d: 'M1,1 L4.4,4.4', class: 'hive-pm-line' }]],
  'recorded-wait': [['path', { d: 'M-3.2,-4 L3.2,-4 L3.2,-2.5 L-3.2,2.5 L-3.2,4 L3.2,4 L3.2,2.5 L-3.2,-2.5 Z', class: 'hive-pm-line' }]],
  untracked: [['path', { d: 'M0,-4 L4.5,4 L-4.5,4 Z M0,-1.5 L0,1 M0,2.4 L0,2.5', class: 'hive-pm-line' }]],
  done: [['path', { d: 'M-3.6,0.2 L-1.1,2.8 L3.8,-2.6', class: 'hive-pm-line' }]],
  closed: [['path', { d: 'M-3.4,0 L3.4,0', class: 'hive-pm-line' }]],
  waiting: [['path', { d: 'M-3.6,-3.6 L3.6,3.6 M3.6,-3.6 L-3.6,3.6', class: 'hive-pm-line' }]],
  deferred: [['rect', { x: '-3.2', y: '-3.6', width: '2.2', height: '7.2', rx: '0.6', class: 'hive-pm-fill' }], ['rect', { x: '1', y: '-3.6', width: '2.2', height: '7.2', rx: '0.6', class: 'hive-pm-fill' }]],
};

function markShapes(kind) {
  if (LUCIDE[kind]) {
    return h('svg:g', { class: 'hive-pm-glyph', transform: `scale(${LUCIDE_SCALE}) translate(-12 -12)` },
      LUCIDE[kind].map(([tag, attrs]) => h(`svg:${tag}`, attrs)));
  }
  return PRIMARY_SHAPES[kind]?.map(([tag, attrs]) => h(`svg:${tag}`, attrs)) || null;
}

const COUNTER_SHAPES = {
  inbox: 'M-4,-2.8 H4 V2.8 H-4 Z M-4,-2.8 L0,0.5 L4,-2.8',
  queen: 'M-3,-4 H3 M-3,4 H3 M-2.5,-4 C-2.5,-1 2.5,1 2.5,4 M2.5,-4 C2.5,-1 -2.5,1 -2.5,4',
  progress: 'M-2.5,-3.5 L3.5,0 L-2.5,3.5 Z',
};

function tileCounters(counters, y) {
  const visible = counters.filter(c => c.count > 0).map(c => {
    const value = c.count > 99 ? '99+' : String(c.count);
    return { ...c, value, width: 14 + textWidth(value, 9, 600) };
  });
  const gap = 10;
  const width = visible.reduce((sum, c) => sum + c.width, 0) + Math.max(0, visible.length - 1) * gap;
  let left = -width / 2;
  return h('svg:g', { class: 'hive-tile-counters', transform: `translate(0 ${y.toFixed(1)})` }, visible.map(c => {
    const x = left + 5;
    left += c.width + gap;
    return h('svg:g', { class: `hive-counter hive-counter-${c.kind}`, dataset: { counter: c.kind }, transform: `translate(${x.toFixed(2)} 0)` },
      h('svg:title', {}, `${c.label}: ${c.count}`),
      c.kind === 'needs' ? markShapes('person') : h('svg:path', { class: 'hive-counter-glyph', d: COUNTER_SHAPES[c.kind] }),
      h('svg:text', { x: '9', y: '3.5', class: 'hive-counter-value' }, c.value));
  }));
}

export function primaryMark(kind, title, x = 0, y = 0, scale = 1) {
  const shapes = markShapes(kind);
  if (!shapes) return null;
  return h('svg:g', { class: `hive-pm hive-pm-${kind}`, transform: `translate(${x.toFixed(1)} ${y.toFixed(1)}) scale(${scale.toFixed(2)})` },
    h('svg:title', {}, title),
    kind === 'waiting' ? null : kind === 'external' ? h('svg:path', { d: hexPath(MARK_R, 0.18), class: 'hive-pm-bg' }) : h('svg:circle', { r: String(MARK_R), class: 'hive-pm-bg' }),
    shapes);
}

// Where the mark's centre sits: low in the tile, with its whole circle,
// stroke included, MARK_CLEAR px inside the selection ring's inner edge. For
// a pointy-top hexagon the lower sloping edges bind first.
const MARK_CLEAR = 4;
function markY(radius, scale) {
  const apothem = (radius * RING - RING_STROKE / 2) * (SQRT3 / 2);
  const envelope = (MARK_R + MARK_STROKE / 2) * scale;
  return (apothem - envelope - MARK_CLEAR * scale) / (SQRT3 / 2);
}

const REL_WORDS = { prereq: 'needed first', dependent: 'waits on it' };
const GHOST_CAP = 3500;
const SQRT3 = Math.sqrt(3);

// The default tile: a pointy-top hexagon. A tile gives its outline, optional
// faces drawn under the rim, its inner ring, the half-width text may use at
// each height, the default text band, where the relationship mark sits and
// where the status mark sits.
export function hexTile(radius) {
  const textR = radius * RING - RING_STROKE / 2 - 0.5;
  return {
    d: hexPath(radius),
    ring: hexPath(radius * RING),
    half: (y) => halfWidth(y, textR),
    top: -textR * 0.84,
    bottom: textR * 0.84,
    relY: -radius * REL_Y,
    markY: (scale) => markY(radius, scale),
  };
}

// A pan/zoom honeycomb of tiles (task cells on the overview, beads inside a
// cell). Ghosts are the empty comb, drawn only for the visible viewport at the
// same size and gap as real tiles.
// No links are drawn between tiles: hovering, focusing or selecting a tile
// lights its real prerequisites and dependents from `relations`. `outlines`
// are group boundaries, drawn in the gaps under the tiles.
// A tile drag reports its new hex coordinate through onMove and never edits
// a link; a click without movement calls onClick. While dragging, `dragGroup`
// names the tiles (and the outline) that travel with the dragged one, and
// `movePreview` gives the hexes the move would fill, marked at the snapped
// destination and flagged when the drop would be refused.
// A tile with `menu` set opens
// `onContextMenu(id, at)` on right-click, the ContextMenu key or Shift+F10,
// with `at` in the map's own coordinates.
// `tile` replaces the default hexagon tile.
export function renderHexMap({
  viewKey, size, items, occupied = new Set(), bounds, selectedId = null, ariaLabel, maxFit = 1.4,
  relations = null, describe = null,
  onClick, onActivate, onSelect, onMove, onDrop = null, onDragStart = () => {}, onBackground,
  onDragState = () => {}, claimDrag = null, overlay = [], outlines = [],
  dragGroup = null, movePreview = null, onContextMenu = null,
  tile = null, className = '', previousPositions = null, storage = null,
}) {
  const id = `hive-map-${(uid += 1)}`;
  const radius = size * 0.92;
  const form = tile || hexTile(radius);
  const pitch = { x: SQRT3 * size, y: 1.5 * size };
  const snap = (p) => fromPixel(p, size);
  const shape = form.d;
  const svg = h('svg:svg', { class: `hive-hexmap${className ? ` ${className}` : ''}`, role: 'group', 'aria-label': ariaLabel });
  const defs = h('svg:defs', {},
    h('svg:path', { id: `${id}-slot`, d: shape }),
    form.faces ? h('svg:clipPath', { id: `${id}-faces` }, h('svg:path', { d: shape })) : null);
  svg.append(defs);
  const world = h('svg:g', { class: 'hive-world' });
  svg.append(world);
  const ghostLayer = h('svg:g', { class: 'hive-comb', 'aria-hidden': 'true' });
  world.append(ghostLayer);

  const savedView = views.get(viewKey) || readMapView(viewKey);
  const view = savedView || { k: 1, tx: 0, ty: 0, auto: true };
  views.set(viewKey, view);
  const status = relations ? h('p', { class: 'hive-sr-only', 'aria-live': 'polite' }) : null;
  const el = h('div', { class: 'hive-canvas', tabindex: '-1', dataset: { viewKey } }, svg, status, overlay);
  const focusTip = h('div', { class: 'hive-mark-tooltip', role: 'tooltip', id: `${id}-mark-tip`, hidden: true });
  el.append(focusTip);
  let describedTile = null;
  const hideFocusTip = () => { focusTip.hidden = true; focusTip.textContent = ''; describedTile?.removeAttribute('aria-describedby'); describedTile = null; };

  el.hiveTilePositions = new Map(items.map((it) => [it.id, { x: it.x, y: it.y }]));

  let ghostKey = '';
  const drawGhosts = () => {
    const cw = el.clientWidth;
    const ch = el.clientHeight;
    if (!cw || !ch) return;
    const wx0 = -view.tx / view.k;
    const wy0 = -view.ty / view.k;
    const wx1 = (cw - view.tx) / view.k;
    const wy1 = (ch - view.ty) / view.k;
    const edge = 2 * MAX_COORD;
    const clamp = (v) => Math.min(edge, Math.max(-edge, v));
    const r0 = clamp(Math.floor(wy0 / pitch.y) - 1);
    const r1 = clamp(Math.ceil(wy1 / pitch.y) + 1);
    const qa = clamp(Math.floor(wx0 / pitch.x) - 1);
    const qb = clamp(Math.ceil(wx1 / pitch.x) + 1);
    const rangeKey = `${r0},${r1},${qa},${qb}`;
    if (rangeKey === ghostKey) return;
    ghostKey = rangeKey;
    const count = Math.max(0, r1 - r0 + 1) * Math.max(0, qb - qa + 2);
    const frag = [];
    if (count <= GHOST_CAP) {
      for (let r = r0; r <= r1; r += 1) {
        const shift = Math.floor(r / 2);
        for (let c = qa - 1; c <= qb; c += 1) {
          const q = c - shift;
          if (occupied.has(`${q},${r}`)) continue;
          const x = pitch.x * (q + r / 2);
          const y = pitch.y * r;
          frag.push(h('svg:use', { href: `#${id}-slot`, class: 'hive-ghost', x: x.toFixed(1), y: y.toFixed(1) }));
        }
      }
    }
    ghostLayer.replaceChildren(...frag);
    el.classList.toggle('is-far', count > GHOST_CAP);
  };
  let ghostFrame = 0;
  const apply = () => {
    saveMapView(viewKey, view);
    world.setAttribute('transform', `translate(${view.tx.toFixed(1)} ${view.ty.toFixed(1)}) scale(${view.k.toFixed(4)})`);
    if (!ghostFrame) ghostFrame = requestAnimationFrame(() => { ghostFrame = 0; drawGhosts(); });
  };

  const viewFor = (box) => {
    const cw = el.clientWidth;
    const ch = el.clientHeight;
    if (!cw || !ch) return null;
    const k = clampZoom(Math.min((cw - FIT_PAD * 2) / box.w, (ch - FIT_PAD * 2) / box.h, maxFit));
    return { k, tx: cw / 2 - (box.x + box.w / 2) * k, ty: ch / 2 - (box.y + box.h / 2) * k };
  };
  let tween = 0;
  const moveTo = (next, animate) => {
    if (!next || sameTransform(view, next)) return;
    cancelAnimationFrame(tween);
    if (!animate || reducedMotion()) {
      Object.assign(view, next);
      apply();
      return;
    }
    const cw = el.clientWidth;
    const ch = el.clientHeight;
    const from = { k: view.k, cx: (cw / 2 - view.tx) / view.k, cy: (ch / 2 - view.ty) / view.k };
    const to = { k: next.k, cx: (cw / 2 - next.tx) / next.k, cy: (ch / 2 - next.ty) / next.k };
    const started = performance.now();
    const step = (now) => {
      const p = Math.min(1, (now - started) / TWEEN_MS);
      const e = 1 - (1 - p) ** 3;
      const k = Math.exp(Math.log(from.k) + (Math.log(to.k) - Math.log(from.k)) * e);
      const cx = from.cx + (to.cx - from.cx) * e;
      const cy = from.cy + (to.cy - from.cy) * e;
      view.k = k;
      view.tx = cw / 2 - cx * k;
      view.ty = ch / 2 - cy * k;
      apply();
      if (p < 1) tween = requestAnimationFrame(step);
    };
    tween = requestAnimationFrame(step);
  };
  const fit = (animate = false) => moveTo(viewFor(bounds), animate);
  let autoButton;
  const autoFit = createAutoFit({
    storage, view, fit,
    changed: ({ enabled, paused }) => {
      if (!autoButton) return;
      saveMapView(viewKey, view);
      autoButton.textContent = paused ? 'Auto-fit paused' : 'Auto-fit';
      autoButton.setAttribute('aria-pressed', String(enabled));
      autoButton.title = paused ? 'Auto-fit paused by pan or zoom; click to resume' : enabled ? 'Turn auto-fit off' : 'Turn auto-fit on';
    },
  });
  const suspend = () => { cancelAnimationFrame(tween); autoFit.suspend(); };
  const zoomAt = (factor, cx, cy) => {
    cancelAnimationFrame(tween);
    const k = clampZoom(view.k * factor);
    view.tx = cx - ((cx - view.tx) * k) / view.k;
    view.ty = cy - ((cy - view.ty) * k) / view.k;
    view.k = k;
    suspend();
    apply();
  };
  const zoomCentre = (factor) => zoomAt(factor, el.clientWidth / 2, el.clientHeight / 2);

  const toWorld = (evt) => {
    const m = world.getScreenCTM();
    if (!m) return { x: 0, y: 0 };
    const pt = svg.createSVGPoint();
    pt.x = evt.clientX;
    pt.y = evt.clientY;
    return pt.matrixTransform(m.inverse());
  };

  const tileEls = new Map();
  const tiles = h('svg:g', { class: 'hive-tiles' });
  const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
  for (const it of sorted) {
    // Space for the relationship mark is reserved on every tile that has a
    // link (fixed by the data, so text never moves when the mark appears on
    // hover or selection); unlinked tiles use that space for their title.
    // The status and agent row is reserved when either mark is present.
    const rel = relations?.get(it.id);
    const linked = Boolean(rel && (rel.prereq.length || rel.dependents.length));
    const markScale = Math.max(1, size / 60);
    const marks = it.marks || (it.mark ? [it.mark] : []);
    const markAt = form.markY(markScale) - (marks.length > 1 ? 6 * markScale : 0);
    const focusWords = marks.filter(m => m.kind.startsWith('review-') || m.kind === 'recorded-wait' || m.kind === 'in-progress').map(m => m.title).join('\n');
    const label = tileText({
      title: it.titleText != null ? { text: it.titleText, maxLines: it.titleLines || 3, px: it.titlePx || 12 } : null,
      lines: it.lines,
      sub: it.sub,
      badge: it.badge,
      counters: it.counters,
      progress: it.progress,
      size,
      lh: it.lineHeight,
      half: form.half,
      bandTop: linked ? form.relY + REL_HALF + 1.5 : form.top,
      bandBottom: marks.length ? Math.min(form.bottom, markAt - (MARK_R + MARK_STROKE / 2) * markScale - 1.5) : form.bottom,
    });
    const g = h('svg:g', {
      class: `hive-hex ${it.classes || ''}${it.id === selectedId ? ' is-selected' : ''}`,
      transform: `translate(${it.x.toFixed(1)} ${it.y.toFixed(1)})`,
      tabindex: '0',
      role: 'button',
      'aria-label': it.ariaLabel,
      'aria-pressed': it.id === selectedId ? 'true' : 'false',
      'aria-haspopup': it.onMark ? 'dialog' : it.menu && onContextMenu ? 'menu' : null,
      dataset: { tileId: it.id },
    },
    h('svg:title', {}, it.title || it.ariaLabel || ''),
    h('svg:path', { d: shape, class: 'hive-hex-shape' }),
    form.faces ? h('svg:g', { class: 'hive-faces', 'aria-hidden': 'true', 'clip-path': `url(#${id}-faces)` }, form.faces.map((f) => h('svg:path', { d: f.d, class: f.className }))) : null,
    h('svg:path', { d: shape, class: 'hive-hex-rim' }),
    h('svg:path', { d: form.ring, class: 'hive-hex-ring' }),
    h('svg:path', { d: shape, class: 'hive-conversation-ring', 'aria-hidden': 'true' }),
    label.text);
    const mark = relations ? h('svg:g', { class: 'hive-rel-mark', transform: `translate(0 ${form.relY.toFixed(1)})` },
      h('svg:title', {}, ''),
      h('svg:rect', { class: 'hive-rel-mark-bg', y: '-7.5', height: '15', rx: '7.5' }),
      h('svg:text', { class: 'hive-rel-mark-text', 'text-anchor': 'middle', y: '4' })) : null;
    if (mark) g.append(mark);
    marks.forEach((m, i) => {
      const x = (i - (marks.length - 1) / 2) * 20 * markScale;
      const pm = primaryMark(m.kind, m.title, x, markAt, markScale);
      if (!pm) return;
      if (m.count > 1) pm.append(h('svg:circle', { cx: '6', cy: '-5', r: '4.5', class: 'hive-waiting-count-bg' }), h('svg:text', { x: '6', y: '-3', 'text-anchor': 'middle', class: 'hive-waiting-count' }, String(m.count)));
      if (m.onMark) {
        pm.style.cursor = 'pointer';
        pm.addEventListener('pointerdown', event => event.stopPropagation());
        pm.addEventListener('pointerup', event => event.stopPropagation());
        pm.addEventListener('click', event => { event.stopPropagation(); g.focus(); m.onMark(g); });
      }
      g.append(pm);
    });
    const menuAt = it.menu && onContextMenu ? (at) => {
      const c = el.getBoundingClientRect();
      const r = g.getBoundingClientRect();
      onContextMenu(it.id, at ? { x: at.x - c.left, y: at.y - c.top } : { x: r.left + r.width / 2 - c.left, y: r.bottom - c.top });
    } : null;
    wireTile({ g, it, toWorld, snap, onClick, onActivate, onSelect, onMove, onDrop, onDragState, claimDrag, menuAt, aid: () => dragAid });
    g.addEventListener('focus', () => {
      focusTip.textContent = focusWords;
      focusTip.hidden = !focusWords;
      if (focusWords) { g.setAttribute('aria-describedby', `${id}-mark-tip`); describedTile = g; }
    });
    g.addEventListener('blur', hideFocusTip);
    tileEls.set(it.id, { g, mark, it });
    tiles.append(g);
    const prior = previousPositions?.get(it.id);
    if (prior && (prior.x !== it.x || prior.y !== it.y) && !reducedMotion()) {
      g.animate?.([
        { transform: `translate(${prior.x}px, ${prior.y}px)` },
        { transform: `translate(${it.x}px, ${it.y}px)` },
      ], { duration: 240, easing: 'ease-out' });
    }
  }
  const outlineEls = new Map();
  if (outlines.length) {
    world.append(h('svg:g', { class: 'hive-groups', 'aria-hidden': 'true' }, outlines.map((o) => {
      const path = h('svg:path', { d: typeof o === 'string' ? o : o.d, class: `hive-group-outline ${typeof o === 'string' ? '' : o.className || ''}` });
      if (o?.headId) outlineEls.set(o.headId, path);
      return path;
    })));
  }
  const dropLayer = h('svg:g', { class: 'hive-drop', 'aria-hidden': 'true' });
  world.append(dropLayer, tiles);
  const place = (el, x, y) => el.setAttribute('transform', `translate(${x.toFixed(1)} ${y.toFixed(1)})`);
  let travelling = [];
  let travelOutlines = [];
  let dropKey = '';
  const dragAid = dragGroup || movePreview ? {
    start(tileId) {
      onDragStart(tileId);
      const g = dragGroup?.(tileId) || {};
      travelling = (g.ids || []).filter((o) => o !== tileId).map((o) => tileEls.get(o)).filter(Boolean);
      for (const t of travelling) t.g.classList.add('is-dragging', 'is-travelling');
      travelOutlines = (g.outlines || (g.outline ? [g.outline] : [])).map((id) => outlineEls.get(id)).filter(Boolean);
      for (const outline of travelOutlines) outline.classList.add('is-travelling');
      dropKey = '';
    },
    follow(it, p, target) {
      const dx = p.x - it.x;
      const dy = p.y - it.y;
      for (const t of travelling) place(t.g, t.it.x + dx, t.it.y + dy);
      for (const outline of travelOutlines) place(outline, dx, dy);
      if (!movePreview || key(target) === dropKey) return;
      dropKey = key(target);
      const plan = key(target) === key(it.local) ? null : movePreview(it.id, target);
      dropLayer.replaceChildren(...Object.values(plan?.moves || {}).map((pos) => {
        const at = toPixel(pos, size);
        return h('svg:use', { href: `#${id}-slot`, class: `hive-drop-slot${plan.ok || plan.pending ? '' : ' is-refused'}`, x: (at.x + (it.ox || 0)).toFixed(1), y: (at.y + (it.oy || 0)).toFixed(1) });
      }));
    },
    stop() {
      for (const t of travelling) {
        t.g.classList.remove('is-dragging', 'is-travelling');
        place(t.g, t.it.x, t.it.y);
      }
      for (const outline of travelOutlines) { outline.classList.remove('is-travelling'); outline.removeAttribute('transform'); }
      travelling = [];
      travelOutlines = [];
      dropKey = '';
      dropLayer.replaceChildren();
    },
  } : null;

  const setMark = (mark, text, tip) => {
    if (!mark) return;
    const [title, bg, label] = mark.children;
    label.textContent = text;
    title.textContent = tip;
    const w = Math.max(15, 8 + text.length * 8);
    bg.setAttribute('x', (-w / 2).toFixed(1));
    bg.setAttribute('width', w.toFixed(1));
    mark.classList.toggle('is-shown', Boolean(text));
  };
  const highlight = (focusId) => {
    if (!relations) return;
    for (const { g, mark } of tileEls.values()) {
      g.classList.remove('is-focus', 'is-prereq', 'is-dependent');
      setMark(mark, '', '');
    }
    const rel = focusId && tileEls.has(focusId) ? relations.get(focusId) : null;
    if (status) status.textContent = rel && describe ? describe(focusId) : '';
    if (!rel) return;
    tileEls.get(focusId).g.classList.add('is-focus');
    // Only blocking links are shown on the map. A tile can be both a
    // prerequisite and a dependent (a cycle); both directions are shown.
    // Tiles left off the map are counted but not lit.
    const kinds = new Map();
    for (const [ids, kind] of [[rel.prereq, 'prereq'], [rel.dependents, 'dependent']]) {
      for (const other of ids) {
        if (other === focusId) continue;
        if (!kinds.has(other)) kinds.set(other, new Set());
        kinds.get(other).add(kind);
      }
    }
    const shown = { prereq: 0, dependent: 0 };
    for (const [other, set] of kinds) {
      const t = tileEls.get(other);
      const list = ['prereq', 'dependent'].filter((k) => set.has(k));
      for (const k of list) {
        t?.g.classList.add(`is-${k}`);
        shown[k] += 1;
      }
      if (t) setMark(t.mark, list.map((k) => REL_MARK[k]).join(''), list.map((k) => REL_WORDS[k]).join('; '));
    }
    // The focused tile counts one mark per linked tile and direction,
    // whether or not that tile is shown.
    const counts = Object.entries(shown).filter(([, n]) => n);
    const f = tileEls.get(focusId);
    setMark(f.mark, counts.map(([k, n]) => `${REL_MARK[k]}${n}`).join(' '), counts.map(([k, n]) => `${n} ${REL_WORDS[k]}`).join('; '));
  };
  let highlightReference = () => {};
  if (relations) {
    let referencePointer = null, referenceFocus = null;
    let hovered = null;
    let focused = null;
    const refresh = () => highlight(referencePointer || hovered || referenceFocus || focused || selectedId);
    highlightReference = (id, source) => {
      if (source === 'pointer') referencePointer = id;
      else referenceFocus = id;
      refresh();
    };
    for (const [tid, { g }] of tileEls) {
      g.addEventListener('pointerenter', () => { hovered = tid; refresh(); });
      g.addEventListener('pointerleave', () => { if (hovered === tid) hovered = null; refresh(); });
      g.addEventListener('focus', () => { focused = tid; refresh(); });
      g.addEventListener('blur', () => { if (focused === tid) focused = null; refresh(); });
    }
    refresh();
  }

  wirePan({ el, svg, view, apply, onBackground, onDragState, claimDrag, zoomAt, suspend });
  el.addEventListener('focusin', (evt) => {
    const t = evt.target.closest?.('[data-tile-id]');
    if (!t) return;
    const r = t.getBoundingClientRect();
    const c = el.getBoundingClientRect();
    if (r.left >= c.left && r.right <= c.right && r.top >= c.top && r.bottom <= c.bottom) return;
    view.tx += c.left + c.width / 2 - (r.left + r.width / 2);
    view.ty += c.top + c.height / 2 - (r.top + r.height / 2);
    suspend();
    apply();
  });
  el.addEventListener('keydown', (evt) => {
    if (evt.target.closest?.('input, textarea, select')) return;
    if (evt.key === 'Escape' && !focusTip.hidden) { evt.preventDefault(); hideFocusTip(); }
    else if (evt.key === '+' || evt.key === '=') { evt.preventDefault(); zoomCentre(1.25); }
    else if (evt.key === '-' || evt.key === '_') { evt.preventDefault(); zoomCentre(0.8); }
    else if (evt.key === '0') { evt.preventDefault(); autoFit.resume(); }
  });

  autoButton = h('button', { type: 'button', class: 'hive-zoom-btn hive-zoom-fit hive-zoom-auto', onclick: () => autoFit.toggle() }, 'Auto-fit');
  autoFit.refresh();
  const tools = h('div', { class: 'hive-zoom', role: 'group', 'aria-label': 'Map view' },
    h('button', { type: 'button', class: 'hive-zoom-btn', 'aria-label': 'Zoom out', title: 'Zoom out (−)', onclick: () => zoomCentre(0.8) }, '−'),
    h('button', { type: 'button', class: 'hive-zoom-btn', 'aria-label': 'Zoom in', title: 'Zoom in (+)', onclick: () => zoomCentre(1.25) }, '+'),
    h('button', { type: 'button', class: 'hive-zoom-btn hive-zoom-fit', title: 'Fit everything in view (0)', onclick: () => { autoFit.resume(); } }, 'Fit'), autoButton);
  el.append(tools);

  let observer = null;
  el.hiveViewMounted = () => {
    if (!savedView) fit(false);
    else { apply(); autoFit.schedule(); }
    if (observer || typeof ResizeObserver !== 'function') return;
    observer = new ResizeObserver(() => {
      if (!el.isConnected) { el.hiveDisposeView(); return; }
      autoFit.schedule();
      ghostKey = ''; apply();
    });
    observer.observe(el);
  };
  el.hiveDisposeView = () => {
    observer?.disconnect();
    autoFit.dispose();
    cancelAnimationFrame(tween);
    cancelAnimationFrame(ghostFrame);
  };
  el.hiveCaptureView = () => ({ ...view });
  el.hiveRestoreView = saved => {
    if (!saved) return;
    cancelAnimationFrame(tween);
    Object.assign(view, saved);
    autoFit.refresh();
    apply();
  };
  el.hivePanTo = tileId => {
    cancelAnimationFrame(tween);
    const item = items.find(it => it.id === tileId);
    if (!item) return;
    view.k = Math.max(view.k, 0.8);
    view.tx = el.clientWidth / 2 - item.x * view.k;
    view.ty = el.clientHeight / 2 - item.y * view.k;
    suspend();
    apply();
  };
  el.hiveTileRect = (tileId) => el.querySelector(`[data-tile-id="${CSS.escape(tileId)}"]`)?.getBoundingClientRect() || null;
  apply();
  return { el, highlightReference };
}

function wirePan({ el, svg, view, apply, onBackground, onDragState, claimDrag, zoomAt, suspend }) {
  let start = null;
  let panning = false;
  let unclaim = null;
  const finish = () => {
    if (unclaim) { try { unclaim(); } catch { } unclaim = null; }
    const was = panning;
    panning = false;
    start = null;
    el.classList.remove('is-panning');
    if (was) onDragState(false);
  };
  svg.addEventListener('pointerdown', (evt) => {
    if (evt.button !== 0 || evt.target.closest('[data-tile-id]')) return;
    start = { x: evt.clientX, y: evt.clientY, tx: view.tx, ty: view.ty };
    try { svg.setPointerCapture(evt.pointerId); } catch { }
  });
  svg.addEventListener('pointermove', (evt) => {
    if (!start) return;
    const dx = evt.clientX - start.x;
    const dy = evt.clientY - start.y;
    if (!panning && Math.hypot(dx, dy) < 3) return;
    if (!panning) {
      panning = true;
      el.classList.add('is-panning');
      onDragState(true);
      if (claimDrag) { try { unclaim = claimDrag(svg); } catch { unclaim = null; } }
    }
    view.tx = start.tx + dx;
    view.ty = start.ty + dy;
    suspend();
    apply();
  });
  svg.addEventListener('pointerup', (evt) => {
    if (!start) return;
    const was = panning;
    finish();
    if (was) return;
    const r = el.getBoundingClientRect();
    onBackground?.({ x: evt.clientX - r.left, y: evt.clientY - r.top });
  });
  svg.addEventListener('pointercancel', finish);
  el.addEventListener('wheel', (evt) => {
    evt.preventDefault();
    const unit = evt.deltaMode === 1 ? 16 : evt.deltaMode === 2 ? el.clientHeight : 1;
    if (evt.ctrlKey || evt.metaKey) {
      const r = el.getBoundingClientRect();
      zoomAt(Math.exp(-evt.deltaY * unit * 0.008), evt.clientX - r.left, evt.clientY - r.top);
      return;
    }
    view.tx -= evt.deltaX * unit;
    view.ty -= evt.deltaY * unit;
    suspend();
    apply();
  }, { passive: false });
}

function wireTile({ g, it, toWorld, snap, onClick, onActivate, onSelect, onMove, onDrop, onDragState, claimDrag, menuAt, aid }) {
  let start = null;
  let dragging = false;
  let unclaim = null;
  let pointer = '';
  const home = `translate(${it.x.toFixed(1)} ${it.y.toFixed(1)})`;
  const end = () => {
    if (unclaim) { try { unclaim(); } catch { } unclaim = null; }
    if (dragging) aid()?.stop();
    if (dragging) onDragState(false);
    dragging = false;
    start = null;
    g.classList.remove('is-dragging');
  };
  g.addEventListener('pointerdown', (evt) => {
    pointer = evt.pointerType;
    if (evt.button !== 0) return;
    evt.stopPropagation();
    for (const animation of g.getAnimations?.() || []) animation.cancel();
    start = { x: evt.clientX, y: evt.clientY };
    try { g.setPointerCapture(evt.pointerId); } catch { }
  });
  g.addEventListener('pointermove', (evt) => {
    if (!start || !onMove || !it.local) return;
    if (!dragging && Math.hypot(evt.clientX - start.x, evt.clientY - start.y) < DRAG_THRESHOLD) return;
    if (!dragging) {
      dragging = true;
      g.classList.add('is-dragging');
      onDragState(true);
      if (claimDrag) { try { unclaim = claimDrag(g); } catch { unclaim = null; } }
      aid()?.start(it.id);
    }
    const p = toWorld(evt);
    g.setAttribute('transform', `translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})`);
    aid()?.follow(it, p, snap({ x: p.x - (it.ox || 0), y: p.y - (it.oy || 0) }));
  });
  g.addEventListener('pointerup', (evt) => {
    if (!start) return;
    const wasDragging = dragging;
    const p = wasDragging ? toWorld(evt) : null;
    end();
    if (!wasDragging) {
      (onClick || onSelect)?.(it.id);
      return;
    }
    const target = snap({ x: p.x - (it.ox || 0), y: p.y - (it.oy || 0) });
    if (key(target) === key(it.local)) {
      g.setAttribute('transform', home);
      return;
    }
    (onDrop || onMove)(it.id, target);
  });
  g.addEventListener('pointercancel', () => {
    end();
    g.setAttribute('transform', home);
  });
  if (menuAt) {
    g.addEventListener('contextmenu', (evt) => {
      if (pointer === 'touch') return;
      evt.preventDefault();
      evt.stopPropagation();
      const wasDragging = dragging;
      end();
      if (wasDragging) { g.setAttribute('transform', home); return; }
      menuAt(evt.button === 2 || evt.clientX || evt.clientY ? { x: evt.clientX, y: evt.clientY } : null);
    });
  }
  g.addEventListener('keydown', (evt) => {
    if (menuAt && (evt.key === 'ContextMenu' || (evt.shiftKey && evt.key === 'F10'))) {
      evt.preventDefault();
      menuAt(null);
    } else if (evt.key === 'Enter') {
      evt.preventDefault();
      (onActivate || onSelect)?.(it.id);
    } else if (evt.key === ' ') {
      evt.preventDefault();
      onSelect?.(it.id);
    } else if (evt.shiftKey && onMove && it.local && evt.key in DIRECTIONS) {
      evt.preventDefault();
      onMove(it.id, neighbour(it.local, DIRECTIONS[evt.key]));
    }
  });
}
