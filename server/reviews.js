import { newId } from './metadata-store.js';
import { actorFor, normalizeIssue, descendantIds } from './bead-model.js';
import { COORDINATING_ROLES, requireBeadAccess, requireCoordinator, resolveCaller } from './access.js';
import { assertAllowedReviewer, chooseReviewer } from './review-policy.js';
import { HiveError, ensureWritable, text, withLock, withLocks, journaled, isRunning } from './ops.js';
import { ADMISSION_LOCK, checkAdmission, exportedGraph, RESERVED_LAUNCH_STATES } from './admission.js';
import { OPEN_REVIEW_STATES, openReview } from './review-state.js';
import { coordinator, spawnWorker } from './workers.js';
import { safeDeliver } from './sessions.js';

export function retainedReviewer(rt, host, record, sid) {
  const session = host.sessions.get(sid);
  return Boolean(session && !session.archived && session.status !== 'exited') && record.reviewerSessionId === sid
    && (rt.metadata.read().bindings[record.cellId] || []).some((b) => b.active && b.sessionId === sid && b.beadId === record.workBeadId && b.role === 'reviewer' && b.reviewId === record.id);
}

function boundReviewer(rt, host, record, sid) {
  return record.state === 'in_review' && retainedReviewer(rt, host, record, sid);
}

export function startReviewRound(rt, reviewId, { commit, summary } = {}) {
  const current = rt.metadata.read().reviews[reviewId];
  if (!current || current.state !== 'changes_requested' || !current.verdict) throw new HiveError('A new review round needs a settled changes_requested verdict.', 'conflict');
  if (['pending', 'uncertain', 'partial'].includes(rt.metadata.read().operations[current.verdictOpId]?.state)) throw new HiveError('The earlier verdict write is unsettled; reconcile it before a new round.', 'uncertain');
  rt.metadata.mutate((d) => {
    const r = d.reviews[reviewId];
    const { verdict, verdictOpId, delivery, completedAt, summary: previous } = r;
    r.history = [...(r.history || []), { round: r.round || 1, commit: r.commit, verdict, verdictOpId, delivery, completedAt, summary: previous }];
    for (const key of ['verdict', 'verdictOpId', 'delivery', 'completedAt']) delete r[key];
    r.round = (r.round || 1) + 1;
    if (commit) r.commit = commit; else delete r.commit;
    r.state = 'in_review'; r.updatedAt = Date.now();
    r.summary = summary || `Round ${r.round} in progress${commit ? ` for ${commit}` : ''}; earlier findings are in the review history.`;
  });
}

function sameVerdict(record, sid, input, summary, commit) {
  return record.verdict.by === sid && record.verdict.value === input.verdict && record.verdict.summary === summary && (record.commit || undefined) === commit;
}

function verdictEvidence(record) {
  const v = record.verdict;
  const round = record.round || 1;
  return { label: `Review ${record.id}${round > 1 ? ` round ${round}` : ''}: ${v.value}`, kind: 'review', detail: v.summary.slice(0, 2000), by: actorFor(v.by), at: new Date(v.at).toISOString() };
}

