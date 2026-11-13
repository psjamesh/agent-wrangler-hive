import { watchdogSettingsForm } from './watchdog-settings.js';
import { reviewPolicyForm } from './review-policy.js';
import { confirmHive, promptHive } from './confirm-dialog.js';
import { allSettings } from './settings-view.js';
import { capacityControl } from './capacity-control.js';
import { waitingItems, cellWaitingItems, waitingSection, openWaitingMenu, needsYouIncomplete } from './waiting-view.js';
import { prSummary, pullRequestsSection } from './pr-view.js';
import { h, syncChildren, markdown, safeHref, relativeTime } from './dom.js';
import { hexPath, primaryMark, fitLines } from './hex-grid.js';
import {
  cellName, sessionLabel, sessionsInTask, statusDot, STATUS_TEXT, childrenMap, agentSummary, capturedAgentSummary, cellBeadIds, waitingOn, workCounts, countsSentence, closedLabel, isDone, displayStatus, recordedWait,
} from './model.js';
import { renderConversation } from './conversation.js';
import { workstreamClasses } from './cell-layout.js';
import { retireDrawer, openRetire, openReopen } from './retire-view.js';
import { retireKey, isRetired } from './retired.js';
import { closedButton, closedKey, completeKey, workstreamDrawer } from './workstream-view.js';
import { attentionEl, launchFields, instructionsField, noticesEl, errorNote } from './widgets.js';
import { submitForm } from './form-submit.js';

const BEAD_SIZE = 60;
// Titles come first: 9.5px semibold (the readable floor), wrapped by the
// map to the hexagon's real width at each line, with metadata kept to marks.
const TITLE_PX = 9.5;
// One primary mark per item, by priority: an attached agent waiting for
// someone's input, then a recorded closure, then an agent busy on open work,
// then review activity, untracked started work, blocked or waiting, then deferred. Anything
// else (open or started, idle or unassigned) is deliberately quiet. Agent
// states come only from live AW sessions; captured sessions pass none, so a
// snapshot never shows current activity or a request for input.
export function primaryKind(bead, waits, agentDots, humanWaits = 0, ownerDot = null) {
  if (humanWaits || agentDots.includes('needs')) return 'person';
  if (bead.status === 'closed') return bead.outcome === 'done' ? 'done' : 'closed';
  if (['requested', 'in_review'].includes(bead.reviewState)) return bead.reviewWorking ? 'review-working' : 'review-pending';
  if (bead.untracked) return 'untracked';
  if (agentDots.includes('working')) return 'busy';
  if (bead.status === 'blocked' || waits.length) return 'waiting';
  if (bead.status === 'deferred') return 'deferred';
  if (bead.status === 'in_progress' && ownerDot === 'idle') return 'in-progress';
  if (bead.kind === 'external') return 'external';
  return null;
}

const MARK_WORDS = {
  person: 'An agent is waiting for input',
  'review-working': 'In review: reviewer working',
  'review-pending': 'In review: review pending',
  done: 'Done',
  untracked: 'Untracked: started work has no live claimant or open blocker',
  busy: 'An agent is working on it',
  'in-progress': 'In progress; agent idle',
  deferred: 'Deferred',
  external: 'External prerequisite',
};

export function markWords(kind, bead) {
  if (kind === 'closed') return `Closed (${bead.outcome || 'no outcome recorded'})`;
  if (kind === 'waiting') return bead.status === 'blocked' ? 'Blocked' : 'Waiting on a prerequisite';
  return MARK_WORDS[kind] || '';
}
const STATUS_LABEL = { in_review: 'In review', open: 'Open', in_progress: 'In progress', blocked: 'Blocked', deferred: 'Deferred', closed: 'Closed' };

function sessionButton(ctx, sessionId, suffix = '') {
  const { graph, ui } = ctx;
  const dot = statusDot(graph, sessionId);
  return h('span', { class: 'hive-session' },
    h('span', { class: `hive-dot-inline hive-dot-${dot}`, 'aria-hidden': 'true' }),
    `${sessionLabel(graph, sessionId)}${suffix}, ${STATUS_TEXT[dot]} `,
    dot === 'gone' ? null : h('button', { type: 'button', class: 'hive-link-btn', onclick: () => ui.inspect(sessionId) }, 'Inspect'));
}

