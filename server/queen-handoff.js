import { AccessError } from './access.js';
import { HiveError, text } from './ops.js';
import { launchQueen } from './sessions.js';

export async function handoffQueen(rt, host, actor, input) {
  const cell = rt.metadata.cell(actor.cell.id);
  if (!cell || cell.snapshot || !cell.enabled) throw new HiveError('This cell is not active.');
  if (actor.role !== 'queen' || cell.queenSessionId !== actor.sessionId) throw new AccessError('Only the current queen can hand the cell to a successor.');
  const summary = text(input.summary, 'summary', 20000, { required: true });
  const expectedGeneration = cell.queenGeneration || 0;
  const brief = [
    `You are the successor queen. Queen session ${actor.sessionId} handed this cell to you; its generation was ${expectedGeneration}.`,
    'Call hive_context first. Existing workers keep their claims and reviews; they now report to you, the current queen. Claims held personally by the previous queen are not transferred: release or reassign them deliberately.',
    `Handoff summary from the previous queen:\n${summary}`,
  ].join('\n\n');
  const launched = await launchQueen(rt, host, {
    cellId: cell.id, cwd: input.cwd, agent: input.agent, model: input.model, effort: input.effort, intent: brief,
    handoff: { fromSessionId: actor.sessionId, expectedGeneration, summary },
  });
  const now = rt.metadata.cell(cell.id);
  return {
    launch_id: launched.launchId,
    successor_session_id: launched.sessionId,
    installed: now?.queenSessionId === launched.sessionId,
    note: 'The successor is the cell queen once installed; you no longer have queen authority. Your workers\' claims are unchanged.',
  };
}
