import {
  HiveError, LIMITS, text, beadIdArg, ensureWritable, refuseSnapshot, withLocks, journaled, assessCompletion, finishGroup, evidenceInput, CATCHING_UP,
} from './ops.js';
import { outstanding, contextOf, humanConversationDoc } from './conversation.js';
import { BeadsError } from './beads.js';
import { OUTCOMES, HUMAN_ACTOR, OPEN_STATUSES, descendantIds, normalizeIssue, buildGraph } from './bead-model.js';
import { planArchive, planReturn, planPlace, hiddenHead, archiveHidden, activeKids, under, drawnNow } from '../public/archive-layout.js';

// Closing, archiving, showing and reopening a workstream: the human's route.
// Completion is a Beads write under the finish fence; archiving and showing
// are Hive's own records and layout; reopening is one journaled Beads write
// followed by putting the group back on the map.

function workstream(rt, { cellId, headId }, { write = true } = {}) {
  const cell = rt.metadata.cell(cellId);
  if (!cell) throw new HiveError(`Unknown cell ${cellId}.`);
  const id = beadIdArg(headId, 'workstream');
  if (write) {
    if (rt.metadata.error) throw new HiveError(rt.metadata.error, 'metadata-unavailable');
    refuseSnapshot(cell);
    if (!cell.enabled) throw new HiveError('This hive is off. Turn it on to change its workstreams.');
  }
  if (!rt.snapshots.hierarchyCurrent) throw new HiveError(CATCHING_UP, 'stale');
  const beads = rt.snapshots.graph.beads;
  if (!cell.rootBeadId || id === cell.rootBeadId || !beads[id] || !descendantIds(beads, cell.rootBeadId).has(id)) {
    throw new HiveError(`${id} is not a workstream in this hive.`, 'stale');
  }
  return { cell, id, beads };
}

// Closed headings between this one and the hive goal, outermost first.
function closedAncestors(beads, rootId, id) {
  const out = [];
  for (let p = beads[id]?.parentId; p && p !== rootId && beads[p]; p = beads[p].parentId) {
    if (beads[p].status === 'closed') out.unshift(p);
  }
  return out;
}

function waitingMessages(rt, cellId, ids) {
  return (humanConversationDoc(rt.metadata.read(), cellId).conversation[cellId] || []).filter((m) => outstanding(m) && ids.has(contextOf(m)?.beadId)).length;
}

export function checkWorkstream(rt, { cellId, headId }) {
  const { cell, id, beads } = workstream(rt, { cellId, headId }, { write: false });
  const head = beads[id];
  const ids = descendantIds(beads, id);
  const rec = rt.metadata.read().archived[id] || null;
  const hidden = archiveHidden({ beads, rootId: cell.rootBeadId, archived: rt.metadata.read().archived });
  const problems = head.status === 'closed' ? [] : assessCompletion(rt, cell, id, rt.snapshots.graph, HUMAN_ACTOR).problems;
  return {
    headId: id,
    title: head.title,
    status: head.status,
    outcome: head.outcome || null,
    itemCount: ids.size - 1,
    problems,
    closedAncestors: closedAncestors(beads, cell.rootBeadId, id).map((a) => ({ id: a, title: beads[a].title })),
    waitingMessages: waitingMessages(rt, cell.id, ids),
    archived: Boolean(rec),
    hidden: hidden.has(id),
  };
}

export async function completeWorkstream(rt, { cellId, headId, outcome, summary, evidence, archive = false }) {
  ensureWritable(rt);
  const { cell, id, beads } = workstream(rt, { cellId, headId });
  if (beads[id].status === 'closed') throw new HiveError(`${id} is already closed.`);
  if (!OUTCOMES.includes(outcome)) throw new HiveError(`outcome must be one of ${OUTCOMES.join(', ')}.`);
  const cleanSummary = text(summary, 'summary', LIMITS.long, { required: true });
  const add = evidenceInput(evidence, HUMAN_ACTOR);
  const out = await finishGroup(rt, { cell, id, outcome, summary: cleanSummary, add, who: HUMAN_ACTOR });
  await rt.snapshots.refresh();
  if (!archive || beads[id].parentId !== cell.rootBeadId) return { opId: out.opId, completed: true };
  try {
    return { opId: out.opId, completed: true, ...(await archiveWorkstream(rt, { cellId, headId })) };
  } catch (err) {
    return { opId: out.opId, completed: true, archived: false, archiveError: `${id} is complete, but it was not archived, so it stays on the map: ${err.message}` };
  }
}

