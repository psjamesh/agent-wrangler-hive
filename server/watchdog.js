import { isScheduleItem } from '../public/schedule.js';
import { ciWaitAttention, ciWaitSuppresses, reconcileCiWaits } from './ci-waits.js';
import { explicitResume, linksResolved, resolveLinkWaits, structuredWait, waitStatus, STRUCTURED_WAIT_HELP } from './link-waits.js';
import { pickupState, defaultPickupProblem, idleReadyProblem, idleReadyAvailable } from './pickup.js';
import { prRepository } from './pr-labels.js';
import { availableSessionHref } from './session-links.js';
import { awaitingQueen } from './conversation.js';
import { OPEN_REVIEW_STATES } from './review-state.js';
import { safeDeliver } from './sessions.js';
import { isCurrent } from './lifetime.js';
import { HiveError, refuseSnapshot } from './ops.js';
import { liveClaimant, sleepingReason } from './tracking.js';
import { GROUP_KINDS, descendantIds } from './bead-model.js';
import { humanWaitText } from './human-wait.js';
import { observedWorkerActivityIndex, workerActivityIndex, workerLastActivity, saveWorkerActivity } from './worker-activity.js';

export const WATCHDOG_DEFAULTS = Object.freeze({ workerMinutes: 30, idleMinutes: 30, reviewMinutes: 60, messageMinutes: 30, queenResponseMinutes: 30, waitHours: 24, deferredDays: 7, untrackedMinutes: 30, waitGraceMinutes: 30, humanWaitMinutes: 10, pickupHeldMinutes: 5, idleReadyMinutes: 15 });
const DAY_MS = 86400000;
const stamp = value => typeof value === 'number' && Number.isFinite(value) ? value : typeof value === 'string' ? Date.parse(value) || 0 : 0;
export const watchdogSettings = cell => {
  const saved = cell?.watchdogSettings || {};
  return Object.fromEntries(Object.entries(WATCHDOG_DEFAULTS).map(([key, fallback]) => {
    const value = key === 'idleMinutes' && !Object.hasOwn(saved, key) ? saved.workerMinutes : saved[key];
    return [key, Number.isFinite(value) && value > 0 ? value : fallback];
  }));
};

const QUEEN_ASKED = [
  /\b(?:queen|coordinator)\s+(?:should|must|to|please|needs? to|can now)\s+(?:reconcile\/)?(?:close|reconcile|finish)\b/i,
  /\bplease\s+(?:close|reconcile)\b(?!\s+(?:the|a|an|any|out|off)\b)/i,
  /\b(?:ready|safe) to close\b/i,
];
const WORK_DONE = [
  /\b(?:work|implementation|task|bead|everything)\s+(?:is|are)\s+(?:now\s+)?(?:done|complete|completed|finished)\b/i,
  /\bacceptance(?:\s+criteria)?\s+(?:is\s+|are\s+)?(?:all\s+)?(?:met|satisfied)\b/i,
];
const HEDGED = /\b(?:not|never|until|once|after|except|yet|unless|whether|if|will|would|when|before)\b|n't/i;
const clauses = value => typeof value === 'string' ? value.split(/[.!?;\n]+/).filter(clause => clause && !HEDGED.test(clause)) : [];
const recordsCompletion = (bead, patterns) => {
  const latest = Array.isArray(bead.evidence) ? bead.evidence.at(-1) : null;
  return [bead.summary, bead.nextAction, latest?.label, latest?.detail].some(value => clauses(value).some(clause => patterns.some(pattern => pattern.test(clause))));
};
const ISO_TIME = /\b(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})(?![\w:.])/g;
const CLOCK_TIME = /(?<![\w:.-])([01]?\d|2[0-3]):([0-5]\d)\s?(?:Z|UTC)(?!\w)(?!\s+(?:on\s+)?(?:\d{1,2}\s+[A-Za-z]{3}|[A-Za-z]{3,9}\s+\d{1,2}\b|\d{4}-\d{2}-\d{2}))/g;
const DEADLINE_CUE = /\b(?:by|until|till|at|after|before|deadline|due|eta|retry|resets?|expected|around|check|recheck|review|wait(?:ing)?)\b[^.;,\n]{0,24}$/i;
const cued = (text, index) => DEADLINE_CUE.test(text.slice(Math.max(0, index - 40), index));
export function waitDeadline(text, anchor) {
  if (typeof text !== 'string' || !text) return 0;
  const times = [];
  for (const m of text.matchAll(ISO_TIME)) {
    const at = Date.parse(m[0].replace(' ', 'T'));
    if (Number.isFinite(at) && (!anchor || at > anchor) && cued(text, m.index)) times.push(at);
  }
  if (anchor) for (const m of text.replace(ISO_TIME, match => ' '.repeat(match.length)).matchAll(CLOCK_TIME)) {
    if (!cued(text, m.index)) continue;
    const day = new Date(anchor);
    let at = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), +m[1], +m[2]);
    if (at < anchor) at += DAY_MS;
    times.push(at);
  }
  return times.length ? Math.max(...times) : 0;
}
const plural = (n, unit) => `${n} ${unit}${n === 1 ? '' : 's'}`;

