import { requestDisplay } from './request-state.js';
import { cellBeadIds, sessionLabel, queenNeedsAttention, queenNotResponding, queenStopped, queenSuspended } from './model.js';
import { needsHuman } from './requests.js';

export function prState(pr, now = Date.now()) {
  if (pr.state === 'MERGED' || pr.state === 'CLOSED') return pr.state.toLowerCase();
  if (pr.observationError || !Number.isFinite(pr.stateCheckedAt) || now - pr.stateCheckedAt > 180000) return 'stale';
  const report = pr.humanAttention;
  if (pr.state !== 'OPEN' || !report || !pr.headSha || report.headSha !== pr.headSha) return 'working';
  if (report.state === 'cannot-fix') return 'stuck';
  if (report.state === 'ready' && pr.isDraft === false && pr.checks === 'green' && pr.reviewDecision !== 'CHANGES_REQUESTED' && pr.mergeable !== 'CONFLICTING') return 'ready';
  return 'working';
}

function sessionBeads(ctx, cell, sid, ids) {
  const attached = [...ids].filter(id => ctx.hive.beads[id]?.ownerSessionId === sid || cell.bindings?.some(b => b.sessionId === sid && b.beadId === id));
  if (attached.length) return attached.sort();
  if (cell.queenSessionId === sid || cell.bindings?.some(b => b.sessionId === sid) || ctx.graph?.tasks?.assignments?.[sid] === cell.taskId) return [cell.rootBeadId];
  return [];
}

export function cellWaitingItems(ctx, cell) {
  if (!cell || cell.retired || cell.snapshot) return [];
  const ids = cellBeadIds(ctx.hive, cell);
  const items = [];
  for (const request of Object.values(cell.requests || {})) {
    if (!needsHuman(request)) continue;
    items.push({ id: `request:${request.id}`, kind: 'request', cellId: cell.id, beadIds: [ids.has(request.beadId) ? request.beadId : cell.rootBeadId], title: requestDisplay(request).title, reason: request.state === 'answered' ? 'Your answer needs delivery repair. Open the request to retry.' : 'Hive request awaiting your decision or action.', threadId: request.threadId, messageId: request.messageId, repair: request.state === 'answered' });
  }
  if (!cell.enabled) return items;
  const sessions = ctx.graph?.sessions || [];
  for (const s of sessions) {
    const stopped = s.sessionId === cell.queenSessionId && queenStopped(ctx.graph, cell);
    const unresponsive = s.sessionId === cell.queenSessionId && queenNotResponding(ctx.graph, cell);
    const queenAttention = s.sessionId === cell.queenSessionId && queenNeedsAttention(ctx.graph, cell);
    if ((s.archived && !stopped) || (s.status !== 'needs-you' && !queenAttention)) continue;
    const beadIds = sessionBeads(ctx, cell, s.sessionId, ids);
    if (beadIds.length) items.push({ id: `agent:${s.sessionId}`, kind: 'agent', cellId: cell.id, beadIds, sessionId: s.sessionId, title: stopped && queenSuspended(ctx.graph, cell) ? 'Queen stopped or suspended' : stopped ? 'Queen stopped' : unresponsive ? 'Queen not responding' : queenAttention ? 'Queen needs attention' : `${sessionLabel(ctx.graph, s.sessionId)} needs input`, reason: stopped && queenSuspended(ctx.graph, cell) ? 'The queen may be suspended with unanswered input. Resume its session card on the board.' : stopped ? 'The queen has stopped with unanswered input. Resume or restore its session card on the board, or arrange a queen handoff.' : unresponsive ? 'Pending input has had no queen activity. Open the queen session to check.' : s.waitingReason || 'Open the session to answer its input request.' });
  }
  for (const pr of cell.pullRequests || []) {
    if (pr.evidenceOnly || !['ready', 'stuck'].includes(prState(pr))) continue;
    items.push({ id: `pr:${pr.url}`, kind: 'pr', title: `#${pr.number} ${pr.title}`, reason: pr.humanAttention.reason, cellId: cell.id, beadIds: pr.beadIds, pr });
  }
  return [...new Map(items.map(item => [item.id, item])).values()].map(item => ({ ...item, beadIds: item.beadIds.filter(id => ids.has(id)) })).filter(item => item.beadIds.length);
}

export function waitingGraphKey(graph) {
  return JSON.stringify([graph?.tasks?.assignments || {}, (graph?.sessions || []).map(s => [s.sessionId, s.status, s.archived, s.waitingReason, s.dormant, s.exitOutput, s.lastActivity, s.createdAt, s.relaunchedAt])]);
}
