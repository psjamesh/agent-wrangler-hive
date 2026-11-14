import { workerBeforeDispatch } from './workers.js';
import { assertCurrent } from './lifetime.js';
import { applyLaunchPolicy, launchRestriction } from './launch-policy.js';
import { newId } from './metadata-store.js';
import { isSessionId } from './bead-model.js';
import { participation, SPAWN_GRACE_MS } from './access.js';
import { HiveError, recordQueen, clearQueen, text, refuseSnapshot, setQueenInstructions } from './ops.js';

const ACTIVE_LAUNCH = new Set(['pending', 'bound', 'uncertain']);
const launchesInFlight = new Set();

// The cell's saved queen instructions: how the human wants the queen to work.
// They are guidance for the queen, repeated in hive_context, not a gate Hive
// checks.
export function instructionsBlock(cell) {
  const body = String(cell?.queenInstructions || '').trim();
  return body ? `\nHow the human wants you to work in this cell (also in hive_context as queen_instructions):\n${body}` : '';
}

export function handoverSources(host) {
  return (host.sessions.list?.() || []).filter((s) =>
    !s.archived && !s.archivedAt && (s.name || s.lastLabel)?.trim() &&
    (!s.runtime || s.runtime === 'local') && ['claude', 'codex'].includes(s.agent)
  ).map((s) => ({ sessionId: s.sessionId, name: s.name || s.lastLabel, taskId: s.taskId, taskName: host.tasks.get(s.taskId)?.name || s.taskId || 'No task' }));
}

export function validateHandoverSource(host, source, taskId, allowCrossTask = false) {
  if (source === undefined || source === null || source === '') return null;
  if (typeof source !== 'string' || !isSessionId(source)) throw new HiveError('Choose a valid handover source session.');
  const s = host.sessions.get(source);
  if (!s || s.archived || s.archivedAt || !(s.name || s.lastLabel)?.trim() ||
      (s.runtime && s.runtime !== 'local') || !['claude', 'codex'].includes(s.agent)) {
    throw new HiveError('The selected handover source is no longer eligible. Choose a named, active local Claude or Codex session.');
  }
  if (!allowCrossTask && s.taskId !== taskId) throw new HiveError('The handover source must belong to this task.');
  return source;
}

function handoverBrief(launch) {
  if (!launch) return '';
  if (!launch.handoverSourceSessionId) return `Current queen launch ${launch.id}: no handover, no archive. Do not revive historical handover requests or archive any source from them.`;
  return `
Request a handover from session ${launch.handoverSourceSessionId} using send_message; request id ${launch.id}. You are already the newly launched and nominated queen of cell ${launch.cellId}, task ${launch.taskId}. Archive-after-handover: ${launch.archiveSourceAfterHandover ? 'YES' : 'NO'}.
Follow the hive-queen handover procedure: send a standalone request with your actual session id as reply address, verify the source reply and read all referenced files, publish a durable receipt, confirm receipt by mail, then explicitly reconcile releases, claims and bindings. Only archive the exact selected source after its readiness and obligations are settled, with archive_children:false. Delivery is not receipt. Recheck your current queen role before accepting, changing claims or archiving. Do not use generic handoff or ask the source to launch another queen.
Source mail capability cannot be verified by the current host API: eligible local legacy cards may fail delivery or never reply. Failed/uncertain delivery, busy or incomplete replies and unreadable files leave handover pending: tell the human, keep the source unarchived and continue independent work. No polling or automatic timeout-to-archive. Cross-task sources provide context only; never move another cell's claims or archive while its obligations remain. Record request, receipt, dispositions and archive outcome in one Hive topic.`;
}

