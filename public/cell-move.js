import { pullDetachedChains, restoreDone } from './hidden-placement.js';
import { subtreeMembers, attachmentState, preservesAttachments, regionBoundary, attachedCandidates, nearestTarget } from './region-attachments.js';
import { key, neighbour, LANDSCAPE } from './hex-layout.js';
import { layoutCell } from './cell-layout.js';
import { inRange, freeShifts, nearestFree, span } from './hex-search.js';

// The server's limit for one batch.
const BATCH_MAX = 2000;

const fail = (reason, moves = {}) => ({ ok: false, reason, moves });
const valid = inRange;
const TOO_FAR = 'That is too far out on the map. Move it nearer the rest of the work.';

// The layout as this browser draws it: without closed work it hides, whose
// hexes are then free for anything else.
function visible(layout, hidden) {
  if (!hidden?.size) return layout;
  return { ...layout, through: layout.order, order: layout.order.filter((o) => !hidden.has(o)), positions: Object.fromEntries(Object.entries(layout.positions).filter(([o]) => !hidden.has(o))) };
}

export function membersOf(layout, kids, headId) {
  const heads = new Set(layout.groupHeads || []);
  const onMap = new Set(layout.order);
  const through = new Set(layout.through || layout.order);
  const seen = new Set([headId]);
  const stack = [headId];
  while (stack.length) {
    for (const c of kids.get(stack.pop()) || []) {
      if (!through.has(c.id) || seen.has(c.id) || heads.has(c.id)) continue;
      seen.add(c.id);
      stack.push(c.id);
    }
  }
  return new Set([...seen].filter((o) => onMap.has(o)));
}

export function pieces(points) {
  const left = new Set(points.map(key));
  let n = 0;
  for (const p of points) {
    if (!left.delete(key(p))) continue;
    n += 1;
    const stack = [p];
    while (stack.length) {
      const at = stack.pop();
      for (let d = 0; d < 6; d += 1) {
        const nb = neighbour(at, d);
        if (left.delete(key(nb))) stack.push(nb);
      }
    }
  }
  return n;
}

// The workstream a bead sits directly in: its parent, unless that is the
// hive goal, where it sits outside any workstream (null).
function containerOf(layout, kids, id) {
  for (const [parent, list] of kids) {
    if (list.some((c) => c.id === id)) return parent === layout.rootId ? null : parent;
  }
  return null;
}

function splits(layout, kids, from, moves) {
  if (layout.groupHeads?.includes(from)) return false;
  const head = layout.parentHead?.[from] || containerOf(layout, kids, from);
  if (!head) return false;
  const ids = [...membersOf(layout, kids, head)];
  return pieces(ids.map((o) => moves[o] || layout.positions[o])) > pieces(ids.map((o) => layout.positions[o]));
}

const DETACH = 'That would detach a child workstream. Keep it attached to its parent or an attached sibling.';

const SPLIT = 'That would split a workstream into separate pieces. Keep it touching the rest of its workstream.';

