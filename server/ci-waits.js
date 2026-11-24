import { requireBeadAccess } from './access.js';
import { HiveError } from './ops.js';
import { newId } from './metadata-store.js';
import { isCurrent, runtimeKey } from './lifetime.js';
import { evaluatePostMerge, observePostMerge } from './post-merge-ci.js';
import { prRepository, runGh } from './pr-labels.js';
import { safeDeliver } from './sessions.js';
import { monitoringProblem } from './monitoring.js';

const FRESH_MS = 180000;
const ACK_MS = 300000;
const SHA = /^[a-f0-9]{40}$/i;
const TARGETS = ['checks', 'check', 'mergeable', 'merge', 'post-merge'];
const stamp = value => typeof value === 'number' ? value : Date.parse(value) || 0;
const line = value => typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, 500) : '';
const inflight = new WeakMap();
const activeWakes = new WeakMap();

function observation(host, url) {
  try { return host?.links?.prObservation?.(url) || null; } catch { return null; }
}

function registrationRecord(rt, host, bead, cell, url, now) {
  const record = rt.metadata.read().prLabels?.[url];
  if (record?.associations?.some(a => a.cellId === cell.id && a.beadId === bead.id)) return record;
  let linked = false;
  try { linked = Boolean(bead.ownerSessionId && host?.links?.get?.(bead.ownerSessionId)?.some(link => link.type === 'pr' && link.url === url)); } catch {}
  const evidenced = bead.evidence?.some(entry => entry.kind === 'pr' && entry.url === url);
  if (!linked && !evidenced) throw new HiveError('Choose a known PR associated with this bead, or link it to the claimant session or record PR evidence on the bead.');
  return {
    url, source: linked ? 'session-link' : 'bead-evidence', sessionId: linked ? bead.ownerSessionId : null,
    firstSeenAt: now, enrolledAt: now, status: 'pending', labelledAt: null, state: null, stateCheckedAt: null,
    ...record,
    cellIds: [...new Set([...(record?.cellIds || []), cell.id])],
    beadIds: [...new Set([...(record?.beadIds || []), bead.id])],
    associations: [...(record?.associations || []), { cellId: cell.id, beadId: bead.id, kind: linked ? 'session-link' : 'bead-evidence' }],
  };
}