export function setWatchdogSettings(rt, { cellId, settings }) {
  const cell = rt.metadata.cell(cellId);
  if (!cell) throw new HiveError('Unknown hive.');
  refuseSnapshot(cell);
  if (!settings || typeof settings !== 'object' || Array.isArray(settings) || !Object.keys(settings).length
    || Object.entries(settings).some(([key, value]) => !Object.hasOwn(WATCHDOG_DEFAULTS, key) || !Number.isFinite(value) || value <= 0 || value > 525600)) {
    throw new HiveError('Work monitoring thresholds must be positive numbers up to 525600, using workerMinutes, idleMinutes, reviewMinutes, messageMinutes, queenResponseMinutes, waitHours, deferredDays, untrackedMinutes, waitGraceMinutes, humanWaitMinutes, pickupHeldMinutes and idleReadyMinutes.');
  }
  rt.metadata.mutate(d => { d.cells[cellId].watchdogSettings = { ...watchdogSettings(cell), ...settings }; });
  return { cellId, settings: watchdogSettings(rt.metadata.cell(cellId)) };
}

function watchdogIndex(rt, host = rt.host) {
  const doc = rt.metadata.read();
  const children = new Map(), reviews = new Map(), requesters = new Map(), asked = new Map();
  for (const bead of Object.values(rt.snapshots.graph.beads)) {
    if (!children.has(bead.parentId)) children.set(bead.parentId, []);
    children.get(bead.parentId).push(bead.id);
  }
  for (const review of Object.values(doc.reviews || {})) {
    if (!reviews.has(review.cellId)) reviews.set(review.cellId, []);
    reviews.get(review.cellId).push(review);
  }
  for (const request of Object.values(doc.requests || {})) if (request.state === 'open') {
    if (!requesters.has(request.cellId)) requesters.set(request.cellId, new Set());
    requesters.get(request.cellId).add(request.requesterSessionId);
    if (request.beadId) {
      if (!asked.has(request.cellId)) asked.set(request.cellId, new Set());
      asked.get(request.cellId).add(request.beadId);
    }
  }
  const blockers = new Map();
  for (const edge of rt.snapshots.graph.edges || []) {
    const prerequisite = rt.snapshots.graph.beads[edge.prerequisite];
    if (edge.blocking && prerequisite && prerequisite.status !== 'closed') blockers.set(edge.dependent, true);
  }
  const observedActivity = observedWorkerActivityIndex(rt, host);
  return { children, reviews, requesters, blockers, asked, observedActivity, activity: workerActivityIndex(rt, host, observedActivity) };
}

