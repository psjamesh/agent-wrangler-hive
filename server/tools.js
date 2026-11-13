import { collectWatchdog, watchdogSettings, archiveSuggestions } from './watchdog.js';
import { reviewPolicy } from './review-policy.js';
import { attachmentsFor, deriveActivity } from './bead-sessions.js';
import { optionsSchema } from './request-options.js';
import * as requests from './requests.js';
import { reportPrWait, waitingProjection } from './waiting.js';
import { z } from 'zod';
import { capacity, RESERVED_LAUNCH_STATES } from './admission.js';
import { isUntracked, sleepingReason } from './tracking.js';
import { OPEN_REVIEW_STATES, reviewFields } from './review-state.js';
import { spawnWorker, reconcileWorkerLaunch } from './workers.js';
import { requestReview, reviewVerdict, cancelReview } from './reviews.js';
import { resolveCaller, participation } from './access.js';
import * as ops from './ops.js';
import { sessionSummary } from './sessions.js';
import { descendantIds, openDescendants, LINK_TYPES, OUTCOMES, SETTABLE_STATUSES } from './bead-model.js';
import { cellContextConversation, publish, acknowledgeInput, updateThread } from './conversation.js';

const KNOWN_CODES = new Set(['access', 'invalid', 'conflict', 'refused', 'uncertain', 'partial', 'failed', 'busy', 'setup-required', 'metadata-unavailable']);

function result(structuredContent) {
  return { content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }], structuredContent };
}

function error(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}

const cellIdArg = z.string().min(1).max(80).optional().describe('Hive cell id. Optional when you take part in exactly one enabled cell.');
const beadId = z.string().min(1).max(80);

function withHostJsonSchema(schema) {
  let building = false;
  schema._zod.toJSONSchema = () => {
    if (building) return undefined;
    building = true;
    try {
      const { $schema, ...json } = z.toJSONSchema(schema, { io: 'input', reused: 'inline', unrepresentable: 'any' });
      return json;
    } finally {
      building = false;
    }
  };
  return schema;
}

function strictObject(shape) {
  return withHostJsonSchema(z.object(shape, {
    error(issue) {
      if (issue.code !== 'unrecognized_keys') return undefined;
      const aliases = { parent_id: ['parent'], parent_key: ['parent'], key: ['ref'], description: ['summary', 'goal'] };
      return issue.keys.map((key) => {
        const suggestion = (Object.hasOwn(aliases, key) ? aliases[key] : []).filter((field) => Object.hasOwn(shape, field)).join(' or ');
        return `Unknown field "${key}"${suggestion ? `; use ${suggestion}` : ''}`;
      }).join('. ');
    },
  }).strict());
}

export function hiveTool(spec, run) {
  const inputSchema = strictObject({ cell_id: cellIdArg, ...spec.inputSchema });
  return {
    ...spec,
    inputSchema,
    async handler({ host, caller }, args = {}) {
      const parsed = inputSchema.safeParse(args);
      if (!parsed.success) return error(`Hive: invalid input: ${parsed.error.message}`);
      args = parsed.data;
      const rt = host?.stores?.hive;
      if (!rt) return error('Hive is not active.');
      try {
        const actor = resolveCaller(rt, host, caller, args.cell_id);
        const out = await run({ rt, host, actor, args });
        return result(out);
      } catch (err) {
        if (err && KNOWN_CODES.has(err.code)) return error(`${err.code === 'access' ? 'Not permitted' : 'Hive'}: ${err.message}`);
        rt.log(`hive: tool ${spec.name} failed: ${err?.stack || err}`);
        return error('Hive hit an internal error; nothing is known to have changed. Tell the human rather than retrying repeatedly.');
      }
    },
  };
}

function compactBead(rt, b, { full, cell }) {
  b = { ...b, ...reviewFields(rt, b.id) };
  const out = {
    ...reviewFields(rt, b.id),
    waiting_for_review: OPEN_REVIEW_STATES.has(b.reviewState),
    bead_id: b.id,
    parent_id: b.parentId,
    title: b.title,
    kind: b.kind,
    status: b.status,
    untracked: isUntracked(rt.host, rt.snapshots.graph, b),
    owner_session_id: b.ownerSessionId,
    assignee: b.assignee,
    next_action: b.nextAction || undefined,
    waiting_for: b.waitingFor || undefined,
    resume: b.resume || undefined,
    waiting_on: ops.waitingOn(rt, b.id),
    outcome: b.outcome || undefined,
    evidence_count: b.evidence.length,
    updated_at: b.updatedAt,
  };
  if (full) {
    out.goal = b.goal || undefined;
    out.acceptance = b.acceptance || undefined;
    out.summary = b.summary || undefined;
    out.evidence = b.evidence.slice(-10);
    out.attached_sessions = attachmentsFor(rt, rt.host, b.id);
    out.activity = deriveActivity(rt, rt.host, cell, b).state || undefined;
  }
  const below = b.status === 'closed' ? [] : openDescendants(rt.snapshots.graph.beads, b.id);
  if (below.length) out.open_descendants = below.length;
  if (!out.waiting_on.length) delete out.waiting_on;
  return out;
}

