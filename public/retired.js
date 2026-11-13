import { nearestFree } from './hex-search.js';

export const RETIRE_OUTCOMES = [
  ['done', 'Done: its goal is met'],
  ['dropped', 'Dropped: no longer needed'],
  ['superseded', 'Superseded by other work'],
];

export const retireKey = (cellId) => `retire:${cellId}`;

export const isRetired = (cell) => Boolean(cell?.retired);

export function visibleCells(cells, showRetired) {
  return showRetired ? cells : cells.filter((c) => !isRetired(c));
}

// Where the overview draws each hive. An active hive always keeps its own
// place. A shown retired hive keeps its old place when no active hive and no
// retired hive already drawn holds it, otherwise it is drawn at the nearest
// free one, and never changes what is saved.
export function overviewPlaces(cells) {
  const at = new Map();
  const taken = [];
  for (const c of cells) {
    if (isRetired(c)) continue;
    const p = { q: c.position?.q ?? 0, r: c.position?.r ?? 0 };
    at.set(c.id, p);
    taken.push(p);
  }
  for (const c of cells) {
    if (!isRetired(c)) continue;
    const old = { q: c.retired.position?.q ?? c.position?.q ?? 0, r: c.retired.position?.r ?? c.position?.r ?? 0 };
    const shift = nearestFree([old], taken) || { q: 0, r: 0 };
    const p = { q: old.q + shift.q, r: old.r + shift.r };
    at.set(c.id, p);
    taken.push(p);
  }
  return at;
}

export const outcomeMark = (retired) => ({
  kind: retired.outcome === 'done' ? 'done' : 'closed',
  title: `Retired, ${retired.outcome}${retired.summary ? `: ${retired.summary.split('\n')[0]}` : ''}`,
});
