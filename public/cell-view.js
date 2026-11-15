import { cellMetrics } from './cell-metrics.js';
import { workerProfileForm } from './worker-profile.js';
import { workstreamProfileSettings } from './worker-profile.js';
import { cellTitle, cellGoalForm } from './cell-settings.js';
import { codexApprovalsForm } from './codex-approvals.js';
import { handoverFields, handoverError } from './handover-fields.js';
import { pickupDetails } from './pickup.js';
import { watchdogSettingsForm, watchdogSummary } from './watchdog-settings.js';
import { reviewPolicyForm } from './review-policy.js';
import { confirmHive, promptHive } from './confirm-dialog.js';
import { settingsModal, settingsButton, advancedSettings } from './settings-view.js';
import { openCellPopover, disposeCellPopover } from './cell-popover.js';
import { capacityControl } from './capacity-control.js';
import { progressBar } from './progress-bar.js';
import { waitingItems, waitingSection, openWaitingMenu } from './waiting-view.js';
import { prSummary, pullRequestsSection } from './pr-view.js';
import { h, syncChildren, markdown, safeHref, relativeTime } from './dom.js';
import { hexPath, primaryMark, fitLines } from './hex-grid.js';
import {
  sessionLabel, statusDot, STATUS_TEXT, childrenMap, agentSummary, capturedAgentSummary, cellBeadIds, waitingOn, workCounts, countsSentence, closedLabel, isDone, displayStatus, recordedWait,
} from './model.js';
import { renderConversation } from './conversation.js';
import { workstreamClasses } from './cell-layout.js';
import { retireDrawer, openRetire, openReopen } from './retire-view.js';
import { isRetired } from './retired.js';
import { closedButton, workstreamDrawer } from './workstream-view.js';
import { attentionEl, launchFields, instructionsField, noticesEl, errorNote } from './widgets.js';
import { submitForm } from './form-submit.js';

const BEAD_SIZE = 60;
// Titles come first: 9.5px semibold (the readable floor), wrapped by the
// map to the hexagon's real width at each line, with metadata kept to marks.
const TITLE_PX = 9.5;
// One primary mark per item, by priority: an attached agent waiting for
// someone's input, then a recorded closure, then an agent busy on open work,
// then review activity, untracked started work, waiting on prerequisites, then deferred. Anything
// else (open or started, idle or unassigned) is deliberately quiet. Agent
// states come only from live AW sessions; captured sessions pass none, so a
// snapshot never shows current activity or a request for input.
export function primaryKind(bead, waits, agentDots, humanWaits = 0, ownerDot = null) {
  if (humanWaits || agentDots.includes('needs')) return 'person';
  if (bead.status === 'closed') return bead.outcome === 'done' ? 'done' : 'closed';
  if (['requested', 'in_review'].includes(bead.reviewState)) return bead.reviewWorking ? 'review-working' : 'review-pending';
  if (bead.untracked) return 'untracked';
  if (agentDots.includes('working')) return 'busy';
  if (['open', 'in_progress'].includes(bead.status) && bead.reviewState === 'approved') return 'approved';
  if (waits.length) return 'waiting';
  if (bead.status === 'deferred') return 'deferred';
  if (bead.status === 'in_progress' && ownerDot === 'idle') return 'in-progress';
  if (bead.kind === 'external') return 'external';
  if (bead.pickup?.armed && ['ready', 'queued'].includes(bead.pickup.state)) return 'pickup';
  return null;
}

const MARK_WORDS = {
  person: 'An agent is waiting for input',
  pickup: 'Ready for pickup; awaiting automatic worker start',
  'review-working': 'In review: reviewer working',
  'review-pending': 'In review: review pending',
  done: 'Done',
  untracked: 'Untracked: started work has no live claimant or open blocker',
  busy: 'An agent is working on it',
  approved: 'Approved, awaiting release',
  'in-progress': 'In progress; agent idle',
  deferred: 'Deferred',
  external: 'External prerequisite',
};

