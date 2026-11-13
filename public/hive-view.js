import { renderRelatedBeads } from './conversation.js';
import { confirmHive } from './confirm-dialog.js';
import { allSettings, settingsButton } from './settings-view.js';
import { capacityControl } from './capacity-control.js';
import { subtreeMembers } from './region-attachments.js';
import { hiddenWork } from './region-visibility.js';
import { bindMapSearch, searchReveals } from './map-search.js';
import { mapInputs } from './view-inputs.js';
import { h, syncChildren } from './dom.js';
import { renderHexMap, fitLines } from './hex-grid.js';
import { toPixel, pixelBounds, key } from './hex-layout.js';
import { layoutCell, groupOutlines, workstreamClasses } from './cell-layout.js';
import { normalAspect } from './hex-layout.js';
import { previewMove, planMove, planGroupArrange, planReveal, membersOf, createDragPlanner, planHide, planHiveReveal } from './cell-move.js';
import { layoutBase, stackable } from './layout-base.js';
import { archiveHidden, activeKids } from './archive-layout.js';
import { openComplete, groupClosed, archiveReply } from './workstream-view.js';
import {
  cellName, cellCounts, agentSummary, capturedAgentSummary, isDone,
} from './model.js';
import { attentionEl, noticesEl } from './widgets.js';
import { hiveTile } from './hive-shape.js';
import { isRetired, overviewPlaces, outcomeMark } from './retired.js';
import { globalInbox } from './global-inbox.js';
import { cellDialog, openCellDialog } from './cell-dialog.js';
import {
  beadTile, relationsFor, describeRelations, legend, cellPanels, launchState,
} from './cell-view.js';

const BEAD_SIZE = 60;
const CELL_SIZE = 92;

function firstLine(text) {
  return String(text || '').split('\n').find((l) => l.trim())?.trim() || '';
}

function cellTile(ctx, cell) {
  const { hive, graph } = ctx;
  const name = cellName(graph, cell);
  const root = cell.rootBeadId ? hive.beads[cell.rootBeadId] : null;
  const counts = cellCounts(hive, cell);
  const goal = firstLine(root?.goal);
  const launch = launchState(hive, cell);
  // The overview marks a cell only for attention or activity: a person while
  // its queen waits for input, a robot while it works, nothing when idle. A
  // captured queen is described in words only, never as current activity.
  let queen;
  let mark = null;
  let warn = false;
  if (cell.snapshot) {
    const q = cell.snapshot.sessions?.[cell.snapshot.queenSessionId];
    const captured = q ? capturedAgentSummary([q], 'Captured queen') : null;
    queen = captured ? `Captured snapshot. ${captured.text}` : 'Captured snapshot';
  } else if (cell.queenSessionId) {
    const live = agentSummary(graph, [cell.queenSessionId], 'Queen');
    queen = live.text;
    if (live.dots.includes('needs')) mark = { kind: 'person', title: `The queen is waiting for input. ${queen}` };
    else if (live.dots.includes('working')) mark = { kind: 'busy', title: `The queen is working. ${queen}` };
  } else {
    queen = launch ? launch.text : 'Setup incomplete: no queen';
    warn = true;
  }
  const work = cell.retired ? `Retired, ${cell.retired.outcome}` : !cell.enabled ? 'Off' : counts.total ? `${counts.closed} of ${counts.total} closed` : 'No work yet';
  const detail = [work, cell.enabled && counts.in_progress ? `${counts.in_progress} in progress` : '', cell.enabled && counts.in_review ? `${counts.in_review} in review` : ''].filter(Boolean).join(', ');
  // What each side still owes the other, so it stays in reach from here.
  const toRead = cell.inbox?.human?.count || 0;
  const toAnswer = cell.inbox?.queen?.count || 0;
  const needs = cell.requestCounts?.human || 0;
  const counters = [
    { kind: 'inbox', count: cell.retired ? 0 : toRead, label: 'Inbox' },
    { kind: 'queen', count: cell.retired ? 0 : toAnswer, label: 'Waiting for queen' },
    { kind: 'needs', count: cell.retired ? 0 : needs, label: 'Needs you' },
    { kind: 'progress', count: cell.occupiedCount || 0, label: 'In progress' },
  ];
  const owed = [needs ? `${needs} need your input` : '', toRead ? `${toRead} from the queen to read` : '', toAnswer ? `${toAnswer} awaiting the queen` : ''].filter(Boolean).join(', ');
  const pos = { q: cell.position?.q ?? 0, r: cell.position?.r ?? 0 };
  const { x, y } = toPixel(pos, CELL_SIZE);
  return {
    id: cell.id,
    x,
    y,
    local: pos,
    titleText: name,
    titleLines: 3,
    titlePx: 13,
    sub: warn ? ['No queen yet'] : (goal ? fitLines(goal, { width: CELL_SIZE * 1.4, maxLines: 2, px: 10.5, weight: 400 }) : (cell.snapshot ? ['Captured snapshot'] : [])),
    counters,
    badge: !cell.enabled || !counts.total ? work : null,
    progress: cell.enabled && counts.total ? { done: counts.closed, total: counts.total } : null,
    lineHeight: 16,
    classes: `hive-cell${cell.retired ? ' is-retired' : (cell.enabled ? '' : ' is-off')}${warn ? ' needs-queen' : ''}${cell.snapshot ? ' is-snapshot' : ''}`,
    mark: cell.retired ? outcomeMark(cell.retired) : (cell.enabled ? mark : null),
    ariaLabel: `${name}. ${goal ? `Goal: ${goal}. ` : ''}${detail}. ${owed ? `Messages: ${owed}. ` : ''}${queen}. Enter opens the hive; Shift and an arrow key moves it.`,
    title: `${name}${goal ? `\n${goal}` : ''}\n${detail}${owed ? `\nMessages: ${owed}` : ''}\n${queen}`,
  };
}

