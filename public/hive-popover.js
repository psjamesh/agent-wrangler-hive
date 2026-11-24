import { sessionLabel } from './model.js';
import { h } from './dom.js';

let active = null;

export function disposeHivePopover(owner) {
  if (active && active.owner === owner) active.dialog.close();
}

export function refreshHivePopover(owner, items) {
  if (!active || active.owner !== owner) return;
  const item = items.find(item => `hive-info:${item.id}` === active.key);
  if (!item) { disposeHivePopover(owner); return; }
  active.draw(item.info);
  const anchor = [...document.querySelectorAll('[data-focus-key]')].find(el => el.dataset.focusKey === active.key);
  anchor?.setAttribute('aria-expanded', 'true');
  if (anchor) active.place(anchor);
}

export function openHivePopover(details, anchor, owner) {
  active?.dialog.close();
  const key = anchor.dataset.focusKey;
  const dialog = h('dialog', { class: 'hive-waiting-menu hive-cell-popover hive-overview-popover', 'aria-label': `Details for ${details.name}` });
  const close = () => { if (dialog.open) dialog.close(); };
  const title = h('h3');
  const body = h('div', { class: 'hive-cell-popover-body' });
  const draw = ({ name, goal, detail, owed, queen, activity = [], activitySummary, beads, graph }) => {
    dialog.setAttribute('aria-label', `Details for ${name}`);
    title.textContent = name;
    body.replaceChildren(...[
      goal ? h('p', { class: 'hive-overview-goal' }, goal) : null,
      h('p', {}, detail),
      activitySummary ? h('p', {}, activitySummary) : null,
      ...activity.map(item => h('p', {}, `${beads?.[item.beadId]?.title || item.beadId}: ${item.reason}. ${item.participants.map(p => `${p.source}: ${p.sessionId ? sessionLabel(graph, p.sessionId) : 'No session yet'} (${p.state})`).join('; ')}`)),
      owed ? h('p', {}, `Attention: ${owed}`) : null,
      h('p', {}, queen)].filter(Boolean));
  };
  dialog.append(h('div', { class: 'hive-details-head' }, title, h('button', { type: 'button', class: 'hive-quiet-btn hive-details-close', 'aria-label': 'Close details', onclick: close }, '×')), body);
  draw(details);
  function place(target) {
    const box = target.getBoundingClientRect();
    dialog.style.margin = '0';
    const centre = (box.left + box.right) / 2;
    const left = Math.max(8, Math.min(centre - dialog.offsetWidth / 2, window.innerWidth - dialog.offsetWidth - 8));
    const above = box.bottom + 12 + dialog.offsetHeight > window.innerHeight - 8 && box.top > window.innerHeight - box.bottom;
    const top = above ? box.top - dialog.offsetHeight - 12 : box.bottom + 12;
    dialog.style.left = `${left}px`;
    dialog.style.top = `${Math.max(8, Math.min(top, window.innerHeight - dialog.offsetHeight - 8))}px`;
    dialog.style.setProperty('--hive-arrow-x', `${Math.max(16, Math.min(centre - left, dialog.offsetWidth - 16))}px`);
    dialog.setAttribute('data-side', above ? 'above' : 'below');
  }
  active = { owner, dialog, key, draw, place };
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
    if (active?.dialog === dialog) active = null;
    dialog.remove();
    const target = anchor.isConnected ? anchor : [...document.querySelectorAll('[data-focus-key]')].find(el => el.dataset.focusKey === key);
    target?.setAttribute('aria-expanded', 'false');
    target?.focus();
  }, { once: true });
  document.body.append(dialog);
  anchor.setAttribute('aria-expanded', 'true');
  dialog.showModal();
  place(anchor);
  dialog.querySelector('button').focus();
  return close;
}