export async function buildContext(rt, host, actor, { include_closed = false, bead_id } = {}) {
  await rt.snapshots.refresh();
  return cellContextConversation(rt, host, actor, {}, (conversation, actor) => {
    const cell = actor.cell;
    const { beads, edges } = rt.snapshots.graph;
    const task = host.tasks.get(cell.taskId);
    const ids = cell.rootBeadId && beads[cell.rootBeadId] ? descendantIds(beads, cell.rootBeadId) : new Set();
    const all = [...ids].map((id) => beads[id]).filter(Boolean);
    const open = all.filter((b) => b.status !== 'closed');
    const closed = all.filter((b) => b.status === 'closed').sort((a, b) => String(b.closedAt).localeCompare(String(a.closedAt)));
    const doc = rt.metadata.read();
    const bindings = (doc.bindings[cell.id] || []).filter((b) => b.active);
    const sessionIds = new Set([cell.queenSessionId, ...open.map((b) => b.ownerSessionId), ...bindings.map((b) => b.sessionId)].filter(Boolean));
    for (const s of host.sessions.forTask(cell.taskId)) sessionIds.add(s.sessionId);
    const sessions = [...sessionIds].slice(0, 60).map((sid) => ({
      ...sessionSummary(host, sid),
      role: sid === cell.queenSessionId ? 'queen' : bindings.find((b) => b.sessionId === sid)?.role || (host.sessions.get(sid)?.taskId === cell.taskId ? 'task member' : 'bound'),
      bound_beads: bindings.filter((b) => b.sessionId === sid && b.beadId).map((b) => b.beadId),
      claims: open.filter((b) => b.ownerSessionId === sid).map((b) => b.id),
    }));
    const stale = [...new Set(open.map((b) => b.ownerSessionId).filter(Boolean))].map((sid) => ({ ...sessionSummary(host, sid), claims: open.filter((b) => b.ownerSessionId === sid).map((b) => b.id) })).filter((s) => !s.known || s.archived || s.status === 'exited' || sleepingReason(s));
    const ops_ = Object.values(doc.operations)
      .filter((op) => op.cellId === cell.id && ops.needsSettling(op))
      .map((op) => ({ op_id: op.id, kind: op.kind, state: op.state, summary: op.summary, actor: op.actor, error: op.error, bead_ids: op.beadIds, expected: ops.finishIntent(op) || op.intent || undefined, release_step: op.releaseStep, queen_told: ops.noticeReceipts(op)[cell.queenSessionId]?.state }));
    const crossEdges = edges.filter((e) => ids.has(e.dependent) !== ids.has(e.prerequisite) && (ids.has(e.dependent) || ids.has(e.prerequisite)));
    const focus = bead_id && beads[bead_id] && ids.has(bead_id) ? beads[bead_id] : null;
    return {
      cell: {
        cell_id: cell.id,
        task_id: cell.taskId,
        task_name: task?.name || '',
        root_bead_id: cell.rootBeadId,
        queen_session_id: cell.queenSessionId,
        goal: cell.rootBeadId ? beads[cell.rootBeadId]?.goal || '' : '',
        acceptance: cell.rootBeadId ? beads[cell.rootBeadId]?.acceptance || '' : '',
        watchdog_settings: watchdogSettings(cell),
        review_policy: reviewPolicy(cell),
        queen_instructions: cell.queenInstructions || '',
        setup: cell.setup?.state || null,
      },
      you: {
        session_id: actor.sessionId,
        role: actor.role,
        other_cells: participation(rt, host, actor.sessionId).filter((p) => p.cell.id !== cell.id).map((p) => ({ cell_id: p.cell.id, role: p.role })),
        claims: open.filter((b) => b.ownerSessionId === actor.sessionId).map((b) => b.id),
        bindings: bindings.filter((b) => b.sessionId === actor.sessionId).map((b) => ({ bead_id: b.beadId, role: b.role })),
      },
      focus: focus ? compactBead(rt, focus, { full: true, cell }) : undefined,
      beads: open.map((b) => compactBead(rt, b, { full: true, cell })),
      closed_beads: (include_closed ? closed : closed.slice(0, 20)).map((b) => compactBead(rt, b, { full: false })),
      closed_count: closed.length,
      pull_requests: waitingProjection(rt, cell, ids).pullRequests,
      links: edges.filter((e) => ids.has(e.dependent) && ids.has(e.prerequisite)).map((e) => ({ dependent: e.dependent, prerequisite: e.prerequisite, type: e.type, blocking: e.blocking })),
      cross_cell_links: crossEdges.map((e) => ({ dependent: e.dependent, prerequisite: e.prerequisite, type: e.type })),
      sessions,
      capacity: capacity(rt),
      attention: {
        watchdog: collectWatchdog(rt, host, cell),
        waiting_beads: open.filter((b) => b.waitingFor).map((b) => ({ bead_id: b.id, title: b.title, status: b.status, owner_session_id: b.ownerSessionId, waiting_for: b.waitingFor })),
        in_progress_without_owner: open.filter((b) => b.status === 'in_progress' && !b.assignee).map((b) => ({ bead_id: b.id, title: b.title, next_action: b.nextAction || undefined })),
        untracked_beads: open.filter((b) => isUntracked(host, rt.snapshots.graph, { ...b, ...reviewFields(rt, b.id) })).map((b) => ({ bead_id: b.id, title: b.title, owner_session_id: b.ownerSessionId })),
        untracked_sessions: sessions.filter((s) => s.session_id !== cell.queenSessionId && s.known && !s.archived && s.status !== 'exited' && !s.claims.length && !Object.values(doc.reviews || {}).some((r) => OPEN_REVIEW_STATES.has(r.state) && r.reviewerSessionId === s.session_id)).map((s) => ({ session_id: s.session_id, status: s.status, note: 'No claimed open bead; ordinary spawns are untracked until claimed.' })),
        worker_launches_to_reconcile: Object.values(doc.workerLaunches || {}).filter((l) => l.cellId === cell.id && RESERVED_LAUNCH_STATES.has(l.state)),
        reviews_awaiting_verdict: Object.values(doc.reviews || {}).filter((r) => r.cellId === cell.id && OPEN_REVIEW_STATES.has(r.state)),
        operations_to_reconcile: ops_,
        operations_note: ops_.length ? 'Writes that did not finish cleanly. Hive checks the store for each one\'s requested final state and settles it on its own when that state is there. For the rest, find out what happened (the holder of an item finishes it; never repeat a write blindly or take over a claim), then the queen or a coordinator records it with hive_reconcile_operation. This is bookkeeping for the agents, not a question for the human.' : undefined,
        claims_held_by_inactive_sessions: stale.map((s) => ({ session_id: s.session_id, claims: s.claims, status: s.known ? (s.archived ? 'archived' : sleepingReason(s) || s.status) : 'unknown' })),
        archive_suggestions: archiveSuggestions(rt, host, cell),
        note: stale.length ? 'A session that stopped, went idle or was archived has not finished its work. Check its last state before releasing or reassigning a claim; never close a bead just because its session stopped.' : undefined,
      },
      ...conversation,
      ...requests.requestContext(rt, actor),
      snapshot: { loaded_at: rt.snapshots.current.loadedAt, error: rt.snapshots.current.error, backend: rt.beads.status.state },
    };
  });
}

