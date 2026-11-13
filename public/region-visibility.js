import { stackable } from './layout-base.js';

export function hiddenWork(hive, layout, kids, hiding) {
  const hidden = new Set(), counts = new Map();
  const heads = new Set(layout.groupHeads), onMap = new Set(layout.order);
  const stats = new Map(), seen = new Set(), flags = new Set(hiding);
  const pending = [...flags].map((id) => [id, false]);
  while (pending.length) {
    const [id, expanded] = pending.pop();
    const children = kids.get(id) || [];
    if (!expanded) {
      if (seen.has(id)) continue;
      seen.add(id);
      pending.push([id, true]);
      for (const child of children) pending.push([child.id, false]);
      continue;
    }
    const complete = stackable(hive.beads[id]) && children.every((c) => stats.get(c.id)?.complete);
    const size = Number(onMap.has(id)) + children.reduce((n, c) => n + (stats.get(c.id)?.size || 0), 0);
    const descendants = children.reduce((n, c) => n + (stats.get(c.id)?.covered || 0), 0);
    stats.set(id, { complete, size, descendants, covered: heads.has(id) && complete ? size : descendants });
  }
  for (const headId of flags) {
    let own = 0;
    const visited = new Set([headId]), todo = [headId];
    while (todo.length) for (const child of kids.get(todo.pop()) || []) {
      if (heads.has(child.id) || visited.has(child.id) || !onMap.has(child.id)) continue;
      visited.add(child.id);
      todo.push(child.id);
      if (stackable(hive.beads[child.id])) { hidden.add(child.id); own += 1; }
    }
    counts.set(headId, own + (stats.get(headId)?.descendants || 0));
  }
  const reached = new Set(), suppressed = new Set();
  const candidates = [...flags].flatMap((id) => (kids.get(id) || []).map((c) => c.id));
  while (candidates.length) {
    const id = candidates.pop();
    if (reached.has(id)) continue;
    reached.add(id);
    if (heads.has(id) && stats.get(id)?.complete) suppressed.add(id);
    for (const child of kids.get(id) || []) candidates.push(child.id);
  }
  const marked = new Set(), todo = [...suppressed];
  while (todo.length) {
    const id = todo.pop();
    if (marked.has(id)) continue;
    marked.add(id);
    if (onMap.has(id)) hidden.add(id);
    for (const child of kids.get(id) || []) todo.push(child.id);
  }
  return { hidden, counts };
}
