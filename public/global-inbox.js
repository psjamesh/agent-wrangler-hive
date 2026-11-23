import { requestDisplay } from './request-state.js';
import { compareTopics } from './topic-order.js';
import { h, relativeTime } from './dom.js';
import { hiveLink } from './deep-links.js';
import { needsHuman, requestAuthor } from './requests.js';
import { cellName, queenNeedsAttention, queenNotResponding, queenStopped, queenSuspended, sessionNode } from './model.js';
import { filterRows, highlightParts, searchTerms, snippetFor } from './inbox-search.js';
import { inboxMessages, inboxMessageCount, topicTitles, topicPriorities, messageAuthor } from './conversation.js';

export const GLOBAL_FILTERS = [['human', 'Inbox'], ['queen', 'Waiting for queen']];

const messageCount = count => `${count} message${count === 1 ? '' : 's'}`;

const oneLine = (text, n) => String(text || '').replace(/\s+/g, ' ').trim().slice(0, n);

export function needsRows(ctx, cells) {
  const { graph } = ctx;
  const rows = [];
  for (const cell of cells) {
    const unresponsive = queenNotResponding(graph, cell);
    const stopped = queenStopped(graph, cell);
    const suspended = queenSuspended(graph, cell);
    const title = suspended ? 'Queen stopped or suspended' : stopped ? 'Queen stopped' : unresponsive ? 'Queen not responding' : 'Queen needs attention';
    const preview = suspended ? 'The queen may be suspended with unanswered input. Resume its session card on the board.' : stopped ? (sessionNode(graph, cell.queenSessionId)?.archived ? 'The queen has stopped with unanswered input. Restore its archived card on the board or arrange a queen handoff.' : 'The queen has stopped with unanswered input. Resume its session card on the board or arrange a queen handoff.') : unresponsive ? 'Pending input has had no queen activity. Open the queen session to check.' : 'The queen is waiting for input at its terminal.';
    if (queenNeedsAttention(graph, cell)) rows.push({
      key: `queen:${cell.id}`, cellId: cell.id, hive: cellName(graph, cell), title, at: 0, hideTime: true,
      preview, texts: [title, preview], beadIds: [],
      needsCount: 1, count: 0, scanSessionReferences: false, sessionLinks: sessionNode(graph, cell.queenSessionId)?.archived ? [] : [{ sessionId: cell.queenSessionId, label: 'Open session' }],
      link: stopped && !suspended ? hiveLink(cell.id) : `#session=${encodeURIComponent(cell.queenSessionId)}`,
    });
    const titles = topicTitles(cell, ctx.hive, ctx.ui);
    for (const r of Object.values(cell.requests || {})) {
      if (!needsHuman(r)) continue;
      const display = requestDisplay(r);
      rows.push({
        rewritten: display.rewritten,
        key: `request:${r.id}`, cellId: cell.id, hive: cellName(graph, cell), title: display.rewritten ? display.title : titles.get(r.threadId) || r.title, at: r.createdAt, blocking: Boolean(r.blocking),
        author: requestAuthor(graph, r), preview: oneLine(display.body, 200), texts: [display.body, display.title].filter(Boolean), beadIds: [r.beadId].filter(Boolean), repair: r.state === 'answered' ? (['failed', 'uncertain'].includes(r.delivery?.state) ? 'Answer needs delivery repair' : 'Answer being delivered') : null,
        threadId: r.threadId, firstId: r.messageId, needsCount: 1, count: 0, sessionLinks: [r.sessionLink, r.requesterSessionLink || (r.requesterSessionId ? { sessionId: r.requesterSessionId, label: 'Open requester session' } : null)].filter(Boolean),
        link: hiveLink(cell.id, r.threadId),
      });
    }
  }
  return rows.sort((a, b) => Number(b.blocking) - Number(a.blocking) || a.at - b.at || (a.key < b.key ? -1 : 1));
}

