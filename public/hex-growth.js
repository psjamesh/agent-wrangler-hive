import { key, neighbour, blockedPoints, restPoints, occupiedIn } from './hex-layout.js';
import { freeShifts, inRange, span } from './hex-search.js';

export function growPatch({ members, todo, positions, taken, aspect, carried = {}, automatic = new Set() }) {
  const placed = members.filter((id) => positions[id]);
  if (!placed.length) return false;
  let anchor = positions[members[0]] || positions[placed[0]];
  const dist2 = (p, from) => 3 * ((p.q - from.q + (p.r - from.r) / 2) / aspect) ** 2 + 2.25 * (p.r - from.r) ** 2;
  const frontier = () => {
    const own = new Set(placed.map((id) => key(positions[id])));
    const out = new Map();
    for (const id of placed) for (let d = 0; d < 6; d++) {
      const p = neighbour(positions[id], d);
      if (inRange(p) && !own.has(key(p))) out.set(key(p), p);
    }
    return [...out.values()];
  };
  for (const id of todo) {
    const border = frontier();
    const open = border.filter((p) => !occupiedIn(taken, key(p)));
    const spots = open.some((p) => !taken.has(key(p))) ? open.filter((p) => !taken.has(key(p))) : open;
    spots.sort((a, b) => span({ q: a.q - anchor.q, r: a.r - anchor.r }) - span({ q: b.q - anchor.q, r: b.r - anchor.r }) || dist2(a, anchor) - dist2(b, anchor) || a.r - b.r || a.q - b.q);
    let p = spots[0];
    if (!p) {
      const centre = placed.reduce((sum, id) => ({ q: sum.q + positions[id].q / placed.length, r: sum.r + positions[id].r / placed.length }), { q: 0, r: 0 });
      p = border.sort((a, b) => dist2(a, centre) - dist2(b, centre) || a.r - b.r || a.q - b.q)[0];
      const busy = blockedPoints(taken);
      const rest = restPoints(taken, new Set(placed.map((id) => key(positions[id]))));
      const shape = [...placed.map((id) => positions[id]), p];
      const carriedIds = members.filter((id) => carried[id]);
      const shift = freeShifts([{ shape, taken: rest }, { shape: carriedIds.map((id) => carried[id]), taken: [] }]).next().value;
      if (shift) {
        for (const id of placed) taken.delete(key(positions[id]));
        for (const id of placed) {
          positions[id] = { q: positions[id].q + shift.q, r: positions[id].r + shift.r };
          taken.add(key(positions[id]));
        }
        anchor = { q: anchor.q + shift.q, r: anchor.r + shift.r };
        for (const id of carriedIds) carried[id] = { q: carried[id].q + shift.q, r: carried[id].r + shift.r };
        for (const id of members) automatic.add(id);
        p = { q: p.q + shift.q, r: p.r + shift.r };
      } else {
        // At the coordinate limit, an impossible rigid fit permits a detached tile.
        const off = freeShifts([{ shape: [anchor], taken: busy }]).next().value;
        p = { q: anchor.q + off.q, r: anchor.r + off.r };
      }
    }
    positions[id] = p;
    taken.add(key(p));
    placed.push(id);
  }
  return true;
}
