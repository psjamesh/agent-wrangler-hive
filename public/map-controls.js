import { h } from './dom.js';

export function mapControls({ id, zoom, options, actions, paused }) {
  const search = h('div', { class: 'hive-control-group hive-map-search-slot' });
  const menu = h('div', { id, class: 'hive-wsmenu hive-map-menu', role: 'menu', 'aria-label': 'Map controls', onwheel: event => event.stopPropagation() },
    h('div', { class: 'hive-control-group', role: 'group', 'aria-label': 'Zoom' }, zoom),
    h('div', { class: 'hive-control-group', role: 'group', 'aria-label': 'View options' }, options),
    actions.flat(Infinity).some(Boolean) ? h('div', { class: 'hive-control-group', role: 'group', 'aria-label': 'Map actions' }, actions) : null);
  menu.hidden = true;
  for (const item of menu.querySelectorAll('button')) {
    const pressed = item.getAttribute('aria-pressed') ?? item.getAttribute('aria-checked');
    item.setAttribute('role', pressed === null ? 'menuitem' : 'menuitemcheckbox');
    if (pressed !== null) {
      item.setAttribute('aria-checked', pressed);
      item.removeAttribute('aria-pressed');
    }
  }
  const items = () => [...menu.querySelectorAll('button')].filter(item => item.getAttribute('disabled') === null);
  const outside = event => { if (!tools.contains(event.target)) close(); };
  const close = (restoreFocus = false) => {
    if (menu.hidden) return;
    menu.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', outside, true);
    if (restoreFocus) trigger.focus({ preventScroll: true });
  };
  const open = (last = false) => {
    menu.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', outside, true);
    const available = items();
    (last ? available.at(-1) : available[0])?.focus({ preventScroll: true });
  };
  const trigger = h('button', {
    type: 'button', class: 'hive-zoom-btn hive-zoom-icon hive-map-menu-toggle',
    'aria-label': 'Map controls', title: 'Map controls', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-controls': id,
    'data-focus-key': 'map-controls',
    onclick: () => menu.hidden ? open() : close(true),
    onkeydown: event => {
      if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      open(event.key === 'ArrowUp');
    },
  }, '☰');
  menu.addEventListener('keydown', event => {
    const available = items();
    const index = available.indexOf(document.activeElement);
    let next;
    if (event.key === 'ArrowDown') next = (index + 1) % available.length;
    else if (event.key === 'ArrowUp') next = (index - 1 + available.length) % available.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = available.length - 1;
    if (next === undefined) return;
    event.preventDefault(); event.stopPropagation();
    available[next]?.focus({ preventScroll: true });
  });
  menu.addEventListener('click', event => {
    if (event.target.closest('button')) close(true);
  }, true);
  const tools = h('div', { class: 'hive-zoom', role: 'group', 'aria-label': 'Map view' }, paused, h('div', { class: 'hive-map-menu-launcher' }, search, trigger), menu);
  tools.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || menu.hidden) return;
    event.preventDefault(); event.stopPropagation(); close(true);
  });
  tools.addEventListener('focusout', event => {
    if (event.relatedTarget && !tools.contains(event.relatedTarget)) close();
  });
  return { tools, search, dispose: close };
}