export function markWords(kind, bead) {
  if (kind === 'closed') return `Closed (${bead.outcome || 'no outcome recorded'})`;
  if (kind === 'waiting') return 'Waiting on a prerequisite';
  return MARK_WORDS[kind] || '';
}
const STATUS_LABEL = { in_review: 'In review', open: 'Open', in_progress: 'In progress', deferred: 'Deferred', closed: 'Closed' };

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
  const externalWait = waits.some(id => hive.beads[id]?.kind === 'external');
  const designWait = waits.some(id => ['decision', 'investigation'].includes(hive.beads[id]?.kind));
  let badge = designWait ? 'Waiting on design' : undefined;
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
    waits.length ? `${designWait ? 'Waiting on design. ' : ''}Needed first: ${waits.map((id) => hive.beads[id]?.title || id).join('; ')}` : '',
    ['requested', 'in_review'].includes(bead.reviewState) ? [bead.review?.summary, bead.review?.waitingFor].filter(Boolean).join('; ') : '',
  ].filter(Boolean);
  const own = `${state}${waits.length ? `, waits on ${waits.length}` : ''}${['requested', 'in_review'].includes(bead.reviewState) ? `, ${bead.reviewWorking ? 'reviewer working' : 'review pending'}` : ''}`;
  const waiting = waitingItems(ctx, bead);
  const kind = primaryKind(bead, waits, agents?.dots || [], waiting.length, !snap && owner ? statusDot(graph, owner) : null);
  const attention = waiting.length ? `${waiting.length} waiting for you: ${waiting.map(item => item.title).join('; ')}` : '';
  const prIds = isHead ? cellBeadIds({ beads: hive.beads }, { rootBeadId: bead.id }) : new Set([bead.id]);
  const prs = prSummary((cell?.pullRequests || []).filter(pr => pr.beadIds.some(id => prIds.has(id))));
  const marks = [];
  if (kind) marks.push({ kind, focus: kind === 'waiting' && Boolean(waitReason), count: waiting.length, onMark: waiting.length ? anchor => openWaitingMenu(ctx, waiting, anchor, { cellId: cell.id, beadId: bead.id, actionsOnly: true }) : null, title: [attention || markWords(kind, bead), kind === 'waiting' && waitReason ? `Waiting for: ${waitReason}` : ''].filter(Boolean).join('. ') });
  if (kind === 'waiting' && externalWait) marks.push({ kind: 'external', title: 'Waiting on something outside this hive' });
  if (status === 'in_review' && !kind?.startsWith('review-')) marks.push({ kind: bead.reviewWorking ? 'review-working' : 'review-pending', title: markWords(bead.reviewWorking ? 'review-working' : 'review-pending', bead) });
  if (waitReason && kind !== 'waiting') marks.push({ kind: 'recorded-wait', title: `Waiting for: ${waitReason}` });
  const detail = `${externalWait ? 'Waiting on something outside this hive. ' : ''}${waitReason ? `Waiting for: ${waitReason}. ` : ''}${attachmentText ? `${attachmentText} ` : ''}Work: ${isHead ? `${countText}; ` : ''}${own}. ${agentText}.${waitReasons.length ? ` Waiting: ${waitReasons.join('; ')}.` : ''}`;
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
    onMark: waiting.length ? anchor => openWaitingMenu(ctx, waiting, anchor, { cellId: cell.id, beadId: bead.id, actionsOnly: true }) : null,
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
        : 'One person icon for every human wait: agent input, a Hive decision or action request or a PR explicitly waiting on you. Unread messages stay in Topics and Inbox. Several waits get a count badge. Worker-handled failing checks stay quiet. One mark per item, most urgent first. Waiting for input means an attached agent is asking someone something; the cross means the work itself waits on a prerequisite. Plain magnifier badges show review: green while the reviewer works, blue while pending. The prerequisite cross is grey; amber marks untracked work. A green outlined triangle means ready for automatic pickup. A chain-link glyph marks an external prerequisite; a cross beside a chain-link means waiting on something outside this hive. Review marks remain visible alongside them. A recorded wait uses an hourglass unless the primary mark is a waiting cross; then its reason is included in the cross tooltip. The outlined progress arc means in-progress work with an idle live owner. Items with no mark have no activity or recorded wait. Each tooltip names every agent and its state.',
    }, [...(snapshot ? [] : [['person', 'waiting for you (count when several)'], ['busy', 'agent working'], ['review-working', 'in review: reviewer working'], ['review-pending', 'in review: review pending'], ['in-progress', 'in progress; agent idle']]), ['approved', MARK_WORDS.approved], ['pickup', 'ready for automatic pickup'], ['external', 'external: outside this hive (teammate PR, release, vendor)'], ['recorded-wait', 'recorded wait (cross carries reason when waiting)'], ['untracked', 'untracked work'], ['waiting', 'waiting on prerequisites'], ['deferred', 'deferred'], ['done', 'done'], ['closed', 'closed otherwise']].map(([k, label]) => h('span', { class: 'hive-legend-st' },
      h('svg:svg', { viewBox: '-8 -8 16 16', width: '14', height: '14', 'aria-hidden': 'true' }, primaryMark(k, label)), label)),
      h('span', { class: 'hive-legend-st' },
        h('svg:svg', { viewBox: '-8 -8 36 16', width: '32', height: '14', 'aria-hidden': 'true' },
          primaryMark('waiting', 'Waiting on a prerequisite'), primaryMark('external', 'External prerequisite', 20)),
        'waiting on something outside this hive')),
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
  if (cell.snapshot) return Boolean(root || cell.snapshot.brief);
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
      root?.goal ? markdown(api, root.goal) : cell.snapshot?.brief
        ? [h('p', { class: 'hive-muted' }, 'Board brief, not a confirmed goal:'), markdown(api, cell.snapshot.brief)]
        : h('p', { class: 'hive-muted' }, cell.snapshot ? 'No goal was confirmed on the captured board.' : 'No goal written yet.'),
      root?.acceptance ? [h('h4', {}, 'Done when'), markdown(api, root.acceptance)] : null,
      h('p', { class: 'hive-muted' }, 'Select a bead or a workstream to see its details here. Use the queen pill to manage the queen, and Settings for its instructions.'));
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
    !cell.snapshot && !cell.retired && bead.status !== 'closed' && bead.kind === 'workstream' && detail.bead ? workerProfileForm(ctx, cell, detail.bead) : null,
    cell.snapshot ? null : pickupDetails(ctx, cell, { ...bead, pickup: detail.bead?.pickup || bead.pickup }),
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
    detail.bead?.history ? beadHistorySection(ctx, detail.bead.history) : null,
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

