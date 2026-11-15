import { descendantIds, normalizeIssue } from './bead-model.js';
import { exportedGraph } from './admission.js';
import { HiveError, journaled, withLocks } from './ops.js';
import { managedPickupReceipt } from './pickup.js';
import { isCurrent } from './lifetime.js';

export const STRUCTURED_WAIT_HELP = 'A blocked or deferred bead needs a structured condition: add an open prerequisite with hive_link_beads (type "blocks", using a normal or external bead), or set resume_after_bead or resume_review_at with hive_update_bead. Prose in waiting_for is only an annotation.';
export const waitStatus = status => ['blocked', 'deferred'].includes(status);
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

const needsResolution = (graph, bead) => bead.status !== 'closed' && !explicitResume(bead) && linksResolved(graph, bead.id) && (waitStatus(bead.status) || bead.waitingFor);

export async function resolveLinkWaits(rt, host) {
  const usable = () => isCurrent(rt, host) && !rt.metadata.error && rt.snapshots.hierarchyCurrent !== false && !rt.snapshots.current.error;
  if (!usable()) return;
  for (const cell of rt.metadata.cells()) {
    if (!cell.enabled || cell.snapshot) continue;
    for (const id of descendantIds(rt.snapshots.graph.beads, cell.rootBeadId)) {
      const bead = rt.snapshots.graph.beads[id];
      if (!bead || !needsResolution(rt.snapshots.graph, bead)) continue;
      await withLocks([`bead:${id}`], async () => {
        if (!usable()) return;
        const unsettled = Object.values(rt.metadata.read().operations || {}).some(o => ['pending', 'uncertain', 'partial'].includes(o.state) && (o.beadIds?.includes(id) || o.intent?.beadId === id));
        if (unsettled) return;
        try {
          await journaled(rt, { kind: 'resolve-link-wait', cellId: cell.id, actor: 'hive', summary: `Resolve prerequisites for ${id}`, beadIds: [id], intent: { beadId: id } }, async (opId, phase) => {
            let before;
            const patch = { waitingFor: '', ...(waitStatus(bead.status) ? { status: 'open' } : {}) };
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
