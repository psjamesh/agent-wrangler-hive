import { pullDetachedChains } from './hidden-placement.js';
import { growAttachedRegion } from './region-growth.js';
import { attachmentState } from './region-attachments.js';
import { neighbour, key, toPixel, landscapeOffsets, nearestFreeLandscape, normalAspect, Occupancy, blockedPoints } from './hex-layout.js';
import { growPatch } from './hex-growth.js';
import { nearestFree, inRange } from './hex-search.js';

export { WORKSTREAM_COLOURS, workstreamColour, workstreamClasses } from './workstream-colours.js';

const byCreated = (a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')) || a.id.localeCompare(b.id);

const layouts = new Map();
const CACHE_LIMIT = 32;

function copyLayout(value) {
  if (value instanceof Set) return new Set(value);
  if (Array.isArray(value)) return value.map(copyLayout);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, copyLayout(v)]));
  return value;
}

export function layoutCell({ kids, rootId, saved = {}, aspect, yieldIds = new Set(), hidden = new Set(), detachedPinned = new Set(), snapshotComplete = true, fallback = false }) {
  const ratio = normalAspect(aspect);
  const cacheKey = JSON.stringify([
    rootId, ratio, snapshotComplete, fallback,
    [...kids].map(([parent, children]) => [parent, children.map(b => [b.id, b.parentId, b.kind, b.createdAt])]).sort(([a], [b]) => a.localeCompare(b)),
    Object.keys(saved).sort().map(id => [id, saved[id]]),
    [...yieldIds].sort(), [...hidden].sort(), [...detachedPinned].sort(),
  ]);
  if (layouts.has(cacheKey)) {
    const cached = layouts.get(cacheKey);
    layouts.delete(cacheKey);
    layouts.set(cacheKey, cached);
    return copyLayout(cached);
  }
  const seen = new Set([rootId]);
  const groupHeads = [];
  const group = {};
  const loose = [];
  const patches = [];
  const byHead = new Map();
  const parents = {};
  const visit = (parentId, regionId) => {
    const children = (kids.get(parentId) || []).filter((c) => !seen.has(c.id)).sort(byCreated);
    for (const c of children) seen.add(c.id);
    for (const c of children) {
      const isHead = c.kind === 'workstream' || (kids.get(c.id) || []).some((k) => !seen.has(k.id));
      if (isHead) {
        groupHeads.push(c.id);
        parents[c.id] = regionId;
        group[c.id] = c.id;
        const members = [c.id];
        patches.push(members);
        byHead.set(c.id, members);
        visit(c.id, c.id);
      } else {
        group[c.id] = regionId;
        if (regionId) byHead.get(regionId).push(c.id);
        else loose.push(c.id);
      }
    }
  };
  visit(rootId, null);

  const positions = {};
  const topOf = (id) => {
    let head = group[id];
    while (head && parents[head]) head = parents[head];
    return head || id;
  };
  const occ = new Occupancy(topOf);
  const all = [...loose, ...patches.flat()];
  const later = [];
  const hiddenIds = all.filter((id) => hidden.has(id));
  const carried = Object.fromEntries(hiddenIds.filter((id) => saved[id]).map((id) => [id, { ...saved[id] }]));
  const automatic = new Set();
  const free = (start, id) => {
    if (!fallback) return nearestFreeLandscape(start, occ.taken(id), ratio);
    const busy = blockedPoints(occ.taken(id));
    const off = nearestFree([start], busy);
    return { q: start.q + off.q, r: start.r + off.r };
  };
  for (const yields of [false, true]) {
    for (const id of all) {
      if (hidden.has(id)) continue;
      if (yieldIds.has(id) !== yields) continue;
      const p = saved[id];
      if (!p || !Number.isInteger(p.q) || !Number.isInteger(p.r) || (fallback && !inRange(p))) continue;
      if (!occ.occupied(p)) {
        positions[id] = { q: p.q, r: p.r };
        occ.claim(id, p);
      } else if (yields) {
        later.push(id);
      }
    }
  }
  const skip = new Set(hiddenIds);
  const claim = (id, p) => occ.claim(id, p);
  const origin = { q: 0, r: 0 };
  for (const id of loose) {
    if (positions[id] || skip.has(id)) continue;
    const p = free(origin, id);
    positions[id] = p;
    claim(id, p);
  }
  for (const members of patches) {
    const todo = members.filter((id) => !positions[id] && !skip.has(id));
    if (!todo.length) continue;
    if (fallback) {
      const anchor = positions[members[0]] || positions[parents[members[0]]] || origin;
      for (const id of todo) { positions[id] = free(anchor, id); claim(id, positions[id]); }
      continue;
    }
    const skeleton = {order:all,positions,parentHead:group,groupHeads,regionParents:parents,rootId};
    if (growAttachedRegion({ members, todo, layout:skeleton, kids, taken: occ.taken(members[0]), aspect:ratio, carried, automatic, hidden })) continue;
    if (growPatch({ members, todo, positions, taken: occ.taken(members[0]), aspect: ratio, carried, automatic })) continue;
    const shape = landscapeOffsets(todo.length, ratio);
    const anchor = positions[parents[members[0]]] || origin;
    const wanted = shape.map((o) => ({ q: anchor.q + o.q, r: anchor.r + o.r }));
    const occupied = blockedPoints(occ.taken(members[0]));
    const shift = nearestFree(wanted, occupied);
    todo.forEach((id, i) => {
      positions[id] = { q: wanted[i].q + shift.q, r: wanted[i].r + shift.r };
      claim(id, positions[id]);
    });
  }
  for (const id of [...later, ...hiddenIds]) {
    if (!hidden.has(id) && positions[id]) continue;
    const start = carried[id] || saved[id] || positions[group[id]] || origin;
    if (hidden.has(id) && saved[id] && (occ.occupied(start) || key(start) !== key(saved[id]))) later.push(id);
    const exact = carried[id] || saved[id];
    const p = exact && Number.isInteger(exact.q) && Number.isInteger(exact.r) && !occ.occupied(exact) ? { q: exact.q, r: exact.r } : free(start, id);
    positions[id] = p;
    claim(id, p);
  }
  const halo = {};
  patches.forEach((members, i) => { for (const id of members) halo[id] = i; });
  const layout = { order: all, positions, halo, patchHeads: patches.map((members) => members[0]), parentHead: group, groupHeads, regionParents: parents, rootId, snapshotComplete, fallback, detachedPinned: new Set(detachedPinned), yielded: later, carried, automatic: Object.fromEntries([...automatic].map((id) => [id, carried[id] || positions[id]])) };
  if (snapshotComplete && !fallback) {
    const moves = pullDetachedChains(layout, kids, hidden);
    Object.assign(layout.positions, moves);
    Object.assign(layout.automatic, moves);
  }
  layout.attachments = attachmentState(layout, kids, positions, hidden).attachments;
  layout.detachedHeads = Object.keys(layout.attachments).filter((id) => layout.attachments[id].status === 'detached');
  const present = new Set(layout.order), detached = new Set(layout.detachedHeads);
  layout.detachedPinned = new Set([...layout.detachedPinned].filter((id) => !snapshotComplete || !present.has(id) || detached.has(id)));
  layouts.set(cacheKey, copyLayout(layout));
  if (layouts.size > CACHE_LIMIT) layouts.delete(layouts.keys().next().value);
  return layout;
}

