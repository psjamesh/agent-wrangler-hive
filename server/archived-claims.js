import { recoverReviews } from './reviews.js';
import { SETTABLE_STATUSES } from './bead-model.js';
import { releaseArchivedBead, withLock } from './ops.js';
import { ADMISSION_LOCK, RESERVED_LAUNCH_STATES } from './admission.js';

export async function releaseArchivedClaims(rt, host, sessionId = null) {
  if (rt.host !== host || rt.metadata.error || rt.beads.status.state !== 'ready') return;
  const graph = await rt.beads.loadSnapshot({ all: true });
  const roots = new Map(rt.metadata.cells().filter((c) => !c.snapshot && c.rootBeadId).map((c) => [c.rootBeadId, c.id]));
  const cellFor = (id) => {
    const seen = new Set();
    let bead = graph.beads[id];
    while (bead && !seen.has(bead.id)) {
      if (roots.has(bead.id)) return roots.get(bead.id);
      seen.add(bead.id);
      bead = graph.beads[bead.parentId];
    }
    return null;
  };
  for (const bead of Object.values(graph.beads)) {
    const owner = bead.ownerSessionId;
    if (!owner || (sessionId && owner !== sessionId) || !SETTABLE_STATUSES.includes(bead.status) || !host.sessions.get(owner)?.archived) continue;
    const cellId = cellFor(bead.id);
    if (!cellId) continue;
    try {
      await releaseArchivedBead(rt, host, { beadId: bead.id, sessionId: owner, cellId });
    } catch (err) { rt.log(`hive: archived claim ${bead.id} needs reconciliation: ${err.message}`); }
  }
  await withLock(ADMISSION_LOCK, async () => {
    const changes = Object.values(rt.metadata.read().workerLaunches || {}).filter((l) => l.sessionId && (!sessionId || l.sessionId === sessionId) && RESERVED_LAUNCH_STATES.has(l.state) && host.sessions.get(l.sessionId)?.archived
      && !Object.values(rt.metadata.read().operations).some((op) => op.kind === 'release' && op.intent?.beadId === l.beadId && ['pending', 'uncertain', 'partial'].includes(op.state)));
    if (!changes.length) return;
    rt.metadata.mutate((d) => {
      for (const l of changes) Object.assign(d.workerLaunches[l.id], { state: 'archived', updatedAt: Date.now() });
    });
  });
  rt.changed?.();
}

export async function onArchive({ sessionId, host }) {
  const rt = host?.stores?.hive;
  if (rt) { await releaseArchivedClaims(rt, host, sessionId); await recoverReviews(rt, host); }
}
