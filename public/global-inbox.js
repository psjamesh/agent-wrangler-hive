import { h, relativeTime, markdown, sessionReference } from './dom.js';
import { hiveLink } from './deep-links.js';
import { needsHuman, requestAuthor } from './requests.js';
import { cellName } from './model.js';
import { filterRows, highlightParts, searchTerms, snippetFor } from './inbox-search.js';
import { waitingMessages, waitingCount, topicTitles, messageAuthor } from './conversation.js';

export const GLOBAL_FILTERS = [['human', 'Inbox'], ['queen', 'Waiting for queen']];

const messageCount = count => `${count} message${count === 1 ? '' : 's'}`;

const oneLine = (text, n) => String(text || '').replace(/\s+/g, ' ').trim().slice(0, n);

export function needsRows(ctx, cells) {
  const { graph } = ctx;
  const rows = [];
  for (const cell of cells) {
    for (const r of Object.values(cell.requests || {})) {
      if (!needsHuman(r)) continue;
      rows.push({
        key: `request:${r.id}`, cellId: cell.id, hive: cellName(graph, cell), title: r.title, at: r.createdAt, blocking: Boolean(r.blocking),
        author: requestAuthor(graph, r), preview: oneLine(r.body, 200), texts: [r.body, r.title].filter(Boolean), beadIds: [r.beadId].filter(Boolean), repair: r.state === 'answered' ? (['failed', 'uncertain'].includes(r.delivery?.state) ? 'Answer needs delivery repair' : 'Answer being delivered') : null,
        threadId: r.threadId, firstId: r.messageId, needsCount: 1, count: 0, sessionLinks: [r.sessionLink, r.requesterSessionLink || (r.requesterSessionId ? { sessionId: r.requesterSessionId, label: 'Open requester session' } : null)].filter(Boolean),
        link: hiveLink(cell.id, r.threadId, r.messageId),
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
    for (const m of waitingMessages(cell, hive, ui, kind)) {
      const k = m.threadId || m.id;
      if (!byThread.has(k)) byThread.set(k, []);
      byThread.get(k).push(m);
    }
    for (const group of byThread.values()) {
      const first = group[0], last = group.at(-1);
      rows.push({
        key: `message:${cell.id}:${first.id}`, cellId: cell.id, hive: cellName(graph, cell), title: titles.get(first.threadId) || 'Topic no longer kept',
        at: first.at, count: group.length, author: messageAuthor(graph, cell, last), preview: oneLine(last.text, 200),
        sessionLinks: group.map(m => m.sessionLink).filter(Boolean), texts: group.map(m => m.text), beadIds: group.map(m => m.context?.beadId || m.beadId).filter(Boolean), threadId: first.threadId,
        link: hiveLink(cell.id, first.threadId, first.id),
      });
    }
    const held = [...byThread.values()].reduce((n, g) => n + g.length, 0);
    const more = waitingCount(cell, hive, ui, kind) - held;
    if (more > 0) rows.push({ key: `more:${cell.id}:${kind}`, cellId: cell.id, hive: cellName(graph, cell), title: `${more} more waiting in this hive`, at: Infinity, count: 0, more, preview: 'Open the hive to see them.', link: hiveLink(cell.id) });
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

export function inboxRows(ctx, cells, kind) {
  if (kind === 'queen') return messageRows(ctx, cells, kind);
  return mergeRows(messageRows(ctx, cells, 'human'), needsRows(ctx, cells));
}

export function remoteRows(ctx, cells, remote, kind) {
  const { graph } = ctx;
  const byId = new Map(cells.map(c => [c.id, c]));
  const rows = [];
  for (const r of remote?.[kind] || []) {
    const cell = byId.get(r.cellId);
    if (!cell) continue;
    rows.push({
      key: r.key, threadId: r.threadId, cellId: cell.id, hive: cellName(graph, cell), title: r.title || 'Topic no longer kept', at: r.at, count: r.count,
      texts: [r.last?.text, r.snippet, r.preview].filter(Boolean), sessionLinks: r.sessionLinks || [r.last?.sessionLink].filter(Boolean),
      author: messageAuthor(graph, cell, r.last), snippet: r.snippet, preview: r.preview, link: hiveLink(cell.id, r.threadId, r.firstId),
    });
  }
  return rows.sort((a, b) => a.at - b.at || (a.key < b.key ? -1 : 1));
}

export function searchedInbox(ctx, cells, query, remoteState) {
  const { remote, pending = false, failed = false } = remoteState || {};
  const requests = needsRows(ctx, cells);
  const local = filterRows(inboxRows(ctx, cells, 'human'), query);
  let human = local;
  if (remote) {
    const messages = remoteRows(ctx, cells, remote, 'human');
    const requestMatches = new Set(local.filter(r => r.needsCount).map(threadKey));
    const remoteKeys = new Set(messages.map(threadKey));
    messages.push(...messageRows(ctx, cells, 'human').filter(r => requestMatches.has(threadKey(r)) && !remoteKeys.has(threadKey(r))));
    const matched = new Set([...messages.map(threadKey), ...requestMatches]);
    human = mergeRows(messages, requests).filter(r => matched.has(threadKey(r))).map(r => ({ ...r, snippet: r.snippet || snippetFor(r.texts || [], query) }));
  }
  const lists = {
    human,
    queen: remote ? remoteRows(ctx, cells, remote, 'queen') : filterRows(messageRows(ctx, cells, 'queen'), query),
  };
  return { lists, pending, failed, truncated: Boolean(remote?.truncated) };
}

export function marked(text, query) {
  return highlightParts(text, query).map(p => p.hit ? h('mark', { class: 'hive-search-hit' }, p.text) : p.text);
}

function needsBadge(count) {
  return h('span', { class: 'hive-inbox-count hive-needs-count', 'aria-label': `${count} needs you`, title: `${count} needs you` }, String(count));
}

function rowSessionLinks(ctx, row) {
  const references = new Map();
  const remember = link => { if (!references.has(link.sessionId)) references.set(link.sessionId, link); };
  for (const link of row.sessionLinks || []) remember(link);
  markdown(ctx.api, (row.texts || []).join('\n'), {
    sessions: ctx.graph?.sessions || [],
    onSessionReference: ({ sessionId, label, bare }) => remember({ sessionId, label: bare ? ctx.graph?.sessions?.find(s => s.sessionId === sessionId)?.name || 'Open session' : label }),
  });
  return references.size ? h('div', { class: 'hive-session-links hive-inbox-session-links' }, [...references.values()].map(link => sessionReference(ctx.graph, link))) : null;
}

export function globalInbox(ctx, cells) {
  const { ui, hive } = ctx;
  const view = ui.globalInboxView() === 'queen' ? 'queen' : 'human';
  const counts = { needs: needsRows(ctx, cells).length, human: 0, queen: 0 };
  const lists = { human: null, queen: null };
  for (const kind of ['human', 'queen']) {
    lists[kind] = inboxRows(ctx, cells, kind);
    counts[kind] = cells.reduce((n, c) => n + waitingCount(c, hive, ui, kind), 0);
  }
  const query = ui.globalInboxQuery?.() || '';
  const searching = searchTerms(query).length > 0;
  const found = searching ? searchedInbox(ctx, cells, query, ui.askGlobalInboxSearch?.(cells.map(c => c.id), `${hive.revision}:${hive.metaVersion}`, hive.metaEpoch)) : null;
  const rows = searching ? found.lists[view] : lists[view];
  const filterCounts = { human: lists.human.length, queen: counts.queen };
  const filters = inboxFilters(view, filterCounts, kind => ui.setGlobalInboxView(kind));
  const label = GLOBAL_FILTERS.find(f => f[0] === view)[1];
  const elsewhere = searching ? GLOBAL_FILTERS.filter(([k]) => k !== view && found.lists[k].length).map(([k, l]) => `${found.lists[k].length} in ${l}`) : [];
  const empty = searching ? `No topics match “${query.trim()}” in ${label}.${elsewhere.length ? ` ${elsewhere.join(', ')}.` : ''}` : view === 'human' ? 'Nothing is waiting for you in any hive.' : 'None of your messages is waiting for an answer.';
  const list = h('ol', { class: 'hive-topics hive-inbox hive-global-inbox-list', 'aria-label': GLOBAL_FILTERS.find(f => f[0] === view)[1] },
    rows.length ? rows.map(r => inboxRow(ctx, r, { query: searching ? query : '' })) : h('li', { class: 'hive-muted' }, empty));
  const box = inboxSearchBox(ui, query, rows, found);
  return h('div', { class: 'hive-dock hive-global-dock' },
    h('section', { class: 'hive-panel hive-conversation hive-global-inbox', tabindex: '-1', 'data-focus-key': 'panel:global-inbox', 'data-scroll-key': 'panel:global-inbox', 'aria-label': 'Inbox across all hives', 'data-pane': 'conversation' },
      h('h3', {}, 'Inbox'), h('div', { class: 'hive-inbox-totals' }, inboxTotals(counts)), box, filters, list));
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
  return h('li', { class: 'hive-topic hive-inbox-item', dataset: { id } },
    h(open ? 'button' : 'a', { ...props, class: 'hive-topic-btn', 'data-focus-key': `global-inbox-item:${r.key}` },
      h('span', { class: 'hive-topic-line' },
        h('strong', { class: 'hive-topic-title' }, query ? marked(r.title, query) : r.title),
        r.count > 1 ? h('span', { class: 'hive-unread', 'aria-label': messageCount(r.count) }, String(r.count)) : null,
        r.needsCount ? needsBadge(r.needsCount) : null,
        h('span', { class: 'hive-muted hive-topic-time' }, relativeTime(r.at))),
      h('span', { class: 'hive-topic-line' },
        showContext ? h('span', { class: 'hive-chip hive-topic-context' }, r.hive) : null,
        h('span', { class: 'hive-muted hive-topic-preview' }, query ? [r.author ? `${r.author}: ` : '', marked(r.snippet || r.preview || '', query)] : [r.author, r.preview].filter(Boolean).join(': ')),
        r.repair ? h('span', { class: 'hive-warning' }, r.repair) : null)),
    rowSessionLinks(ctx, r), action);
}

export function inboxSearchBox(ui, query, rows, found, cellId) {
  const searching = searchTerms(query).length > 0;
  const input = h('input', {
    type: 'search', class: 'hive-inbox-search-input', autocomplete: 'off', spellcheck: 'false', value: query, maxlength: '200',
    placeholder: 'Search topics, messages and bead ids', 'aria-label': 'Search the inbox', 'data-focus-key': 'global-inbox-search',
    oninput: (e) => { if (!e.isComposing) ui.setGlobalInboxQuery(input.value, cellId); },
    onkeydown: (e) => { if (e.key === 'Escape' && input.value) { e.preventDefault(); e.stopPropagation(); ui.setGlobalInboxQuery('', cellId); } },
  });
  const clear = h('button', {
    type: 'button', class: 'hive-inbox-search-clear', 'aria-label': 'Clear search', title: 'Clear search (Esc)', 'data-focus-key': 'global-inbox-search-clear',
    tabindex: searching ? null : '-1', 'aria-hidden': searching ? null : 'true', onclick: () => { ui.setGlobalInboxQuery('', cellId); },
  }, '×');
  const status = !searching ? '' : found.failed ? 'Searching loaded messages only: the full search failed.'
    : `${rows.length} topic${rows.length === 1 ? '' : 's'} match${rows.length === 1 ? 'es' : ''}${found.pending ? ' · searching all messages…' : ''}${found.truncated ? ' · first matches only' : ''}`;
  const box = h('div', { class: 'hive-inbox-search', role: 'search' },
    h('div', { class: 'hive-inbox-search-field' }, input, clear),
    h('span', { class: 'hive-muted hive-inbox-search-status', role: 'status', 'aria-live': 'polite' }, status));
  return box;
}
