import { setPickup } from './pickup.js';
import { setWatchdogSettings } from './watchdog.js';
import { setReviewPolicy } from './review-policy.js';
import { humanAnswer, dismissRequest, retryDelivery } from './requests.js';
import { readAttachment, attachmentThumbnail } from './attachments.js';
import { beadDetail, searchBeads } from './bead-detail.js';
import { searchInbox } from './inbox-search.js';
import * as ops from './ops.js';
import { checkRetire, retireCell, reopenCell } from './retire.js';
import { launchQueen, reconcileLaunch, sendActivationBrief } from './sessions.js';
import { checkWorkstream, completeWorkstream, archiveWorkstream, showWorkstream, reopenWorkstream, dismissRestoreNotice } from './workstreams.js';
import { recordHumanInput, recordHumanReaction, deliver, markReceived, renameThread, resolveDeepLink, threadHistory, threadList, topicRelations, inboxPage, acknowledgeMessage, autoReadMessages, undoAcknowledge, withdrawMessage, undoWithdraw, humanConversationDoc } from './conversation.js';

export class HumanError extends Error {}

function runtimeOf(host) {
  const rt = host?.stores?.hive;
  if (!rt) throw new HumanError('Hive is not active.');
  return rt;
}

const READ_ONLY = new Set(['hive-image', 'hive-thread-relations', 'hive-bead-detail', 'hive-bead-search', 'hive-inbox-search']);

export function humanHandler(type, run) {
  return {
    type,
    async handler(msg = {}, host, reply) {
      const base = { op: type, requestId: typeof msg.requestId === 'string' ? msg.requestId.slice(0, 80) : null };
      try {
        const rt = runtimeOf(host);
        const out = await run({ msg, host, rt });
        if (!READ_ONLY.has(type)) { rt.changed(); rt.pickup?.schedule(); }
        reply?.({ ...base, ok: true, ...(out || {}) });
      } catch (err) {
        const known = err instanceof HumanError || typeof err?.code === 'string';
        if (type !== 'hive-thread-relations' && type !== 'hive-bead-detail' && type !== 'hive-bead-search' && type !== 'hive-inbox-search') host?.stores?.hive?.changed?.();
        reply?.({ ...base, ok: false, error: known ? err.message : 'Hive could not complete that action.', code: err?.code || null });
        if (!known) host?.stores?.hive?.log?.(`hive: ${type} failed: ${err?.stack || err}`);
      }
    },
  };
}

const recheck = humanHandler('hive-setup-recheck', async ({ rt }) => {
  await rt.recheck();
  return { backend: rt.beads.status };
});

const initialize = humanHandler('hive-setup-init', async ({ rt }) => {
  const out = await rt.initializeStore();
  return { initialized: out.initialized, backend: rt.beads.status };
});

export const setupHandlers = [recheck, initialize];

function str(v, max = 200) {
  return typeof v === 'string' ? v.slice(0, max) : undefined;
}

// Every cell gets a queen. The steps stay separate and journaled: task, cell
// goal, then the queen launch. A failed or uncertain launch leaves the task and
// cell in place for a launch from the cell; nothing is ever created twice.
const createCell = humanHandler('hive-cell-create', async ({ msg, host, rt }) => {
  if (!msg.queen || typeof msg.queen !== 'object') throw new HumanError('A new cell needs its queen: give the launch settings.');
  const queen = pickLaunch(msg.queen);
  const out = await ops.createCell(rt, host, { name: msg.name, goal: msg.goal, acceptance: msg.acceptance, instructions: instructionsOf(msg), position: msg.position });
  if (out.rootError) {
    out.launchError = 'The queen was not launched because the cell goal was not created. Reconcile the goal, then launch the queen from the cell.';
  } else {
    try {
      out.launch = await launchQueen(rt, host, { cellId: out.cellId, ...queen });
    } catch (err) {
      out.launchError = err.message;
    }
  }
  return out;
});

