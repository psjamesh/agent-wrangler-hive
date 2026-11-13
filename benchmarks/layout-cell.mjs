import { performance } from 'node:perf_hooks';
import { layoutCell } from '../public/cell-layout.js';

export function syntheticCell(rootId = 'benchmark-root') {
  const kids = new Map(), saved = {};
  const add = (parent, id, kind = 'work') => {
    if (!kids.has(parent)) kids.set(parent, []);
    kids.get(parent).push({ id, parentId: parent, kind, createdAt: '2026-11-01' });
  };
  for (let i = 0; i < 3; i++) {
    const top = `${rootId}-stream-${i}`;
    add(rootId, top, 'workstream');
    saved[top] = { q: i * 15, r: 0 };
    for (let j = 0; j < 3; j++) {
      const nested = `${top}-nested-${j}`;
      add(top, nested, 'workstream');
      saved[nested] = { q: i * 15 + j * 3, r: 1 };
      for (let k = 0; k < 23; k++) add(nested, `${nested}-work-${k}`);
    }
  }
  return { kids, rootId, saved, aspect: 1.6 };
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const first = [], repeat = [];
  for (let i = 0; i < 3; i++) {
    const input = syntheticCell(`benchmark-${i}`);
    let start = performance.now();
    const layout = layoutCell(input);
    first.push(performance.now() - start);
    for (let j = 0; j < 10; j++) {
      start = performance.now();
      layoutCell({ ...input, kids: new Map([...input.kids].map(([id, kids]) => [id, kids.map(b => ({ ...b, title: 'Updated title' }))])), saved: structuredClone(input.saved) });
      repeat.push(performance.now() - start);
    }
    if (layout.order.length !== 219) throw new Error('Expected 220 beads including root');
  }
  const stats = values => ({ medianMs: +values.sort((a, b) => a - b)[Math.floor(values.length / 2)].toFixed(3), minMs: +Math.min(...values).toFixed(3), maxMs: +Math.max(...values).toFixed(3) });
  console.log(JSON.stringify({ beads: 220, saved: 12, first: stats(first), unchanged: stats(repeat) }, null, 2));
}
