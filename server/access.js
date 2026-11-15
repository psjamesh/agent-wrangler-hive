import { assertCurrent } from './lifetime.js';
import { isSessionId } from './bead-model.js';

export class AccessError extends Error {
  constructor(message) {
    super(message);
    this.code = 'access';
  }
}

export const COORDINATING_ROLES = new Set(['queen', 'coordinator']);
export const SPAWN_GRACE_MS = 10 * 60 * 1000;

function taskIdOf(host, sessionId) {
  try {
    return host?.tasks?.forSession?.(sessionId)?.taskId ?? null;
  } catch {
    return null;
  }
}

// Every enabled cell a session takes part in, with its strongest role there.
// The nominated queen; a session the board puts in the cell's task; a session
// with an active Hive binding; or, until its task assignment lands, a session a
// participant has just spawned into this cell's own task (see prepareSession).
// That grace ends as soon as the session is assigned anywhere else. The caller id comes from the MCP layer,
// never from a tool argument.
export function participation(rt, host, sessionId) {
  if (!isSessionId(sessionId)) return [];
  const doc = rt.metadata.read();
  const taskId = taskIdOf(host, sessionId);
  const pending = rt.pendingParticipants.get(sessionId);
  const spawned = pending && Date.now() - pending.at < SPAWN_GRACE_MS && (!taskId || taskId === pending.taskId) ? pending : null;
  const out = [];
  for (const cell of Object.values(doc.cells)) {
    if (!cell.enabled || cell.snapshot) continue;
    const bindings = (doc.bindings[cell.id] || []).filter((b) => b.active && b.sessionId === sessionId);
    let role = null;
    if (cell.queenSessionId === sessionId) role = 'queen';
    else if (bindings.some((b) => b.role === 'coordinator')) role = 'coordinator';
    else if (bindings.length || (taskId && taskId === cell.taskId) || (spawned?.cellId === cell.id && spawned.taskId === cell.taskId)) role = 'worker';
    if (role) out.push({ cell, role });
  }
  return out;
}

export function roleIn(rt, host, sessionId, cellId) {
  return participation(rt, host, sessionId).find((p) => p.cell.id === cellId)?.role ?? null;
}

export function resolveCaller(rt, host, caller, cellId) {
  if (!isSessionId(caller)) throw new AccessError('This request carried no session identity, so Hive cannot attribute or authorize it.');
  const mine = participation(rt, host, caller);
  if (cellId) {
    const hit = mine.find((p) => p.cell.id === cellId);
    if (hit) return { sessionId: caller, cell: hit.cell, role: hit.role, cells: mine };
    const cell = rt.metadata.cell(cellId);
    if (!cell) throw new AccessError(`Unknown Hive cell ${cellId}.`);
    if (!cell.enabled) throw new AccessError(`Hive cell ${cellId} is turned off.`);
    if (cell.snapshot) throw new AccessError(`Hive cell ${cellId} is a captured snapshot and is read only.`);
    throw new AccessError(`You do not take part in Hive cell ${cellId}. A session takes part when it is the cell's queen, is in the cell's task, or is bound to the cell by its queen.`);
  }
  if (mine.length === 1) return { sessionId: caller, cell: mine[0].cell, role: mine[0].role, cells: mine };
  if (!mine.length) throw new AccessError('You do not take part in any enabled Hive cell.');
  throw new AccessError(`You take part in several Hive cells (${mine.map((p) => p.cell.id).join(', ')}); pass cell_id.`);
}

export function requireCoordinator(actor, what) {
  if (!COORDINATING_ROLES.has(actor.role)) throw new AccessError(`Only the cell's queen or a coordinator bound by it can ${what}.`);
}

export function requireQueen(actor, what) {
  if (actor.role !== 'queen') throw new AccessError(`Only the cell's nominated queen can ${what}.`);
}

// The cell a bead belongs to: the nearest ancestor (or itself) that is an
// enabled cell's root.
export function cellOfBead(rt, beadId) {
  const beads = rt.snapshots.graph.beads;
  const roots = new Map();
  for (const cell of rt.metadata.cells()) if (cell.rootBeadId) roots.set(cell.rootBeadId, cell);
  const seen = new Set();
  let cursor = beads[beadId];
  while (cursor && !seen.has(cursor.id)) {
    if (roots.has(cursor.id)) return roots.get(cursor.id);
    seen.add(cursor.id);
    cursor = cursor.parentId ? beads[cursor.parentId] : null;
  }
  return null;
}