// `intent` is the older one-off launch note; it is still passed to that launch
// only. Saved queen instructions travel separately as `instructions`.
function pickLaunch(q = {}) {
  return { cwd: str(q.cwd, 4096), agent: str(q.agent, 40), model: str(q.model, 120), effort: str(q.effort, 40), autoCompactTokens: compactTokens(q.autoCompactTokens), intent: str(q.intent, 20000) };
}

// Unset or empty is the agent's default. Anything else must be a whole number
// of tokens; Agent Wrangler checks it against the agent's own range at launch.
function compactTokens(v) {
  if (v === undefined || v === null || v === '') return undefined;
  if (!Number.isInteger(v) || v <= 0) throw new HumanError('Auto-compaction threshold must be a whole number of tokens.');
  return v;
}

// Passed through whole, so ops validates the full text (type and length) and
// an absent field stays distinct from an explicit empty one.
function instructionsOf(msg) {
  return msg.instructions !== undefined ? msg.instructions : msg.queen?.instructions;
}

const adoptTask = humanHandler('hive-cell-adopt', async ({ msg, host, rt }) => {
  const launching = msg.queen && typeof msg.queen === 'object';
  if (!msg.queenSessionId && !launching) throw new HumanError('Choose the cell\'s queen: nominate a session on the task, or launch a new one.');
  const queen = msg.queenSessionId ? null : pickLaunch(msg.queen);
  const out = await ops.adoptTask(rt, host, { taskId: str(msg.taskId, 80), goal: msg.goal, acceptance: msg.acceptance, instructions: instructionsOf(msg), rootBeadId: str(msg.rootBeadId, 80), position: msg.position });
  if (out.rootError) {
    out.launchError = 'The queen was not set up because the cell goal was not created. Reconcile the goal, then nominate or launch the queen from the cell.';
  } else if (msg.queenSessionId) {
    out.queen = ops.nominateQueen(rt, host, { cellId: out.cellId, sessionId: str(msg.queenSessionId, 128) });
    if (msg.sendBrief) out.brief = await sendActivationBrief(rt, host, { cellId: out.cellId });
  } else {
    try {
      out.launch = await launchQueen(rt, host, { cellId: out.cellId, ...queen });
    } catch (err) {
      out.launchError = err.message;
    }
  }
  return out;
});

const retryRoot = humanHandler('hive-cell-root-retry', async ({ msg, host, rt }) => {
  const out = await ops.retryCellRoot(rt, host, { cellId: str(msg.cellId, 80) });
  return { rootBeadId: out.rootBeadId };
});

const enableCell = humanHandler('hive-cell-enable', ({ msg, rt }) => ops.setCellEnabled(rt, { cellId: str(msg.cellId, 80), enabled: true }));
const disableCell = humanHandler('hive-cell-disable', ({ msg, rt }) => ops.setCellEnabled(rt, { cellId: str(msg.cellId, 80), enabled: false }));
const retireCheck = humanHandler('hive-cell-retire-check', ({ msg, host, rt }) => checkRetire(rt, host, { cellId: str(msg.cellId, 80) }));
const retire = humanHandler('hive-cell-retire', ({ msg, host, rt }) => retireCell(rt, host, {
  cellId: str(msg.cellId, 80), outcome: str(msg.outcome, 20), summary: msg.summary, override: msg.override === true, archiveSessions: msg.archiveSessions === true, sessionIds: Array.isArray(msg.sessionIds) ? msg.sessionIds.slice(0, 100).map((i) => str(i, 128)) : null,
}));
const reopen = humanHandler('hive-cell-reopen', ({ msg, rt }) => reopenCell(rt, { cellId: str(msg.cellId, 80), reason: msg.reason }));
const moveCell = humanHandler('hive-cell-move', ({ msg, rt }) => ops.moveCell(rt, { cellId: str(msg.cellId, 80), position: msg.position }));
const moveBeads = humanHandler('hive-bead-move', ({ msg, rt }) => ops.moveBeads(rt, { cellId: str(msg.cellId, 80), positions: msg.positions, aspect: msg.aspect, base: msg.base, stack: msg.stack }));