// Cell positions with moves still being saved applied, swapping as the server
// does when a hive is dropped on another.
function placedCells(cells, placements) {
  const at = new Map(cells.filter((c) => !isRetired(c)).map((c) => [c.id, { q: c.position?.q ?? 0, r: c.position?.r ?? 0 }]));
  for (const p of placements) {
    if (p.kind !== 'cell' || !at.has(p.cellId)) continue;
    const from = at.get(p.cellId);
    for (const [id, pos] of at) if (id !== p.cellId && pos.q === p.position.q && pos.r === p.position.r) at.set(id, from);
    at.set(p.cellId, p.position);
  }
  const moved = cells.map((c) => (isRetired(c) ? c : { ...c, position: at.get(c.id) }));
  const places = overviewPlaces(moved);
  return moved.map((c) => ({ ...c, position: places.get(c.id) }));
}

function placedLayout(cellId, saved, placements) {
  const out = { ...saved };
  for (const p of placements) {
    if (p.kind !== 'beads' || p.cellId !== cellId) continue;
    for (const [id, pos] of Object.entries(p.positions)) {
      if (pos === null) delete out[id];
      else out[id] = pos;
    }
  }
  return out;
}

function focusTile(id) {
  document.querySelector(`.hive-canvas [data-tile-id="${CSS.escape(id)}"]`)?.focus();
}

// The actions for one workstream heading, as a menu over the map. Arrow
// keys, Home and End move between items; Enter or Space picks one; Escape,
// Tab or a click outside closes it. Focus then goes back to the heading,
// unless the click was on another control outside the map, which keeps its
// own action and focus.
// The watcher for presses outside the menu has one owner. Every render
// starts by dropping the menu's listeners, and a drawn menu adds them again.
// A press already under way keeps its own listeners and timers while the
// menu is still drawn; a finished render without the menu, or the view
// unmounting, cancels all of it.
//
// A press outside the menu and its map backdrop closes the menu once that
// press's click arrives, before the clicked control's own handler runs, but
// without redrawing: the control keeps its action and focus, and any redraw
// it causes no longer shows the menu. A redraw follows on the next task if
// nothing else drew. A press with no click (a drag, or a cancelled touch)
// closes it shortly after the press ends; a context menu outside closes it
// at once.
const CLICK_WAIT = 600;
const menuWatch = { base: null, press: null, drawn: false };

function dropBase() {
  menuWatch.base?.();
  menuWatch.base = null;
}

function endPress() {
  const press = menuWatch.press;
  menuWatch.press = null;
  press?.stop();
}

export function menuRenderStart() {
  dropBase();
  menuWatch.drawn = false;
}

export function menuRenderEnd() {
  if (!menuWatch.drawn) endPress();
}

export function disposeMenuWatch() {
  dropBase();
  endPress();
  menuWatch.drawn = false;
}

function startPress(close, now) {
  const listeners = [];
  const timers = new Set();
  const on = (type, fn) => { document.addEventListener(type, fn, true); listeners.push([type, fn]); };
  const wait = (fn, ms) => {
    const t = setTimeout(() => { timers.delete(t); fn(); }, ms);
    timers.add(t);
  };
  const stop = () => {
    for (const [type, fn] of listeners.splice(0)) document.removeEventListener(type, fn, true);
    for (const t of timers) clearTimeout(t);
    timers.clear();
  };
  const press = { stop };
  const finish = () => {
    stop();
    close.quiet();
    wait(() => {
      if (menuWatch.press === press) menuWatch.press = null;
      close.redraw();
    }, 0);
  };
  menuWatch.press = press;
  if (now) {
    finish();
    return;
  }
  on('click', finish);
  on('pointercancel', finish);
  on('pointerup', () => wait(finish, CLICK_WAIT));
}