const evidenceSchema = strictObject({
  label: z.string().min(1).max(200).describe('Short label, e.g. "PR #12 merged" or "Failing test output". Labels beginning with "Review " are reserved for managed verdict receipts.'),
  url: z.string().max(2000).optional().describe('http(s) link, if any.'),
  detail: z.string().max(2000).optional().describe('Optional Markdown detail.'),
  kind: z.string().max(40).optional().describe('e.g. note, test, review, merge, pr, decision.'),
});

export const contextTool = hiveTool({
  name: 'hive_context',
  description: 'Read your Hive cell: its goal and acceptance, the human\'s queen instructions (how the queen should work), your role, every open bead with goal, acceptance, status, owner, waiting links and evidence, recent closed beads, links, the sessions involved and their AW status, operations that need reconciliation and recent conversation (plus, for the queen, human input not yet taken on board, human messages still awaiting your answer under awaiting_response, messages the human withdrew under withdrawn_by_human (do not answer those), and how many of your messages the human has not yet read, reacted to or replied to). Call it first when you start or resume.',
  inputSchema: {
    include_closed: z.boolean().optional().describe('Include every closed bead, not just the 20 most recent.'),
    bead_id: beadId.optional().describe('Also return this bead in full as `focus`.'),
  },
}, ({ rt, host, actor, args }) => buildContext(rt, host, actor, args));