const nominate = humanHandler('hive-queen-nominate', async ({ msg, host, rt }) => {
  if (msg.instructions !== undefined) ops.setQueenInstructions(rt, { cellId: str(msg.cellId, 80), instructions: msg.instructions });
  const out = ops.nominateQueen(rt, host, { cellId: str(msg.cellId, 80), sessionId: str(msg.sessionId, 128) });
  if (msg.sendBrief) out.brief = await sendActivationBrief(rt, host, { cellId: out.cellId });
  return out;
});

const brief = humanHandler('hive-queen-brief', async ({ msg, host, rt }) => ({ brief: await sendActivationBrief(rt, host, { cellId: str(msg.cellId, 80) }) }));

const launch = humanHandler('hive-queen-launch', ({ msg, host, rt }) => launchQueen(rt, host, { cellId: str(msg.cellId, 80), ...pickLaunch(msg), instructions: msg.instructions }));

const watchdogSettings = humanHandler('hive-watchdog-settings', ({ msg, rt }) => setWatchdogSettings(rt, { cellId: str(msg.cellId, 80), settings: msg.settings }));

const reviewPolicyH = humanHandler('hive-review-policy', ({ msg, rt }) => setReviewPolicy(rt, { cellId: str(msg.cellId, 80), policy: msg.policy }));

const setInstructions = humanHandler('hive-cell-instructions', ({ msg, rt }) => ops.setQueenInstructions(rt, { cellId: str(msg.cellId, 80), instructions: msg.instructions }));

const reconcileLaunchH = humanHandler('hive-launch-reconcile', ({ msg, host, rt }) => reconcileLaunch(rt, host, { launchId: str(msg.launchId, 80), dismiss: msg.dismiss === true, abandon: msg.abandon === true }));

const reconcileOp = humanHandler('hive-op-reconcile', ({ msg, rt }) => ops.reconcileOperation(rt, { opId: str(msg.opId, 80) }));
const resolveOp = humanHandler('hive-op-resolve', ({ msg, rt }) => ops.resolveOperation(rt, { opId: str(msg.opId, 80), note: str(msg.note, 500) }, 'aw:human'));

const releaseBead = humanHandler('hive-bead-release', async ({ msg, rt }) => {
  const out = await ops.humanRelease(rt, { beadId: str(msg.beadId, 80), reason: msg.reason });
  return { opId: out.opId };
});

// Saved first, then delivered: a failed or uncertain delivery leaves a stored,
// visible message rather than input that vanished.
const sendMessage = humanHandler('hive-send', async ({ msg, host, rt }) => {
  const cellId = str(msg.cellId, 80);
  const fresh = msg.newThread && typeof msg.newThread === 'object' ? { title: str(msg.newThread.title, 2000), beadId: str(msg.newThread.beadId, 80) } : null;
  const saved = await recordHumanInput(rt, { cellId, text: msg.text, beadId: str(msg.beadId, 80), replyTo: str(msg.replyTo, 80), threadId: str(msg.threadId, 80), newThread: fresh, images: msg.images, ackRev: Number.isInteger(msg.ackRev) ? msg.ackRev : null, readThrough: str(msg.readThrough, 80) });
  rt.changed();
  const delivery = await deliver(rt, host, { cellId, messageId: saved.id }).catch((err) => ({ state: 'failed', error: err.message }));
  return { messageId: saved.id, threadId: saved.threadId, ackSettled: saved.ackSettled, markedRead: saved.markedRead, delivery };
});

const renameTopic = humanHandler('hive-thread-rename', ({ msg, rt }) => renameThread(rt, { cellId: str(msg.cellId, 80), threadId: str(msg.threadId, 80), title: str(msg.title, 2000) }));

const topicList = humanHandler('hive-thread-list', ({ msg, rt }) => threadList(rt, {
  cellId: str(msg.cellId, 80),
  after: msg.after && typeof msg.after === 'object' ? { id: str(msg.after.id, 80), lastAt: Number.isFinite(msg.after.lastAt) ? msg.after.lastAt : 0 } : null,
  limit: Number.isInteger(msg.limit) ? msg.limit : undefined,
}));

