import { h, relativeTime } from './dom.js';
import { hiveLink } from './deep-links.js';
import { needsHuman, requestAuthor } from './requests.js';
import { cellName } from './model.js';
import { filterRows, highlightParts, searchTerms } from './inbox-search.js';
import { waitingMessages, waitingCount, topicTitles, messageAuthor } from './conversation.js';

export const GLOBAL_FILTERS = [['needs', 'Needs you'], ['human', 'Inbox'], ['queen', 'Waiting for queen']];

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
        texts: group.map(m => m.text), beadIds: group.map(m => m.context?.beadId || m.beadId).filter(Boolean), threadId: first.threadId,
        link: hiveLink(cell.id, first.threadId, first.id),
      });
    }
    const held = [...byThread.values()].reduce((n, g) => n + g.length, 0);
    const more = waitingCount(cell, hive, ui, kind) - held;
    if (more > 0) rows.push({ key: `more:${cell.id}:${kind}`, cellId: cell.id, hive: cellName(graph, cell), title: `${more} more waiting in this hive`, at: Infinity, count: 0, more, preview: 'Open the hive to see them.', link: hiveLink(cell.id) });
  }
  return rows.sort((a, b) => a.at - b.at || (a.key < b.key ? -1 : 1));
}

export function inboxRows(ctx, cells, kind) {
  return kind === 'needs' ? needsRows(ctx, cells) : messageRows(ctx, cells, kind);
}

export function remoteRows(ctx, cells, remote, kind) {
  const { graph } = ctx;
  const byId = new Map(cells.map(c => [c.id, c]));
  const rows = [];
  for (const r of remote?.[kind] || []) {
    const cell = byId.get(r.cellId);
    if (!cell) continue;
    rows.push({
      key: r.key, cellId: cell.id, hive: cellName(graph, cell), title: r.title || 'Topic no longer kept', at: r.at, count: r.count,
      author: messageAuthor(graph, cell, r.last), snippet: r.snippet, preview: r.preview, link: hiveLink(cell.id, r.threadId, r.firstId),
    });
  }
  return rows.sort((a, b) => a.at - b.at || (a.key < b.key ? -1 : 1));
}

export function searchedInbox(ctx, cells, query, remoteState) {
  const { remote, pending = false, failed = false } = remoteState || {};
  const lists = {
    needs: filterRows(needsRows(ctx, cells), query),
    human: remote ? remoteRows(ctx, cells, remote, 'human') : filterRows(messageRows(ctx, cells, 'human'), query),
    queen: remote ? remoteRows(ctx, cells, remote, 'queen') : filterRows(messageRows(ctx, cells, 'queen'), query),
  };
  return { lists, pending, failed, truncated: Boolean(remote?.truncated) };
}

export function marked(text, query) {
  return highlightParts(text, query).map(p => p.hit ? h('mark', { class: 'hive-search-hit' }, p.text) : p.text);
}