export function beadTile(ctx, bead, tile, kids) {
  const { hive, graph } = ctx;
  const { layout } = tile;
  const snap = hive.cells[tile.cellId]?.snapshot || null;
  const ref = snap?.beadSessions?.[bead.id] ? snap.sessions?.[snap.beadSessions[bead.id]] : null;
  const isHead = layout.groupHeads.includes(bead.id);
  const waits = bead.status === 'closed' ? [] : waitingOn(hive, bead.id);
  const status = displayStatus(bead);
  const state = status === 'closed' ? closedLabel(bead) : (STATUS_LABEL[status] || status);
  const waitReason = recordedWait(bead);
  const owner = bead.ownerSessionId;
  const cell = hive.cells[tile.cellId];
  const sessions = [owner, ...(cell?.bindings || []).filter((b) => b.beadId === bead.id).map((b) => b.sessionId)].filter(Boolean);
  // An attached or busy agent says nothing about this item's status, and a
  // captured session is never shown as busy or asking for input now.
  const agents = snap ? capturedAgentSummary([ref]) : agentSummary(graph, sessions);
  const agentText = agents ? agents.text : 'No agent attached';
  const groupId = layout.parentHead[bead.id];
  const groupName = groupId && groupId !== bead.id ? hive.beads[groupId]?.title : (isHead && bead.parentId && bead.parentId !== layout.rootId ? hive.beads[bead.parentId]?.title : null);
  let badge;
  const parentLabel = isHead && bead.parentId !== layout.rootId ? groupName : null;
  const titleLines = parentLabel ? 4 : 5;
  let progress = null;
  let countText = '';
  const patchHead = layout.halo[bead.id] != null ? layout.patchHeads?.[layout.halo[bead.id]] : null;
  const colour = patchHead ? workstreamClasses(patchHead, cell?.workstreamColours, layout.regionParents, cell?.workstreamShades) : null;
  if (isHead) {
    const counts = workCounts(hive, kids, bead.id);
    countText = counts.total ? countsSentence(counts) : 'no work items yet';
    if (counts.total) progress = { done: counts.closed, total: counts.total };
    else badge = 'No items yet';
    if (tile.hiddenCount) {
      badge = `${tile.hiddenCount} closed hidden`;
      countText += `; ${tile.hiddenCount} closed item${tile.hiddenCount === 1 ? '' : 's'} hidden`;
    }
  }
  const attachment = layout.attachments?.[bead.id];
  const attachmentText = attachment?.status === 'detached' ? 'Detached from its parent; drag this heading to attach it.' : attachment?.status === 'sibling' ? `Attached via ${hive.beads[attachment.via]?.title || attachment.via} in the parent group.` : '';
  if (!badge && attachmentText) badge = attachment.status === 'detached' ? 'Detached' : 'Via sibling';
  const waitReasons = bead.status === 'closed' ? [] : [
    waits.length ? `Needed first: ${waits.map((id) => hive.beads[id]?.title || id).join('; ')}` : '',
    ['requested', 'in_review'].includes(bead.reviewState) ? [bead.review?.summary, bead.review?.waitingFor].filter(Boolean).join('; ') : '',
  ].filter(Boolean);
  const own = `${state}${waits.length ? `, waits on ${waits.length}` : ''}${['requested', 'in_review'].includes(bead.reviewState) ? `, ${bead.reviewWorking ? 'reviewer working' : 'review pending'}` : ''}`;
  const waiting = waitingItems(ctx, bead);
  const kind = primaryKind(bead, waits, agents?.dots || [], waiting.length, !snap && owner ? statusDot(graph, owner) : null);
  const attention = waiting.length ? `${waiting.length} waiting for you: ${waiting.map(item => item.title).join('; ')}` : '';
  const prIds = isHead ? cellBeadIds({ beads: hive.beads }, { rootBeadId: bead.id }) : new Set([bead.id]);
  const prs = prSummary((cell?.pullRequests || []).filter(pr => pr.beadIds.some(id => prIds.has(id))));
  const marks = [];
  if (kind) marks.push({ kind, count: waiting.length, onMark: waiting.length ? anchor => openWaitingMenu(ctx, waiting, anchor, { cellId: cell.id, beadId: bead.id }) : null, title: attention || markWords(kind, bead) });
  if (status === 'in_review' && !kind?.startsWith('review-')) marks.push({ kind: bead.reviewWorking ? 'review-working' : 'review-pending', title: markWords(bead.reviewWorking ? 'review-working' : 'review-pending', bead) });
  if (waitReason) marks.push({ kind: 'recorded-wait', title: `Waiting for: ${waitReason}` });
  const detail = `${waitReason ? `Waiting for: ${waitReason}. ` : ''}${attachmentText ? `${attachmentText} ` : ''}Work: ${isHead ? `${countText}; ` : ''}${own}. ${agentText}.${waitReasons.length ? ` Waiting: ${waitReasons.join('; ')}.` : ''}`;
  return {
    id: bead.id,
    cellId: tile.cellId,
    x: tile.x,
    y: tile.y,
    ox: tile.ox,
    oy: tile.oy,
    local: tile.local,
    titleText: bead.title,
    titleLines,
    sub: parentLabel ? fitLines(`In ${parentLabel}`, { width: 80, maxLines: 1, px: TITLE_PX * 0.85 }) : [],
    titlePx: TITLE_PX,
    badge,
    progress,
    lineHeight: 11,
    mark: kind ? { kind, count: waiting.length, title: `${attention || markWords(kind, bead)}. ${detail}` } : null,
    marks,
    onMark: waiting.length ? anchor => openWaitingMenu(ctx, waiting, anchor, { cellId: cell.id, beadId: bead.id }) : null,
    menu: isHead,
    classes: `hive-bead hive-status-${displayStatus(bead)}${isDone(bead) ? ' hive-done' : ''}${isHead ? ' is-head' : ''}${isHead && colour != null ? ` has-ws ${colour}${bead.parentId === layout.rootId ? ' is-top' : ''}` : ''} hive-kind-${bead.kind}`,
    ariaLabel: `${isHead ? 'Workstream ' : bead.kind === 'external' ? 'External prerequisite ' : ''}${bead.title}. ${groupName ? `In ${groupName}. ` : ''}${kind ? `${attention || markWords(kind, bead)}. ` : ''}${detail}${prs ? ` ${prs}.` : ''}${owner ? ` Claimed by ${sessionLabel(graph, owner)}.` : ''} Enter ${waiting.length ? 'opens the waiting-for-you dialog' : 'shows its details'}; Shift and an arrow key moves ${isHead ? 'this workstream and its descendants; Shift+F10 shows its actions' : 'it'}.`,
    title: `${bead.title}${groupName ? `\nIn ${groupName}` : ''}${marks.length ? `\n${marks.map(m => m.title).join('\n')}` : ''}\n${isHead ? `Workstream: ${countText}; ${own}` : `${bead.kind === 'external' ? 'External prerequisite' : bead.kind}, ${own}`}\n${agentText}${prs ? `\n${prs}` : ''}${waitReasons.length ? `\nWaiting: ${waitReasons.join('; ')}` : ''}`,
  };
}

export function relationsFor(hive, ids, hidden = new Set()) {
  // The map shows blocking links only: what must come first and what waits.
  // Other link types are kept in the store and listed in the details panel.
  // Pairs are counted once even if several blocking edges join them.
  const rel = new Map([...ids].filter((id) => !hidden.has(id)).map((id) => [id, { prereq: [], dependents: [], outside: 0 }]));
  const seen = new Set();
  for (const e of hive.edges) {
    if (!e.blocking || e.prerequisite === e.dependent || hidden.has(e.prerequisite) || hidden.has(e.dependent)) continue;
    const pair = `${e.dependent}>${e.prerequisite}`;
    if (seen.has(pair)) continue;
    seen.add(pair);
    const a = rel.get(e.prerequisite);
    const b = rel.get(e.dependent);
    if (a && !b) a.outside += 1;
    if (b && !a) b.outside += 1;
    if (!a || !b) continue;
    b.prereq.push(e.prerequisite);
    a.dependents.push(e.dependent);
  }
  return rel;
}

