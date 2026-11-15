import { descendantIds, normalizeIssue } from './bead-model.js';
import { exportedGraph } from './admission.js';
import { HiveError, journaled, withLocks } from './ops.js';
import { managedPickupReceipt } from './pickup.js';
import { isCurrent } from './lifetime.js';
import { newId } from './metadata-store.js';

export const STRUCTURED_WAIT_HELP = 'A deferred bead needs a structured condition: add an open prerequisite with hive_link_beads (type "blocks", using a normal or external bead), or set resume_after_bead or resume_review_at with hive_update_bead. Prose in waiting_for is only an annotation.';
export const waitStatus = status => status === 'deferred';
export const explicitResume = bead => Boolean(bead.resume?.afterBead || bead.resume?.reviewAt);
export const prerequisites = (graph, id) => (graph.edges || []).filter(e => e.dependent === id && e.blocking);
export const linksResolved = (graph, id) => {
  const edges = prerequisites(graph, id);
  return edges.length > 0 && edges.every(e => graph.beads[e.prerequisite]?.status === 'closed');
};
export function structuredWait(graph, bead) {
  return explicitResume(bead) || prerequisites(graph, bead.id).some(e => graph.beads[e.prerequisite] && graph.beads[e.prerequisite].status !== 'closed');
}
export function requireStructuredWait(graph, bead) {
  if (waitStatus(bead.status) && !structuredWait(graph, bead)) throw new HiveError(STRUCTURED_WAIT_HELP, 'refused');
}

const needsResolution = (graph, bead) => bead.status !== 'closed' && !explicitResume(bead) && linksResolved(graph, bead.id) && waitStatus(bead.status);

function recordResolution(doc, cellId, id, refs, at) {
  const records = doc.cells[cellId].linkWaits ||= {};
  if (records[id]?.refs === refs && records[id].resolution && !records[id].waiting) return;
  records[id] = { refs, waiting: false, resolution: { id: newId('wait'), at } };
}

export function observeLinkWaits(rt, at = Date.now()) {
  if (!isCurrent(rt) || rt.metadata.error || rt.snapshots.hierarchyCurrent === false || rt.snapshots.current.error) return;
  const graph = rt.snapshots.graph;
  const edits = [];
  for (const cell of rt.metadata.cells()) {
    if (!cell.enabled || cell.snapshot) continue;
    const ids = descendantIds(graph.beads, cell.rootBeadId);
    for (const id of new Set([...ids, ...Object.keys(cell.linkWaits || {})])) {
      const bead = graph.beads[id];
      const edges = prerequisites(graph, id);
      const refs = JSON.stringify([...new Set(edges.map(e => e.prerequisite))].sort());
      const previous = cell.linkWaits?.[id];
      if (!ids.has(id) || !bead || bead.status === 'closed' || explicitResume(bead) || !edges.length) {
        if (previous) edits.push({ cellId: cell.id, id, remove: true });
      } else if (!linksResolved(graph, id)) {
        if (!previous?.waiting || previous.refs !== refs) edits.push({ cellId: cell.id, id, refs, waiting: true });
      } else if (previous?.waiting && previous.refs === refs) {
        edits.push({ cellId: cell.id, id, refs });
      } else if (previous && previous.refs !== refs) {
        edits.push({ cellId: cell.id, id, remove: true });
      }
    }
  }
  if (edits.length) rt.metadata.mutate(d => {
    for (const edit of edits) {
      const records = d.cells[edit.cellId].linkWaits ||= {};
      if (edit.remove) delete records[edit.id];
      else if (edit.waiting) records[edit.id] = { refs: edit.refs, waiting: true };
      else recordResolution(d, edit.cellId, edit.id, edit.refs, at);
    }
  });
}

