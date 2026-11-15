function line(value) {
  return String(value || '').split('\n').find(s => s.trim())?.trim().slice(0, 300) || '';
}

function time(value) {
  if (value === undefined || value === null || value === '') return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function actor(value) {
  return value?.startsWith('aw:') && value !== 'aw:human' && !value.startsWith('aw:hive-') ? value.slice(3) : value || null;
}

export function indexBeadHistory(doc) {
  const index = new Map();
  const record = id => {
    if (!index.has(id)) index.set(id, { workerLaunches: {}, bindings: { all: [] }, operations: {}, reviews: {}, pickupAttempts: doc.pickupAttempts });
    return index.get(id);
  };
  for (const [id, launch] of Object.entries(doc.workerLaunches || {})) record(launch.beadId).workerLaunches[id] = launch;
  for (const list of Object.values(doc.bindings || {})) for (const binding of list) record(binding.beadId).bindings.all.push(binding);
  for (const [id, op] of Object.entries(doc.operations || {})) for (const beadId of new Set(op.beadIds || [])) record(beadId).operations[id] = op;
  for (const [id, review] of Object.entries(doc.reviews || {})) record(review.workBeadId).reviews[id] = review;
  return index;
}

export function beadHistory(doc, bead) {
  const entries = [];
  const add = (id, at, by, outcome, reason) => entries.push({ id, at: time(at), by: actor(by), outcome, reason: line(reason) });
  const launches = Object.values(doc.workerLaunches || {}).filter(l => l.beadId === bead.id);
  const operations = Object.values(doc.operations || {}).filter(o => o.beadIds?.includes(bead.id) && (o.state === 'applied' || o.state === 'resolved' && o.verdict === 'applied'));
  const launchedIds = new Set(launches.map(l => l.id));
  const launchedSessions = new Set(launches.map(l => l.sessionId).filter(Boolean));
  for (const l of launches) {
    const at = l.createdAt ?? doc.pickupAttempts?.[l.armToken]?.at ?? l.updatedAt;
    add(`launch:${l.id}`, at, l.sessionId || l.requestedBy, `${l.reviewId ? 'Reviewer' : 'Worker'} launch: ${l.state || 'unknown'}`, l.error || l.reason);
    if (l.recoveredAt) add(`recovered:${l.id}`, l.recoveredAt, l.sessionId, 'Launch recovered', 'Startup confirmation recovered after interruption');
  }
  for (const list of Object.values(doc.bindings || {})) for (const b of list) {
    if (b.beadId !== bead.id) continue;
    const launched = launchedIds.has(b.workerLaunchId) || launchedSessions.has(b.sessionId);
    if (!launched) add(`binding:${b.id}`, b.at, b.sessionId, `Bound: ${b.role || 'worker'}`, b.note);
    if (b.unboundAt) add(`unbound:${b.id}`, b.unboundAt, b.unboundBy || b.sessionId, 'Unbound', b.unboundBecause || b.note);
  }
  const latestClosure = operations.filter(o => ['finish', 'reopen'].includes(o.kind)).sort((a, b) => (a.updatedAt || a.createdAt || 0) - (b.updatedAt || b.createdAt || 0)).at(-1);
  for (const o of operations) {
    if (o.kind === 'claim' && !o.result?.already) add(`claim:${o.id}`, o.createdAt, o.actor, 'Claimed', '');
    if (o.kind === 'finish') {
      const current = bead.status === 'closed' && o === latestClosure;
      add(`finish:${o.id}`, current ? bead.closedAt : o.updatedAt || o.createdAt, o.actor, `Closed: ${o.result?.outcome || o.intent?.outcome || (current && bead.outcome) || 'closed'}`, current ? bead.closeReason : '');
    }
    if (o.kind === 'reopen') add(`reopen:${o.id}`, o.updatedAt || o.createdAt, o.actor, 'Reopened', o.result?.reason);
    if (o.kind === 'release') add(`release:${o.id}`, o.updatedAt || o.createdAt, o.actor, 'Released', o.result?.reason);
  }
  const reviewLabels = new Set();
  for (const r of Object.values(doc.reviews || {})) {
    if (r.workBeadId !== bead.id) continue;
    for (const round of [...(r.history || []), r]) {
      const number = round.round || 1;
      const current = round === r;
      const v = !current || r.state === round.verdict?.value ? round.verdict : null;
      const state = v?.value || (current ? r.state : 'unknown');
      const at = v?.at || round.completedAt || (current ? number === 1 ? r.startedAt || r.createdAt : r.updatedAt : null);
      add(`review:${r.id}:${number}`, at, v?.by || r.reviewerSessionId || r.previousReviewerSessionId || r.requestedBy, `Review round ${number}: ${String(state || 'unknown').replaceAll('_', ' ')}`, v?.summary || round.waitingFor || round.summary);
      if (v) reviewLabels.add(`Review ${r.id}${number > 1 ? ` round ${number}` : ''}: ${v.value}`);
    }
  }
  for (const [i, e] of (bead.evidence || []).entries()) {
    if (!['handoff', 'handover', 'restart', 'merge', 'review', 'install-wait', 'merge-wait'].includes(e.kind) || reviewLabels.has(e.label)) continue;
    const outcome = { handoff: 'Handoff', handover: 'Handoff', restart: 'Restart', merge: 'Merged', review: e.label, 'install-wait': 'Waiting for installation', 'merge-wait': 'Waiting for merge' }[e.kind];
    add(`evidence:${i}`, e.at, e.by, outcome, e.detail || e.label);
  }
  if (bead.status === 'closed' && latestClosure?.kind !== 'finish') {
    add('closed', bead.closedAt, null, `Closed: ${bead.outcome || 'closed'}`, bead.closeReason);
  }
  return entries.sort((a, b) => (a.at === null) - (b.at === null) || String(a.at).localeCompare(String(b.at)) || a.id.localeCompare(b.id));
}