export function collectWatchdog(rt, host, cell, now = Date.now(), index = watchdogIndex(rt, host)) {
  if (!cell?.enabled || cell.snapshot) return [];
  const doc = rt.metadata.read();
  const beads = rt.snapshots.graph.beads;
  const ids = new Set();
  const pending = cell.rootBeadId && beads[cell.rootBeadId] ? [cell.rootBeadId] : [];
  while (pending.length) {
    const id = pending.pop();
    if (ids.has(id)) continue;
    ids.add(id);
    pending.push(...(index.children.get(id) || []));
  }
  const open = [...ids].map(id => beads[id]).filter(b => b.status !== 'closed');
  const settings = watchdogSettings(cell);
  const reviews = index.reviews.get(cell.id) || [];
  const histories = new Map();
  for (const review of reviews) {
    if (!histories.has(review.workBeadId)) histories.set(review.workBeadId, []);
    histories.get(review.workBeadId).push(review);
  }
  const flags = [];
  const add = (kind, subject, state, since, reason, fields) => {
    const id = JSON.stringify([kind, subject, state]);
    since = cell.watchdogFlags?.[id]?.since ?? since;
    flags.push({ id, kind, ...fields, ...(fields?.session_id ? { session_link: availableSessionHref(host, fields.session_id) } : {}), reason, since, age_ms: Math.max(0, now - since) });
  };
  for (const flag of ciWaitAttention(rt, cell, now)) {
    add(flag.kind, flag.bead_id, flag.wait_id, flag.since, flag.reason, { bead_id: flag.bead_id, session_id: flag.session_id, wait_id: flag.wait_id });
  }
  const migrations = Object.entries(cell.blockedMigrations || {}).filter(([, migration]) => !migration.notice).sort(([a], [b]) => a.localeCompare(b));
  if (migrations.length) {
    const ids = migrations.map(([id]) => id);
    add('blocked_status_migrated', cell.id, migrations.map(([id, migration]) => [id, migration.at]), Math.min(...migrations.map(([, migration]) => migration.at)),
      `Migrated blocked cells to open: ${ids.map(id => `${id} (${beads[id]?.title || id})`).join(', ')}. Links and waiting annotations were preserved. Waiting now comes from open blocks prerequisites.`, { migrated_bead_ids: ids });
  }
  const idleAvailable = open.some(bead => idleReadyCandidate(bead, cell)) && idleReadyAvailable(rt, host, cell);
  for (const bead of open) {
    if (isScheduleItem(bead)) continue;
    const idleProblem = idleReadyProblem(rt, host, cell, bead, rt.snapshots.graph, now, idleAvailable);
    const idleAnchor = cell.idleReadyAnchors?.[bead.id];
    if (idleProblem && idleAnchor && now - idleAnchor.at >= settings.idleReadyMinutes * 60000) {
      add('idle_ready_work', bead.id, idleAnchor.at, idleAnchor.at,
        `Ready work ${bead.title || bead.id} cannot start despite free capacity: ${idleProblem}.`, { bead_id: bead.id });
    }
    const pickupProblem = defaultPickupProblem(rt, host, cell, bead, rt.snapshots.graph, index.asked.get(cell.id) || new Set(), now);
    if (pickupProblem) add('pickup_unavailable', bead.id, pickupProblem, now, `Free work capacity cannot start scoped work: ${pickupProblem}`, { bead_id: bead.id });
    if (bead.pickup?.armed) {
      const state = pickupState(rt, host, cell, bead, rt.snapshots.graph, { now });
      const anchor = cell.pickupHoldAnchors?.[bead.id];
      if (state.state === 'queued' && state.reconciliation_reasons.length && anchor?.token === bead.pickup.armToken && now - anchor.at >= settings.pickupHeldMinutes * 60000) {
        add('pickup_held', bead.id, bead.pickup.armToken, anchor.at,
          `Automatic pickup is held: ${state.reasons.join('; ')}. Reconcile the holds or disarm the mark.`,
          { bead_id: bead.id, reasons: state.reasons, session_ids: state.blocking_session_ids });
      }
    }
    const updated = stamp(bead.updatedAt);
    if (waitStatus(bead.status) && !structuredWait(rt.snapshots.graph, bead) && !linksResolved(rt.snapshots.graph, bead.id)) {
      add('unstructured_wait', bead.id, bead.status, updated || now, `Legacy wait has no structured condition. ${STRUCTURED_WAIT_HELP}`, { bead_id: bead.id, session_id: bead.ownerSessionId || null });
    }
    const resolution = cell.linkWaits?.[bead.id]?.resolution;
    if (resolution && !resolution.notice && !waitStatus(bead.status) && !explicitResume(bead) && linksResolved(rt.snapshots.graph, bead.id)) {
      add('prerequisites_resolved', bead.id, resolution.id, resolution.at, 'All blocking prerequisites have closed; work is ready to continue.', { bead_id: bead.id, session_id: bead.ownerSessionId || null, resolution_id: resolution.id });
    }

    if ((index.blockers.get(bead.id) || bead.waitingFor) && updated && now - updated >= settings.waitHours * 3600000) {
      add('stale_wait', bead.id, [updated, bead.status, bead.waitingFor || ''], updated, 'Waiting work has not been touched.', { bead_id: bead.id, session_id: bead.ownerSessionId || null });
    }
    if (explicitResume(bead) || bead.status === 'deferred') {
      const resume = bead.resume || {};
      const reviewAt = stamp(resume.reviewAt);
      const prerequisite = resume.afterBead ? beads[resume.afterBead] : null;
      if (reviewAt && now >= reviewAt) {
        add('deferred_due', bead.id, ['review', reviewAt], reviewAt, `Waiting cell's review date has passed.`, { bead_id: bead.id, session_id: bead.ownerSessionId || null });
      } else if (resume.afterBead && (!prerequisite || prerequisite.status === 'closed')) {
        const since = prerequisite ? stamp(prerequisite.closedAt) || stamp(prerequisite.updatedAt) || now : now;
        add('deferred_due', bead.id, ['prerequisite', resume.afterBead], since, `Waiting cell's prerequisite ${resume.afterBead} has closed.`, { bead_id: bead.id, session_id: bead.ownerSessionId || null });
      } else if (!reviewAt && !resume.afterBead && updated && now - updated >= settings.deferredDays * DAY_MS) {
        add('deferred_due', bead.id, ['age', updated], updated, `Deferred cell has not been reviewed for ${plural(settings.deferredDays, 'day')}.`, { bead_id: bead.id, session_id: bead.ownerSessionId || null });
      }
    }
    const sid = bead.ownerSessionId;
    const session = sid && host?.sessions?.get?.(sid);
    const recorded = cell.waitAnchors?.[bead.id];
    const deadline = bead.waitingFor ? waitDeadline(bead.waitingFor, recorded?.text === bead.waitingFor ? recorded.at : updated) : 0;
    if (deadline && now - deadline >= settings.waitGraceMinutes * 60000) {
      add('overdue_wait', bead.id, [deadline, bead.waitingFor], deadline, `Recorded wait names a time that has passed: ${bead.waitingFor.slice(0, 120)}`, { bead_id: bead.id, session_id: sid || null });
    }
    const ciWait = doc.ciWaits?.[bead.id];
    const proseAnchor = recorded && recorded.text === bead.waitingFor ? recorded.at : updated;
    const proseGrace = bead.waitingFor && !(ciWait && !ciWait.acknowledgedAt) && proseAnchor && now - proseAnchor < settings.waitGraceMinutes * 60000;
    const waiting = Boolean(proseGrace || ciWaitSuppresses(rt, host, bead, now) || structuredWait(rt.snapshots.graph, bead));
    const claimed = liveClaimant(host, sid);
    const history = histories.get(bead.id) || [];
    const reviewOpen = history.some(r => OPEN_REVIEW_STATES.has(r.state));
    if (!claimed && !GROUP_KINDS.has(bead.kind) && updated) {
      const exitedClaim = session && ['exited', 'error', 'errored'].includes(session.status) && !session.archived;
      const finished = !waiting && !index.blockers.get(bead.id)
        && recordsCompletion(bead, sid ? [...QUEEN_ASKED, ...WORK_DONE] : QUEEN_ASKED);
      if (finished && !reviewOpen && now - updated >= settings.untrackedMinutes * 60000) {
        add('finished_open', bead.id, [updated, bead.status], updated, 'No worker holds this cell and its record says the work is finished or asks the queen to close it.', { bead_id: bead.id, session_id: sid || null });
      } else if (bead.status === 'in_progress' && !exitedClaim && !reviewOpen && now - updated >= settings.untrackedMinutes * 60000
        && !index.blockers.get(bead.id)) {
        add('untracked_work', bead.id, [updated, sid || ''], updated, 'In-progress work has no live claimant.', { bead_id: bead.id, session_id: sid || null });
      }
    }
    const humanWait = humanWaitText(bead);
    if (humanWait && updated && now - updated >= settings.humanWaitMinutes * 60000 && !index.asked.get(cell.id)?.has(bead.id)) {
      add('human_wait_unasked', bead.id, [updated, bead.status, humanWait], updated, `Cell waits on the human but no hive_request_input is open for it: ${humanWait}`, { bead_id: bead.id, session_id: bead.ownerSessionId || null });
    }
    if (!session) continue;
    const activity = workerLastActivity(session, bead, index.activity);
    const requestOpen = index.asked.get(cell.id)?.has(bead.id) || index.requesters.get(cell.id)?.has(sid);
    const handedOff = reviewOpen || requestOpen
      || recordsCompletion(bead, [...QUEEN_ASKED, ...WORK_DONE]);
    const turn = session.lastTurn;
    if (bead.status === 'in_progress' && !session.archived && !session.hasBackgroundShell && !handedOff
      && !waiting && !index.blockers.get(bead.id) && ['aborted', 'error'].includes(turn?.outcome)
      && Number.isFinite(turn.at) && turn.at > 0 && turn.at <= now
      && Math.max(updated, index.observedActivity.get(sid) || 0) <= turn.at) {
      const reason = turn.outcome === 'aborted' ? 'Claimed worker’s last turn was aborted.'
        : `Claimed worker’s last turn ended with an error${turn.errorKind ? ` (${turn.errorKind})` : ''}.`;
      add(turn.outcome === 'aborted' ? 'aborted_turn' : 'errored_turn', bead.id, [sid, turn.at, turn.errorKind || ''], turn.at,
        reason, { bead_id: bead.id, session_id: sid });
      continue;
    }
    if (['exited', 'error', 'errored'].includes(session.status)) {
      add('stalled_worker', bead.id, [sid, session.status], activity || now, `Claimed worker ${session.status}.`, { bead_id: bead.id, session_id: sid });
      continue;
    }
    if (bead.status === 'in_progress' && !session.archived && !handedOff && !waiting && !index.blockers.get(bead.id)
      && ['api-error', 'api-error-blocking'].includes(session.waitingReason) && session.status !== 'working') {
      add('stalled_worker', bead.id, [sid, 'api-error'], activity || now, 'Claimed worker ended its turn with an API error.', { bead_id: bead.id, session_id: sid });
      continue;
    }
    const sleeping = sleepingReason(session);
    if (sleeping && !GROUP_KINDS.has(bead.kind) && !reviewOpen && !(session.hasBackgroundShell)) {
      const since = activity;
      const sleepingWait = waiting || index.blockers.get(bead.id) || requestOpen;
      if (!sleepingWait && since && now - since >= settings.workerMinutes * 60000) {
        add('dormant_claim', bead.id, [sid, sleeping], since, `Claim is held by a ${sleeping} session with no recorded wait, request or review.`, { bead_id: bead.id, session_id: sid });
      }
      continue;
    }
    if (session.status !== 'idle' || session.hasBackgroundShell || session.archived || waiting || index.blockers.get(bead.id)) continue;
    if (handedOff) continue;
    const latest = history.toSorted((a, b) => stamp(b.createdAt) - stamp(a.createdAt)).at(0);
    const since = Math.max(activity, latest?.state === 'approved' ? stamp(latest.completedAt || latest.verdict?.at || latest.updatedAt) : 0);
    if (since && now - since >= settings.idleMinutes * 60000) {
      add('stalled_worker', bead.id, [sid, 'idle', since], since, 'Claimed worker is idle without a recorded handoff.', { bead_id: bead.id, session_id: sid });
    }
  }
  const labelRepos = new Set(Object.values(doc.prLabels || {}).filter(record => record?.status === 'pending' && (record.cellIds?.includes(cell.id) || record.associations?.some(row => row.cellId === cell.id))).map(record => prRepository(record.url)?.toLowerCase()).filter(Boolean));
  for (const repo of labelRepos) {
    const failure = doc.prLabelRepos?.[repo];
    if (failure) add('pr_label_configuration', repo, 'unavailable', failure.at,
      `Hive PR labelling is unavailable for ${repo}: ${failure.message}. Repository label attempts are paused until ${new Date(failure.retryAt).toISOString()}.`, {});
  }
  const linkedSessions = new Map();
  for (const binding of doc.bindings?.[cell.id] || []) {
    if (!binding.active || !ids.has(binding.beadId) || beads[binding.beadId]?.status !== 'closed') continue;
    const session = host?.sessions?.get?.(binding.sessionId);
    if (!session || session.archived) continue;
    if (!linkedSessions.has(binding.sessionId)) linkedSessions.set(binding.sessionId, new Set());
    linkedSessions.get(binding.sessionId).add(binding.beadId);
  }
  for (const [sid, closedIds] of linkedSessions) {
    for (const link of host.links?.get?.(sid) || []) {
      const observed = doc.prLabels?.[link.url];
      if (link.type !== 'pr' || !prRepository(link.url) || observed?.state !== 'OPEN' || observed.observationError) continue;
      for (const beadId of closedIds) {
        const bead = beads[beadId];
        const closedAt = stamp(bead.closedAt) || stamp(bead.updatedAt);
        if (!closedAt || stamp(observed.stateCheckedAt) <= closedAt) continue;
        add('closed_bead_pr', [sid, beadId, link.url], 'OPEN', stamp(bead.closedAt) || stamp(bead.updatedAt) || now,
          `Open PR ${link.url} is still linked to a session bound to closed bead ${beadId}. Relink it to its current owner or remove the stale session link.`,
          { bead_id: beadId, session_id: sid, pr_url: link.url });
      }
    }
  }
  for (const review of reviews) {
    const since = stamp(review.requestedAt) || ((review.round || 1) > 1 ? stamp(review.updatedAt) : 0) || stamp(review.createdAt);
    if (OPEN_REVIEW_STATES.has(review.state) && !review.verdict && ids.has(review.workBeadId) && beads[review.workBeadId]?.status !== 'closed' && since && now - since >= settings.reviewMinutes * 60000) {
      add('stuck_review', review.id, since, since, 'Requested review has no verdict.', { bead_id: review.workBeadId, session_id: review.reviewerSessionId || null, review_id: review.id });
    }
  }
  for (const message of doc.conversation[cell.id] || []) {
    const since = stamp(message.at);
    if (awaitingQueen(message) && since && now - since >= settings.messageMinutes * 60000) {
      add('unanswered_message', message.id, since, since, 'Human message is awaiting the queen’s answer.', { bead_id: message.beadId || null, session_id: cell.queenSessionId || null, message_id: message.id, thread_id: message.threadId || null });
    }
  }
  return flags;
}

