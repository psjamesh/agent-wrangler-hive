import { buildGraph, descendantIds, GROUP_KINDS } from './bead-model.js';
import { HiveError } from './ops.js';
import { OPEN_REVIEW_STATES } from './review-state.js';

export const WORK_LIMIT_SETTING = 'maxClaimedWork';
export const DEFAULT_WORK_LIMIT = 8;
export const ADMISSION_LOCK = 'hive:admission';
export const RESERVED_LAUNCH_STATES = new Set(['reserved', 'binding', 'claimed', 'uncertain']);

export function workLimit(rt) {
  const value = rt.host?.settings?.get?.(WORK_LIMIT_SETTING) ?? rt.settings?.get?.(WORK_LIMIT_SETTING);
  return Number.isSafeInteger(value) && value >= 0 ? value : DEFAULT_WORK_LIMIT;
}

export function hiveWorkIds(rt, graph) {
  const ids = new Set();
  for (const cell of rt.metadata.cells()) {
    if (cell.snapshot || !cell.rootBeadId) continue;
    for (const id of descendantIds(graph.beads, cell.rootBeadId)) {
      if (id !== cell.rootBeadId && graph.beads[id] && graph.beads[id].kind !== 'external' && !GROUP_KINDS.has(graph.beads[id].kind)) ids.add(id);
    }
  }
  return ids;
}

export function capacity(rt, graph = rt.snapshots.graph, { reserve = [], breakdown = false } = {}) {
  const scope = hiveWorkIds(rt, graph);
  const charge = (id) => id;
  const claimed = new Set([...scope].filter((id) => graph.beads[id].status === 'in_progress' && graph.beads[id].assignee).map(charge));
  const roots = new Set(rt.metadata.cells().map((c) => c.rootBeadId));
  const counts = (id) => typeof id === 'string' && !roots.has(id) && graph.beads[id]?.kind !== 'external' && !GROUP_KINDS.has(graph.beads[id]?.kind);
  const reserved = new Set(Object.values(rt.metadata.read().workerLaunches || {})
    .filter((l) => RESERVED_LAUNCH_STATES.has(l.state) && counts(l.beadId)).map((l) => charge(l.beadId)));
  for (const op of Object.values(rt.metadata.read().operations)) {
    if (op.kind === 'claim' && ['pending', 'uncertain', 'partial'].includes(op.state) && counts(op.intent?.beadId)) reserved.add(charge(op.intent.beadId));
  }
  const reviews = new Set(Object.values(rt.metadata.read().reviews || {}).filter((r) => OPEN_REVIEW_STATES.has(r.state) && counts(r.workBeadId)).map((r) => r.workBeadId));
  for (const id of reviews) reserved.add(id);
  for (const id of reserve) if (counts(id)) reserved.add(charge(id));
  const used = new Set([...claimed, ...reserved]).size;
  const limit = workLimit(rt);
  return { limit, unlimited: limit === 0, claimed: claimed.size, reserved: [...reserved].filter((id) => !claimed.has(id)).length, used, available: limit === 0 ? null : Math.max(0, limit - used),
    ...(breakdown ? { breakdown: { claimed: claimed.size, reviews: [...reviews].filter((id) => !claimed.has(id)).length, launching: [...reserved].filter((id) => !claimed.has(id) && !reviews.has(id)).length } } : {}),
  };
}

export function exportedGraph({ issues, errors }) {
  if (errors?.length) throw new HiveError('The Beads export is incomplete; capacity and ownership cannot be confirmed.', 'refused');
  return buildGraph(issues);
}

export function checkAdmission(rt, graph, beadId, { sessionId, launchId = null, ownOperationId = null, review = false } = {}) {
  const bead = graph.beads[beadId];
  if (!bead || bead.status === 'closed') throw new HiveError(`Bead ${beadId} is missing or closed.`, 'conflict');
  if (bead.kind === 'external') throw new HiveError(`External prerequisite ${beadId} is never claimable work. Close it when the outside prerequisite is met.`, 'refused');
  for (const launch of Object.values(rt.metadata.read().workerLaunches || {})) {
    if (launch.beadId === beadId && RESERVED_LAUNCH_STATES.has(launch.state) && launch.id !== launchId) throw new HiveError(`Bead ${beadId} is reserved by launch ${launch.id}. Reconcile that launch first.`, 'conflict');
  }
  for (const op of Object.values(rt.metadata.read().operations)) {
    if (op.id !== ownOperationId && op.kind === 'claim' && op.intent?.beadId === beadId && ['pending', 'uncertain', 'partial'].includes(op.state)) throw new HiveError(`The claim for ${beadId} is unsettled (${op.id}). Reconcile it first.`, 'uncertain');
  }
  if (!review && bead.assignee === `aw:${sessionId}`) return;
  if (!review && bead.assignee) throw new HiveError(`Bead ${beadId} is already claimed by ${bead.assignee}.`, 'conflict');
  if (!hiveWorkIds(rt, graph).has(beadId)) return;
  const usage = capacity(rt, graph, { reserve: [beadId] });
  if (usage.limit && usage.used > usage.limit) throw new HiveError(`Hive's global work limit is ${usage.limit}; ${usage.used} slots are claimed or reserved across all hives. Do not record this in the bead summary or next action: raise it to the queen now with hive_request_input, naming this bead, so the queen can free capacity or change Maximum active workers in Hive settings.`, 'busy');
}
