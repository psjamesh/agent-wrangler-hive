import { h } from './dom.js';

export function progressBar(used, total) {
  const fill = h('span', {});
  fill.style.width = `${total ? Math.max(0, Math.min(100, Math.round(used / total * 100))) : 0}%`;
  return h('span', { class: 'hive-progress-inline', 'aria-hidden': 'true' }, fill);
}
