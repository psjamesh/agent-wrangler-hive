import { reconcilePendingCreates, settleOperations, settleOne, needsSettling, checkTarget, byLastChecked, noticeReceipts } from './ops.js';
import { releaseArchivedClaims } from './archived-claims.js';
import { recoverReviews } from './reviews.js';
import { safeDeliver } from './sessions.js';
import { isCurrent } from './lifetime.js';

// Hive settles its own unfinished writes. Each pass reads the store for the
// final state each operation asked for, records it when it is there, and tells
// a cell's queen once about anything still unsettled after a grace period, so
// the agents repair technical bookkeeping without the human being asked.

const NOTIFY_AFTER_MS = 5 * 60000;
const RETRY_FAILED_MS = 15 * 60000;
const MAX_ATTEMPTS = 3;
const NOTIFY_BATCH = 10;

const passes = new WeakMap();

export function recover(rt, host) {
  if (!isCurrent(rt, host)) return Promise.resolve();
  if (passes.has(rt)) return passes.get(rt);
  const pass = (async () => {
    if (rt.metadata.error || rt.beads.status.state !== 'ready') return;
    const before = rt.metadata.version;
    await reconcilePendingCreates(rt);
    await settleOperations(rt);
    if (host) await releaseArchivedClaims(rt, host);
    if (host) await recoverReviews(rt, host);
    if (host && rt.host === host) await notifyQueens(rt, host);
    if (rt.metadata.version !== before) rt.changed();
  })().catch((err) => rt.log(`hive: recovery pass failed: ${err.message}`)).finally(() => { passes.delete(rt); });
  passes.set(rt, pass);
  return pass;
}

// After a write succeeds, any unsettled operation about the same beads may
// now be settled (a worker finishing an item settles a queen's earlier
// refused finish of it). Collected briefly so a burst of writes costs one
// check, and only for the beads written.
const touches = new WeakMap();

export function afterWrite(rt, beadIds = []) {
  if (!isCurrent(rt)) return;
  let batch = touches.get(rt);
  if (!batch) { batch = { ids: new Set(), timer: null }; touches.set(rt, batch); }
  for (const id of beadIds) batch.ids.add(id);
  if (batch.timer || !batch.ids.size) return;
  batch.timer = setTimeout(async () => {
    touches.delete(rt);
    const ids = batch.ids;
    try {
      if (!isCurrent(rt) || rt.metadata.error || rt.beads.status.state !== 'ready') return;
      const ops = Object.values(rt.metadata.read().operations)
        .filter((op) => needsSettling(op) && ids.has(checkTarget(op)))
        .sort(byLastChecked)
        .slice(0, 5);
      let settled = 0;
      for (const op of ops) if ((await settleOne(rt, op.id)).settled) settled += 1;
      if (settled) rt.changed();
    } catch (err) {
      rt.log(`hive: settling after a write failed: ${err.message}`);
    }
  }, 3000);
  batch.timer.unref?.();
}

// Whether this operation should be part of a notice to `queen` now. One notice
// per operation per queen: a confirmed or unconfirmed delivery is final, a
// failed one is tried again a few times, well apart.
function due(op, queen, now) {
  if (!needsSettling(op, now) || now - (op.updatedAt || 0) < NOTIFY_AFTER_MS) return false;
  if (['cell-create', 'cell-root'].includes(op.kind)) return false;
  const n = noticeReceipts(op)[queen];
  if (!n) return true;
  if (n.state !== 'failed') return false;
  return (n.attempts || 0) < MAX_ATTEMPTS && now - (n.at || 0) > RETRY_FAILED_MS;
}

function noticeText(cell, ops) {
  const lines = ops.map((op) => `- ${op.id} (${op.kind}, ${op.state}): ${op.summary || ''}${op.error ? `. Recorded error: ${String(op.error).slice(0, 300)}` : ''}`);
  return [
    `[Hive] ${ops.length === 1 ? 'An operation' : `${ops.length} operations`} in cell ${cell.id} did not finish cleanly, and Hive could not confirm from the store that the requested final state is now there:`,
    ...lines,
    'Please settle this yourself; it is bookkeeping, not a question for the human. Check hive_context (attention.operations_to_reconcile) and the beads named. Do not repeat a write blindly or take over another session\'s claim: the session holding an item finishes it, or you check with it before releasing. Once you know the outcome, record it with hive_reconcile_operation and a note saying what you verified. Ask the human only for a real decision or action they must take.',
  ].join('\n');
}

// Each cell's batch is chosen from the metadata as it is at that moment, never
// from a copy held across an earlier delivery: the cell must still be enabled
// and live with the same queen, and the runtime still attached to this host.
// Nothing more is sent once the runtime detaches.
export async function notifyQueens(rt, host) {
  if (typeof host?.deliver !== 'function') return;
  for (const cellId of Object.keys(rt.metadata.read().cells)) {
    if (rt.host !== host || rt.metadata.error) return;
    const doc = rt.metadata.read();
    const cell = doc.cells[cellId];
    if (!eligible(cell)) continue;
    const queen = cell.queenSessionId;
    const session = host.sessions?.get?.(queen);
    if (!session || session.archived) continue;
    const at = Date.now();
    const candidates = Object.values(doc.operations)
      .filter((op) => op.cellId === cellId && due(op, queen, at))
      .sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0))
      .slice(0, NOTIFY_BATCH)
      .map((op) => op.id);
    if (!candidates.length) continue;
    // Recorded before sending, so a stop mid-delivery leaves "sending", which
    // is never sent again rather than repeated on every restart.
    const ops = rt.metadata.mutate((d) => {
      const c = d.cells[cellId];
      if (!eligible(c) || c.queenSessionId !== queen) return [];
      const marked = [];
      for (const id of candidates) {
        const rec = d.operations[id];
        if (!rec || rec.cellId !== cellId || !due(rec, queen, at)) continue;
        const prior = noticeReceipts(rec);
        rec.notices = { ...prior, [queen]: { state: 'sending', at, attempts: (prior[queen]?.attempts || 0) + 1 } };
        delete rec.notice;
        marked.push(rec);
      }
      return marked;
    });
    if (!ops.length) continue;
    const ids = ops.map((op) => op.id);
    const result = await safeDeliver(host, queen, noticeText(cell, ops), rt);
    rt.metadata.mutate((d) => {
      for (const id of ids) {
        const rec = d.operations[id];
        const n = rec?.notices?.[queen];
        if (n && n.at === at) rec.notices[queen] = { ...n, state: result.state, error: result.error || undefined, finishedAt: Date.now() };
      }
    });
    if (result.state === 'failed') rt.log(`hive: could not tell the queen of ${cellId} about ${ids.length} unsettled operation(s): ${result.error}`);
  }
}

function eligible(cell) {
  return !!cell && cell.enabled && !cell.snapshot && !!cell.queenSessionId;
}
