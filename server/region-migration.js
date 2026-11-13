import { legacyLayoutCell } from '../public/legacy-cell-layout.js';
import { activeKids, archiveHidden } from '../public/archive-layout.js';
import { stackable } from '../public/layout-base.js';
import { inRange } from '../public/hex-search.js';

export const REGION_LAYOUT_VERSION = 1;

export function migrateRegions(metadata, beads) {
  if (metadata.error) return false;
  const doc = metadata.read();
  const updates = {};
  const yieldIds = new Set(Object.values(beads).filter(stackable).map((b) => b.id));
  for (const cell of Object.values(doc.cells)) {
    if ((doc.regionLayout?.[cell.id] || 0) >= REGION_LAYOUT_VERSION || !beads[cell.rootBeadId]) continue;
    const hidden = archiveHidden({ beads, rootId: cell.rootBeadId, archived: doc.archived });
    const saved = doc.beadLayout[cell.id] || {};
    const legacy = legacyLayoutCell({ kids: activeKids(beads, hidden), rootId: cell.rootBeadId, saved, aspect: doc.arrangeAspect[cell.id], yieldIds });
    updates[cell.id] = { ...saved };
    const translated = new Map();
    const yielded = new Set(legacy.yielded);
    for (const id of Object.keys(legacy.automatic)) {
      if (!inRange(saved[id]) || yielded.has(id)) continue;
      translated.set(legacy.halo[id], {
        q: legacy.positions[id].q - saved[id].q,
        r: legacy.positions[id].r - saved[id].r,
      });
    }
    for (const [id, pos] of Object.entries(legacy.positions)) {
      const shift = id in legacy.automatic ? translated.get(legacy.halo[id]) : null;
      if (shift && inRange(saved[id])) {
        const canonical = { q: saved[id].q + shift.q, r: saved[id].r + shift.r };
        if (!inRange(canonical)) throw new Error(`Cannot migrate ${cell.id}: translated canonical position for ${id} is out of range.`);
        updates[cell.id][id] = canonical;
      } else if (!inRange(saved[id])) updates[cell.id][id] = pos;
    }
  }
  if (!Object.keys(updates).length) return false;
  metadata.mutate((d) => {
    d.regionLayout ||= {};
    for (const [id, saved] of Object.entries(updates)) {
      d.beadLayout[id] = saved;
      d.regionLayout[id] = REGION_LAYOUT_VERSION;
    }
  });
  return true;
}
