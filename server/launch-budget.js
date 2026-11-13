const WINDOW_MS = 60000;

export function launchRate(doc, cellId, now = Date.now()) {
  const ledger = doc.pickupRates || {};
  const at = Math.max(now, ledger.lastAt || 0);
  const recent = (ledger.starts || []).filter(x => at - x.at < WINDOW_MS);
  const local = recent.filter(x => x.cellId === cellId);
  const reason = local.length >= 1 ? 'Waiting for the hive start-rate guard' : recent.length >= 2 ? 'Waiting for the global start-rate guard' : '';
  return { at, recent, reason };
}

export function reservePickupStart(doc, cellId, launchId, now = Date.now()) {
  const rate = launchRate(doc, cellId, now);
  if (rate.reason) throw Object.assign(new Error(rate.reason), { code: 'busy' });
  doc.pickupRates = { lastAt: rate.at, cursor: cellId, starts: [...rate.recent, { cellId, launchId, at: rate.at }] };
}
