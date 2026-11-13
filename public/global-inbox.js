import { h, relativeTime } from './dom.js';
import { hiveLink } from './deep-links.js';
import { needsHuman, requestAuthor } from './requests.js';
import { cellName } from './model.js';
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
        author: requestAuthor(graph, r), preview: oneLine(r.body, 200), repair: r.state === 'answered' ? (['failed', 'uncertain'].includes(r.delivery?.state) ? 'Answer needs delivery repair' : 'Answer being delivered') : null,
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

export function globalInbox(ctx, cells) {
  const { ui, hive } = ctx;
  const view = ui.globalInboxView();
  const counts = { needs: needsRows(ctx, cells).length, human: 0, queen: 0 };
  const lists = { needs: null, human: null, queen: null };
  for (const kind of ['human', 'queen']) {
    lists[kind] = messageRows(ctx, cells, kind);
    counts[kind] = cells.reduce((n, c) => n + waitingCount(c, hive, ui, kind), 0);
  }
  const rows = view === 'needs' ? needsRows(ctx, cells) : lists[view];
  const filters = h('div', { class: 'hive-inbox-filters', role: 'group', 'aria-label': 'Inbox filter' },
    GLOBAL_FILTERS.map(([kind, label]) => h('button', {
      type: 'button',
      class: `hive-inbox-filter${view === kind ? ' is-on' : ''}${counts[kind] ? ' has-items' : ''}`,
      'aria-pressed': view === kind ? 'true' : 'false',
      'data-focus-key': `global-inbox:${kind}`,
      onclick: () => ui.setGlobalInboxView(kind),
    }, `${label} `, h('span', { class: 'hive-inbox-count', 'aria-label': `${counts[kind]} waiting` }, String(counts[kind])))));
  const empty = view === 'needs' ? 'Nothing needs you in any hive.' : view === 'human' ? 'Nothing from a queen is waiting for you.' : 'None of your messages is waiting for an answer.';
  const list = h('ol', { class: 'hive-topics hive-inbox hive-global-inbox-list', 'aria-label': GLOBAL_FILTERS.find(f => f[0] === view)[1] },
    rows.length ? rows.map(r => h('li', { class: 'hive-topic hive-inbox-item', dataset: { id: r.key } },
      h('a', { class: 'hive-topic-btn', href: r.link, 'data-focus-key': `global-inbox-item:${r.key}` },
        h('span', { class: 'hive-topic-line' },
          h('strong', { class: 'hive-topic-title' }, r.title),
          r.count > 1 ? h('span', { class: 'hive-unread', 'aria-label': `${r.count} waiting` }, String(r.count)) : null,
          h('span', { class: 'hive-muted hive-topic-time' }, relativeTime(r.at))),
        h('span', { class: 'hive-topic-line' },
          h('span', { class: 'hive-chip hive-topic-context' }, r.hive),
          h('span', { class: 'hive-muted hive-topic-preview' }, [r.author, r.preview].filter(Boolean).join(': ')),
          r.repair ? h('span', { class: 'hive-warning' }, r.repair) : null)))) : h('li', { class: 'hive-muted' }, empty));
  return h('div', { class: 'hive-dock hive-global-dock' },
    h('section', { class: 'hive-panel hive-conversation hive-global-inbox', tabindex: '-1', 'data-focus-key': 'panel:global-inbox', 'data-scroll-key': 'panel:global-inbox', 'aria-label': 'Inbox across all hives', 'data-pane': 'conversation' },
      h('h3', {}, 'Inbox'), filters, list));
}
