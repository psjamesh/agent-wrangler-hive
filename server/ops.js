import { consumePickup, managedPickupReceipt, pickupState, structuralPickupReasons } from './pickup.js';
import { storedRole, apiRole, holdsBead } from './bead-sessions.js';
import { REGION_LAYOUT_VERSION } from './region-migration.js';
import crypto from 'node:crypto';
import { assertCurrent } from './lifetime.js';
import { openReview } from './review-state.js';
import { humanWaitText, hasOpenRequest, hasBlockingPrerequisite, hasOpenReview, HUMAN_WAIT_WARNING } from './human-wait.js';
import { ADMISSION_LOCK, checkAdmission, exportedGraph, capacity, RESERVED_LAUNCH_STATES } from './admission.js';
import { newId } from './metadata-store.js';
import { assertAllowedReviewer } from './review-policy.js';
import { BeadsError } from './beads.js';
import {
  actorFor, issueTypeForKind, GROUP_KINDS, isBeadId, isSessionId, SETTABLE_STATUSES, LINK_TYPES, OUTCOMES, OPEN_STATUSES, descendantIds, normalizeIssue, buildGraph,
} from './bead-model.js';
import { AccessError, COORDINATING_ROLES, requireBeadAccess, requireCoordinator, requireQueen, cellOfBead, requireCompleteHierarchy } from './access.js';
import { layoutBase, stackable } from '../public/layout-base.js';
import { archiveHidden } from '../public/archive-layout.js';
import { inRange, MAX_COORD } from '../public/hex-search.js';

export class HiveError extends Error {
  constructor(message, code = 'invalid') {
    super(message);
    this.code = code;
  }
}

export const LIMITS = { title: 200, short: 2000, instructions: 8000, long: 20000, evidence: 50, beads: 50, links: 50, label: 200, url: 2000 };

export function text(value, field, max, { required = false, allowEmpty = true } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new HiveError(`${field} is required.`);
    return undefined;
  }
  if (typeof value !== 'string') throw new HiveError(`${field} must be a string.`);
  const trimmed = value.trim();
  if ((required || !allowEmpty) && !trimmed) throw new HiveError(`${field} cannot be empty.`);
  if (trimmed.length > max) throw new HiveError(`${field} is longer than ${max} characters.`);
  return trimmed;
}

export function beadIdArg(value, field) {
  if (!isBeadId(value)) throw new HiveError(`${field} must be a bead id.`);
  return value;
}

export function ensureWritable(rt) {
  assertCurrent(rt);
  if (rt.metadata.error) throw new HiveError(rt.metadata.error, 'metadata-unavailable');
  if (rt.beads.status.state !== 'ready') {
    throw new HiveError(`Hive's Beads store is not ready (${rt.beads.status.state}). Nothing was changed. ${rt.beads.status.detail || ''} The human can finish setup in the Hive view.`, 'setup-required');
  }
  requireCompleteHierarchy(rt);
}

const locks = new Map();
// Several locks are always taken in one order, so two callers can never each
// hold one the other waits for.
export function withLocks(keys, fn) {
  return takeLocks([...new Set(keys)].sort(), fn);
}

function takeLocks(keys, fn) {
  return keys.length ? withLock(keys[0], () => takeLocks(keys.slice(1), fn)) : fn();
}

export async function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  let release;
  const mine = new Promise((r) => { release = r; });
  const chain = prev.then(() => mine);
  locks.set(key, chain);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(key) === chain) locks.delete(key);
  }
}

function stamp(op, patch) {
  return { ...op, ...patch, updatedAt: Date.now() };
}

// Records a write that crosses into bd before running it, so a crash or
// timeout leaves a visible pending/uncertain record rather than a silent gap,
// and nothing is ever retried behind the caller's back. `phase.applied` is set
// by the operation as soon as its side effect has happened: any failure after
// that point is bookkeeping, and leaves the operation recoverable rather than
// "error". `intent` is the requested final state in structured form (ids and
// expected values, never free text), so recovery can check the store for it.
export async function journaled(rt, { kind, cellId = null, actor, summary = '', beadIds = [], intent = null, onApplied = null }, fn) {
  ensureWritable(rt);
  const blocked = Object.values(rt.metadata.read?.().operations || {}).find((op) =>
    managedReleaseIntent(op) && UNSETTLED.has(op.state) && beadIds.includes(op.intent.beadId));
  if (blocked) throw new HiveError(`Release operation ${blocked.id} must be reconciled before changing ${blocked.intent.beadId}.`, 'busy');
  const opId = newId('op');
  const at = Date.now();
  rt.metadata.mutate((d) => {
    d.operations[opId] = { id: opId, kind, cellId, actor, summary: summary.slice(0, 300), beadIds: beadIds.slice(0, 20), ...(intent ? { intent } : {}), state: 'pending', createdAt: at, updatedAt: at };
  });
  if (kind === 'claim') rt.changed();
  const phase = { applied: false };
  running.add(opId);
  try {
    let result;
    try {
      result = await fn(opId, phase);
    } catch (err) {
      let code = err?.code;
      if (code !== 'uncertain' && code !== 'partial' && (phase.applied || (phase.attempted && !err.noWrite))) {
        code = 'uncertain';
        err.code = code;
        err.message = phase.applied
          ? `The change was made in Beads, but Hive's follow-up step failed: ${err.message}`
          : `A Beads write was attempted, but Hive could not confirm the outcome: ${err.message}`;
      }
      const state = code === 'uncertain' ? 'uncertain' : code === 'partial' ? 'partial' : 'error';
      try {
        rt.metadata.mutate((d) => {
          if (d.operations[opId]) d.operations[opId] = stamp(d.operations[opId], { state, error: String(err?.message || err).slice(0, 1000) });
        });
      } catch (metaErr) {
        rt.log(`hive: could not record outcome of ${opId}; it stays pending: ${metaErr.message}`);
      }
      if (state !== 'error') err.message = `${err.message} (operation ${opId}). Do not repeat it. Hive checks the store for its outcome on its own; while it stays unsettled it is listed in hive_context, and the queen settles it with hive_reconcile_operation.`;
      err.opId = opId;
      throw err;
    }
    try {
      rt.metadata.mutate((d) => {
        if (d.operations[opId]) d.operations[opId] = stamp(d.operations[opId], { state: 'applied', result: result?.journal ?? null });
        onApplied?.(d);
      });
    } catch (metaErr) {
      const err = new HiveError(`The change was made in Beads, but Hive could not record it (${metaErr.message}). Operation ${opId} stays pending; do not repeat it.`, 'partial');
      err.opId = opId;
      throw err;
    }
    rt.afterWrite?.(beadIds);
    return { opId, ...result };
  } finally {
    running.delete(opId);
    rt.snapshots.invalidate();
  }
}

// Operations whose write is still in progress in this process. Recovery never
// judges these.
const running = new Set();
export function isRunning(opId) {
  return running.has(opId);
}

// A new cell's overview slot: the nearest free hex in an elliptical order
// about twice as wide as tall, so the overview grows sideways for widescreen
// rather than in a ring. Existing positions never move.
const OVERVIEW_ASPECT = 2;
let overviewOrder = null;

function freePosition(cells) {
  const taken = new Set(cells.filter((c) => !c.retired).map((c) => `${c.position?.q},${c.position?.r}`));
  if (!overviewOrder) {
    const all = [];
    for (let q = -40; q <= 40; q += 1) {
      for (let r = -20; r <= 20; r += 1) {
        const x = Math.sqrt(3) * (q + r / 2);
        const y = 1.5 * r;
        all.push({ q, r, d: (x / OVERVIEW_ASPECT) ** 2 + y ** 2, a: Math.atan2(y, x) });
      }
    }
    overviewOrder = all.sort((m, n) => m.d - n.d || m.a - n.a).map(({ q, r }) => ({ q, r }));
  }
  for (const p of overviewOrder) if (!taken.has(`${p.q},${p.r}`)) return p;
  return { q: cells.length, r: 0 };
}

function axial(value) {
  if (!value || typeof value !== 'object') throw new HiveError('position must be {q, r}.');
  const { q, r } = value;
  if (!inRange({ q, r })) throw new HiveError(`position q and r must be whole numbers from -${MAX_COORD} to ${MAX_COORD}.`);
  return { q, r };
}

// ---- Human configuration ----

export async function createCellRoot(rt, { cellId, title, goal, acceptance, actor }) {
  return journaled(rt, { kind: 'cell-root', cellId, actor, summary: `Create root goal "${title}"` }, async (opId, phase) => {
    rt.metadata.mutate((d) => {
      if (d.cells[cellId]) d.cells[cellId].setup = { state: 'pending', opId };
    });
    let ids;
    try {
      ({ ids } = await rt.beads.createMany({
        nodes: [{ key: 'root', title, kind: 'goal', issueType: 'epic', goal, acceptance, cellId }],
      }, actor, opId));
      phase.applied = true;
    } catch (err) {
      try {
        rt.metadata.mutate((d) => {
          if (d.cells[cellId]) d.cells[cellId].setup = { state: err.code === 'uncertain' ? 'uncertain' : 'failed', opId, error: err.message };
        });
      } catch (metaErr) {
        rt.log(`hive: could not record root setup state for ${cellId}: ${metaErr.message}`);
      }
      throw err;
    }
    rt.metadata.mutate((d) => {
      if (d.cells[cellId]) {
        d.cells[cellId].rootBeadId = ids.root;
        d.cells[cellId].setup = { state: 'ready', opId };
      }
    });
    await rt.snapshots.refresh();
    return { rootBeadId: ids.root, journal: { ids } };
  });
}

// AW's task create has no idempotency key, so the intent is written first. If
// the process stops after AW created the task but before Hive recorded it, the
// pending operation stays visible (with the name) for the human to adopt the
// task that exists instead of creating another.
export async function createCell(rt, host, { name, goal, acceptance, instructions, position }) {
  ensureWritable(rt);
  const cleanName = text(name, 'name', LIMITS.title, { required: true });
  const cleanInstructions = text(instructions, 'instructions', LIMITS.instructions) || '';
  const cleanGoal = text(goal, 'goal', LIMITS.short) || '';
  const cleanAcceptance = text(acceptance, 'acceptance', LIMITS.short) || '';
  const pos = position ? axial(position) : null;
  const opId = newId('op');
  const cellId = newId('cell');
  const at = Date.now();
  rt.metadata.mutate((d) => {
    d.operations[opId] = {
      id: opId, kind: 'cell-create', cellId, actor: actorFor(null), state: 'pending', createdAt: at, updatedAt: at,
      summary: `Create task and cell "${cleanName}". If this stays unfinished, check the board for that task and add it with "Add existing task" rather than creating it again.`.slice(0, 300),
    };
  });
  let task;
  try {
    assertCurrent(rt, host);
    task = host.tasks.create({ name: cleanName });
  } catch (err) {
    // AW checks its task limit before touching anything; any other throw can
    // come after the task was added in memory (its save failed), so the task
    // may exist and the intent stays open for the human to check.
    const refusedBeforeChange = /^Task limit reached \(max [0-9]+\)\.$/.test(String(err?.message ?? '')) && !String(err.message).endsWith('\n');
    const message = refusedBeforeChange
      ? `AW refused to create the task: ${err.message}`
      : `AW reported an error while creating task "${cleanName}" (${err?.message || err}). The task may exist anyway: check the board and add it with "Add existing task" rather than creating it again.`;
    try {
      rt.metadata.mutate((d) => {
        d.operations[opId] = stamp(d.operations[opId], { state: refusedBeforeChange ? 'error' : 'uncertain', error: message.slice(0, 1000) });
      });
    } catch (metaErr) {
      rt.log(`hive: could not record outcome of ${opId}; it stays pending: ${metaErr.message}`);
    }
    throw new HiveError(refusedBeforeChange ? message : `${message} (operation ${opId})`, refusedBeforeChange ? 'refused' : 'uncertain');
  }
  try {
    rt.metadata.mutate((d) => {
      (d.regionLayout ||= {})[cellId] = REGION_LAYOUT_VERSION;
      d.cells[cellId] = {
        id: cellId,
        taskId: task.id,
        rootBeadId: null,
        queenSessionId: null,
        queens: [],
        queenInstructions: cleanInstructions,
        enabled: true,
        position: pos || freePosition(Object.values(d.cells)),
        setup: { state: 'pending' },
        createdAt: at,
        updatedAt: Date.now(),
      };
      d.operations[opId] = stamp(d.operations[opId], { state: 'applied', result: { taskId: task.id } });
    });
  } catch (err) {
    throw new HiveError(`The task "${cleanName}" (${task.id}) was created on the board, but Hive could not record its cell: ${err.message}. Add that task with "Add existing task" once Hive can write again; do not create it again.`, 'partial');
  }
  try {
    await createCellRoot(rt, { cellId, title: cleanName, goal: cleanGoal, acceptance: cleanAcceptance, actor: actorFor(null) });
  } catch (err) {
    return { cellId, taskId: task.id, rootError: err.message, rootState: err.code === 'uncertain' ? 'uncertain' : 'failed' };
  }
  return { cellId, taskId: task.id };
}