export function requireCompleteHierarchy(rt) {
  if (rt.snapshots.current?.error || rt.snapshots.hierarchyCurrent === false) {
    throw new AccessError('The Beads snapshot is incomplete or out of date. Wait for a complete refresh before changing or admitting work. Nothing was changed.');
  }
}

// Only read-only admission may be retried; callers perform effects afterwards.
export async function waitForHierarchy(rt, { read, refresh = false, timeoutMs = 10000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let backoff = 250;
  const busy = () => Object.assign(new AccessError('Hive is still catching up with a hierarchy change. It is safe to retry in about 1 second. No action was retried.'), { code: 'busy', hierarchyBusy: true, noWrite: true });
  async function bounded(fn) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw busy();
    let timer;
    try {
      return await Promise.race([Promise.resolve().then(fn), new Promise((_, reject) => { timer = setTimeout(() => reject(busy()), remaining); })]);
    } finally { clearTimeout(timer); }
  }
  while (true) {
    assertCurrent(rt);
    if (rt.beads.status.state !== 'ready') throw Object.assign(new AccessError(`Hive's Beads store is not ready (${rt.beads.status.state}). Finish setup in the Hive view before retrying.`), { code: 'setup-required', noWrite: true });
    if (rt.snapshots.current?.error) requireCompleteHierarchy(rt);
    if ((refresh || rt.snapshots.hierarchyCurrent === false) && !rt.beads.hierarchy?.writing) {
      await bounded(() => rt.snapshots.refresh());
      assertCurrent(rt);
      if (rt.snapshots.current?.error) requireCompleteHierarchy(rt);
    }
    if (rt.snapshots.hierarchyCurrent !== false) {
      const generation = rt.beads.hierarchy?.generation;
      const result = read ? await bounded(read) : undefined;
      assertCurrent(rt);
      if (rt.snapshots.current?.error) requireCompleteHierarchy(rt);
      if (rt.snapshots.hierarchyCurrent !== false && generation === rt.beads.hierarchy?.generation) return result;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw busy();
    await new Promise(resolve => setTimeout(resolve, Math.min(backoff, remaining)));
    backoff = Math.min(backoff * 2, 1000);
  }
}

// A bead an actor may change: it must sit under a cell the actor takes part
// in. Passing another cell's ids does not reach it.
export function requireBeadAccess(rt, actor, beadId) {
  requireCompleteHierarchy(rt);
  const bead = rt.snapshots.graph.beads[beadId];
  if (!bead) throw new AccessError(`Unknown bead ${beadId}. Call hive_context for current ids; a bead created outside Hive appears after the next refresh.`);
  const cell = cellOfBead(rt, beadId);
  if (!cell) throw new AccessError(`Bead ${beadId} is not part of any Hive cell.`);
  const part = actor.cells.find((p) => p.cell.id === cell.id);
  if (!part) throw new AccessError(`Bead ${beadId} belongs to cell ${cell.id}, which you do not take part in.`);
  return { bead, cell, role: part.role };
}

export function requireNonHelper(rt, actor, what) {
  if (isHelper(rt, actor.sessionId, actor.cell.id)) {
    throw new AccessError(`Helper sessions cannot ${what}. Report back to the bead's holder.`);
  }
}

export function isHelper(rt, sessionId, cellId) {
  const cell = rt.metadata.cell(cellId);
  const bindings = (rt.metadata.read().bindings[cellId] || []).filter(b => b.active && b.sessionId === sessionId);
  if (cell?.queenSessionId === sessionId || bindings.some(b => b.role === 'coordinator')) return false;
  const session = rt.host?.sessions?.get(sessionId);
  if (session && !session.archived && session.status !== 'exited' && Object.values(rt.snapshots.graph.beads).some(b => b.status !== 'closed' && b.assignee === `aw:${sessionId}`)) return false;
  return bindings.some(b => b.role === 'investigator' && (b.workerLaunchId || b.helper));
}