export const readyTool = hiveTool({
  name: 'hive_ready',
  description: 'List work in your cell that is ready to claim: open, unclaimed, with no open children and no unfinished blocking prerequisites.',
  inputSchema: {
    under_bead_id: beadId.optional().describe('Limit to this bead\'s subtree, e.g. a workstream.'),
    limit: z.number().int().min(1).max(100).optional(),
  },
}, ({ rt, actor, args }) => ops.readyBeads(rt, actor, args));

export const createBeadsTool = hiveTool({
  name: 'hive_create_beads',
  description: 'Create one or more beads (work items, workstreams, investigations, decisions...) in your cell in one atomic step, with optional links. Give new beads a ref so later entries in the same call can use it as parent or link end. Beads without a parent go under the cell goal. Links say what depends on what; they are not created by position in the view.',
  inputSchema: {
    beads: z.array(strictObject({
      ref: z.string().max(40).optional().describe('Temporary name for this call, e.g. "api".'),
      parent: z.string().max(80).optional().describe('Parent bead id or a ref from this call. Defaults to the cell goal.'),
      title: z.string().min(1).max(200).describe('Short, self-contained action or outcome in plain words, shown on the map. Put ticket or PR references after the meaningful words, or in goal/summary/evidence.'),
      kind: z.string().max(40).optional().describe('work (default), workstream, investigation, fix, review, decision, idea, external (outside prerequisite; never claimable work)...'),
      goal: z.string().max(20000).optional().describe('The outcome this bead is for.'),
      acceptance: z.string().max(20000).optional().describe('How anyone can tell it is achieved.'),
      summary: z.string().max(20000).optional().describe('Current understanding (Markdown).'),
      next_action: z.string().max(2000).optional(),
      status: z.enum(SETTABLE_STATUSES).optional(),
    })).min(1).max(50),
    links: z.array(strictObject({
      dependent: z.string().max(80).describe('Bead id or ref that depends on `prerequisite`.'),
      prerequisite: z.string().max(80).describe('Bead id or ref it depends on.'),
      type: z.enum(LINK_TYPES).optional().describe('blocks (default) makes the dependent wait; related/tracks/... only associate.'),
    })).max(50).optional(),
  },
}, ({ rt, actor, args }) => ops.createBeads(rt, actor, args));

export const updateBeadTool = hiveTool({
  name: 'hive_update_bead',
  description: 'Update a bead in your cell: title, kind, goal, acceptance, summary (replace it, do not append a log), next action, waiting reason, status (open, in_progress, blocked, deferred) or parent, and add or remove evidence. Omitted fields are unchanged; an empty string clears a text field. Use hive_finish_bead to close work.',
  inputSchema: {
    bead_id: beadId,
    title: z.string().max(200).optional().describe('Short, self-contained action or outcome in plain words. Clarify, never change scope.'),
    kind: z.string().max(40).optional(),
    goal: z.string().max(20000).optional(),
    acceptance: z.string().max(20000).optional(),
    summary: z.string().max(20000).optional(),
    next_action: z.string().max(2000).optional(),
    waiting_for: z.string().max(2000).optional().describe('What it is waiting on and why. Waiting is normal, not failure.'),
    status: z.enum(SETTABLE_STATUSES).optional(),
    resume_review_at: z.string().max(40).optional().describe('With status "deferred": a review date (e.g. 2026-12-01) after which Hive raises the bead to the queen. Empty string clears it. Without any resume condition, the hive\'s default deferred review age applies.'),
    resume_after_bead: z.string().max(80).optional().describe('With status "deferred": a prerequisite bead id; Hive raises this bead to the queen when it closes. Empty string clears it.'),
    parent_id: z.string().max(80).optional().describe('New parent bead id; empty string moves it under the cell goal.'),
    expected_updated_at: z.string().max(80).optional().describe('Optional guard: the bead\'s updated_at as hive_context showed it. The update is refused if the bead has changed since. Omit to overwrite as before.'),
    add_evidence: z.array(evidenceSchema).max(20).optional(),
    remove_evidence_labels: z.array(z.string().max(200)).max(50).optional(),
  },
}, ({ rt, actor, args }) => ops.updateBead(rt, actor, args));

