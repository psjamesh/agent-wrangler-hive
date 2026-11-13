import test from 'node:test';
import assert from 'node:assert/strict';
import { installPanelSplit, panelBounds, PANEL_WIDTH_KEY } from '../public/panel-split.js';

function fixture(saved = null, throws = false) {
  const listeners = {};
  const attrs = {};
  const divider = { focus() { this.focused = true; }, dataset: {}, setAttribute(k, v) { attrs[k] = String(v); }, addEventListener(k, f) { listeners[k] = f; }, setPointerCapture() {}, releasePointerCapture() {} };
  const styles = {};
  const root = { clientWidth: 1200, dataset: {}, style: { setProperty(k, v) { styles[k] = v; } }, getBoundingClientRect: () => ({ right: 1200 }) };
  const writes = [];
  const storage = { getItem() { if (throws) throw Error(); return saved; }, setItem(k, v) { if (throws) throw Error(); writes.push([k, v]); } };
  const update = installPanelSplit(root, divider, storage);
  const key = key => listeners.keydown({ key, preventDefault() {} });
  return { root, divider, styles, attrs, writes, listeners, key, update };
}

test('bounds reserve 320px map, 320px panel and grid chrome', () => {
  assert.deepEqual(panelBounds(1024), { min: 320, max: 640 });
});
test('saved width is shared and re-clamped without discarding preference', () => {
  const f = fixture('600');
  assert.equal(f.attrs['aria-valuenow'], '600');
  f.root.clientWidth = 800; f.update();
  assert.equal(f.attrs['aria-valuenow'], '416');
  f.root.clientWidth = 1200; f.update();
  assert.equal(f.attrs['aria-valuenow'], '600');
  assert.equal(f.writes.length, 0);
});
test('keyboard arrows and limits resize and persist the panel', () => {
  const f = fixture('500');
  f.key('ArrowLeft'); assert.equal(f.attrs['aria-valuenow'], '520');
  f.key('ArrowRight'); assert.equal(f.attrs['aria-valuenow'], '500');
  f.key('Home'); assert.equal(f.attrs['aria-valuenow'], '320');
  f.key('End'); assert.equal(f.attrs['aria-valuenow'], '816');
  assert.deepEqual(f.writes.at(-1), [PANEL_WIDTH_KEY, '816']);
});
test('pointer drag clamps and saves width; cancellation ends the drag', () => {
  const f = fixture('500');
  f.listeners.pointerdown({ button: 0, pointerId: 1, clientX: 600, preventDefault() {} });
  f.listeners.pointermove({ pointerId: 1, clientX: 500 });
  assert.equal(f.attrs['aria-valuenow'], '600');
  assert.equal('dragging' in f.divider.dataset, true);
  f.listeners.pointercancel({ pointerId: 1 });
  assert.equal('dragging' in f.divider.dataset, false);
  f.listeners.pointermove({ pointerId: 1, clientX: 0 });
  assert.equal(f.attrs['aria-valuenow'], '600');
  assert.deepEqual(f.writes.at(-1), [PANEL_WIDTH_KEY, '600']);
});
test('unavailable and invalid storage retain usable defaults', () => {
  for (const saved of ['garbage', '-100', 'Infinity', null]) {
    const f = fixture(saved);
    assert.equal(f.attrs['aria-valuenow'], '456');
  }
  const f = fixture(null, true);
  f.key('ArrowLeft');
  assert.equal(f.attrs['aria-valuenow'], '476');
});


test('starting a drag focuses the separator for immediate keyboard resizing', () => {
  const f = fixture('500');
  f.listeners.pointerdown({ button: 0, pointerId: 1, clientX: 600, preventDefault() {} });
  assert.equal(f.divider.focused, true);
  f.listeners.pointerup({ pointerId: 1 });
  f.key('ArrowLeft');
  assert.equal(f.attrs['aria-valuenow'], '520');
});

test('splitter is a 12px gap with no grid gap and a widened hit area', async () => {
  const { readFile } = await import('node:fs/promises');
  const css = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
  const grid = css.match(/\.hive-root\[data-view\^="cell"\] \{[^}]*\}/)[0];
  assert.match(grid, /grid-template-columns: minmax\(0, 1fr\) 12px var\(--hive-panel-width/);
  assert.match(grid, /gap: 10px 0;/);
  const open = '\\.hive-root\\[data-panels="open"\\] ';
  assert.match(css, new RegExp(open + '\\.hive-divider::before \\{[^}]*width: 0;'));
  assert.match(css, new RegExp(open + '\\.hive-divider::after \\{[^}]*inset: 0 -4px;'));
  assert.match(css, new RegExp(open + '\\.hive-divider\\[data-dragging\\]::before \\{ width: 3px;'));
  assert.match(css, new RegExp(open + '\\.hive-divider:focus-visible::before'));
  assert.match(css, new RegExp('@media \\(forced-colors: active\\) \\{[^@]*' + open + '\\.hive-divider::before \\{ background: CanvasText; \\}[^@]*' + open + '\\.hive-divider:hover::before[^{]*\\{ background: Highlight; \\}'));
  assert.equal(/(^|\n)\s*\.hive-divider(:[\w-]+)*::(before|after)/.test(css), false);
  assert.match(css, /\.hive-root\[data-view="overview"\]\[data-panels="open"\] \{[^}]*minmax\(0, 1fr\) 12px var\(--hive-panel-width[^}]*gap: 0;/);
  assert.match(css, /\.hive-root\[data-view="overview"\]\[data-panels="open"\] \.hive-divider \{[^}]*position: relative;/);
});
