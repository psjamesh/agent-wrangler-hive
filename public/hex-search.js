// Shared by the map and the server. The map has no edge in practice, but
// every coordinate stays within ±MAX_COORD so all arithmetic on it, and on
// the pixels drawn from it, stays exact.
export const MAX_COORD = 2 ** 30;

export const inRange = (p) => Boolean(p) && Number.isSafeInteger(p.q) && Number.isSafeInteger(p.r)
  && Math.abs(p.q) <= MAX_COORD && Math.abs(p.r) <= MAX_COORD;

export const span = (o) => Math.max(Math.abs(o.q), Math.abs(o.r), Math.abs(o.q + o.r));

const START = 32;
const CEIL = 256;

function runsOf(shape) {
  const rows = new Map();
  for (const p of shape) {
    if (!rows.has(p.r)) rows.set(p.r, []);
    rows.get(p.r).push(p.q);
  }
  const runs = [];
  for (const [r, qs] of rows) {
    qs.sort((a, b) => a - b);
    for (let i = 0; i < qs.length;) {
      let j = i;
      while (j + 1 < qs.length && qs[j + 1] <= qs[j] + 1) j += 1;
      runs.push({ r, a: qs[i], b: qs[j] });
      i = j + 1;
    }
  }
  return runs;
}

// The shifts in `win` that put some hex of a rule's shape on that rule's
// taken hexes. Only taken hexes that can block a shift this close are
// visited, so far-off work costs nothing.
function windowGrid(rules, win) {
  const { q0, q1, r0, r1 } = win;
  const w = q1 - q0 + 1;
  const diff = new Int32Array((w + 1) * (r1 - r0 + 1));
  for (const { runs, taken, lo, hi } of rules) {
    for (const t of taken) {
      if (t.r - hi.r > r1 || t.r - lo.r < r0 || t.q - hi.q > q1 || t.q - lo.q < q0) continue;
      for (const run of runs) {
        const y = t.r - run.r;
        if (y < r0 || y > r1) continue;
        const a = Math.max(q0, t.q - run.b);
        const b = Math.min(q1, t.q - run.a);
        if (a > b) continue;
        diff[(y - r0) * (w + 1) + a - q0] += 1;
        diff[(y - r0) * (w + 1) + b - q0 + 1] -= 1;
      }
    }
  }
  const blocked = new Uint8Array(w * (r1 - r0 + 1));
  for (let y = 0; y <= r1 - r0; y += 1) {
    let run = 0;
    for (let x = 0; x < w; x += 1) {
      run += diff[y * (w + 1) + x];
      if (run) blocked[y * w + x] = 1;
    }
  }
  return (q, r) => !blocked[(r - r0) * w + (q - q0)];
}