export async function adoptTask(rt, host, { taskId, goal, acceptance, instructions, rootBeadId, position }) {
  ensureWritable(rt);
  const cleanInstructions = text(instructions, 'instructions', LIMITS.instructions);
  const task = host.tasks.get(taskId);
  if (!task || task.archived) throw new HiveError(`Unknown or archived task ${taskId}.`);
  if (taskId === host.tasks.adhocId) throw new HiveError('The Unassigned tile cannot be a Hive cell.');
  const existing = rt.metadata.cellForTask(taskId);
  if (existing) {
    if (existing.retired) throw new HiveError('This task\'s hive is retired. Use Reopen hive to bring it back.', 'refused');
    rt.metadata.mutate((d) => {
      d.cells[existing.id].enabled = true;
      if (cleanInstructions !== undefined && !existing.snapshot) d.cells[existing.id].queenInstructions = cleanInstructions;
      d.cells[existing.id].updatedAt = Date.now();
    });
    return { cellId: existing.id, taskId, reenabled: true };
  }
  if (rootBeadId !== undefined && rootBeadId !== null && rootBeadId !== '') {
    beadIdArg(rootBeadId, 'root_bead_id');
    const bead = rt.snapshots.graph.beads[rootBeadId] || null;
    if (!bead) throw new HiveError(`Bead ${rootBeadId} is not in Hive's store.`);
    const owner = cellOfBead(rt, rootBeadId);
    if (owner) throw new HiveError(`Bead ${rootBeadId} already belongs to cell ${owner.id}.`);
  }
  const cellId = newId('cell');
  const at = Date.now();
  rt.metadata.mutate((d) => {
    (d.regionLayout ||= {})[cellId] = REGION_LAYOUT_VERSION;
    d.cells[cellId] = {
      id: cellId,
      taskId,
      rootBeadId: rootBeadId || null,
      queenSessionId: null,
      queens: [],
      queenInstructions: cleanInstructions || '',
      enabled: true,
      position: position ? axial(position) : freePosition(Object.values(d.cells)),
      setup: { state: rootBeadId ? 'ready' : 'pending' },
      createdAt: at,
      updatedAt: at,
    };
  });
  if (rootBeadId) return { cellId, taskId };
  try {
    await createCellRoot(rt, { cellId, title: task.name, goal: text(goal, 'goal', LIMITS.short) || '', acceptance: text(acceptance, 'acceptance', LIMITS.short) || '', actor: actorFor(null) });
  } catch (err) {
    return { cellId, taskId, rootError: err.message, rootState: err.code === 'uncertain' ? 'uncertain' : 'failed' };
  }
  return { cellId, taskId };
}

// How the human wants the queen to work. Guidance kept with the cell and
// repeated in queen briefs and hive_context; Hive does not enforce it.
export function setQueenInstructions(rt, { cellId, instructions }) {
  ensureWritable(rt);
  const cell = rt.metadata.cell(cellId);
  if (!cell) throw new HiveError(`Unknown cell ${cellId}.`);
  refuseSnapshot(cell);
  if (instructions === undefined || instructions === null) throw new HiveError('instructions is required; send an empty string to clear them.');
  const clean = text(instructions, 'instructions', LIMITS.instructions);
  rt.metadata.mutate((d) => {
    d.cells[cellId].queenInstructions = clean;
    d.cells[cellId].updatedAt = Date.now();
  });
  return { cellId, queenInstructions: clean };
}

export function retryCellRoot(rt, host, { cellId }) {
  const cell = rt.metadata.cell(cellId);
  if (!cell) throw new HiveError(`Unknown cell ${cellId}.`);
  if (cell.rootBeadId) throw new HiveError('This cell already has a root goal.');
  if (cell.setup?.state === 'uncertain' || cell.setup?.state === 'pending') {
    throw new HiveError('The last attempt to create this cell\'s root goal has an unknown outcome. Reconcile it first.');
  }
  const task = host.tasks.get(cell.taskId);
  return createCellRoot(rt, { cellId, title: task?.name || 'Hive cell', goal: '', acceptance: '', actor: actorFor(null) });
}

export function setCellEnabled(rt, { cellId, enabled }) {
  const cell = rt.metadata.cell(cellId);
  if (!cell) throw new HiveError(`Unknown cell ${cellId}.`);
  if (cell.retired) throw new HiveError('This hive is retired. Use Reopen hive to bring it back.', 'refused');
  rt.metadata.mutate((d) => {
    d.cells[cellId].enabled = Boolean(enabled);
    d.cells[cellId].updatedAt = Date.now();
  });
  return { cellId, enabled: Boolean(enabled) };
}

export function moveCell(rt, { cellId, position }) {
  if (!rt.metadata.cell(cellId)) throw new HiveError(`Unknown cell ${cellId}.`);
  const pos = axial(position);
  rt.metadata.mutate((d) => {
    const clash = Object.values(d.cells).find((c) => c.id !== cellId && !c.retired && c.position?.q === pos.q && c.position?.r === pos.r);
    if (clash) clash.position = { ...d.cells[cellId].position };
    d.cells[cellId].position = pos;
  });
  return { cellId, position: pos, metaEpoch: rt.metadata.epoch, metaVersion: rt.metadata.version };
}

// Arrange may store the proportions automatic placement uses for a cell,
// taken from the map canvas it was pressed on. Older clients send none and
// leave the stored value alone.
const ASPECT_MIN = 0.6;
const ASPECT_MAX = 3.5;

function arrangeAspect(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new HiveError('aspect must be a positive number.');
  return Math.round(Math.min(ASPECT_MAX, Math.max(ASPECT_MIN, value)) * 10) / 10;
}

// A batch that places beads must carry `base`, the map's fingerprint of the
// layout it was planned on (public/layout-base.js). If the cell's hierarchy,
// saved positions or proportions have changed since, the whole batch is
// refused, as is one that places a bead outside the cell or on a hex another
// bead has saved. Two beads may share a hex only when all but one of them are
// named in `stack` and are closed in the graph Hive holds now: closed work hidden
// in one browser frees its hex there without losing its own saved place. While a change to which beads sit under which is running,
// or has not yet been read back, the hierarchy Hive holds may be behind the
// store, so such a batch is refused until it has caught up. Arrange only
// clears positions and needs no base.
export const CATCHING_UP = 'Hive is still catching up with a change to the work in this hive. Nothing was moved; try again in a moment.';

export function moveBeads(rt, { cellId, positions, aspect, base, stack }) {
  const cell = rt.metadata.cell(cellId);
  if (!cell) throw new HiveError(`Unknown cell ${cellId}.`);
  if (!positions || typeof positions !== 'object') throw new HiveError('positions must be an object.');
  const ratio = aspect === undefined || aspect === null ? null : arrangeAspect(aspect);
  if (ratio !== null && (cell.snapshot || !cell.enabled)) throw new HiveError('Only a hive that is on and not a captured snapshot can be arranged.');
  if (cell.retired) throw new HiveError('This hive is retired. Reopen it to rearrange its work.', 'refused');
  const entries = Object.entries(positions);
  if (entries.length > 2000) throw new HiveError('Too many positions.');
  const clean = {};
  for (const [id, pos] of entries) {
    beadIdArg(id, 'bead id');
    clean[id] = pos === null ? null : axial(pos);
  }
  if (stack !== undefined && stack !== null && (!Array.isArray(stack) || stack.length > 2000)) throw new HiveError('stack must be a list of bead ids.');
  const stacked = new Set((stack || []).map((id) => beadIdArg(id, 'bead id')));
  const placed = Object.entries(clean).filter(([, pos]) => pos !== null);
  if (placed.length) {
    if (typeof base !== 'string' || !base || base.length > 64) throw new HiveError('This move did not say which layout it was made on. Reload Hive and move again.');
    if (!rt.snapshots.hierarchyCurrent) throw new HiveError(CATCHING_UP, 'stale');
    const beads = rt.snapshots.graph.beads;
    const inCell = cell.rootBeadId && beads[cell.rootBeadId] ? descendantIds(beads, cell.rootBeadId) : new Set();
    for (const [id] of placed) {
      if (id === cell.rootBeadId || !inCell.has(id)) throw new HiveError(`Bead ${id} is not in this hive any more. Nothing was moved.`, 'stale');
    }
  }
  rt.metadata.mutate((d) => {
    if (placed.length) {
      if (!rt.snapshots.hierarchyCurrent) throw new HiveError(CATCHING_UP, 'stale');
      const beads = rt.snapshots.graph.beads;
      const hidden = archiveHidden({ beads, rootId: cell.rootBeadId, archived: d.archived });
      const current = layoutBase({ beads, rootId: cell.rootBeadId, saved: d.beadLayout[cellId] || {}, aspect: d.arrangeAspect[cellId] ?? null, hidden: [...hidden] });
      if (current !== base) throw new HiveError('The hive changed while you were moving. Nothing was moved; try again.', 'stale');
      if (placed.some(([id]) => hidden.has(id))) throw new HiveError('That work is archived and not on the map. Nothing was moved.', 'stale');
      const inCell = descendantIds(beads, cell.rootBeadId);
      const next = { ...(d.beadLayout[cellId] || {}) };
      for (const [id, pos] of Object.entries(clean)) {
        if (pos === null) delete next[id];
        else next[id] = pos;
      }
      const onHex = new Map();
      for (const [id, pos] of Object.entries(next)) {
        if (!inCell.has(id) || id === cell.rootBeadId || hidden.has(id)) continue;
        const k = `${pos.q},${pos.r}`;
        if (!onHex.has(k)) onHex.set(k, []);
        onHex.get(k).push(id);
      }
      for (const ids of onHex.values()) {
        if (ids.length < 2 || !ids.some((id) => id in clean)) continue;
        if (ids.filter((id) => !(stacked.has(id) && stackable(beads[id]))).length > 1) throw new HiveError('That move would put two beads on one hex. Nothing was moved.', 'stale');
      }
    }
    const layout = d.beadLayout[cellId] || (d.beadLayout[cellId] = {});
    for (const [id, pos] of Object.entries(clean)) {
      if (pos === null) delete layout[id];
      else layout[id] = pos;
    }
    if (ratio !== null) d.arrangeAspect[cellId] = ratio;
  });
  return { cellId, moved: entries.length, ...(ratio !== null ? { aspect: ratio } : {}), metaEpoch: rt.metadata.epoch, metaVersion: rt.metadata.version };
}

