import { h } from './dom.js';

export function reactionGlyph(name) {
  const colors = { seen: 'grey', approve: 'green', decline: 'red' };
  const white = { stroke: '#fff', 'stroke-width': '2.2', 'stroke-linecap': 'round', fill: 'none' };
  const symbol = name === 'seen'
    ? [h('svg:path', { d: 'M6.5 12s2-3.3 5.5-3.3 5.5 3.3 5.5 3.3-2 3.3-5.5 3.3S6.5 12 6.5 12z', ...white, 'stroke-width': '1.5' }), h('svg:circle', { cx: 12, cy: 12, r: 1.6, fill: '#fff' })]
    : h('svg:path', { d: name === 'approve' ? 'M7.8 12.3l2.8 2.8 5.6-5.8' : 'M9 9l6 6M15 9l-6 6', ...white, 'stroke-linejoin': 'round' });
  return h('svg:svg', { viewBox: '0 0 24 24', width: 24, height: 24, 'aria-hidden': 'true', focusable: 'false' },
    h('svg:path', { d: 'M12 1.8 21 7v10l-9 5.2L3 17V7z', fill: `var(--hive-reaction-${colors[name]})` }), symbol);
}