export const linkBeadsTool = hiveTool({
  name: 'hive_link_beads',
  description: 'Add or remove typed links between beads, atomically. Linking beads in two different cells requires you to take part in both.',
  inputSchema: {
    links: z.array(strictObject({
      dependent: beadId,
      prerequisite: beadId,
      type: z.enum(LINK_TYPES).optional(),
      remove: z.boolean().optional(),
    })).min(1).max(50),
  },
}, ({ rt, actor, args }) => ops.linkBeads(rt, actor, args));

export const claimBeadTool = hiveTool({
  name: 'hive_claim_bead',
  description: 'Claim a bead for yourself (it becomes in_progress, assigned to your session) and bind your session to it. Refused if another session holds it. Claiming twice is harmless.',
  inputSchema: { bead_id: beadId },
}, ({ rt, actor, args }) => ops.claimBead(rt, actor, args));

export const releaseBeadTool = hiveTool({
  name: 'hive_release_bead',
  description: 'Release your claim on a bead, keeping its status unless you pass status. A queen or coordinator may release another session\'s claim with force: true and a reason, after checking with the holder; it never happens automatically.',
  inputSchema: {
    bead_id: beadId,
    reason: z.string().max(2000).optional(),
    force: z.boolean().optional(),
    status: z.enum(SETTABLE_STATUSES).optional().describe('Status after release. Omit to keep the current status.'),
  },
}, ({ rt, actor, args }) => ops.releaseBead(rt, actor, args));

export const bindSessionTool = hiveTool({
  name: 'hive_bind_session',
  description: 'Associate a session with your cell, optionally with one bead and a role: work, review, helper (or the older worker, reviewer, investigator) or coordinator. Use it to join a session that was started some other way (plain spawn_session, adversarial-pr-review) to a bead so Hive tracks it. Joining as review needs a bead and records a review that session can give a verdict on (policy cannot be enforced; its actual agent is recorded). Bind yourself, or, as queen or coordinator, a session in this task or one you launched; the holder of a bead may also join review/helper sessions to it. The bead\'s holder cannot join itself as its reviewer. Only the queen can grant coordinator. unbind: true removes the association. Bindings record who worked on what; they do not complete anything.',
  inputSchema: {
    bead_id: beadId.optional(),
    session_id: z.string().max(128).optional().describe('Defaults to you.'),
    role: z.string().max(40).optional(),
    note: z.string().max(2000).optional(),
    unbind: z.boolean().optional(),
  },
}, ({ rt, host, actor, args }) => ops.bindSession(rt, host, actor, args));

export const finishBeadTool = hiveTool({
  name: 'hive_finish_bead',
  description: 'Close a bead with an explicit outcome (done, dropped, superseded, duplicate), a summary of what was achieved or why it stopped, and evidence. For outcome done, close only when the whole goal of the bead is done, not after one step of several; use dropped, superseded or duplicate to retire work that will not ship. Evidence records what happened; closing a bead does not claim a review took place unless your evidence says so. Refused while anything under it is still open; a heading with work under it is also refused while it waits on an open prerequisite, another session holds it, or a Hive write about any of it is unsettled.',
  inputSchema: {
    bead_id: beadId,
    outcome: z.enum(OUTCOMES),
    summary: z.string().min(1).max(20000),
    evidence: z.array(evidenceSchema).max(20).optional(),
  },
}, ({ rt, actor, args }) => ops.finishBead(rt, actor, args));

export const publishTool = hiveTool({
  name: 'hive_publish',
  description: 'Returns a relative hash link to the posted message. Publish a deliberate message to the human in your cell\'s Hive conversation: an answer, decision, trade-off, concern, question, meaningful milestone or result, a significant change of approach, scope or timing, or a material blocker. It is shown as coming from your session. Answer a [Hive] message from the human here, with reply_to set to its id, or list the human messages this answers in answers: text in your terminal is not shown in Hive. Every human message waits for a visible answer from the queen; only such an answer settles it, and it also acknowledges receipt. The human marks queen messages read, reacts to them or replies; that arrives as state in hive_context, not as messages. Inform the human even when they need not act. Leave routine bookkeeping, unchanged status and worker chatter on the beads, and do not post timed status updates. Messages are grouped into topics: a reply joins its message\'s topic, thread_id posts into a topic, and otherwise a new topic starts, named thread_title or the message\'s first line.',
  inputSchema: {
    text: z.string().min(1).max(20000).describe('Markdown. Self-contained: enough context to respond without opening a terminal.'),
    bead_id: beadId.optional().describe('The bead this is about, if any. A new topic is anchored to it.'),
    reply_to: z.string().max(80).optional().describe('Message id you are replying to.'),
    thread_id: z.string().max(80).optional().describe('Topic to post into, from hive_context threads. Not needed with reply_to.'),
    thread_title: z.string().min(1).max(120).optional().describe('Name for the new topic this message starts. Only without reply_to and thread_id.'),
    attachments: z.array(strictObject({ file: z.string().min(1).max(100), alt: z.string().max(500).optional() })).max(4).optional().describe('Queen only. PNG, JPEG, GIF or WebP files saved in attachments_inbox from hive_context. Bare names only, never paths. Up to 4, each at most 5 MB.'),
    answers: z.array(z.string().min(1).max(80)).max(20).optional().describe('Queen only. Ids of human messages in this cell that this message answers, besides reply_to.'),
  },
}, ({ rt, host, actor, args }) => publish(rt, actor, args, host));

