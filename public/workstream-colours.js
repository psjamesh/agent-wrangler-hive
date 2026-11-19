export const WORKSTREAM_COLOURS = 6;

function colourRoot(id, parents) {
  const seen = new Set([id]);
  while (parents?.[id] && Object.hasOwn(parents, parents[id]) && !seen.has(parents[id])) {
    id = parents[id];
    seen.add(id);
  }
  return id;
}

function colourHash(id) {
  let h = 0;
  for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h;
}

export function workstreamColour(id, assigned = null, parents = null) {
  id = colourRoot(id, parents);
  const slot = assigned?.[id];
  if (Number.isInteger(slot) && slot >= 0 && slot < WORKSTREAM_COLOURS) return slot;
  return colourHash(id) % WORKSTREAM_COLOURS;
}

export function assignShades(prev = {}, parents = {}) {
  const next = { ...prev };
  const valid = shade => Number.isInteger(shade) && shade >= 0 && shade < 5;
  const counts = new Map();
  const children = Object.keys(parents).filter(id => colourRoot(id, parents) !== id).sort();
  for (const id of children) {
    if (!counts.has(parents[id])) counts.set(parents[id], Array(5).fill(0));
    if (valid(prev[id])) counts.get(parents[id])[prev[id]] += 1;
  }
  for (const id of children) {
    if (valid(prev[id])) continue;
    const used = counts.get(parents[id]);
    let shade = colourHash(id) % 5;
    const min = Math.min(...used);
    while (used[shade] > min) shade = (shade + 1) % 5;
    next[id] = shade;
    used[shade] += 1;
  }
  return next;
}

export function workstreamClasses(id, assigned = null, parents = null, shades = {}) {
  const base = `hive-ws-c${workstreamColour(id, assigned, parents)}`;
  if (colourRoot(id, parents) === id) return base;
  return `${base} hive-ws-shade${assignShades(shades, parents)[id]}`;
}