async function reconcileReview(rt, host, record) {
  if (record.verdict && OPEN_REVIEW_STATES.has(record.state)) {
    const op = rt.metadata.read().operations[record.verdictOpId];
    const failed = op && (['error', 'not-applied'].includes(op.state) || (op.state === 'resolved' && op.verdict !== 'applied'));
    if (failed) {
      rt.metadata.mutate((d) => { delete d.reviews[record.id].verdict; delete d.reviews[record.id].verdictOpId; });
    } else if (op?.kind === 'review-verdict' && op.actor === actorFor(record.verdict.by)
      && op.intent?.reviewId === record.id && op.intent?.beadId === record.workBeadId && op.intent?.verdict === record.verdict.value && (op.intent?.round || 1) === (record.round || 1)
      && ['pending', 'uncertain', 'partial', 'applied', 'resolved'].includes(op.state)) {
      const raw = await rt.beads.show(record.workBeadId);
      const expected = verdictEvidence(record);
      if (raw && normalizeIssue(raw).evidence.some((e) => e.label === expected.label && e.by === expected.by && e.detail === expected.detail)) {
        rt.metadata.mutate((d) => {
          const r = d.reviews[record.id];
          r.state = r.verdict.value; r.completedAt = Date.now(); r.summary = r.verdict.summary;
          const currentOp = d.operations[r.verdictOpId];
          if (!isRunning(currentOp.id) && ['pending', 'uncertain', 'partial'].includes(currentOp.state)) Object.assign(currentOp, { state: 'applied', settledBy: 'hive:observed', updatedAt: Date.now() });
        });
      }
    }
  }
  const current = rt.metadata.read().reviews[record.id];
  if (OPEN_REVIEW_STATES.has(current.state) && current.reviewerSessionId && host.sessions.get(current.reviewerSessionId)?.archived) {
    rt.metadata.mutate((d) => {
      const r = d.reviews[record.id];
      r.previousReviewerSessionId = r.reviewerSessionId;
      r.reviewerSessionId = null; r.state = 'requested'; r.updatedAt = Date.now();
      r.waitingFor = 'Reviewer archived without a verdict; request a replacement reviewer or explicitly cancel.';
      for (const b of d.bindings[r.cellId] || []) if (b.reviewId === r.id) b.active = false;
      const l = d.workerLaunches[r.launchId];
      if (l) { l.state = 'archived'; l.updatedAt = Date.now(); }
    });
  }
  const latest = rt.metadata.read().reviews[record.id];
  if (latest.state === 'changes_requested' && !latest.delivery) {
    const work = await rt.beads.show(latest.workBeadId);
    if (work?.assignee?.startsWith('aw:') && work.assignee !== actorFor(latest.verdict.by)) {
      rt.metadata.mutate((d) => { d.reviews[record.id].delivery = { state: 'sending', at: Date.now() }; });
      const result = await safeDeliver(host, work.assignee.slice(3), `[Hive] Review of ${latest.workBeadId} requested changes. Your claim remains. ${latest.summary}`, rt);
      rt.metadata.mutate((d) => { d.reviews[record.id].delivery = { ...result, at: Date.now() }; });
    }
  }
}

export async function notifyQueen(rt, host, cell, actor, textBody) {
  if (!cell?.queenSessionId || cell.queenSessionId === actor?.sessionId) return null;
  return safeDeliver(host, cell.queenSessionId, textBody, rt);
}

function builderAgentOf(host, bead) {
  const sid = bead.assignee?.startsWith('aw:') ? bead.assignee.slice(3) : null;
  return (sid && host.sessions.get(sid)?.agent) || null;
}

export function resolveReviewPolicy(cell, builderAgent, input, byHolder) {
  const chosen = chooseReviewer(cell, builderAgent);
  const explicit = ['agent', 'model', 'effort'].filter((k) => input[k] !== undefined);
  const policy = { ...chosen.config, builderAgent, sameProvider: chosen.unknownBuilder ? null : chosen.sameProvider, ...(chosen.unknownBuilder ? { unknownBuilder: true } : {}) };
  if (explicit.length && !byHolder) {
    const reason = text(input.override_reason, 'override_reason', 1000);
    if (!reason) throw new HiveError('The review policy applies to every review. To use a different agent, model or effort, pass override_reason.', 'refused');
    for (const k of explicit) policy[k] = text(input[k], k, 120);
    assertAllowedReviewer(policy);
    policy.sameProvider = builderAgent ? policy.agent === builderAgent : null;
    policy.overrideReason = reason;
  }
  return policy;
}

