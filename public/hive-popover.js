import { h } from './dom.js';

export function openHivePopover({ name, goal, detail, owed, queen }, anchor) {
  const dialog = h('dialog', { class: 'hive-waiting-menu hive-cell-popover hive-overview-popover', 'aria-label': `Details for ${name}` });
  const close = () => { if (dialog.open) dialog.close(); };
  dialog.append(
    h('div', { class: 'hive-details-head' }, h('h3', {}, name), h('button', { type: 'button', class: 'hive-quiet-btn', onclick: close }, 'Close')),
    h('div', { class: 'hive-cell-popover-body' },
      goal ? h('p', { class: 'hive-overview-goal' }, goal) : null,
      h('p', {}, detail),
      owed ? h('p', {}, `Attention: ${owed}`) : null,
      h('p', {}, queen)));
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  dialog.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
  });
  const outside = event => {
    const rect = dialog.getBoundingClientRect();
    return event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom);
  };
  let pressedOutside = false;
  dialog.addEventListener('pointerdown', event => { pressedOutside = outside(event); });
  dialog.addEventListener('click', event => { if (pressedOutside && outside(event)) close(); });
  dialog.addEventListener('close', () => {
    dialog.remove();
    const target = anchor.isConnected ? anchor : [...document.querySelectorAll('[data-focus-key]')].find(el => el.dataset.focusKey === anchor.dataset.focusKey);
    target?.setAttribute('aria-expanded', 'false');
    target?.focus();
  }, { once: true });
  document.body.append(dialog);
  anchor.setAttribute('aria-expanded', 'true');
  dialog.showModal();
  const box = anchor.getBoundingClientRect();
  dialog.style.margin = '0';
  dialog.style.left = `${Math.max(8, Math.min(box.left, window.innerWidth - dialog.offsetWidth - 8))}px`;
  dialog.style.top = `${Math.max(8, Math.min(box.bottom + 8, window.innerHeight - dialog.offsetHeight - 8))}px`;
  dialog.querySelector('button').focus();
  return close;
}