// A heading carries its whole subtree; hidden work travels from its canonical origin.
export function previewMove({ layout: full, kids, id, target, hidden = new Set(), saved = {}, attachmentBaseline = null, dragContext = null }) {
  const layout = visible(full, hidden);
  const from = layout.positions[id];
  if (!from) return fail('That bead is not on the map.');
  if (key(target) === key(from)) return { ok: true, same: true, moves: {} };
  if (!valid(target)) return fail(TOO_FAR);
  const at = dragContext?.occupied || new Map(layout.order.map((o) => [key(layout.positions[o]), o]));
  const moves = {};
  if (layout.groupHeads.includes(id)) {
    const members = dragContext?.members || subtreeMembers(layout, kids, id);
    const dq = target.q - from.q;
    const dr = target.r - from.r;
    for (const m of members) moves[m] = { q: layout.positions[m].q + dq, r: layout.positions[m].r + dr };
    if (Object.values(moves).some((p) => at.has(key(p)) && !members.has(at.get(key(p))))) {
      return fail('The workstream would land on other beads. Move it where all of it fits on empty hexes.', moves);
    }
    const carried = {};
    for (const m of dragContext?.fullMembers || subtreeMembers(full, kids, id)) {
      if (!hidden.has(m)) continue;
      const p = full.carried?.[m] || (valid(saved[m]) ? saved[m] : full.positions[m]);
      carried[m] = { q: p.q + dq, r: p.r + dr };
    }
    if (![...Object.values(moves), ...Object.values(carried)].every(valid)) return fail(TOO_FAR, moves);
    const attached = dragContext?.check ? dragContext.check(moves) : preservesAttachments(full,kids,{...full.positions,...moves},hidden,id,hidden,attachmentBaseline);
    if (!attached) return fail(DETACH,moves);
    return { ok: true, moves, carried };
  }
  moves[id] = target;
  const occupant = at.get(key(target));
  if (occupant) {
    if (layout.groupHeads.includes(occupant)) return fail('That hex holds a workstream heading. Drag the heading to move its whole workstream.', moves);
    const mine = containerOf(layout, kids, id);
    const theirs = containerOf(layout, kids, occupant);
    if (mine !== theirs) {
      return fail(mine === null || theirs === null
        ? 'Beads outside workstreams swap only with each other.'
        : 'That hex belongs to another workstream. Beads swap only within their own workstream.', moves);
    }
    moves[occupant] = from;
  }
  if (splits(layout, kids, id, moves)) return fail(SPLIT, moves);
  if (!preservesAttachments(full, kids, { ...full.positions, ...moves }, hidden, null, hidden, attachmentBaseline)) return fail(DETACH, moves);
  return { ok: true, moves };
}

// Automatic placement fills gaps around saved positions, so saving only the
// moved beads could shift others. Any bead that would shift keeps its current
// place as a saved position instead, so nothing the user did not move
// changes; Arrange releases them all again. Hidden closed work with no saved
// place is saved where it is now. Hidden closed work that ends up sharing a
// saved hex, and closed work already drawn away from its saved hex and not
// moved now, is expected to give way (see layoutCell) and is not pinned;
// `stack` names it for the server to check. Any other bead must keep its
// place, so a plan where it would not is refused. Null when that cannot be done
// within the server's batch limit.
function pinBatch({ layout, kids, rootId, saved, aspect, moves, yieldIds = new Set(), hidden = new Set() }) {
  const want = { ...layout.positions, ...layout.carried, ...moves };
  const batch = { ...layout.automatic, ...moves };
  if (!hidden.size && !layout.yielded?.length && layout.order.every((id)=>{
    const p=id in batch?batch[id]:saved[id];
    return valid(p)&&key(p)===key(want[id]);
  })) return Object.keys(batch).length>BATCH_MAX?null:{batch,stack:[]};
  const claimed = new Set(Object.values(batch).map(key));
  const away = new Set(layout.yielded || []);
  for (const o of layout.order) {
    if (o in batch) continue;
    const p = saved[o];
    if (hidden.has(o)) {
      if (!valid(p)) batch[o] = want[o];
    } else if (!away.has(o) && valid(p) && claimed.has(key(p))) {
      batch[o] = want[o];
    }
  }
  const sharing = () => {
    const onHex = new Map();
    for (const o of layout.order) {
      const p = o in batch ? batch[o] : saved[o];
      if (!valid(p)) continue;
      if (!onHex.has(key(p))) onHex.set(key(p), []);
      onHex.get(key(p)).push(o);
    }
    const out = new Set();
    for (const list of onHex.values()) {
      if (list.length < 2) continue;
      for (const o of list) if (yieldIds.has(o) && (hidden.has(o) || (away.has(o) && !(o in moves)))) out.add(o);
    }
    return out;
  };
  for (let pass = 0; pass <= layout.order.length; pass += 1) {
    const next = layoutCell({ kids, rootId, saved: { ...saved, ...batch }, aspect, yieldIds, hidden, detachedPinned: layout.detachedPinned, snapshotComplete: layout.snapshotComplete, fallback: layout.fallback });
    const stack = sharing();
    const drift = layout.order.filter((o) => {
      if (stack.has(o) || (away.has(o) && !(o in batch))) return false;
      const p = hidden.has(o) ? next.carried?.[o] || next.positions[o] : next.positions[o];
      return !p || key(p) !== key(want[o]);
    });
    if (!drift.length) return Object.keys(batch).length > BATCH_MAX ? null : { batch, stack: [...stack] };
    const fresh = drift.filter((o) => !(o in batch));
    if (!fresh.length) return null;
    for (const o of fresh) batch[o] = want[o];
  }
  return null;
}