function beadHistorySection(ctx, entries) {
  return h('section', { class: 'hive-history', 'aria-label': 'History' },
    h('h4', {}, 'History'),
    h('p', { class: 'hive-muted' }, 'Recorded events only; older records may be incomplete.'),
    entries.length ? h('ol', { class: 'hive-history-list' }, entries.map(e => h('li', {},
      e.at ? h('time', { datetime: e.at, title: e.at, class: 'hive-muted' }, new Date(e.at).toLocaleString()) : h('span', { class: 'hive-muted' }, 'Time not recorded'),
      ' · ', e.by ? (e.by.startsWith('aw:') || e.by === 'hive' ? e.by : sessionLabel(ctx.graph, e.by)) : 'Who not recorded',
      h('strong', {}, e.outcome),
      h('span', { class: 'hive-history-reason', title: e.reason || '' }, e.reason || 'No stop reason recorded.'))))
      : h('p', { class: 'hive-muted' }, 'No attempt history recorded.'));
}

// Exact counts for a workstream, over every item nested beneath it.
function workstreamProgress(c) {
  if (!c.total) return h('div', { class: 'hive-row' }, h('strong', {}, 'Progress: '), 'no work items yet');
  const parts = [`${c.closed} of ${c.total} closed`];
  if (c.in_progress) parts.push(`${c.in_progress} in progress`);
  if (c.in_review) parts.push(`${c.in_review} in review`);
  if (c.not_active) parts.push(`${c.not_active} not active`);
  if (c.waiting) parts.push(`${c.waiting} waiting`);
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
  h('p', { class: 'hive-muted' }, cell.queenSessionId ? 'The current queen sees the change the next time it reads hive_context; use Send brief to tell it now.' : 'The next queen launched for this hive receives them.'),
  errorNote(editing.error),
  h('div', { class: 'hive-actions' },
    h('button', { type: 'submit', class: 'hive-btn hive-btn-primary', disabled: Boolean(editing.pending) }, editing.pending ? 'Saving…' : 'Save'),
    h('button', { type: 'button', class: 'hive-btn', onclick: () => ui.setForm(key, null) }, 'Cancel')));
}

