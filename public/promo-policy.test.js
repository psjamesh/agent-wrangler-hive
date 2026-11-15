import test from 'node:test';
import assert from 'node:assert/strict';
import { promoOffer, createPromoStorage, regularHexagon } from './promo-policy.js';
import { PROMO } from './promo-content.js';

const record = (epoch, more = {}) => JSON.stringify({ schema: 1, dismissedContentVersion: epoch, dismissedHiveVersion: 'demo', dismissedAt: '2026-01-01T00:00:00.000Z', ...more });
const memory = () => { const values = new Map(); return { get: k => values.get(k), set: (k, v) => values.set(k, v), remove: k => values.delete(k) }; };

test('first visit, corrupt data, known and future editions follow the display policy', () => {
  for (const raw of [null, '{', '{}', record(0), record(1, { dismissedAt: 23 })]) assert.equal(promoOffer(raw, PROMO).show, true);
  for (const raw of [record(1), record(9), JSON.stringify({ schema: 2 })]) assert.equal(promoOffer(raw, PROMO).show, false);
});

test('skipped editions collect changes in page order and open the first changed page', () => {
  const manifest = { ...PROMO, contentVersion: 4, changes: [
    { contentVersion: 4, pageId: 'delivery', headline: 'Delivery evidence' },
    { contentVersion: 2, pageId: 'inbox', headline: 'Shared inbox' },
    { contentVersion: 3, pageId: 'inbox', headline: 'Filters' },
    { contentVersion: 5, pageId: 'welcome', headline: 'Future' },
  ] };
  const offer = promoOffer(record(1), manifest);
  assert.equal(offer.page, 3);
  assert.deepEqual(offer.changes.map(c => c.headline), ['Shared inbox', 'Filters', 'Delivery evidence']);
  assert.match(promoOffer(record(1), { ...manifest, changes: [] }).digest, /updated/);
});

test('storage must round-trip a probe before offering; read-only and denied stores are manual only', () => {
  for (const storage of [null, { get() {}, set() {} }, { get() { throw Error(); }, set() {} }]) assert.equal(createPromoStorage(storage).available, false);
  const storage = memory();
  const state = createPromoStorage(storage);
  assert.equal(state.available, true);
  assert.equal(storage.get('promoProbe'), undefined);
  assert.equal(state.dismiss(1, 'active-build'), true);
  assert.equal(JSON.parse(storage.get('promoState')).dismissedHiveVersion, 'active-build');
});

test('dismissal rereads competing tabs, preserves future schema and never lowers an edition', () => {
  const storage = memory(), state = createPromoStorage(storage);
  const newer = record(9);
  storage.set('promoState', newer);
  assert.equal(state.dismiss(1, 'older'), true);
  assert.equal(storage.get('promoState'), newer);
  const future = JSON.stringify({ schema: 2, custom: 'retain' });
  storage.set('promoState', future);
  assert.equal(state.dismiss(1, null), true);
  assert.equal(storage.get('promoState'), future);
  storage.set('promoState', record(1));
  assert.equal(state.offer(PROMO).show, false);
});

test('failed dismissal disables later automatic offers while manual replay can remain available', () => {
  const storage = memory(), state = createPromoStorage(storage);
  storage.set = () => { throw Error('full'); };
  assert.equal(state.dismiss(1, null), false);
  assert.equal(state.offer(PROMO).show, false);
});

test('regular desktop hexagons retain six equal edges at every scale', () => {
  for (const width of [320, 720, 880, 1120, 1999]) {
    const { height, points } = regularHexagon(width);
    assert.ok(Math.abs(height - width * Math.sqrt(3) / 2) < 1e-9);
    for (let i = 0; i < 6; i++) {
      const a = points[i], b = points[(i + 1) % 6];
      assert.ok(Math.abs(Math.hypot(a[0] - b[0], a[1] - b[1]) - width / 2) < 1e-9);
    }
  }
});