// Pure. The batch to save for a move. If the other beads cannot all be kept
// where they are, nothing is saved.
export function planMove({ layout, kids, rootId, saved = {}, aspect, id, target, hidden = new Set(), yieldIds = new Set(), attachmentBaseline = null, dragContext = null }) {
  const preview = previewMove({ layout, kids, id, target, hidden, saved, attachmentBaseline, dragContext });
  if (!preview.ok || preview.same) return preview;
  const moves = { ...preview.moves, ...preview.carried };
  const pinned = pinBatch({ layout, kids, rootId, saved, aspect, moves, yieldIds, hidden });
  if (!pinned) return fail('Hive could not keep the other beads where they are, so nothing was moved. Arrange repacks the hive.', preview.moves);
  return { ok: true, moves: preview.moves, positions: pinned.batch, stack: pinned.stack };
}

const NO_ROOM = 'There\'s no room to arrange this workstream here. Move it to open space, or Arrange the whole hive.';

// Twice the pixel x of a hex, in whole numbers, and its squared pixel
// distance from another in units of the hex size.
const xx = (p) => 2 * p.q + p.r;
const dist2 = (a, b) => 0.75 * (xx(a) - xx(b)) ** 2 + 2.25 * (a.r - b.r) ** 2;

export function planGroupArrange({ layout: full, kids, rootId, saved = {}, aspect, headId, isDone, hidden = new Set(), yieldIds = new Set() }) {
  const layout = visible(full, hidden);
  const home = layout.positions[headId];
  if (!home || !layout.groupHeads.includes(headId)) return fail('That workstream is not on the map.');
  const members = membersOf(layout, kids, headId);
  const onMap = new Set(layout.order);
  const rank = new Map(layout.order.map((o, i) => [o, i]));
  const units = (kids.get(headId) || [])
    .filter((c) => members.has(c.id))
    .map((c) => {
      const ids = [...membersOf(layout, kids, c.id)].sort((a, b) => rank.get(a) - rank.get(b));
      return { ids, anchor: onMap.has(c.id) ? c.id : ids[0], left: Boolean(isDone(c.id)) };
    })
    .filter((u) => u.ids.length)
    .sort((a, b) => rank.get(a.anchor) - rank.get(b.anchor));
  if (!units.length) return { ok: true, same: true, moves: {} };
  const blocked = new Set(layout.order.filter((o) => !members.has(o)).map((o) => key(layout.positions[o])));
  blocked.add(key(home));
  const claimed = new Set();
  const moves = {};
  const sides = { left: new Map([[key(home), home]]), right: new Map([[key(home), home]]) };
  const onSide = (p, left) => (left ? xx(p) < xx(home) : xx(p) >= xx(home)) && key(p) !== key(home);
  const free = (p) => !blocked.has(key(p)) && !claimed.has(key(p));
  const take = (id, p, side) => { moves[id] = p; claimed.add(key(p)); side.set(key(p), p); };
  const order = [...units.filter((u) => u.ids.length > 1), ...units.filter((u) => u.ids.length === 1)];
  for (const unit of order) {
    const side = unit.left ? sides.left : sides.right;
    const from = layout.positions[unit.anchor];
    const shape = unit.ids.map((o) => ({ id: o, q: layout.positions[o].q - from.q, r: layout.positions[o].r - from.r }));
    const cx = shape.reduce((n, s) => n + s.q, 0) / shape.length;
    const cr = shape.reduce((n, s) => n + s.r, 0) / shape.length;
    const inShape = new Set(shape.map(key));
    const edge = shape.filter((s) => [0, 1, 2, 3, 4, 5].some((d) => !inShape.has(key(neighbour(s, d)))));
    const reach = new Map();
    for (const p of side.values()) {
      for (let d = 0; d < 6; d += 1) {
        const n = neighbour(p, d);
        if (free(n) && onSide(n, unit.left)) reach.set(key(n), n);
      }
    }
    const tries = new Map();
    for (const n of reach.values()) {
      for (const s of edge) {
        const at = { q: n.q - s.q, r: n.r - s.r };
        tries.set(key(at), at);
      }
    }
    const centre = (at) => dist2({ q: at.q + cx, r: at.r + cr }, home);
    const ranked = [...tries.values()].sort((a, b) => centre(a) - centre(b) || a.r - b.r || a.q - b.q);
    let placed = false;
    const fits = (at) => {
      for (const s of shape) {
        const p = { q: at.q + s.q, r: at.r + s.r };
        if (!free(p) || !onSide(p, unit.left)) return false;
      }
      return true;
    };
    for (const at of ranked) {
      if (!fits(at)) continue;
      for (const s of shape) take(s.id, { q: at.q + s.q, r: at.r + s.r }, side);
      placed = true;
      break;
    }
    if (!placed) return fail(NO_ROOM, moves);
  }
  const ids = [...members];
  if (!Object.values(moves).every(valid)) return fail(NO_ROOM, moves);
  if (ids.every((o) => key(moves[o] || layout.positions[o]) === key(layout.positions[o]))) return { ok: true, same: true, moves: {} };
  if (pieces(ids.map((o) => moves[o] || layout.positions[o])) > pieces(ids.map((o) => layout.positions[o]))) return fail(NO_ROOM, moves);
  if (splits(layout, kids, headId, moves)) return fail(SPLIT, moves);
  if (!preservesAttachments(full, kids, { ...full.positions, ...moves }, hidden)) return fail(DETACH, moves);
  const pinned = pinBatch({ layout: full, kids, rootId, saved, aspect, moves, yieldIds, hidden });
  if (!pinned) return fail('Hive could not keep the other beads where they are, so nothing was arranged. Arrange repacks the whole hive.', moves);
  return { ok: true, moves, positions: pinned.batch, stack: pinned.stack };
}