// Also "Hide again" for a group that is being shown.
export async function archiveWorkstream(rt, { cellId, headId }) {
  workstream(rt, { cellId, headId });
  await rt.snapshots.refresh();
  const { cell, id, beads } = workstream(rt, { cellId, headId });
  if (beads[id].parentId !== cell.rootBeadId) throw new HiveError(`Only top-level workstreams can be archived. ${id} is part of the workstream around it.`);
  const group = [...under(activeKids(beads), id)];
  const open = group.filter((b) => beads[b].status !== 'closed');
  if (open.length) throw new HiveError(`Only finished work can be archived: ${open.slice(0, 5).join(', ')}${open.length > 5 ? ', …' : ''} ${open.length === 1 ? 'is' : 'are'} not closed.`);
  let result;
  rt.metadata.mutate((d) => {
    const archived = { ...d.archived };
    if (archived[id]) archived[id] = { ...archived[id], shown: true };
    const plan = planArchive({ beads, rootId: cell.rootBeadId, saved: d.beadLayout[cell.id] || {}, aspect: d.arrangeAspect[cell.id] ?? null, archived, headId: id });
    if (!plan.ok) throw new HiveError(plan.reason, 'conflict');
    const prev = d.archived[id];
    const head = beads[id];
    d.archived[id] = {
      cellId: cell.id,
      at: prev?.at || Date.now(),
      by: HUMAN_ACTOR,
      outcome: head.outcome || null,
      summary: head.summary.slice(0, LIMITS.short),
      closedAt: head.closedAt,
      itemCount: group.length - 1,
      ids: group,
      positions: plan.positions,
      colour: d.workstreamColours?.[cell.id]?.[id] ?? null,
      shown: false,
    };
    d.beadLayout[cell.id] = plan.saved;
    delete d.restoring[intentKey(cell.id, id)];
    result = { archived: true, hidden: Object.keys(plan.positions).length, waitingMessages: waitingMessages(rt, cell.id, new Set(group)) };
  });
  return result;
}

export function showWorkstream(rt, { cellId, headId }) {
  const { cell, id, beads } = workstream(rt, { cellId, headId });
  let result;
  rt.metadata.mutate((d) => {
    const rec = d.archived[id];
    if (!rec) throw new HiveError(`${id} is not archived.`, 'stale');
    const hiddenBefore = archiveHidden({ beads, rootId: cell.rootBeadId, archived: d.archived });
    if (!hiddenBefore.has(id)) throw new HiveError(`${id} is already on the map.`, 'stale');
    const archived = { ...d.archived, [id]: { ...rec, shown: true } };
    const hiddenAfter = archiveHidden({ beads, rootId: cell.rootBeadId, archived });
    const plan = planReturn({ beads, rootId: cell.rootBeadId, saved: d.beadLayout[cell.id] || {}, aspect: d.arrangeAspect[cell.id] ?? null, hiddenBefore, hiddenAfter, headId: id, positions: rec.positions });
    if (!plan) throw new HiveError(`There is no free spot in range for ${id} in its shape, so it stays hidden.`, 'no-room');
    d.archived[id] = archived[id];
    d.beadLayout[cell.id] = plan.saved;
    result = { shown: true, moved: plan.shift > 0 };
  });
  return result;
}

// Other work stays where it is drawn now. With `before`, the map as the
// reopen found it in this hive, a bead whose saved place has not changed
// since stays where it was drawn then, so the reopen's own refresh moves
// nothing, unless something placed since holds that hex: the newer place
// wins and no two beads share a hex.
function restoreArgs(d, cell, beads, headId, positions, before = null) {
  const args = { rootId: cell.rootBeadId, saved: d.beadLayout[cell.id] || {}, aspect: d.arrangeAspect[cell.id] ?? null, archived: d.archived };
  const drawn = drawnNow({ ...args, beads });
  if (before?.cellId === cell.id) {
    const same = (id) => JSON.stringify(args.saved[id] ?? null) === JSON.stringify(before.saved[id] ?? null);
    const group = under(activeKids(beads), headId);
    const at = new Set(Object.entries(drawn).filter(([id]) => !group.has(id)).map(([, p]) => `${p.q},${p.r}`));
    for (const [id, p] of Object.entries(before.drawn)) {
      if (!drawn[id] || group.has(id) || !same(id) || at.has(`${p.q},${p.r}`)) continue;
      at.delete(`${drawn[id].q},${drawn[id].r}`);
      at.add(`${p.q},${p.r}`);
      drawn[id] = p;
    }
  }
  return { ...args, beads, headId, positions, drawn };
}