const detail = humanHandler('hive-bead-detail', ({ msg, rt }) => beadDetail(rt, { beadId: str(msg.beadId, 80) }));

const search = humanHandler('hive-bead-search', ({ msg, rt }) => searchBeads(rt, { cellId: str(msg.cellId, 80), query: str(msg.query, 200) }));

const inboxSearch = humanHandler('hive-inbox-search', ({ msg, rt }) => searchInbox(rt, { cellIds: msg.cellIds, query: str(msg.query, 200) }));

const deepLink = humanHandler('hive-deep-link', ({ msg, rt }) => resolveDeepLink(rt, {
  cellId: str(msg.cellId, 80), threadId: str(msg.threadId, 80), messageId: str(msg.messageId, 80), restore: msg.restore === true,
}));

const relations = humanHandler('hive-thread-relations', ({ msg, rt }) => topicRelations(rt, {
  cellId: str(msg.cellId, 80), threadId: str(msg.threadId, 80),
}));

const topicHistory = humanHandler('hive-thread-history', ({ msg, rt }) => threadHistory(rt, {
  cellId: str(msg.cellId, 80),
  threadId: str(msg.threadId, 80),
  before: str(msg.before, 80),
  limit: Number.isInteger(msg.limit) ? msg.limit : undefined,
}));

const inbox = humanHandler('hive-inbox', ({ msg, rt }) => inboxPage(rt, {
  cellId: str(msg.cellId, 80),
  awaiting: str(msg.awaiting, 10),
  after: msg.after && typeof msg.after === 'object' ? { id: str(msg.after.id, 80), at: Number.isFinite(msg.after.at) ? msg.after.at : 0 } : null,
  limit: Number.isInteger(msg.limit) ? msg.limit : undefined,
}));

// The human is the only one who acknowledges a queen message; who did it is
// fixed here, never taken from the request.
const ack = humanHandler('hive-ack', async ({ msg, host, rt }) => {
  const args = {
    cellId: str(msg.cellId, 80), messageId: str(msg.messageId, 80),
    kind: str(msg.kind, 20), emoji: str(msg.emoji, 16),
    rev: Number.isInteger(msg.rev) ? msg.rev : null,
  };
  if (!msg.reaction) return acknowledgeMessage(rt, args);
  if (args.kind !== 'reaction') throw new HumanError('Choose Yes or No.');
  const saved = await recordHumanReaction(rt, { ...args, reaction: str(msg.reaction, 20) });
  if (!saved.created) return saved;
  rt.changed();
  const delivery = await deliver(rt, host, { cellId: args.cellId, messageId: saved.reactionMessageId }).catch(err => ({ state: 'failed', error: err.message }));
  return { ...saved, delivery };
});

const ackUndo = humanHandler('hive-ack-undo', ({ msg, rt }) => undoAcknowledge(rt, {
  cellId: str(msg.cellId, 80),
  messageId: str(msg.messageId, 80),
  rev: Number.isInteger(msg.rev) ? msg.rev : null,
}));

const withdraw = humanHandler('hive-withdraw', ({ msg, rt }) => withdrawMessage(rt, { cellId: str(msg.cellId, 80), messageId: str(msg.messageId, 80) }));

const withdrawUndo = humanHandler('hive-withdraw-undo', ({ msg, rt }) => undoWithdraw(rt, { cellId: str(msg.cellId, 80), messageId: str(msg.messageId, 80) }));

const autoRead = humanHandler('hive-auto-read', ({ msg, rt }) => autoReadMessages(rt, { cellId: str(msg.cellId, 80), messages: msg.messages }));

const resend = humanHandler('hive-deliver', async ({ msg, host, rt }) => ({
  delivery: await deliver(rt, host, { cellId: str(msg.cellId, 80), messageId: str(msg.messageId, 80), force: msg.force === true }),
}));

const received = humanHandler('hive-mark-received', ({ msg, rt }) => markReceived(rt, { cellId: str(msg.cellId, 80), messageId: str(msg.messageId, 80) }));

