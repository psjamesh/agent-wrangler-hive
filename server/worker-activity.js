const stamp = value => typeof value === 'number' && Number.isFinite(value) ? value : typeof value === 'string' ? Date.parse(value) || 0 : 0;

export function workerActivityIndex(rt, host) {
  const doc = rt.metadata.read();
  const activity = new Map(Object.entries(doc.workerActivity || {}).map(([sid, at]) => [sid, stamp(at)]));
  const record = (sid, at) => {
    if (sid) activity.set(sid, Math.max(activity.get(sid) || 0, stamp(at)));
  };
  for (const op of Object.values(doc.operations || {})) {
    if (op.state === 'applied' && op.actor?.startsWith('aw:') && op.beadIds?.length) record(op.actor.slice(3), op.updatedAt);
  }
  const recipients = new Set((host?.sessions?.list?.() || []).map(s => s.sessionId));
  for (const cell of rt.metadata.cells()) if (cell.queenSessionId) recipients.add(cell.queenSessionId);
  for (const bead of Object.values(rt.snapshots.graph.beads)) {
    if (bead.ownerSessionId) recipients.add(bead.ownerSessionId);
    for (const evidence of bead.evidence || []) {
      if (evidence.by?.startsWith('aw:')) record(evidence.by.slice(3), evidence.at);
    }
  }
  if (host?.mail?.list) for (const sid of recipients) {
    for (const mail of host.mail.list(sid)) record(mail.from, mail.at);
  }
  return activity;
}

export function workerLastActivity(session, bead, activity = new Map()) {
  return Math.max(stamp(session?.lastActivity), stamp(session?.createdAt), stamp(session?.relaunchedAt),
    stamp(bead?.updatedAt), activity.get(bead?.ownerSessionId) || 0);
}

export function saveWorkerActivity(rt, host, activity) {
  const next = {};
  for (const bead of Object.values(rt.snapshots.graph.beads)) {
    if (bead.status === 'closed' || !bead.ownerSessionId) continue;
    const sid = bead.ownerSessionId;
    next[sid] = Math.max(next[sid] || 0, workerLastActivity(host?.sessions?.get?.(sid), bead, activity));
  }
  if (JSON.stringify(next) !== JSON.stringify(rt.metadata.read().workerActivity || {})) {
    rt.metadata.mutate(d => { d.workerActivity = next; });
  }
}