export function queenBrief({ cell, taskName, extra = '', launch }) {
  return [
    `You are the queen of the Hive cell for task "${taskName}" (cell ${cell.id}, task ${cell.taskId}).`,
    'Use the hive-queen skill. Start with hive_context to recover the goal, the work graph and any input from the human, then keep the work record coherent: maintain goals and readiness with the hive_* tools, delegate tracked work with hive_spawn_worker (passing its bead_id) and request reviews with hive_request_review, and reconcile what workers report. Do not call spawn_session, spawn_workflow or schedule_session; every helper, advisor or investigation is a bead launched with hive_spawn_worker, and a successor queen is requested with hive_handoff_queen.',
    'If the task already has sessions or work, map it before anything else, as the hive-queen skill\'s "Map existing work" section describes: reuse any beads and bindings already there, and do not spawn workers just to represent sessions that exist.',
    'Follow the review and merge instructions the human, the repository and your global skills give you. Answer each [Hive] message from the human with hive_publish and its reply_to: your terminal text is not shown in Hive. Also publish what the human should know even when they need not act: meaningful milestones and results, significant changes of approach, scope or timing, material blockers and how you are handling them, decisions, questions, and completion or verification outcomes. Say in one concise message what changed, why it matters and what comes next. Leave routine bookkeeping, unchanged status and worker chatter on the beads, and post no timed status updates.',
    `When the human must act in a specific session, pass its full session_id and optional session_label to hive_request_input or hive_publish for a one-click board link. For decisions or actions use Hive's input tool hive_request_input; do not also call request_human_input. Review worker/reviewer input_requests in hive_context: answer within your authority with hive_answer_request or forward the same id with hive_forward_request. Queen-stage requests stay out of human views; human step-in is not supported. Helpers must launch into task ${cell.taskId}; ancestry alone does not enroll them. If tools are missing, check membership and refresh the agent terminal.`,
    handoverBrief(launch),
    instructionsBlock(cell),
    extra ? `\nFrom the human, for this launch:\n${extra}` : '',
  ].join('\n').trim();
}

export function activationBrief({ cell, taskName }) {
  return `[Hive] Queen brief\n${queenBrief({ cell, taskName })}`;
}

// An explicit unknown outcome wins over the mode: AW reports
// { mode: 'error', outcome: 'unknown' } after a paste may already have landed.
// Only an error with no unknown outcome is treated as not delivered.
export function deliveryState(result) {
  if (result?.outcome === 'unknown') return { state: 'uncertain', error: result.error || 'Delivery could not be confirmed.' };
  if (!result || result.mode === 'error') return { state: 'failed', error: result?.error || 'Delivery failed.' };
  if (result.mode === 'live' || result.mode === 'dormant') return { state: 'delivered', error: '' };
  return { state: 'uncertain', error: 'Unrecognised delivery result.' };
}

export async function safeDeliver(host, sessionId, textBody, rt = host?.stores?.hive) {
  assertCurrent(rt, host);
  try {
    return deliveryState(await host.deliver(sessionId, textBody));
  } catch (err) {
    return { state: 'uncertain', error: `Delivery threw after it may have started: ${err?.message || err}` };
  }
}

export async function sendActivationBrief(rt, host, { cellId }) {
  const cell = rt.metadata.cell(cellId);
  refuseSnapshot(cell);
  if (!cell?.queenSessionId) throw new HiveError('This cell has no queen to brief.');
  const taskName = host.tasks.get(cell.taskId)?.name || cell.taskId;
  const attemptId = newId('brief');
  rt.metadata.mutate((d) => {
    d.cells[cellId].activation = { attemptId, sessionId: cell.queenSessionId, state: 'pending', at: Date.now() };
  });
  const result = await safeDeliver(host, cell.queenSessionId, activationBrief({ cell, taskName }), rt);
  rt.metadata.mutate((d) => {
    const a = d.cells[cellId]?.activation;
    if (a?.attemptId === attemptId) Object.assign(a, result, { finishedAt: Date.now() });
  });
  return result;
}