function idleReadyCandidate(bead, cell) {
  return bead.id !== cell.rootBeadId && bead.status === 'open' && !bead.assignee
    && !GROUP_KINDS.has(bead.kind) && !isScheduleItem(bead) && !['decision', 'external', 'idea'].includes(bead.kind);
}

function syncIdleReadyAnchors(rt, host, now) {
  const graph = rt.snapshots.graph;
  const edits = [];
  for (const cell of rt.metadata.cells()) {
    const next = {};
    const ids = cell.enabled && !cell.snapshot && cell.rootBeadId && graph.beads[cell.rootBeadId] ? descendantIds(graph.beads, cell.rootBeadId) : new Set();
    const candidates = [...ids].filter(id => idleReadyCandidate(graph.beads[id], cell));
    const available = candidates.length > 0 && idleReadyAvailable(rt, host, cell, graph);
    for (const id of candidates) {
      if (!available || !idleReadyProblem(rt, host, cell, graph.beads[id], graph, now, available)) continue;
      next[id] = cell.idleReadyAnchors?.[id] || { at: now };
    }
    if (JSON.stringify(next) !== JSON.stringify(cell.idleReadyAnchors || {})) edits.push([cell.id, next]);
  }
  if (edits.length) rt.metadata.mutate(d => { for (const [id, anchors] of edits) d.cells[id].idleReadyAnchors = anchors; });
}

