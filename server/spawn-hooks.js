import { participation, requireCompleteHierarchy, cellOfBead } from './access.js';
import { capacity, capacitySlots, eligibleWorkCell } from './admission.js';
import { actorFor } from './bead-model.js';
import { newId } from './metadata-store.js';
import { assertCurrent } from './lifetime.js';
import { ensureWritable } from './ops.js';
import { safeDeliver } from './sessions.js';

export function beforeSpawn({ spawnedBy, parentSession, source, spawner, host }) {
  const rt = host?.stores?.hive;
  if (!rt || spawner === 'hive') return;
  const parentId = source === 'fork' ? parentSession : spawnedBy;
  if (!parentId) return;
  try {
    const parts = participation(rt, host, parentId);
    if (!parts.length) return;
    assertCurrent(rt, host);
    ensureWritable(rt);
    requireCompleteHierarchy(rt);
    const doc = rt.metadata.read();
    const targets = new Map();
    for (const { cell } of parts) {
      for (const b of doc.bindings[cell.id] || []) {
        if (b.active && b.sessionId === parentId && rt.snapshots.graph.beads[b.beadId]?.status !== 'closed' && cellOfBead(rt, b.beadId)?.id === cell.id) targets.set(b.beadId, cell);
      }
      for (const b of Object.values(rt.snapshots.graph.beads)) {
        if (b.assignee === actorFor(parentId) && b.status !== 'closed' && cellOfBead(rt, b.id)?.id === cell.id) targets.set(b.id, cell);
      }
    }
    if (!targets.size && parts.length === 1) targets.set(parts[0].cell.rootBeadId, parts[0].cell);
    if (targets.size !== 1) return { refuse: 'Hive cannot determine one parent bead for this helper. Ask the queen to bind the parent to one bead or launch through Hive.' };
    const [beadId, cell] = [...targets][0];
    if (!rt.snapshots.graph.beads[beadId] || rt.snapshots.graph.beads[beadId].status === 'closed') return { refuse: 'Hive cannot enrol a helper on a missing or closed parent bead.' };
    const slots = capacitySlots(rt, rt.snapshots.graph);
    if (eligibleWorkCell(rt, rt.snapshots.graph, beadId)?.id === cell.id) slots.reserved.add(beadId);
    const usage = capacity(rt, rt.snapshots.graph, { slots });
    if (usage.limit && usage.used > usage.limit) return { refuse: `Hive capacity limit is ${usage.limit}; ${usage.used} slots would be occupied. Ask the queen to free capacity or change Maximum active work items.` };
    const data = { id: newId('helper'), cellId: cell.id, beadId, parentId, at: Date.now() };
    (rt.spawnAdmissions ||= new Map()).set(data.id, data);
    (rt.spawnAdmissionTokens ||= new WeakSet()).add(data);
    rt.changed();
    return { data };
  } catch (err) {
    return { refuse: `Hive refused helper launch: ${err.message}` };
  }
}

export async function spawned({ sessionId, data, host }) {
  const rt = host?.stores?.hive;
  if (!rt || !data?.id) return;
  assertCurrent(rt, host);
  if (!rt.spawnAdmissionTokens?.has(data)) return;
  const admission = data;
  const { cellId, beadId, parentId } = admission;
  rt.metadata.mutate(d => {
    const list = d.bindings[cellId] ||= [];
    if (!list.some(b => b.active && b.sessionId === sessionId && b.beadId === beadId)) list.push({ id: newId('bind'), sessionId, beadId, role: 'investigator', boundBy: actorFor(parentId), active: true, at: Date.now(), autoEnrolled: true });
  });
  rt.spawnAdmissions.delete(data.id);
  rt.spawnAdmissionTokens.delete(data);
  rt.changed();
  const brief = `[Hive] You are a helper on Hive cell ${beadId} in Hive ${cellId}. The parent keeps its claim. Use the hive-worker skill and start with hive_context({ scope: "bead", bead_id: "${beadId}", hive_id: "${cellId}" }). Report results to session ${parentId} by Agent Wrangler mail. For decisions or actions use hive_request_input, not request_human_input; requests go to this hive's queen. Delegate through Hive or ask the queen. If Hive tools are missing, ask the queen to check membership and refresh the agent terminal.`;
  const result = await safeDeliver(host, sessionId, brief, rt);
  assertCurrent(rt, host);
  if (result.state !== 'delivered') rt.log(`hive: helper ${sessionId} brief delivery ${result.state}: ${result.error}`);
}