export async function launchQueen(rt, host, { cellId, cwd, agent, model, effort, autoCompactTokens, intent, instructions, handoff = null, handoverSourceSessionId, archiveSourceAfterHandover, allowCrossTaskSource = false }) {
  if (rt.metadata.error) throw new HiveError(rt.metadata.error);
  let cell = rt.metadata.cell(cellId);
  if (!cell) throw new HiveError(`Unknown cell ${cellId}.`);
  refuseSnapshot(cell);
  if (!cell.enabled) throw new HiveError('Turn the cell on before launching a queen.');
  const active = Object.values(rt.metadata.read().launches).find((l) => l.cellId === cellId && ACTIVE_LAUNCH.has(l.state));
  if (active) throw new HiveError(`A queen launch for this cell is already ${active.state}. Reconcile it before launching another.`);
  const task = host.tasks.get(cell.taskId);
  if (!task || task.archived) throw new HiveError('The cell\'s task is archived.');
  if (handoff && ((cell.queenGeneration || 0) !== handoff.expectedGeneration || cell.queenSessionId !== handoff.fromSessionId)) throw new HiveError('The queen changed; this handoff is stale.', 'conflict');
  const source = validateHandoverSource(host, handoverSourceSessionId, cell.taskId, allowCrossTaskSource);
  if (archiveSourceAfterHandover !== undefined && typeof archiveSourceAfterHandover !== 'boolean') throw new HiveError('Archive source after handover must be a checkbox value.');
  const archive = Boolean(source) && archiveSourceAfterHandover !== false;
  const extra = text(intent, 'intent', 20000) || '';
  if (autoCompactTokens != null && (!Number.isInteger(autoCompactTokens) || autoCompactTokens <= 0)) throw new HiveError('Auto-compaction threshold must be a whole number of tokens.');
  if (instructions !== undefined) {
    setQueenInstructions(rt, { cellId, instructions });
    cell = rt.metadata.cell(cellId);
  }
  const launchId = newId('launch');
  rt.metadata.mutate((d) => {
    d.launches[launchId] = { id: launchId, cellId, taskId: cell.taskId, handoverSourceSessionId: source, archiveSourceAfterHandover: archive, state: 'pending', sessionId: null, generation: d.cells[cellId].queenGeneration || 0, restriction: launchRestriction(agent), ...(handoff ? { handoff: { fromSessionId: handoff.fromSessionId, summary: handoff.summary.slice(0, 4000) } } : {}), createdAt: Date.now(), updatedAt: Date.now() };
  });
  const opts = { intent: queenBrief({ cell, taskName: task.name, extra, launch: rt.metadata.read().launches[launchId] }), taskId: cell.taskId, ext: { hive: { launchId } } };
  if (typeof cwd === 'string' && cwd.trim()) opts.cwd = cwd.trim();
  for (const [k, v] of [['agent', agent], ['model', model], ['effort', effort]]) if (typeof v === 'string' && v.trim()) opts[k] = v.trim();
  if (autoCompactTokens != null) opts.autoCompactTokens = autoCompactTokens;
  let result;
  launchesInFlight.add(launchId);
  try {
    assertCurrent(rt, host);
    result = await host.sessions.spawn(applyLaunchPolicy(opts));
  } catch (err) {
    const bound = rt.metadata.read().launches[launchId];
    try {
      rt.metadata.mutate((d) => {
        const l = d.launches[launchId];
        l.state = bound?.sessionId ? 'uncertain' : 'failed';
        l.error = String(err?.message || err).slice(0, 1000);
        l.updatedAt = Date.now();
      });
    } catch (metaErr) {
      rt.log(`hive: could not record outcome of launch ${launchId}; it stays ${bound?.state || 'pending'}: ${metaErr.message}`);
    }
    throw new HiveError(bound?.sessionId
      ? `The queen session ${bound.sessionId} was created but its launch reported an error: ${err.message}. Reconcile the launch rather than launching again.`
      : `Could not launch the queen: ${err.message}`);
  } finally {
    launchesInFlight.delete(launchId);
  }
  const sessionId = result?.sessionId;
  rt.metadata.mutate((d) => {
    const l = d.launches[launchId];
    if (l.state !== 'pending' && l.state !== 'bound') return;
    l.state = 'launched';
    l.sessionId = l.sessionId || sessionId || null;
    l.updatedAt = Date.now();
    const cell = d.cells[cellId];
    if (!cell || !l.sessionId || l.superseded || cell.queenSessionId === l.sessionId) return;
    if ((cell.queenGeneration || 0) !== l.generation) {
      l.superseded = true;
      return;
    }
    recordQueen(d, cellId, l.sessionId, Date.now(), 'launched', { revokeFrom: l.handoff?.fromSessionId });
    l.generation = cell.queenGeneration;
  });
  return { launchId, sessionId };
}

// A launch is settled only by evidence: a session on the board, or a human
// abandoning it after looking. An absent entry is not proof of failure, since
// AW saves the session only after Hive's dispatch hook has run.
export function reconcileLaunch(rt, host, { launchId, dismiss = false, abandon = false }) {
  const l = rt.metadata.read().launches[launchId];
  if (!l) throw new HiveError(`Unknown launch ${launchId}.`);
  if (dismiss) {
    if (l.state !== 'failed') throw new HiveError('Only a failed launch can be dismissed.');
    rt.metadata.mutate((d) => { d.launches[launchId].state = 'dismissed'; });
    return { launchId, state: 'dismissed' };
  }
  if (!ACTIVE_LAUNCH.has(l.state)) return { launchId, state: l.state };
  if (launchesInFlight.has(launchId)) throw new HiveError('This launch is still in progress. Check it again once it finishes.');
  const session = l.sessionId ? host.sessions.get(l.sessionId) : null;
  if (session && !session.archived) {
    rt.metadata.mutate((d) => {
      const rec = d.launches[launchId];
      rec.state = 'launched';
      rec.updatedAt = Date.now();
    });
    return { launchId, state: 'launched', sessionId: l.sessionId };
  }
  if (!abandon) {
    rt.metadata.mutate((d) => {
      const rec = d.launches[launchId];
      rec.state = 'uncertain';
      rec.updatedAt = Date.now();
      rec.error = l.sessionId
        ? `No session ${l.sessionId} is on the board yet. If you have checked it is not starting, abandon this launch.`
        : 'This launch never reported a session. If you have checked nothing is starting, abandon it.';
    });
    return { launchId, state: 'uncertain', sessionId: l.sessionId };
  }
  rt.metadata.mutate((d) => {
    const rec = d.launches[launchId];
    rec.state = 'abandoned';
    rec.updatedAt = Date.now();
    const cell = d.cells[rec.cellId];
    if (cell && rec.sessionId && !rec.superseded && cell.queenSessionId === rec.sessionId && (cell.queenGeneration || 0) === rec.generation) {
      clearQueen(d, rec.cellId, Date.now());
    }
  });
  return { launchId, state: 'abandoned', sessionId: l.sessionId };
}

