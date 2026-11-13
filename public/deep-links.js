export const HIVE_VIEW = '#view=ext:hive:overview';

export function hiveLink(cellId, threadId, messageId, { beadId, pane } = {}) {
  const params = new URLSearchParams();
  if (cellId) params.set('cell', cellId);
  if (threadId) params.set('topic', threadId);
  if (messageId) params.set('message', messageId);
  if (beadId) params.set('bead', beadId);
  if (pane === 'details') params.set('pane', pane);
  return HIVE_VIEW + (params.size ? `&${params}` : '');
}

export function parseHiveLink(hash) {
  if (typeof hash !== 'string' || !hash.startsWith(`${HIVE_VIEW}&`)) return null;
  const p = new URLSearchParams(hash.slice(HIVE_VIEW.length + 1));
  const id = (name) => {
    const value = p.get(name);
    return value && /^[a-zA-Z0-9_-]{1,80}$/.test(value) ? value : null;
  };
  return { cellId: id('cell'), threadId: id('topic'), messageId: id('message'), ...(id('bead') ? { beadId: id('bead') } : {}), ...(p.get('pane') === 'details' ? { pane: 'details' } : {}) };
}

const bridges = new WeakMap();

export function installHiveLinks(win, onTarget, onNavigate = () => {}) {
  let pending = null, repair = null, selection = null;
  let replacing = false;
  let generation = 0, untrackedBlocked = false, unblockTimer = null;
  const navigations = [];
  const remember = () => {
    const hash = win.location.hash;
    const internal = replacing && repair && hash === HIVE_VIEW;
    if (!internal) invalidate();
    navigations.push({ hash, generation, handled: !internal && !parseHiveLink(hash) });
  };
  const clearRepair = () => {
    clearTimeout(repair?.timer);
    repair = null;
  };
  const write = hash => {
    win.history.replaceState(null, '', hash);
  };
  const finish = () => {
    if (pending && !pending.dispatched) {
      pending.dispatched = true;
      onTarget(pending.target);
    } else if (!pending && selection) write(selection);
  };
  const showView = () => {
    if (repair) return;
    if (win.location.hash === HIVE_VIEW) { finish(); return; }
    const attempt = { oldHash: win.location.hash, generation };
    repair = attempt;
    replacing = true;
    try { win.location.replace(HIVE_VIEW); } finally { replacing = false; }
    attempt.timer = setTimeout(() => {
      if (repair !== attempt || attempt.generation !== generation) return;
      const selected = selection;
      const atOverview = win.location.hash === HIVE_VIEW;
      cancel();
      if (selected && atOverview) { selection = selected; write(selected); }
    }, 100);
    attempt.timer.unref?.();
  };
  const invalidate = (fence = true) => {
    generation++;
    clearRepair();
    clearTimeout(unblockTimer);
    untrackedBlocked = fence;
    const cancelledGeneration = generation;
    unblockTimer = setTimeout(() => {
      if (generation === cancelledGeneration) untrackedBlocked = false;
    }, 0);
    unblockTimer.unref?.();
    pending = null;
    selection = null;
    onNavigate();
  };
  const cancel = (fence = true) => {
    invalidate(fence);
    if (parseHiveLink(win.location.hash)) write(HIVE_VIEW);
  };
  const start = hash => {
    if (pending?.hash !== hash) pending = { hash, target: parseHiveLink(hash), dispatched: false };
    selection = null;
    showView();
  };
  const capture = event => {
    if (!event) {
      const hash = win.location.hash, target = parseHiveLink(hash);
      if (!target) { cancel(false); return; }
      pending = { hash, target, dispatched: false };
      write(HIVE_VIEW);
      finish();
      return;
    }
    let hash = win.location.hash, oldHash = null;
    if (typeof event.newURL === 'string') {
      try {
        hash = new URL(event.newURL).hash;
        oldHash = event.oldURL ? new URL(event.oldURL).hash : null;
      } catch { return; }
    }
    const at = navigations.findIndex(navigation => navigation.hash === hash);
    const navigation = at >= 0 ? navigations.splice(0, at + 1).at(-1) : null;
    if (navigation && navigation.generation !== generation) {
      const latest = navigations.findLast(next => next.generation === generation && parseHiveLink(next.hash));
      if (selection) showView();
      else if (latest && (!win.location.hash || win.location.hash === HIVE_VIEW || parseHiveLink(win.location.hash))) start(latest.hash);
      return;
    }
    if (navigation?.handled) {
      if (selection) showView();
      return;
    }
    if (repair && repair.generation === generation && hash === HIVE_VIEW && oldHash === repair.oldHash) {
      clearRepair();
      if (win.location.hash === HIVE_VIEW) finish();
      else cancel();
      return;
    }
    const current = win.location.hash;
    if (!navigation && untrackedBlocked) {
      if (selection) showView();
      return;
    }
    if (current && current !== HIVE_VIEW && !parseHiveLink(current)) { cancel(); return; }
    if (parseHiveLink(hash)) {
      start(parseHiveLink(current) && !selection ? current : hash);
    } else if (hash === current) cancel();
    else if (selection) showView();
    else if (parseHiveLink(current)) start(current);
  };
  const bridge = {
    cancel,
    select(hash) { selection = hash; if (!repair) write(hash); },
    isCurrent: () => Boolean(pending?.dispatched && win.location.hash === HIVE_VIEW),
    restore(hash = pending?.hash) {
      if (pending && win.location.hash === HIVE_VIEW) write(hash);
      pending = null;
    },
    dispose() {
      clearRepair();
      clearTimeout(unblockTimer);
      navigations.length = 0;
      win.removeEventListener('hashchange', capture, true);
      win.removeEventListener('popstate', remember, true);
      if (bridges.get(win) === bridge) bridges.delete(win);
    },
  };
  bridges.set(win, bridge);
  win.addEventListener('popstate', remember, true);
  win.addEventListener('hashchange', capture, true);
  capture();
  return bridge;
}

export function revealMessage(root, messageId) {
  if (!root || root.clientWidth <= 0) return false;
  const item = [...root.querySelectorAll('.hive-message')].find(el => el.dataset.id === messageId);
  if (!item || item.getBoundingClientRect().width <= 0) return false;
  item.scrollIntoView({ block: 'center', behavior: 'instant' });
  return true;
}

export function syncHiveSelection(win, { cellId, threadId, beadId, pane }) {
  if (!win || (win.location.hash !== HIVE_VIEW && !parseHiveLink(win.location.hash))) return;
  const hash = hiveLink(cellId, cellId ? threadId : null, null, cellId ? { beadId, pane } : {});
  const bridge = bridges.get(win);
  if (bridge) bridge.select(hash);
  else if (win.location.hash !== hash) win.history.replaceState(null, '', hash);
}