function queenBar(ctx, cell) {
  const { graph, ui, send, busy, api } = ctx;
  const launchForm = ui.form(`launch:${cell.id}`);
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
    launch?.active ? null : h('button', { type: 'button', class: cell.queenSessionId ? 'hive-quiet-btn' : 'hive-btn', 'data-focus-key': `queen-launch:${cell.id}`, onclick: () => ui.setForm(`launch:${cell.id}`, launchForm ? null : { autoCompactTokens: 250000, handoverSourceSessionId: cell.queenSessionId || '', archiveSourceAfterHandover: true }) }, launchForm ? 'Cancel launch' : 'Launch a new queen…'),
    launchForm ? h('form', {
      class: 'hive-form hive-form-inline',
      onsubmit: (e) => {
        e.preventDefault();
        const form = ui.form(`launch:${cell.id}`) || {};
        const sourceError = handoverError(ctx.hive, form, cell.taskId);
        if (sourceError) return ctx.notice(sourceError);
        const { instructions, ...settings } = form;
        send({ type: 'hive-queen-launch', cellId: cell.id, ...settings, instructions: instructions ?? cell.queenInstructions ?? '' }, {
          onReply: (frame) => {
            if (!frame.ok) return ctx.notice(frame.error || 'The queen did not launch.', { severity: 'error' });
            ui.setForm(`launch:${cell.id}`, null);
          },
        });
      },
    }, launchFields(api, launchForm, (next) => ui.setForm(`launch:${cell.id}`, { ...ui.form(`launch:${cell.id}`), ...next }), (p) => ui.patchForm(`launch:${cell.id}`, p)),
    handoverFields(ctx.hive, launchForm, next => ui.setForm(`launch:${cell.id}`, { ...ui.form(`launch:${cell.id}`), ...next }), cell.taskId, Boolean(cell.queenSessionId)),
    instructionsField(launchForm.instructions ?? cell.queenInstructions ?? '', (text) => ui.patchForm(`launch:${cell.id}`, { instructions: text }), `launch-instructions:${cell.id}`),
    h('button', { type: 'submit', class: 'hive-btn hive-btn-primary', disabled: busy('hive-queen-launch') }, busy('hive-queen-launch') ? 'Launching…' : 'Launch queen')) : null);
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
function queenPill(ctx, cell, openQueen) {
  const { graph, hive } = ctx;
  if (cell.snapshot) {
    const snap = cell.snapshot;
    return h('button', { type: 'button', class: 'hive-setup-pill is-snapshot', 'aria-haspopup': 'dialog', 'data-focus-key': `queen-open:${cell.id}`, onclick: openQueen }, `Captured snapshot${snap.capturedAt ? `, ${relativeTime(snap.capturedAt)}` : ''}: read only`);
  }
  if (!cell.enabled) return h('button', { type: 'button', class: 'hive-setup-pill hive-pill-btn', 'aria-haspopup': 'dialog', 'data-focus-key': `queen-open:${cell.id}`, onclick: openQueen }, 'Queen');
  if (!cell.queenSessionId) {
    const launch = launchState(hive, cell);
    return h('button', { type: 'button', class: 'hive-setup-pill hive-pill-btn', 'aria-haspopup': 'dialog', 'data-focus-key': `queen-open:${cell.id}`, onclick: openQueen, title: 'Manage the queen' }, launch ? launch.text : 'Setup incomplete: no queen');
  }
  const dot = statusDot(graph, cell.queenSessionId);
  const a = cell.activation;
  const brief = a && a.sessionId === cell.queenSessionId ? { failed: 'brief not delivered', uncertain: 'brief unconfirmed' }[a.state] : null;
  return h('button', {
    type: 'button',
    class: `hive-queen-pill${brief ? ' is-warn' : ''}`,
    'aria-haspopup': 'dialog', 'data-focus-key': `queen-open:${cell.id}`, onclick: openQueen,
    title: `Queen: ${sessionLabel(graph, cell.queenSessionId)}, ${STATUS_TEXT[dot]}. Manage the queen.`,
  },
  h('span', { class: `hive-dot-inline hive-dot-${dot}`, 'aria-hidden': 'true' }),
  `Queen${['working', 'idle'].includes(dot) ? '' : ` ${STATUS_TEXT[dot]}`}`, brief ? ` · ${brief}` : '');
}

