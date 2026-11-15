import { OPEN_REVIEW_STATES } from './review-state.js';

const NEGATION = /\b(?:no|not|never|without)\b|n't/i;
const NOT_NEEDED = /\b(?:not|never)\s+(?:be\s+)?(?:required|needed|necessary|waiting)\b|n't\s+(?:be\s+)?(?:required|needed|necessary)\b|\bno longer\b|\bunnecessary\b/i;
const HUMAN_PREFIX = /^human\s*:/i;
const HUMAN_NOUN = /^human\s+(?:decision|approval|input|confirmation)(?![\w-])/i;
const WAITING_ON_HUMAN = /\b(?:waiting|blocked|awaiting)\s+(?:(?:on|for)\s+)?(?:the\s+)?human(?![\w-])/i;

const NEEDS_HUMAN = /\b(?:needs?|requires?|obtain|get|seek)\s+(?:the\s+)?human(?:['’]s)?\s+(?:go-ahead|approval|decision|input|confirmation)(?![\w-])/i;
const HUMAN_MUST_ACT = /\bhuman\s+(?:must|needs?\s+to|has\s+to)\s+(?:approve|decide|confirm|choose|give\s+(?:the\s+)?go-ahead)(?![\w-])/i;

export function waitsOnHuman(text) {
  if (typeof text !== 'string') return false;
  return text.split(/[.!?;,\n]+|\bbut\b/i).some(raw => {
    const clause = raw.trim();
    if (HUMAN_PREFIX.test(clause)) return true;
    if (NOT_NEEDED.test(clause)) return false;
    if (HUMAN_NOUN.test(clause)) return true;
    const match = WAITING_ON_HUMAN.exec(clause) || NEEDS_HUMAN.exec(clause) || HUMAN_MUST_ACT.exec(clause);
    return Boolean(match) && !NEGATION.test(clause.slice(0, match.index));
  });
}

export function humanWaitText(bead) {
  if (waitsOnHuman(bead.waitingFor)) return bead.waitingFor;
  if (waitsOnHuman(bead.nextAction)) return bead.nextAction;
  return null;
}

export function hasOpenRequest(doc, cellId, beadId) {
  return Object.values(doc.requests || {}).some(r => r.state === 'open' && r.cellId === cellId && r.beadId === beadId);
}

export function hasBlockingPrerequisite(graph, beadId) {
  return (graph.edges || []).some(e => e.dependent === beadId && e.blocking && graph.beads[e.prerequisite] && graph.beads[e.prerequisite].status !== 'closed');
}

export function hasOpenReview(doc, cellId, beadId) {
  return Object.values(doc.reviews || {}).some(r => r.cellId === cellId && r.workBeadId === beadId && OPEN_REVIEW_STATES.has(r.state));
}

export const HUMAN_WAIT_WARNING = 'This bead waits on the human but no hive_request_input is open for it, so the human has not been asked. Raise hive_request_input with bead_id in the same step.';
