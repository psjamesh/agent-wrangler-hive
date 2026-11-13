import { key, neighbour, haloOf } from './hex-layout.js';
import { inRange, nearestFree, span } from './hex-search.js';
import { attachedCandidates, regionBoundary, subtreeMembers } from './region-attachments.js';

function components(ids, positions) {
  const at = new Map(ids.map((id) => [key(positions[id]), id]));
  const remaining = new Set(ids), groups = [];
  for (const id of ids) {
    if (!remaining.delete(id)) continue;
    const group = [id];
    for (let i = 0; i < group.length; i++) for (let d = 0; d < 6; d++) {
      const next = at.get(key(neighbour(positions[group[i]], d)));
      if (remaining.delete(next)) group.push(next);
    }
    groups.push(group);
  }
  return groups;
}

const compareShift = (a, b) => span(a) - span(b) || a.r - b.r || a.q - b.q;

export function pullDetachedChains(layout, kids, hidden) {
  if (layout.snapshotComplete === false || layout.fallback || !hidden.size) return {};
  const positions = { ...layout.positions }, moves = {};
  const visible = layout.order.filter((id) => !hidden.has(id));
  for (const head of layout.groupHeads) {
    if (hidden.has(head) || layout.regionParents[head]) continue;
    const family = subtreeMembers(layout, kids, head);
    const excluded = new Set();
    for (const pinned of layout.detachedPinned || []) {
      if (family.has(pinned)) for (const id of subtreeMembers(layout, kids, pinned)) excluded.add(id);
    }
    const canonical = { ...positions, ...layout.carried };
    const before = components([...family].filter((id) => !excluded.has(id)), canonical).find((group) => group.includes(head)) || [];
    const reachable = new Set(before);
    const ids = visible.filter((id) => family.has(id) && !excluded.has(id));
    const groups = components(ids, positions);
    const connected = groups.find((group) => group.includes(head));
    if (!connected) continue;
    const apart = new Set(haloOf(visible.filter((id) => !family.has(id)).map((id) => positions[id])).map(key));
    const pending = groups.filter((group) => group !== connected && group.some((id) => reachable.has(id)));
    while (pending.length) {
      let best = null;
      const border = regionBoundary(connected.map((id) => positions[id]));
      for (const group of pending) {
        const own = new Set(group), home = positions[group[0]];
        const taken = new Set([...apart, ...visible.filter((id) => family.has(id) && !own.has(id)).map((id) => key(positions[id]))]);
        for (const target of attachedCandidates(group.map((id) => positions[id]), border, home)) {
          const off = { q: target.q - home.q, r: target.r - home.r };
          const shifted = group.map((id) => ({ q: positions[id].q + off.q, r: positions[id].r + off.r }));
          if (!shifted.every((p) => inRange(p) && !taken.has(key(p)) && border.outside(p))) continue;
          if (!best || compareShift(off, best.off) < 0 || (compareShift(off, best.off) === 0 && group[0] < best.group[0])) best = { group, off, shifted };
        }
      }
      if (!best) {
        for (const group of pending) for (const id of group) if (layout.groupHeads.includes(id)) layout.detachedPinned.add(id);
        break;
      }
      best.group.forEach((id, i) => { positions[id] = best.shifted[i]; moves[id] = positions[id]; });
      connected.push(...best.group);
      pending.splice(pending.indexOf(best.group), 1);
    }
  }
  return moves;
}

export function restoreDone({ layout, kids, saved, back, hidden, edges = [] }) {
  const positions = {}, ids = layout.order.filter((id) => back.has(id) && !hidden.has(id)).sort();
  const current = { ...layout.positions }, used = new Set(layout.order.filter((id) => !hidden.has(id) && !back.has(id)).map((id) => key(current[id])));
  const placed = new Set(layout.order.filter((id) => !hidden.has(id) && !back.has(id)));
  const origins = Object.fromEntries(ids.map((id) => [id, inRange(saved[id]) ? saved[id] : layout.carried?.[id] || current[id]]));
  const displaced = [];
  for (const id of ids) {
    const p = origins[id];
    if (!inRange(p) || used.has(key(p))) { displaced.push(id); continue; }
    current[id] = p;
    placed.add(id);
    used.add(key(p));
  }
  const parents = new Map([...kids].flatMap(([parent, children]) => children.map((child) => [child.id, parent])));
  for (const id of displaced) {
    const home = origins[id];
    if (!inRange(home)) return null;
    const busy = [...used].map((k) => { const [q, r] = k.split(',').map(Number); return { q, r }; });
    const off = nearestFree([home], busy);
    if (!off) return null;
    const radius = span(off), candidates = [];
    const anchors = [parents.get(id), ...edges.filter((e) => e.prerequisite === id || e.dependent === id).map((e) => e.prerequisite === id ? e.dependent : e.prerequisite)].filter((other) => placed.has(other));
    for (let dq = -radius; dq <= radius; dq++) for (let dr = Math.max(-radius, -dq - radius); dr <= Math.min(radius, -dq + radius); dr++) {
      if (span({ q: dq, r: dr }) !== radius) continue;
      const p = { q: home.q + dq, r: home.r + dr };
      if (inRange(p) && !used.has(key(p))) candidates.push(p);
    }
    const distance = (p) => anchors.length ? Math.min(...anchors.map((other) => span({ q: p.q - current[other].q, r: p.r - current[other].r }))) : 0;
    candidates.sort((a, b) => distance(a) - distance(b) || a.r - b.r || a.q - b.q);
    current[id] = candidates[0];
    placed.add(id);
    used.add(key(current[id]));
  }
  for (const id of ids) if (!inRange(saved[id]) || key(current[id]) !== key(saved[id])) positions[id] = current[id];
  return positions;
}