function watchMenu(menu, close) {
  dropBase();
  menuWatch.drawn = true;
  const inside = (evt) => evt.composedPath().some((el) => el === menu || el.classList?.contains('hive-wsmenu-backdrop'));
  const onDown = (evt) => {
    if (inside(evt)) return;
    endPress();
    startPress(close, evt.type === 'contextmenu');
  };
  document.addEventListener('pointerdown', onDown, true);
  document.addEventListener('contextmenu', onDown, true);
  menuWatch.base = () => {
    document.removeEventListener('pointerdown', onDown, true);
    document.removeEventListener('contextmenu', onDown, true);
  };
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// What a reveal will do, for the warning before it is saved.
function revealWarning(plan, allClosed) {
  const verb = 'Fitting this work back';
  const things = (n) => plural(n, allClosed ? 'closed item' : 'item', allClosed ? 'closed items' : 'items');
  if (!plan.shift) return `${verb} will place ${things(plan.crowded)} next to this workstream, because their hexes are now in use.`;
  return `${verb} will move this workstream ${plural(plan.shift, 'hex', 'hexes')} to make room for ${things(plan.crowded)}. Some ${allClosed ? 'closed items' : 'items'} may also be placed in new spots within the workstream.`;
}

function workstreamMenu({ title, at, arranging, fitLabel, confirm, onArrange, onFit, onConfirm, onComplete, onArchive, archiveLabel, onClose, onDismiss }) {
  const extra = (key, label, fn) => (fn ? h('button', {
    type: 'button',
    role: 'menuitem',
    class: 'hive-wsmenu-item',
    tabindex: '-1',
    'data-focus-key': `wsmenu:${key}`,
    onclick: fn,
  }, label) : null);
  const items = confirm ? [
    h('button', {
      type: 'button',
      role: 'menuitem',
      class: 'hive-wsmenu-item',
      tabindex: '-1',
      'aria-disabled': arranging ? 'true' : null,
      'data-focus-key': 'wsmenu:confirm',
      onclick: () => { if (!arranging) onConfirm(); },
    }, arranging ? 'Moving…' : confirm.action),
    h('button', {
      type: 'button',
      role: 'menuitem',
      class: 'hive-wsmenu-item',
      tabindex: '-1',
      'data-focus-key': 'wsmenu:cancel',
      onclick: onClose,
    }, 'Cancel'),
  ] : [
    h('button', {
      type: 'button',
      role: 'menuitem',
      class: 'hive-wsmenu-item',
      tabindex: '-1',
      'aria-disabled': arranging ? 'true' : null,
      'data-focus-key': 'wsmenu:arrange',
      onclick: () => { if (!arranging) onArrange(); },
    }, arranging ? 'Arranging…' : 'Arrange this workstream'),
    fitLabel ? h('button', {
      type: 'button',
      role: 'menuitem',
      class: 'hive-wsmenu-item',
      tabindex: '-1',
      'aria-disabled': arranging ? 'true' : null,
      'data-focus-key': 'wsmenu:fit',
      onclick: () => { if (!arranging) onFit(); },
    }, fitLabel) : null,
    extra('complete', 'Complete workstream…', onComplete),
    extra('archive', archiveLabel, onArchive),
  ].filter(Boolean);
  const move = (evt) => {
    const i = items.indexOf(document.activeElement);
    let next = null;
    if (evt.key === 'ArrowDown') next = (i + 1) % items.length;
    else if (evt.key === 'ArrowUp') next = (i - 1 + items.length) % items.length;
    else if (evt.key === 'Home') next = 0;
    else if (evt.key === 'End') next = items.length - 1;
    if (next !== null) {
      evt.preventDefault();
      items[next].focus();
    } else if (evt.key === 'Escape' || evt.key === 'Tab') {
      evt.preventDefault();
      evt.stopPropagation();
      onClose();
    }
  };
  const close = (evt) => { evt.preventDefault(); evt.stopPropagation(); onClose(); };
  const menu = h('div', {
    class: 'hive-wsmenu',
    role: 'menu',
    'aria-label': `Actions for ${title}`,
    style: { left: `max(8px, min(${Math.round(at.x)}px, calc(100% - 16em)))`, top: `max(8px, min(${Math.round(at.y)}px, calc(100% - ${confirm ? 13 : 8.5}em)))` },
    onkeydown: move,
    oncontextmenu: (e) => e.preventDefault(),
  }, confirm ? h('p', { class: 'hive-wsmenu-warning', role: 'alert' }, confirm.text) : null, items);
  watchMenu(menu, onDismiss);
  return [
    h('div', { class: 'hive-wsmenu-backdrop', 'aria-hidden': 'true', onpointerdown: close, oncontextmenu: close, onwheel: (e) => e.stopPropagation() }),
    menu,
  ];
}

function overviewMap(ctx, shown) {
  const { hive, ui, api } = ctx;
  const cells = placedCells(shown, ui.placements());
  const items = cells.map((c) => cellTile(ctx, c));
  const box = pixelBounds(items.length ? items.map((i) => i.local) : [{ q: 0, r: 0 }], CELL_SIZE);
  let map = null;
  const enter = (id) => ui.openCell(id, map?.el.hiveTileRect(id) || null);
  map = renderHexMap({
    viewKey: 'overview',
    storage: api?.storage,
    size: CELL_SIZE,
    tile: hiveTile(CELL_SIZE),
    className: 'is-hives',
    items,
    occupied: new Set(items.map((i) => key(i.local))),
    bounds: { x: box.x, y: box.y, w: box.width, h: box.height },
    selectedId: ui.highlightedCell(),
    maxFit: 1.3,
    ariaLabel: 'Hives, one per task. Position is only your own arrangement.',
    onClick: enter,
    onActivate: enter,
    onSelect: enter,
    onMove: (id, position) => cells.find((c) => c.id === id)?.retired ? null : ui.sendPlacement({ type: 'hive-cell-move', cellId: id, position }, { kind: 'cell', cellId: id, position }),
    onBackground: () => ui.clearHighlight(),
    onDragState: (on) => ui.setDragging(on),
    claimDrag: api?.claimDrag ? (el) => api.claimDrag(el) : null,
    overlay: [
      cells.length ? h('p', { class: 'hive-stage-hint' }, 'Click a hive to open its work. Drag hives to arrange them; drag the background to pan. A red person means the queen is waiting for input and a green robot means it is working; an idle queen has no mark.')
        : h('p', { class: 'hive-stage-empty' }, 'No hives yet. Create one, or add a task that is already on the board.'),
    ],
  });
  return h('section', { class: 'hive-stage', 'aria-label': 'Hives' }, map.el);
}

function cellMap(ctx, cell, related = null, previous = null) {
  const { hive, ui, send, api } = ctx;
  const archived = archiveHidden({ beads: hive.beads, rootId: cell.rootBeadId, archived: cell.archived || {} });
  const kids = activeKids(hive.beads, archived);
  const saved = placedLayout(cell.id, cell.beadLayout || {}, ui.placements());
  const closed = new Set(Object.values(hive.beads).filter(stackable).map((b) => b.id));
  const snapshotComplete = hive.backend?.snapshotComplete ?? !hive.backend?.snapshotError;
  const known = snapshotComplete && Array.isArray(hive.backend?.snapshotBeadIds) ? new Set(hive.backend.snapshotBeadIds) : null;
  const detachedPinned = new Set([...ui.detachedRegions(cell.id)].filter((id) => !known || known.has(id)));
  let layout = layoutCell({ kids, rootId: cell.rootBeadId, saved, aspect: cell.arrangeAspect, yieldIds: closed, detachedPinned, snapshotComplete, fallback: Boolean(cell.layoutWarning) });
  const base = layoutBase({ beads: hive.beads, rootId: cell.rootBeadId, saved, aspect: cell.arrangeAspect, hidden: [...archived] });
  const selected = ui.selectedBeadId();
  const heads = new Set(layout.groupHeads);
  const hiveHiding = ui.hideDoneForHive(cell.id);
  const hiding = hiveHiding ? [cell.rootBeadId, ...heads] : [];
  const { hidden: searchHidden, counts: hiddenCounts } = hiddenWork(hive, layout, kids, hiding);
  const searchIds = [...layout.order];
  const hidden = searchReveals(ui, cell.id) ? new Set() : searchHidden;
  if (hidden.size) layout = layoutCell({ kids, rootId: cell.rootBeadId, saved, aspect: cell.arrangeAspect, yieldIds: closed, hidden, detachedPinned, snapshotComplete, fallback: Boolean(cell.layoutWarning) });
  ui.setDetachedRegions(cell.id, layout.detachedPinned);
  const items = layout.order.filter((id) => !hidden.has(id)).map((id) => {
    const p = layout.positions[id];
    const { x, y } = toPixel(p, BEAD_SIZE);
    const tile = beadTile(ctx, hive.beads[id], { cellId: cell.id, layout, local: p, x, y, ox: 0, oy: 0, hiddenCount: hiddenCounts.get(id) || 0 }, kids);
    if (related?.ids.has(id)) { tile.classes = `${tile.classes || ''} is-conversation-related`; tile.ariaLabel += '; Related to conversation'; }
    return tile;
  });
  const visible = new Set(items.map(it => it.id));
  const drawRelated = () => {
    if (!related) return;
    renderRelatedBeads(related, id => visible.has(id)
        ? h('button', { type: 'button', class: 'hive-chip hive-related-chip', 'data-focus-key': `related:${id}`, title: `Locate ${hive.beads[id].title || id} on the map`, onclick: e => { e.stopPropagation(); focusTile(id); } }, hive.beads[id].title || id)
        : h('span', { class: 'hive-chip hive-related-hidden' }, `${hive.beads[id].title || id} (${hidden.has(id) ? 'hidden by Hide done' : 'not shown on map'})`));
  };
  drawRelated();
  const preview = (id, target) => previewMove({ layout, kids, id, target, hidden, saved });
  let draggedId = null, dragPlanner = null;
  const startDrag = (id) => {
    draggedId = id;
    dragPlanner = createDragPlanner({ layout, kids, rootId: cell.rootBeadId, saved, aspect: cell.arrangeAspect, id, hidden, yieldIds: closed });
  };
  const dragPreview = (id, target) => {
    if (draggedId !== id) startDrag(id);
    return dragPlanner(target);
  };
  const drawn = { ...layout, positions: Object.fromEntries(Object.entries(layout.positions).filter(([id]) => !hidden.has(id))) };
  const positions = Object.values(drawn.positions);
  const box = pixelBounds(positions.length ? positions : [{ q: 0, r: 0 }], BEAD_SIZE);
  const trim = BEAD_SIZE * 0.5;
  const rel = relationsFor(hive, layout.order, hidden);
  const present = new Set(layout.order);
  // Arrange resets any positions set by hand here and packs the comb to the
  // shape of the map as it is now, and only when pressed: the shape is stored
  // with the hive, so resizing the window or the panels never moves anything.
  // While a reset is in flight it is disabled, so clicks never queue repeats.
  const savedHere = Object.keys(saved).filter((id) => present.has(id));
  const arranging = ctx.busy('hive-bead-move');
  const arrange = async () => {
    if (ctx.busy('hive-bead-move')) return;
    const r = map.el.getBoundingClientRect();
    const aspect = r.width > 0 && r.height > 0 ? normalAspect(r.width / r.height) : null;
    if (!savedHere.length && (aspect === null || aspect === normalAspect(cell.arrangeAspect))) {
      ctx.notice('This hive is already arranged to fit the map as it is now.', { severity: 'info' });
      return;
    }
    if (savedHere.length && !await confirmHive('Rearrange this hive to fit the map as it is now? Positions you set here are reset. Links are not changed.')) return;
    send({ type: 'hive-bead-move', cellId: cell.id, positions: Object.fromEntries(savedHere.map((id) => [id, null])), ...(aspect === null ? {} : { aspect }) });
  };
  const menuForm = ui.form('wsMenu');
  const menuHead = menuForm?.cellId === cell.id && heads.has(menuForm.headId) && !hidden.has(menuForm.headId) ? menuForm.headId : null;
  const closeMenu = () => {
    ui.setForm('wsMenu', null);
    if (menuForm?.globalDone) document.querySelector(`[data-focus-key="hide-done:${cell.id}"]`)?.focus();
    else if (menuHead) focusTile(menuHead);
  };
  const dismissMenu = {
    quiet: () => {
      const open = ui.form('wsMenu');
      if (open?.cellId === menuForm?.cellId && open?.headId === menuForm?.headId) ui.dropForm('wsMenu');
    },
    redraw: () => { if (!ui.form('wsMenu')) ui.setForm('wsMenu', null); },
  };
  const readOnly = Boolean(cell.retired);
  const save = (plan, onSaved) => readOnly ? ctx.notice('This hive is retired. Reopen it to rearrange its work.') : ui.sendPlacement(
    { type: 'hive-bead-move', cellId: cell.id, positions: plan.positions, base, ...(plan.stack?.length ? { stack: plan.stack } : {}) },
    { kind: 'beads', cellId: cell.id, positions: plan.positions },
    { onSaved },
  );
  const hiveReveal = () => {
    const after = new Set();
    const back = new Set(hidden);
    return planHiveReveal({ layout, kids, rootId: cell.rootBeadId, saved, aspect: cell.arrangeAspect, back, hidden: after, yieldIds: closed, edges: hive.edges });
  };
  const setHiveHiding = (on, plan) => {
    if (plan.detachedPinned) ui.setDetachedRegions(cell.id, plan.detachedPinned);
    ui.setHideDoneForHive(cell.id, on);
  };
  const toggleHiveDone = (evt) => {
    if (arranging) return;
    if (hiveHiding) {
      const plan = hiveReveal();
      if (!plan.ok) { ctx.notice(plan.reason); return; }
      if (plan.same) setHiveHiding(false, plan);
      else {
        ui.setForm('wsMenu', { cellId: cell.id, globalDone: true, at: { x: evt.clientX, y: evt.clientY }, confirm: { text: 'Showing done work across this hive needs placement changes to make room.' } });
        document.querySelector('[data-focus-key="wsmenu:confirm"]')?.focus();
      }
      return;
    }
    const after = hiddenWork(hive, layout, kids, [cell.rootBeadId, ...heads]).hidden;
    const plan = planHide({ layout, kids, rootId: cell.rootBeadId, saved, aspect: cell.arrangeAspect, hidden: after, yieldIds: closed });
    if (!plan.ok) { ctx.notice(plan.reason); return; }
    ui.setForm('wsMenu', null);
    if (plan.same) setHiveHiding(true, plan); else save(plan, () => setHiveHiding(true, plan));
  };
  const confirmHiveReveal = () => {
    if (arranging) return;
    const plan = hiveReveal();
    ui.setForm('wsMenu', null);
    if (!plan.ok) ctx.notice(plan.reason);
    else if (plan.same) setHiveHiding(false, plan);
    else save(plan, () => setHiveHiding(false, plan));
    document.querySelector(`[data-focus-key="hide-done:${cell.id}"]`)?.focus();
  };
  const arrangeGroup = () => {
    ui.setForm('wsMenu', null);
    if (!ctx.busy('hive-bead-move')) {
      const plan = planGroupArrange({ layout, kids, rootId: cell.rootBeadId, saved, aspect: cell.arrangeAspect, headId: menuHead, isDone: (id) => isDone(hive.beads[id]), hidden, yieldIds: closed });
      if (!plan.ok) ctx.notice(plan.reason);
      else if (plan.same) ctx.notice('This workstream is already arranged.', { severity: 'info' });
      else save(plan);
    }
    focusTile(menuHead);
  };
  const writable = cell.enabled && !cell.snapshot;
  const menuOpen = menuHead && hive.beads[menuHead]?.status !== 'closed';
  const menuClosed = menuHead && !menuOpen && hive.beads[menuHead]?.parentId === cell.rootBeadId && groupClosed(hive, menuHead);
  const completeGroup = () => {
    ui.setForm('wsMenu', null);
    openComplete(ctx, cell, menuHead);
  };
  const archiveGroup = () => {
    ui.setForm('wsMenu', null);
    send({ type: 'hive-ws-archive', cellId: cell.id, headId: menuHead }, { onReply: archiveReply(ctx) });
  };
  // Tiles drawn away from the hex they saved, because another tile saved it
  // too while closed work was hidden in some browser.
  const away = (headId) => [...membersOf(layout, kids, headId)].filter((id) => {
    const p = saved[id];
    return !hidden.has(id) && p && Number.isInteger(p.q) && Number.isInteger(p.r) && key(p) !== key(layout.positions[id]);
  });
  // Showing closed work again, or fitting tiles back, may need a move first.
  // That move is planned against the map as it is when it is confirmed.
  const reveal = () => {
    const back = new Set(away(menuHead));
    return { back, plan: planReveal({ layout, kids, rootId: cell.rootBeadId, saved, aspect: cell.arrangeAspect, headId: menuHead, back, hidden, yieldIds: closed }) };
  };
  const startReveal = () => {
    const { plan, back } = reveal();
    if (!plan.ok) {
      ui.setForm('wsMenu', null);
      ctx.notice(plan.reason);
      focusTile(menuHead);
    } else if (plan.same) {
      ui.setForm('wsMenu', null);
      focusTile(menuHead);
    } else {
      const allClosed = [...back].every((id) => closed.has(id));
      ui.setForm('wsMenu', { ...menuForm, confirm: { kind: 'fit', text: revealWarning(plan, allClosed) } });
      document.querySelector('[data-focus-key="wsmenu:confirm"]')?.focus();
    }
  };
  const confirmReveal = () => {
    const { plan } = reveal();
    ui.setForm('wsMenu', null);
    if (!plan.ok) ctx.notice(plan.reason);
    else if (!plan.same) save(plan);
    focusTile(menuHead);
  };
  const asked = menuHead && menuForm.confirm?.kind === 'fit' ? menuForm.confirm : null;
  const confirm = asked ? { text: String(asked.text || ''), action: 'Move and fit' } : null;
  const awayHere = menuHead ? away(menuHead) : [];
  const fitLabel = awayHere.length ? (awayHere.every((id) => closed.has(id)) ? 'Fit closed work back' : 'Fit work back') : null;
  const openMenu = (headId, at) => {
    const current = ui.form('wsMenu');
    if (current?.cellId === cell.id && current.headId === headId) return;
    ui.setForm('wsMenu', { cellId: cell.id, headId, at });
    document.querySelector('[data-focus-key="wsmenu:arrange"]')?.focus();
  };
  const keyOpen = Boolean(ui.form('key'));
  const map = renderHexMap({
    viewKey: `cell:${cell.id}`,
    storage: api?.storage,
    previousPositions: previous?.hiveTilePositions,
    size: BEAD_SIZE,
    items,
    occupied: new Set(positions.map(key)),
    bounds: { x: box.x + trim, y: box.y + trim, w: box.width - trim * 2, h: box.height - trim * 2 },
    selectedId: selected,
    maxFit: 1.6,
    relations: rel,
    describe: (id) => describeRelations(hive, rel, id),
    outlines: groupOutlines(drawn, BEAD_SIZE).map((o) => ({ d: o.d, headId: o.headId, className: workstreamClasses(o.headId, cell.workstreamColours, layout.regionParents, cell.workstreamShades) })),
    ariaLabel: 'Every bead in this hive, as a honeycomb. Each workstream has its own labelled region and outline. Child workstreams are separate regions. Position is only your arrangement; neighbouring cells are not linked. Shift+F10 on a workstream for its actions.',
    onClick: (id) => ui.selectBead(id),
    onActivate: id => {
      const item = items.find(item => item.id === id);
      if (item?.onMark) item.onMark(document.querySelector(`[data-tile-id="${CSS.escape(id)}"]`));
      else ui.selectBead(id);
    },
    onSelect: (id) => ui.selectBead(id),
    dragGroup: (id) => {
      if (readOnly || !layout.groupHeads.includes(id)) return null;
      const ids = subtreeMembers(layout,kids,id);
      return {ids:[...ids],outlines:layout.groupHeads.filter((head)=>ids.has(head))};
    },
    onDragStart: readOnly ? () => {} : startDrag,
    movePreview: dragPreview,
    onDrop: (id, target) => {
      if (readOnly) return;
      const plan = dragPreview(id, target);
      if (!plan.ok) { ctx.notice(plan.reason); return; }
      if (!plan.same) {
        for (const [id, p] of Object.entries(plan.moves)) map.el.hiveTilePositions?.set(id, toPixel(p, BEAD_SIZE));
        save(plan);
      }
    },
    onContextMenu: openMenu,
    onMove: (id, pos) => {
      if (readOnly) return;
      const check = preview(id, pos);
      if (!check.ok) {
        ctx.notice(check.reason);
        return;
      }
      const plan = planMove({ layout, kids, rootId: cell.rootBeadId, saved, aspect: cell.arrangeAspect, id, target: pos, hidden, yieldIds: closed });
      if (!plan.ok) {
        ctx.notice(plan.reason);
        return;
      }
      if (plan.same) return;
      save(plan);
    },
    onBackground: () => {
      if (selected) ui.selectBead(null);
    },
    onDragState: (on) => ui.setDragging(on),
    claimDrag: api?.claimDrag ? (el) => api.claimDrag(el) : null,
    overlay: [
      cell.snapshot ? null : h('div', { class: 'hive-stage-tools' },
        h('button', {
          type: 'button',
          class: 'hive-quiet-btn',
          onclick: arrange,
          disabled: readOnly || arranging || !layout.order.length,
          'data-focus-key': `arrange:${cell.id}`,
          title: savedHere.length ? 'Reset positions set by hand and pack this hive to fit the map as it is now' : 'Pack this hive to fit the map as it is now',
        }, arranging ? 'Arranging…' : 'Arrange'),
        h('button', {
          type: 'button', class: 'hive-quiet-btn', onclick: toggleHiveDone, disabled: arranging || !layout.order.length,
          'data-focus-key': `hide-done:${cell.id}`, 'aria-pressed': hiveHiding ? 'true' : 'false',
          title: hiveHiding ? 'Show done work across this hive' : 'Hide done work across this hive',
        }, hiveHiding ? 'Show done' : 'Hide done')),
      h('div', { class: `hive-key${keyOpen ? ' is-open' : ''}`, onwheel: (e) => e.stopPropagation() },
        keyOpen ? legend(Boolean(cell.snapshot)) : null,
        h('button', {
          type: 'button',
          class: 'hive-key-btn',
          'aria-expanded': keyOpen ? 'true' : 'false',
          'data-focus-key': 'key',
          title: 'What the marks, outlines and arrows on the map mean',
          onclick: () => ui.setForm('key', keyOpen ? null : {}),
        }, keyOpen ? 'Hide key' : 'Key')),
      menuHead ? workstreamMenu({
        title: hive.beads[menuHead]?.title || menuHead,
        at: menuForm.at || { x: 0, y: 0 },
        arranging,
        fitLabel,
        confirm,
        onArrange: arrangeGroup,
        onComplete: writable && menuOpen ? completeGroup : null,
        onArchive: writable && menuClosed ? archiveGroup : null,
        archiveLabel: cell.archived?.[menuHead]?.shown ? 'Hide again' : 'Archive workstream',
        onFit: startReveal,
        onConfirm: confirmReveal,
        onClose: closeMenu,
        onDismiss: dismissMenu,
      }) : null,
      menuForm?.cellId === cell.id && menuForm.globalDone && menuForm.confirm ? workstreamMenu({
        title: 'Show done across this hive', at: menuForm.at || { x: 0, y: 0 }, arranging,
        confirm: { text: menuForm.confirm.text, action: 'Move and show' }, onConfirm: confirmHiveReveal, onClose: closeMenu, onDismiss: dismissMenu,
      }) : null,
      layout.order.length ? null : h('div', { class: 'hive-stage-empty' }, h('p', {}, h('strong', {}, 'Waiting for the queen\'s work map.'), ' Once it is active, the queen maps the task\'s existing work into beads and links its sessions. Existing sessions are not turned into beads automatically.')),
    ],
  });
  if (hidden.size && Object.keys(layout.automatic).length && snapshotComplete && !cell.snapshot && cell.enabled && !arranging) {
    const plan = planHide({ layout, kids, saved, hidden });
    const attempt = JSON.stringify([cell.id, base, plan.positions]);
    if (plan.ok && !plan.same && automaticPlacements.get(ui) !== attempt) globalThis.requestAnimationFrame?.(() => {
      if (!map.el.isConnected || ctx.busy('hive-bead-move') || automaticPlacements.get(ui) === attempt) return;
      automaticPlacements.set(ui, attempt);
      save(plan);
    });
  }
  bindMapSearch({ ctx, cell, map, ids: searchIds, hidden: searchHidden, heads: [...heads] });
  const updateRelated = () => {
    related?.refresh?.();
    drawRelated();
    const labels = new Map(items.map(it => [it.id, (it.ariaLabel || '').replace(/; Related to conversation$/, '')]));
    for (const tile of map.el.querySelectorAll('[data-tile-id]')) {
      const on = Boolean(related?.ids.has(tile.dataset.tileId));
      tile.classList.toggle('is-conversation-related', on);
      tile.setAttribute('aria-label', `${labels.get(tile.dataset.tileId) || ''}${on ? '; Related to conversation' : ''}`);
    }
  };
  const connectRelated = next => {
    related = next;
    if (related) related.el.hiveSelectMessage = updateRelated;
    updateRelated();
  };
  map.el.hiveConnectRelated = connectRelated;
  connectRelated(related);
  if (ctx.beadReference) ctx.beadReference.highlight = map.highlightReference;
  return h('section', { class: 'hive-stage', 'aria-label': 'Work map' }, map.el);
}

// Two levels: the overview shows only the task cells; opening one shows only
// that cell's beads.
const hiveViews = new WeakMap();
const automaticPlacements = new WeakMap();

export function renderHive(ctx) {
  const { hive, ui, graph } = ctx;
  const allCells = Object.values(hive.cells).filter((c) => c.occupiedCount > 0 || c.snapshot || (graph?.tasks?.tasks?.some((t) => t.id === c.taskId && !t.archivedAt && !t.archived) ?? true));
  const retiredCount = allCells.filter((c) => c.retired && !c.occupiedCount).length;
  const showRetired = ui.showRetired?.() === true;
  const cells = showRetired ? allCells : allCells.filter((c) => !c.retired || c.occupiedCount > 0);
  const focusedId = ui.cellId();
  const cell = focusedId ? hive.cells[focusedId] : null;
  if (focusedId || cells.length === 0 || !ui.dockOpen()) ui.cancelGlobalInboxSearch?.();
  if (focusedId && !cell && ui.pendingCell() === focusedId) {
    return {
      top: h('div', { class: 'hive-cellview' },
        h('header', { class: 'hive-cellhead' }, h('div', { class: 'hive-cellhead-top' },
          h('button', { type: 'button', class: 'hive-back', onclick: () => ui.closeCell(), 'aria-label': 'Back to all hives' }, h('span', { class: 'hive-back-icon', 'aria-hidden': 'true' }), 'All hives'))),
        noticesEl(ctx),
        h('div', { class: 'hive-stage hive-stage-note', role: 'status' }, h('p', {}, 'Opening the new hive. It appears here as soon as the server reports it; nothing is created again.'))),
      bottom: null,
      inspector: false,
      view: { inspecting: false, panels: false, pane: null },
    };
  }
  if (cell) {
    let cached = hiveViews.get(ui);
    if (!cached || cached.cellId !== cell.id) {
      disposeMap(cached?.map);
      cached = { cellId: cell.id, beadReference: {} };
      hiveViews.set(ui, cached);
    }
    const cellCtx = { ...ctx, beadReference: cached.beadReference };
    const panels = cellPanels(cellCtx, cell);
    if (!cached.top) cached.top = h('div', { class: 'hive-cellview', onkeydown: panels.onKeyDown });
    const root = cell.rootBeadId ? hive.beads[cell.rootBeadId] : null;
    let body;
    if (!cell.enabled && !cell.retired) body = h('div', { class: 'hive-stage hive-stage-note' }, h('p', {}, 'This hive is off. Its record is kept; turn it on to see its work and to let agents use it.'));
    else if (panels.inspecting) body = panels.inspectbar;
    else if (!root) body = h('div', { class: 'hive-stage hive-stage-note' }, h('p', {}, 'The hive goal is not in the store yet. See "To reconcile" above.'));
    else {
      const sig = mapInputs(ctx, cell);
      if (cached.sig !== sig || cached.map?.parentNode !== cached.top || ui.form('wsMenu')) {
        disposeMap(cached.map);
        cached.map = cellMap(cellCtx, cell, panels.related, cached.map?.querySelector('.hive-canvas'));
        cached.sig = mapInputs(ctx, cell);
        cached.related = panels.related;
      } else if (cached.related !== panels.related) {
        cached.map.querySelector('.hive-canvas')?.hiveConnectRelated?.(panels.related);
        cached.related = panels.related;
      }
      cached.map.querySelector('.hive-canvas')?.hiveRefreshSearch?.(ctx);
      body = cached.map;
    }
    const top = syncChildren(cached.top, [panels.header, body, panels.tabs, panels.info], ctx.beforeReplace);
    return {
      top,
      bottom: panels.dock,
      inspector: panels.inspecting,
      view: { inspecting: panels.inspecting, panels: Boolean(panels.dock), pane: ui.pane() },
    };
  }
  const total = cells.reduce((n, c) => n + cellCounts(hive, c).total, 0);
  let cached = hiveViews.get(ui);
  if (!cached || cached.cellId !== null) {
    disposeMap(cached?.map);
    cached = { cellId: null, top: h('div', { class: 'hive-overview' }) };
    hiveViews.set(ui, cached);
  }
  const sig = mapInputs(ctx, null);
  if (cached.sig !== sig) { disposeMap(cached.map); cached.map = overviewMap(ctx, cells); cached.sig = sig; }
  const top = syncChildren(cached.top, [
    h('header', { class: 'hive-overhead' },
      h('span', { class: 'hive-mark', 'aria-hidden': 'true' }),
      h('h2', { class: 'hive-title' }, 'All hives'),
      capacityControl(ctx),
      h('span', { class: 'hive-counts' }, `${cells.length} hive${cells.length === 1 ? '' : 's'}, ${total} bead${total === 1 ? '' : 's'}`),
      cells.length ? h('button', { type: 'button', class: 'hive-quiet-btn', 'aria-pressed': ui.dockOpen() ? 'true' : 'false', onclick: () => ui.setDockOpen(!ui.dockOpen()), 'data-focus-key': 'global-inbox-toggle' }, ui.dockOpen() ? 'Hide inbox' : 'Show inbox') : null,
      retiredCount ? h('button', { type: 'button', class: 'hive-quiet-btn', onclick: () => ui.setShowRetired(!showRetired), 'aria-pressed': showRetired ? 'true' : 'false', 'data-focus-key': 'show-retired', title: showRetired ? 'Hide retired hives from this map' : 'Show retired hives on this map' }, showRetired ? `Hide retired (${retiredCount})` : `Show retired (${retiredCount})`) : null,
      h('div', { class: 'hive-head-actions' },
        h('button', { type: 'button', class: 'hive-btn hive-btn-primary', onclick: () => openCellDialog(ui, 'new', 'open-new'), 'data-focus-key': 'open-new', 'aria-haspopup': 'dialog' }, 'New hive'),
        h('button', { type: 'button', class: 'hive-quiet-btn', onclick: () => openCellDialog(ui, 'adopt', 'open-adopt'), 'data-focus-key': 'open-adopt', 'aria-haspopup': 'dialog' }, 'Add existing task'),
        settingsButton(ctx)),
      allSettings(ctx)),
    noticesEl(ctx),
    attentionEl(ctx),
    cached.map,
    cellDialog(ctx)], ctx.beforeReplace);
  const panelsOpen = cells.length > 0 && ui.dockOpen();
  return {
    top,
    bottom: panelsOpen ? globalInbox(ctx, cells) : null,
    inspector: false,
    view: { overview: true, panels: panelsOpen, pane: null },
  };
}

function disposeMap(map) { map?.querySelector('.hive-canvas')?.hiveDisposeView?.(); }

export function disposeHiveView(ui) {
  disposeMap(hiveViews.get(ui)?.map);
  hiveViews.delete(ui);
}
