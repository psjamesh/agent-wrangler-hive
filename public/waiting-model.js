import { cellBeadIds, sessionLabel } from './model.js';
import { parseHiveLink } from './deep-links.js';
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

export const needsYouIncomplete = graph => (graph?.inbox?.items?.length || 0) >= 200;

function sessionBeads(ctx, cell, sid, ids) {
  const attached = [...ids].filter(id => ctx.hive.beads[id]?.ownerSessionId === sid || cell.bindings?.some(b => b.sessionId === sid && b.beadId === id));
  if (attached.length) return attached.sort();
  if (cell.queenSessionId === sid || cell.bindings?.some(b => b.sessionId === sid) || ctx.graph?.tasks?.assignments?.[sid] === cell.taskId) return [cell.rootBeadId];
  return [];
}

function requestTargets(ctx, item) {
  const links = String(item.body || '').match(/(?:https?:\/\/[^\s()<>#]+)?#view=ext:hive:overview&[^\s)<>]*/g) || [];
  const targets = [];
  for (const link of links) {
    if (!link.startsWith('#')) {
      try { if (globalThis.location && new URL(link).origin !== globalThis.location.origin) continue; } catch { continue; }
    }
    const target = parseHiveLink(link.slice(link.indexOf('#')));
    const cell = ctx.hive.cells[target?.cellId];
    if (!cell?.enabled || cell.snapshot) continue;
    const ids = cellBeadIds(ctx.hive, cell);
    const topic = cell.threads?.find(t => t.id === target.threadId);
    const message = cell.messages?.find(m => m.id === target.messageId);
    const beadId = target.beadId || cell.waitTargets?.messages?.[target.messageId] || message?.beadId || cell.waitTargets?.topics?.[target.threadId] || topic?.beadId || cell.rootBeadId;
    if (ids.has(beadId)) targets.push({ cellId: cell.id, beadId });
  }
  return targets;
}

export function cellWaitingItems(ctx, cell) {
  if (!cell?.enabled || cell.snapshot) return [];
  const ids = cellBeadIds(ctx.hive, cell);
  const items = (cell.waits || []).map(item => ({ ...item }));
  for (const request of Object.values(cell.requests || {})) {
    if (!needsHuman(request)) continue;
    items.push({ id: `request:${request.id}`, kind: 'request', cellId: cell.id, beadIds: [ids.has(request.beadId) ? request.beadId : cell.rootBeadId], title: request.title, reason: request.state === 'answered' ? 'Your answer needs delivery repair. Open the request to retry.' : 'Hive request awaiting your decision or action.', threadId: request.threadId, messageId: request.messageId });
  }
  const sessions = ctx.graph?.sessions || [];
  for (const s of sessions) {
    if (s.archived || s.status !== 'needs-you') continue;
    const beadIds = sessionBeads(ctx, cell, s.sessionId, ids);
    if (beadIds.length) items.push({ id: `agent:${s.sessionId}`, kind: 'agent', cellId: cell.id, beadIds, sessionId: s.sessionId, title: `${sessionLabel(ctx.graph, s.sessionId)} needs input`, reason: s.waitingReason || 'Open the session to answer its input request.' });
  }
  for (const item of ctx.graph?.inbox?.items || []) {
    if (item.source === 'status') {
      const session = sessions.find(s => s.sessionId === item.sessionId);
      if (session?.archived || (session?.status && session.status !== 'needs-you') || items.some(wait => wait.id === `agent:${item.sessionId}`)) continue;
    }
    if (item.state !== 'open' && !(item.state === 'answered' && item.answer?.delivery === 'failed')) continue;
    const targets = requestTargets(ctx, item);
    const beadIds = targets.length ? [...new Set(targets.filter(t => t.cellId === cell.id).map(t => t.beadId))] : sessionBeads(ctx, cell, item.sessionId, ids);
    if (beadIds.length) items.push({ id: `needsyou:${item.id}`, kind: 'needsyou', title: item.title, reason: item.state === 'answered' ? 'Your answer could not be delivered. Open Needs You to retry.' : 'Needs You request awaiting your decision or action.', cellId: cell.id, beadIds, sessionId: item.sessionId });
  }
  for (const pr of cell.pullRequests || []) {
    if (!['ready', 'stuck'].includes(prState(pr))) continue;
    items.push({ id: `pr:${pr.url}`, kind: 'pr', title: `#${pr.number} ${pr.title}`, reason: pr.humanAttention.reason, cellId: cell.id, beadIds: pr.beadIds, pr });
  }
  return [...new Map(items.map(item => [item.id, item])).values()].map(item => ({ ...item, beadIds: item.beadIds.filter(id => ids.has(id)) })).filter(item => item.beadIds.length);
}

export function waitingGraphKey(graph) {
  return JSON.stringify([graph?.inbox || null, graph?.tasks?.assignments || {}, (graph?.sessions || []).map(s => [s.sessionId, s.status, s.archived, s.waitingReason])]);
}