const intentKey = (cellId, headId) => `${cellId}:${headId}`;
const UNSETTLED_STATES = ['pending', 'uncertain', 'partial'];

function inFlight(doc, cellId, ids, skip = null) {
  return Object.values(doc.operations).some((op) => op.id !== skip && op.cellId === cellId && ['delete-beads', 'reopen'].includes(op.kind)
    && UNSETTLED_STATES.includes(op.state) && (op.intent?.beadIds || op.beadIds || []).some((b) => ids.has(b)));
}

// The hive as it is now, which must still be the enabled live hive the
// reopen was checked against.
function liveCell(rt, cellId, rootId) {
  if (rt.metadata.error) throw new HiveError(rt.metadata.error, 'metadata-unavailable');
  const cell = rt.metadata.cell(cellId);
  if (!cell || cell.rootBeadId !== rootId) throw new HiveError('This hive changed. Nothing was reopened.', 'stale');
  refuseSnapshot(cell);
  if (!cell.enabled) throw new HiveError('This hive is off. Nothing was reopened.', 'stale');
  return cell;
}

// The store and the hive as read inside the reopen's own queued job must
// still show what was confirmed: the hive enabled and live, no deletion or
// other reopen of this work unsettled, every heading closed and inside this
// hive, and the same closed headings around it. Then, before Beads is
// written, the restore it owes is recorded, so it is finished later if it
// cannot be finished now. `before` is given the map as it is drawn then.
function reopenFence(rt, cell, id, ancestors, ids, { opId, by, unfinished = null, triggers = [], notice = null, before = null }) {
  return (read) => {
    const live = liveCell(rt, cell.id, cell.rootBeadId);
    const doc = rt.metadata.read();
    if (inFlight(doc, cell.id, new Set([...ids, ...triggers]), opId)) throw new HiveError('A deletion or another reopen of this work is still unsettled. Nothing was reopened.', 'conflict');
    if (read.errors?.length) throw new HiveError('Hive could not read every item in the store, so nothing was reopened. Check again.', 'stale');
    const { beads } = buildGraph(read.issues);
    if (!beads[id] || !descendantIds(beads, live.rootBeadId).has(id) || id === live.rootBeadId) throw new HiveError(`${id} is no longer a workstream in this hive. Nothing was reopened.`, 'stale');
    for (const b of ids) if (beads[b]?.status !== 'closed') throw new HiveError(`${b} is no longer closed. Nothing was reopened.`, 'stale');
    const now = closedAncestors(beads, live.rootBeadId, id);
    if (now.join() !== ancestors.join()) throw new HiveError(`The closed workstreams around ${id} changed. Reopening it now would also reopen ${now.length ? now.join(', ') : 'nothing else'}. Check again before reopening.`, 'stale');
    if (unfinished && !unfinished(beads).length) throw new HiveError(`Nothing under ${id} is unfinished any more.`, 'stale');
    const head = hiddenHead({ beads, rootId: live.rootBeadId, archived: doc.archived, heads: ids });
    const geo = head ? structuredClone(doc.archived[head].positions) : {};
    if (before) {
      const saved = doc.beadLayout[cell.id] || {};
      Object.assign(before, { cellId: cell.id, saved: structuredClone(saved), drawn: drawnNow({ beads, rootId: live.rootBeadId, saved, aspect: doc.arrangeAspect[cell.id] ?? null, archived: doc.archived }) });
    }
    rt.metadata.mutate((d) => {
      d.restoring[intentKey(cell.id, id)] = { cellId: cell.id, headId: id, ids, geo, opId, by, at: Date.now(), ...(notice ? { notice } : {}) };
    });
  };
}