export function globalInbox(ctx, cells) {
  const { ui, hive } = ctx;
  const view = ui.globalInboxView();
  const counts = { needs: needsRows(ctx, cells).length, human: 0, queen: 0 };
  const lists = { needs: null, human: null, queen: null };
  for (const kind of ['human', 'queen']) {
    lists[kind] = messageRows(ctx, cells, kind);
    counts[kind] = cells.reduce((n, c) => n + waitingCount(c, hive, ui, kind), 0);
  }
  const query = ui.globalInboxQuery?.() || '';
  const searching = searchTerms(query).length > 0;
  const found = searching ? searchedInbox(ctx, cells, query, view === 'needs' ? null : ui.askGlobalInboxSearch?.(cells.map(c => c.id), `${hive.revision}:${hive.metaVersion}`, hive.metaEpoch)) : null;
  const rows = searching ? found.lists[view] : view === 'needs' ? needsRows(ctx, cells) : lists[view];
  const filters = h('div', { class: 'hive-inbox-filters', role: 'group', 'aria-label': 'Inbox filter' },
    GLOBAL_FILTERS.map(([kind, label]) => h('button', {
      type: 'button',
      class: `hive-inbox-filter${view === kind ? ' is-on' : ''}${counts[kind] ? ' has-items' : ''}`,
      'aria-pressed': view === kind ? 'true' : 'false',
      'data-focus-key': `global-inbox:${kind}`,
      onclick: () => ui.setGlobalInboxView(kind),
    }, `${label} `, h('span', { class: 'hive-inbox-count', 'aria-label': `${counts[kind]} waiting` }, String(counts[kind])))));
  const label = GLOBAL_FILTERS.find(f => f[0] === view)[1];
  const elsewhere = searching ? GLOBAL_FILTERS.filter(([k]) => k !== view && found.lists[k].length).map(([k, l]) => `${found.lists[k].length} in ${l}`) : [];
  const empty = searching ? `No topics match “${query.trim()}” in ${label}.${elsewhere.length ? ` ${elsewhere.join(', ')}.` : ''}` : view === 'needs' ? 'Nothing needs you in any hive.' : view === 'human' ? 'Nothing from a queen is waiting for you.' : 'None of your messages is waiting for an answer.';
  const list = h('ol', { class: 'hive-topics hive-inbox hive-global-inbox-list', 'aria-label': GLOBAL_FILTERS.find(f => f[0] === view)[1] },
    rows.length ? rows.map(r => h('li', { class: 'hive-topic hive-inbox-item', dataset: { id: r.key } },
      h('a', { class: 'hive-topic-btn', href: r.link, 'data-focus-key': `global-inbox-item:${r.key}` },
        h('span', { class: 'hive-topic-line' },
          h('strong', { class: 'hive-topic-title' }, searching ? marked(r.title, query) : r.title),
          r.count > 1 ? h('span', { class: 'hive-unread', 'aria-label': `${r.count} waiting` }, String(r.count)) : null,
          h('span', { class: 'hive-muted hive-topic-time' }, relativeTime(r.at))),
        h('span', { class: 'hive-topic-line' },
          h('span', { class: 'hive-chip hive-topic-context' }, r.hive),
          h('span', { class: 'hive-muted hive-topic-preview' }, searching ? [r.author ? `${r.author}: ` : '', marked(r.snippet || r.preview || '', query)] : [r.author, r.preview].filter(Boolean).join(': ')),
          r.repair ? h('span', { class: 'hive-warning' }, r.repair) : null)))) : h('li', { class: 'hive-muted' }, empty));
  const input = h('input', {
    type: 'search', class: 'hive-inbox-search-input', autocomplete: 'off', spellcheck: 'false', value: query, maxlength: '200',
    placeholder: 'Search topics, messages and bead ids', 'aria-label': 'Search the inbox', 'data-focus-key': 'global-inbox-search',
    oninput: (e) => { if (!e.isComposing) ui.setGlobalInboxQuery(input.value); },
    onkeydown: (e) => { if (e.key === 'Escape' && input.value) { e.preventDefault(); e.stopPropagation(); ui.setGlobalInboxQuery(''); } },
  });
  const clear = h('button', {
    type: 'button', class: 'hive-inbox-search-clear', 'aria-label': 'Clear search', title: 'Clear search (Esc)', 'data-focus-key': 'global-inbox-search-clear',
    tabindex: searching ? null : '-1', 'aria-hidden': searching ? null : 'true', onclick: () => { ui.setGlobalInboxQuery(''); },
  }, '×');
  const status = !searching ? '' : found.failed ? 'Searching loaded messages only: the full search failed.'
    : `${rows.length} topic${rows.length === 1 ? '' : 's'} match${rows.length === 1 ? 'es' : ''}${found.pending ? ' · searching all messages…' : ''}${found.truncated ? ' · first matches only' : ''}`;
  const box = h('div', { class: 'hive-inbox-search', role: 'search' },
    h('div', { class: 'hive-inbox-search-field' }, input, clear),
    h('span', { class: 'hive-muted hive-inbox-search-status', role: 'status', 'aria-live': 'polite' }, status));
  return h('div', { class: 'hive-dock hive-global-dock' },
    h('section', { class: 'hive-panel hive-conversation hive-global-inbox', tabindex: '-1', 'data-focus-key': 'panel:global-inbox', 'data-scroll-key': 'panel:global-inbox', 'aria-label': 'Inbox across all hives', 'data-pane': 'conversation' },
      h('h3', {}, 'Inbox'), box, filters, list));
}