export const updateThreadTool = hiveTool({
  name: 'hive_update_thread',
  description: 'Queen or coordinator only. Rename a conversation topic, or move it to the item it is now about (bead_id), so it shows when the human selects that item. A topic the human named keeps its name. Only the queen can change a hive-wide topic or make one hive-wide (bead_id: "").',
  inputSchema: {
    thread_id: z.string().min(1).max(80),
    title: z.string().min(1).max(120).optional(),
    bead_id: z.union([beadId, z.literal('')]).optional().describe('The item the topic is about; "" makes it hive-wide.'),
  },
}, ({ rt, actor, args }) => updateThread(rt, actor, args));

export const acknowledgeInputTool = hiveTool({
  name: 'hive_acknowledge_input',
  description: 'Queen only. Confirm receipt: you have taken on board human messages listed under unacknowledged_input in hive_context, so Hive stops retrying them. It does not send anything and does not answer them; each still waits under awaiting_response until you answer it with hive_publish.',
  inputSchema: { message_ids: z.array(z.string().min(1).max(80)).min(1).max(100) },
}, ({ rt, actor, args }) => acknowledgeInput(rt, actor, args));

export const reconcileOperationTool = hiveTool({
  name: 'hive_reconcile_operation',
  description: 'Queen or coordinator only. Settle one of your cell\'s unfinished operations (listed under attention.operations_to_reconcile in hive_context). Hive first reads the store and settles it itself when the requested final state is there. If it cannot confirm that, call again with a verdict and a note saying what you verified. It never repeats or forces a write, and cell setup operations stay with the human.',
  inputSchema: {
    op_id: z.string().min(1).max(80),
    verdict: z.enum(ops.VERDICTS).optional().describe('Only after verifying: applied (the requested state is there), not-applied (it did not happen and is not needed as recorded), superseded (later work replaced it).'),
    note: z.string().max(500).optional().describe('Required with a verdict: what you checked and found.'),
  },
}, ({ rt, actor, args }) => ops.reconcileForAgent(rt, actor, args));

export const deleteBeadsTool = hiveTool({
  name: 'hive_delete_beads',
  description: 'Queen only. Permanently delete items from your hive that should not exist at all, such as mistakes or accidental copies. To stop, drop or replace real work, use hive_finish_bead instead: it keeps the record. Without execute this only previews: it lists the items and anything that stops the deletion. Name every item, including all children; nothing is deleted on its own. Refused for the hive goal, items in other hives, claimed items, unnamed children, links between a deleted item and one that stays, and items with unsettled operations. To delete, call again with the same bead_ids, execute: true and the preview\'s confirm_token.',
  inputSchema: {
    bead_ids: z.array(beadId).min(1).max(20),
    reason: z.string().min(1).max(2000).describe('Why these items should not exist. Kept with the operation record.'),
    execute: z.boolean().optional().describe('Only after a clean preview. Deleting cannot be undone from Hive.'),
    confirm_token: z.string().max(80).optional().describe('From the preview of exactly these items.'),
  },
}, ({ rt, actor, args }) => ops.deleteBeads(rt, actor, args));

const workerArgs = {
  bead_id: beadId,
  intent: z.string().min(1).max(20000).describe('Bounded brief for the worker or reviewer.'),
  cwd: z.string().max(2000).optional(),
  agent: z.string().max(80).optional(),
  model: z.string().max(200).optional(),
  effort: z.string().max(80).optional(),
  auto_compact_tokens: z.number().int().positive().optional(),
  worktree: strictObject({ branch: z.string().optional(), folderName: z.string().optional(), auto: z.boolean().optional(), base: z.string().optional() }).optional(),
};

