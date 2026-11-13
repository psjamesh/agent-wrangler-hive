const PREFIX = 'hive:view:';
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value);
const coordinate = value => Number.isFinite(value) && Math.abs(value) <= 1e8;

export const conversationEpoch = (epoch, revision) => revision ? `${epoch}:${revision}` : epoch;

export function readSession(key) {
  try { return JSON.parse(globalThis.sessionStorage.getItem(PREFIX + key)); }
  catch { return null; }
}

export function writeSession(key, value) {
  try { globalThis.sessionStorage.setItem(PREFIX + key, JSON.stringify(value)); }
  catch { }
}

export function readScrollState(hash) {
  const saved = readSession('scroll');
  if (!saved || typeof saved.hash !== 'string' || !Array.isArray(saved.scroll) || !Array.isArray(saved.follow)) return null;
  const scroll = saved.scroll.slice(-60).filter(entry => Array.isArray(entry) && entry.length === 2).filter(([key, value]) => typeof key === 'string' && key.length <= 300 && value && coordinate(value.left) && coordinate(value.top)).map(([key, value]) => [key, {
    left: value.left, top: value.top,
    anchor: validId(value.anchor?.id) && coordinate(value.anchor?.offset) ? value.anchor : null,
  }]);
  const follow = saved.follow.slice(-60).filter(entry => Array.isArray(entry) && entry.length === 2).filter(([key, value]) => typeof key === 'string' && key.length <= 300 && typeof value === 'boolean');
  return { restore: saved.hash === hash, scroll: new Map(scroll), follow: new Map(follow) };
}

export function saveScrollState(hash, scroll, follow) {
  writeSession('scroll', { hash, scroll: [...scroll].slice(-60), follow: [...follow].slice(-60) });
}

export function readMapView(key) {
  const view = readSession(`map:${key}`);
  return view && Number.isFinite(view.k) && view.k >= 0.25 && view.k <= 2.5 && coordinate(view.tx) && coordinate(view.ty) && typeof view.auto === 'boolean'
    ? { k: view.k, tx: view.tx, ty: view.ty, auto: view.auto } : null;
}

export function saveMapView(key, view) {
  writeSession(`map:${key}`, { k: view.k, tx: view.tx, ty: view.ty, auto: view.auto });
}
