export const AUTO_FIT_SETTING = 'autoFit';

export function createAutoFit({ storage, view, fit, changed = () => {} }) {
  let enabled = true;
  try { enabled = JSON.parse(storage?.get(AUTO_FIT_SETTING) ?? 'true') !== false; } catch { }
  let timer = null;
  let disposed = false;
  const cancel = () => { clearTimeout(timer); timer = null; };
  const active = () => enabled && view.auto && !disposed;
  const notify = () => changed({ enabled, paused: enabled && !view.auto });
  const schedule = () => {
    cancel();
    if (!active()) return;
    timer = setTimeout(() => { timer = null; if (active()) fit(); }, 200);
  };
  return {
    schedule,
    refresh: notify,
    suspend() { cancel(); view.auto = false; notify(); },
    resume() { cancel(); view.auto = true; notify(); fit(true); },
    toggle() {
      enabled = !enabled || !view.auto;
      if (enabled) view.auto = true;
      try { storage?.set(AUTO_FIT_SETTING, JSON.stringify(enabled)); } catch { }
      notify();
      cancel();
      if (active()) fit(true);
    },
    dispose() { disposed = true; cancel(); },
  };
}

export function sameTransform(a, b) {
  return b && a.k.toFixed(4) === b.k.toFixed(4)
    && a.tx.toFixed(1) === b.tx.toFixed(1) && a.ty.toFixed(1) === b.ty.toFixed(1);
}
