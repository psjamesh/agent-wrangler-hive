// A closed bead, whatever its outcome, may share its saved hex with one
// other bead (see layoutCell).
export const stackable = (b) => b?.status === 'closed';

// Shared by the map and the server. A fingerprint of everything that decides
// where a cell's beads are drawn: the cell's hierarchy (ids, parents, kinds
// and creation times under its root), its saved positions, its stored
// proportions and which beads are archived off the map. Titles and
// conversation are left out, so they never make a move stale. Status counts
// only for a closed bead whose saved hex another bead has also saved, since
// that decides which of them keeps it.
export function layoutBase({ beads, rootId, saved = {}, aspect = null, hidden = [] }) {
  const children = new Map();
  for (const b of Object.values(beads || {})) {
    if (!b?.parentId) continue;
    if (!children.has(b.parentId)) children.set(b.parentId, []);
    children.get(b.parentId).push(b.id);
  }
  const ids = new Set();
  const stack = rootId && beads?.[rootId] ? [rootId] : [];
  while (stack.length) {
    const id = stack.pop();
    if (ids.has(id)) continue;
    ids.add(id);
    for (const c of children.get(id) || []) stack.push(c);
  }
  const parts = ['layout:attached-regions-2', `root:${rootId || ''}`, `aspect:${aspect ?? ''}`];
  for (const id of [...ids].sort()) {
    const b = beads[id];
    parts.push(`b:${id}|${b.parentId || ''}|${b.kind || ''}|${b.createdAt || ''}`);
  }
  const onHex = new Map();
  for (const id of Object.keys(saved || {}).sort()) {
    const p = saved[id];
    parts.push(`s:${id}|${p?.q},${p?.r}`);
    if (!ids.has(id) || id === rootId) continue;
    const k = `${p?.q},${p?.r}`;
    if (!onHex.has(k)) onHex.set(k, []);
    onHex.get(k).push(id);
  }
  for (const list of onHex.values()) {
    if (list.length > 1) for (const id of list) if (stackable(beads[id])) parts.push(`y:${id}`);
  }
  for (const id of [...hidden].sort()) parts.push(`h:${id}`);
  return digest(parts.join('\n'));
}

function digest(text) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `${(h2 >>> 0).toString(16).padStart(8, '0')}${(h1 >>> 0).toString(16).padStart(8, '0')}:${text.length}`;
}
