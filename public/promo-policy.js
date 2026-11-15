export function readPromoRecord(raw) {
  let value;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!value || typeof value !== 'object') return null;
  if (Number.isInteger(value.schema) && value.schema > 1) return { future: true };
  if (value.schema !== 1 || !Number.isInteger(value.dismissedContentVersion) || value.dismissedContentVersion < 1
    || !(value.dismissedHiveVersion === null || typeof value.dismissedHiveVersion === 'string')
    || typeof value.dismissedAt !== 'string' || !Number.isFinite(Date.parse(value.dismissedAt))) return null;
  return value;
}

export function promoOffer(raw, manifest) {
  const record = readPromoRecord(raw);
  const previous = record?.dismissedContentVersion || 0;
  const changes = record && !record.future ? manifest.pages.flatMap(page => manifest.changes.filter(change => change.pageId === page.id && change.contentVersion > previous && change.contentVersion <= manifest.contentVersion)) : [];
  return {
    show: !record?.future && previous < manifest.contentVersion,
    page: changes.length ? manifest.pages.findIndex(page => page.id === changes[0].pageId) : 0,
    changes,
    digest: previous && previous < manifest.contentVersion ? (changes.length ? `New since your last intro: ${changes.map(c => c.headline).join(' · ')}` : 'The Hive introduction has been updated.') : '',
  };
}

export function createPromoStorage(storage) {
  let available = false, failed = false;
  try {
    if (typeof storage?.get === 'function' && typeof storage?.set === 'function' && typeof storage?.remove === 'function') {
      const probe = `intro-${Math.random()}`;
      storage.set('promoProbe', probe);
      available = storage.get('promoProbe') === probe;
      storage.remove('promoProbe');
    }
  } catch { available = false; }
  return {
    get available() { return available; },
    offer(manifest) {
      if (!available || failed) return { show: false, page: 0, changes: [], digest: '' };
      try { return promoOffer(storage.get('promoState'), manifest); }
      catch { available = false; return { show: false, page: 0, changes: [], digest: '' }; }
    },
    dismiss(contentVersion, hiveVersion) {
      if (!available) return false;
      try {
        const current = readPromoRecord(storage.get('promoState'));
        if (current?.future || current?.dismissedContentVersion > contentVersion) return true;
        const raw = JSON.stringify({ schema: 1, dismissedContentVersion: contentVersion, dismissedHiveVersion: hiveVersion || null, dismissedAt: new Date().toISOString() });
        storage.set('promoState', raw);
        if (storage.get('promoState') !== raw) throw new Error('Dismissal not saved');
        return true;
      } catch { failed = true; return false; }
    },
  };
}

export function regularHexagon(width) {
  const height = width * Math.sqrt(3) / 2;
  return { width, height, points: [[width / 4, 0], [width * 3 / 4, 0], [width, height / 2], [width * 3 / 4, height], [width / 4, height], [0, height / 2]] };
}