export async function requestReview(rt, host, actor, input) {
  const intent = text(input.intent, 'intent', 20000, { required: true });
  const commit = input.commit === undefined ? undefined : text(input.commit, 'commit', 80, { required: true });
  const asAttach = { attach: true, beadId: input.bead_id };
  const reviewerSessionId = input.reviewer_session_id === undefined ? undefined : text(input.reviewer_session_id, 'reviewer_session_id', 200, { required: true });
  let retained = null;
  let reviewId;
  let policy = null;
  let cellOf = null;
  await withLock(`review:${input.bead_id}`, async () => {
    const previous = openReview(rt, input.bead_id);
    if (previous) await reconcileReview(rt, host, previous);
    await withLocks([ADMISSION_LOCK, `bead:${input.bead_id}`], async () => {
      ensureWritable(rt);
      await rt.snapshots.refresh();
      if (rt.snapshots.current.error) throw new HiveError('Cannot confirm current review work.');
      actor = coordinator(rt, host, actor, asAttach);
      const byHolder = !COORDINATING_ROLES.has(actor.role);
      const { bead, cell } = requireBeadAccess(rt, actor, input.bead_id);
      cellOf = cell;
      if (cell.id !== actor.cell.id || bead.status === 'closed' || bead.id === cell.rootBeadId) throw new HiveError('Request a review for open work in this cell.');
      if (reviewerSessionId) {
        const launchOptions = ['agent', 'model', 'effort', 'override_reason'].filter(k => input[k] !== undefined);
        if (launchOptions.length) throw new HiveError(`Cannot use ${launchOptions.join(', ')} with reviewer_session_id; a retained reviewer keeps its existing configuration.`, 'refused');
        if (!commit) throw new HiveError('A retained review requires a new commit.', 'refused');
        const doc = rt.metadata.read();
        const record = Object.values(doc.reviews).filter(r => r.workBeadId === bead.id).at(-1);
        const worked = bead.assignee === actorFor(reviewerSessionId)
          || (doc.bindings[cell.id] || []).some(b => b.sessionId === reviewerSessionId && b.beadId === bead.id && ['worker', 'investigator'].includes(b.role))
          || Object.values(doc.workerLaunches || {}).some(l => l.sessionId === reviewerSessionId && l.beadId === bead.id && !l.reviewId);
        if (worked) throw new HiveError('A session that has worked on this bead cannot review it.', 'access');
        if (!record || record.cellId !== cell.id || !retainedReviewer(rt, host, record, reviewerSessionId)) throw new HiveError('The session must be this bead’s retained bound reviewer and must not be archived or exited.', 'access');
        if (openReview(rt, bead.id)) throw new HiveError('This bead already has an open review; wait for its verdict or cancel it.', 'conflict');
        if (commit === record.commit || (record.history || []).some(h => h.commit === commit)) throw new HiveError('A retained review requires a new commit, not one from an earlier round.', 'conflict');
        checkAdmission(rt, await rt.beads.loadSnapshot({ all: true }), bead.id, { sessionId: null, review: true });
        const fresh = await rt.beads.show(bead.id);
        if (!fresh || fresh.status === 'closed') throw new HiveError('Reviewed work is missing or closed.', 'conflict');
        await journaled(rt, { kind: 'review-request', cellId: cell.id, actor: actorFor(actor.sessionId), summary: `Re-request review of ${bead.id}`, beadIds: [bead.id], intent: { reviewId: record.id, reviewerSessionId, commit } }, async () => {
          startReviewRound(rt, record.id, { commit, summary: intent });
          return { journal: { reviewId: record.id } };
        });
        const round = rt.metadata.read().reviews[record.id].round;
        await rt.snapshots.refresh(); rt.changed();
        retained = { session_id: reviewerSessionId, review_id: record.id, round, policy: record.policy };
        return;
      }
      policy = resolveReviewPolicy(cell, builderAgentOf(host, bead), input, byHolder);
      const prior = openReview(rt, bead.id);
      if (prior) {
        const launch = rt.metadata.read().workerLaunches[prior.launchId];
        if (prior.reviewerSessionId || (launch && RESERVED_LAUNCH_STATES.has(launch.state))) throw new HiveError('This review already has a reviewer or an unsettled launch; reconcile it first.', 'conflict');
        if (prior.verdict) throw new HiveError('The pending verdict needs reconciliation before replacing the reviewer.', 'conflict');
        reviewId = prior.id;
      } else reviewId = newId('review');
      checkAdmission(rt, await rt.beads.loadSnapshot({ all: true }), bead.id, { sessionId: null, review: true });
      const fresh = await rt.beads.show(bead.id);
      if (!fresh || fresh.status === 'closed') throw new HiveError('Reviewed work is missing or closed.', 'conflict');
      actor = coordinator(rt, host, actor, asAttach);
      await journaled(rt, { kind: 'review-request', cellId: cell.id, actor: actorFor(actor.sessionId), summary: `Request review of ${bead.id}`, beadIds: [bead.id] }, async () => {
        rt.metadata.mutate((d) => {
          if (Object.values(d.reviews).some((r) => r.workBeadId === bead.id && r.id !== reviewId && OPEN_REVIEW_STATES.has(r.state))) throw new HiveError('This bead already has an open review; wait for its verdict or cancel it.', 'conflict');
          d.reviews[reviewId] = { ...d.reviews[reviewId], id: reviewId, cellId: cell.id, workBeadId: bead.id, requestedBy: actor.sessionId, state: 'requested', reviewerSessionId: null, summary: intent, createdAt: d.reviews[reviewId]?.createdAt || Date.now(), updatedAt: Date.now(), policy, ...(commit ? { commit } : {}) };
        });
        return { journal: { reviewId } };
      });
    });
  });
  if (retained) {
    const delivery = await safeDeliver(host, reviewerSessionId, `[Hive] Re-review ${input.bead_id}, round ${retained.round}, commit ${commit}. ${intent}\nUse hive_review_verdict with bead_id ${input.bead_id} and commit ${commit}. Earlier findings remain in review history.`, rt);
    rt.metadata.mutate(d => { d.reviews[retained.review_id].requestDelivery = { ...delivery, at: Date.now() }; });
    const deliveryWarning = delivery.state === 'delivered' ? '' : ` Reviewer mail ${delivery.state}: ${delivery.error}. The round remains open; confirm delivery before waiting for its verdict.`;
    await notifyQueen(rt, host, cellOf, actor, `[Hive] Review round ${retained.round} reopened on ${input.bead_id} with retained reviewer ${reviewerSessionId}, commit ${commit}.${deliveryWarning}`);
    return { ...retained, delivery };
  }
  try {
    const launchInput = { ...input, agent: policy.agent, model: policy.model, effort: policy.effort, intent: `${intent}${commit ? `\n\nReview commit ${commit}.` : ''}\n\nYou review work bead ${input.bead_id}; its builder keeps the claim. Give hive_review_verdict with bead_id ${input.bead_id}, approved or changes_requested, findings${commit ? ` and commit ${commit}` : ' and the reviewed commit'}.` };
    const launch = await spawnWorker(rt, host, actor, launchInput, { reviewId });
    await notifyQueen(rt, host, cellOf, actor, `[Hive] Review session ${launch.session_id} started on ${input.bead_id} (${policy.agent}/${policy.model}/${policy.effort}${policy.sameProvider ? ', same provider as the builder' : ''}${policy.overrideReason ? `, policy overridden: ${policy.overrideReason}` : ''}), requested by ${actor.sessionId}. No action needed.`);
    return { ...launch, review_id: reviewId, policy };
  } catch (err) {
    if (rt.metadata.read().reviews[reviewId]?.state === 'cancelled') throw new HiveError(`Review ${reviewId} was cancelled before its reviewer launch completed: ${err.message}`, 'refused');
    throw new HiveError(`Review ${reviewId} remains a wait on ${input.bead_id}, but its reviewer launch did not finish: ${err.message}. Reconcile the launch before requesting a replacement.`, err.code || 'uncertain');
  }
}