// One bd reopen of `ids`, fenced by `check`. When bd reports a failure, each
// id is read again so a partial reopen is reported as one.
async function runReopen(rt, ids, reason, actor, check, phase) {
  let failure = null;
  try {
    await rt.beads.reopen(ids, reason, actor, check);
  } catch (err) {
    if (err.code === 'uncertain' || err instanceof HiveError) throw err;
    failure = err;
  }
  const still = [];
  try {
    for (const b of ids) {
      const raw = await rt.beads.show(b);
      if (!raw || normalizeIssue(raw).status === 'closed') still.push(b);
    }
  } catch (err) {
    throw new BeadsError('uncertain', `${failure ? `bd reported a failure (${failure.message}) and ` : ''}Hive could not check which items were reopened: ${err.message}`);
  }
  if (still.length === ids.length && failure) throw failure;
  phase.applied = true;
  if (still.length) {
    const done = ids.filter((b) => !still.includes(b));
    throw new BeadsError('partial', `${done.length ? `${done.join(', ')} ${done.length === 1 ? 'was' : 'were'} reopened, but` : 'Beads reported success, but'} ${still.join(', ')} ${still.length === 1 ? 'is' : 'are'} still closed${failure ? `: ${failure.message}` : '.'}`);
  }
}

const NOTICE_CAP = 10;

function addNotice(d, cellId, it, beads) {
  const list = Array.isArray(d.restoreNotices[cellId]) ? d.restoreNotices[cellId] : [];
  const at = Date.now();
  const n = it.notice || {};
  d.restoreNotices[cellId] = [...list, {
    id: `${at}-${it.headId}`, at, headId: it.headId, by: it.by, title: String(n.title ?? beads[it.headId]?.title ?? '').slice(0, LIMITS.short), reopened: it.ids, triggers: n.triggers || [], more: n.more || 0, placed: 'restored',
  }].slice(-NOTICE_CAP);
}

// The hive a heading is in now: the nearest goal above it. A group can move
// to another hive between its reopen and its restore.
function ownerCell(doc, beads, headId) {
  const roots = new Map(Object.values(doc.cells).filter((c) => c.rootBeadId).map((c) => [c.rootBeadId, c]));
  for (let p = beads[headId]?.parentId; p && beads[p]; p = beads[p].parentId) {
    if (roots.has(p)) return roots.get(p);
  }
  return null;
}

const usable = (cell) => cell && cell.enabled && !cell.snapshot;

// The geometry a restore still owes, from the intent or, for one recorded
// before it kept its own copy, from the records of its headings.
const owed = (d, it) => it.geo || Object.assign({}, ...(it.stages || []).map((h) => d.archived[h]?.positions || {}));

// The parts of `geo` as the store has them now, each led by its topmost
// bead: a bead that moved away from its group leads its own part.
function parts(beads, geo) {
  const out = new Map();
  for (const id of Object.keys(geo)) {
    if (!beads[id]) continue;
    let top = id;
    while (geo[beads[top].parentId] && beads[beads[top].parentId]) top = beads[top].parentId;
    if (!out.has(top)) out.set(top, {});
    out.get(top)[id] = geo[id];
  }
  return out;
}

// Finishes a recorded restore once its headings are open. Each part of the
// group, kept as the intent's geometry, is put back in its exact shape in
// the hive its leading bead is in now, so beads that moved apart are each
// placed where they are. Geometry not yet placed stays in the intent, and
// the records are dropped once all of it is back, except one made by a later
// archive of a heading closed again since. True when all is done.
function settleRestore(rt, key, before = null) {
  let done = false;
  rt.metadata.mutate((d) => {
    const it = d.restoring[key];
    if (!it) return;
    const { beads } = rt.snapshots.graph;
    const left = {};
    for (const [head, positions] of parts(beads, owed(d, it))) {
      const cell = ownerCell(d, beads, head);
      const plan = usable(cell) && planPlace(restoreArgs(d, cell, beads, head, positions, before));
      if (!plan) {
        Object.assign(left, positions);
        continue;
      }
      d.beadLayout[cell.id] = plan.saved;
    }
    if (Object.keys(left).length) {
      const { stages, ...rest } = it;
      d.restoring[key] = { ...rest, geo: left };
      return;
    }
    for (const h of it.ids) {
      if (!(beads[h]?.status === 'closed' && d.archived[h]?.closedAt === beads[h].closedAt)) delete d.archived[h];
    }
    delete d.restoring[key];
    const home = ownerCell(d, beads, it.headId) || Object.values(d.cells).find((c) => c.id === it.cellId);
    if (it.notice && home) addNotice(d, home.id, it, beads);
    done = true;
  });
  return done;
}