function syncPickupHoldAnchors(rt, host, now) {
  const beads = rt.snapshots.graph.beads;
  const edits = [];
  for (const cell of rt.metadata.cells()) {
    const next = {};
    const ids = cell.enabled && !cell.snapshot && cell.rootBeadId && beads[cell.rootBeadId] ? descendantIds(beads, cell.rootBeadId) : new Set();
    for (const id of ids) {
      const bead = beads[id];
      if (bead.status === 'closed' || !bead.pickup?.armed) continue;
      const state = pickupState(rt, host, cell, bead, rt.snapshots.graph, { now });
      if (state.state !== 'queued' || !state.reconciliation_reasons.length) continue;
      const prior = cell.pickupHoldAnchors?.[id];
      next[id] = prior?.token === bead.pickup.armToken ? prior : { token: bead.pickup.armToken, at: now };
    }
    if (JSON.stringify(next) !== JSON.stringify(cell.pickupHoldAnchors || {})) edits.push([cell.id, next]);
  }
  if (edits.length) rt.metadata.mutate(d => { for (const [id, anchors] of edits) d.cells[id].pickupHoldAnchors = anchors; });
}

export function syncWaitAnchors(rt) {
  const beads = rt.snapshots.graph.beads;
  const edits = [];
  for (const cell of rt.metadata.cells()) {
    const next = {};
    const ids = cell.enabled && !cell.snapshot && cell.rootBeadId && beads[cell.rootBeadId] ? descendantIds(beads, cell.rootBeadId) : new Set();
    for (const b of [...ids].map(id => beads[id])) if (b?.waitingFor && b.status !== 'closed') {
      const prev = cell.waitAnchors?.[b.id];
      next[b.id] = prev?.text === b.waitingFor ? prev : { text: b.waitingFor, at: stamp(b.updatedAt) };
    }
    const old = cell.waitAnchors || {};
    if (JSON.stringify(next) !== JSON.stringify(old)) edits.push([cell.id, next]);
  }
  if (edits.length) rt.metadata.mutate(d => { for (const [id, a] of edits) d.cells[id].waitAnchors = a; });
}

