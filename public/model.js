export function taskOf(graph, taskId) {
  return (graph?.tasks?.tasks || []).find((t) => t.id === taskId) || null;
}

export function taskName(graph, taskId) {
  return taskOf(graph, taskId)?.name || taskId;
}

export function cellName(graph, cell) {
  return taskOf(graph, cell.taskId)?.name || cell.snapshot?.taskName || cell.taskId;
}

export function sessionNode(graph, sessionId) {
  return (graph?.sessions || []).find((s) => s.sessionId === sessionId) || null;
}

export function sessionLabel(graph, sessionId) {
  const s = sessionNode(graph, sessionId);
  return s ? (s.name || s.label || sessionId.slice(0, 8)) : (sessionId ? `${sessionId.slice(0, 8)} (not on board)` : '');
}

export function sessionsInTask(graph, taskId) {
  const assignments = graph?.tasks?.assignments || {};
  return (graph?.sessions || []).filter((s) => assignments[s.sessionId] === taskId && !s.archived);
}

export function statusDot(graph, sessionId) {
  const s = sessionNode(graph, sessionId);
  if (!s) return 'gone';
  if (s.archived) return 'archived';
  if (s.status === 'working') return 'working';
  if (s.status === 'needs-you') return 'needs';
  if (s.exitOutput || s.status === 'exited') return 'exited';
  return 'idle';
}

export const STATUS_TEXT = {
  working: 'working',
  needs: 'waiting for input',
  idle: 'idle',
  exited: 'stopped',
  archived: 'archived',
  gone: 'not on the board',
};

// What the robot marker says about the sessions attached to an item: its
// owner and any bound sessions, each counted once. `busy` only when AW
// reports one of them working right now; an archived session counts as
// stopped whatever status it last had. The text names each session's state.
export function agentSummary(graph, sessionIds, role = 'Agent') {
  const ids = [...new Set(sessionIds.filter(Boolean))];
  if (!ids.length) return null;
  const states = ids.map((sid) => ({ sid, dot: statusDot(graph, sid) }));
  const has = (d) => states.some((s) => s.dot === d);
  const state = has('working') ? 'busy' : has('needs') ? 'needs' : has('idle') ? 'idle' : 'stopped';
  let text;
  if (ids.length === 1) {
    text = `${role} ${sessionLabel(graph, ids[0])}: ${STATUS_TEXT[states[0].dot]}`;
  } else {
    const counts = {};
    for (const s of states) counts[s.dot] = (counts[s.dot] || 0) + 1;
    const parts = ['working', 'needs', 'idle', 'exited', 'archived', 'gone'].filter((d) => counts[d]).map((d) => `${counts[d]} ${STATUS_TEXT[d]}`);
    text = `${ids.length} agents attached (${parts.join(', ')}): ${states.map((s) => `${sessionLabel(graph, s.sid)} ${STATUS_TEXT[s.dot]}`).join('; ')}`;
  }
  return { state, count: ids.length, text, dots: states.map((s) => s.dot) };
}

// The same marker for a captured snapshot: always historical, never busy,
// whatever the session was doing when the board was captured.
export function capturedAgentSummary(refs, role = 'Captured session') {
  const list = refs.filter(Boolean);
  if (!list.length) return null;
  const one = (r) => `${r.label || 'unnamed'}, ${r.status || 'unknown'} when captured`;
  return {
    state: 'historical',
    count: list.length,
    dots: [],
    text: `${role}${list.length > 1 ? 's' : ''} (historical, not live): ${list.map(one).join('; ')}`,
  };
}

export function childrenMap(beads) {
  const map = new Map();
  for (const b of Object.values(beads)) {
    if (!b.parentId) continue;
    if (!map.has(b.parentId)) map.set(b.parentId, []);
    map.get(b.parentId).push(b);
  }
  return map;
}

export function cellBeadIds(hive, cell) {
  const out = new Set();
  if (!cell.rootBeadId || !hive.beads[cell.rootBeadId]) return out;
  const kids = childrenMap(hive.beads);
  const stack = [cell.rootBeadId];
  while (stack.length) {
    const id = stack.pop();
    if (out.has(id)) continue;
    out.add(id);
    for (const c of kids.get(id) || []) stack.push(c.id);
  }
  return out;
}

export function waitingOn(hive, beadId) {
  return hive.edges
    .filter((e) => e.dependent === beadId && e.blocking && hive.beads[e.prerequisite] && hive.beads[e.prerequisite].status !== 'closed')
    .map((e) => e.prerequisite);
}

export function displayStatus(bead) {
  return ['requested', 'in_review'].includes(bead.reviewState) ? 'in_review' : bead.status;
}

export function recordedWait(bead) {
  return String(bead.waitingFor || '').trim();
}

export function cellCounts(hive, cell) {
  const counts = { open: 0, in_progress: 0, in_review: 0, blocked: 0, waiting: 0, closed: 0, total: 0 };
  for (const id of cellBeadIds(hive, cell)) {
    if (id === cell.rootBeadId) continue;
    const b = hive.beads[id];
    counts.total += 1;
    if (displayStatus(b) === 'in_review') counts.in_review += 1;
    else if (b.status === 'closed') counts.closed += 1;
    else if (b.status === 'in_progress') counts.in_progress += 1;
    else if (b.status === 'blocked') counts.blocked += 1;
    else counts.open += 1;
    if (b.status !== 'closed' && waitingOn(hive, id).length) counts.waiting += 1;
  }
  return counts;
}

export function workCounts(hive, kids, beadId) {
  const counts = { open: 0, in_progress: 0, in_review: 0, blocked: 0, closed: 0, total: 0 };
  const seen = new Set([beadId]);
  const stack = [...(kids.get(beadId) || [])];
  while (stack.length) {
    const b = stack.pop();
    if (seen.has(b.id)) continue;
    seen.add(b.id);
    counts.total += 1;
    if (displayStatus(b) === 'in_review') counts.in_review += 1;
    else if (b.status === 'closed') counts.closed += 1;
    else if (b.status === 'in_progress') counts.in_progress += 1;
    else if (b.status === 'blocked') counts.blocked += 1;
    else counts.open += 1;
    stack.push(...(kids.get(b.id) || []));
  }
  return counts;
}

export function countsSentence(c) {
  if (!c.total) return 'No work yet';
  const parts = [];
  if (c.in_progress) parts.push(`${c.in_progress} in progress`);
  if (c.in_review) parts.push(`${c.in_review} in review`);
  if (c.blocked) parts.push(`${c.blocked} blocked`);
  if (c.open) parts.push(`${c.open} open`);
  parts.push(`${c.closed} of ${c.total} closed`);
  return parts.join(', ');
}

export function isDone(bead) {
  return bead?.status === 'closed' && bead.outcome === 'done';
}

export function closedLabel(bead) {
  if (bead.outcome === 'done') return 'Done';
  return bead.outcome ? `Closed, ${bead.outcome}` : 'Closed';
}