// A restore is marked opened in the same save that records its reopen as
// applied, so later changes to the headings never make it look as if the
// reopen did not happen. One whose receipt was settled as applied later
// counts as opened too.
const markOpened = (key) => (d) => {
  if (d.restoring[key]) d.restoring[key] = { ...d.restoring[key], opened: true };
};

const opened = (doc, it) => {
  const op = doc.operations[it.opId];
  return Boolean(it.opened || op?.state === 'applied' || (op?.state === 'resolved' && op.verdict === 'applied'));
};

// A restore that cannot be finished now, or whose save fails, is kept and
// tried again on a later pass.
function trySettle(rt, key, before = null) {
  try {
    return settleRestore(rt, key, before);
  } catch (err) {
    rt.log(`hive: could not save the restore of ${key}: ${err.message}`);
    return false;
  }
}

const PENDING_NOTE = 'It was reopened, but its group could not be put back yet. Hive keeps its shape and tries again shortly.';

const settling = new Set();

export async function reopenWorkstream(rt, { cellId, headId, reason, confirmAncestors }) {
  ensureWritable(rt);
  const { cell, id, beads } = workstream(rt, { cellId, headId });
  if (beads[id].status !== 'closed') throw new HiveError(`${id} is not closed.`, 'stale');
  const cleanReason = text(reason, 'reason', LIMITS.short, { required: true });
  const ancestors = closedAncestors(beads, cell.rootBeadId, id);
  const confirmed = Array.isArray(confirmAncestors) ? [...confirmAncestors].sort() : null;
  if (!confirmed || confirmed.join() !== [...ancestors].sort().join()) {
    throw new HiveError(`The closed workstreams around ${id} changed. Reopening it now would also reopen ${ancestors.length ? ancestors.join(', ') : 'nothing else'}. Check again before reopening.`, 'stale');
  }
  const ids = [...ancestors, id];
  const key = intentKey(cell.id, id);
  const before = {};
  settling.add(key);
  try {
    const out = await withLocks(ids.map((b) => `bead:${b}`), () => journaled(rt, { kind: 'reopen', cellId: cell.id, actor: HUMAN_ACTOR, summary: `Reopen ${ids.join(', ')}`, beadIds: ids, intent: { beadIds: ids }, onApplied: markOpened(key) }, async (opId, phase) => {
      await runReopen(rt, ids, cleanReason, HUMAN_ACTOR, reopenFence(rt, cell, id, ancestors, ids, { opId, by: HUMAN_ACTOR, before }), phase);
      return { journal: { reason: cleanReason } };
    }));
    await rt.snapshots.refresh();
    if (trySettle(rt, key, before)) return { opId: out.opId, reopened: ids, placed: 'restored' };
    return { opId: out.opId, reopened: ids, placed: 'pending', note: PENDING_NOTE };
  } finally {
    settling.delete(key);
  }
}

const HIVE_ACTOR = 'hive';
const RETRY_MS = 10 * 60000;
const failedAt = new Map();

// The innermost closed heading above each unfinished item, with the items
// that make it inconsistent.
function closedOverUnfinished(beads, rootId) {
  const found = new Map();
  for (const b of descendantIds(beads, rootId)) {
    if (b === rootId || !OPEN_STATUSES.includes(beads[b]?.status)) continue;
    for (let p = beads[b].parentId; p && p !== rootId && beads[p]; p = beads[p].parentId) {
      if (beads[p].status !== 'closed') continue;
      if (!found.has(p)) found.set(p, []);
      found.get(p).push(b);
      break;
    }
  }
  return found;
}

function unfinishedUnder(beads, id) {
  return [...descendantIds(beads, id)].filter((b) => OPEN_STATUSES.includes(beads[b]?.status));
}