export function archiveSuggestions(rt, host, cell, now = Date.now()) {
  if (!cell?.enabled || cell.snapshot) return [];
  const beads = rt.snapshots.graph.beads;
  const doc = rt.metadata.read();
  const minutes = watchdogSettings(cell).untrackedMinutes * 60000;
  const last = new Map();
  for (const b of doc.bindings?.[cell.id] || []) {
    if (!b.beadId || !b.sessionId || b.sessionId === cell.queenSessionId) continue;
    if (!last.has(b.sessionId) || stamp(b.at) >= stamp(last.get(b.sessionId).at)) last.set(b.sessionId, b);
  }
  const holders = new Set(Object.values(beads).filter(b => b.status !== 'closed' && b.ownerSessionId).map(b => b.ownerSessionId));
  const reviewers = new Set(Object.values(doc.reviews || {}).filter(r => OPEN_REVIEW_STATES.has(r.state)).map(r => r.reviewerSessionId));
  const out = [];
  for (const [sid, binding] of last) {
    const session = host?.sessions?.get?.(sid);
    const bead = beads[binding.beadId];
    if (!session || session.archived || session.status !== 'idle' || session.hasBackgroundShell || !bead || bead.status !== 'closed') continue;
    if (holders.has(sid) || reviewers.has(sid) || session.waitingReason) continue;
    const since = Math.max(stamp(session.lastActivity), stamp(session.createdAt), stamp(session.relaunchedAt), stamp(bead.closedAt));
    if (since && now - since >= minutes) out.push({ session_id: sid, last_bead_id: bead.id, idle_ms: now - since });
  }
  return out;
}

