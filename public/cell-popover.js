import { h } from './dom.js';

let active = null;

export function disposeCellPopover() { active?.dialog.close(); }

export function openCellPopover(ctx, cell, anchor, title, content) {
  disposeCellPopover();
  const returnKey = anchor?.dataset?.focusKey;
  const dialog = h('dialog', { class: 'hive-waiting-menu hive-cell-popover', role: 'dialog', 'aria-label': title });
  const close = () => dialog.close();
  const draw = (next, current) => {
    const focused = document.activeElement;
    const focusKey = focused?.dataset?.focusKey;
    const selection = typeof focused?.selectionStart === 'number' ? [focused.selectionStart, focused.selectionEnd, focused.selectionDirection] : null;
    dialog.replaceChildren(
      h('div', { class: 'hive-details-head' }, h('h3', {}, title), h('button', { type: 'button', class: 'hive-quiet-btn', 'data-focus-key': 'cell-popover-close', onclick: close }, 'Close')),
      h('div', { class: 'hive-cell-popover-body' }, content(next, current)));
    if (focusKey) {
      const target = [...dialog.querySelectorAll('[data-focus-key]')].find(el => el.dataset.focusKey === focusKey);
      target?.focus();
      if (selection) target?.setSelectionRange?.(...selection);
    }
  };
  active = { dialog, cellId: cell.id, draw };
  draw(ctx, cell);
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  dialog.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
  });
  dialog.addEventListener('close', () => {
    if (active?.dialog === dialog) active = null;
    dialog.remove();
    const target = anchor?.isConnected ? anchor : [...document.querySelectorAll('[data-focus-key]')].find(el => el.dataset.focusKey === returnKey);
    target?.focus();
  }, { once: true });
  document.body.append(dialog);
  dialog.showModal();
  dialog.querySelector('button')?.focus();
  if (anchor) {
    const box = anchor.getBoundingClientRect();
    dialog.style.margin = '0';
    dialog.style.left = `${Math.max(8, Math.min(box.left, window.innerWidth - dialog.offsetWidth - 8))}px`;
    dialog.style.top = `${Math.max(8, Math.min(box.bottom + 8, window.innerHeight - dialog.offsetHeight - 8))}px`;
  }
}

export function refreshCellPopover(ctx) {
  if (!active) return;
  const cell = ctx.hive.cells[active.cellId];
  if (!cell || ctx.ui.cellId() !== cell.id) { disposeCellPopover(); return; }
  active.draw(ctx, cell);
}