// Runs after dispatch has minted the card id and before the launch command,
// the skill gate or the agent's first tool call: the only window in which a
// UI-launched queen can be bound without a race.
export function onBeforeDispatch({ sessionId, ext, host }) {
  const rt = host?.stores?.hive;
  if (!rt || !isSessionId(sessionId)) return;
  if (workerBeforeDispatch({ sessionId, ext, host })) return;
  const launchId = ext && typeof ext === 'object' ? ext.launchId : null;
  if (typeof launchId === 'string' && !rt.metadata.error) {
    const l = rt.metadata.read().launches[launchId];
    if (l) (rt.queenDispatches ||= new Map()).set(sessionId, launchId);
    if (l && l.state === 'pending') {
      rt.metadata.mutate((d) => {
        const rec = d.launches[launchId];
        rec.sessionId = sessionId;
        rec.state = 'bound';
        rec.boundAt = Date.now();
        rec.updatedAt = rec.boundAt;
        const cell = d.cells[rec.cellId];
        if (!cell) return;
        if ((cell.queenGeneration || 0) === rec.generation) {
          recordQueen(d, rec.cellId, sessionId, rec.boundAt, 'launched', { revokeFrom: rec.handoff?.fromSessionId });
          rec.generation = cell.queenGeneration;
        } else {
          rec.superseded = true;
        }
      });
      return;
    }
  }
}

export async function queenLaunchContext({ sid, ext, reason, host }) {
  if (!['dispatch', 'spawn'].includes(reason)) return;
  const rt = host?.stores?.hive;
  if (!rt || rt.metadata.error) return;
  const launches = Object.values(rt.metadata.read().launches || {});
  const launch = rt.metadata.read().launches[(typeof ext?.launchId === 'string' && ext.launchId) || rt.queenDispatches?.get(sid)] || launches.find((l) => l.sessionId === sid);
  if (!launch || (launch.sessionId && launch.sessionId !== sid)) return;
  try { assertCurrent(rt, host); } catch (err) { return { refuse: `Hive refused queen startup: ${err.message}` }; }
  const cell = rt.metadata.cell(launch.cellId);
  if (launch.superseded || launch.state === 'abandoned' || !cell?.enabled || cell.queenSessionId !== sid || (cell.queenGeneration || 0) !== launch.generation) {
    return { refuse: 'Hive refused queen startup: this queen launch was superseded, abandoned or replaced before it started.' };
  }
}

// session.prepare runs for every new dispatch with the task the launch will be
// assigned to, before the skill gate and the agent's first call. A session
// spawned by a participant counts as taking part only when that resolved task
// is the cell's own task; lineage alone never grants a cell.
export function prepareSession({ sessionId, taskId, spawnedBy, host }) {
  const rt = host?.stores?.hive;
  if (!rt || !isSessionId(sessionId) || !isSessionId(spawnedBy) || typeof taskId !== 'string' || !taskId) return;
  const cell = rt.metadata.cellForTask(taskId);
  if (!cell || !cell.enabled) return;
  if (!participation(rt, host, spawnedBy).some((p) => p.cell.id === cell.id)) return;
  const now = Date.now();
  for (const [sid, v] of rt.pendingParticipants) if (now - v.at > SPAWN_GRACE_MS) rt.pendingParticipants.delete(sid);
  rt.pendingParticipants.set(sessionId, { cellId: cell.id, taskId, spawnedBy, at: now });
}

export function sessionSummary(host, sessionId) {
  const s = isSessionId(sessionId) ? host.sessions.get(sessionId) : null;
  if (!s) return { session_id: sessionId, known: false };
  return {
    session_id: sessionId,
    known: true,
    name: s.name || s.lastLabel || '',
    status: s.status,
    dormant: s.dormant,
    archived: s.archived,
    waiting_reason: s.waitingReason,
    task_id: s.taskId,
    spawned_by: s.spawnedBy,
  };
}