export function messageRows(ctx, cells, kind) {
  const { hive, graph, ui } = ctx;
  const rows = [];
  for (const cell of cells) {
    const titles = topicTitles(cell, hive, ui);
    const byThread = new Map();
    for (const m of inboxMessages(cell, hive, ui, kind)) {
      const k = m.threadId || m.id;
      if (!byThread.has(k)) byThread.set(k, []);
      byThread.get(k).push(m);
    }
    for (const group of byThread.values()) {
      const first = group[0], last = group.at(-1);
      rows.push({
        key: `message:${cell.id}:${first.id}`, cellId: cell.id, hive: cellName(graph, cell), title: titles.get(first.threadId) || 'Topic no longer kept',
        at: first.at, count: group.length, unreadCount: kind === 'human' ? group.length : 0, author: messageAuthor(graph, cell, last), preview: oneLine(last.text, 200),
        sessionLinks: group.map(m => m.sessionLink).filter(Boolean), texts: group.map(m => m.text), beadIds: group.map(m => m.context?.beadId || m.beadId).filter(Boolean), threadId: first.threadId,
        link: hiveLink(cell.id, first.threadId),
      });
    }
    const held = [...byThread.values()].reduce((n, g) => n + g.length, 0);
    const more = inboxMessageCount(cell, hive, ui, kind) - held;
    if (more > 0) rows.push({ key: `more:${cell.id}:${kind}`, cellId: cell.id, hive: cellName(graph, cell), title: `${more} more ${kind === 'human' ? 'unread' : 'awaiting an answer'} in this hive`, at: Infinity, count: 0, more, preview: 'Open the hive to see them.', link: hiveLink(cell.id) });
  }
  return rows.sort((a, b) => a.at - b.at || (a.key < b.key ? -1 : 1));
}

const rowOrder = (a, b) => Number(Boolean(b.needsCount)) - Number(Boolean(a.needsCount)) || a.at - b.at || a.key.localeCompare(b.key);
const threadKey = r => `${r.cellId}:${r.threadId || r.key}`;

export function mergeRows(messages, requests) {
  const rows = new Map(messages.map(r => [threadKey(r), { ...r, needsCount: 0 }]));
  for (const request of requests) {
    const key = threadKey(request);
    const row = rows.get(key);
    if (!row) rows.set(key, { ...request });
    else {
      if (request.rewritten) { row.title = request.title; row.preview = request.preview; row.snippet = null; }
      row.needsCount += 1;
      row.at = Math.min(row.at, request.at);
      row.texts = [...(row.texts || []), ...request.texts];
      row.beadIds = [...(row.beadIds || []), ...request.beadIds];
      row.repair ||= request.repair;
      row.sessionLinks = [...(row.sessionLinks || []), ...request.sessionLinks];
    }
  }
  return [...rows.values()].sort(rowOrder);
}

export function orderInboxTopics(ctx, cells, rows) {
  const priorities = new Map(cells.map(cell => [cell.id, topicPriorities(cell, ctx.hive, ctx.ui)]));
  const priority = row => {
    const topic = priorities.get(row.cellId)?.get(row.threadId);
    return {
      id: `${row.cellId}:${row.threadId || row.key}`, lastAt: topic?.lastAt ?? row.lastAt ?? row.at,
      needsCount: topic?.needsCount ?? row.needsCount, unreadCount: topic?.unreadCount ?? row.unreadCount ?? row.count,
    };
  };
  return rows.map(row => ({
    ...row, unreadCount: priorities.get(row.cellId)?.get(row.threadId)?.unreadCount ?? row.unreadCount ?? 0,
  })).sort((a, b) => compareTopics(priority(a), priority(b)) || a.key.localeCompare(b.key));
}

export function inboxRows(ctx, cells, kind) {
  const rows = kind === 'queen' ? messageRows(ctx, cells, kind) : mergeRows(messageRows(ctx, cells, 'human'), needsRows(ctx, cells));
  return orderInboxTopics(ctx, cells, rows);
}

export function remoteRows(ctx, cells, remote, kind) {
  const { graph } = ctx;
  const byId = new Map(cells.map(c => [c.id, c]));
  const rows = [];
  for (const r of remote?.[kind] || []) {
    const cell = byId.get(r.cellId);
    if (!cell) continue;
    rows.push({
      key: r.key, threadId: r.threadId, cellId: cell.id, hive: cellName(graph, cell), title: r.title || 'Topic no longer kept', at: r.at, lastAt: r.lastAt, count: r.count, unreadCount: kind === 'human' ? r.count : 0,
      beadIds: r.beadIds || [], texts: [r.last?.text, r.snippet, r.preview].filter(Boolean), sessionLinks: r.sessionLinks || [r.last?.sessionLink].filter(Boolean),
      author: messageAuthor(graph, cell, r.last), snippet: r.snippet, preview: r.preview, link: hiveLink(cell.id, r.threadId),
    });
  }
  return rows.sort((a, b) => a.at - b.at || (a.key < b.key ? -1 : 1));
}

