const SQRT3 = Math.sqrt(3);
const DIRS = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];

export const key = (p) => `${p.q},${p.r}`;

export function toPixel({ q, r }, size) {
  return { x: size * SQRT3 * (q + r / 2), y: size * 1.5 * r };
}

export function fromPixel({ x, y }, size) {
  const q = ((SQRT3 / 3) * x - (1 / 3) * y) / size;
  const r = ((2 / 3) * y) / size;
  return cubeRound(q, r);
}

function cubeRound(fq, fr) {
  const fs = -fq - fr;
  let q = Math.round(fq);
  let r = Math.round(fr);
  const s = Math.round(fs);
  const dq = Math.abs(q - fq);
  const dr = Math.abs(r - fr);
  const ds = Math.abs(s - fs);
  if (dq > dr && dq > ds) q = -r - s;
  else if (dr > ds) r = -q - s;
  return { q: q + 0, r: r + 0 };
}

export function neighbour(p, dir) {
  const [dq, dr] = DIRS[dir];
  return { q: p.q + dq, r: p.r + dr };
}

export function nearestFree(start, taken) {
  if (!taken.has(key(start))) return start;
  for (let radius = 1; radius < 200; radius += 1) {
    let p = { q: start.q + DIRS[4][0] * radius, r: start.r + DIRS[4][1] * radius };
    for (let side = 0; side < 6; side += 1) {
      for (let i = 0; i < radius; i += 1) {
        if (!taken.has(key(p))) return p;
        p = neighbour(p, side);
      }
    }
  }
  return { q: start.q + 200, r: start.r };
}

// Automatic placement takes hexes in order of an elliptical distance, by
// default about twice as wide as it is tall, so a growing comb spreads into a
// compact wide shape rather than a tall stack or one long row. A cell can
// store another ratio when someone presses Arrange; it is never read from the
// window, so resizing never moves anything. Saved positions are never passed
// through this.
export const LANDSCAPE = 2;
export const ASPECT_MIN = 0.6;
export const ASPECT_MAX = 3.5;

export function normalAspect(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return LANDSCAPE;
  return Math.round(Math.min(ASPECT_MAX, Math.max(ASPECT_MIN, n)) * 10) / 10;
}
const offsetCache = new Map();

// One list per aspect, the longest computed so far: a longer list's prefix is
// every shorter one, so smaller sizes are never kept separately. A miss
// computes double what is asked, so a growing count recomputes only rarely.
export function landscapeOffsets(count, aspect = LANDSCAPE) {
  const want = Math.max(1, count);
  const cached = offsetCache.get(aspect);
  if (cached && cached.length >= want) return cached.slice(0, want);
  const size = Math.max(64, want * 2);
  const radius = Math.ceil(Math.sqrt(size) * Math.max(aspect, 1 / aspect)) + 2;
  const all = [];
  for (let q = -radius * 2; q <= radius * 2; q += 1) {
    for (let r = -radius; r <= radius; r += 1) {
      const x = Math.sqrt(3) * (q + r / 2);
      const y = 1.5 * r;
      all.push({ q, r, d: (x / aspect) ** 2 + y ** 2, a: Math.atan2(y, x) });
    }
  }
  all.sort((m, n) => m.d - n.d || m.a - n.a);
  const list = all.slice(0, size).map(({ q, r }) => ({ q, r }));
  offsetCache.set(aspect, list);
  return list.slice(0, want);
}

export function landscapeAround(centre, count, aspect = LANDSCAPE) {
  return landscapeOffsets(count, aspect).map((o) => ({ q: centre.q + o.q, r: centre.r + o.r }));
}

export function nearestFreeLandscape(start, taken, aspect = LANDSCAPE) {
  for (let n = 64; n <= 16384; n *= 4) {
    for (const o of landscapeOffsets(n, aspect)) {
      const p = { q: start.q + o.q, r: start.r + o.r };
      if (!taken.has(key(p))) return p;
    }
  }
  return nearestFree(start, taken);
}

export function pixelBounds(points, size) {
  if (!points.length) return { x: -size * 2, y: -size * 2, width: size * 4, height: size * 4 };
  let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity;
  for (const p of points) {
    const { x, y } = toPixel(p, size);
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  const pad = size * 1.6;
  return { x: minX - pad, y: minY - pad, width: maxX - minX + pad * 2, height: maxY - minY + pad * 2 };
}

export const DIRECTIONS = { ArrowRight: 0, ArrowUp: 2, ArrowLeft: 3, ArrowDown: 5 };

const point = (k) => {
  const [q, r] = k.split(',').map(Number);
  return { q, r };
};

export function haloOf(points) {
  const out = new Map();
  for (const p of points) {
    out.set(key(p), p);
    for (let d = 0; d < 6; d += 1) {
      const n = neighbour(p, d);
      out.set(key(n), n);
    }
  }
  return [...out.values()];
}

export class Occupancy {
  constructor(ownerOf = () => null) {
    this.at = new Map();
    this.ownerOf = ownerOf;
  }

  taken(id) {
    return this.view(this.ownerOf(id));
  }

  view(owner) {
    const at = this.at;
    const clear = (k) => {
      if (at.has(k)) return false;
      const p = point(k);
      for (let d = 0; d < 6; d += 1) {
        const o = at.get(key(neighbour(p, d)));
        if (o !== undefined && o !== owner) return false;
      }
      return true;
    };
    return {
      has: (k) => !clear(k),
      occupied: (k) => at.has(k),
      add: (k) => { at.set(k, owner); },
      delete: (k) => { at.delete(k); },
      blocked: () => haloOf([...at].filter(([, o]) => o !== owner).map(([k]) => point(k)))
        .concat([...at].filter(([, o]) => o === owner).map(([k]) => point(k))),
      rest: () => haloOf([...at].filter(([, o]) => o !== owner).map(([k]) => point(k))),
      [Symbol.iterator]: function* () { yield* at.keys(); },
    };
  }

  claim(id, p) {
    this.at.set(key(p), this.ownerOf(id));
  }

  occupied(p) {
    return this.at.has(key(p));
  }
}

export const blockedPoints = (taken) => (taken.blocked ? taken.blocked() : [...taken].map(point));

export const restPoints = (taken, own) => (taken.rest ? taken.rest() : [...taken].filter((k) => !own.has(k)).map(point));

export const occupiedIn = (taken, k) => (taken.occupied ? taken.occupied(k) : taken.has(k));