export function describeRelations(hive, rel, id) {
  const r = rel.get(id);
  const title = hive.beads[id]?.title || id;
  if (!r) return '';
  const names = (ids) => ids.map((b) => hive.beads[b]?.title || b).join('; ');
  const parts = [];
  if (r.prereq.length) parts.push(`needed first: ${names(r.prereq)}`);
  if (r.dependents.length) parts.push(`waiting on it: ${names(r.dependents)}`);
  if (r.outside) parts.push(`${r.outside} blocking link${r.outside === 1 ? '' : 's'} to work in another hive, listed in its details`);
  return `${title}. ${parts.length ? parts.join('. ') : 'Nothing it needs first or that waits on it'}.`;
}

export function legend(snapshot = false) {
  const swatch = (cls, label) => h('span', { class: 'hive-legend-item' },
    h('svg:svg', { viewBox: '-11 -11 22 22', width: '16', height: '16', 'aria-hidden': 'true', class: `hive-legend-hex ${cls}` },
      cls === 'is-external'
        ? h('svg:polygon', { points: '0,-9 7.79,-4.5 7.79,4.5 0,9 -7.79,4.5 -7.79,-4.5', class: 'hive-legend-shape' })
        : h('svg:path', { d: hexPath(9, 0.18), class: 'hive-legend-shape' })),
    label);
  return h('div', { class: 'hive-legend', 'aria-label': 'Key' },
    h('span', {
      class: 'hive-legend-item hive-legend-marks',
      title: snapshot
        ? 'One mark per item, from its recorded work status. Captured sessions describe the capture, not now, so this hive never shows an agent working or waiting for input; their states are in each tooltip.'
        : 'One person icon for every human wait: agent input, an unacknowledged Hive message, a Needs You request or a PR explicitly waiting on you. Several waits get a count badge. Worker-handled failing checks stay quiet. One mark per item, most urgent first. Waiting for input means an attached agent is asking someone something; the cross means the work itself is blocked or waits on a prerequisite. In review and recorded wait marks remain visible alongside them. The outlined progress arc means in-progress work with an idle live owner. Items with no mark have no activity or recorded wait. Each tooltip names every agent and its state.',
    }, [...(snapshot ? [] : [['person', 'waiting for you (count when several)'], ['busy', 'agent working'], ['review-working', 'in review: reviewer working'], ['review-pending', 'in review: review pending'], ['in-progress', 'in progress; agent idle']]), ['recorded-wait', 'recorded wait (reason in tooltip and details)'], ['untracked', 'untracked work'], ['waiting', 'blocked or waiting'], ['deferred', 'deferred'], ['done', 'done'], ['closed', 'closed otherwise']].map(([k, label]) => h('span', { class: 'hive-legend-st' },
      h('svg:svg', { viewBox: '-8 -8 16 16', width: '14', height: '14', 'aria-hidden': 'true' }, primaryMark(k, label)), label))),
    h('span', { class: 'hive-legend-item hive-legend-note' }, 'No mark: no activity or recorded wait'),
    swatch('is-done', 'Closed work'),
    swatch('is-group', 'Workstream'),
    swatch('is-external', 'External'),
    h('span', { class: 'hive-legend-item hive-legend-marks', title: 'Shown on the items that must come first for, or wait on, the one you point at, focus or select. Other kinds of link are listed in the details.' }, '▲ needed first · ▼ waits on it'));
}

// A hive that is off still shows its conversation, so what each side owes
// stays in reach.
function hasPanels(cell, root) {
  if (!cell.snapshot && Object.keys(cell.requests || {}).length) return true;
  if (cell.snapshot) return Boolean(root && cell.enabled);
  return cell.enabled || isRetired(cell) ? Boolean(root) : Boolean(cell.inbox);
}

function detailStatus(ctx, bead, detail) {
  if (detail.error) {
    return h('div', { class: 'hive-row hive-warning', role: 'alert' }, `Could not load the full details: ${detail.error} `,
      h('button', { type: 'button', class: 'hive-link-btn', 'data-focus-key': `detail-retry:${bead.id}`, onclick: () => ctx.ui.retryBeadDetail(bead.id) }, 'Retry'));
  }
  if (detail.loading && !detail.bead) return h('p', { class: 'hive-muted', role: 'status', 'data-detail-loading': bead.id }, 'Loading details…');
  return null;
}