export async function reviewVerdict(rt, host, actor, input) {
  ensureWritable(rt);
  if (!['approved', 'changes_requested'].includes(input.verdict)) throw new HiveError('verdict must be approved or changes_requested.');
  const summary = text(input.summary, 'summary', 20000, { required: true });
  const commit = input.commit === undefined ? undefined : text(input.commit, 'commit', 80, { required: true });
  const id = input.bead_id;
  const { cell } = requireBeadAccess(rt, actor, id);
  return withLock(`review:${id}`, async () => {
    const records = Object.values(rt.metadata.read().reviews).filter((r) => r.workBeadId === id);
    const record = openReview(rt, id) || records.at(-1);
    if (!record || record.cellId !== cell.id) throw new HiveError('This work has no requested review.');
    if (record.verdict && !sameVerdict(record, actor.sessionId, input, summary, commit)) {
      const newRound = record.state === 'changes_requested' && commit && commit !== record.commit && !(record.history || []).some((h) => h.commit === commit);
      if (!newRound) throw new HiveError('This review already has a different verdict.', 'conflict');
    }
    await reconcileReview(rt, host, record);
    let saved = rt.metadata.read().reviews[record.id];
    if (saved.state === 'in_review' && (saved.round || 1) > 1 && saved.commit && commit !== saved.commit) throw new HiveError('The verdict commit must match the current review round commit.', 'conflict');
    const reopen = saved.state === 'changes_requested' && saved.verdict && !sameVerdict(saved, actor.sessionId, input, summary, commit);
    if (!reopen) {
      if (saved.state === input.verdict && saved.verdict?.by === actor.sessionId) return { bead_id: id, review_id: saved.id, verdict: saved.state };
      if (saved.verdict && ['pending', 'uncertain', 'partial'].includes(rt.metadata.read().operations[saved.verdictOpId]?.state)) throw new HiveError('The verdict write is unsettled; reconcile it rather than repeating it.', 'uncertain');
      if (!boundReviewer(rt, host, saved, actor.sessionId)) throw new HiveError('Only the current bound reviewer may give this verdict.', 'access');
    } else if (!retainedReviewer(rt, host, saved, actor.sessionId)) throw new HiveError('Only the current bound reviewer may give this verdict.', 'access');
    const write = () => journaled(rt, { kind: 'review-verdict', cellId: cell.id, actor: actorFor(actor.sessionId), summary: `Review ${id}: ${input.verdict}`, beadIds: [id], intent: { beadId: id, reviewId: saved.id, verdict: input.verdict, round: saved.round || 1, ...(commit ? { commit } : {}) } }, async (opId, phase) => {
      const fresh = await rt.beads.show(id);
      if (!fresh || fresh.status === 'closed') throw new HiveError('Reviewed work is missing or closed.', 'conflict');
      rt.metadata.mutate((d) => { Object.assign(d.reviews[saved.id], { verdictOpId: opId, verdict: { by: actor.sessionId, value: input.verdict, summary, at: Date.now() }, round: d.reviews[saved.id].round || 1, ...(commit ? { commit } : {}) }); });
      const evidence = [...normalizeIssue(fresh).evidence, verdictEvidence(rt.metadata.read().reviews[saved.id])];
      if (evidence.length > 50) throw new HiveError('Remove old evidence before recording this review.');
      await rt.beads.update(id, { evidence, nextAction: input.verdict === 'changes_requested' ? `Address review findings: ${summary}`.slice(0, 2000) : 'Review approved. Continue acceptance and integration steps.' }, actorFor(actor.sessionId), (context) => {
        const graph = exportedGraph(context);
        if (!boundReviewer(rt, host, rt.metadata.read().reviews[saved.id], actor.sessionId) || !descendantIds(graph.beads, cell.rootBeadId).has(id) || graph.beads[id]?.status === 'closed') throw new HiveError('The reviewer or work changed before its verdict.', 'conflict');
      });
      phase.applied = true;
      await reconcileReview(rt, host, rt.metadata.read().reviews[saved.id]);
      return { journal: { reviewId: saved.id, verdict: input.verdict } };
    });
    if (reopen) {
      await withLocks([ADMISSION_LOCK, `bead:${id}`], async () => {
        ensureWritable(rt);
        await rt.snapshots.refresh();
        if (rt.snapshots.current.error) throw new HiveError('Cannot confirm current review work.');
        checkAdmission(rt, await rt.beads.loadSnapshot({ all: true }), id, { sessionId: null, review: true });
        const fresh = await rt.beads.show(id);
        if (!fresh || fresh.status === 'closed') throw new HiveError('Reviewed work is missing or closed.', 'conflict');
        startReviewRound(rt, saved.id, { commit });
        saved = rt.metadata.read().reviews[record.id];
        await write();
      });
    } else await withLock(`bead:${id}`, write);
    await rt.snapshots.refresh(); rt.changed();
    await notifyQueen(rt, host, cell, actor, `[Hive] Review verdict on ${id}: ${input.verdict}${commit ? ` (commit ${commit})` : ''} from ${actor.sessionId}. ${summary.slice(0, 300)}`);
    return { bead_id: id, review_id: saved.id, verdict: input.verdict };
  });
}

