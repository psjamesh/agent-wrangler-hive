import { reviewFields } from './review-state.js';
import { isUntracked } from './tracking.js';
import { OPEN_REVIEW_STATES } from './review-state.js';
import { descendantIds } from './bead-model.js';
import { rankBeads } from '../public/bead-rank.js';

export const SEARCH_LIMIT = 1000;

const SLIM_FIELDS = ['id', 'parentId', 'title', 'kind', 'status', 'outcome', 'closeReason', 'waitingFor', 'assignee', 'ownerSessionId', 'createdAt', 'updatedAt', 'closedAt'];

function firstLine(text) {
  return String(text || '').split('\n').find((l) => l.trim())?.trim().slice(0, 300) || '';
}

function slimReview(review) {
  const out = {};
  for (const key of ['id', 'workBeadId', 'state', 'round', 'reviewerSessionId', 'waitingFor']) if (review[key] !== undefined) out[key] = review[key];
  if (OPEN_REVIEW_STATES.has(review.state) && review.summary !== undefined) out.summary = review.summary;
  return out;
}

export function fullBead(runtime, graph, id) {
  const bead = { ...graph.beads[id], ...reviewFields(runtime, id) };
  return { ...bead, untracked: isUntracked(runtime.host, graph, bead) };
}

// The fields the map, lists, badges and the waiting views read for every bead.
// Long text stays out; a cell's root bead keeps its goal and acceptance, which
// the overview tile and the hive goal panel show without a selection.
export function slimBead(runtime, graph, id, { root = false } = {}) {
  const full = fullBead(runtime, graph, id);
  const out = {};
  for (const key of SLIM_FIELDS) out[key] = full[key];
  for (const key of ['reviewState', 'reviewWorking']) if (key in full) out[key] = full[key];
  if (full.review) out.review = slimReview(full.review);
  out.untracked = full.untracked;
  out.summaryLine = firstLine(full.summary);
  if (root) {
    out.goal = full.goal;
    out.acceptance = full.acceptance;
  }
  return out;
}

function visibleIds(rt, cellId) {
  const doc = rt.metadata.read();
  const graph = rt.snapshots.graph;
  const out = new Set();
  for (const cell of Object.values(doc.cells)) {
    if (cellId && cell.id !== cellId) continue;
    if (cell.enabled || cell.retired) if (cell.rootBeadId && graph.beads[cell.rootBeadId]) for (const id of descendantIds(graph.beads, cell.rootBeadId)) out.add(id);
  }
  return out;
}

export function beadDetail(rt, { beadId }) {
  const graph = rt.snapshots.graph;
  if (typeof beadId !== 'string' || !graph.beads[beadId] || !visibleIds(rt, null).has(beadId)) {
    const err = new Error('That bead is not available.');
    err.code = 'unknown-bead';
    throw err;
  }
  return { bead: fullBead(rt, graph, beadId) };
}

export function searchBeads(rt, { cellId, query }) {
  const graph = rt.snapshots.graph;
  const ids = visibleIds(rt, cellId);
  const text = typeof query === 'string' ? query.slice(0, 200) : '';
  const found = rankBeads([...ids].map((id) => graph.beads[id]).filter(Boolean), text);
  return { query: text, cellId, revision: rt.snapshots.current.revision, results: found.slice(0, SEARCH_LIMIT), truncated: found.length > SEARCH_LIMIT };
}