const MAX_DIGESTS_PER_PASS = 10;
const DELIVERY_TIMEOUT_MS = 15000;

function digestText(items, archive = []) {
  const counts = new Map();
  for (const { flag } of items) counts.set(flag.kind, (counts.get(flag.kind) || 0) + 1);
  const shown = [...items.filter(({ flag }) => flag.kind === 'blocked_status_migrated'), ...items.filter(({ flag }) => flag.kind !== 'blocked_status_migrated').slice(0, 10)];
  return [
    `[Hive] Watchdog attention: ${items.length} newly flagged item(s). ${[...counts].map(([kind, count]) => `${kind}: ${count}`).join(', ')}.`,
    ...shown.map(({ cellId, flag }) => `- Cell ${cellId}: ${flag.reason} ${flag.bead_id ? `Bead ${flag.bead_id}. ` : ''}${flag.session_id ? `Session ${flag.session_id}${flag.session_link ? ` [Open session](${flag.session_link})` : ''}. ` : ''}${flag.message_id ? `Message ${flag.message_id}. ` : ''}Age ${Math.floor(flag.age_ms / 60000)} minutes.`),
    ...(archive.length ? [`Idle sessions whose last bead is closed; consider archiving: ${archive.slice(0, 10).map(a => `${a.session_id} (${a.last_bead_id})`).join(', ')}${archive.length > 10 ? ` and ${archive.length - 10} more` : ''}.`] : []),
    'Read hive_context attention.watchdog for the full list. Investigate and update the work or answer the message. Do not infer completion or restart a worker automatically.',
  ].join('\n');
}

