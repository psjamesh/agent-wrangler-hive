import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom, walk, press } from './helpers/dom.mjs';
import { h } from '../public/dom.js';
import { createPromo } from '../public/promo-dialog.js';

function fixture(t) {
  installDom(t);
  const values = new Map(), notices = [], paused = [];
  const storage = { get: k => values.get(k), set: (k, v) => values.set(k, v), remove: k => values.delete(k) };
  const root = h('main'), opener = h('button', {}, 'About Hive');
  document.body.append(root, opener);
  const promo = createPromo({ root: () => root, storage, buildVersion: () => 'active-demo', notice: msg => notices.push(msg), pause: value => paused.push(value) });
  const dialog = () => root.children.find(el => el.tagName === 'dialog');
  const button = label => walk(dialog()).find(el => el.tagName === 'button' && el.textContent === label);
  t.after(() => promo.dispose());
  return { promo, root, opener, values, notices, paused, dialog, button };
}

test('navigation changes only the active page, announces it and puts next/back focus on the heading', t => {
  const f = fixture(t);
  f.promo.open(f.opener);
  assert.equal(f.dialog().getAttribute('aria-label'), 'Introducing Hive');
  assert.equal(document.activeElement.textContent, 'Give your work a home');
  f.button('Explore the map →').click();
  assert.equal(document.activeElement.textContent, 'See the work and what it needs');
  assert.match(f.dialog().textContent, /Map, page 2 of 6/);
  const stop = walk(f.dialog()).find(el => el.getAttribute('data-page') === 'inbox');
  stop.focus(); stop.click();
  assert.equal(document.activeElement, stop);
  assert.equal(stop.getAttribute('aria-current'), 'step');
  assert.equal(walk(f.dialog()).filter(el => el.tagName === 'h2').length, 1);
  assert.equal(f.values.get('promoState'), undefined);
});

test('escape dismisses the pinned edition and restores focus; replay does not erase the record', t => {
  const f = fixture(t);
  f.promo.open(f.opener);
  press(f.dialog(), 'Escape');
  assert.equal(f.dialog(), undefined);
  assert.equal(document.activeElement, f.opener);
  const saved = f.values.get('promoState');
  assert.equal(JSON.parse(saved).dismissedHiveVersion, 'active-demo');
  f.promo.open(f.opener);
  assert.equal(f.values.get('promoState'), saved);
  f.promo.dispose();
  assert.equal(f.values.get('promoState'), saved);
  assert.deepEqual(f.paused, [true, false, true, false]);
});

test('offer reads storage again, defers busy entries, and unmount never dismisses', t => {
  const f = fixture(t);
  assert.equal(f.promo.offer({ blocked: true }), false);
  assert.equal(f.dialog(), undefined);
  assert.equal(f.promo.offer({ blocked: false }), true);
  const same = f.dialog();
  assert.equal(f.promo.offer({ blocked: false }), false);
  assert.equal(f.dialog(), same);
  f.promo.dispose();
  assert.equal(f.values.get('promoState'), undefined);
});

test('enlargement returns to the page without dismissing the intro', t => {
  const f = fixture(t);
  f.promo.open(f.opener);
  f.button('Enlarge example').click();
  assert.equal(f.dialog().getAttribute('aria-label'), 'Welcome example — demo hive');
  press(f.dialog(), 'Escape');
  assert.equal(f.dialog().getAttribute('aria-label'), 'Introducing Hive');
  assert.equal(f.values.get('promoState'), undefined);
});

test('all six pages remain reachable and final close is the only page action that writes', t => {
  const f = fixture(t);
  f.promo.open(f.opener);
  for (const label of ['Explore the map →', 'Meet the agents →', 'Visit the inbox →', 'See what needs you →', 'Follow delivery →']) {
    f.button(label).click();
    assert.equal(f.values.get('promoState'), undefined);
  }
  assert.equal(document.activeElement.textContent, 'Follow the result, with evidence');
  const buttons = walk(f.dialog()).filter(el => el.tagName === 'button' && el.textContent === 'Close intro');
  buttons.at(-1).click();
  assert.equal(JSON.parse(f.values.get('promoState')).dismissedContentVersion, 1);
});

