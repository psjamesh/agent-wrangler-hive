import { key, haloOf } from './hex-layout.js';
import { layoutCell } from './cell-layout.js';
import { stackable } from './layout-base.js';
import { inRange, nearestFree, span } from './hex-search.js';

// Shared by the map and the server. Closed workstreams that have been
// archived leave the map. Records are keyed by heading id, so a group keeps
// its record when it moves to another hive. A record hides its group only
// while it holds nothing but the closed work that was archived, its heading
// is still the closure it recorded, and it is not being shown, so new or
// reopened work brings it (and the groups around it) back on its own.


const closedIds = (beads) => new Set(Object.values(beads).filter(stackable).map((b) => b.id));

export function activeKids(beads, hidden = new Set()) {
  const map = new Map();
  for (const b of Object.values(beads || {})) {
    if (!b?.parentId || hidden.has(b.id)) continue;
    if (!map.has(b.parentId)) map.set(b.parentId, []);
    map.get(b.parentId).push(b);
  }
  return map;
}

export function under(kids, headId) {
  const out = new Set([headId]);
  const stack = [headId];
  while (stack.length) {
    for (const c of kids.get(stack.pop()) || []) {
      if (out.has(c.id)) continue;
      out.add(c.id);
      stack.push(c.id);
    }
  }
  return out;
}

// The records for the top-level workstreams of this hive. Only those are
// archived: deeper workstreams are ordinary work inside them.
export function archivedHere({ beads, rootId, archived }) {
  const out = {};
  if (!rootId || !beads?.[rootId]) return out;
  const inCell = under(activeKids(beads), rootId);
  for (const [headId, rec] of Object.entries(archived || {})) {
    if (rec && typeof rec === 'object' && beads[headId]?.parentId === rootId && inCell.has(headId)) out[headId] = rec;
  }
  return out;
}

export function settledGroup(beads, kids, headId) {
  return [...under(kids, headId)].every((id) => beads[id]?.status === 'closed');
}

export function archiveHidden({ beads, rootId, archived }) {
  const hidden = new Set();
  const here = archivedHere({ beads, rootId, archived });
  const kids = activeKids(beads);
  for (const [headId, rec] of Object.entries(here)) {
    if (rec.shown || hidden.has(headId) || beads[headId].closedAt !== rec.closedAt || !settledGroup(beads, kids, headId)) continue;
    const group = under(kids, headId);
    const known = new Set(Array.isArray(rec.ids) ? rec.ids : []);
    if (![...group].every((id) => known.has(id))) continue;
    for (const id of group) hidden.add(id);
  }
  return hidden;
}

// As archiveHidden, but the groups of `heads` count as hidden while their
// headings are still the closures their records hold, even with unfinished
// work under them: what the map showed before that work appeared. With
// `trust`, the records of `heads` are taken as they are, for headings
// already reopened.
export function restoreHidden({ beads, rootId, archived, heads, trust = false }) {
  const hidden = archiveHidden({ beads, rootId, archived });
  const here = archivedHere({ beads, rootId, archived });
  const kids = activeKids(beads);
  for (const h of heads) {
    const rec = here[h];
    if (!rec || rec.shown || (!trust && beads[h].closedAt !== rec.closedAt)) continue;
    const group = under(kids, h);
    for (const id of Array.isArray(rec.ids) ? rec.ids : []) if (group.has(id)) hidden.add(id);
  }
  return hidden;
}

// Saves the place of every bead in `ids` at `want`, adding a saved position
// for any that would otherwise drift. Null when that never settles.
function holdPlaces({ kids, rootId, saved, aspect, want, ids, yieldIds }) {
  const next = { ...saved };
  for (let pass = 0; pass <= ids.length; pass += 1) {
    const lay = layoutCell({ kids, rootId, saved: next, aspect, yieldIds });
    const drift = ids.filter((o) => !lay.positions[o] || key(lay.positions[o]) !== key(want[o]));
    if (!drift.length) return next;
    const fresh = drift.filter((o) => !next[o] || key(next[o]) !== key(want[o]));
    if (!fresh.length) return null;
    for (const o of fresh) next[o] = want[o];
  }
  return null;
}

