import test from 'node:test';
import assert from 'node:assert/strict';
import { layoutCell } from '../public/cell-layout.js';
import { activeKids } from '../public/archive-layout.js';
import { planHiveReveal } from '../public/cell-move.js';

test('unchanged independent region returns avoid repeated whole-cell planning', () => {
  const beads = { root: { id: 'root', kind: 'goal' } }, saved = {}, back = new Set();
  for (let i = 0; i < 100; i++) {
    const head = `h${i}`, leaf = `l${i}`;
    beads[head] = { id: head, kind: 'workstream', parentId: 'root' };
    beads[leaf] = { id: leaf, kind: 'work', parentId: head };
    saved[head] = { q: i * 3, r: 0 };
    saved[leaf] = { q: i * 3 + 1, r: 0 };
    back.add(head); back.add(leaf);
  }
  const kids = activeKids(beads);
  const layout = layoutCell({ kids, rootId: 'root', saved, hidden: back, yieldIds: back });
  let reads = 0;
  const get = kids.get.bind(kids);
  kids.get = (id) => { reads++; return get(id); };
  const out = planHiveReveal({ layout, kids, rootId: 'root', saved, back, yieldIds: back });
  assert.deepEqual(out, { ok: true, same: true, positions: {}, stack: [], detachedPinned: new Set() });
  assert.ok(reads < 100 * 20, `unchanged returns read children ${reads} times`);
});

test('hive reveal keeps visible positions and restores free done origins across random graphs', () => {
  let seed = 0x5d49;
  const random = (n) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  for (let trial = 0; trial < 200; trial++) {
    const beads = { root: { id: 'root', kind: 'goal' } }, saved = {}, back = new Set(), hidden = new Set(), detachedPinned = new Set();
    const heads = [], unchanged = trial % 4 === 0;
    for (let i = 0, n = 2 + random(7); i < n; i++) {
      const head = `h${i}`, leaf = `l${i}`;
      const parentId = !unchanged && heads.length && random(3) === 0 ? heads[random(heads.length)] : 'root';
      beads[head] = { id: head, kind: 'workstream', parentId };
      beads[leaf] = { id: leaf, kind: 'work', parentId: head };
      heads.push(head);
      saved[head] = unchanged ? { q: i * 3, r: 0 } : { q: random(3) ? i * 3 : random(12), r: random(3) - 1 };
      saved[leaf] = { q: saved[head].q + 1, r: saved[head].r };
      if (unchanged || random(2)) { back.add(head); back.add(leaf); }
      else if (random(2)) { back.add(leaf); }
      if (!unchanged && random(4) === 0) { hidden.add(leaf); back.delete(leaf); }
      if (!unchanged && random(4) === 0) detachedPinned.add(head);
    }
    if (!unchanged && random(2)) {
      beads.loose = { id: 'loose', kind: 'work', parentId: 'root' };
      saved.loose = { q: random(12), r: 0 };
      back.add('loose');
    }
    const kids = activeKids(beads), yieldIds = new Set([...back, ...hidden]);
    const layout = layoutCell({ kids, rootId: 'root', saved, hidden: yieldIds, yieldIds, detachedPinned, snapshotComplete: random(5) !== 0, fallback: random(5) === 0 });
    const args = { layout, kids, rootId: 'root', saved, back, hidden, yieldIds };
    const out = planHiveReveal(args);
    assert.equal(out.ok, true, `trial ${trial}: ${out.reason}`);
    const final = { ...saved, ...out.positions };
    const shown = layout.order.filter((id) => !hidden.has(id));
    assert.equal(new Set(shown.map((id) => `${final[id].q},${final[id].r}`)).size, shown.length, `trial ${trial}: overlap`);
    for (const id of shown.filter((id) => !back.has(id))) assert.deepEqual(final[id], layout.positions[id], `trial ${trial}: live ${id}`);
    assert.deepEqual(planHiveReveal(args), out, `trial ${trial}: deterministic`);
  }
});