// Pure. One SVG path per region, tracing the outside of its
// member hexes through the gaps of the comb. Only the group's own hexes are
// enclosed, so an outline never takes in another group; members placed apart
// by hand get one loop each.
export function groupOutlines(layout, size) {
  const groups = new Map();
  for (const [id, i] of Object.entries(layout.halo)) {
    if (!layout.positions[id]) continue;
    if (!groups.has(i)) groups.set(i, new Set());
    groups.get(i).add(key(layout.positions[id]));
  }
  const pt = (x, y) => `${Math.round(x * 10) / 10 + 0},${Math.round(y * 10) / 10 + 0}`;
  const out = [];
  for (const [i, members] of groups) {
    const next = new Map();
    for (const k of members) {
      const [q, r] = k.split(',').map(Number);
      const c = toPixel({ q, r }, size);
      for (let d = 0; d < 6; d += 1) {
        const nb = neighbour({ q, r }, d);
        if (members.has(key(nb))) continue;
        const n = toPixel(nb, size);
        const len = Math.hypot(n.x - c.x, n.y - c.y);
        const ux = (n.x - c.x) / len;
        const uy = (n.y - c.y) / len;
        const mx = (c.x + n.x) / 2;
        const my = (c.y + n.y) / 2;
        const a = pt(mx - uy * size / 2, my + ux * size / 2);
        const b = pt(mx + uy * size / 2, my - ux * size / 2);
        if (!next.has(a)) next.set(a, []);
        next.get(a).push(b);
      }
    }
    let d = '';
    for (const [startKey, ends] of next) {
      while (ends.length) {
        const loop = [startKey];
        let at = ends.pop();
        while (at !== startKey) {
          loop.push(at);
          const more = next.get(at);
          if (!more?.length) break;
          at = more.pop();
        }
        d += roundedLoop(loop.map((k) => k.split(',').map(Number)));
      }
    }
    out.push({ group: i, headId: layout.patchHeads?.[i] ?? null, d });
  }
  return out;
}

const CORNER = 0.09;

function roundedLoop(pts) {
  const n = pts.length;
  const f = (v) => Math.round(v * 10) / 10 + 0;
  let d = '';
  for (let i = 0; i < n; i += 1) {
    const [px, py] = pts[i];
    const [ax, ay] = pts[(i + n - 1) % n];
    const [bx, by] = pts[(i + 1) % n];
    d += `${i ? 'L' : 'M'}${f(px + (ax - px) * CORNER)},${f(py + (ay - py) * CORNER)}`;
    d += `Q${f(px)},${f(py)} ${f(px + (bx - px) * CORNER)},${f(py + (by - py) * CORNER)}`;
  }
  return `${d}Z`;
}