// Pure. Takes a group off the map: where each of its beads is drawn now, and
// the hive's saved positions afterwards, with every other bead kept where it
// is. The freed hexes become free space.
export function planArchive({ beads, rootId, saved = {}, aspect, archived, headId }) {
  const hiddenBefore = archiveHidden({ beads, rootId, archived });
  if (hiddenBefore.has(headId)) return { ok: true, same: true, positions: {}, saved };
  const yieldIds = closedIds(beads);
  const before = layoutCell({ kids: activeKids(beads, hiddenBefore), rootId, saved, aspect, yieldIds });
  const group = [...under(activeKids(beads, hiddenBefore), headId)].filter((id) => before.positions[id]);
  const inGroup = new Set(group);
  const positions = Object.fromEntries(group.map((id) => [id, before.positions[id]]));
  const rest = before.order.filter((id) => !inGroup.has(id));
  const savedAfter = Object.fromEntries(Object.entries(saved).filter(([id]) => !inGroup.has(id)));
  const kidsAfter = activeKids(beads, new Set([...hiddenBefore, ...group]));
  const next = holdPlaces({ kids: kidsAfter, rootId, saved: savedAfter, aspect, want: before.positions, ids: rest, yieldIds });
  if (!next) return { ok: false, reason: 'Hive could not keep the other work where it is, so nothing was archived. Arrange the hive, then try again.' };
  return { ok: true, positions, saved: next };
}

// Pure. Brings a group back as one rigid unit, keeping its exact shape: at
// its former hexes when they are all free, otherwise at the nearest whole
// shift where every hex is free. It need not touch anything, and it always
// finds a place. Nothing else moves: other work keeps the place it is drawn
// at in `drawn` (the map as it is now) or, failing that, in the layout with
// the group still hidden. `hiddenAfter` is what stays hidden once it is back.
export function planReturn({ beads, rootId, saved = {}, aspect, hiddenBefore, hiddenAfter, headId, positions = {}, drawn = null }) {
  const yieldIds = closedIds(beads);
  const before = layoutCell({ kids: activeKids(beads, hiddenBefore), rootId, saved, aspect, yieldIds });
  const kidsAfter = activeKids(beads, hiddenAfter);
  const group = under(kidsAfter, headId);
  const shapeIds = [...group].filter((id) => inRange(positions[id]));
  const keep = {};
  const used = new Set();
  const others = before.order.filter((id) => !group.has(id));
  for (const pick of [(id) => drawn?.[id], (id) => before.positions[id]]) {
    for (const id of others) {
      const p = pick(id);
      if (keep[id] || !p || used.has(key(p))) continue;
      keep[id] = p;
      used.add(key(p));
    }
  }
  const rest = others.filter((id) => keep[id]);
  const baseSaved = Object.fromEntries(Object.entries(saved).filter(([id]) => !group.has(id)));
  let top = headId;
  while (beads[top]?.parentId && beads[top].parentId !== rootId && beads[beads[top].parentId]) top = beads[top].parentId;
  const family = under(activeKids(beads), top);
  const apart = rest.filter((id) => !family.has(id)).map((id) => keep[id]);
  const kin = rest.filter((id) => family.has(id)).map((id) => keep[id]);
  const off = shapeIds.length ? nearestFree(shapeIds.map((id) => positions[id]), [...haloOf(apart), ...kin]) : { q: 0, r: 0 };
  if (!off) return null;
  const at = Object.fromEntries(shapeIds.map((id) => [id, { q: positions[id].q + off.q, r: positions[id].r + off.r }]));
  const want = { ...keep, ...at };
  for (const p of Object.values(at)) used.add(key(p));
  const ids = [...rest, ...shapeIds];
  const next = holdPlaces({ kids: kidsAfter, rootId, saved: { ...baseSaved, ...at }, aspect, want, ids, yieldIds })
    || { ...Object.fromEntries(Object.entries(baseSaved).filter(([, p]) => !p || !used.has(key(p)))), ...want };
  return { saved: next, shift: span(off) };
}

// Where each bead is drawn now, with the archived groups hidden.
export function drawnNow({ beads, rootId, saved = {}, aspect, archived }) {
  return layoutCell({ kids: activeKids(beads, archiveHidden({ beads, rootId, archived })), rootId, saved, aspect, yieldIds: closedIds(beads) }).positions;
}

// Of the reopening `heads` (`beads` is the store before the reopen), the
// one whose group the map was hiding, if any.
export function hiddenHead({ beads, rootId, archived, heads }) {
  const start = restoreHidden({ beads, rootId, archived, heads });
  return heads.find((h) => start.has(h) && archived?.[h]?.positions) || null;
}

// Pure. Puts back the part of a reopened group whose geometry is
// `positions`, headed by `headId` in this hive, as one rigid unit at the
// nearest free spot. Other work keeps the place it has in `drawn`, the map
// as it is now.
export function planPlace({ beads, rootId, saved = {}, aspect, archived, headId, positions, drawn = null }) {
  const hiddenAfter = archiveHidden({ beads, rootId, archived });
  const part = [...under(activeKids(beads, hiddenAfter), headId)].filter((id) => positions[id]);
  const plan = planReturn({ beads, rootId, saved, aspect, hiddenBefore: new Set([...hiddenAfter, ...part]), hiddenAfter, headId, positions, drawn });
  return plan && { saved: plan.saved, moved: plan.shift > 0 };
}