export function conversationRows(ctx, cells) {
  return cells.flatMap(cell => {
    const topics = new Map((cell.threads || []).map(t => [t.id, t]));
    for (const m of cell.messages || []) if (!topics.has(m.threadId)) topics.set(m.threadId, { id: m.threadId, title: 'Topic no longer kept' });
    const grouped = new Map();
    for (const m of cell.messages || []) {
      if (!grouped.has(m.threadId)) grouped.set(m.threadId, []);
      grouped.get(m.threadId).push(m);
    }
    return [...topics.values()].map(t => {
      const messages = grouped.get(t.id) || [];
      const last = messages.at(-1) || t.preview;
      return { key: `topic:${cell.id}:${t.id}`, cellId: cell.id, threadId: t.id, hive: cellName(ctx.graph, cell), title: t.title,
        at: t.lastAt || last?.at || 0, count: messages.length, texts: [...messages.map(m => m.text), t.preview?.text].filter(Boolean),
        beadIds: [t.beadId, t.about, ...messages.map(m => m.context?.beadId || m.beadId)].filter(Boolean),
        preview: last?.text || '', author: last ? messageAuthor(ctx.graph, cell, last) : '', link: hiveLink(cell.id, t.id) };
    });
  });
}

export function searchedInbox(ctx, cells, query, remoteState) {
  const { remote, pending = false, failed = false } = remoteState || {};
  const requests = needsRows(ctx, cells);
  const local = filterRows(mergeRows([...messageRows(ctx, cells, 'human'), ...conversationRows(ctx, cells)], requests), query);
  let human = local;
  if (remote) {
    const messages = remoteRows(ctx, cells, remote, remote.topics ? 'topics' : 'human');
    const requestMatches = new Set(local.filter(r => r.needsCount).map(threadKey));
    const remoteKeys = new Set(messages.map(threadKey));
    messages.push(...messageRows(ctx, cells, 'human').filter(r => requestMatches.has(threadKey(r)) && !remoteKeys.has(threadKey(r))));
    const matched = new Set([...messages.map(threadKey), ...requestMatches]);
    human = mergeRows(messages, requests).filter(r => matched.has(threadKey(r))).map(r => ({ ...r, snippet: r.snippet || snippetFor(r.texts || [], query) }));
  }
  const lists = {
    human: orderInboxTopics(ctx, cells, human),
    queen: orderInboxTopics(ctx, cells, remote ? remoteRows(ctx, cells, remote, 'queen') : filterRows(messageRows(ctx, cells, 'queen'), query)),
  };
  return { lists, pending, failed, truncated: Boolean(remote?.truncated) };
}

export function marked(text, query) {
  return highlightParts(text, query).map(p => p.hit ? h('mark', { class: 'hive-search-hit' }, p.text) : p.text);
}

function needsBadge(count) {
  return h('span', { class: 'hive-inbox-count hive-needs-count', 'aria-label': `${count} needs you`, title: `${count} needs you` }, String(count));
}

