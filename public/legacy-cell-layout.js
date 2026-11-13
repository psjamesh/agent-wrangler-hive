import { key, landscapeAround, landscapeOffsets, nearestFreeLandscape, normalAspect } from './hex-layout.js';
import { growPatch } from './hex-growth.js';

const PATCH_SPREAD = 1.75;
const byCreated = (a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')) || a.id.localeCompare(b.id);

// Pre-region placement is retained only to pin existing unsaved tiles during migration.
export function legacyLayoutCell({ kids, rootId, saved = {}, aspect, yieldIds = new Set(), hidden = new Set() }) {
  const ratio = normalAspect(aspect);
  const seen = new Set([rootId]);
  const groupHeads = [];
  const group = {};
  const flatten = (id, groupId, out) => {
    const children = (kids.get(id) || []).filter((c) => !seen.has(c.id)).sort(byCreated);
    for (const c of children) seen.add(c.id);
    const isHead = (c) => c.kind === 'workstream' || (kids.get(c.id) || []).some((k) => !seen.has(k.id));
    const heads = children.filter(isHead);
    for (const c of children) {
      if (heads.includes(c)) continue;
      out.push(c.id);
      group[c.id] = groupId;
    }
    for (const c of heads) {
      out.push(c.id);
      group[c.id] = c.id;
      groupHeads.push(c.id);
      flatten(c.id, c.id, out);
    }
    return out;
  };
  const rootChildren = (kids.get(rootId) || []).filter((c) => !seen.has(c.id)).sort(byCreated);
  for (const c of rootChildren) seen.add(c.id);
  const loose = [];
  const patches = [];
  for (const c of rootChildren) {
    if (c.kind === 'workstream' || (kids.get(c.id) || []).some((k) => !seen.has(k.id))) {
      group[c.id] = c.id;
      groupHeads.push(c.id);
      patches.push([c.id, ...flatten(c.id, c.id, [])]);
    } else {
      loose.push(c.id);
      group[c.id] = null;
    }
  }

  const positions = {};
  const taken = new Set();
  const all = [...loose, ...patches.flat()];
  const later = [];
  const hiddenIds = all.filter((id) => hidden.has(id));
  const carried = Object.fromEntries(hiddenIds.filter((id) => saved[id]).map((id) => [id, { ...saved[id] }]));
  const automatic = new Set();
  for (const yields of [false, true]) {
    for (const id of all) {
      if (hidden.has(id)) continue;
      if (yieldIds.has(id) !== yields) continue;
      const p = saved[id];
      if (!p || !Number.isInteger(p.q) || !Number.isInteger(p.r)) continue;
      if (!taken.has(key(p))) {
        positions[id] = { q: p.q, r: p.r };
        taken.add(key(p));
      } else if (yields) {
        later.push(id);
      }
    }
  }
  const skip = new Set([...later, ...hiddenIds]);
  const claim = (p) => taken.add(key(p));
  const origin = { q: 0, r: 0 };
  for (const id of loose) {
    if (positions[id] || skip.has(id)) continue;
    const p = nearestFreeLandscape(origin, taken, ratio);
    positions[id] = p;
    claim(p);
  }
  // Each patch takes the nearest centre, in the same order, where its
  // whole blob fits, so patches line up side by side.
  for (const members of patches) {
    const todo = members.filter((id) => !positions[id] && !skip.has(id));
    if (!todo.length) continue;
    if (growPatch({ members, todo, positions, taken, aspect: ratio, carried, automatic })) continue;
    const shape = landscapeOffsets(todo.length, ratio);
    let centre = null;
    for (let n = 64; !centre && n <= 16384; n *= 4) {
      for (const c of landscapeOffsets(n, ratio * PATCH_SPREAD)) {
        if (shape.every((o) => !taken.has(`${c.q + o.q},${c.r + o.r}`))) { centre = c; break; }
      }
    }
    const slots = landscapeAround(centre || nearestFreeLandscape(origin, taken, ratio), todo.length, ratio);
    todo.forEach((id, i) => {
      const p = taken.has(key(slots[i])) ? nearestFreeLandscape(slots[i], taken, ratio) : slots[i];
      positions[id] = p;
      taken.add(key(p));
    });
    for (const id of todo) claim(positions[id]);
  }
  for (const id of [...later, ...hiddenIds]) {
    const start = carried[id] || saved[id] || positions[group[id]] || origin;
    if (hidden.has(id) && saved[id] && (taken.has(key(start)) || key(start) !== key(saved[id]))) later.push(id);
    const p = nearestFreeLandscape(start, taken, ratio);
    positions[id] = p;
    claim(p);
  }
  const halo = {};
  patches.forEach((members, i) => { for (const id of members) halo[id] = i; });
  return { order: all, positions, halo, patchHeads: patches.map((members) => members[0]), parentHead: group, groupHeads, rootId, yielded: later, carried, automatic: Object.fromEntries([...automatic].map((id) => [id, carried[id] || positions[id]])) };
}