function checkOutcome(row) {
  const value = String(row.state || (row.status === 'COMPLETED' ? row.conclusion : row.status) || '').toUpperCase();
  if (['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(value)) return 'success';
  if (value === 'CANCELLED') return 'cancelled';
  if (value === 'ACTION_REQUIRED') return 'action-required';
  if (['FAILURE', 'ERROR', 'TIMED_OUT', 'STARTUP_FAILURE', 'STALE'].includes(value)) return 'failure';
  return null;
}

function evaluateObservation(wait, observed, now) {
  if (!observed || observed.url !== wait.url || !observed.state) return { unavailable: 'No shared PR observation. Link the PR to a session or task so core observes it.' };
  if (observed.lastError) return { unavailable: 'Core could not refresh the PR. Restore GitHub access and verify the linked PR.' };
  if (!stamp(observed.fetchedAt) || (observed.state !== 'merged' && now - stamp(observed.fetchedAt) > FRESH_MS)) return { unavailable: 'Shared PR observation is stale. Keep the PR linked and restore core observation.' };
  if (!observed.nodeId || !SHA.test(observed.headSha || '')) return { unavailable: 'Shared PR identity or head is unavailable.' };
  if ((wait.nodeId && observed.nodeId !== wait.nodeId) || observed.headSha.toLowerCase() !== wait.headSha.toLowerCase()) {
    return stamp(observed.fetchedAt) > wait.createdAt ? { outcome: 'superseded' } : {};
  }
  if (observed.state === 'closed') return { outcome: 'cancelled' };
  const merged = observed.state === 'merged';
  if (merged && ['merge', 'mergeable'].includes(wait.target)) return { outcome: 'success' };
  if (observed.state !== 'open' && !merged) return { unavailable: 'Unknown PR state requires reconciliation.' };
  if (wait.target === 'merge') return {};
  if (wait.target === 'mergeable') {
    if (observed.checkStatus === 'passing' && observed.isDraft === false) return { outcome: 'success' };
    if (observed.checkStatus !== 'failing') return {};
  }
  const unfinished = () => merged ? { outcome: 'reconciliation-required' } : {};
  let rows = observed.statusCheckRollup;
  if (!Array.isArray(rows)) return merged ? unfinished() : { unavailable: 'Shared check rollup is unavailable.' };
  if (!rows.length) return unfinished();
  if (wait.target === 'check') {
    rows = rows.filter(row => (row?.name || row?.context) === wait.checkName);
    if (!rows.length) return unfinished();
    if (rows.length !== 1) return merged ? unfinished() : { unavailable: `Selected check ${wait.checkName} is ambiguous; choose a unique check name.` };
  }
  const outcomes = rows.map(row => row && checkOutcome(row));
  if (wait.desiredOutcome === 'completed' && outcomes.some(outcome => !outcome)) return unfinished();
  const outcome = ['failure', 'action-required', 'cancelled'].find(value => outcomes.includes(value));
  if (outcome) return { outcome };
  if (wait.target !== 'mergeable' && outcomes.every(value => value === 'success')) return { outcome: 'success' };
  return unfinished();
}

export function evaluateCiWait(wait, observed, now = Date.now()) {
  const result = wait.target === 'post-merge' ? evaluatePostMerge(wait, now) : evaluateObservation(wait, observed, now);
  if (result.outcome) return result;
  return now < wait.deadline ? result : { outcome: 'overdue' };
}

function waitFor(rt, beadId) { return rt.metadata.read().ciWaits?.[beadId]; }

export function settleClosedBeadWait(rt, beadId, now = Date.now()) {
  const wait = waitFor(rt, beadId);
  if (!wait || wait.acknowledgedAt) return;
  rt.metadata.mutate(doc => {
    const saved = doc.ciWaits[beadId];
    if (saved.state === 'pending') Object.assign(saved, { state: 'resolved', outcome: 'cancelled', resolvedAt: now });
    Object.assign(saved, { acknowledgedAt: now, settledReason: 'Bead closed' });
  });
  rt.changed();
}

export function reportCiWait(rt, host, actor, args, now = Date.now()) {
  const { bead, cell, role } = requireBeadAccess(rt, actor, args.bead_id);
  if (!['queen', 'coordinator'].includes(role) && bead.ownerSessionId !== actor.sessionId) throw new HiveError('Only the claimant, queen or coordinator can report a CI wait.');
  if (!cell.enabled || cell.snapshot || (bead.status === 'closed' && args.state !== 'acknowledge')) throw new HiveError('CI waits require an open bead in a live hive.');
  const current = waitFor(rt, bead.id);
  if (['acknowledge', 'retry-wake', 'cancel-wait'].includes(args.state)) {
    if (!current || args.wait_id !== current.id) throw new HiveError('Use the current exact wait_id from hive_context.');
    if (args.state !== 'cancel-wait' && current.state !== 'resolved') throw new HiveError('Only a resolved wait can be acknowledged or its wake retried.');
    if (args.state === 'retry-wake' && activeWakes.get(runtimeKey(rt))?.has(current.id)) throw new HiveError('Wake delivery is still in flight; reconcile its receipt before retrying.');
    if (args.state === 'retry-wake' && (current.acknowledgedAt || !['failed', 'uncertain', 'sending'].includes(current.wake?.state))) throw new HiveError('Only a failed or uncertain unacknowledged wake can be retried.');
    rt.metadata.mutate(doc => {
      const saved = doc.ciWaits[bead.id];
      if (args.state === 'acknowledge') saved.acknowledgedAt = now;
      else if (args.state === 'retry-wake') delete saved.wake;
      else if (saved.state === 'pending') Object.assign(saved, { state: 'resolved', outcome: 'cancelled', resolvedAt: now });
    });
  } else {
    if (args.state !== 'wait') throw new HiveError('Unknown CI wait state.');
    if (['run_id', 'attempt', 'workflow', 'workflow_id'].some(key => args[key] !== undefined) || !TARGETS.includes(args.target)) throw new HiveError('Select checks, check, mergeable, merge or post-merge. Run, attempt and workflow identity waits are unsupported by core observations.');
    if (!SHA.test(args.head_sha || '') || !prRepository(args.url)) throw new HiveError('Give a canonical PR URL and its full head SHA.');
    const record = registrationRecord(rt, host, bead, cell, args.url, now);
    if (!bead.ownerSessionId) throw new HiveError('A CI wait requires a responsible claimant.');
    if (!line(args.reason)) throw new HiveError('Give the purpose of the wait in reason.');
    if (!['success', 'completed'].includes(args.desired_outcome) || (['merge', 'mergeable', 'post-merge'].includes(args.target) && args.desired_outcome !== 'success')) throw new HiveError('desired_outcome must be success, or completed for a check target.');
    if (args.target === 'check' ? !line(args.check_name) : args.check_name !== undefined) throw new HiveError('check_name is required only for a named check target.');
    if (args.workflow_name !== undefined && (args.target !== 'post-merge' || !line(args.workflow_name))) throw new HiveError('workflow_name is supported only for post-merge waits.');
    const deadline = Date.parse(args.deadline);
    if (!/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(args.deadline || '') || !Number.isFinite(deadline) || deadline <= now) throw new HiveError('Give a future deadline with an explicit timezone.');
    const next = { beadId: bead.id, cellId: cell.id, sessionId: bead.ownerSessionId, url: args.url, headSha: args.head_sha.toLowerCase(), target: args.target, workflowName: args.workflow_name === undefined ? undefined : args.workflow_name.trim(), checkName: args.check_name, desiredOutcome: args.desired_outcome, purpose: line(args.reason), deadline };
    const same = current && Object.entries(next).every(([key, value]) => current[key] === value);
    if (current && !current.acknowledgedAt && !same) throw new HiveError('Acknowledge the previous outcome, or cancel the pending wait and acknowledge it before replacing it.');
    rt.metadata.mutate(doc => {
      (doc.prLabels ||= {})[args.url] = record;
      if (!same || current.acknowledgedAt) (doc.ciWaits ||= {})[bead.id] = { ...next, id: newId('ciwait'), nodeId: record.nodeId || null, createdAt: now, state: 'pending' };
    });
  }
  rt.changed();
  return reconcileCiWaits(rt, host, now).then(() => ({ ...waitFor(rt, bead.id) }));
}

function ownerProblem(rt, host, wait) {
  const bead = rt.snapshots.graph.beads[wait.beadId];
  if (!bead || bead.status === 'closed' || bead.ownerSessionId !== wait.sessionId) return 'The responsible worker no longer owns this open bead.';
  const session = host?.sessions?.get?.(wait.sessionId);
  if (!session || session.archived || ['snoozed', 'exited', 'error', 'errored'].includes(session.status)) return 'The responsible worker is unavailable; the queen must reconcile this wait.';
  return null;
}

async function deliverWake(rt, host, wait, now) {
  if (wait.acknowledgedAt || wait.wake || ownerProblem(rt, host, wait)) return;
  rt.metadata.mutate(doc => { doc.ciWaits[wait.beadId].wake = { state: 'sending', at: now }; });
  const sending = activeWakes.get(runtimeKey(rt)) || new Set();
  activeWakes.set(runtimeKey(rt), sending);
  sending.add(wait.id);
  let timer;
  let receipt;
  try {
    receipt = await Promise.race([
      safeDeliver(host, wait.sessionId, `[Hive] CI wait ${wait.id} for bead ${wait.beadId}: ${wait.outcome}. PR ${wait.url}, expected head ${wait.headSha}, target ${wait.target}${wait.checkName ? ` (${wait.checkName})` : ''}. Purpose: ${wait.purpose}. ${wait.resultDetail ? `${wait.resultDetail} ` : ''}Read hive_context, verify the outcome, then call hive_report_pr_wait with bead_id, state: "acknowledge", wait_id: "${wait.id}". Continue only the authorized work; this notice does not authorize merge or deployment.`, rt),
      new Promise(resolve => { timer = setTimeout(() => resolve({ state: 'uncertain', error: 'Wake delivery timed out; it may still arrive.' }), 15000); timer.unref?.(); }),
    ]);
  } finally { clearTimeout(timer); sending.delete(wait.id); }
  if (!isCurrent(rt, host)) return;
  rt.metadata.mutate(doc => {
    const saved = doc.ciWaits[wait.beadId];
    if (saved?.id === wait.id && saved.wake?.at === now) Object.assign(saved.wake, receipt);
  });
  rt.changed();
}

async function reconcilePass(rt, host, now) {
  if (!isCurrent(rt, host) || rt.metadata.error || rt.snapshots.hierarchyCurrent === false || rt.snapshots.current?.error || !rt.snapshots.current?.loadedAt || rt.beads?.status?.state !== 'ready') return;
  for (const initial of Object.values(rt.metadata.read().ciWaits || {})) {
    if (!isCurrent(rt, host)) return;
    const cell = rt.metadata.cell(initial.cellId);
    if (!cell || cell.snapshot) continue;
    if (!rt.snapshots.graph.beads[initial.beadId]) {
      rt.metadata.mutate(doc => { delete doc.ciWaits[initial.beadId]; });
      rt.changed();
      continue;
    }
    if (rt.snapshots.graph.beads[initial.beadId]?.status === 'closed') {
      settleClosedBeadWait(rt, initial.beadId, now);
      continue;
    }
    if (!cell.enabled || initial.acknowledgedAt) continue;
    let wait = waitFor(rt, initial.beadId);
    const problem = ownerProblem(rt, host, wait);
    if (wait.state === 'pending') {
      if (wait.target === 'post-merge' && now - (wait.postMerge?.attemptedAt || 0) >= 60000) {
        let postMerge;
        try { postMerge = { ...await observePostMerge(wait, rt.ciGh || runGh, now), attemptedAt: now }; }
        catch { postMerge = { ...wait.postMerge, attemptedAt: now, error: true }; }
        if (!isCurrent(rt, host)) return;
        const current = waitFor(rt, wait.beadId);
        if (current?.id !== wait.id || current.state !== 'pending' || current.acknowledgedAt) continue;
        rt.metadata.mutate(doc => { doc.ciWaits[wait.beadId].postMerge = postMerge; });
        wait = waitFor(rt, wait.beadId);
        rt.changed();
      }
      const observed = wait.target === 'post-merge' ? null : observation(host, wait.url);
      const result = evaluateCiWait(wait, observed, now);
      const patch = { observerProblem: result.unavailable || null };
      if (!wait.nodeId && observed?.nodeId && !observed.lastError) patch.nodeId = observed.nodeId;
      if (result.outcome) Object.assign(patch, { state: 'resolved', outcome: result.outcome, resultDetail: result.detail, resolvedAt: now });
      if (Object.entries(patch).some(([key, value]) => wait[key] !== value)) {
        rt.metadata.mutate(doc => { Object.assign(doc.ciWaits[wait.beadId], patch); });
        wait = waitFor(rt, wait.beadId);
        rt.changed();
      }
    }
    if (wait.state === 'resolved' && !problem) {
      await deliverWake(rt, host, wait, now);
    }
  }
}

export function reconcileCiWaits(rt, host = rt.host, now = Date.now()) {
  const active = inflight.get(runtimeKey(rt));
  if (active) { active.again = true; active.now = now; return active.promise; }
  const entry = { again: true, now };
  entry.promise = (async () => {
    while (entry.again) {
      entry.again = false;
      await reconcilePass(rt, host, entry.now);
    }
  })().finally(() => inflight.delete(runtimeKey(rt)));
  inflight.set(runtimeKey(rt), entry);
  return entry.promise;
}

export function ciWaitSuppresses(rt, host, bead, now = Date.now()) {
  const wait = waitFor(rt, bead.id);
  return Boolean(wait?.state === 'pending' && wait.sessionId === bead.ownerSessionId && !ownerProblem(rt, host, wait)
    && !Object.keys(evaluateCiWait(wait, observation(host, wait.url), now)).length && now < wait.deadline);
}

export function ciWaitAttention(rt, cell, now = Date.now()) {
  const flags = [];
  const monitoring = monitoringProblem(rt);
  for (const wait of Object.values(rt.metadata.read().ciWaits || {})) {
    const bead = rt.snapshots.graph.beads[wait.beadId];
    if (wait.cellId !== cell.id || wait.acknowledgedAt) continue;
    const add = (kind, reason) => flags.push({ kind, wait_id: wait.id, bead_id: wait.beadId, session_id: wait.sessionId, since: kind === 'ci_wait_unavailable' ? now : wait.resolvedAt || wait.createdAt, reason });
    if (monitoring) { add('ci_wait_unavailable', monitoring); continue; }
    if (!bead || bead.status === 'closed') continue;
    const problem = ownerProblem(rt, rt.host, wait);
    if (wait.state === 'pending') {
      const result = evaluateCiWait(wait, observation(rt.host, wait.url), now);
      if (result.outcome === 'overdue') add('ci_wait_overdue', 'CI wait deadline passed; reconcile the selected target.');
      else if (problem || result.unavailable) add('ci_wait_unavailable', problem || result.unavailable);
    } else {
      if (wait.outcome === 'overdue') add('ci_wait_overdue', 'CI wait deadline passed; worker must reconcile the selected target.');
      if (problem || ['unavailable', 'reconciliation-required'].includes(wait.outcome)) add('ci_wait_unavailable', problem || wait.observerProblem || 'Merged PR does not establish the selected check outcome; reconcile its retained evidence.');
      if (!activeWakes.get(runtimeKey(rt))?.has(wait.id) && (problem || ['sending', 'uncertain', 'failed'].includes(wait.wake?.state) || !wait.wake)) add('ci_wait_delivery', 'Finished CI wait needs queen attention: worker wake is unavailable or uncertain. Inspect the worker before retry-wake with the exact wait_id.');
      else if (now - (wait.wake.at || wait.resolvedAt) >= ACK_MS) add('ci_wait_unacknowledged', 'Finished CI wait has no worker acknowledgement. Inspect the worker and reconcile its continuation.');
    }
  }
  return flags;
}

export function startCiWaits(rt, host, now = Date.now) {
  const reconcile = () => reconcileCiWaits(rt, host, now())
    .then(() => { if (isCurrent(rt, host)) rt.watchdog?.schedule(); })
    .catch(err => rt.log(`hive: CI wait reconciliation failed: ${err.message}`));
  const stop = host.events?.on('pr:observation', reconcile);
  const timer = setInterval(reconcile, 60000);
  timer.unref?.();
  void reconcile();
  return () => { clearInterval(timer); stop?.(); };
}