function headProgress(counts) {
  if (!counts) return null;
  return h('span', { class: 'hive-counts hive-headprogress', title: countsSentence(counts) },
    counts.total ? progressBar(counts.closed, counts.total) : null,
    counts.total ? `${counts.closed}/${counts.total} closed` : 'No work yet');
}

function cellHeader(ctx, cell, root) {
  const { graph, ui, send, hive } = ctx;
  const metrics = cellMetrics(ctx, cell);
  const counts = root && (cell.enabled || isRetired(cell)) ? metrics.work : null;
  const waiting = metrics.waitingItems;
  return h('header', { class: 'hive-cellhead' },
    h('div', { class: 'hive-cellhead-top' },
      h('button', { type: 'button', class: 'hive-back', onclick: () => ui.closeCell(), 'aria-label': 'Show all hives', title: 'Show all hives' },
        h('span', { class: 'hive-back-icon', 'aria-hidden': 'true' }), 'All hives'),
      h('span', { class: 'hive-crumb-sep', 'aria-hidden': 'true' }, '/'),
      h('h2', { class: 'hive-celltitle' }, cellTitle(ctx, cell)),
      isRetired(cell) ? h('span', { class: 'hive-badge hive-badge-retired', title: cell.retired.summary }, `Retired · ${cell.retired.outcome}`) : (cell.enabled ? null : h('span', { class: 'hive-badge' }, 'Off')),
      h('div', { class: 'hive-cellstate' },
        capacityControl(ctx),
        headProgress(counts),
        waiting.length ? h('button', { type: 'button', class: 'hive-queen-pill hive-waiting', 'aria-haspopup': 'dialog', 'data-focus-key': 'waiting-header', onclick: event => openWaitingMenu(ctx, waiting, event.currentTarget, { cellId: cell.id }) },
          h('span', { class: 'hive-dot-inline hive-dot-needs', 'aria-hidden': 'true' }), `${waiting.length} need you`) : null,
        queenPill(ctx, cell, event => openQueenPopover(ctx, cell, event.currentTarget))),
      h('div', { class: 'hive-head-actions' },
        isRetired(cell) ? h('button', { type: 'button', class: 'hive-btn hive-btn-primary', onclick: () => openReopen(ctx, cell), 'data-focus-key': `reopen-open:${cell.id}` }, 'Reopen hive…') : (cell.enabled || cell.snapshot ? null : h('button', { type: 'button', class: 'hive-btn hive-btn-primary', onclick: () => send({ type: 'hive-cell-enable', cellId: cell.id }) }, 'Turn on')),
        settingsButton(ctx, cell))),
    settingsModal(ctx, cell, (leave, section) => hiveSettings(ctx, cell, leave, section)),
    attentionEl(ctx, { cellId: cell.id }),
    noticesEl(ctx));
}