// Every change of queen selection bumps queenGeneration. A launch remembers
// the generation it started from and may only nominate its session while that
// is still current, so a later human choice is never overridden.
export function recordQueen(d, cellId, sessionId, at, via, { revokeFrom = null } = {}) {
  const cell = d.cells[cellId];
  const current = cell.queens.at(-1);
  if (current && current.sessionId === sessionId && current.to == null) return;
  if (current && current.to == null) current.to = at;
  cell.queens.push({ sessionId, from: at, to: null, via });
  cell.queenSessionId = sessionId;
  cell.queenGeneration = (cell.queenGeneration || 0) + 1;
  cell.updatedAt = at;
  if (revokeFrom && revokeFrom !== sessionId) {
    for (const b of d.bindings?.[cellId] || []) {
      if (b.active && b.sessionId === revokeFrom && b.role === 'coordinator') Object.assign(b, { active: false, unboundAt: at, unboundBy: 'aw:hive-handoff' });
    }
  }
}

export function clearQueen(d, cellId, at) {
  const cell = d.cells[cellId];
  const current = cell.queens.at(-1);
  if (current && current.to == null) current.to = at;
  cell.queenSessionId = null;
  cell.queenGeneration = (cell.queenGeneration || 0) + 1;
  cell.updatedAt = at;
}

// A captured snapshot cell shows another board's state for reading only. Its
// session references are not sessions on this board, so nothing may launch,
// nominate, brief or deliver to them.
export function refuseSnapshot(cell) {
  if (cell?.snapshot) throw new HiveError(`Cell ${cell.id} is a captured snapshot: it is read only and its sessions cannot be reached from here.`, 'snapshot');
}

export function nominateQueen(rt, host, { cellId, sessionId }) {
  const cell = rt.metadata.cell(cellId);
  if (!cell) throw new HiveError(`Unknown cell ${cellId}.`);
  refuseSnapshot(cell);
  if (!isSessionId(sessionId)) throw new HiveError('Choose a session.');
  const session = host.sessions.get(sessionId);
  if (!session || session.archived) throw new HiveError('Choose a live session.');
  if (session.taskId !== cell.taskId) throw new HiveError('The queen must be a session in this cell\'s task.');
  rt.metadata.mutate((d) => recordQueen(d, cellId, sessionId, Date.now(), 'nominated'));
  return { cellId, queenSessionId: sessionId };
}

// The human settles only an interrupted cell creation, after checking the
// board for the task it names.
export async function resolveOperation(rt, { opId, note }, actor) {
  const op = rt.metadata.read().operations[opId];
  if (!op) throw new HiveError(`Unknown operation ${opId}.`);
  if (op.kind !== 'cell-create') throw new HiveError('Hive and the cell\'s queen settle this operation; nothing is needed from you.');
  if (op.state !== 'uncertain' && op.state !== 'partial' && op.state !== 'pending') throw new HiveError(`Operation ${opId} is already ${op.state}.`);
  rt.metadata.mutate((d) => {
    d.operations[opId] = stamp(d.operations[opId], { state: 'resolved', resolvedBy: actor, resolution: (note || '').slice(0, 500) });
  });
  return { opId, state: 'resolved' };
}

// A create whose outcome was unknown is settled by READING the store for the
// beads it stamped; nothing is written again.
export async function reconcileOperation(rt, { opId }) {
  ensureWritable(rt);
  const op = rt.metadata.read().operations[opId];
  if (!op) throw new HiveError(`Unknown operation ${opId}.`);
  if (op.state !== 'uncertain' && op.state !== 'pending') return { opId, state: op.state };
  if (!['create-beads', 'cell-root'].includes(op.kind)) {
    return { opId, state: op.state, manual: true, message: 'This kind of operation cannot be checked automatically. Inspect the beads it names, then mark it resolved.' };
  }
  const ids = await rt.beads.findByOperation(opId);
  rt.metadata.mutate((d) => {
    const next = ids.length ? 'applied' : 'not-applied';
    d.operations[opId] = stamp(d.operations[opId], { state: next, reconciledIds: ids.slice(0, 100) });
    if (op.kind === 'cell-root' && op.cellId && d.cells[op.cellId] && !d.cells[op.cellId].rootBeadId) {
      if (ids.length === 1) {
        d.cells[op.cellId].rootBeadId = ids[0];
        d.cells[op.cellId].setup = { state: 'ready', opId };
      } else {
        d.cells[op.cellId].setup = { state: ids.length ? 'uncertain' : 'failed', opId, error: ids.length ? `Found ${ids.length} candidate roots.` : 'The root goal was not created.' };
      }
    }
  });
  await rt.snapshots.refresh();
  return { opId, state: ids.length ? 'applied' : 'not-applied', ids };
}

export async function reconcilePendingCreates(rt) {
  if (rt.metadata.error || rt.beads.status.state !== 'ready') return;
  const ops = Object.values(rt.metadata.read().operations)
    .filter((op) => ['create-beads', 'cell-root'].includes(op.kind) && ((op.state === 'uncertain' && Date.now() - op.updatedAt > 30000) || (op.state === 'pending' && Date.now() - op.updatedAt > 5 * 60000)));
  for (const op of ops.slice(0, 5)) {
    try {
      await reconcileOperation(rt, { opId: op.id });
    } catch (err) {
      rt.log(`hive: reconcile ${op.id} failed: ${err.message}`);
    }
  }
}

// ---- Settling recorded writes by reading the store ----

export const UNSETTLED = new Set(['pending', 'uncertain', 'partial']);
const PENDING_STALE_MS = 5 * 60000;
const RECHECK_MS = 10 * 60000;
const SETTLE_BATCH = 5;
const lastChecked = new Map();

// An operation is open for recovery when it is unsettled and not still
// running: a pending record counts only once it is old enough that its
// process has clearly stopped.
export function needsSettling(op, now = Date.now()) {
  if (!op || !UNSETTLED.has(op.state) || running.has(op.id)) return false;
  return !!managedReleaseIntent(op) || op.state !== 'pending' || now - (op.updatedAt || 0) > PENDING_STALE_MS;
}

// What a finish asked for. New records carry it as intent. A record written
// before intent existed is recognised only in the one exact form Hive used
// ("Finish <id> as <outcome>" naming its single bead); anything else is not
// treated as a finish.
export function finishIntent(op) {
  if (op?.kind !== 'finish') return null;
  const i = op.intent;
  if (i && isBeadId(i.beadId) && OUTCOMES.includes(i.outcome)) return { beadId: i.beadId, outcome: i.outcome };
  if (i) return null;
  const m = /^Finish (\S+) as ([a-z]+)$/.exec(op.summary || '');
  if (!m || !Array.isArray(op.beadIds) || op.beadIds.length !== 1 || op.beadIds[0] !== m[1]) return null;
  if (!isBeadId(m[1]) || !OUTCOMES.includes(m[2])) return null;
  return { beadId: m[1], outcome: m[2] };
}

// The bead whose current state can confirm this operation, or null when Hive
// cannot check it from the store (such as a claim or release recorded before
// intent existed).
export function checkTarget(op) {
  const id = finishIntent(op)?.beadId || (op?.intent && ['claim', 'release'].includes(op.kind) ? op.intent.beadId : null) || deleteIntent(op)?.[0] || reopenIntent(op)?.[0];
  return id && isBeadId(id) ? id : null;
}

export function managedReleaseIntent(op) {
  const i = op?.kind === 'release' ? op.intent : null;
  return i && isBeadId(i.beadId) && typeof i.holder === 'string' && i.holder
    && SETTABLE_STATUSES.includes(i.priorStatus) && SETTABLE_STATUSES.includes(i.status) ? i : null;
}

export function reopenIntent(op) {
  const ids = op?.kind === 'reopen' ? op.intent?.beadIds : null;
  return Array.isArray(ids) && ids.length && ids.every(isBeadId) ? ids : null;
}

export function deleteIntent(op) {
  const ids = op?.kind === 'delete-beads' ? op.intent?.beadIds : null;
  return Array.isArray(ids) && ids.length && ids.every(isBeadId) ? ids : null;
}

// Queen notice receipts by queen session, so a queen that returns keeps its
// earlier receipt and retry count. A record from before receipts were kept per
// queen counts as that one queen's receipt.
export function noticeReceipts(op) {
  if (op?.notices && typeof op.notices === 'object' && !Array.isArray(op.notices)) return op.notices;
  return typeof op?.notice?.sessionId === 'string' ? { [op.notice.sessionId]: op.notice } : {};
}

// Least recently checked first, so a backlog that never settles cannot keep
// later operations from being checked.
export function byLastChecked(a, b) {
  return (lastChecked.get(a.id) || 0) - (lastChecked.get(b.id) || 0) || (a.updatedAt || 0) - (b.updatedAt || 0) || String(a.id).localeCompare(String(b.id));
}

function markChecked(opId) {
  lastChecked.delete(opId);
  lastChecked.set(opId, Date.now());
}

// Reads the one bead an operation is about and says whether the state it asked
// for is there now. Nothing is written to Beads. A finish counts only when the
// item is closed with exactly the requested outcome recorded; closed with no
// outcome or a different one stays unsettled for the queen.
async function observe(rt, op) {
  const reopening = reopenIntent(op);
  if (reopening) {
    const closed = [];
    const missing = [];
    for (const id of reopening) {
      const raw = await rt.beads.show(id);
      if (!raw) missing.push(id);
      else if (normalizeIssue(raw).status === 'closed') closed.push(id);
    }
    return { checkable: true, settled: !closed.length && !missing.length, observed: { closed, missing, at: Date.now() } };
  }
  const deleting = deleteIntent(op);
  if (deleting) {
    const present = [];
    for (const id of deleting) if (await rt.beads.show(id)) present.push(id);
    const missing = deleting.filter((id) => !present.includes(id));
    return { checkable: true, settled: !present.length, observed: { missing, present, at: Date.now() } };
  }
  const finish = finishIntent(op);
  const beadId = checkTarget(op);
  if (!beadId) return { checkable: false };
  const raw = await rt.beads.show(beadId);
  const at = Date.now();
  if (!raw) return { checkable: true, settled: false, observed: { beadId, missing: true, at } };
  const bead = normalizeIssue(raw);
  const observed = { beadId, status: bead.status, outcome: bead.outcome || null, assignee: bead.assignee || null, at };
  let settled = false;
  if (finish) settled = bead.status === 'closed' && bead.outcome === finish.outcome;
  else if (op.kind === 'claim') settled = typeof op.intent.assignee === 'string' && bead.assignee === op.intent.assignee;
  else if (op.kind === 'release') settled = managedReleaseIntent(op)
    ? !bead.assignee && bead.status === op.intent.status
    : typeof op.intent.holder === 'string' && bead.assignee !== op.intent.holder;
  return { checkable: true, settled, observed };
}

