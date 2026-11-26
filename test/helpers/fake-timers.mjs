export const flush = async (n = 5) => {
  for (let i = 0; i < n; i += 1) await new Promise(setImmediate);
};

// Virtual wall clock and timers. advance() is awake time: timers fire on
// schedule. sleep() jumps the clock as a host suspend does, then fires
// every overdue timer late, in due order or reversed to model the race.
export function fakeTimers(start = 1_000_000) {
  let t = start;
  let seq = 0;
  const timers = new Map();
  const api = {
    now: () => t,
    setTimeout(fn, ms) { const id = ++seq; timers.set(id, { fn, at: t + ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    setInterval(fn, ms) { const id = ++seq; timers.set(id, { fn, at: t + ms, every: ms }); return id; },
    clearInterval(id) { timers.delete(id); },
  };
  function fireDue({ reverse = false } = {}) {
    const due = [...timers].filter(([, x]) => x.at <= t).sort((a, b) => a[1].at - b[1].at || a[0] - b[0]);
    if (reverse) due.reverse();
    for (const [id, x] of due) {
      if (!timers.has(id)) continue;
      if (x.every) x.at = t + x.every;
      else timers.delete(id);
      x.fn();
    }
    return due.length;
  }
  async function settle() {
    await flush();
    while (fireDue()) await flush();
  }
  return {
    ...api,
    timers: api,
    async advance(ms, step = 100) {
      const end = t + ms;
      while (t < end) {
        t = Math.min(end, t + step);
        await settle();
      }
    },
    async sleep(ms, opts) {
      t += ms;
      fireDue(opts);
      await settle();
    },
    get pending() { return timers.size; },
  };
}
