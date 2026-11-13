import { awaitingHuman, humanConversationDoc } from './conversation.js';
import { requireBeadAccess } from './access.js';
import { HiveError } from './ops.js';
import { prRepository } from './pr-labels.js';

const line = value => String(value || '').replace(/\s+/g, ' ').trim().slice(0, 500);

export function reportPrWait(rt, actor, args) {
  const { bead, cell, role } = requireBeadAccess(rt, actor, args.bead_id);
  if (!['queen', 'coordinator'].includes(role) && bead.ownerSessionId !== actor.sessionId) throw new HiveError('Only the claimant, queen or coordinator can report a PR wait.');
  const record = rt.metadata.read().prLabels?.[args.url];
  if (!record || !prRepository(args.url)) throw new HiveError('Choose a known recorded PR URL.');
  if (!record.associations?.some(a => a.cellId === cell.id && a.beadId === bead.id)) throw new HiveError('The PR is not associated with this bead.');
  if (!/^[a-f0-9]{40}$/i.test(args.head_sha) || record.headSha !== args.head_sha) throw new HiveError('The full head SHA must match the latest observed PR head.');
  if (!['ready', 'cannot-fix', 'clear'].includes(args.state)) throw new HiveError('Unknown PR wait state.');
  if (args.state !== 'clear' && !line(args.reason)) throw new HiveError('Give a one-line reason for the human wait.');
  if (record.state !== 'OPEN') throw new HiveError('Only an open PR can receive a wait report.');
  const report = args.state === 'clear' ? null : { state: args.state, headSha: args.head_sha, reason: line(args.reason), actor: actor.sessionId, beadId: bead.id, at: Date.now() };
  rt.metadata.mutate(doc => { doc.prLabels[args.url].humanAttention = report; });
  rt.changed();
  return { url: args.url, state: report?.state || 'clear', head_sha: args.head_sha };
}

export function waitingProjection(rt, cell, beadIds) {
  if (!cell.enabled || cell.snapshot) return { waits: [], pullRequests: [], waitTargets: { messages: {}, topics: {} } };
  const doc = humanConversationDoc(rt.metadata.read(), cell.id);
  const waits = (doc.conversation[cell.id] || []).filter(awaitingHuman).map(m => {
    const topic = doc.threads?.[cell.id]?.[m.threadId];
    const beadId = beadIds.has(m.beadId) ? m.beadId : beadIds.has(topic?.beadId) ? topic.beadId : cell.rootBeadId;
    return { id: `message:${m.id}`, kind: 'message', title: line(m.text), reason: 'Hive message awaiting your acknowledgement (read, react or reply).', beadIds: [beadId], cellId: cell.id, messageId: m.id, threadId: m.threadId, at: m.at };
  });
  const pullRequests = Object.values(doc.prLabels || {}).filter(r => prRepository(r?.url)).flatMap(r => {
    const ids = [...new Set((r.associations || []).filter(a => a.cellId === cell.id && beadIds.has(a.beadId)).map(a => a.beadId))];
    if (!ids.length) return [];
    return [{ url: r.url, number: r.number || Number(r.url.split('/').at(-1)), title: r.title || r.url, state: r.state, headSha: r.headSha || null, checks: r.checks || 'unknown', isDraft: r.isDraft !== false, reviewDecision: r.reviewDecision || null, mergeable: r.mergeable || null, mergeStateStatus: r.mergeStateStatus || null, stateCheckedAt: r.stateCheckedAt ?? null, observationError: r.observationError || null, humanAttention: r.humanAttention || null, beadIds: ids, cellId: cell.id }];
  });
  const topics = Object.fromEntries(Object.values(doc.threads?.[cell.id] || {}).map(t => [t.id, beadIds.has(t.beadId) ? t.beadId : cell.rootBeadId]));
  const messages = Object.fromEntries((doc.conversation[cell.id] || []).map(m => [m.id, beadIds.has(m.beadId) ? m.beadId : topics[m.threadId] || cell.rootBeadId]));
  return { waits, pullRequests, waitTargets: { messages, topics } };
}
