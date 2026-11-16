import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const css = fs.readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
const rule = selector => css.match(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]+)\\}`))?.[1] || '';

test('per-topic unread counts keep their round filled badge', () => {
  const badge = rule('.hive-unread');
  assert.match(badge, /border-radius:\s*999px/);
  assert.match(badge, /background:\s*var\(--hive-fill\)/);
});

test('needs-you counts have their own red fill and contrasting ink', () => {
  const badge = rule('.hive-needs-count');
  assert.match(badge, /background:\s*#b42332/);
  assert.match(badge, /color:\s*#fff/);
  assert.match(css, /@media\s*\(forced-colors:\s*active\)\s*\{\s*\.hive-needs-count\s*\{[^}]*background:\s*Highlight;[^}]*color:\s*HighlightText/s);
});