const reviewArgs = {
  commit: z.string().min(1).max(80).optional().describe('SHA to review (role review).'),
  override_reason: z.string().min(1).max(1000).optional().describe('Queen/coordinator only: required to use an agent, model or effort other than the hive review policy for a review. Recorded on the review.'),
};

export const spawnWorkerTool = hiveTool({
  name: 'hive_spawn_worker',
  description: 'Launch a tracked session attached to a bead, with a role: work (default), review or helper. The queen/coordinator may launch any role. The session holding the bead\'s claim may launch review or helper sessions for that bead only (never another work session). work reserves the bead and global capacity and launches a worker already claimed and bound. review launches a reviewer bound to the bead on the hive review policy (cell.review_policy: a primary and a secondary config, chosen so the reviewer\'s provider differs from the builder\'s, else the primary with sameProvider noted); agent/model/effort are ignored for a holder, and the queen/coordinator may differ only with override_reason, which is recorded. A re-review is another review session on the same bead with its own verdict. helper launches an investigator bound to the bead without taking its claim. Review and helper sessions share the bead\'s capacity slot. The queen is told when a review session starts. An uncertain launch keeps its reservation; reconcile it instead of launching again. Ordinary spawn_session remains possible but is untracked until you join it with hive_bind_session.',
  inputSchema: { ...workerArgs, ...reviewArgs, role: z.enum(['work', 'review', 'helper']).optional() },
}, ({ rt, host, actor, args }) => {
  const { role = 'work', commit, override_reason, ...rest } = args;
  if (role !== 'review' && (commit !== undefined || override_reason !== undefined)) throw new ops.HiveError('commit and override_reason apply only to role review.');
  if (role === 'review') return requestReview(rt, host, actor, { ...rest, commit, override_reason });
  return spawnWorker(rt, host, actor, rest, role === 'helper' ? { role: 'investigator' } : {});
});

export const reconcileWorkerTool = hiveTool({
  name: 'hive_reconcile_worker_launch',
  description: 'Queen/coordinator only. Confirm a reserved/uncertain worker launch from its live session and claim. To abandon one, verify no worker is starting, release any surviving claim, then pass abandon: true and a reason. Never launches again or takes a claim.',
  inputSchema: { launch_id: z.string().min(1).max(80), abandon: z.boolean().optional(), reason: z.string().max(2000).optional() },
}, ({ rt, host, actor, args }) => reconcileWorkerLaunch(rt, host, actor, args));

export const requestReviewTool = hiveTool({
  name: 'hive_request_review',
  description: 'Alias of hive_spawn_worker with role review, kept for existing callers. Launches a reviewer on this bead on the hive review policy; see hive_spawn_worker. The claim holder or the queen/coordinator may call it; override_reason is required to depart from the policy.',
  inputSchema: { ...workerArgs, ...reviewArgs },
}, ({ rt, host, actor, args }) => requestReview(rt, host, actor, args));

export const reviewVerdictTool = hiveTool({
  name: 'hive_review_verdict',
  description: 'Only the current bound reviewer may give a verdict on this work bead. Records evidence and ends the review wait without closing the work or changing the builder\'s claim. changes_requested returns findings to the builder. Retry only the same verdict if its receipt was interrupted. After changes_requested, the same reviewer may record a new round with a different `commit` (the reviewed SHA); earlier rounds stay in history. The same commit cannot take a conflicting verdict.',
  inputSchema: { bead_id: beadId, verdict: z.enum(['approved', 'changes_requested']), summary: z.string().min(1).max(20000), commit: z.string().min(1).max(80).optional() },
}, ({ rt, host, actor, args }) => reviewVerdict(rt, host, actor, args));

export const cancelReviewTool = hiveTool({
  name: 'hive_cancel_review',
  description: 'Queen/coordinator only. Explicitly cancel the open review on this work bead with a reason. Clears the review wait without a verdict and fences its reviewer. Does not close work or change the builder\'s claim.',
  inputSchema: { bead_id: beadId, reason: z.string().min(1).max(2000) },
}, ({ rt, host, actor, args }) => cancelReview(rt, host, actor, args));