test('a pending automatic offer respects another tab dismissal; manual replay still opens', t => {
  const f = fixture(t);
  f.values.set('promoState', JSON.stringify({ schema: 1, dismissedContentVersion: 1, dismissedHiveVersion: null, dismissedAt: '2026-01-01' }));
  assert.equal(f.promo.offer(), false);
  assert.equal(f.promo.open(f.opener), true);
});

test('a failed dismissal closes normally and reports the browser storage problem', t => {
  const f = fixture(t);
  f.promo.open(f.opener);
  f.values.set = () => { throw Error('full'); };
  f.button('Close intro').click();
  assert.equal(f.dialog(), undefined);
  assert.match(f.notices[0], /could not be saved/);
  assert.equal(f.promo.offer(), false);
});

test('tab wraps in DOM order and does not intercept arrow keys', t => {
  const f = fixture(t);
  f.promo.open(f.opener);
  const dialog = f.dialog();
  const original = dialog.querySelectorAll.bind(dialog);
  dialog.querySelectorAll = selector => selector === '*' ? walk(dialog).slice(1) : original(selector);
  const controls = walk(dialog).filter(el => ['button', 'select'].includes(el.tagName) && !el.disabled && !el.hidden);
  controls.at(-1).focus();
  assert.equal(press(dialog, 'Tab').defaultPrevented, true);
  assert.equal(document.activeElement, controls[0]);
  press(dialog, 'Tab', { shiftKey: true });
  assert.equal(document.activeElement, controls.at(-1));
  assert.equal(press(dialog, 'ArrowLeft').defaultPrevented, false);
});

test('automatic opening restores focus to About Hive when the entry had no focused control', t => {
  const f = fixture(t);
  f.opener.dataset.focusKey = 'about-hive';
  document.querySelectorAll = selector => selector === '[data-focus-key]' ? [f.opener] : [];
  assert.equal(document.activeElement, document.body);
  f.promo.offer();
  f.button('Close intro').click();
  assert.equal(document.activeElement, f.opener);
});

test('an unavailable scene keeps its fallback within that image theme', t => {
  const f = fixture(t);
  f.promo.open(f.opener);
  const img = walk(f.dialog()).find(el => el.tagName === 'img' && el.getAttribute('class') === 'hive-promo-art-light');
  const target = img || walk(f.dialog()).find(el => el.tagName === 'img' && el.parentNode.getAttribute('class') === 'hive-promo-art-light');
  target.dispatchEvent({ type: 'error', target });
  const fallback = walk(f.dialog()).find(el => el.getAttribute('class') === 'hive-promo-image-fallback');
  assert.equal(fallback.parentNode.getAttribute('class'), 'hive-promo-art-light');
});

test('the page is a labelled keyboard-scrollable region while navigation stays outside it', t => {
  const f = fixture(t);
  f.promo.open(f.opener);
  const page = walk(f.dialog()).find(el => el.getAttribute('class') === 'hive-promo-page');
  assert.equal(page.getAttribute('role'), 'region');
  assert.equal(page.getAttribute('tabindex'), '0');
  assert.equal(page.getAttribute('aria-labelledby'), 'hive-promo-page-title');
  assert.equal(walk(page).some(el => el.tagName === 'button'), false);
});

test('caption and close stay outside the scrolling page', t => {
  const f = fixture(t);
  f.promo.open(f.opener);
  const elements = walk(f.dialog());
  const page = elements.find(el => el.getAttribute('class') === 'hive-promo-page');
  const caption = elements.find(el => el.getAttribute('class') === 'hive-promo-caption');
  const close = f.button('Close intro ×');
  assert.equal(caption.parentNode, page.parentNode);
  assert.equal(close.parentNode.getAttribute('class'), 'hive-promo-eyebrow');
  assert.match(caption.textContent, /One hive/);
  for (const img of elements.filter(el => el.tagName === 'img')) assert.equal(img.getAttribute('aria-describedby'), caption.getAttribute('id'));
  f.button('Explore the map →').click();
  assert.match(caption.textContent, /Select a bead/);
});