export const NO_REVEAL = 'This workstream is walled in by other work, so there\'s no free hex beside it to show its closed work. Move some of that work away, or Arrange the whole hive.';
export const REVEAL_RETRY = 'Hive could not keep the other work where it is while showing this workstream\'s closed work, so nothing was moved. Try again.';
const TRIES = 8;
const wide = (o) => (Math.sqrt(3) * (o.q + o.r / 2) / LANDSCAPE) ** 2 + (1.5 * o.r) ** 2;
const at = (p) => { const [q, r] = p.split(',').map(Number); return { q, r }; };

function revealShifts({ layout, kids, headId, shape, rules, hidden, beforeHidden, baseline }) {
  const state = baseline || attachmentState(layout, kids, layout.positions, beforeHidden);
  const parent = state.parents[headId];
  let sources = [], familyBorder = null;
  if (parent && state.attachments[headId]?.status !== 'detached') {
    familyBorder = state.familyBounds.get(headId);
    sources = [parent];
  } else {
    const child = Object.keys(state.attachments).find((h) => !beforeHidden.has(h) && state.parents[h] === headId && state.attachments[h].status !== 'detached');
    if (child) sources = [child];
  }
  if (!sources.length) return freeShifts(rules, { rank: wide });
  const candidates = new Map();
  const anchor = shape[headId] || Object.values(shape)[0];
  for (const h of sources) {
    const points = state.groups.get(h) || [];
    const border = familyBorder || regionBoundary(points);
    for (const target of attachedCandidates(Object.values(shape), { exterior: familyBorder ? border.exterior : border.frontier }, anchor)) {
      const offset = { q: target.q - anchor.q, r: target.r - anchor.r };
      candidates.set(key(offset), offset);
    }
  }
  const zero = { q: 0, r: 0 };
  return [...candidates.values()].sort((a,b) => nearestTarget(a,b,zero)).filter((off) => rules.every(({ shape, taken }) => {
    const busy = new Set(taken.map(key));
    return shape.every((p) => {
      const at = { q:p.q+off.q, r:p.r+off.r };
      return valid(at) && !busy.has(key(at));
    });
  }));
}

