import { humanConversationDoc, awaitingHuman, awaitingQueen, threadRecords, threadIn, contextOf } from './conversation.js';
import { refuseSnapshot } from './ops.js';
import { topicMatches, snippetFor, searchTerms, INBOX_SEARCH_MAX } from '../public/inbox-search.js';

const indexes = new WeakMap();

function indexOf(rt, cellId) {
  const store = rt.metadata;
  let held = indexes.get(store);
  if (!held || held.version !== store.version) {
    held = { version: store.version, cells: new Map() };
    indexes.set(store, held);
  }
  if (held.cells.has(cellId)) return held.cells.get(cellId);
  const doc = humanConversationDoc(store.read(), cellId);
  const records = threadRecords(doc, cellId);
  const built = { human: [], queen: [] };
  for (const [kind, waiting] of [['human', awaitingHuman], ['queen', awaitingQueen]]) {
    const groups = new Map();
    for (const m of doc.conversation[cellId] || []) {
      if (!waiting(m)) continue;
      const key = m.threadId || m.id;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(m);
    }
    for (const group of groups.values()) {
      built[kind].push({
        group,
        title: threadIn(records, group[0].threadId)?.title || null,
        texts: group.map((m) => m.text),
        beadIds: group.map((m) => contextOf(m)?.beadId).filter(Boolean),
      });
    }
  }
  held.cells.set(cellId, built);
  return built;
}

export function searchInbox(rt, { cellIds, query }) {
  const text = typeof query === 'string' ? query.slice(0, 200) : '';
  const out = { human: [], queen: [] };
  let truncated = false;
  if (!searchTerms(text).length || rt.metadata.error) return { query: text, ...out, truncated };
  const ids = Array.isArray(cellIds) ? [...new Set(cellIds.slice(0, 500).filter((id) => typeof id === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(id)))] : [];
  for (const cellId of ids) {
    const cell = rt.metadata.cell(cellId);
    if (!cell) continue;
    try { refuseSnapshot(cell); } catch { continue; }
    const built = indexOf(rt, cellId);
    for (const kind of ['human', 'queen']) {
      for (const { group, title, texts, beadIds } of built[kind]) {
        if (!topicMatches({ title, texts, beadIds }, text)) continue;
        if (out[kind].length >= INBOX_SEARCH_MAX) { truncated = true; break; }
        const last = group.at(-1);
        out[kind].push({
          cellId, threadId: group[0].threadId || null, firstId: group[0].id, title, at: group[0].at, count: group.length,
          last: { author: last.author, sessionId: last.sessionId || null, role: last.role || null },
          snippet: snippetFor(texts, text),
          preview: String(last.text || '').replace(/\s+/g, ' ').trim().slice(0, 200),
          key: `message:${cellId}:${group[0].id}`,
        });
      }
    }
  }
  return { query: text, ...out, truncated };
}
