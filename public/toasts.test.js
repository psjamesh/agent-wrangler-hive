import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createToaster, toastSeverity, announceRestoreNotices, restoreNoticeText } from './toasts.js';

const host = (result = true) => { const shown = []; return { shown, api: { ui: { toast: o => { shown.push(o); return result; } } } }; };

test('severity defaults to warning, brief to info, and explicit severities are kept', () => {
  assert.equal(toastSeverity(), 'warning');
  assert.equal(toastSeverity({ brief: true }), 'info');
  for (const s of ['success', 'info', 'warning', 'error']) assert.equal(toastSeverity({ severity: s }), s);
  assert.equal(toastSeverity({ severity: 'loud' }), 'warning');
});

test('a notice becomes a host toast and a repeat within a second is dropped', () => {
  const h = host(); let t = 0;
  const toast = createToaster(() => h.api, () => t);
  assert.equal(toast('Could not send.', { severity: 'error' }), true);
  assert.equal(toast('Could not send.', { severity: 'error' }), true);
  t = 1500;
  toast('Could not send.', { severity: 'error' });
  assert.deepEqual(h.shown.map(o => [o.severity, o.text]), [['error', 'Could not send.'], ['error', 'Could not send.']]);
});

test('a host without toasts, or one that refuses, reports false', () => {
  assert.equal(createToaster(() => ({}))('x'), false);
  assert.equal(createToaster(() => host(false).api)('x'), false);
  assert.equal(createToaster(() => null)('x'), false);
});

test('restore notices toast once as warnings and are dismissed on the server', () => {
  const h = host(), sent = [], seen = new Set();
  const toast = createToaster(() => h.api, () => 0);
  const hive = { cells: { c: { id: 'c', restoreNotices: [{ id: 'n1', headId: 'w', title: 'Work', triggers: ['b1'], placed: 'restored' }] } } };
  announceRestoreNotices(seen, hive, toast, f => sent.push(f));
  announceRestoreNotices(seen, hive, toast, f => sent.push(f));
  assert.equal(h.shown.length, 1);
  assert.equal(h.shown[0].severity, 'warning');
  assert.match(h.shown[0].text, /Hive reopened Work \(w\) because b1 under it is not finished\. It is back in its former shape/);
  assert.deepEqual(sent, [{ type: 'hive-restore-notice-dismiss', cellId: 'c', noticeId: 'n1' }]);
  announceRestoreNotices(seen, { cells: { c: { id: 'c', restoreNotices: [] } } }, toast, () => {});
  assert.equal(seen.size, 0);
});

test('a refused restore toast is retried and not dismissed', () => {
  const sent = [], seen = new Set();
  const hive = { cells: { c: { id: 'c', restoreNotices: [{ id: 'n1', headId: 'w' }] } } };
  announceRestoreNotices(seen, hive, () => false, f => sent.push(f));
  assert.equal(sent.length, 0);
  assert.equal(seen.size, 0);
});

test('restore text for a human reopen omits the Hive cause', () => {
  assert.equal(restoreNoticeText({ by: 'human', headId: 'w', title: 'Work' }), 'Work (w) was reopened.');
});

test('restore notices are not toasted or dismissed while the page is hidden', () => {
  const h = host(), sent = [], seen = new Set();
  const toast = createToaster(() => h.api, () => 0);
  const hive = { cells: { c: { id: 'c', restoreNotices: [{ id: 'n1', headId: 'w' }] } } };
  announceRestoreNotices(seen, hive, toast, f => sent.push(f), false);
  assert.equal(h.shown.length + sent.length + seen.size, 0);
  announceRestoreNotices(seen, hive, toast, f => sent.push(f), true);
  assert.equal(h.shown.length, 1);
});

test('several restore notices in one pass share one toast with the full list in detail', () => {
  const h = host(), sent = [], seen = new Set();
  const toast = createToaster(() => h.api, () => 0);
  const hive = { cells: { c: { id: 'c', restoreNotices: ['a', 'b', 'c', 'd'].map(x => ({ id: `n${x}`, headId: x, title: x.toUpperCase(), triggers: ['t'] })) } } };
  announceRestoreNotices(seen, hive, toast, f => sent.push(f));
  assert.equal(h.shown.length, 1);
  assert.equal(h.shown[0].text, 'Hive reopened 4 workstreams: a, b, c, d.');
  for (const x of ['A (a)', 'B (b)', 'C (c)', 'D (d)']) assert.match(h.shown[0].detail, new RegExp(x.replace(/[()]/g, '\\$&')));
  assert.equal(sent.length, 4);
});

test('extension has no native browser notification or input dialogs', () => {
  for (const file of fs.readdirSync(new URL('../public/', import.meta.url)).filter(x => x.endsWith('.js') && !x.includes('.test.'))) {
    assert.doesNotMatch(fs.readFileSync(new URL(`../public/${file}`, import.meta.url), 'utf8'), /(?:globalThis|window)\.(?:confirm|alert|prompt)\b|\bonbeforeunload\b|['"]beforeunload['"]/, file);
  }
});