export function planReveal({ layout, kids, rootId, saved = {}, aspect, headId, back, hidden = new Set(), yieldIds = new Set(), baseline = null }) {
  if (!layout.positions[headId]) return fail('That workstream is not on the map.');
  const group = membersOf(layout, kids, headId);
  for (const id of layout.groupHeads || []) {
    if (back.has(id) && !hidden.has(id)) for (const m of subtreeMembers(layout, kids, id)) group.add(m);
  }
  const storedOf = (o) => (valid(saved[o]) ? saved[o] : layout.positions[o]);
  const startOf = (o) => layout.carried?.[o] || storedOf(o);
  const coming = layout.order.filter((o) => group.has(o) && back.has(o) && !hidden.has(o));
  if (!coming.length) return { ok: true, same: true, moves: {} };
  if (!baseline) {
    const visibleBefore = attachmentState(layout, kids, layout.positions, new Set([...hidden, ...back]));
    baseline = (layout.groupHeads || []).some((id) => back.has(id) && !hidden.has(id))
      ? attachmentState(layout, kids, { ...layout.positions, ...layout.carried }, hidden) : visibleBefore;
    for (const [id, attachment] of Object.entries(visibleBefore.attachments)) {
      if (attachment.status !== 'detached') baseline.attachments[id] = attachment;
    }
  }
  const shown = layout.order.filter((o) => group.has(o) && !back.has(o) && !hidden.has(o));
  const carried = layout.order.filter((o) => group.has(o) && hidden.has(o));
  const blocked = new Set(layout.order.filter((o) => !group.has(o) && !hidden.has(o)).map((o) => key(layout.positions[o])));
  const yielded = new Set(layout.yielded || []);
  const held = new Set(layout.order.filter((o) => !group.has(o) && hidden.has(o) && !yielded.has(o)).map((o) => key(layout.positions[o])));
  const shape = Object.fromEntries(shown.map((o) => [o, layout.positions[o]]));
  const used = new Set(shown.map((o) => key(shape[o])));
  const clash = [];
  let crowded = 0;
  for (const o of coming) {
    const p = startOf(o);
    if (used.has(key(p)) || held.has(key(p))) {
      clash.push(o);
      crowded += 1;
      continue;
    }
    shape[o] = p;
    used.add(key(p));
    if (blocked.has(key(p))) crowded += 1;
  }
  const seeds = shown.length ? shown : coming.filter((o) => shape[o]).slice(0, 1);
  const joinedUp = () => {
    const tiles = new Set(Object.keys(shape).map((o) => key(shape[o])));
    const joined = new Set(seeds.map((o) => key(shape[o])));
    const stack = [...joined];
    while (stack.length) {
      const [q, r] = stack.pop().split(',').map(Number);
      for (let d = 0; d < 6; d += 1) {
        const n = key(neighbour({ q, r }, d));
        if (tiles.has(n) && !joined.has(n)) {
          joined.add(n);
          stack.push(n);
        }
      }
    }
    return joined;
  };
  const allowedPieces = Math.max(1, pieces([...shown.map((o) => layout.positions[o]), ...coming.map(startOf)]));
  for (let again = seeds.length > 0 && pieces(Object.values(shape)) > allowedPieces; again;) {
    again = false;
    const reach = joinedUp();
    for (const o of coming) {
      if (!shape[o] || reach.has(key(shape[o]))) continue;
      if (!blocked.has(key(shape[o]))) crowded += 1;
      used.delete(key(shape[o]));
      delete shape[o];
      clash.push(o);
      again = true;
    }
  }
  for (const o of clash) {
    const from = startOf(o);
    const spots = new Map();
    for (const s of Object.keys(shape)) {
      for (let d = 0; d < 6; d += 1) {
        const n = neighbour(shape[s], d);
        if (!used.has(key(n))) spots.set(key(n), n);
      }
    }
    const score = (n) => (blocked.has(key(n)) || held.has(key(n)) ? 1e9 : 0) + dist2(n, from);
    const ranked = [...spots.values()].sort((a, b) => score(a) - score(b) || a.r - b.r || a.q - b.q);
    shape[o] = ranked.length ? ranked[0] : from;
    used.add(key(shape[o]));
  }
  const ids = Object.keys(shape);
  const pts0 = ids.map((o) => shape[o]);
  const rules = [
    { shape: pts0, taken: [...blocked].map(at) },
    { shape: ids.filter((o) => back.has(o)).map((o) => shape[o]), taken: [...held].map(at) },
    { shape: carried.map(startOf), taken: [] },
  ];
  let tries = 0;
  for (const off of revealShifts({ layout, kids, headId, shape, rules, hidden, beforeHidden: new Set([...hidden, ...back]), baseline })) {
    if (tries >= TRIES) break;
    const shift = (p) => ({ q: p.q + off.q, r: p.r + off.r });
    const moves = {};
    for (const o of ids) {
      const p = shift(shape[o]);
      if (key(p) !== key(layout.positions[o]) || (back.has(o) && key(p) !== key(storedOf(o)))) moves[o] = p;
    }
    if (off.q || off.r) {
      const along = carried.map((o) => [o, shift(startOf(o))]);
      for (const [o, p] of along) moves[o] = p;
    }
    if (!preservesAttachments(layout, kids, { ...layout.positions, ...moves }, hidden, null, new Set([...hidden, ...back]), baseline)) continue;
    if (!clash.length && !off.q && !off.r && coming.every((o) => key(startOf(o)) === key(storedOf(o)))) return { ok: true, same: true, moves: {} };
    tries += 1;
    const pinned = pinBatch({ layout, kids, rootId, saved, aspect, moves, yieldIds, hidden });
    if (!pinned) continue;
    return { ok: true, moves, positions: pinned.batch, stack: pinned.stack, shift: span(off), replaced: clash.length, crowded };
  }
  if (tries >= TRIES) return fail(REVEAL_RETRY);
  const grown = growBeside({ shown: shown.map((o) => layout.positions[o]), coming, startOf, taken: new Set([...blocked, ...held]) });
  if (!grown) return fail(NO_REVEAL);
  const moves = {};
  for (const o of coming) {
    if (key(grown[o]) !== key(layout.positions[o]) || key(grown[o]) !== key(storedOf(o))) moves[o] = grown[o];
  }
  if (!preservesAttachments(layout, kids, { ...layout.positions, ...moves }, hidden, null, new Set([...hidden, ...back]), baseline)) return fail(DETACH, moves);
  const pinned = pinBatch({ layout, kids, rootId, saved, aspect, moves, yieldIds, hidden });
  if (!pinned) return fail(REVEAL_RETRY);
  return { ok: true, moves, positions: pinned.batch, stack: pinned.stack, shift: 0, replaced: coming.length, crowded };
}

