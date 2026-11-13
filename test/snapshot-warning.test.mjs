import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../public/widgets.js', import.meta.url), 'utf8');
const code = source.slice(source.indexOf('export function noticesEl'), source.indexOf('export function attentionEl')).replace('export ', '');
const h = (tag, attrs, ...children) => ({ tag, attrs, children, style: {}, addEventListener() {} });
const noticesEl = vm.runInNewContext(`${code}\nnoticesEl;`, { h });
const textOf = (el) => el == null ? '' : typeof el === 'string' ? el : Array.isArray(el) ? el.map(textOf).join(' ') : textOf(el.children);

test('a snapshot error shows a non-blocking warning and clears after a clean refresh', () => {
  const ctx = { hive: { backend: { snapshotError: 'Export skipped one invalid line.' } } };
  const el = noticesEl(ctx);
  assert.equal(el.attrs.role, 'status');
  assert.match(el.attrs.class, /hive-warning/);
  assert.match(textOf(el), /Showing available work/);
  assert.match(textOf(el), /Export skipped one invalid line/);
  ctx.hive.backend.snapshotError = null;
  assert.equal(noticesEl(ctx), null);
});

test('ordinary notices no longer render in the view', () => {
  assert.equal(noticesEl({ hive: { backend: {} }, notices: [{ id: 1, text: 'Move rejected' }] }), null);
});