function requestTool(name, description, inputShape, run) {
  const inputSchema = strictObject(inputShape);
  return {
    name, description, inputSchema,
    async handler({ host, caller }, args = {}) {
      const parsed = inputSchema.safeParse(args);
      if (!parsed.success) return error(`Hive: invalid input: ${parsed.error.message}`);
      args = parsed.data;
      const rt = host?.stores?.hive;
      if (!rt) return error('Hive is not active.');
      try {
        return result(await run(rt, host, caller, args));
      }
      catch (err) {
        if (KNOWN_CODES.has(err?.code)) return error(err.message);
        rt.log?.(`hive: ${name} failed: ${err?.message}`);
        return error('Hive could not confirm the request operation. Read hive_list_my_requests or hive_context before retrying.');
      }
    },
  };
}

const requestIdArg = z.string().regex(/^hreq_[0-9a-f]{12}$/);
const requestRevisionArgs = {
  request_id: requestIdArg,
  revision: z.number().int().positive().describe('Current request revision from Hive.'),
  route_revision: z.number().int().positive().describe('Current route revision from Hive.'),
};
const requestTools = [
  requestTool('hive_request_input', 'Ask for a decision or action inside your active Hive cell. Worker/reviewer/helper requests go to its queen, who answers or forwards the same request to the human. Queens ask the human directly. Do not also call request_human_input. Outside Hive use that standard tool instead. Offer 2-4 options where there is a choice, recommended first with (Recommended) in its label, and explain your recommendation in the body. Caller identity comes from MCP, never arguments.', {
    cell_id: cellIdArg,
    title: z.string().min(1).max(200), body: z.string().min(1).max(20000),
    options: optionsSchema.optional(),
    allow_free_text: z.boolean().optional().describe('Compatibility parameter; ignored. Standalone text replies and optional notes are always allowed.'),
    kind: z.enum(['question', 'decision', 'approval', 'manual-action']).optional(),
    bead_id: beadId.optional(), thread_id: z.string().max(80).optional(), blocking: z.boolean().optional(),
    dedupe_key: z.string().max(120).optional(), expires_at: z.number().int().positive().optional().describe('Optional future Unix timestamp in milliseconds.'),
  }, requests.createRequest),
  requestTool('hive_list_my_requests', 'Recover your own native requests, audience, answers and delivery state. Remains available after leaving a hive. Human and queen answers are explicitly attributed. Does not read the Needs You extension.', { cell_id: cellIdArg }, (rt, host, caller, args) => ({ requests: requests.listMine(rt, host, caller, args.cell_id) })),
  requestTool('hive_withdraw_request', 'Withdraw only your own native request, including when an answer arrived in chat. Remains available after leaving a hive. Never withdraw a legacy ibx request here.', { request_id: requestIdArg, reason: z.string().max(2000).optional() }, requests.withdrawRequest),
  requestTool('hive_answer_request', 'Current queen only: answer a request still routed to you, within your own authority. It is attributed as a queen answer, never a human answer. Use current revisions from hive_context.', { ...requestRevisionArgs, option_id: z.string().max(32).optional().describe('Stable id from the current options.'), text: z.string().max(20000).optional().describe('Standalone answer or optional note with an option (up to 4000 characters for requests with options).') }, requests.answerRequest),
  requestTool('hive_forward_request', 'Current queen only: forward your queued native request to the human with an optional recommendation. Preserves the original request and requester. Do not create a second standard request.', { ...requestRevisionArgs, recommendation: z.string().max(4000).optional() }, requests.forwardRequest),
];
export const reportPrWaitTool = hiveTool({
  name: 'hive_report_pr_wait',
  description: 'Report or clear a human wait on a known PR associated with your bead. Claimant, queen or coordinator only. ready means independent review approved this exact head and the human should review it; GitHub checks must also be green. cannot-fix records a concrete human blocker the worker cannot resolve, such as admin workflow approval or an unresolved conflict. Failing checks the worker is handling are not a human wait. Reports expire when the observed head changes. This never merges or changes GitHub.',
  inputSchema: { bead_id: beadId, url: z.string().max(2000), head_sha: z.string().regex(/^[a-f0-9]{40}$/i), state: z.enum(['ready', 'cannot-fix', 'clear']), reason: z.string().max(500).optional() },
}, ({ rt, actor, args }) => reportPrWait(rt, actor, args));

export const workTools = [
  ...requestTools, reportPrWaitTool, spawnWorkerTool, reconcileWorkerTool, requestReviewTool, reviewVerdictTool, cancelReviewTool, contextTool, readyTool, createBeadsTool, updateBeadTool, linkBeadsTool, claimBeadTool, releaseBeadTool, bindSessionTool, finishBeadTool, deleteBeadsTool, publishTool, acknowledgeInputTool, reconcileOperationTool, updateThreadTool];
