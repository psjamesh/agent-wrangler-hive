import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const css = fs.readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
const client = fs.readFileSync(new URL('../public/client.js', import.meta.url), 'utf8');
const panels = fs.readFileSync(new URL('../public/cell-view.js', import.meta.url), 'utf8');

test('all cell sizes share right-hand tabs with only the selected pane visible', () => {
  assert.doesNotMatch(panels, /tab\('map'/);
  assert.match(css, /grid-template-areas: "head head head" "map divider tabs" "map divider rail"/);
  assert.match(css, /\.hive-root\[data-pane="details"\] \.hive-dock > \[data-pane="conversation"\]/);
  assert.doesNotMatch(client, /SIDE_BY_SIDE_MIN_WIDTH|STACKED_MIN_HEIGHT|function sizeClass/);
  assert.doesNotMatch(css, /data-layout="wide"|data-layout="narrow-short"/);
});

test('hidden panels and inspector keep their own grid areas', () => {
  assert.match(css, /data-panels="closed"/);
  assert.match(css, /"head head head" "bar divider tabs" "slot divider rail"/);
});


test('short small windows can scroll overflowing cell and inspector tracks', () => {
  const small = css.match(/\.hive-root\[data-layout="small"\]\[data-view\^="cell"\]\[data-panels="open"\] \{([^}]+)\}/)?.[1] || '';
  assert.match(small, /overflow: auto/);
});