// Checks one operation against the store, under the same per-bead lock as the
// writes, and records an honest receipt when its requested final state is
// there: "applied", settled by Hive's observation, which says nothing about
// which write produced that state.
export async function settleOne(rt, opId) {
  const first = rt.metadata.read().operations[opId];
  if (!needsSettling(first)) return { opId, state: first?.state || 'unknown', settled: false };
  const beadId = checkTarget(first);
  const check = async () => {
    const op = rt.metadata.read().operations[opId];
    if (!needsSettling(op)) return { opId, state: op?.state || 'unknown', settled: false };
    markChecked(opId);
    const seen = await observe(rt, op);
    if (!seen.checkable) return { opId, state: op.state, settled: false, checkable: false };
    if (!seen.settled) return { opId, state: op.state, settled: false, checkable: true, observed: seen.observed };
    rt.metadata.mutate((d) => {
      const rec = d.operations[opId];
      if (rec && needsSettling(rec)) {
        d.operations[opId] = stamp(rec, { state: 'applied', settledBy: 'hive:observed', previousState: rec.state, observed: seen.observed });
        if (deleteIntent(rec)) forgetDeleted(d, rec.cellId, seen.observed.missing, 'hive:observed');
      }
    });
    return { opId, state: 'applied', settled: true, observed: seen.observed };
  };
  const many = deleteIntent(first) || reopenIntent(first);
  if (many) return withLocks(many.map((id) => `bead:${id}`), check);
  return beadId ? withLock(`bead:${beadId}`, check) : check();
}

let settling = null;

// The background pass: a few unsettled finishes, claims and releases per run,
// least recently checked first, each rechecked at most every few minutes.
// Operations the store cannot confirm are left to the queen. Creates keep their own check by
// operation stamp. Never refreshes the snapshot or replays a write; returns
// how many operations it settled.
export function settleOperations(rt) {
  if (settling) return settling;
  settling = (async () => {
    if (rt.metadata.error || rt.beads.status.state !== 'ready') return 0;
    const now = Date.now();
    const due = Object.values(rt.metadata.read().operations)
      .filter((op) => checkTarget(op) && needsSettling(op, now) && now - (lastChecked.get(op.id) || 0) > RECHECK_MS)
      .sort(byLastChecked)
      .slice(0, SETTLE_BATCH);
    let settled = 0;
    for (const op of due) {
      try {
        if ((await settleOne(rt, op.id)).settled) settled += 1;
      } catch (err) {
        rt.log(`hive: settling ${op.id} failed: ${err.message}`);
      }
    }
    const operations = rt.metadata.read().operations;
    for (const id of [...lastChecked.keys()]) {
      const op = operations[id];
      if (!op || !UNSETTLED.has(op.state) || !checkTarget(op)) lastChecked.delete(id);
    }
    return settled;
  })().finally(() => { settling = null; });
  return settling;
}

// A coordinator's check of one operation in its own cell. The store is read
// first; only if that cannot confirm the outcome may the coordinator record
// what it verified, with a reason. Nothing is retried or forced, and setup
// operations stay with the human.
export const VERDICTS = ['applied', 'not-applied', 'superseded'];

export async function reconcileForAgent(rt, actor, { op_id, verdict, note }) {
  requireCompleteHierarchy(rt);
  if (rt.metadata.error) throw new HiveError(rt.metadata.error, 'metadata-unavailable');
  const opId = text(op_id, 'op_id', 80, { required: true });
  const op = rt.metadata.read().operations[opId];
  if (!op || !op.cellId || op.cellId !== actor.cell.id) throw new AccessError(`Operation ${opId} is not one of this cell's operations.`);
  requireCoordinator(actor, 'settle operations');
  if (['cell-create', 'cell-root'].includes(op.kind)) throw new HiveError('Cell setup operations are settled by the human in the Hive view.', 'refused');
  if (!UNSETTLED.has(op.state)) return { op_id: opId, state: op.state, message: `Already ${op.state}; nothing to do.` };
  if (running.has(opId)) throw new HiveError(`Operation ${opId} is still running. Check again once it finishes.`, 'busy');
  if (op.state === 'pending' && !needsSettling(op)) throw new HiveError(`Operation ${opId} started moments ago and may still be running. Check again in a few minutes.`, 'busy');
  let check = { settled: false };
  if (op.kind === 'create-beads' && op.state !== 'partial') {
    ensureWritable(rt);
    const out = await reconcileOperation(rt, { opId });
    rt.changed();
    return { op_id: opId, state: out.state, settled_by: 'hive:observed', ids: out.ids };
  }
  if (['finish', 'claim', 'release', 'delete-beads', 'reopen'].includes(op.kind)) {
    if (rt.beads.status.state !== 'ready') throw new HiveError('The Beads store is not ready, so the outcome cannot be checked now.', 'setup-required');
    check = await settleOne(rt, opId);
    if (check.settled) {
      rt.changed();
      return { op_id: opId, state: 'applied', settled_by: 'hive:observed', observed: check.observed };
    }
  }
  if (verdict === undefined) {
    return {
      op_id: opId,
      state: op.state,
      observed: check.observed,
      message: check.checkable
        ? 'The store does not show the requested final state. Check the bead and talk to whoever holds it; then call again with a verdict and a note saying what you verified. Do not repeat the write blindly.'
        : 'Hive cannot check this kind of operation from the store. Inspect the beads it names, then call again with a verdict and a note saying what you verified.',
    };
  }
  if (!VERDICTS.includes(verdict)) throw new HiveError(`verdict must be one of ${VERDICTS.join(', ')}.`);
  const reason = text(note, 'note', 500, { required: true });
  const by = actorFor(actor.sessionId);
  let recorded = false;
  rt.metadata.mutate((d) => {
    const rec = d.operations[opId];
    if (rec && UNSETTLED.has(rec.state) && !running.has(opId)) {
      d.operations[opId] = stamp(rec, { state: 'resolved', previousState: rec.state, verdict, resolvedBy: by, resolution: reason, ...(check.observed ? { observed: check.observed } : {}) });
      if (deleteIntent(rec) && Array.isArray(check.observed?.missing)) forgetDeleted(d, rec.cellId, check.observed.missing, by);
      recorded = true;
    }
  });
  if (!recorded) return { op_id: opId, state: rt.metadata.read().operations[opId]?.state, message: 'It changed meanwhile; nothing recorded.' };
  rt.changed();
  return { op_id: opId, state: 'resolved', verdict, resolved_by: by };
}

// ---- Agent and human work operations ----