function beadDetails(ctx, cell) {
  const { hive, graph, api, ui, send } = ctx;
  const id = ui.selectedBeadId();
  const bead = id ? hive.beads[id] : null;
  if (!bead) {
    const root = hive.beads[cell.rootBeadId];
    return h('section', { class: 'hive-panel hive-details', tabindex: '-1', 'data-focus-key': 'panel:details', 'aria-label': 'Details', 'data-pane': 'details', dataset: { scrollKey: `details:${cell.id}:goal` } },
      h('h3', {}, 'Hive goal'),
      root ? waitingSection(ctx, root) : null,
      root ? pullRequestsSection(ctx, root) : null,
      root?.goal ? markdown(api, root.goal) : h('p', { class: 'hive-muted' }, cell.snapshot ? 'No goal was confirmed on the captured board.' : 'No goal written yet.'),
      root?.acceptance ? [h('h4', {}, 'Done when'), markdown(api, root.acceptance)] : null,
      h('p', { class: 'hive-muted' }, 'Select a bead or a workstream to see its details here. The queen and its instructions are under Info.'));
  }
  const detail = ui.beadDetail(bead);
  const full = { goal: bead.goal || '', acceptance: bead.acceptance || '', summary: '', nextAction: '', evidence: [], nativeMetadataKeys: [], ...(detail.bead ? { goal: detail.bead.goal, acceptance: detail.bead.acceptance, summary: detail.bead.summary, nextAction: detail.bead.nextAction, evidence: detail.bead.evidence, nativeMetadataKeys: detail.bead.nativeMetadataKeys } : {}) };
  const waits = waitingOn(hive, bead.id);
  const dependents = hive.edges.filter((e) => e.blocking && e.prerequisite === bead.id).map((e) => e.dependent);
  const related = hive.edges.filter((e) => !e.blocking && (e.dependent === bead.id || e.prerequisite === bead.id));
  const bound = cell.bindings.filter((b) => b.beadId === bead.id && b.sessionId !== bead.ownerSessionId);
  const kids = childrenMap(hive.beads).get(bead.id) || [];
  const link = (bid) => h('button', { type: 'button', class: 'hive-chip', onclick: () => ui.selectBead(bid) }, hive.beads[bid]?.title || bid);
  const inCell = cellBeadIds(hive, cell).has(bead.id);
  const snap = cell.snapshot || null;
  const refId = snap?.beadSessions?.[bead.id] || null;
  const ref = refId ? snap.sessions?.[refId] : null;
  return h('section', { class: 'hive-panel hive-details', tabindex: '-1', 'data-focus-key': 'panel:details', 'aria-label': 'Bead details', 'data-pane': 'details', dataset: { scrollKey: `details:${cell.id}:${bead.id}` } },
    h('div', { class: 'hive-details-head' },
      h('h3', {}, bead.title),
      h('button', { type: 'button', class: 'hive-quiet-btn', onclick: () => ui.selectBead(null), title: 'Show the hive goal' }, 'Hive goal')),
    waitingSection(ctx, bead),
    h('p', { class: 'hive-meta' },
      h('span', { class: `hive-status-pill hive-status-${displayStatus(bead)}` }, STATUS_LABEL[displayStatus(bead)] || bead.status),
      h('span', {}, bead.kind),
      h('code', {}, bead.id),
      bead.updatedAt ? h('span', {}, `updated ${relativeTime(bead.updatedAt)}`) : null,
      inCell ? null : h('span', {}, 'in another hive')),
    bead.status === 'closed' ? h('p', {}, h('strong', {}, `Closed${bead.outcome ? ` as ${bead.outcome}` : ''}`), bead.closeReason ? ` — ${bead.closeReason}` : '') : null,
    ref ? h('div', { class: 'hive-row' }, h('strong', {}, 'Captured session: '),
      h('span', { class: 'hive-session' }, h('span', { class: `hive-dot-inline hive-dot-${snapshotDot(ref.status)}`, 'aria-hidden': 'true' }), `${ref.label || refId.slice(0, 8)}, ${ref.status || 'unknown'} when captured`),
      h('span', { class: 'hive-muted' }, 'Read-only reference; it is not a session on this board.')) : null,
    bead.untracked ? h('p', { class: 'hive-warning' }, 'Untracked: this started work has no live claimant or open blocking prerequisite.') : null,
    bead.ownerSessionId ? h('div', { class: 'hive-row' }, h('strong', {}, 'Claimed by '), sessionButton(ctx, bead.ownerSessionId),
      isRetired(cell) ? null : h('button', {
        type: 'button',
        class: 'hive-link-btn',
        'data-focus-key': `release:${bead.id}`,
        onclick: async () => {
          const reason = await promptHive('Release this claim? Its status stays the same. Why?');
          if (reason && reason.trim()) send({ type: 'hive-bead-release', beadId: bead.id, reason });
        },
      }, 'Release…')) : (bead.assignee ? h('div', {}, `Assigned to ${bead.assignee}`) : null),
    bound.length ? h('div', { class: 'hive-row' }, h('strong', {}, 'Also bound: '), bound.map((b) => sessionButton(ctx, b.sessionId, ` (${b.role})`))) : null,
    waits.length ? h('div', { class: 'hive-row' }, h('strong', {}, 'Waiting on: '), waits.map(link)) : null,
    bead.review ? h('div', { class: 'hive-row' }, h('strong', {}, `Review: ${String(bead.reviewState).replaceAll('_', ' ')}. `), detail.bead?.review?.summary || bead.review.summary || '', bead.review.reviewerSessionId ? sessionButton(ctx, bead.review.reviewerSessionId, ' (reviewer)') : null) : null,
    recordedWait(bead) ? h('div', { class: 'hive-row' }, h('strong', {}, 'Waiting for: '), recordedWait(bead)) : null,
    full.nextAction ? h('div', { class: 'hive-row' }, h('strong', {}, 'Next: '), full.nextAction) : null,
    dependents.length ? h('div', { class: 'hive-row' }, h('strong', {}, 'Needed by: '), dependents.map(link)) : null,
    related.length ? h('div', { class: 'hive-row' }, h('strong', {}, 'Other links: '), related.map((e) => h('span', { class: 'hive-other-link' }, link(e.dependent === bead.id ? e.prerequisite : e.dependent), ` (${e.type})`))) : null,
    kids.length || bead.kind === 'workstream' ? workstreamProgress(workCounts(hive, childrenMap(hive.beads), bead.id)) : null,
    kids.length ? h('div', { class: 'hive-row' }, h('strong', {}, 'Contains: '), kids.map((k) => link(k.id))) : null,
    pullRequestsSection(ctx, bead),
    detailStatus(ctx, bead, detail),
    full.goal ? [h('h4', {}, 'Goal'), markdown(api, full.goal)] : null,
    full.acceptance ? [h('h4', {}, 'Done when'), markdown(api, full.acceptance)] : null,
    full.summary ? [h('h4', {}, 'Current understanding'), markdown(api, full.summary)] : null,
    full.evidence.length ? [h('h4', {}, 'Evidence'), h('ul', { class: 'hive-evidence' }, full.evidence.map((e) => {
      const href = safeHref(e.url);
      return h('li', {},
        href ? h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, e.label) : h('strong', {}, e.label),
        e.kind && e.kind !== 'note' ? h('span', { class: 'hive-muted' }, `, ${e.kind}`) : null,
        e.by ? h('span', { class: 'hive-muted' }, `, ${e.by.startsWith('aw:') && e.by !== 'aw:human' ? sessionLabel(graph, e.by.slice(3)) : e.by}`) : null,
        e.detail ? markdown(api, e.detail) : null);
    }))] : null,
    full.nativeMetadataKeys?.length ? h('p', { class: 'hive-muted' }, `Other metadata: ${full.nativeMetadataKeys.join(', ')}`) : null);
}

