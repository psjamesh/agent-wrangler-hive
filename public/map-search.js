import { h } from './dom.js';

import { rankBeads, SEARCH_FIELD_LABELS as labels } from './bead-rank.js';

export { rankBeads };
const searches = new WeakMap();

function stateFor(ui, cellId) {
  let state = searches.get(ui);
  if (!state || state.cellId !== cellId) {
    state = { cellId, scope: '', reveal: false, current: null };
    searches.set(ui, state);
  }
  return state;
}

export function searchReveals(ui, cellId) {
  return Boolean(ui.searchQuery?.().trim() && searches.get(ui)?.cellId === cellId && searches.get(ui)?.reveal);
}

export function bindMapSearch({ ctx, cell, map, ids, hidden, heads }) {
  const state = stateFor(ctx.ui, cell.id);
  let latest = ctx;
  const count = h('span', { class: 'hive-search-count', role: 'status', 'aria-live': 'polite' });
  const matched = h('span', { class: 'hive-search-field', role: 'status', 'aria-live': 'polite' });
  const scope = h('select', { class: 'hive-input', 'data-focus-key': `map-search-scope:${cell.id}`, 'aria-label': 'Search scope', onchange: () => { state.scope = scope.value; state.current = null; refresh(); } });
  const reveal = h('button', { type: 'button', 'data-focus-key': `map-search-reveal:${cell.id}`, class: 'hive-quiet-btn', onclick: () => {
    state.reveal = !state.reveal;
    latest.ui.setForm('mapSearchReveal', { cellId: cell.id, reveal: state.reveal });
  } });
  const close = () => {
    latest.ui.setSearchQuery(''); state.current = null; state.scope = ''; state.remote = null; state.asked = null; state.remoteFailed = null;
    clearTimeout(timer);
    scope.value = '';
    map.el.hiveRestoreView?.(state.view);
    state.view = null;
    refresh();
    map.el.focus({ preventScroll: true });
    if (state.reveal) {
      state.reveal = false;
      latest.ui.setForm('mapSearchReveal', null);
    }
  };
  const bar = h('div', { class: 'hive-map-search', role: 'group', 'aria-label': 'Bead matches', onwheel: e => e.stopPropagation() },
    h('div', { class: 'hive-search-row' }, scope,
      h('button', { type: 'button', class: 'hive-quiet-btn', onclick: close }, 'Clear')),
    count, ' ', reveal, matched,
    h('span', { class: 'hive-muted' }, 'Enter / Shift+Enter or arrows: next / previous · Esc: clear'));
  const open = query => {
    if (!state.view) state.view = map.el.hiveCaptureView?.();
    if (query !== undefined) latest.ui.setSearchQuery(query);
    refresh();
    const input = document.querySelector('[data-focus-key="global-inbox-search"]');
    if (input) { input.value = latest.ui.searchQuery(); input.focus({ preventScroll: true }); }
  };
  let results = [];
  let timer = null;
  function askServer(query) {
    const key = `${query}\n${latest.hive.revision}`;
    if (state.asked === key) return;
    state.asked = key;
    const ask = () => latest.send({ type: 'hive-bead-search', cellId: cell.id, query }, {
      quiet: true,
      onReply: frame => {
        if (state.asked !== key || latest.ui.searchQuery().trim() !== query) return;
        if (frame.ok) state.remote = { query, revision: latest.hive.revision, results: frame.results || [], truncated: Boolean(frame.truncated) };
        else if (!state.remote || state.remote.query !== query) state.remoteFailed = query;
        refresh();
      },
    });
    clearTimeout(timer);
    const delay = latest.searchDelay ?? 150;
    if (delay > 0) timer = setTimeout(ask, delay);
    else ask();
  }
  function refresh() {
    const beads = latest.hive.beads;
    const inScope = id => {
      if (!state.scope) return true;
      const seen = new Set();
      for (let b = beads[id]; b && !seen.has(b.id); b = beads[b.parentId]) {
        if (b.id === state.scope) return true;
        seen.add(b.id);
      }
      return false;
    };
    const query = (latest.ui.searchQuery?.() || '').trim();
    if (query && !state.view) state.view = map.el.hiveCaptureView?.();
    if (!query) {
      if (state.view) map.el.hiveRestoreView?.(state.view);
      state.view = null; state.reveal = false; state.scope = ''; scope.value = '';
      state.current = null; state.remote = null; state.asked = null; state.remoteFailed = null; clearTimeout(timer); }
    const idSet = new Set(ids);
    const remote = state.remote?.query === query ? state.remote : null;
    const all = remote
      ? remote.results.filter(r => idSet.has(r.id) && beads[r.id] && inScope(r.id))
      : rankBeads(ids.filter(inScope).map(id => beads[id]).filter(Boolean), (latest.ui.searchQuery?.() || ''));
    const hiddenCount = all.filter(r => hidden.has(r.id)).length;
    results = all.filter(r => state.reveal || !hidden.has(r.id));
    if (!results.some(r => r.id === state.current)) state.current = null;
    const matching = new Set(results.map(r => r.id));
    const active = Boolean(query);
    for (const tile of map.el.querySelectorAll('[data-tile-id]')) {
      tile.classList.toggle('is-search-match', active && matching.has(tile.dataset.tileId));
      tile.classList.toggle('is-search-dim', active && !matching.has(tile.dataset.tileId));
      tile.classList.toggle('is-search-current', active && tile.dataset.tileId === state.current);
    }
    bar.hidden = !query;
    count.textContent = `${results.length} match${results.length === 1 ? '' : 'es'}${hiddenCount ? ` · ${hiddenCount} ${state.reveal ? 'revealed from' : 'hidden by'} Hide done` : ''}${query && !remote ? (state.remoteFailed === query ? ' · titles only: full-text search failed' : ' · searching full text…') : ''}${remote?.truncated ? ' · first matches only' : ''}`;
    reveal.hidden = !hiddenCount && !state.reveal;
    reveal.textContent = state.reveal ? 'Hide done again' : 'Reveal hidden matches';
    reveal.setAttribute('aria-pressed', String(state.reveal));
    const index = results.findIndex(r => r.id === state.current);
    matched.textContent = index < 0 ? '' : `${index + 1} of ${results.length}: ${beads[state.current]?.title || state.current} — ${labels[results[index].field] || results[index].field}`;
    if (query && (!state.remote || state.remote.query !== query || state.remote.revision !== latest.hive.revision)) askServer(query);
  }
  map.el.hiveSearchKey = e => {
    if (e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (!['Enter', 'ArrowDown', 'ArrowUp'].includes(e.key)) return;
    e.preventDefault(); e.stopPropagation();
    if (!results.length) return;
    const backwards = e.shiftKey || e.key === 'ArrowUp';
    const index = results.findIndex(r => r.id === state.current);
    state.current = results[(index < 0 ? (backwards ? results.length - 1 : 0) : (index + (backwards ? -1 : 1) + results.length) % results.length)].id;
    map.el.hivePanTo?.(state.current);
    refresh();
  };
  map.el.addEventListener('keydown', e => {
    if (e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.target.closest?.('input, textarea, select, button, [contenteditable], [role="textbox"], [role="menu"]')) return;
    const query = latest.ui.searchQuery?.() || '';
    if (e.key === 'Escape' && query) { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (!query && (['+', '=', '-', '_', '0'].includes(e.key) || (e.key === ' ' && e.target.closest?.('[data-tile-id]')))) return;
    if (e.key.length === 1) {
      e.preventDefault(); e.stopPropagation();
      open(e.key === '/' ? query : query + e.key);
    }
  }, true);
  map.el.addEventListener('pointerdown', e => {
    if (e.target.closest?.('svg') && !e.target.closest('[data-tile-id]')) map.el.focus({ preventScroll: true });
  });
  map.el.setAttribute('tabindex', '0');
  map.el.setAttribute('data-focus-key', `map:${cell.id}`);
  map.el.append(bar);
  map.el.hiveRefreshSearch = next => {
    latest = next;
    const options = heads.map(id => [id, next.hive.beads[id]?.title || id]);
    const signature = JSON.stringify(options);
    if (scope.dataset.options !== signature) {
      scope.replaceChildren(h('option', { value: '' }, 'Whole hive'), ...options.map(([id, title]) => h('option', { value: id }, title)));
      scope.dataset.options = signature;
      if (!heads.includes(state.scope)) state.scope = '';
      scope.value = state.scope;
    }
    refresh();
  };
  map.el.hiveRefreshSearch(ctx);
}
