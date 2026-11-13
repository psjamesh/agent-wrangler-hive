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
  let again = false;
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
      log(`hive: snapshot refresh failed: ${err.message}`);
      current = { ...current, revision: current.revision + 1, error: err.message };
    }
    onChange(current);
    return current;
  }

  function refresh() {
    if (!isCurrent()) return Promise.resolve(current);
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      try {
        let out;
        do {
          again = false;
          out = await doRefresh();
        } while (again && isCurrent());
        return out;
      } finally {
        running = null;
      }
    })();
    return running;
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