export function planHiveReveal({ layout, kids, saved = {}, back, hidden = new Set(), edges = [] }) {
  if ([...back].some((id) => !layout.order.includes(id))) return fail('Some closed work is no longer on the map. Try showing it again after the next refresh.');
  const positions = restoreDone({ layout, kids, saved, back, hidden, edges });
  if (!positions) return fail('There is no free place to show the done work.');
  for (const id of layout.order) {
    if (!back.has(id) && !hidden.has(id) && (!valid(saved[id]) || key(saved[id]) !== key(layout.positions[id]))) positions[id] = layout.positions[id];
  }
  if (Object.keys(positions).length > BATCH_MAX) return fail('This hive is too large to save the show move in one batch.');
  return { ok: true, same: !Object.keys(positions).length, positions, stack: [], detachedPinned: layout.detachedPinned };
}

function growBeside({ shown, coming, startOf, taken }) {
  const busy = new Set([...taken, ...shown.map(key)]);
  const tiles = [...shown];
  const placed = {};
  const free = (p) => valid(p) && !busy.has(key(p));
  const put = (o, p) => {
    placed[o] = p;
    busy.add(key(p));
    tiles.push(p);
  };
  const beside = () => {
    const out = new Map();
    for (const t of tiles) {
      for (let d = 0; d < 6; d += 1) {
        const n = neighbour(t, d);
        if (free(n)) out.set(key(n), n);
      }
    }
    return [...out.values()];
  };
  let left = [...coming];
  if (!tiles.length) {
    const from = startOf(left[0]);
    const off = nearestFree([from], [...busy].map(at));
    if (!off) return null;
    put(left.shift(), { q: from.q + off.q, r: from.r + off.r });
  }
  while (left.length) {
    const spots = new Set(beside().map(key));
    const exact = left.find((o) => spots.has(key(startOf(o))) && free(startOf(o)));
    if (exact) {
      put(exact, startOf(exact));
      left = left.filter((o) => o !== exact);
      continue;
    }
    const o = left[0];
    const from = startOf(o);
    const best = beside().sort((a, b) => dist2(a, from) - dist2(b, from) || a.r - b.r || a.q - b.q)[0];
    if (!best) return null;
    put(o, best);
    left.shift();
  }
  return placed;
}

