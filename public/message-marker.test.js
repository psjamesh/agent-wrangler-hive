import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)];

test('linked, selected and unread messages share a full-height theme-aware bar', () => {
  for (const state of ['is-link-target', 'is-conversation-selected', 'is-unread']) {
    const selector = `.hive-message.${state}::before`;
    const marker = rules.find(([, selectors]) => selectors.split(',').some(s => s.trim() === selector));
    assert.ok(marker, `${state} has a marker`);
    assert.match(marker[2], /position:\s*absolute/);
    assert.match(marker[2], /top:\s*0\s*;/);
    assert.match(marker[2], /bottom:\s*0\s*;/);
    assert.doesNotMatch(marker[2], /(?:height|transform)\s*:/);
    assert.match(marker[2], /background:\s*#70c7d4/);
    assert.ok(rules.some(([, selectors, declarations]) => selectors.split(',').some(s => s.trim() === `body.light ${selector}`) && /background:\s*#186879/.test(declarations)));
  }
});

test('jump targets have no outline box or separate background tint', () => {
  for (const [, selectors, declarations] of rules) {
    if (selectors.split(',').some(s => s.trim() === '.hive-message.is-link-target')) {
      assert.doesNotMatch(declarations, /(?:outline|box-shadow|background)\s*:/);
    }
  }
});