export function globalInbox(ctx, cells) {
  const { ui, hive } = ctx;
  const view = ui.globalInboxView() === 'queen' ? 'queen' : 'human';
  const counts = { needs: needsRows(ctx, cells).length, human: 0, queen: 0 };
  const lists = { human: null, queen: null };
  for (const kind of ['human', 'queen']) {
    lists[kind] = inboxRows(ctx, cells, kind);
    counts[kind] = cells.reduce((n, c) => n + inboxMessageCount(c, hive, ui, kind), 0);
  }
  const query = ui.searchQuery?.() || '';
  const searching = searchTerms(query).length > 0;
  const found = searching ? searchedInbox(ctx, cells, query, ui.askGlobalInboxSearch?.(cells.map(c => c.id), `${hive.revision}:${hive.metaVersion}`, hive.metaEpoch)) : null;
  const rows = searching ? found.lists[view] : lists[view];
  const filterCounts = { human: lists.human.length, queen: counts.queen };
  const filters = inboxFilters(view, filterCounts, kind => ui.setGlobalInboxView(kind));
  const label = GLOBAL_FILTERS.find(f => f[0] === view)[1];
  const elsewhere = searching ? GLOBAL_FILTERS.filter(([k]) => k !== view && found.lists[k].length).map(([k, l]) => `${found.lists[k].length} in ${l}`) : [];
  const empty = searching ? `No topics match “${query.trim()}” in ${label}.${elsewhere.length ? ` ${elsewhere.join(', ')}.` : ''}` : view === 'human' ? 'No unread messages or open requests in any hive.' : 'None of your messages is waiting for an answer.';
  const list = h('ol', { class: 'hive-topics hive-inbox hive-global-inbox-list', 'aria-label': GLOBAL_FILTERS.find(f => f[0] === view)[1] },
    rows.length ? rows.map(r => inboxRow(ctx, r, { query: searching ? query : '' })) : h('li', { class: 'hive-muted' }, empty));

  return h('div', { class: 'hive-dock hive-global-dock' },
    h('section', { class: 'hive-panel hive-conversation hive-global-inbox', tabindex: '-1', 'data-focus-key': 'panel:global-inbox', 'data-scroll-key': 'panel:global-inbox', 'aria-label': 'Inbox across all hives', 'data-pane': 'conversation' },
      h('div', { class: 'hive-inbox-heading' }, h('h3', {}, 'Inbox'), h('div', { class: 'hive-inbox-totals' }, inboxTotals(counts))),
      h('div', { class: 'hive-inbox-toolbar' }, searchStatus(query, rows, found), filters), list));
}


export function inboxTotals(counts) {
  return [counts.needs ? [needsBadge(counts.needs), ' needs you · '] : null, messageCount(counts.human)].filter(Boolean);
}

export function inboxFilters(view, counts, select, key = 'global-inbox') {
  return h('div', { class: 'hive-inbox-filters', role: 'group', 'aria-label': 'Inbox filter' },
    GLOBAL_FILTERS.map(([kind, label]) => h('button', {
      type: 'button', class: `hive-inbox-filter${view === kind ? ' is-on' : ''}${counts[kind] ? ' has-items' : ''}`,
      'aria-pressed': String(view === kind), 'data-focus-key': `${key}:${kind}`, onclick: () => select(kind),
    }, label, counts[kind] ? [' ', h('span', { class: 'hive-inbox-count', 'aria-label': `${counts[kind]} ${kind === 'human' ? 'topics' : 'waiting'}` }, String(counts[kind]))] : null)));
}

export function inboxRow(ctx, r, { query = '', open, id = r.key, action, showContext = true } = {}) {
  const props = open ? { type: 'button', onclick: () => open(r) } : { href: r.link };
  return h('li', { class: `hive-topic hive-inbox-item${r.unreadCount > 0 ? ' is-unread' : ''}`, dataset: { id } },
    h(open ? 'button' : 'a', { ...props, class: 'hive-topic-btn', 'data-focus-key': `global-inbox-item:${r.key}` },
      h('span', { class: 'hive-topic-line' },
        h('strong', { class: 'hive-topic-title' }, query ? marked(r.title, query) : r.title),
        r.count > (r.unreadCount > 0 ? 0 : 1) ? h('span', { class: 'hive-unread', 'aria-label': messageCount(r.count) }, String(r.count)) : null,
        r.needsCount ? needsBadge(r.needsCount) : null,
        r.hideTime ? null : h('span', { class: 'hive-muted hive-topic-time' }, relativeTime(r.at))),
      h('span', { class: 'hive-topic-line' },
        showContext ? h('span', { class: 'hive-chip hive-topic-context' }, r.hive) : null,
        h('span', { class: 'hive-muted hive-topic-preview' }, query ? [r.author ? `${r.author}: ` : '', marked(r.snippet || r.preview || '', query)] : [r.author, r.preview].filter(Boolean).join(': ')),
        r.repair ? h('span', { class: 'hive-warning' }, r.repair) : null)),
    action);
}

export function searchStatus(query, rows, found) {
  const status = !searchTerms(query).length || !found ? '' : found.failed ? 'Searching loaded messages only: the full search failed.'
    : `${rows.length} topic${rows.length === 1 ? '' : 's'} match${rows.length === 1 ? 'es' : ''}${found.pending ? ' · searching all messages…' : ''}${found.truncated ? ' · first matches only' : ''}`;
  return h('span', { class: 'hive-muted hive-inbox-search-status', role: 'status', 'aria-live': 'polite' }, status);
}