export function createDragPlanner(args, { budgetMs = 8, now = () => performance.now() } = {}) {
  const { layout, kids, id, hidden = new Set(), saved = {} } = args;
  if (!layout.groupHeads.includes(id)) return (target) => ({ ...planMove({ ...args, target }), target });
  const fullMembers = subtreeMembers(layout, kids, id);
  const members = [...fullMembers].filter((m) => !hidden.has(m));
  const home = layout.positions[id];
  const state = attachmentState(layout, kids, layout.positions, hidden);
  const parent = state.parents[id];
  const ownIds=members.filter((m)=>layout.parentHead[m]===id);
  const withoutBranch = parent ? attachmentState(layout, kids, layout.positions, new Set([...hidden, ...fullMembers])) : null;
  const supportsOthers = parent && Object.entries(state.attachments).some(([head, attachment]) =>
    !fullMembers.has(head) && attachment.status !== 'detached' && withoutBranch.attachments[head]?.status === 'detached');
  const check=!parent ? ()=>true : !supportsOthers ? (moves)=>{
    const border=state.familyBounds.get(id);
    return ownIds.every((m)=>border.outside(moves[m])) && ownIds.some((m)=>border.exterior.has(key(moves[m])));
  } : null;
  const preparedArgs={...args,attachmentBaseline:state,dragContext:{
    occupied:new Map(layout.order.filter((m)=>!hidden.has(m)).map((m)=>[key(layout.positions[m]),m])),
    members:new Set(members),fullMembers,check,
  }};
  const taken = new Set(layout.order.filter((m) => !fullMembers.has(m) && !hidden.has(m)).map((m) => key(layout.positions[m])));
  const offsets = members.map((m) => ({ q: layout.positions[m].q - home.q, r: layout.positions[m].r - home.r }));
  const carried = [...fullMembers].filter((m) => hidden.has(m)).map((m) => {
    const p = layout.carried?.[m] || saved[m] || layout.positions[m];
    return { q: p.q - home.q, r: p.r - home.r };
  });
  const fits = (target) => offsets.every((p) => {
    const at = { q: p.q + target.q, r: p.r + target.r };
    return valid(at) && !taken.has(key(at));
  }) && carried.every((p) => valid({ q: p.q + target.q, r: p.r + target.r }));
  const own = state.groups.get(id) || [];
  const border = parent ? state.familyBounds.get(id) : null;
  const candidates = (function* () {
    const seen = new Set();
    if (!border) return;
    for (const at of attachedCandidates(own, border, home)) {
      if (!seen.has(key(at))) { seen.add(key(at)); yield at; }
    }
  })();
  const validTargets = [];
  let complete = false;
  const cache = new Map();
  const remember=(target,plan)=>{
    cache.set(key(target),plan);
    if(cache.size>8) cache.delete(cache.keys().next().value);
  };
  const movePlan = (target) => {
    const plan = planMove({ ...preparedArgs, target });
    if (plan.same) return { ...plan, target, moves: Object.fromEntries(members.map((m) => [m, layout.positions[m]])) };
    return { ...plan, target };
  };
  const acceptable = (target) => {
    if (!fits(target)) return false;
    const check = previewMove({ ...preparedArgs, target });
    if (!check.ok) return false;
    return key(target)!==key(home) || !parent || state.attachments[id]?.status!=='detached';
  };
  if (acceptable(home)) validTargets.push(home);
  return (target) => {
    const cached = cache.get(key(target));
    if (cached && !cached.pending) return cached;
    const started = now();
    const exact = previewMove({ ...preparedArgs, target });
    if (exact.ok && acceptable(target)) {
      const plan = movePlan(target);
      remember(target,plan);
      return plan;
    }
    if (fullMembers.size > BATCH_MAX) return fail('This workstream is too large to move in one saved batch.');
    if (!parent) {
      if(budgetMs===Infinity) {
        const shape=offsets.map((p)=>({q:p.q+target.q,r:p.r+target.r}));
        const shift=freeShifts([{shape,taken:[...taken].map(at)},{shape:carried.map((p)=>({q:p.q+target.q,r:p.r+target.r})),taken:[]}]).next().value;
        if(!shift) return {...exact,target};
        const plan={...movePlan({q:target.q+shift.q,r:target.r+shift.r}),snapped:true};
        remember(target,plan);return plan;
      }
      const planAt = (resolved, approximate) => {
        const plan={...movePlan(resolved),snapped:key(resolved)!==key(target),approximate};
        remember(target,plan);
        return plan;
      };
      let radius=1;
      while(now()-started<budgetMs) {
        let point={q:target.q-radius,r:target.r+radius};
        for(let side=0;side<6;side++) for(let step=0;step<radius;step++) {
          if(now()-started>=budgetMs) return planAt(home,true);
          if(fits(point)) return planAt(point,false);
          point=neighbour(point,side);
        }
        radius++;
      }
      return planAt(home,true);
    }
    while (!complete && now() - started < budgetMs) {
      const next = candidates.next();
      if (next.done) { complete = true; break; }
      if (acceptable(next.value)) validTargets.push(next.value);
    }
    const ranked = [...validTargets].sort((a, b) => nearestTarget(a, b, target));
    for (const resolved of ranked) {
      const plan = movePlan(resolved);
      if (!plan.ok) continue;
      const result = { ...plan, snapped: key(resolved) !== key(target), approximate: !complete };
      remember(target,result);
      return result;
    }
    return { ...exact, target, pending: !complete, reason: complete ? 'No free attached placement fits this workstream.' : 'Finding a free attached placement for this workstream.' };
  };
}

export function planDrag(args) {
  return createDragPlanner(args, { budgetMs: Infinity })(args.target);
}

export function planHide({ layout, kids, saved = {}, hidden }) {
  layout = { ...layout, detachedPinned: new Set(layout.detachedPinned) };
  const moves = pullDetachedChains(layout, kids, hidden);
  const positions = {};
  for (const id of layout.order) {
    const p = hidden.has(id) ? saved[id] || layout.carried?.[id] || layout.positions[id] : moves[id] || layout.positions[id];
    if (!valid(saved[id]) || key(p) !== key(saved[id])) positions[id] = p;
  }
  if (Object.keys(positions).length > BATCH_MAX) return fail('This hive is too large to save the hide move in one batch.');
  const claimed = new Set(layout.order.filter((id) => !hidden.has(id)).map((id) => key(positions[id] || saved[id])));
  const stack = layout.order.filter((id) => hidden.has(id) && claimed.has(key(positions[id] || saved[id])));
  return { ok: true, same: !Object.keys(positions).length, positions, stack, detachedPinned: layout.detachedPinned };
}