export function openQueenPopover(ctx, cell, anchor) {
  openCellPopover(ctx, cell, anchor, 'Queen', (next, current) => current.snapshot ? snapshotQueen(next, current)
    : current.enabled ? queenBar({ ...next, ui: { ...next.ui, inspect: id => { disposeCellPopover(); next.ui.inspect(id); } } }, current)
      : h('p', { class: 'hive-muted' }, isRetired(current) ? 'This hive is retired. Reopen it to manage its queen.' : 'Turn the hive on to manage its queen.'));
}

export function hiveSettings(ctx, cell, leave = () => true, section = null) {
  const { send } = ctx;
  const retire = () => { if (leave()) openRetire(ctx, cell); };
  const reopen = () => { if (leave()) openReopen(ctx, cell); };
  const show = id => section === null || section === id;
  const editable = !cell.snapshot && !isRetired(cell);
  if (isRetired(cell) && ['agents', 'advanced'].includes(section)) return h('p', { class: 'hive-muted' }, 'Reopen the hive in Lifecycle to change these settings.');
  return [
    show('general') ? [h('div', { class: 'hive-settings-name' }, h('span', {}, 'Name'), cellTitle(ctx, cell, 'settings-rename')), cellGoalForm(ctx, cell),
      editable ? queenInstructions(ctx, cell) : null] : null,
    show('advanced') && editable ? advancedSettings(ctx.ui, cell.id, watchdogSummary(cell), watchdogSettingsForm(ctx, cell)) : null,
    !show('agents') || !editable ? null : codexApprovalsForm(ctx, cell),
    !show('agents') || !editable ? null : workstreamProfileSettings(ctx, cell),
    !show('agents') || !editable ? null : reviewPolicyForm(ctx, cell),
    !show('lifecycle') || cell.snapshot ? null : h('section', {},
      h('h4', {}, 'Lifecycle'),
      isRetired(cell)
        ? [h('p', { class: 'hive-muted' }, `Retired as ${cell.retired.outcome}${cell.retired.at ? `, ${relativeTime(cell.retired.at)}` : ''}: ${cell.retired.summary}`),
          h('button', { type: 'button', class: 'hive-btn hive-btn-primary', onclick: reopen }, 'Reopen hive…')]
        : [h('p', { class: 'hive-muted' }, cell.enabled ? 'Turning the hive off keeps its record. Agents cannot use it until it is turned on again.' : 'This hive is off. Its record is kept; turn it on to see its work and to let agents use it.'),
          cell.enabled
            ? h('button', { type: 'button', class: 'hive-btn', onclick: () => send({ type: 'hive-cell-disable', cellId: cell.id }) }, 'Turn hive off')
            : h('button', { type: 'button', class: 'hive-btn hive-btn-primary', onclick: () => send({ type: 'hive-cell-enable', cellId: cell.id }) }, 'Turn hive on'),
          h('p', { class: 'hive-muted' }, 'Retiring a finished hive records its outcome and takes it off the All hives map.'),
          h('button', { type: 'button', class: 'hive-btn', onclick: retire, 'data-focus-key': `retire-open:${cell.id}`, 'aria-haspopup': 'dialog' }, 'Retire hive…')])];
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

// The focused task's header and action drawers, and the dock with its
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
  const details = cell.snapshot || cell.enabled || isRetired(cell) ? beadDetails(ctx, cell) : h('section', { class: 'hive-panel hive-details', tabindex: '-1', 'data-focus-key': 'panel:details', 'aria-label': 'Details', 'data-pane': 'details' },
    h('h3', {}, 'Details'), h('p', { class: 'hive-muted' }, 'This hive is off. Turn it on to see its work.'));
  const history = cell.enabled && !cell.snapshot && (!root || ui.inspecting()) ? closedButton(ctx, cell) : null;
  if (history) details.append(history);
  const dock = hasPanels(cell, root) || history ? syncChildren(cached.dock, [conversation, details]) : null;
  return {
    header: cellHeader(ctx, cell, root),
    drawer: retireDrawer(ctx, cell) || workstreamDrawer(ctx, cell),
    tabs: dock ? paneTabs(ui) : null,
    inspectbar,
    dock,
    inspecting: Boolean(inspecting),
    related: convo?.related,
    onKeyDown,
  };
}
