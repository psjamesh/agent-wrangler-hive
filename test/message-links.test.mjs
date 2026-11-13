import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const css = fs.readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
const selector = '.hive-root :is(.hive-message, .hive-md) a:not(.hive-link-btn)';
const rule = suffix => css.split(`${selector}${suffix} {`)[1]?.split('}')[0] || '';

function luminance(rgb) {
  return rgb.map(channel => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
}
const rgb = hex => hex.match(/\w\w/g).map(value => parseInt(value, 16));
const contrast = (a, b) => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05);

test('message and markdown links keep themed visited colour and non-colour interaction cues', () => {
  assert.match(css, /--hive-message-link: color-mix\(in srgb, var\(--fg\) 80%, var\(--accent, var\(--fg\)\)\)/);
  assert.match(rule(''), /color: var\(--hive-message-link\)/);
  assert.match(rule(''), /text-decoration: underline/);
  assert.match(rule(':visited'), /color: var\(--hive-message-link\)/);
  assert.match(rule(':hover'), /text-decoration-thickness: 2px/);
  assert.match(rule(':focus-visible'), /outline: 2px solid currentColor/);
  assert.match(rule(':focus-visible'), /outline-offset: 2px/);
});

test('link mix and foreground focus colour meet AA on host light and dark message surfaces', () => {
  const themes = [
    { fg: 'f0f6fc', accent: '1f6feb', backgrounds: ['0d1117', '151b23', '1c2128'] },
    { fg: '1b1d21', accent: '4f46e5', backgrounds: ['eceef1', 'fcfcfb', 'e9ebee'] },
  ];
  for (const theme of themes) {
    const fg = rgb(theme.fg);
    const link = fg.map((value, index) => value * 0.8 + rgb(theme.accent)[index] * 0.2);
    for (const background of theme.backgrounds) {
      const highlighted = rgb(background).map((value, index) => value * 0.82 + rgb('d5a93b')[index] * 0.18);
      assert.ok(contrast(link, highlighted) >= 4.5, `${theme.fg}/${background} highlighted link contrast`);
      assert.ok(contrast(link, rgb(background)) >= 4.5, `${theme.fg}/${background} link contrast`);
      assert.ok(contrast(fg, rgb(background)) >= 4.5, `${theme.fg}/${background} focus contrast`);
    }
  }
});