// Exact counts for a workstream, over every item nested beneath it.
function workstreamProgress(c) {
  if (!c.total) return h('div', { class: 'hive-row' }, h('strong', {}, 'Progress: '), 'no work items yet');
  const parts = [`${c.closed} of ${c.total} closed`];
  if (c.in_progress) parts.push(`${c.in_progress} in progress`);
  if (c.in_review) parts.push(`${c.in_review} in review`);
  if (c.not_active) parts.push(`${c.not_active} not active`);
  if (c.blocked) parts.push(`${c.blocked} blocked`);
  if (c.open) parts.push(`${c.open} open`);
  const fill = h('span', {});
  fill.style.width = `${Math.round((c.closed / c.total) * 100)}%`;
  return h('div', { class: 'hive-row hive-progress-row' },
    h('strong', {}, 'Progress: '),
    h('span', { class: 'hive-progress-inline', 'aria-hidden': 'true' }, fill),
    parts.join(', '));
}

const SAVE_FAILED = 'Could not save the instructions.';

export function queenInstructions(ctx, cell) {
  const { ui, api } = ctx;
  const key = `instructions:${cell.id}`;
  const editing = ui.form(key);
  const saved = cell.queenInstructions || '';
  if (!editing) {
    return h('div', { class: 'hive-instructions' },
      h('div', { class: 'hive-details-head' },
        h('h4', {}, 'How the queen works'),
        h('button', { type: 'button', class: 'hive-quiet-btn', onclick: () => ui.setForm(key, { text: saved, id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}` }), 'data-focus-key': `edit-instructions:${cell.id}` }, saved ? 'Edit' : 'Add instructions')),
      saved ? markdown(api, saved) : h('p', { class: 'hive-muted' }, 'No queen instructions. The queen follows the hive-queen skill and the instructions its session already has.'));
  }
  return h('form', {
    class: 'hive-form hive-instructions',
    onsubmit: (e) => {
      e.preventDefault();
      submitForm({
        ctx, key,
        newId: (cur) => `${cur.id}:${Date.now().toString(36)}`,
        message: (cur) => ({ type: 'hive-cell-instructions', cellId: cell.id, instructions: cur.text || '' }),
        failed: SAVE_FAILED,
        lateFailure: (frame) => ctx.notice(`Queen instructions were not saved: ${frame.error || SAVE_FAILED}`, { severity: 'error' }),
        succeeded: (frame, mine) => {
          if (mine) ui.setForm(key, null);
          else ctx.notice('Earlier queen instructions were saved after you closed the editor; reopen it to see the current text.');
        },
      });
    },
  },
  instructionsField(editing.text, (text) => ui.patchForm(key, { text }), `instructions:${cell.id}`),
  h('p', { class: 'hive-muted' }, cell.queenSessionId ? 'The current queen sees the change the next time it reads hive_context; use Send brief to tell it now.' : 'The next queen launched or nominated for this hive receives them.'),
  errorNote(editing.error),
  h('div', { class: 'hive-actions' },
    h('button', { type: 'submit', class: 'hive-btn hive-btn-primary', disabled: Boolean(editing.pending) }, editing.pending ? 'Saving…' : 'Save'),
    h('button', { type: 'button', class: 'hive-btn', onclick: () => ui.setForm(key, null) }, 'Cancel')));
}

function queenBar(ctx, cell) {
  const { graph, ui, send, busy, api } = ctx;
  const members = sessionsInTask(graph, cell.taskId);
  const launchForm = ui.form(`launch:${cell.id}`);
  const nominate = h('select', {
    'aria-label': 'Nominate a queen',
    'data-focus-key': 'nominate',
    onchange: async (e) => {
      const sid = e.target.value;
      if (!sid) return;
      if (await confirmHive(`Make ${sessionLabel(graph, sid)} the queen? It keeps its conversation and instructions and receives an activation brief; it is not restarted. If it is already running, it may need its agent terminal restarted or resumed before Hive's skills and tools appear.`)) {
        send({ type: 'hive-queen-nominate', cellId: cell.id, sessionId: sid, sendBrief: true });
      } else {
        e.target.value = '';
      }
    },
  }, h('option', { value: '' }, cell.queenSessionId ? 'Replace queen…' : 'Nominate a queen…'),
  members.filter((s) => s.sessionId !== cell.queenSessionId).map((s) => h('option', { value: s.sessionId }, sessionLabel(graph, s.sessionId))));
  const a = cell.activation;
  const launch = launchState(ctx.hive, cell);
  return h('div', { class: 'hive-queenbar' },
    h('span', { class: 'hive-fact-label' }, 'Queen'),
    cell.queenSessionId ? sessionButton(ctx, cell.queenSessionId) : h('span', { class: 'hive-setup-pill' }, launch ? launch.text : 'Setup incomplete: no queen'),
    a && a.sessionId === cell.queenSessionId && a.state !== 'delivered'
      ? h('span', { class: 'hive-muted' }, `Brief ${a.state}${a.error ? `: ${a.error}` : ''} `)
      : null,
    cell.queenSessionId ? h('button', {
      type: 'button',
      class: 'hive-link-btn',
      disabled: busy('hive-queen-brief'),
      'data-focus-key': `brief:${cell.id}`,
      onclick: async () => {
        const unsure = a && a.sessionId === cell.queenSessionId && (a.state === 'uncertain' || a.state === 'pending');
        if (unsure && !await confirmHive('The last brief may already have reached the queen. Send it again anyway?')) return;
        send({ type: 'hive-queen-brief', cellId: cell.id });
      },
    }, a && a.sessionId === cell.queenSessionId && a.state !== 'failed' ? 'Send brief again…' : 'Send brief') : null,
    members.length > (cell.queenSessionId ? 1 : 0) ? nominate : null,
    launch?.active ? null : h('button', { type: 'button', class: cell.queenSessionId ? 'hive-quiet-btn' : 'hive-btn', onclick: () => ui.setForm(`launch:${cell.id}`, launchForm ? null : { autoCompactTokens: 250000 }) }, launchForm ? 'Cancel launch' : (cell.queenSessionId ? 'Launch a new queen…' : 'Launch a queen…')),
    launchForm ? h('form', {
      class: 'hive-form hive-form-inline',
      onsubmit: (e) => {
        e.preventDefault();
        const form = ui.form(`launch:${cell.id}`) || {};
        const { instructions, ...settings } = form;
        send({ type: 'hive-queen-launch', cellId: cell.id, ...settings, instructions: instructions ?? cell.queenInstructions ?? '' }, {
          onReply: (frame) => {
            if (!frame.ok) return ctx.notice(frame.error || 'The queen did not launch.', { severity: 'error' });
            ui.setForm(`launch:${cell.id}`, null);
          },
        });
      },
    }, launchFields(api, launchForm, (next) => ui.setForm(`launch:${cell.id}`, { ...ui.form(`launch:${cell.id}`), ...next }), (p) => ui.patchForm(`launch:${cell.id}`, p)),
    instructionsField(launchForm.instructions ?? cell.queenInstructions ?? '', (text) => ui.patchForm(`launch:${cell.id}`, { instructions: text }), `launch-instructions:${cell.id}`),
    h('button', { type: 'submit', class: 'hive-btn hive-btn-primary', disabled: busy('hive-queen-launch') }, busy('hive-queen-launch') ? 'Launching…' : 'Launch queen')) : null,
    nominatedNote(ctx, cell));
}

// A nominated queen is a session that was already running: it keeps its
// conversation and instructions, but its agent may not load Hive's skills and
// tools until its terminal is restarted or resumed. Hive cannot tell, and a
// delivered brief proves nothing about it, so the human gets the route to the
// session's own controls instead.
function nominatedNote(ctx, cell) {
  const { ui } = ctx;
  const current = cell.queens?.at(-1);
  if (!cell.queenSessionId || current?.sessionId !== cell.queenSessionId || current.via !== 'nominated') return null;
  return h('div', { class: 'hive-queen-note' },
    h('span', { class: 'hive-muted' }, 'Existing session: if it does not have Hive\'s tools yet, restart or resume its agent terminal from its session (this does not restart Agent Wrangler).'),
    h('button', {
      type: 'button',
      class: 'hive-link-btn',
      onclick: () => ui.inspect(cell.queenSessionId),
      title: 'Opens the queen\'s own session panel, with its normal Restart and Resume controls.',
    }, 'Open queen session'));
}

const LAUNCH_TEXT = {
  pending: 'Queen launch in progress',
  bound: 'Queen launch in progress',
  uncertain: 'Queen launch unconfirmed: check before retrying',
  failed: 'Queen launch failed',
};

// The newest unresolved queen launch for a cell without a queen, if any.
export function launchState(hive, cell) {
  if (cell.queenSessionId) return null;
  const mine = (hive.launches || []).filter((l) => l.cellId === cell.id).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const l = mine[0];
  if (!l || !LAUNCH_TEXT[l.state]) return null;
  return { state: l.state, text: LAUNCH_TEXT[l.state], active: l.state !== 'failed' };
}

function snapshotQueen(ctx, cell) {
  const snap = cell.snapshot;
  const q = snap.queenSessionId ? snap.sessions?.[snap.queenSessionId] : null;
  return h('div', { class: 'hive-queenbar' },
    h('span', { class: 'hive-fact-label' }, 'Queen'),
    q ? h('span', { class: 'hive-session' }, h('span', { class: `hive-dot-inline hive-dot-${snapshotDot(q.status)}`, 'aria-hidden': 'true' }), `${q.label || snap.queenSessionId.slice(0, 8)}, ${q.status || 'unknown'} when captured`) : h('span', { class: 'hive-muted' }, 'none recorded'),
    h('span', { class: 'hive-setup-pill is-snapshot' }, `Captured snapshot${snap.capturedAt ? `, ${relativeTime(snap.capturedAt)}` : ''}: read only`));
}

export function snapshotDot(status) {
  if (status === 'working') return 'working';
  if (status === 'needs-you') return 'needs';
  if (status === 'exited') return 'exited';
  return 'idle';
}

// Sessions of a live hive that are asking someone for input right now: its
// queen, its bound agents and the owners of its work, from AW's own session
// states. A captured snapshot never reports any.
function queenPill(ctx, cell, openInfo) {
  const { graph, hive } = ctx;
  if (cell.snapshot) {
    const snap = cell.snapshot;
    return h('span', { class: 'hive-setup-pill is-snapshot' }, `Captured snapshot${snap.capturedAt ? `, ${relativeTime(snap.capturedAt)}` : ''}: read only`);
  }
  if (!cell.enabled) return null;
  if (!cell.queenSessionId) {
    const launch = launchState(hive, cell);
    return h('button', { type: 'button', class: 'hive-setup-pill hive-pill-btn', onclick: openInfo, title: 'Open hive info to launch or nominate a queen' }, launch ? launch.text : 'Setup incomplete: no queen');
  }
  const dot = statusDot(graph, cell.queenSessionId);
  const a = cell.activation;
  const brief = a && a.sessionId === cell.queenSessionId ? { failed: 'brief not delivered', uncertain: 'brief unconfirmed' }[a.state] : null;
  return h('button', {
    type: 'button',
    class: `hive-queen-pill${brief ? ' is-warn' : ''}`,
    onclick: openInfo,
    title: `Queen: ${sessionLabel(graph, cell.queenSessionId)}, ${STATUS_TEXT[dot]}. Open hive info to manage the queen.`,
  },
  h('span', { class: `hive-dot-inline hive-dot-${dot}`, 'aria-hidden': 'true' }),
  `Queen ${STATUS_TEXT[dot]}`, brief ? ` · ${brief}` : '');
}

function headProgress(counts) {
  if (!counts) return null;
  const fill = h('span', {});
  fill.style.width = `${counts.total ? Math.round((counts.closed / counts.total) * 100) : 0}%`;
  return h('span', { class: 'hive-counts hive-headprogress', title: countsSentence(counts) },
    counts.total ? h('span', { class: 'hive-progress-inline', 'aria-hidden': 'true' }, fill) : null,
    counts.total ? `${counts.closed} of ${counts.total} closed` : 'No work yet');
}

function focusKey(k) {
  globalThis.document?.querySelector(`.hive-root [data-focus-key="${CSS.escape(k)}"]`)?.focus();
}

function cellHeader(ctx, cell, root) {
  const { graph, ui, send, hive } = ctx;
  const name = cellName(graph, cell);
  const counts = root && (cell.enabled || isRetired(cell)) ? workCounts(hive, childrenMap(hive.beads), root.id) : null;
  const waiting = cellWaitingItems(ctx, cell);
  const infoKey = `info:${cell.id}`;
  const infoOpen = Boolean(ui.form(infoKey));
  const openInfo = () => {
    ui.setForm(closedKey(cell.id), null);
    ui.setForm(completeKey(cell.id), null);
    ui.setForm(retireKey(cell.id), null);
    if (!ui.form(infoKey)) ui.setForm(infoKey, {});
    focusKey(`info-close:${cell.id}`);
  };
  return h('header', { class: 'hive-cellhead' },
    h('div', { class: 'hive-cellhead-top' },
      h('button', { type: 'button', class: 'hive-back', onclick: () => ui.closeCell(), 'aria-label': 'Show all hives', title: 'Show all hives' },
        h('span', { class: 'hive-back-icon', 'aria-hidden': 'true' }), 'All hives'),
      h('span', { class: 'hive-crumb-sep', 'aria-hidden': 'true' }, '/'),
      h('h2', { class: 'hive-celltitle', title: name }, name),
      isRetired(cell) ? h('span', { class: 'hive-badge hive-badge-retired', title: cell.retired.summary }, `Retired · ${cell.retired.outcome}`) : (cell.enabled ? null : h('span', { class: 'hive-badge' }, 'Off')),
      capacityControl(ctx),
      h('div', { class: 'hive-cellstate' },
        queenPill(ctx, cell, openInfo),
        headProgress(counts),
        waiting.length ? h('button', { type: 'button', class: 'hive-quiet-btn hive-waiting', 'aria-haspopup': 'dialog', 'data-focus-key': 'waiting-header', onclick: event => openWaitingMenu(ctx, waiting, event.currentTarget, { cellId: cell.id }) }, `${waiting.length} waiting for you`) : null),
      h('div', { class: 'hive-head-actions' },
        hasPanels(cell, root) ? h('button', { type: 'button', class: 'hive-quiet-btn', 'aria-pressed': ui.dockOpen() ? 'true' : 'false', onclick: () => ui.setDockOpen(!ui.dockOpen()), 'data-focus-key': `panels:${cell.id}` }, ui.dockOpen() ? 'Hide panels' : 'Show panels') : null,
        isRetired(cell) ? h('button', { type: 'button', class: 'hive-btn hive-btn-primary', onclick: () => openReopen(ctx, cell), 'data-focus-key': `reopen-open:${cell.id}` }, 'Reopen hive…') : (cell.enabled || cell.snapshot ? null : h('button', { type: 'button', class: 'hive-btn hive-btn-primary', onclick: () => send({ type: 'hive-cell-enable', cellId: cell.id }) }, 'Turn on')),
        cell.enabled && !cell.snapshot ? closedButton(ctx, cell) : null,
        h('button', {
          type: 'button',
          class: 'hive-quiet-btn',
          'aria-expanded': infoOpen ? 'true' : 'false',
          'aria-controls': `hive-info-${cell.id}`,
          'data-focus-key': `info-open:${cell.id}`,
          title: 'Goal, queen, instructions and settings for this hive',
          onclick: () => (infoOpen ? ui.setForm(infoKey, null) : openInfo()),
        }, 'Info'))),
    allSettings(ctx),
    needsYouIncomplete(graph) ? h('p', { class: 'hive-warning' }, 'Needs You list may be incomplete: the queue supplies at most 200 items. Open Needs You to see the queue.') : null,
    attentionEl(ctx, { cellId: cell.id }),
    noticesEl(ctx));
}

// Everything about the hive that is not the work itself: its full goal, its
// queen and how to manage it, the queen's instructions, and turning it off.
function infoDrawer(ctx, cell, root) {
  const { ui, send, api, graph, hive } = ctx;
  const infoKey = `info:${cell.id}`;
  if (!ui.form(infoKey)) return null;
  const close = () => {
    ui.setForm(infoKey, null);
    focusKey(`info-open:${cell.id}`);
  };
  const name = cellName(graph, cell);
  const counts = root && (cell.enabled || isRetired(cell)) ? workCounts(hive, childrenMap(hive.beads), root.id) : null;
  let goal;
  if (root?.goal) goal = markdown(api, root.goal);
  else if (cell.snapshot?.brief) goal = [h('p', { class: 'hive-muted' }, 'Board brief, not a confirmed goal:'), markdown(api, cell.snapshot.brief)];
  else goal = h('p', { class: 'hive-muted' }, cell.snapshot ? 'No goal was confirmed on the captured board.' : 'No goal written yet.');
  let queen;
  if (cell.snapshot) queen = snapshotQueen(ctx, cell);
  else if (cell.enabled) queen = queenBar(ctx, cell);
  else queen = h('p', { class: 'hive-muted' }, isRetired(cell) ? 'This hive is retired. Reopen it to manage its queen.' : 'Turn the hive on to manage its queen.');
  return h('aside', {
    class: 'hive-info',
    id: `hive-info-${cell.id}`,
    role: 'dialog',
    'aria-label': `About ${name}`,
    onkeydown: (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } },
  },
  h('div', { class: 'hive-info-head' },
    h('h3', {}, name),
    h('button', { type: 'button', class: 'hive-quiet-btn', onclick: close, 'data-focus-key': `info-close:${cell.id}` }, 'Close')),
  h('div', { class: 'hive-info-body', dataset: { scrollKey: `info:${cell.id}` } },
    h('section', {}, h('h4', {}, 'Goal'), goal),
    root?.acceptance ? h('section', {}, h('h4', {}, 'Done when'), markdown(api, root.acceptance)) : null,
    counts ? h('section', {}, h('h4', {}, 'Progress'), h('p', {}, countsSentence(counts))) : null,
    h('section', {}, h('h4', {}, 'Queen'), queen),
    cell.snapshot || isRetired(cell) ? null : queenInstructions(ctx, cell),
    cell.snapshot || isRetired(cell) ? null : watchdogSettingsForm(ctx, cell),
    cell.snapshot || isRetired(cell) ? null : reviewPolicyForm(ctx, cell),
    cell.snapshot ? null : h('section', {},
      h('h4', {}, 'Hive'),
      isRetired(cell)
        ? [h('p', { class: 'hive-muted' }, `Retired as ${cell.retired.outcome}${cell.retired.at ? `, ${relativeTime(cell.retired.at)}` : ''}: ${cell.retired.summary}`),
          h('button', { type: 'button', class: 'hive-btn hive-btn-primary', onclick: () => openReopen(ctx, cell) }, 'Reopen hive…')]
        : [h('p', { class: 'hive-muted' }, cell.enabled ? 'Turning the hive off keeps its record. Agents cannot use it until it is turned on again.' : 'This hive is off. Its record is kept; turn it on to see its work and to let agents use it.'),
          cell.enabled
            ? h('button', { type: 'button', class: 'hive-btn', onclick: () => send({ type: 'hive-cell-disable', cellId: cell.id }) }, 'Turn hive off')
            : h('button', { type: 'button', class: 'hive-btn hive-btn-primary', onclick: () => send({ type: 'hive-cell-enable', cellId: cell.id }) }, 'Turn hive on'),
          h('p', { class: 'hive-muted' }, 'Retiring a finished hive records its outcome and takes it off the All hives map.'),
          h('button', { type: 'button', class: 'hive-btn', onclick: () => openRetire(ctx, cell), 'data-focus-key': `retire-open:${cell.id}`, 'aria-haspopup': 'dialog' }, 'Retire hive…')]),
    h('section', {},
      h('h4', {}, 'All hives'),
      ctx.bees.slider(`info:${cell.id}`),
      h('p', { class: 'hive-muted' }, 'This applies to every hive, not only this one.'))));
}

function paneTabs(ui) {
  const pane = ui.pane() === 'details' ? 'details' : 'conversation';
  const tab = (id, label) => h('button', {
    type: 'button',
    role: 'tab',
    class: 'hive-tab',
    dataset: { tab: id },
    'aria-selected': pane === id ? 'true' : 'false',
    'data-focus-key': `tab:${id}`,
    onclick: () => ui.setPane(id),
  }, label);
  return h('div', { class: 'hive-tabs', role: 'tablist', 'aria-label': 'Show' },
    tab('conversation', 'Conversation'), tab('details', 'Details'));
}

function firstParagraph(text) {
  return String(text || '').split(/\n\s*\n/).map((p) => p.trim()).find(Boolean)?.replace(/\s+/g, ' ') || '';
}

// The focused task's header and info drawer, and the dock with its
// conversation and details.
const panelViews = new WeakMap();

export function disposePanels(ui) { panelViews.delete(ui); }

export function cellPanels(ctx, cell) {
  const { graph, ui, hive } = ctx;
  const root = cell.rootBeadId ? hive.beads[cell.rootBeadId] : null;
  const onKeyDown = event => {
    if (event.key === 'Escape') ui.selectConversationMessage?.(cell.id, ui.openThread(cell.id), null);
  };
  const inspecting = ui.inspecting();
  const convo = hasPanels(cell, root) && !cell.snapshot ? renderConversation({ cell, hive, graph, api: ctx.api, ui, ctx }) : null;
  if (convo) {
    if (convo.textarea) convo.textarea.dataset.focusKey = convo.focusKey;
    convo.list.dataset.scrollKey = convo.scrollKey;
    if (convo.follow) convo.list.dataset.scrollFollow = '';
  }
  const inspectbar = inspecting ? h('div', { class: 'hive-inspectbar', 'aria-label': 'Session' },
    h('strong', {}, sessionLabel(graph, inspecting)),
    h('button', { type: 'button', class: 'hive-quiet-btn', onclick: () => ui.closeInspector() }, 'Back to the map')) : null;
  const open = ui.dockOpen();
  let cached = panelViews.get(ui);
  if (!cached || cached.cellId !== cell.id) {
    cached = { cellId: cell.id, dock: h('div', { class: 'hive-dock' }), conversation: null };
    panelViews.set(ui, cached);
  }
  let conversation = null;
  if (convo) {
    conversation = cached.conversation ||= h('section', { class: 'hive-panel hive-conversation', tabindex: '-1', 'data-focus-key': 'panel:conversation', 'aria-label': 'Conversation', 'data-pane': 'conversation' });
    if (cached.convo !== convo) {
      if (cached.convo?.list !== convo.list) ctx.beforeReplace?.(conversation);
      conversation.dataset.scrollKey = `panel:${convo.scrollKey}`;
      conversation.hiveRebuilt = cached.convo?.list !== convo.list;
      syncChildren(conversation, [cached.heading ||= h('h3', {}, 'Conversation'), convo.head, convo.list, convo.toast, convo.composer]);
      cached.convo = convo;
    }
  }
  else if (cell.snapshot) conversation = h('section', { class: 'hive-panel hive-conversation', tabindex: '-1', 'data-focus-key': 'panel:conversation', 'aria-label': 'Conversation', 'data-pane': 'conversation' }, h('h3', {}, 'Conversation'), h('p', { class: 'hive-muted' }, 'This is a captured snapshot of another board. Its sessions cannot receive messages here.'));
  if (cached.readInteraction !== convo?.onReadInteraction) {
    for (const type of ['pointerdown', 'keydown', 'focusin', 'wheel', 'touchstart']) if (cached.readInteraction) cached.readElement.removeEventListener(type, cached.readInteraction, true);
    cached.readElement = conversation;
    cached.readInteraction = conversation ? convo?.onReadInteraction : null;
    if (cached.readInteraction) for (const type of ['pointerdown', 'keydown', 'focusin', 'wheel', 'touchstart']) conversation.addEventListener(type, cached.readInteraction, true);
  }
  if (conversation && !conversation.hiveKeys) { conversation.addEventListener('keydown', onKeyDown); conversation.hiveKeys = true; }
  const details = cell.enabled || isRetired(cell) ? beadDetails(ctx, cell) : h('section', { class: 'hive-panel hive-details', tabindex: '-1', 'data-focus-key': 'panel:details', 'aria-label': 'Details', 'data-pane': 'details' },
    h('h3', {}, 'Details'), h('p', { class: 'hive-muted' }, 'This hive is off. Turn it on to see its work.'));
  const dock = hasPanels(cell, root) && open ? syncChildren(cached.dock, [conversation, details]) : null;
  return {
    header: cellHeader(ctx, cell, root),
    info: infoDrawer(ctx, cell, root) || retireDrawer(ctx, cell) || workstreamDrawer(ctx, cell),
    tabs: dock ? paneTabs(ui) : null,
    inspectbar,
    dock,
    inspecting: Boolean(inspecting),
    related: convo?.related,
    onKeyDown,
  };
}