export function createWatchdog({ runtime: rt, host, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let running = null, stopped = false, queued = false;
  const active = () => !stopped && isCurrent(rt, host) && rt.host === host && !rt.metadata.error;
  const usable = () => active() && rt.beads.status.state === 'ready' && rt.snapshots.current.loadedAt && !rt.snapshots.current.error && rt.snapshots.hierarchyCurrent !== false;
  async function boundedDeliver(queen, body) {
    let timer;
    try {
      return await Promise.race([
        safeDeliver(host, queen, body, rt),
        new Promise(resolve => { timer = setTimer(() => resolve({ state: 'uncertain', error: 'Queen delivery timed out; it may still arrive.' }), DELIVERY_TIMEOUT_MS); timer?.unref?.(); }),
      ]);
    } finally { clearTimer(timer); }
  }
  async function pass() {
    if (!usable()) return;
    await reconcileCiWaits(rt, host, now());
    if (!usable()) return;
    await resolveLinkWaits(rt, host, now());
    if (!usable()) return;
    const index = watchdogIndex(rt, host);
    saveWorkerActivity(rt, host, index.activity);
    syncWaitAnchors(rt);
    syncIdleReadyAnchors(rt, host, now());
    syncPickupHoldAnchors(rt, host, now());
    const changes = new Map(), groups = new Map();
    for (const cell of rt.metadata.cells()) {
      const flags = collectWatchdog(rt, host, cell, now(), index);
      const previous = cell.watchdogFlags || {};
      const next = Object.fromEntries(flags.map(flag => [flag.id, previous[flag.id] || { ...flag, episodeAt: now(), noticed: {} }]));
      if (Object.keys(previous).some(id => !next[id]) || flags.some(flag => !previous[flag.id])) changes.set(cell.id, next);
      const queen = cell.queenSessionId;
      const key = `${queen}:${cell.queenGeneration || 0}`;
      for (const flag of flags) if (!next[flag.id].noticed?.[key] && queen) {
        if (!groups.has(queen)) groups.set(queen, []);
        groups.get(queen).push({ cellId: cell.id, key, flag });
      }
    }
    if (changes.size) {
      rt.metadata.mutate(d => { for (const [cellId, flags] of changes) d.cells[cellId].watchdogFlags = flags; });
      rt.changed();
    }
    let attempts = 0;
    for (const [queen, candidates] of groups) {
      if (!usable() || attempts >= MAX_DIGESTS_PER_PASS) return;
      const recipient = host.sessions?.get?.(queen);
      if (!recipient || recipient.archived || typeof host.deliver !== 'function') continue;
      const currentFlags = new Map();
      const currentIndex = watchdogIndex(rt, host);
      for (const { cellId } of candidates) if (!currentFlags.has(cellId)) {
        const cell = rt.metadata.cell(cellId);
        currentFlags.set(cellId, new Set(collectWatchdog(rt, host, cell, now(), currentIndex).map(flag => flag.id)));
      }
      const items = candidates.filter(({ cellId, key, flag }) => {
        const cell = rt.metadata.cell(cellId);
        return cell?.enabled && !cell.snapshot && cell.queenSessionId === queen && key === `${queen}:${cell.queenGeneration || 0}`
          && currentFlags.get(cellId).has(flag.id) && !cell.watchdogFlags?.[flag.id]?.noticed?.[key];
      });
      if (!items.length) continue;
      const at = now();
      const archive = [];
      for (const cellId of new Set(items.map(i => i.cellId))) {
        const cell = rt.metadata.cell(cellId);
        const key = items.find(i => i.cellId === cellId).key;
        for (const s of archiveSuggestions(rt, host, cell, at)) if (cell.archiveSuggested?.[s.session_id] !== key) archive.push({ ...s, cellId, key });
      }
      rt.metadata.mutate(d => {
        for (const cellId of new Set(items.map(i => i.cellId))) {
          const current = new Set(archiveSuggestions(rt, host, rt.metadata.cell(cellId), at).map(x => x.session_id));
          const kept = d.cells[cellId].archiveSuggested;
          if (kept) for (const sid of Object.keys(kept)) if (!current.has(sid)) delete kept[sid];
        }
        for (const { cellId, key, flag } of items) {
          d.cells[cellId].watchdogFlags[flag.id].noticed[key] = { state: 'sending', at };
          if (flag.kind === 'blocked_status_migrated') for (const id of flag.migrated_bead_ids) d.cells[cellId].blockedMigrations[id].notice = { state: 'sending', at };
          const event = d.cells[cellId].linkWaits?.[flag.bead_id]?.resolution;
          if (flag.kind === 'prerequisites_resolved' && event?.id === flag.resolution_id) event.notice = { state: 'sending', at };
        }
        for (const { cellId, key, session_id } of archive) (d.cells[cellId].archiveSuggested ||= {})[session_id] = key;
      });
      attempts++;
      const result = await boundedDeliver(queen, digestText(items, archive));
      if (!active()) return;
      rt.metadata.mutate(d => {
        for (const { cellId, key, flag } of items) {
          if (flag.kind === 'blocked_status_migrated') {
            for (const id of flag.migrated_bead_ids) Object.assign(d.cells[cellId].blockedMigrations[id].notice, result);
            delete d.cells[cellId].watchdogFlags[flag.id];
          }
          const receipt = d.cells[cellId]?.watchdogFlags?.[flag.id]?.noticed?.[key];
          if (receipt?.at === at) Object.assign(receipt, result);
          const event = d.cells[cellId]?.linkWaits?.[flag.bead_id]?.resolution;
          if (flag.kind === 'prerequisites_resolved' && event?.id === flag.resolution_id) {
            if (event.notice?.at === at) Object.assign(event.notice, result);
            delete d.cells[cellId].watchdogFlags[flag.id];
          }
        }
      });
      rt.changed();
    }
  }
  function run() {
    if (!active()) return Promise.resolve();
    if (!running) running = pass().catch(err => rt.log(`hive: watchdog failed: ${err.message}`)).finally(() => { running = null; });
    return running;
  }
  return {
    run,
    schedule() {
      if (queued || running || !active()) return;
      queued = true;
      queueMicrotask(() => { queued = false; void run(); });
    },
    stop() { stopped = true; },
  };
}