export async function resolveLinkWaits(rt, host, at = Date.now()) {
  const usable = () => isCurrent(rt, host) && !rt.metadata.error && rt.snapshots.hierarchyCurrent !== false && !rt.snapshots.current.error;
  if (!usable()) return;
  await migrateBlocked(rt, host, at);
  if (!usable()) return;
  observeLinkWaits(rt, at);
  for (const cell of rt.metadata.cells()) {
    if (!cell.enabled || cell.snapshot) continue;
    for (const id of descendantIds(rt.snapshots.graph.beads, cell.rootBeadId)) {
      const bead = rt.snapshots.graph.beads[id];
      if (!bead || !needsResolution(rt.snapshots.graph, bead)) continue;
      const refs = JSON.stringify([...new Set(prerequisites(rt.snapshots.graph, id).map(e => e.prerequisite))].sort());
      await withLocks([`bead:${id}`], async () => {
        if (!usable()) return;
        const unsettled = Object.values(rt.metadata.read().operations || {}).some(o => ['pending', 'uncertain', 'partial'].includes(o.state) && (o.beadIds?.includes(id) || o.intent?.beadId === id));
        if (unsettled) return;
        try {
          await journaled(rt, { kind: 'resolve-link-wait', cellId: cell.id, actor: 'hive', summary: `Resolve prerequisites for ${id}`, beadIds: [id], intent: { beadId: id }, onApplied: d => recordResolution(d, cell.id, id, refs, at) }, async (opId, phase) => {
            let before;
            const patch = { waitingFor: '', status: 'open' };
            const written = await rt.beads.update(id, patch, 'hive', context => {
              if (!usable() || !rt.metadata.cell(cell.id)?.enabled || rt.metadata.cell(cell.id)?.snapshot) throw new HiveError('Hive changed before resolving the wait.', 'conflict');
              const graph = exportedGraph(context);
              const current = graph.beads[id];
              if (!current || current.updatedAt !== bead.updatedAt || current.status !== bead.status || current.assignee !== bead.assignee || !needsResolution(graph, current) || !descendantIds(graph.beads, cell.rootBeadId).has(id)) throw new HiveError('The linked wait changed; reread it before resolving.', 'conflict');
              before = current;
              return { assignee: current.assignee || '', status: current.status };
            });
            phase.applied = true;
            if (written) managedPickupReceipt(rt, before, normalizeIssue(written));
            await rt.snapshots.refresh();
            return { journal: { fields: Object.keys(patch) } };
          });
        } catch (err) { rt.log(`hive: could not resolve linked wait ${id}: ${err.message}`); }
      });
    }
  }
}

async function migrateBlocked(rt, host, at) {
  for (const cell of rt.metadata.cells()) {
    if (!cell.enabled || cell.snapshot) continue;
    for (const id of descendantIds(rt.snapshots.graph.beads, cell.rootBeadId)) {
      const bead = rt.snapshots.graph.beads[id];
      if (bead?.status !== 'blocked') continue;
      await withLocks([`bead:${id}`], async () => {
        const usable = () => isCurrent(rt, host) && !rt.metadata.error && rt.snapshots.hierarchyCurrent !== false && !rt.snapshots.current.error
          && rt.metadata.cell(cell.id)?.enabled && !rt.metadata.cell(cell.id)?.snapshot;
        if (!usable() || Object.values(rt.metadata.read().operations || {}).some(o => ['pending', 'uncertain', 'partial'].includes(o.state) && (o.beadIds?.includes(id) || o.intent?.beadId === id))) return;
        try {
          await journaled(rt, { kind: 'migrate-blocked', cellId: cell.id, actor: 'hive', summary: `Migrate blocked status for ${id}`, beadIds: [id], intent: { beadId: id }, onApplied: d => {
            (d.cells[cell.id].blockedMigrations ||= {})[id] = { at };
          } }, async (opId, phase) => {
            let before;
            const written = await rt.beads.update(id, { status: 'open' }, 'hive', context => {
              const graph = exportedGraph(context);
              const current = graph.beads[id];
              if (!usable() || !current || current.status !== 'blocked' || current.updatedAt !== bead.updatedAt || current.assignee !== bead.assignee || !descendantIds(graph.beads, cell.rootBeadId).has(id)) throw new HiveError('Bead changed before blocked status migration.', 'conflict');
              before = current;
              return { assignee: current.assignee || '', status: 'blocked' };
            });
            phase.applied = true;
            if (written) managedPickupReceipt(rt, before, normalizeIssue(written));
            await rt.snapshots.refresh();
            return { journal: { fields: ['status'] } };
          });
        } catch (err) { rt.log(`hive: could not migrate blocked bead ${id}: ${err.message}`); }
      });
    }
  }
}