function lowerBound(list, x) {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// The nearest free shifts past CEIL rings, one or two per row, nearest
// first. Rows are visited outward from no shift and each row's blocked
// stretches are built only from the taken rows that can reach it, so the
// cost follows the work near the shapes. A row with nothing blocked is free
// at its nearest point, so the scan stops one row past the nearest find.
function rowShifts(rules, legal) {
  const sets = [];
  for (const { shape, taken } of rules) {
    if (!taken.length) continue;
    const byRow = new Map();
    for (const t of taken) {
      if (!byRow.has(t.r)) byRow.set(t.r, []);
      byRow.get(t.r).push(t.q);
    }
    const shapeRows = new Map();
    for (const run of runsOf(shape)) {
      if (!shapeRows.has(run.r)) shapeRows.set(run.r, []);
      shapeRows.get(run.r).push(run);
    }
    const rs = [...shapeRows.keys()];
    sets.push({ byRow, rows: [...byRow.keys()].sort((m, n) => m - n), shapeRows, s0: Math.min(...rs), s1: Math.max(...rs) });
  }
  const blockedIn = (y) => {
    const spans = [];
    for (const { byRow, rows, shapeRows, s0, s1 } of sets) {
      for (let i = lowerBound(rows, y + s0); i < rows.length && rows[i] <= y + s1; i += 1) {
        const runs = shapeRows.get(rows[i] - y);
        if (!runs) continue;
        for (const q of byRow.get(rows[i])) for (const run of runs) spans.push([q - run.b, q - run.a]);
      }
    }
    spans.sort((m, n) => m[0] - n[0]);
    const merged = [];
    for (const [a, b] of spans) {
      const top = merged[merged.length - 1];
      if (top && a <= top[1] + 1) top[1] = Math.max(top[1], b);
      else merged.push([a, b]);
    }
    return merged;
  };
  const out = [];
  let best = Infinity;
  const visit = (y) => {
    const merged = blockedIn(y);
    const z0 = Math.min(0, -y);
    const z1 = Math.max(0, -y);
    const inner = Math.abs(y) <= CEIL;
    let right = Math.max(z0, legal.q0, inner ? Math.min(CEIL, CEIL - y) + 1 : -Infinity);
    for (const [a, b] of merged) if (a <= right && right <= b) right = b + 1;
    let left = Math.min(z1, legal.q1, inner ? Math.max(-CEIL, -CEIL - y) - 1 : Infinity);
    for (let i = merged.length - 1; i >= 0; i -= 1) if (merged[i][0] <= left && left <= merged[i][1]) left = merged[i][0] - 1;
    for (const q of new Set([right, left])) {
      if (q < legal.q0 || q > legal.q1) continue;
      out.push({ q, r: y });
      best = Math.min(best, span({ q, r: y }));
    }
  };
  const from = legal.r0 > 0 ? legal.r0 : legal.r1 < 0 ? -legal.r1 : 0;
  for (let d = from; d <= best; d += 1) {
    const ys = d ? [d, -d] : [0];
    const inside = ys.filter((y) => y >= legal.r0 && y <= legal.r1);
    if (!inside.length && (d > legal.r1 && -d < legal.r0)) break;
    for (const y of inside) visit(y);
  }
  return out;
}

function ring(k) {
  if (!k) return [{ q: 0, r: 0 }];
  const out = [];
  for (let q = -k; q <= k; q += 1) {
    const a = Math.max(-k, -q - k);
    const b = Math.min(k, -q + k);
    if (Math.abs(q) === k) for (let r = a; r <= b; r += 1) out.push({ q, r });
    else out.push({ q, r: a }, { q, r: b });
  }
  return out;
}

// Whole shifts that put no hex of any rule's `shape` on that rule's `taken`
// hexes (points) and keep them all within ±MAX_COORD, nearest first. Within
// CEIL rings every such shift comes, ring by ring, with `rank` ordering each
// ring, from a window that never passes CEIL. Past them come the nearest free
// shifts of each row, so the first one is always the nearest free shift in
// range. It yields nothing only when no shift in range is free.
export function* freeShifts(rules, { rank = null } = {}) {
  const live = rules.filter((x) => x.shape.length);
  if (!live.length) return;
  const box = (list) => list.reduce((b, p) => ({ lo: { q: Math.min(b.lo.q, p.q), r: Math.min(b.lo.r, p.r) }, hi: { q: Math.max(b.hi.q, p.q), r: Math.max(b.hi.r, p.r) } }), { lo: { q: Infinity, r: Infinity }, hi: { q: -Infinity, r: -Infinity } });
  const prepared = live.map((x) => ({ runs: runsOf(x.shape), taken: x.taken, ...box(x.shape) }));
  const { lo, hi } = box(live.flatMap((x) => x.shape));
  const legal = { q0: -MAX_COORD - lo.q, q1: MAX_COORD - hi.q, r0: -MAX_COORD - lo.r, r1: MAX_COORD - hi.r };
  if (legal.q0 > legal.q1 || legal.r0 > legal.r1) return;
  const fits = (o) => o.q >= legal.q0 && o.q <= legal.q1 && o.r >= legal.r0 && o.r <= legal.r1;
  const last = Math.max(...[[legal.q0, legal.r0], [legal.q0, legal.r1], [legal.q1, legal.r0], [legal.q1, legal.r1]].map(([q, r]) => span({ q, r })));
  const near = Math.min(last, CEIL);
  const windowOf = (R) => ({ q0: Math.max(-R, legal.q0), q1: Math.min(R, legal.q1), r0: Math.max(-R, legal.r0), r1: Math.min(R, legal.r1) });
  let R = Math.min(START, CEIL);
  let free = windowGrid(prepared, windowOf(R));
  for (let k = 0; k <= near; k += 1) {
    if (k > R) {
      R = Math.min(R * 2, CEIL);
      free = windowGrid(prepared, windowOf(R));
    }
    const found = ring(k).filter((o) => fits(o) && free(o.q, o.r));
    if (rank) found.sort((m, n) => rank(m) - rank(n));
    yield* found;
  }
  if (last <= CEIL) return;
  const far = rowShifts(live, legal);
  far.sort((m, n) => span(m) - span(n) || (rank ? rank(m) - rank(n) : 0));
  yield* far;
}

export function nearestFree(shape, taken) {
  for (const o of freeShifts([{ shape, taken }])) return o;
  return null;
}
