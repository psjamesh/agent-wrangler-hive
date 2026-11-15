import { exportedGraph } from './admission.js';
import { HiveError, LIMITS, text, ensureWritable, refuseSnapshot, withLocks, journaled } from './ops.js';
import { HUMAN_ACTOR, normalizeIssue } from './bead-model.js';
import { recordHumanSettingsInput, deliver } from './conversation.js';

function editableCell(rt, cellId) {
  ensureWritable(rt);
  const cell = rt.metadata.cell(cellId);
  if (!cell) throw new HiveError('Unknown hive.');
  refuseSnapshot(cell);
  if (cell.retired) throw new HiveError('This hive is retired. Reopen it to edit it.');
  return cell;
}

export async function renameCell(rt, host, { cellId, name }) {
  const cell = editableCell(rt, cellId);
  const clean = text(name, 'name', LIMITS.title, { required: true });
  const task = host.tasks.get(cell.taskId);
  if (!task) throw new HiveError('The task for this hive no longer exists.');
  if (task.name === clean) return { name: clean };
  if (typeof host.tasks.rename !== 'function') throw new HiveError('This Agent Wrangler host cannot rename tasks.');
  if (!await host.tasks.rename(cell.taskId, clean)) throw new HiveError('The task could not be renamed.');
  Promise.resolve(host.rebuild?.()).catch(err => rt.log(`hive: rebuild after rename failed: ${err.message}`));
  return { name: clean };
}

export async function saveCellGoal(rt, host, { cellId, goal, acceptance, expectedUpdatedAt }) {
  const cell = editableCell(rt, cellId);
  if (!cell.rootBeadId) throw new HiveError('This hive has no goal bead yet.');
  if (typeof expectedUpdatedAt !== 'string' || !expectedUpdatedAt) throw new HiveError('The goal revision is missing. Reopen settings and try again.', 'stale');
  const patch = {};
  for (const [key, value] of Object.entries({ goal, acceptance })) {
    if (typeof value !== 'string') throw new HiveError(`${key} must be a string.`);
    patch[key] = text(value, key, LIMITS.long);
  }
  return withLocks([`bead:${cell.rootBeadId}`], () => journaled(rt, {
    kind: 'update-bead', cellId, actor: HUMAN_ACTOR, summary: 'Human edited hive goal and done when',
    beadIds: [cell.rootBeadId], intent: { beadId: cell.rootBeadId, fields: ['goal', 'acceptance'] },
  }, async (opId, phase) => {
    const written = await rt.beads.update(cell.rootBeadId, patch, HUMAN_ACTOR, context => {
      const current = exportedGraph(context).beads[cell.rootBeadId];
      editableCell(rt, cellId);
      if (!current || current.updatedAt !== expectedUpdatedAt) throw new HiveError('The goal changed. Reopen settings and try again.', 'stale');
    });
    phase.applied = true;
    const saved = await recordHumanSettingsInput(rt, {
      cellId, beadId: cell.rootBeadId, newThread: { title: 'Hive goal edited', beadId: cell.rootBeadId },
      text: `I edited this hive’s Goal and Done when in settings. Read the updated goal and acceptance on ${cell.rootBeadId} and use them for this hive’s work.`,
    });
    const delivery = await deliver(rt, host, { cellId, messageId: saved.id }).catch(err => ({ state: 'failed', error: err.message }));
    let updatedAt = written?.updated_at;
    if (!updatedAt) {
      const fresh = await rt.beads.show(cell.rootBeadId);
      const current = fresh && normalizeIssue(fresh);
      if (!current || current.goal !== patch.goal || current.acceptance !== patch.acceptance) throw new HiveError('The goal changed again after saving. Reopen settings before editing again.', 'partial');
      updatedAt = fresh.updated_at;
    }
    if (!updatedAt) throw new HiveError('The goal was saved but its revision could not be read. Reopen settings before editing again.', 'partial');
    return { messageId: saved.id, delivery, updatedAt };
  }));
}
