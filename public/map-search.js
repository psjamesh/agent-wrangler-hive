import { h } from './dom.js';

import { rankBeads, SEARCH_FIELD_LABELS as labels } from './bead-rank.js';

export { rankBeads };
const searches = new WeakMap();

function stateFor(ui, cellId) {
  let state = searches.get(ui);
  if (!state || state.cellId !== cellId) {
    state = { cellId, scope: '', open: false, reveal: false, current: null };
    searches.set(ui, state);
  }
  return state;
}

export function searchReveals(ui, cellId) {
  return Boolean(ui.searchQuery?.().trim() && searches.get(ui)?.cellId === cellId && searches.get(ui)?.reveal);
}

export function bindMapSearch({ ctx, cell = null, map, ids, hidden = new Set(), heads = [], findMatches = null }) {
  const searchId = cell?.id || 'overview';
  const state = stateFor(ctx.ui, searchId);
  let latest = ctx;
  const input = h('input', {
    class: 'hive-input hive-inbox-search-input', type: 'search', autocomplete: 'off', spellcheck: 'false', maxlength: '200',
    'data-focus-key': 'global-inbox-search', 'aria-label': 'Search Hive', placeholder: 'Search beads, topics and messages',
    value: ctx.ui.searchQuery?.() || '',
    oninput: e => {
      if (e.isComposing) return;
      state.current = null;
      if (!input.value.trim()) { close(); return; }
      latest.ui.setSearchQuery(input.value);
      refresh();
    },
    onkeydown: e => map.el.hiveSearchKey?.(e),
  });
  const count = h('span', { class: 'hive-search-count', role: 'status', 'aria-live': 'polite' });
  const matched = h('span', { class: 'hive-search-field', role: 'status', 'aria-live': 'polite' });
  const scope = h('select', { class: 'hive-input', 'data-focus-key': `map-search-scope:${searchId}`, 'aria-label': 'Search scope', onchange: () => { state.scope = scope.value; state.current = null; refresh(); } });
  const reveal = h('button', { type: 'button', 'data-focus-key': `map-search-reveal:${searchId}`, class: 'hive-quiet-btn', onclick: () => {
    state.reveal = !state.reveal;
    latest.ui.setForm('mapSearchReveal', { cellId: searchId, reveal: state.reveal });
  } });
  const close = () => {
    state.open = false;
    input.value = '';
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
  const bar = h('div', { class: 'hive-map-search', role: 'search', 'aria-label': 'Search Hive', onwheel: e => e.stopPropagation() },
    h('div', { class: 'hive-search-row' }, input, cell ? scope : null,
      h('button', { type: 'button', class: 'hive-quiet-btn hive-search-clear', 'aria-label': 'Clear search', title: 'Clear search and close (Esc)', onclick: close }, 'Clear')),
    count, ' ', cell ? reveal : null, matched,
    h('span', { class: 'hive-muted' }, 'Enter / Shift+Enter or arrows: next / previous · Esc: clear'));
  const open = query => {
    if (!state.view) state.view = map.el.hiveCaptureView?.();
    state.open = true;
    if (query !== undefined) latest.ui.setSearchQuery(query);
    refresh();
    input.focus({ preventScroll: true });
  };
  const trigger = h('button', {
    type: 'button', class: 'hive-zoom-btn hive-search-open', 'data-focus-key': 'map-search-open',
    title: 'Search beads, topics and messages (/ or start typing on the map)',
    onclick: () => state.open ? close() : open(),
  }, 'Search');
  let results = [];
  let timer = null;
  function askServer(query) {
    const key = `${query}\n${latest.hive.revision}`;
    if (state.asked === key) return;
    state.asked = key;
    const ask = () => latest.send({ type: 'hive-bead-search', cellId: searchId, query }, {
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
    const all = findMatches ? findMatches(latest, query) : remote
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
    if (query) state.open = true;
    else if (input.value) state.open = false;
    input.value = latest.ui.searchQuery?.() || '';
    bar.hidden = !state.open;
    trigger.setAttribute('aria-pressed', String(state.open));
    trigger.setAttribute('aria-expanded', String(state.open));
    count.textContent = `${results.length} match${results.length === 1 ? '' : 'es'}${hiddenCount ? ` · ${hiddenCount} ${state.reveal ? 'revealed from' : 'hidden by'} Hide done` : ''}${cell && query && !remote ? (state.remoteFailed === query ? ' · titles only: full-text search failed' : ' · searching full text…') : ''}${remote?.truncated ? ' · first matches only' : ''}`;
    reveal.hidden = !hiddenCount && !state.reveal;
    reveal.textContent = 'Reveal hidden matches';
    reveal.title = state.reveal ? 'Hide done matches again' : 'Temporarily show done work that matches this search';
    reveal.setAttribute('aria-pressed', String(state.reveal));
    const index = results.findIndex(r => r.id === state.current);
    matched.textContent = index < 0 ? '' : `${index + 1} of ${results.length}: ${beads[state.current]?.title || latest.hive.beads[latest.hive.cells[state.current]?.rootBeadId]?.title || state.current} — ${labels[results[index].field] || results[index].field}`;
    if (cell && query && (!state.remote || state.remote.query !== query || state.remote.revision !== latest.hive.revision)) askServer(query);
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
    if (e.key === 'Escape' && state.open) { e.preventDefault(); e.stopPropagation(); close(); return; }
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
  map.el.setAttribute('data-focus-key', `map:${searchId}`);
  map.el.append(bar);
  map.searchControls.append(trigger);
  map.el.hiveRefreshSearch = next => {
    latest = next;
    if (!(next.ui.searchQuery?.() || '').trim() && input.value) state.open = false;
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
