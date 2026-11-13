export const INBOX_SEARCH_MAX = 200;
export const INBOX_SNIPPET = 160;

export function searchTerms(query) {
  return [...new Set(String(query || '').toLowerCase().split(/\s+/).filter(Boolean))].slice(0, 8);
}

export function textMatches(text, query) {
  const hay = String(text || '').toLowerCase();
  const terms = searchTerms(query);
  return terms.length > 0 && terms.every((t) => hay.includes(t));
}

export function topicMatches({ title, texts = [], beadIds = [] }, query) {
  const terms = searchTerms(query);
  if (!terms.length) return true;
  const hay = [title, ...texts, ...beadIds].map((x) => String(x || '').toLowerCase()).join('\n');
  return terms.every((t) => hay.includes(t));
}

export function highlightParts(text, query) {
  const value = String(text ?? '');
  const terms = searchTerms(query);
  if (!terms.length || !value) return [{ text: value, hit: false }];
  const lower = value.toLowerCase();
  const spans = [];
  for (const term of terms) {
    for (let at = lower.indexOf(term); at >= 0; at = lower.indexOf(term, at + term.length)) spans.push([at, at + term.length]);
  }
  spans.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const merged = [];
  for (const span of spans) {
    const last = merged.at(-1);
    if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
    else merged.push([...span]);
  }
  const out = [];
  let cursor = 0;
  for (const [from, to] of merged) {
    if (from > cursor) out.push({ text: value.slice(cursor, from), hit: false });
    out.push({ text: value.slice(from, to), hit: true });
    cursor = to;
  }
  if (cursor < value.length) out.push({ text: value.slice(cursor), hit: false });
  return out;
}

const flat = (text) => String(text || '').replace(/\s+/g, ' ').trim();

export function snippetFor(texts, query, size = INBOX_SNIPPET) {
  const terms = searchTerms(query);
  const lines = texts.map(flat).filter(Boolean);
  let pick = null;
  let at = -1;
  for (const line of lines) {
    const lower = line.toLowerCase();
    const found = terms.map((t) => lower.indexOf(t)).filter((i) => i >= 0);
    if (found.length) { pick = line; at = Math.min(...found); break; }
  }
  if (pick === null) return null;
  if (pick.length <= size) return pick;
  const start = Math.max(0, Math.min(at - Math.floor(size / 4), pick.length - size));
  return `${start > 0 ? '…' : ''}${pick.slice(start, start + size)}${start + size < pick.length ? '…' : ''}`;
}

export function filterRows(rows, query) {
  if (!searchTerms(query).length) return rows;
  const out = [];
  for (const row of rows) {
    if (row.more) continue;
    if (!topicMatches({ title: row.title, texts: row.texts || [], beadIds: row.beadIds || [] }, query)) continue;
    out.push({ ...row, snippet: snippetFor(row.texts || [], query) });
  }
  return out;
}