export function evidenceInput(list, by) {
  if (list === undefined) return [];
  if (!Array.isArray(list)) throw new HiveError('evidence must be an array.');
  if (list.length > 20) throw new HiveError('At most 20 evidence entries per call.');
  return list.map((e, i) => {
    if (!e || typeof e !== 'object') throw new HiveError(`evidence[${i}] must be an object.`);
    const label = text(e.label, `evidence[${i}].label`, LIMITS.label, { required: true });
    if (label.startsWith('Review ')) throw new HiveError('Evidence labels beginning with Review are reserved for hive_review_verdict. Use a different label for external review notes.');
    const url = text(e.url, `evidence[${i}].url`, LIMITS.url);
    if (url && !/^https?:\/\//i.test(url)) throw new HiveError(`evidence[${i}].url must be an http(s) URL.`);
    const detail = text(e.detail, `evidence[${i}].detail`, LIMITS.short) || '';
    const kind = text(e.kind, `evidence[${i}].kind`, 40) || 'note';
    return { label, url: url || null, detail, kind, by, at: new Date().toISOString() };
  });
}

function kindArg(value) {
  const kind = text(value, 'kind', 40);
  if (kind !== undefined && !/^[a-z][a-z0-9-]{0,39}$/.test(kind)) throw new HiveError('kind must be a short lowercase word such as work, workstream, goal, investigation, fix, review or decision.');
  return kind;
}

export async function createBeads(rt, actor, { beads = [], links = [] }) {
  ensureWritable(rt);
  if (!Array.isArray(beads) || !beads.length) throw new HiveError('Give at least one bead.');
  if (beads.length > LIMITS.beads) throw new HiveError(`At most ${LIMITS.beads} beads per call.`);
  if (!Array.isArray(links) || links.length > LIMITS.links) throw new HiveError(`At most ${LIMITS.links} links per call.`);
  const cell = actor.cell;
  if (!cell.rootBeadId) throw new HiveError('This cell has no root goal yet; the human must finish creating the cell.');
  const refs = new Map();
  const nodes = beads.map((b, i) => {
    const ref = text(b.ref, `beads[${i}].ref`, 40) || `n${i}`;
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(ref)) throw new HiveError(`beads[${i}].ref must be a short name (letters, digits, - or _).`);
    if (refs.has(ref)) throw new HiveError(`Duplicate ref ${ref}.`);
    refs.set(ref, i);
    const kind = kindArg(b.kind) || 'work';
    if (kind === 'goal') throw new HiveError('A cell has exactly one goal bead, its root. Use kind "workstream" for nested goals.');
    const status = b.status === undefined ? undefined : text(b.status, `beads[${i}].status`, 20);
    if (status !== undefined && !SETTABLE_STATUSES.includes(status)) throw new HiveError(`beads[${i}].status must be one of ${SETTABLE_STATUSES.join(', ')}.`);
    if (status === 'in_progress' && !GROUP_KINDS.has(kind)) throw new HiveError('Create work as open, then claim it with hive_claim_bead before starting it.');
    return {
      key: ref,
      title: text(b.title, `beads[${i}].title`, LIMITS.title, { required: true }),
      kind,
      issueType: issueTypeForKind(kind),
      goal: text(b.goal, `beads[${i}].goal`, LIMITS.long) || '',
      acceptance: text(b.acceptance, `beads[${i}].acceptance`, LIMITS.long) || '',
      summary: text(b.summary, `beads[${i}].summary`, LIMITS.long) || '',
      nextAction: text(b.next_action, `beads[${i}].next_action`, LIMITS.short) || undefined,
      status: status === 'open' ? undefined : status,
      parentRaw: b.parent,
      cellId: cell.id,
    };
  });
  for (const n of nodes) {
    const p = n.parentRaw;
    delete n.parentRaw;
    if (p === undefined || p === null || p === '') {
      n.parentId = cell.rootBeadId;
    } else if (typeof p === 'string' && refs.has(p)) {
      if (p === n.key) throw new HiveError(`${p} cannot be its own parent.`);
      n.parentKey = p;
    } else {
      beadIdArg(p, 'parent');
      const { cell: parentCell } = requireBeadAccess(rt, actor, p);
      if (parentCell.id !== cell.id) throw new HiveError(`Parent ${p} is in another cell; create beads from that cell instead.`);
      n.parentId = p;
    }
  }
  const touchedCells = new Set([cell.id]);
  const edges = links.map((l, i) => {
    const type = l.type === undefined ? 'blocks' : l.type;
    if (!LINK_TYPES.includes(type)) throw new HiveError(`links[${i}].type must be one of ${LINK_TYPES.join(', ')}.`);
    const end = (v, field) => {
      if (typeof v === 'string' && refs.has(v)) return { key: v };
      beadIdArg(v, field);
      const { cell: c } = requireBeadAccess(rt, actor, v);
      touchedCells.add(c.id);
      return { id: v };
    };
    const dep = end(l.dependent, `links[${i}].dependent`);
    const pre = end(l.prerequisite, `links[${i}].prerequisite`);
    if (dep.key && pre.key && dep.key === pre.key) throw new HiveError(`links[${i}] links a bead to itself.`);
    return { fromKey: dep.key, fromId: dep.id, toKey: pre.key, toId: pre.id, type };
  });
  const affected = [...new Set([...nodes.map((n) => n.parentId), ...edges.flatMap((e) => [e.fromId, e.toId])].filter(Boolean))];
  const out = await journaled(rt, { kind: 'create-beads', cellId: cell.id, actor: actorFor(actor.sessionId), summary: `Create ${nodes.length} bead(s)`, beadIds: affected }, async (opId, phase) => {
    const { ids } = await rt.beads.createMany({ nodes, edges }, actorFor(actor.sessionId), opId);
    phase.applied = true;
    await rt.snapshots.refresh();
    return { ids, journal: { ids } };
  });
  return { op_id: out.opId, ids: out.ids, cross_cell: touchedCells.size > 1 };
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

export async function updateBead(rt, actor, input) {
  ensureWritable(rt);
  const id = beadIdArg(input.bead_id, 'bead_id');
  const { bead, cell } = requireBeadAccess(rt, actor, id);
  const isRoot = cell.rootBeadId === id;
  const patch = {
    title: text(input.title, 'title', LIMITS.title, { allowEmpty: false }),
    goal: text(input.goal, 'goal', LIMITS.long),
    acceptance: text(input.acceptance, 'acceptance', LIMITS.long),
    summary: text(input.summary, 'summary', LIMITS.long),
    nextAction: text(input.next_action, 'next_action', LIMITS.short),
    waitingFor: text(input.waiting_for, 'waiting_for', LIMITS.short),
  };
  const kind = kindArg(input.kind);
  if (kind !== undefined) {
    if (isRoot) throw new HiveError('The cell root is always the goal bead.');
    if (kind === 'goal') throw new HiveError('Use kind "workstream" for nested goals.');
    patch.kind = kind;
  }
  if (input.status !== undefined) {
    if (!SETTABLE_STATUSES.includes(input.status)) throw new HiveError(`status must be one of ${SETTABLE_STATUSES.join(', ')}. Use hive_finish_bead to close work.`);
    if (bead.status === 'closed') throw new HiveError(`Bead ${id} is closed. Reopening is a human or queen decision; publish the reason if it should reopen.`);
    patch.status = input.status;
  }
  if (input.parent_id !== undefined) {
    if (isRoot) throw new HiveError('The cell root cannot be moved.');
    const parentId = input.parent_id || cell.rootBeadId;
    beadIdArg(parentId, 'parent_id');
    const { cell: target } = requireBeadAccess(rt, actor, parentId);
    if (descendantIds(rt.snapshots.graph.beads, id).has(parentId)) throw new HiveError('That would make the bead its own ancestor.');
    if (target.id !== cell.id) requireCoordinator(actor.cells.find((p) => p.cell.id === target.id) || { role: null }, 'move work into another cell');
    patch.parentId = parentId;
  }
  const resumeAt = input.resume_review_at, resumeAfter = input.resume_after_bead;
  if (resumeAt !== undefined || resumeAfter !== undefined) {
    const finalStatus = patch.status ?? bead.status;
    const resume = { ...(bead.resume || {}) };
    if (resumeAt !== undefined) {
      const clean = text(resumeAt, 'resume_review_at', 40);
      if (clean && !(ISO_DATE.test(clean) && Number.isFinite(Date.parse(clean)))) throw new HiveError('resume_review_at must be a date such as 2026-12-01 or 2026-12-01T09:00:00Z.');
      if (clean) resume.reviewAt = new Date(clean).toISOString(); else delete resume.reviewAt;
    }
    if (resumeAfter !== undefined) {
      const clean = text(resumeAfter, 'resume_after_bead', 80);
      if (clean) {
        beadIdArg(clean, 'resume_after_bead');
        if (clean === id) throw new HiveError('A bead cannot wait for itself.');
        if (!rt.snapshots.graph.beads[clean]) throw new HiveError(`resume_after_bead ${clean} does not exist.`);
        resume.afterBead = clean;
      } else delete resume.afterBead;
    }
    const cleared = !resume.reviewAt && !resume.afterBead;
    if (!cleared && finalStatus !== 'deferred') throw new HiveError('A resume condition only applies to a deferred bead; set status "deferred" too.');
    patch.resume = cleared ? '' : resume;
  } else if (patch.status !== undefined && bead.resume && (patch.status !== 'deferred' || bead.status !== 'deferred')) {
    patch.resume = '';
  }
  const add = evidenceInput(input.add_evidence, actor.sessionId ? actorFor(actor.sessionId) : 'aw:human');
  const removeLabels = Array.isArray(input.remove_evidence_labels) ? input.remove_evidence_labels.slice(0, 50).map(String) : [];
  for (const k of Object.keys(patch)) if (patch[k] === undefined) delete patch[k];
  if (!Object.keys(patch).length && !add.length && !removeLabels.length) throw new HiveError('Nothing to update.');
  const expectedUpdatedAt = input.expected_updated_at;
  if (expectedUpdatedAt !== undefined && (typeof expectedUpdatedAt !== 'string' || !expectedUpdatedAt)) throw new HiveError('expected_updated_at must be the updated_at that hive_context showed for this bead.');
  const affectsCapacity = patch.status !== undefined || patch.kind !== undefined || patch.parentId !== undefined;
  let applied = null;
  return withLocks([`bead:${id}`, ...(affectsCapacity ? [ADMISSION_LOCK] : [])], async () => {
    let parentId = bead.parentId;
    if (patch.parentId !== undefined) {
      const fresh = await rt.beads.show(id);
      if (!fresh) throw new HiveError(`Bead ${id} no longer exists.`);
      parentId = fresh.parent || normalizeIssue(fresh).parentId;
    }
    const affected = [...new Set([id, ...(patch.parentId !== undefined ? [parentId, patch.parentId] : [])].filter(Boolean))];
    return journaled(rt, { kind: 'update-bead', cellId: cell.id, actor: actorFor(actor.sessionId), summary: `Update ${id}`, beadIds: affected, intent: { beadId: id, fields: Object.keys(patch) } }, async (opId, phase) => {
      if (add.length || removeLabels.length) {
        const fresh = await rt.beads.show(id);
        if (!fresh) throw new HiveError(`Bead ${id} no longer exists.`);
        const { evidence } = normalizeIssue(fresh);
        const kept = evidence.filter((e) => !removeLabels.includes(e.label));
        const next = [...kept, ...add];
        if (next.length > LIMITS.evidence) throw new HiveError(`A bead holds at most ${LIMITS.evidence} evidence entries; remove some first.`);
        patch.evidence = next;
      }
      let pickupBefore = null;
      const written = await rt.beads.update(id, patch, actorFor(actor.sessionId), affectsCapacity || expectedUpdatedAt || bead.pickup?.armed ? (context) => {
        const graph = exportedGraph(context);
        const current = graph.beads[id];
        if (!current) throw new HiveError(`Bead ${id} no longer exists.`, 'conflict');
        pickupBefore = current;
        if (expectedUpdatedAt && current.updatedAt !== expectedUpdatedAt) throw new HiveError(`Bead ${id} changed since ${expectedUpdatedAt} (now ${current.updatedAt}); nothing was applied. Re-read it with hive_context and resend against the current version.`, 'conflict');
        if (!affectsCapacity) return;
        const nextBead = { ...current, ...patch };
        if (patch.kind === 'external') {
          const doc = rt.metadata.read();
          const unsettledClaim = Object.values(doc.operations).some(op => op.kind === 'claim' && op.intent?.beadId === id && UNSETTLED.has(op.state));
          const reservedWorker = Object.values(doc.workerLaunches || {}).some(l => l.beadId === id && RESERVED_LAUNCH_STATES.has(l.state));
          if (current.assignee || unsettledClaim || openReview(rt, id) || reservedWorker) {
            throw new HiveError(`Release the claim and reconcile any unsettled claim, reserved worker or review before converting ${id} to an external prerequisite.`, 'refused');
          }
        }
        const startsWork = nextBead.status === 'in_progress' && !GROUP_KINDS.has(nextBead.kind) && (current.status !== 'in_progress' || GROUP_KINDS.has(current.kind));
        if (startsWork && !current.assignee) throw new HiveError(`Claim ${id} with hive_claim_bead before starting work: status in_progress needs a claim and nobody holds it. Nothing in this update was applied; title, summary, next_action, waiting_for and evidence need no claim, so resend without status, or claim it first.`, 'refused');
        const before = capacity(rt, graph);
        const next = { ...graph, beads: { ...graph.beads, [id]: { ...graph.beads[id], ...patch } } };
        const after = capacity(rt, next);
        if (after.limit && after.used > after.limit && after.used > before.used) throw new HiveError(`Hive's global work limit is ${after.limit}; this update would use ${after.used} slots. Raise it to the queen with hive_request_input instead of recording it in the bead summary.`, 'busy');
        if (startsWork) return { assignee: current.assignee, status: current.status };
      } : undefined);
      phase.applied = true;
      if (written) managedPickupReceipt(rt, pickupBefore, normalizeIssue(written));
      try {
        const current = await rt.beads.show(id);
        if (current) applied = normalizeIssue(current);
      } catch { applied = null; }
      return { journal: { fields: Object.keys(patch) } };
    });
  }).then((out) => {
    const result = { op_id: out.opId, bead_id: id, updated: Object.keys(patch) };
    if (patch.waitingFor !== undefined || patch.status === 'blocked') {
      const doc = rt.metadata.read();
      const merged = applied || { ...bead, ...patch };
      const waits = humanWaitText(merged, { blocked: hasBlockingPrerequisite(rt.snapshots.graph, id), reviewOpen: hasOpenReview(doc, cell.id, id) });
      if (waits && !hasOpenRequest(doc, cell.id, id)) result.warning = HUMAN_WAIT_WARNING;
    }
    return result;
  });
}

export async function linkBeads(rt, actor, { links }) {
  ensureWritable(rt);
  if (!Array.isArray(links) || !links.length) throw new HiveError('Give at least one link.');
  if (links.length > LIMITS.links) throw new HiveError(`At most ${LIMITS.links} links per call.`);
  const existing = rt.snapshots.graph.edges;
  const touched = new Set();
  const clean = [];
  for (const [i, l] of links.entries()) {
    const dependent = beadIdArg(l.dependent, `links[${i}].dependent`);
    const prerequisite = beadIdArg(l.prerequisite, `links[${i}].prerequisite`);
    if (dependent === prerequisite) throw new HiveError(`links[${i}] links a bead to itself.`);
    const a = requireBeadAccess(rt, actor, dependent);
    const b = requireBeadAccess(rt, actor, prerequisite);
    touched.add(a.cell.id);
    touched.add(b.cell.id);
    const type = l.type === undefined ? 'blocks' : l.type;
    if (!l.remove && !LINK_TYPES.includes(type)) throw new HiveError(`links[${i}].type must be one of ${LINK_TYPES.join(', ')}.`);
    const present = existing.some((e) => e.dependent === dependent && e.prerequisite === prerequisite);
    if (l.remove && !present) continue;
    if (!l.remove && existing.some((e) => e.dependent === dependent && e.prerequisite === prerequisite && e.type === type)) continue;
    clean.push({ dependent, prerequisite, type, remove: Boolean(l.remove) });
  }
  if (!clean.length) return { changed: 0, message: 'Every requested link was already in that state.' };
  const out = await journaled(rt, { kind: 'link-beads', cellId: actor.cell.id, actor: actorFor(actor.sessionId), summary: `${clean.length} link change(s)`, beadIds: clean.flatMap((l) => [l.dependent, l.prerequisite]), intent: { links: clean } }, async (opId, phase) => {
    await rt.beads.linkMany(clean, actorFor(actor.sessionId), opId);
    phase.applied = true;
    const snapshot = await rt.snapshots.refresh();
    if (snapshot.error || rt.beads.status.state !== 'ready') {
      throw new BeadsError('uncertain', `Links were changed in Beads, but refreshing their snapshot failed: ${snapshot.error || rt.beads.status.detail || rt.beads.status.state}`);
    }
    return { journal: { links: clean } };
  });
  return { op_id: out.opId, changed: clean.length, cross_cell: touched.size > 1 };
}

export async function claimBead(rt, actor, { bead_id }, { launchId = null, validate = () => {} } = {}) {
  ensureWritable(rt);
  const id = beadIdArg(bead_id, 'bead_id');
  const { cell, bead } = requireBeadAccess(rt, actor, id);
  if (cell.rootBeadId === id) throw new HiveError('The cell goal is not claimed; claim a piece of work under it.');
  if (bead.status === 'closed') throw new HiveError(`Bead ${id} is closed.`);
  const who = actorFor(actor.sessionId);
  const out = await withLocks([ADMISSION_LOCK, `bead:${id}`], () => journaled(rt, { kind: 'claim', cellId: cell.id, actor: who, summary: `Claim ${id}`, beadIds: [id], intent: { beadId: id, assignee: who } }, async (opId, phase) => {
    const res = await rt.beads.claim(id, who, (context) => {
      context.pickupOperationId = opId;
      validate(context);
      if (launchId) {
        const launch = rt.metadata.read().workerLaunches[launchId];
        if (!launch || launch.state !== 'binding' || launch.sessionId !== actor.sessionId || launch.beadId !== id) throw new HiveError('Worker launch changed before claiming.', 'conflict');
      }
      const graph = exportedGraph(context);
      if (!descendantIds(graph.beads, cell.rootBeadId).has(id)) throw new HiveError(`Bead ${id} moved outside this cell.`, 'conflict');
      checkAdmission(rt, graph, id, { sessionId: actor.sessionId, launchId, ownOperationId: opId });
      if (graph.beads[id]?.pickup?.armToken) rt.metadata.mutate(d => consumePickup(d, graph.beads[id], { source: 'claim', operationId: opId }));
    });
    phase.applied = true;
    return { already: res.already, journal: { already: res.already } };
  }));
  bindIfMissing(rt, cell.id, actor.sessionId, id, 'worker', who);
  return { op_id: out.opId, bead_id: id, claimed_by: actor.sessionId, already_yours: out.already };
}

export async function releaseBead(rt, actor, { bead_id, reason, force, status }) {
  ensureWritable(rt);
  const id = beadIdArg(bead_id, 'bead_id');
  const { cell, role } = requireBeadAccess(rt, actor, id);
  const who = actorFor(actor.sessionId);
  const cleanReason = text(reason, 'reason', LIMITS.short) || '';
  if (status !== undefined && !SETTABLE_STATUSES.includes(status)) throw new HiveError(`status must be one of ${SETTABLE_STATUSES.join(', ')}.`);
  return withLock(`bead:${id}`, async () => {
    const fresh = await rt.beads.show(id);
    if (!fresh) throw new HiveError(`Bead ${id} no longer exists.`);
    const holder = fresh.assignee || null;
    if (!holder) return { bead_id: id, released: false, message: 'It was not claimed.' };
    const mine = holder === who;
    if (!mine) {
      if (!force) throw new HiveError(`Bead ${id} is claimed by ${holder}, not you. A queen or coordinator can release it with force: true and a reason, after checking with the holder.`, 'conflict');
      requireCoordinator({ role }, `release another session's claim in cell ${cell.id}`);
      if (!cleanReason) throw new HiveError('Releasing another session\'s claim needs a reason.');
    }
    const out = await releaseWithStatus(rt, { cellId: cell.id, actor: who, id, fresh, reason: cleanReason, status,
      summary: `Release ${id}${mine ? '' : ` held by ${holder}`}` });
    return { op_id: out.opId, bead_id: id, released: true, previous_holder: holder, status: out.status };
  });
}

async function releaseWithStatus(rt, { cellId, actor, id, fresh, reason, status = fresh.status, summary, check }) {
  if (!SETTABLE_STATUSES.includes(fresh.status)) throw new HiveError(`Cannot release ${id} in status ${fresh.status}.`, 'refused');
  const holder = fresh.assignee;
  return journaled(rt, { kind: 'release', cellId, actor, summary, beadIds: [id],
    intent: { beadId: id, holder, priorStatus: fresh.status, status } }, async (opId, phase) => {
    await rt.beads.release(id, actor, { reason, holder, priorStatus: fresh.status, status, check,
      onStep(progress) {
        if (progress.state === 'done') phase.applied = true;
        rt.metadata.mutate((d) => {
          d.operations[opId] = stamp(d.operations[opId], { releaseStep: progress });
        });
        phase.attempted = true;
      },
    });
    phase.applied = true;
    const snapshot = await rt.snapshots.refresh();
    if (snapshot.error || rt.beads.status.state !== 'ready') throw new BeadsError('uncertain', `Released ${id}, but its snapshot could not be refreshed.`);
    return { status, journal: { holder, reason, status } };
  });
}

export async function releaseArchivedBead(rt, host, { beadId, sessionId, cellId }) {
  return withLock(`bead:${beadId}`, async () => {
    ensureWritable(rt);
    if (rt.host !== host || !host.sessions.get(sessionId)?.archived) return { released: false };
    const fresh = await rt.beads.show(beadId);
    if (!fresh || fresh.assignee !== actorFor(sessionId) || !SETTABLE_STATUSES.includes(fresh.status)) return { released: false };
    if (rt.host !== host || !host.sessions.get(sessionId)?.archived) return { released: false };
    const out = await releaseWithStatus(rt, { cellId, actor: 'hive', id: beadId, fresh,
      reason: `Session ${sessionId} was archived.`, summary: `Release archived session ${sessionId}'s claim on ${beadId}`,
      check() {
        if (rt.host !== host || !host.sessions.get(sessionId)?.archived) throw new HiveError('The session is no longer archived or Hive detached; its claim was kept.', 'conflict');
      },
    });
    return { released: true, op_id: out.opId };
  });
}

export function bindIfMissing(rt, cellId, sessionId, beadId, role, by) {
  if (!sessionId) return;
  const list = rt.metadata.read().bindings[cellId] || [];
  if (list.some((b) => b.active && b.sessionId === sessionId && b.beadId === beadId)) return;
  try {
    rt.metadata.mutate((d) => {
      const l = d.bindings[cellId] || (d.bindings[cellId] = []);
      l.push({ id: newId('bind'), sessionId, beadId, role, boundBy: by, at: Date.now(), active: true });
    });
  } catch (err) {
    rt.log(`hive: could not record binding: ${err.message}`);
  }
}

export async function bindSession(rt, host, actor, input) {
  const beadId = typeof input.bead_id === 'string' ? input.bead_id.trim() : null;
  const stored = storedRole((typeof input.role === 'string' ? input.role.trim() : '') || 'worker');
  if (beadId && ['reviewer', 'investigator'].includes(stored) && !input.unbind) {
    return withLock(`review:${beadId}`, () => withLocks([ADMISSION_LOCK, `bead:${beadId}`], async () => {
      await rt.snapshots.refresh();
      return bindSessionNow(rt, host, actor, input);
    }));
  }
  return bindSessionNow(rt, host, actor, input);
}

async function bindSessionNow(rt, host, actor, { bead_id, session_id, role, unbind, note }) {
  requireCompleteHierarchy(rt);
  if (rt.metadata.error) throw new HiveError(rt.metadata.error, 'metadata-unavailable');
  const cell = actor.cell;
  const target = session_id === undefined || session_id === null || session_id === '' ? actor.sessionId : session_id;
  if (!isSessionId(target)) throw new HiveError('session_id must be a session id.');
  let beadId = null;
  if (bead_id !== undefined && bead_id !== null && bead_id !== '') {
    beadId = beadIdArg(bead_id, 'bead_id');
    const { cell: c } = requireBeadAccess(rt, actor, beadId);
    if (c.id !== cell.id) throw new HiveError(`Bead ${beadId} is in cell ${c.id}; bind from that cell.`);
  }
  const cleanRole = storedRole(text(role, 'role', 40) || 'worker');
  if (!/^[a-z][a-z-]{0,39}$/.test(cleanRole)) throw new HiveError('role must be work, review, helper, or a short lowercase word such as coordinator.');
  const attachRole = ['reviewer', 'investigator'].includes(cleanRole);
  const holds = Boolean(beadId) && holdsBead(rt, host, actor.sessionId, beadId);
  if (cleanRole === 'reviewer' && !unbind && !beadId) throw new HiveError('A review session must be joined to a bead (bead_id).');
  if (target !== actor.sessionId) {
    if (!(attachRole && holds && !unbind)) requireCoordinator(actor, 'bind another session');
    const session = host.sessions.get(target);
    if (!session || session.archived) throw new HiveError(`Unknown or archived session ${target}.`);
    const inTask = session.taskId === cell.taskId;
    if (!inTask && session.spawnedBy !== actor.sessionId) throw new AccessError('You can bind another session only if it is in this cell\'s task or you launched it.');
    if (cleanRole === 'coordinator') requireQueen(actor, 'make another session a coordinator');
  } else if (cleanRole === 'coordinator' && actor.role !== 'coordinator' && actor.role !== 'queen') {
    throw new AccessError('Only the queen can grant the coordinator role.');
  }
  if (cleanRole === 'reviewer' && !unbind) {
    const targetSession = host.sessions.get(target);
    assertAllowedReviewer({ agent: targetSession?.agent, model: targetSession?.model });
    if (target === actor.sessionId) throw new AccessError('A session cannot nominate itself as a reviewer. The bead\'s holder or the queen joins it with hive_bind_session(session_id).');
    if (!COORDINATING_ROLES.has(actor.role) && !holds) throw new AccessError('Only the queen, a coordinator or the bead\'s live holder can nominate a review session.');
    const doc = rt.metadata.read();
    const worked = (doc.bindings[cell.id] || []).some((b) => b.sessionId === target && b.beadId === beadId && ['worker', 'investigator'].includes(b.role))
      || Object.values(doc.workerLaunches || {}).some((l) => l.sessionId === target && l.beadId === beadId && !l.reviewId)
      || rt.snapshots.graph.beads[beadId]?.assignee === actorFor(target);
    if (worked) throw new AccessError('A session that has worked on this bead cannot review it.');
  }
  if (attachRole && beadId && !unbind) checkAdmission(rt, await rt.beads.loadSnapshot({ all: true }), beadId, { sessionId: null, review: true });
  const by = actorFor(actor.sessionId);
  const at = Date.now();
  const noteText = text(note, 'note', LIMITS.short) || '';
  if (unbind) {
    if (target !== actor.sessionId) requireCoordinator(actor, 'unbind another session');
    let count = 0;
    rt.metadata.mutate((d) => {
      for (const b of d.bindings[cell.id] || []) {
        if (b.active && b.sessionId === target && (beadId === null || b.beadId === beadId)) {
          b.active = false;
          b.unboundAt = at;
          b.unboundBy = by;
          count += 1;
        }
      }
    });
    rt.changed();
    return { cell_id: cell.id, session_id: target, unbound: count };
  }
  let reviewId = null;
  if (cleanRole === 'reviewer') {
    if (Object.values(rt.metadata.read().reviews || {}).some((r) => r.workBeadId === beadId && ['requested', 'in_review'].includes(r.state))) throw new HiveError('This bead already has an open review; wait for its verdict or cancel it.', 'conflict');
    const bead = rt.snapshots.graph.beads[beadId];
    if (!bead || bead.status === 'closed' || bead.id === cell.rootBeadId) throw new HiveError('Join a review session to open work in this cell.');
    reviewId = newId('review');
  }
  rt.metadata.mutate((d) => {
    const list = d.bindings[cell.id] || (d.bindings[cell.id] = []);
    const existing = list.find((b) => b.active && b.sessionId === target && b.beadId === beadId);
    if (existing && !reviewId) {
      existing.role = cleanRole;
      existing.note = noteText;
    } else {
      if (existing) existing.active = false;
      list.push({ id: newId('bind'), sessionId: target, beadId, role: cleanRole, note: noteText, boundBy: by, at, active: true, ...(reviewId ? { reviewId } : {}) });
    }
    if (reviewId) {
      const builderSid = rt.snapshots.graph.beads[beadId].assignee?.startsWith('aw:') ? rt.snapshots.graph.beads[beadId].assignee.slice(3) : null;
      const builderAgent = (builderSid && host.sessions.get(builderSid)?.agent) || null;
      const agent = host.sessions.get(target)?.agent || null;
      d.reviews[reviewId] = { id: reviewId, cellId: cell.id, workBeadId: beadId, requestedBy: actor.sessionId, state: 'in_review', reviewerSessionId: target, summary: noteText || 'Review session joined.', createdAt: at, startedAt: at, updatedAt: at, policy: { agent, model: host.sessions.get(target)?.model || null, effort: host.sessions.get(target)?.effort || null, builderAgent, sameProvider: builderAgent ? agent === builderAgent : null, ...(builderAgent ? {} : { unknownBuilder: true }), joined: true } };
    }
  });
  rt.changed();
  if (reviewId && cell.queenSessionId && cell.queenSessionId !== actor.sessionId) {
    Promise.resolve().then(() => host.deliver?.(cell.queenSessionId, `[Hive] Review session ${target} joined ${beadId}, added by ${actor.sessionId}. No action needed.`)).catch(() => {});
  }
  return { cell_id: cell.id, session_id: target, bead_id: beadId, role: apiRole(cleanRole), ...(reviewId ? { review_id: reviewId } : {}) };
}

export async function finishBead(rt, actor, input) {
  ensureWritable(rt);
  const id = beadIdArg(input.bead_id, 'bead_id');
  if (openReview(rt, id)) throw new HiveError('An open review must end with hive_review_verdict or a coordinator using hive_cancel_review before this work can finish.');
  const { cell, bead, role } = requireBeadAccess(rt, actor, id);
  if (bead.status === 'closed') throw new HiveError(`Bead ${id} is already closed.`);
  if (cell.rootBeadId === id) requireQueen({ role }, `close the goal of cell ${cell.id}`);
  const outcome = input.outcome;
  if (!OUTCOMES.includes(outcome)) throw new HiveError(`outcome must be one of ${OUTCOMES.join(', ')}.`);
  const summary = text(input.summary, 'summary', LIMITS.long, { required: true });
  const add = evidenceInput(input.evidence, actorFor(actor.sessionId));
  const who = actorFor(actor.sessionId);
  if (id !== cell.rootBeadId && Object.values(rt.snapshots.graph.beads).some((b) => b.parentId === id)) {
    const out = await finishGroup(rt, { cell, id, outcome, summary, add, who });
    return { op_id: out.opId, bead_id: id, outcome, closed: true };
  }
  const openChildren = Object.values(rt.snapshots.graph.beads).filter((b) => b.parentId === id && OPEN_STATUSES.includes(b.status));
  if (openChildren.length) {
    throw new HiveError(`Bead ${id} still has ${openChildren.length} open child bead(s) (${openChildren.slice(0, 5).map((b) => b.id).join(', ')}). Finish or re-parent them first.`);
  }
  const blockers = waitingOn(rt, id);
  if (blockers.length) {
    throw new HiveError(`Bead ${id} is still waiting on ${blockers.join(', ')}. Beads will not close it while a blocking prerequisite is open: finish the prerequisite, or remove the link with hive_link_beads if it no longer applies.`);
  }
  const out = await withLock(`bead:${id}`, () => journaled(rt, { kind: 'finish', cellId: cell.id, actor: who, summary: `Finish ${id} as ${outcome}`, beadIds: [id], intent: { beadId: id, outcome } }, async (opId, phase) => {
    if (openReview(rt, id)) throw new HiveError('This work still has an open review.');
    const fresh = await rt.beads.show(id);
    if (!fresh) throw new HiveError(`Bead ${id} no longer exists.`);
    if (fresh.status === 'closed') throw new HiveError(`Bead ${id} was closed meanwhile.`);
    // Beads refuses to close an item another actor holds. Checking before any
    // write means that predictable refusal changes nothing, instead of saving
    // the summary and evidence and then failing to close.
    if (fresh.assignee && fresh.assignee !== who) {
      throw new HiveError(`Bead ${id} is claimed by ${fresh.assignee}, so only that session can finish it. Nothing was changed. Ask the holder to finish it with hive_finish_bead; if it cannot, a queen or coordinator can check with it and then release the claim with hive_release_bead (force: true and a reason) before finishing.`, 'conflict');
    }
    const normalized = normalizeIssue(fresh);
    if (normalized.pickup?.armToken) rt.metadata.mutate(d => consumePickup(d, normalized, { source: 'finish', operationId: opId }));
    const { evidence } = normalized;
    const next = [...evidence, ...add].slice(-LIMITS.evidence);
    await rt.beads.update(id, { summary, evidence: next }, who);
    phase.applied = true;
    try {
      await rt.beads.close(id, `${outcome}: ${summary.split('\n')[0].slice(0, 300)}`, who);
    } catch (err) {
      throw new BeadsError(err.code === 'uncertain' ? 'uncertain' : 'partial',
        `The summary and evidence were recorded, but closing ${id} ${err.code === 'uncertain' ? 'has an unknown outcome' : 'was refused'}: ${err.message}`);
    }
    try {
      await rt.beads.update(id, { outcome, waitingFor: '', nextAction: '' }, who);
    } catch (err) {
      throw new BeadsError(err.code === 'uncertain' ? 'uncertain' : 'partial',
        `${id} is closed (reason "${outcome}: ..."), but recording its outcome field ${err.code === 'uncertain' ? 'has an unknown outcome' : 'failed'}: ${err.message}`);
    }
    return { journal: { outcome } };
  }));
  return { op_id: out.opId, bead_id: id, outcome, closed: true };
}

export function readyBeads(rt, actor, { under_bead_id, limit }) {
  requireCompleteHierarchy(rt);
  const beads = rt.snapshots.graph.beads;
  const edges = rt.snapshots.graph.edges;
  const cell = actor.cell;
  if (!cell.rootBeadId) return { ready: [], note: 'This cell has no root goal yet.' };
  let scope = descendantIds(beads, cell.rootBeadId);
  if (under_bead_id) {
    beadIdArg(under_bead_id, 'under_bead_id');
    const { cell: c } = requireBeadAccess(rt, actor, under_bead_id);
    if (c.id !== cell.id) throw new HiveError(`Bead ${under_bead_id} is in another cell.`);
    scope = descendantIds(beads, under_bead_id);
  }
  const ready = [...scope]
    .map((id) => beads[id])
    .filter((b) => b && b.id !== cell.rootBeadId && structuralPickupReasons(rt, { beads, edges }, b, { requireBrief: false }).length === 0)
    .sort((a, b) => (a.priority ?? 9) - (b.priority ?? 9) || String(a.createdAt).localeCompare(String(b.createdAt)))
    .slice(0, Math.min(Math.max(Number(limit) || 20, 1), 100))
    .map((b) => ({ bead_id: b.id, title: b.title, kind: b.kind, parent_id: b.parentId, next_action: b.nextAction, acceptance: b.acceptance, pickup: pickupState(rt, rt.host, cell, b) }));
  const pickup = [...scope].map(id => beads[id]).filter(b => b?.pickup?.armed).map(b => ({ bead_id: b.id, ...pickupState(rt, rt.host, cell, b) }));
  return { cell_id: cell.id, ready, pickup, refreshed_at: rt.snapshots.current.loadedAt };
}

// A workstream heading closes only if, in the store as read at the moment of
// writing, nothing anywhere under it is open, it waits on no open
// prerequisite, nobody else holds it, and no Hive write about any of it (or
// any create in the hive) is still unsettled.
export function assessCompletion(rt, cell, id, { beads, edges, errors = [] }, who, ownOpId = null) {
  const problems = [];
  if (errors.length) problems.push(`Hive could not read ${errors.length} record(s) from the store, so it cannot be sure everything under it is finished.`);
  const head = beads[id];
  if (!head) return { problems: [...problems, `${id} is not in the store.`], ids: [] };
  if (head.status === 'closed') problems.push(`${id} is already closed.`);
  if (!cell.rootBeadId || !descendantIds(beads, cell.rootBeadId).has(id) || id === cell.rootBeadId) problems.push(`${id} is not a workstream in this hive.`);
  const ids = [...descendantIds(beads, id)];
  const reviews = ids.filter((d) => openReview(rt, d));
  if (reviews.length) problems.push(`Open reviews still wait on ${reviews.join(', ')}; record their verdicts or explicitly cancel them first.`);
  const open = ids.filter((d) => d !== id && beads[d].status !== 'closed');
  if (open.length) problems.push(`${open.length} item(s) under it are not finished yet (${open.slice(0, 5).join(', ')}${open.length > 5 ? ', …' : ''}). Finish or move them first.`);
  if (head.assignee && head.assignee !== who) problems.push(`It is claimed by ${head.assignee}; that session finishes it, or the claim is released first.`);
  const waits = edges.filter((e) => e.dependent === id && e.blocking && beads[e.prerequisite] && beads[e.prerequisite].status !== 'closed').map((e) => e.prerequisite);
  if (waits.length) problems.push(`It is still waiting on ${waits.join(', ')}.`);
  const inSet = new Set(ids);
  const busy = Object.values(rt.metadata.read().operations).filter((op) => op.id !== ownOpId && (UNSETTLED.has(op.state) || running.has(op.id))
    && (op.cellId === cell.id && op.kind === 'create-beads' || (op.beadIds || []).some((b) => inSet.has(b))));
  for (const op of busy.slice(0, 5)) problems.push(`Operation ${op.id} (${op.kind}) in this hive is not settled yet.`);
  return { problems, ids, beads };
}

// Finishes a workstream heading under the fence: the checks above are made
// against a fresh read in the same Beads job as the writes.
export function finishGroup(rt, { cell, id, outcome, summary, add = [], who }) {
  return withLock(`bead:${id}`, () => journaled(rt, { kind: 'finish', cellId: cell.id, actor: who, summary: `Finish ${id} as ${outcome}`, beadIds: [id], intent: { beadId: id, outcome } }, async (opId, phase) => {
    const fresh = await rt.beads.show(id);
    if (!fresh) throw new HiveError(`Bead ${id} no longer exists.`);
    const evidence = [...normalizeIssue(fresh).evidence, ...add].slice(-LIMITS.evidence);
    try {
      await rt.beads.finishFenced(id, { summary, evidence: add.length ? evidence : null, outcome, reason: `${outcome}: ${summary.split('\n')[0].slice(0, 300)}` }, who, (read) => {
        const { problems } = assessCompletion(rt, cell, id, { ...buildGraph(read.issues), errors: read.errors }, who, opId);
        if (problems.length) throw new HiveError(`${id} was not finished. ${problems.join(' ')}`, 'refused');
      }, () => { phase.applied = true; });
    } catch (err) {
      if (err instanceof HiveError || !phase.applied) throw err;
      throw new BeadsError(err.code === 'uncertain' ? 'uncertain' : 'partial', err.step === 1
        ? `The summary was recorded, but closing ${id} ${err.code === 'uncertain' ? 'has an unknown outcome' : 'was refused'}: ${err.message}`
        : `${id} is closed, but recording its outcome ${err.code === 'uncertain' ? 'has an unknown outcome' : 'failed'}: ${err.message}`);
    }
    return { journal: { outcome } };
  }));
}

export function waitingOn(rt, beadId) {
  const { beads, edges } = rt.snapshots.graph;
  return edges.filter((e) => e.dependent === beadId && e.blocking && beads[e.prerequisite] && beads[e.prerequisite].status !== 'closed').map((e) => e.prerequisite);
}

export async function humanRelease(rt, { beadId, reason }) {
  ensureWritable(rt);
  const id = beadIdArg(beadId, 'bead');
  const cleanReason = text(reason, 'reason', LIMITS.short, { required: true });
  const cell = cellOfBead(rt, id);
  if (cell?.retired) throw new HiveError('This hive is retired. Reopen it to release claims.', 'refused');
  return withLock(`bead:${id}`, async () => {
    const fresh = await rt.beads.show(id);
    if (!fresh) throw new HiveError(`Unknown bead ${id}.`);
    if (!fresh.assignee) throw new HiveError('It is not claimed.');
    return releaseWithStatus(rt, { cellId: cell?.id || null, actor: actorFor(null), id, fresh, reason: cleanReason,
      summary: `Human released ${id} held by ${fresh.assignee}` });
  });
}


// ---- Deleting work items ----

const DELETE_LIMIT = 20;
const DELETE_TEXT_FIELDS = ['description', 'notes', 'design', 'acceptance_criteria'];

// Removes what Hive itself kept about beads that are confirmed gone: their
// map positions and the session bindings to them. Conversations keep their
// messages as they were.
export function forgetDeleted(d, cellId, ids, by) {
  if (!cellId || !ids?.length) return;
  const gone = new Set(ids);
  const at = Date.now();
  for (const b of d.bindings[cellId] || []) {
    if (b.active && gone.has(b.beadId)) Object.assign(b, { active: false, unboundAt: at, unboundBy: by, unboundBecause: 'bead deleted' });
  }
  const layout = d.beadLayout[cellId];
  if (layout) for (const id of gone) delete layout[id];
  for (const id of gone) delete d.archived[id];
  for (const [k, it] of Object.entries(d.restoring)) {
    if (it?.cellId === cellId && (it.ids || []).some((b) => gone.has(b))) delete d.restoring[k];
  }
  for (const rec of Object.values(d.archived)) {
    if (rec?.positions) for (const id of gone) delete rec.positions[id];
  }
}

function nearestCellRoot(beads, id, roots) {
  const seen = new Set();
  let cursor = beads[id];
  while (cursor && !seen.has(cursor.id)) {
    if (roots.has(cursor.id)) return cursor.id;
    seen.add(cursor.id);
    cursor = cursor.parentId ? beads[cursor.parentId] : null;
  }
  return null;
}

// Judges a deletion against fresh reads of the store. Anything that would
// change work that stays, or delete more than was named, is a problem; the
// deletion goes ahead only when there are none. An incomplete read is a
// problem too.
function assessDeletion(rt, cell, ids, { issues, errors, neighbours }, ownOpId = null) {
  const raw = new Map(issues.map((r) => [r.id, r]));
  const { beads, edges } = buildGraph(issues);
  const chosen = new Set(ids);
  const roots = new Set(rt.metadata.cells().map((c) => c.rootBeadId).filter(Boolean));
  const problems = new Set();
  if (errors.length) problems.add(`Hive could not read ${errors.length} record(s) from the store, so it cannot be sure what the deletion would touch.`);
  for (const id of ids) {
    const b = beads[id];
    if (!b) { problems.add(`${id} is not in Hive's read of the store.`); continue; }
    if (roots.has(id)) { problems.add(`${id} is a hive goal; hive goals are never deleted.`); continue; }
    if (nearestCellRoot(beads, id, roots) !== cell.rootBeadId) problems.add(`${id} is not in this hive.`);
    if (openReview(rt, id)) problems.add(`${id} has an open review; record its verdict or explicitly cancel it first.`);
    if (b.assignee) problems.add(`${id} is claimed by ${b.assignee}; the holder finishes or releases it first.`);
  }
  for (const b of Object.values(beads)) {
    if (b.parentId && chosen.has(b.parentId) && !chosen.has(b.id)) problems.add(`${b.id} is a child of ${b.parentId} and was not named; name it too, or move it with hive_update_bead first.`);
  }
  for (const e of edges) {
    if (chosen.has(e.dependent) !== chosen.has(e.prerequisite)) problems.add(`${e.dependent} has a ${e.type} link to ${e.prerequisite} and only one of them is named; remove the link with hive_link_beads first.`);
  }
  const pattern = new RegExp(`(^|[^A-Za-z0-9_-])(${ids.map((id) => id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})($|[^A-Za-z0-9_-])`);
  for (const n of neighbours) {
    const other = n.issue.id;
    if (chosen.has(other)) continue;
    if (n.direction === 'up') {
      problems.add(n.type === 'parent-child'
        ? `${other} is a child of ${n.anchor} and was not named; name it too, or move it with hive_update_bead first.`
        : `${other} has a ${n.type || 'link'} link to ${n.anchor} and only one of them is named; remove the link with hive_link_beads first.`);
    } else if (n.type !== 'parent-child') {
      problems.add(`${n.anchor} has a ${n.type || 'link'} link to ${other} and only one of them is named; remove the link with hive_link_beads first.`);
    }
    if (DELETE_TEXT_FIELDS.some((f) => typeof n.issue[f] === 'string' && pattern.test(n.issue[f]))) problems.add(`${other} stays but its text mentions an item being deleted, which bd would rewrite; edit ${other} first.`);
  }
  const affected = new Set([...ids, ...ids.map((id) => beads[id]?.parentId), ...neighbours.map((n) => n.issue.id)].filter(Boolean));
  const busy = Object.values(rt.metadata.read().operations)
    .filter((op) => op.id !== ownOpId && (UNSETTLED.has(op.state) || running.has(op.id)) && (op.beadIds || []).some((id) => affected.has(id)));
  for (const op of busy) problems.add(`Operation ${op.id} (${op.kind}) about these items is not settled yet.`);
  const records = ids.filter((id) => raw.has(id)).map((id) => raw.get(id));
  const token = crypto.createHash('sha256').update(JSON.stringify(records)).digest('hex').slice(0, 24);
  return { beads, records, problems: [...problems], token };
}

// The authority to delete, read again at the last moment: the same session is
// still the nominated queen of the same hive, which is still on, not a
// snapshot, and still has the same goal.
function currentQueenCell(rt, cell, sessionId) {
  if (rt.metadata.error) throw new HiveError(rt.metadata.error, 'metadata-unavailable');
  const now = rt.metadata.cell(cell.id);
  if (!now || !now.enabled || now.snapshot || now.rootBeadId !== cell.rootBeadId || now.queenSessionId !== sessionId) {
    throw new AccessError('This hive was turned off, changed its goal or nominated another queen meanwhile. Nothing was deleted.');
  }
  return now;
}

// Queen only. Previews by default; deletes only with execute and the token of
// a preview of exactly the same items in the same state. Never cascades or
// orphans: every child must be named and no link may reach work that stays.
export async function deleteBeads(rt, actor, { bead_ids, reason, execute, confirm_token }) {
  ensureWritable(rt);
  requireQueen(actor, 'delete work items');
  const cell = actor.cell;
  if (!cell.rootBeadId) throw new HiveError('This hive has no goal yet.');
  const why = text(reason, 'reason', LIMITS.short, { required: true });
  if (!Array.isArray(bead_ids) || !bead_ids.length) throw new HiveError('Name at least one item in bead_ids.');
  if (bead_ids.length > DELETE_LIMIT) throw new HiveError(`At most ${DELETE_LIMIT} items per deletion.`);
  const ids = [...new Set(bead_ids.map((id, i) => beadIdArg(id, `bead_ids[${i}]`)))].sort();
  if (ids.length !== bead_ids.length) throw new HiveError('bead_ids names an item more than once.');
  for (const id of ids) {
    const { cell: c } = requireBeadAccess(rt, actor, id);
    if (c.id !== cell.id) throw new AccessError(`${id} is in another hive.`);
  }
  if (!execute) {
    const plan = assessDeletion(rt, cell, ids, await rt.beads.deletionContext(ids));
    const bindings = (rt.metadata.read().bindings[cell.id] || []).filter((b) => b.active && ids.includes(b.beadId));
    return {
      preview: true,
      cell_id: cell.id,
      reason: why,
      items: ids.map((id) => plan.beads[id]).filter(Boolean).map((b) => ({ bead_id: b.id, title: b.title, kind: b.kind, status: b.status, parent_id: b.parentId })),
      bindings_cleared: bindings.map((b) => ({ session_id: b.sessionId, bead_id: b.beadId, role: b.role })),
      problems: plan.problems,
      can_delete: !plan.problems.length,
      confirm_token: plan.problems.length ? undefined : plan.token,
      message: plan.problems.length
        ? 'Nothing can be deleted until every problem is resolved. To retire work but keep its record, use hive_finish_bead instead.'
        : 'Deleting is permanent. To go ahead, call again with the same bead_ids, execute: true and this confirm_token.',
    };
  }
  const token = text(confirm_token, 'confirm_token', 80);
  if (!token) throw new HiveError('Preview the deletion first (without execute), then pass its confirm_token with execute: true.');
  const who = actorFor(actor.sessionId);
  const affected = [...new Set([...ids, ...ids.map((id) => rt.snapshots.graph.beads[id]?.parentId)].filter(Boolean))];
  const out = await withLocks(ids.map((id) => `bead:${id}`), () => journaled(rt, { kind: 'delete-beads', cellId: cell.id, actor: who, summary: `Delete ${ids.length} item(s): ${why}`, beadIds: affected, intent: { beadIds: ids } }, async (opId, phase) => {
    let failure = null;
    try {
      await rt.beads.deleteMany(ids, who, (context) => {
        const plan = assessDeletion(rt, currentQueenCell(rt, cell, actor.sessionId), ids, context, opId);
        if (plan.problems.length) throw new HiveError(`Nothing was deleted. ${plan.problems.join(' ')}`, 'refused');
        if (plan.token !== token) throw new HiveError('These items changed since the preview. Nothing was deleted; preview again.', 'conflict');
        rt.metadata.mutate((d) => {
          if (d.operations[opId]) d.operations[opId] = stamp(d.operations[opId], { reason: why, before: plan.records });
        });
      });
    } catch (err) {
      if (!err.deleteStarted || err.code === 'uncertain') throw err;
      failure = err;
    }
    if (!failure) phase.applied = true;
    const present = [];
    try {
      for (const id of ids) if (await rt.beads.show(id)) present.push(id);
    } catch (err) {
      if (failure) throw new BeadsError('uncertain', `bd reported a failure (${failure.message}) and Hive could not check which items remain: ${err.message}`);
      throw err;
    }
    if (failure && present.length === ids.length) throw failure;
    phase.applied = true;
    const gone = ids.filter((id) => !present.includes(id));
    rt.metadata.mutate((d) => forgetDeleted(d, cell.id, gone, who));
    if (failure) throw new BeadsError('partial', `bd reported a failure, but ${gone.join(', ')} were deleted and ${present.join(', ') || 'none'} remain: ${failure.message}`);
    if (present.length) throw new BeadsError('partial', `bd reported the deletion done, but ${present.join(', ')} still exist.`);
    await rt.snapshots.refresh();
    return { journal: { deleted: ids } };
  }));
  return { op_id: out.opId, deleted: ids };
}

export { AccessError };
