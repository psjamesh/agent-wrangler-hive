import { h } from './dom.js';
import { hiveLink } from './deep-links.js';
import { cellWaitingItems as collect } from './waiting-model.js';
import { pullRequestRow } from './pr-view.js';

export { needsYouIncomplete } from './waiting-model.js';
const caches = new WeakMap();
let menu = null;
const menuSignature = items => JSON.stringify(items, (key, value) => key === 'stateCheckedAt' ? undefined : value);
export function cellWaitingItems(ctx, cell) {
  if (!caches.has(ctx)) caches.set(ctx, new Map());
  const cache = caches.get(ctx);
  if (!cache.has(cell.id)) cache.set(cell.id, collect(ctx, cell));
  return cache.get(cell.id);
}
export function waitingItems(ctx, bead) {
  return Object.values(ctx.hive.cells).flatMap(cell => cellWaitingItems(ctx, cell)).filter(item => item.beadIds.includes(bead.id));
}

function waitingList(ctx, items, labelled, close = () => {}, selectedBeadId = null) {
  return h('ul', { class: 'hive-waiting-list' }, items.map(item => {
    const bead = ctx.hive.beads[selectedBeadId && item.beadIds.includes(selectedBeadId) ? selectedBeadId : [...item.beadIds].sort()[0]];
    const reply = item.threadId ? h('a', { class: 'hive-link-btn', href: hiveLink(item.cellId, item.threadId, item.messageId), dataset: { waitAction: 'reply' }, onclick: close }, item.kind === 'request' ? 'Open request' : 'Reply') : null;
    return h('li', { dataset: { waitId: item.id } }, labelled ? h('p', { class: 'hive-muted' }, item.beadIds.map(id => ctx.hive.beads[id]?.title || id).join(' · ')) : null,
      item.kind === 'pr' && !selectedBeadId && item.beadIds.length > 1 && item.pr.humanAttention?.state === 'cannot-fix' ? h('p', { class: 'hive-muted' }, `Queen help will be posted under “${bead.title}”.`) : null,
      item.kind === 'pr' ? pullRequestRow(ctx, bead, item.pr) : [
        h('strong', {}, item.title), h('p', {}, item.reason),
        h('div', { class: 'hive-pr-actions' }, reply,
          item.kind === 'needsyou' ? h('a', { class: 'hive-link-btn', href: '#view=ext:needsyou:inbox', dataset: { waitAction: 'needsyou' }, onclick: close }, 'Open Needs You queue') : null,
          item.kind === 'agent' ? h('button', { type: 'button', class: 'hive-btn', dataset: { waitAction: 'session' }, onclick: () => { close(); ctx.ui.inspect(item.sessionId); } }, 'Open session') : null)]);
  }));
}

export function waitingSection(ctx, bead) {
  const items = waitingItems(ctx, bead);
  return items.length ? h('section', { class: 'hive-waiting-section', 'aria-label': 'Waiting for you' },
    h('h4', {}, `Waiting for you (${items.length})`), waitingList(ctx, items, false, undefined, bead.id)) : null;
}

export function disposeWaitingMenu() { menu?.dialog.close(); }

export function openWaitingMenu(ctx, items, anchor = null, scope = {}) {
  if (!items.length) return;
  disposeWaitingMenu();
  const previous = document.activeElement;
  const tileId = anchor?.dataset?.tileId;
  const selectedBeadId = scope.beadId || tileId;
  const dialog = h('dialog', { class: 'hive-waiting-menu', 'aria-label': 'Waiting for you' });
  const close = () => dialog.close();
  const draw = (nextCtx, next) => {
    const feedback = h('p', { role: 'status', 'aria-live': 'polite' });
    const localCtx = { ...nextCtx, notice: (message, opts) => { feedback.textContent = message; nextCtx.notice(message, opts); } };
    const nodes = [h('div', { class: 'hive-details-head' }, h('h3', {}, `Waiting for you (${next.length})`), h('button', { type: 'button', class: 'hive-quiet-btn', onclick: close, 'aria-label': 'Close waiting for you', dataset: { waitAction: 'close' } }, 'Close')),
      waitingList(localCtx, next, true, close, selectedBeadId), feedback];
    if (dialog.replaceChildren) dialog.replaceChildren(...nodes); else dialog.append(...nodes);
  };
  draw(ctx, items);
  menu = { dialog, draw, scope: { cellId: scope.cellId || items[0].cellId, beadId: scope.beadId || tileId }, signature: menuSignature(items) };
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  dialog.addEventListener('close', () => {
    dialog.remove();
    if (menu?.dialog === dialog) menu = null;
    const fallback = tileId ? document.querySelector?.(`[data-tile-id="${CSS.escape(tileId)}"]`) : document.querySelector?.('[data-focus-key="waiting-header"]');
    if (previous?.isConnected) previous.focus(); else fallback?.focus();
  }, { once: true });
  document.body.append(dialog);
  dialog.showModal();
  if (anchor) {
    const box = anchor.getBoundingClientRect();
    dialog.style.margin = '0';
    dialog.style.left = `${Math.max(8, Math.min(box.right + 8, window.innerWidth - dialog.offsetWidth - 8))}px`;
    dialog.style.top = `${Math.max(8, Math.min(box.top, window.innerHeight - dialog.offsetHeight - 8))}px`;
  }
}

export function refreshWaitingMenu(ctx) {
  if (!menu) return;
  const { cellId, beadId } = menu.scope;
  const cell = ctx.hive.cells[cellId];
  if (!cell || (ctx.ui.cellId && ctx.ui.cellId() !== cellId)) { disposeWaitingMenu(); return; }
  const items = cellWaitingItems(ctx, cell).filter(item => !beadId || item.beadIds.includes(beadId));
  if (!items.length) { disposeWaitingMenu(); return; }
  const signature = menuSignature(items);
  if (signature === menu.signature) return;
  const focus = document.activeElement;
  const waitId = focus?.closest('[data-wait-id]')?.dataset.waitId || '';
  const action = focus?.dataset.waitAction;
  menu.draw(ctx, items);
  menu.signature = signature;
  const controls = [...menu.dialog.querySelectorAll('[data-wait-action]')];
  const target = controls.find(el => !el.disabled && el.dataset.waitAction === action && (el.closest('[data-wait-id]')?.dataset.waitId || '') === waitId);
  (target || controls.find(el => el.dataset.waitAction === 'close')).focus();
}