export async function cancelReview(rt, host, actor, input) {
  ensureWritable(rt);
  const reason = text(input.reason, 'reason', 2000, { required: true });
  return withLock(`review:${input.bead_id}`, async () => {
    actor = resolveCaller(rt, host, actor.sessionId, actor.cell.id);
    requireCoordinator(actor, 'cancel a review');
    const record = openReview(rt, input.bead_id);
    if (!record || record.cellId !== actor.cell.id) throw new HiveError('This work has no open review.');
    await reconcileReview(rt, host, record);
    const current = rt.metadata.read().reviews[record.id];
    if (!OPEN_REVIEW_STATES.has(current.state)) throw new HiveError('This review already ended with a verdict.', 'conflict');
    if (current.verdict) throw new HiveError('Reconcile the pending verdict before cancelling this review.', 'conflict');
    actor = resolveCaller(rt, host, actor.sessionId, record.cellId);
    requireCoordinator(actor, 'cancel a review');
    rt.metadata.mutate((d) => {
      Object.assign(d.reviews[record.id], { state: 'cancelled', summary: reason, cancellation: { by: actor.sessionId, reason, at: Date.now() }, completedAt: Date.now() });
      for (const b of d.bindings[record.cellId] || []) if (b.reviewId === record.id) b.active = false;
      const l = d.workerLaunches[record.launchId];
      if (l) Object.assign(l, { state: 'cancelled', updatedAt: Date.now() });
    });
    rt.changed();
    return { bead_id: input.bead_id, review_id: record.id, cancelled: true };
  });
}

export async function recoverReviews(rt, host) {
  for (const saved of Object.values(rt.metadata.read().reviews || {})) {
    try { await withLock(`review:${saved.workBeadId}`, () => reconcileReview(rt, host, rt.metadata.read().reviews[saved.id])); }
    catch (err) { rt.log(`hive: review ${saved.id} recovery needs reconciliation: ${err.message}`); }
  }
}
