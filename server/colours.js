import { assignShades, workstreamColour } from '../public/workstream-colours.js';

// Palette slots are persisted per region; nested regions inherit their ancestor slot.
export const WORKSTREAM_SLOTS = 6;

// Every workstream or parent beneath the root owns a region.
export function topWorkstreams(beads, rootId) {
  if (!rootId || !beads[rootId]) return [];
  const parents = new Set();
  for (const b of Object.values(beads)) if (b.parentId) parents.add(b.parentId);
  const inCell = new Set([rootId]);
  const children = new Map();
  for (const b of Object.values(beads)) {
    if (!children.has(b.parentId)) children.set(b.parentId, []);
    children.get(b.parentId).push(b.id);
  }
  const queue = [rootId];
  while (queue.length) for (const id of children.get(queue.pop()) || []) {
    if (!inCell.has(id)) { inCell.add(id); queue.push(id); }
  }
  return Object.values(beads)
    .filter((b) => b.id !== rootId && inCell.has(b.id) && (b.kind === 'workstream' || parents.has(b.id)))
    .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')) || a.id.localeCompare(b.id))
    .map((b) => b.id);
}

function inheritedSlots(prev, heads, beads, rootId, parents) {
  const roots = heads.filter(id => beads[id].parentId === rootId);
  const valid = slot => Number.isInteger(slot) && slot >= 0 && slot < WORKSTREAM_SLOTS;
  const next = { ...prev };
  const counts = Array(WORKSTREAM_SLOTS).fill(0);
  for (const id of roots) if (valid(prev[id])) counts[prev[id]] += 1;
  for (const id of roots) {
    if (valid(prev[id])) continue;
    const slot = counts.indexOf(Math.min(...counts));
    next[id] = slot;
    counts[slot] += 1;
  }
  for (const id of heads) next[id] = workstreamColour(id, next, parents);
  return next;
}

function same(a = {}, b = {}) {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
}

// Brings every cell's stored mapping up to date with the current bead
// graph. Writes only when something changed. Runs synchronously, so two
// refreshes cannot interleave their assignments.
export function reconcileColours(metadata, beads) {
  if (metadata.error) return false;
  const doc = metadata.read();
  const updates = {};
  for (const cell of Object.values(doc.cells)) {
    const heads = topWorkstreams(beads, cell.rootBeadId);
    if (!heads.length) continue;
    const prev = doc.workstreamColours?.[cell.id] || {};
    const parents = Object.fromEntries(heads.map(id => [id, beads[id].parentId === cell.rootBeadId ? null : beads[id].parentId]));
    const next = inheritedSlots(prev, heads, beads, cell.rootBeadId, parents);
    const previousShades = doc.workstreamShades?.[cell.id] || {};
    const shades = assignShades(previousShades, parents);
    if (!same(prev, next) || !same(previousShades, shades)) updates[cell.id] = { colours: next, shades };
  }
  if (!Object.keys(updates).length) return false;
  metadata.mutate((d) => {
    d.workstreamColours = d.workstreamColours || {};
    d.workstreamShades ||= {};
    for (const [cellId, map] of Object.entries(updates)) {
      if (d.cells[cellId]) {
        d.workstreamColours[cellId] = map.colours;
        d.workstreamShades[cellId] = map.shades;
      }
    }
  });
  return true;
}