const image = humanHandler('hive-image', async ({ msg, rt }) => {
  const cell = rt.metadata.cell(msg.cellId);
  if (!cell || cell.snapshot) throw new HumanError('Unknown hive image.');
  const visible = () => !rt.metadata.error && (humanConversationDoc(rt.metadata.read(), cell.id).conversation[cell.id] || []).some(m => m.id === msg.messageId && m.attachments?.some(a => a.file === msg.file));
  if (!visible()) return { missing: true };
  const got = msg.full === true
    ? await readAttachment(rt, cell.id, msg.messageId, msg.file)
    : await attachmentThumbnail(rt, cell.id, msg.messageId, msg.file);
  const current = rt.metadata.cell(cell.id);
  const kept = current && !current.snapshot && visible();
  return kept && got ? { mime: got.mime, dataBase64: got.bytes.toString('base64') } : { missing: true };
});

const wsArgs = (msg) => ({ cellId: str(msg.cellId, 80), headId: str(msg.headId, 80) });
const wsCheck = humanHandler('hive-ws-check', ({ msg, rt }) => checkWorkstream(rt, wsArgs(msg)));
const wsComplete = humanHandler('hive-ws-complete', ({ msg, rt }) => completeWorkstream(rt, {
  ...wsArgs(msg), outcome: str(msg.outcome, 20), summary: msg.summary, evidence: msg.evidence, archive: msg.archive === true,
}));
const wsArchive = humanHandler('hive-ws-archive', ({ msg, rt }) => archiveWorkstream(rt, wsArgs(msg)));
const wsShow = humanHandler('hive-ws-show', ({ msg, rt }) => showWorkstream(rt, wsArgs(msg)));
const wsNoticeDismiss = humanHandler('hive-restore-notice-dismiss', ({ msg, rt }) => dismissRestoreNotice(rt, { cellId: str(msg.cellId, 80), noticeId: str(msg.noticeId, 120) }));
const wsReopen = humanHandler('hive-ws-reopen', ({ msg, rt }) => reopenWorkstream(rt, {
  ...wsArgs(msg), reason: msg.reason, confirmAncestors: Array.isArray(msg.confirmAncestors) ? msg.confirmAncestors.slice(0, 50).map((a) => str(a, 80)) : null,
}));

const requestAnswer = humanHandler('hive-request-answer', async ({ rt, host, msg }) => ({ request: await humanAnswer(rt, host, msg) }));
const requestDismiss = humanHandler('hive-request-dismiss', async ({ rt, host, msg }) => ({ request: await dismissRequest(rt, host, msg) }));
const requestRetry = humanHandler('hive-request-retry', async ({ rt, host, msg }) => ({ request: await retryDelivery(rt, host, msg) }));

const pickupH = humanHandler('hive-bead-pickup', async ({ msg, host, rt }) => {
  const cell = rt.metadata.cell(msg.cellId);
  if (!cell || !cell.enabled || cell.snapshot) throw new HumanError('Choose an enabled hive.');
  const actor = { sessionId: null, role: 'human', cell, cells: [{ cell, role: 'human' }] };
  return setPickup(rt, host, actor, { bead_id: msg.beadId, ready: msg.ready, profile: msg.profile, rearm: msg.rearm, reason: msg.reason, expected_token: msg.expectedToken });
});

export const configHandlers = [pickupH,requestAnswer, requestDismiss, requestRetry, detail, search, inboxSearch, deepLink, image, sendMessage, resend, received, inbox, ack, ackUndo, withdraw, withdrawUndo, autoRead, renameTopic, relations, topicHistory, topicList, createCell, adoptTask, retryRoot, enableCell, disableCell, retireCheck, retire, reopen, moveCell, moveBeads, nominate, brief, launch, setInstructions, watchdogSettings, reviewPolicyH, reconcileLaunchH, reconcileOp, resolveOp, releaseBead, wsCheck, wsComplete, wsArchive, wsShow, wsReopen, wsNoticeDismiss];
