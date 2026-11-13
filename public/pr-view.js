import { h } from './dom.js';
import { prState } from './waiting-model.js';

export { prState } from './waiting-model.js';
const submittedRequests = new WeakMap();

export function beadPullRequests(ctx, bead) {
  return Object.values(ctx.hive.cells).flatMap(cell => cell.pullRequests || []).filter(pr => pr.beadIds.includes(bead.id));
}

export function prSummary(prs) {
  const open = [...new Map(prs.map(pr => [pr.url, pr])).values()].filter(pr => !['merged', 'closed'].includes(prState(pr)));
  const needs = open.filter(pr => ['ready', 'stuck'].includes(prState(pr))).length;
  return open.length ? `${open.length} open PR${open.length === 1 ? '' : 's'}, ${needs} waiting for you` : '';
}

export function pullRequestRow(ctx, bead, pr) {
  const state = prState(pr);
  const cell = ctx.hive.cells[pr.cellId];
  if (!submittedRequests.has(ctx.ui)) submittedRequests.set(ctx.ui, new Set());
  const submitted = submittedRequests.get(ctx.ui);
  const requestKey = JSON.stringify([pr.cellId, bead.id, pr.url, pr.headSha, pr.humanAttention?.at]);
  const sent = h('p', { class: 'hive-muted' }, submitted.has(requestKey) ? 'Request submitted. Check the bead topic before repeating.' : '');
  const ask = h('button', { type: 'button', class: 'hive-link-btn', dataset: { waitAction: 'ask-queen' }, onclick: () => {
    if (submitted.has(requestKey)) return;
    submitted.add(requestKey);
    ask.disabled = true;
    sent.textContent = 'Request submitted. Check the bead topic before repeating.';
    const topic = cell?.threads?.find(t => t.beadId === bead.id || t.beads?.includes(bead.id));
    ctx.send({ type: 'hive-send', cellId: pr.cellId, beadId: bead.id, threadId: topic?.id,
      ...(topic ? {} : { newThread: { title: `Help with PR #${pr.number}`, beadId: bead.id } }),
      text: `Please help resolve PR #${pr.number} (${pr.url}) on “${bead.title}”. ${pr.humanAttention?.reason || 'Please check what is needed next.'}`,
    }, { quiet: true, onReply: reply => {
      if (!reply.ok) ctx.notice(reply.error || 'Could not ask the queen. Check before repeating.');
      else ctx.notice(reply.delivery?.state === 'failed' ? 'Saved in the bead topic; delivery failed. Check the topic before repeating.' : 'Asked the queen in the bead topic.', { brief: true });
    } });
  } }, 'Ask the queen to fix');
  ask.disabled = submitted.has(requestKey);
  const href = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9][0-9]*$/.test(pr.url) ? pr.url : null;
  return h('article', { class: `hive-pr hive-pr-${state}` },
    h('div', { class: 'hive-pr-heading' }, h('strong', {}, `#${pr.number} ${pr.title}`),
      h('span', { class: 'hive-pr-state' }, { ready: 'Ready for your review', stuck: 'Needs your help', working: 'With the worker', merged: 'Merged', closed: 'Closed', stale: 'Status out of date' }[state])),
    pr.observationError ? h('p', { class: 'hive-warning' }, `GitHub refresh failed: ${pr.observationError.message}. Last observed ${pr.stateCheckedAt == null ? 'never' : new Date(pr.stateCheckedAt).toLocaleString()}. Retrying after ${new Date(pr.observationError.retryAt).toLocaleString()}.`) : null,
    ['ready', 'stuck'].includes(state) ? h('p', { class: 'hive-pr-reason' }, pr.humanAttention.reason) : null,
    h('details', { class: 'hive-pr-detail' }, h('summary', { dataset: { waitAction: 'checks' } }, 'Checks and review'),
      h('p', {}, `Checks: ${pr.checks}. GitHub review: ${pr.reviewDecision || 'not recorded'}.`),
      pr.humanAttention ? h('p', {}, `Worker/queen report: ${pr.humanAttention.reason}`) : null,
      h('p', {}, 'Head: ', h('code', {}, pr.headSha || 'not observed')),
      h('p', { class: 'hive-muted' }, pr.stateCheckedAt == null ? 'No confirmed observation yet.' : `Last observed ${new Date(pr.stateCheckedAt).toLocaleString()}.`)),
    h('div', { class: 'hive-pr-actions' },
      href ? h('a', { class: 'hive-link-btn', href, target: '_blank', rel: 'noopener noreferrer', dataset: { waitAction: 'github' } }, 'Open on GitHub') : null,
      state === 'stuck' && cell?.enabled && !cell.snapshot ? [ask, sent] : null));
}

export function pullRequestsSection(ctx, bead) {
  const prs = beadPullRequests(ctx, bead);
  if (!prs.length) return null;
  const history = prs.filter(pr => ['merged', 'closed'].includes(prState(pr)));
  const open = prs.filter(pr => !history.includes(pr));
  return h('section', { class: 'hive-prs', 'aria-label': 'Pull requests' }, h('h4', {}, 'Pull requests'),
    open.map(pr => pullRequestRow(ctx, bead, pr)),
    history.length ? h('details', { class: 'hive-pr-history' }, h('summary', {}, `History (${history.length})`), history.map(pr => pullRequestRow(ctx, bead, pr))) : null);
}
