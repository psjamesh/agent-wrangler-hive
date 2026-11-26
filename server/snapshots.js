const EMPTY = Object.freeze({ beads: Object.freeze({}), edges: Object.freeze([]) });
const RETRY_AFTER_ERROR_MS = 30000;

function deepFreeze(obj) {
  if (obj === null || typeof obj !== 'object' || Object.isFrozen(obj)) return obj;
  Object.freeze(obj);
  for (const v of Object.values(obj)) deepFreeze(v);
  return obj;
}

// One read-only projection of the Beads store, replaced whole after each
// refresh. Readers (the graph contributor, skill and tool gates) never touch bd;
// only refresh() does, and at most one refresh runs at a time.
export function createSnapshotCache({ beads, onChange = () => {}, log = () => {}, isCurrent = () => true }) {
  let current = { revision: 0, loadedAt: null, error: null, graph: EMPTY };
  let running = null;
  let passes = 0;
  const waiters = [];
  let lastErrorAt = 0;
  let loadedGeneration = null;

  async function doRefresh() {
    if (!isCurrent()) return current;
    const status = beads.status.state === 'ready' ? beads.status : await beads.probe();
    if (!isCurrent()) return current;
    if (status.state !== 'ready') {
      current = { ...current, revision: current.revision + 1, error: null, graph: current.graph };
      onChange(current);
      return current;
    }
    const generation = beads.hierarchy?.generation ?? null;
    try {
      const { snapshotError = null, ...loaded } = await beads.loadSnapshot();
      if (!isCurrent()) return current;
      const graph = deepFreeze(loaded);
      current = { revision: current.revision + 1, loadedAt: Date.now(), error: snapshotError, graph };
      if (snapshotError) lastErrorAt = Date.now();
      loadedGeneration = generation;
    } catch (err) {
      if (!isCurrent()) return current;
      lastErrorAt = Date.now();
      log(`hive: snapshot refresh failed: ${err.message}${err.diagnostics ? ` ${JSON.stringify(err.diagnostics)}` : ''}`);
      current = { ...current, revision: current.revision + 1, error: err.message, errorDetail: err.diagnostics || null };
    }
    onChange(current);
    return current;
  }

  function settleWaiters(upTo, result, error = null) {
    const due = waiters.filter((w) => w.target <= upTo);
    waiters.splice(0, waiters.length, ...waiters.filter((w) => w.target > upTo));
    for (const w of due) {
      if (error) w.reject(error);
      else w.resolve(result);
    }
  }

  async function drain() {
    try {
      while (isCurrent() && waiters.some((w) => w.target > passes)) {
        const pass = ++passes;
        try {
          settleWaiters(pass, await doRefresh());
        } catch (err) {
          settleWaiters(pass, null, err);
        }
      }
    } finally {
      running = null;
      settleWaiters(Infinity, current);
    }
  }

  // Each caller waits for the first pass that starts after its call, never
  // for passes requested later, so continuous refreshes cannot hold it.
  function refresh() {
    if (!isCurrent()) return Promise.resolve(current);
    const waiting = new Promise((resolve, reject) => waiters.push({ target: passes + 1, resolve, reject }));
    if (!running) running = drain();
    return waiting;
  }

  const invalidate = () => {
    refresh().catch((err) => log(`hive: refresh failed: ${err.message}`));
  };
  beads.onHierarchySettled?.(invalidate);

  return {
    get current() { return current; },
    get graph() { return current.graph; },
    // True only when the graph comes from a successful read that started
    // after every hierarchy write had ended and none is running now. Until
    // then the cached hierarchy may be behind the store.
    get hierarchyCurrent() {
      const h = beads.hierarchy;
      return Boolean(h && !h.writing && current.loadedAt && !current.error
        && beads.status.state === 'ready' && loadedGeneration === h.generation);
    },
    refresh,
    invalidate,
    maybeRefresh() {
      if (running) return;
      if (current.error && Date.now() - lastErrorAt < RETRY_AFTER_ERROR_MS) return;
      this.invalidate();
    },
  };
}
