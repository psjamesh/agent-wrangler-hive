import { key, neighbour } from './hex-layout.js';
import { inRange, span } from './hex-search.js';

const corners = [[0, -2], [1, -1], [1, 1], [0, 2], [-1, 1], [-1, -1]];
const sides = [1, 0, 5, 4, 3, 2];
const pointKey = ([x, y]) => `${x},${y}`;

function inside(p, polygon) {
  const x = 2 * p.q + p.r, y = 3 * p.r;
  let result = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [ax, ay] = polygon[i], [bx, by] = polygon[j];
    if ((ay > y) !== (by > y) && x < (bx - ax) * (y - ay) / (by - ay) + ax) result = !result;
  }
  return result;
}

export function regionBoundary(points) {
  const own = new Set(points.map(key));
  const frontier = new Map(), edges = new Map();
  for (const p of points) for (let d = 0; d < 6; d++) {
    const nb = neighbour(p, d);
    if (own.has(key(nb))) continue;
    if (inRange(nb)) frontier.set(key(nb), nb);
    const v = sides[d];
    const at = (i) => [2 * p.q + p.r + corners[i][0], 3 * p.r + corners[i][1]];
    const a = at(v), b = at((v + 1) % 6);
    edges.set(pointKey(a), { a, b });
  }
  const holes = [];
  while (edges.size) {
    const first = edges.values().next().value;
    const polygon = [first.a];
    let edge = first;
    do {
      edges.delete(pointKey(edge.a));
      polygon.push(edge.b);
      edge = edges.get(pointKey(edge.b));
    } while (edge && edge !== first);
    const [ox, oy] = polygon[0];
    let area = 0;
    for (let i = 1; i < polygon.length; i++) {
      const [ax, ay] = polygon[i - 1], [bx, by] = polygon[i];
      area += (ax - ox) * (by - oy) - (bx - ox) * (ay - oy);
    }
    if (area < 0) holes.push(polygon);
  }
  const outside = (p) => !holes.some((polygon) => inside(p, polygon));
  const exterior = new Map([...frontier].filter(([, p]) => outside(p)));
  return { exterior, outside, frontier };
}

export function subtreeMembers(layout, kids, headId) {
  const through = new Set(layout.through || layout.order), onMap = new Set(layout.order);
  const seen = new Set([headId]), stack = [headId];
  while (stack.length) for (const c of kids.get(stack.pop()) || []) {
    if (!through.has(c.id) || seen.has(c.id)) continue;
    seen.add(c.id);
    stack.push(c.id);
  }
  return new Set([...seen].filter((id) => onMap.has(id)));
}

export function attachmentState(layout, kids, positions = layout.positions, hidden = new Set()) {
  const heads = new Set(layout.groupHeads || []);
  const parents = layout.regionParents || Object.fromEntries([...kids].flatMap(([parent, children]) => children.filter((b) => heads.has(b.id)).map((b) => [b.id, heads.has(parent) ? parent : null])));
  const groups = new Map([...heads].map((id) => [id, []]));
  for (const id of layout.order) {
    const head = layout.parentHead?.[id];
    if (groups.has(head) && positions[id] && !hidden.has(id)) groups.get(head).push(positions[id]);
  }
  const familyBounds = new Map(), attachments = {};
  for (const head of heads) {
    const parent = parents[head];
    if (!parent) continue;
    const ownBranch = subtreeMembers(layout,kids,head);
    const family = subtreeMembers(layout,kids,parent);
    const allowed = new Map();
    for (const id of family) {
      if (ownBranch.has(id) || hidden.has(id) || !positions[id]) continue;
      allowed.set(key(positions[id]),{p:positions[id],owner:layout.parentHead[id]});
    }
    const reached = new Map(), queue = [...(groups.get(parent)||[])];
    for (const p of queue) reached.set(key(p),p);
    for (let i=0;i<queue.length;i++) for (let d=0;d<6;d++) {
      const nb=neighbour(queue[i],d), entry=allowed.get(key(nb));
      if (entry && !reached.has(key(nb))) { reached.set(key(nb),entry.p);queue.push(entry.p); }
    }
    const border = regionBoundary([...reached.values()]);
    familyBounds.set(head,border);
    const pts=groups.get(head)||[];
    const contacts=pts.filter((p)=>border.exterior.has(key(p)));
    let status='detached',via=null;
    if (contacts.length && pts.every(border.outside)) {
      const owners=[];
      for (const p of contacts) for(let d=0;d<6;d++) {
        const k=key(neighbour(p,d));
        if(reached.has(k) && allowed.has(k)) owners.push(allowed.get(k).owner);
      }
      status=owners.includes(parent)?'direct':'sibling';
      if(status==='sibling') via=owners[0];
    }
    attachments[head]={parentId:parent,status,via};
  }
  return { parents, groups, familyBounds, attachments };
}

export function preservesAttachments(layout, kids, positions, hidden = new Set(), requireHead = null, beforeHidden = hidden, baseline = null) {
  const before = baseline?.attachments || attachmentState(layout, kids, layout.positions, beforeHidden).attachments;
  const after = attachmentState(layout, kids, positions, hidden).attachments;
  return Object.entries(after).every(([head, state]) => state.status !== 'detached' || (before[head]?.status === 'detached' && head !== requireHead));
}

export function attachedCandidates(points, border, anchor) {
  const ownKeys = new Set(points.map(key));
  const edge = points.filter((p) => [0, 1, 2, 3, 4, 5].some((d) => !ownKeys.has(key(neighbour(p, d)))));
  const unique = new Set();
  return (function* () {
    for (const p of border.exterior.values()) for (const own of edge) {
      const target = { q: anchor.q + p.q - own.q, r: anchor.r + p.r - own.r };
      const k = key(target);
      if (!unique.has(k) && inRange(target)) { unique.add(k); yield target; }
    }
  })();
}

export const nearestTarget = (a, b, target) => span({ q: a.q - target.q, r: a.r - target.r }) - span({ q: b.q - target.q, r: b.r - target.r }) || a.r - b.r || a.q - b.q;