// A restore recorded before a reopen that was not finished, because Hive
// stopped or a later step failed. Once the reopen has settled it is finished
// from Hive's own records, in the hive the heading is in now; Beads is never
// written again. One whose reopen did not happen is dropped. Once a reopen is
// known to have happened, each part still owed is settled on its own, and a
// part is dropped only when its beads are gone. One that cannot be finished
// yet is kept and tried again later.
function recoverOneRestore(rt, skip) {
  const doc = rt.metadata.read();
  const { beads } = rt.snapshots.graph;
  for (const [key, it] of Object.entries(doc.restoring)) {
    if (settling.has(key) || skip.has(key)) continue;
    skip.add(key);
    const owners = [...parts(beads, owed(doc, it)).keys()].map((h) => ownerCell(doc, beads, h));
    if (inFlight(doc, it.cellId, new Set(it.ids)) || owners.some((c) => c && inFlight(doc, c.id, new Set(it.ids)))) continue;
    if (!opened(doc, it) && it.ids.some((b) => !beads[b] || beads[b].status === 'closed')) {
      rt.metadata.mutate((d) => { delete d.restoring[key]; });
    } else if (owners.length && !owners.some(usable)) {
      continue;
    } else if (!trySettle(rt, key)) {
      rt.log(`hive: could not yet put back ${it.headId} after reopening it`);
    }
    rt.changed();
    return true;
  }
  return false;
}

// A closed heading with unfinished work under it is reopened by Hive, with
// the closed headings around it, and its group goes back on the map. Each
// pass handles one heading and is journaled; the refresh after it starts the
// next. Only enabled live hives are touched, and a heading that is gone or
// has a deletion or reopen still unsettled is left alone. Both are checked
// again inside the reopen's queued job.
async function reopenOneUnfinished(rt, skip) {
  if (rt.metadata.error || rt.beads.status.state !== 'ready' || !rt.snapshots.hierarchyCurrent) return false;
  if (recoverOneRestore(rt, skip)) return true;
  const doc = rt.metadata.read();
  const { beads } = rt.snapshots.graph;
  for (const cell of Object.values(doc.cells)) {
    if (!cell.enabled || cell.snapshot || !cell.rootBeadId || !beads[cell.rootBeadId]) continue;
    for (const [id, triggers] of closedOverUnfinished(beads, cell.rootBeadId)) {
      const ancestors = closedAncestors(beads, cell.rootBeadId, id);
      const ids = [...ancestors, id];
      if (inFlight(doc, cell.id, new Set([...ids, ...triggers]))) continue;
      const tried = intentKey(cell.id, id);
      if (Date.now() - (failedAt.get(tried) || 0) < RETRY_MS) continue;
      const shown = triggers.slice(0, 10);
      const reason = `Unfinished work under it: ${shown.join(', ')}${triggers.length > shown.length ? ', …' : ''}`;
      const notice = { title: String(beads[id].title || '').slice(0, LIMITS.short), triggers: shown, more: triggers.length - shown.length };
      settling.add(tried);
      try {
        await withLocks(ids.map((b) => `bead:${b}`), () => journaled(rt, { kind: 'reopen', cellId: cell.id, actor: HIVE_ACTOR, summary: `Reopen ${ids.join(', ')}: ${reason}`, beadIds: ids, intent: { beadIds: ids }, onApplied: markOpened(tried) }, async (opId, phase) => {
          const check = reopenFence(rt, cell, id, ancestors, ids, { opId, by: HIVE_ACTOR, unfinished: (fresh) => unfinishedUnder(fresh, id), triggers, notice });
          await runReopen(rt, ids, reason, HIVE_ACTOR, check, phase);
          return { journal: { reason, triggers: shown } };
        }));
        failedAt.delete(tried);
      } catch (err) {
        failedAt.set(tried, Date.now());
        rt.log(`hive: could not reopen ${id} over its unfinished work: ${err.message}`);
        continue;
      } finally {
        settling.delete(tried);
      }
      skip.add(tried);
      await rt.snapshots.refresh();
      trySettle(rt, tried);
      rt.changed();
      return true;
    }
  }
  return false;
}

let reconciling = null;
let reconcileAgain = false;

export function reopenUnfinished(rt) {
  if (reconciling) {
    reconcileAgain = true;
    return reconciling;
  }
  reconciling = (async () => {
    do {
      reconcileAgain = false;
      const skip = new Set();
      while (await reopenOneUnfinished(rt, skip));
    } while (reconcileAgain);
  })().catch((err) => rt.log(`hive: reopening workstreams over unfinished work failed: ${err.message}`)).finally(() => { reconciling = null; });
  return reconciling;
}

export function dismissRestoreNotice(rt, { cellId, noticeId }) {
  rt.metadata.mutate((d) => {
    const list = Array.isArray(d.restoreNotices[cellId]) ? d.restoreNotices[cellId] : [];
    d.restoreNotices[cellId] = list.filter((x) => x.id !== noticeId);
  });
  return { dismissed: true };
}
