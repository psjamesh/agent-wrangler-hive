import { h, relativeTime } from './dom.js';
import { activeKids, under, archiveHidden } from './archive-layout.js';

const OUTCOMES = [
  ['done', 'Done: its goal is met'],
  ['dropped', 'Dropped: no longer needed'],
  ['superseded', 'Superseded by other work'],
  ['duplicate', 'Duplicate of other work'],
];

export const closedKey = (cellId) => `closed:${cellId}`;
export const completeKey = (cellId) => `wscomplete:${cellId}`;

function focusKey(k) {
  globalThis.document?.querySelector(`.hive-root [data-focus-key="${CSS.escape(k)}"]`)?.focus();
}

function firstLine(text) {
  return String(text || '').split('\n').find((l) => l.trim())?.trim() || '';
}

// Closed headings between this one and the hive goal, outermost first. The
// server checks the same list again before it reopens anything.
export function closedAncestors(beads, rootId, id) {
  const out = [];
  for (let p = beads[id]?.parentId; p && p !== rootId && beads[p]; p = beads[p].parentId) {
    if (beads[p].status === 'closed') out.unshift(p);
  }
  return out;
}

export function closedWorkstreams(hive, cell) {
  return Object.entries(cell.archived || {})
    .filter(([id, rec]) => hive.beads[id]?.parentId === cell.rootBeadId && hive.beads[id].status === 'closed' && hive.beads[id].closedAt === rec.closedAt)
    .sort(([, a], [, b]) => (b.closedAt ? Date.parse(b.closedAt) : b.at || 0) - (a.closedAt ? Date.parse(a.closedAt) : a.at || 0));
}

export function groupClosed(hive, headId) {
  return [...under(activeKids(hive.beads), headId)].every((id) => hive.beads[id]?.status === 'closed');
}

export function closedButton(ctx, cell) {
  const { ui, hive } = ctx;
  const n = closedWorkstreams(hive, cell).length;
  if (!n) return null;
  const k = closedKey(cell.id);
  const open = Boolean(ui.form(k));
  return h('button', {
    type: 'button',
    class: 'hive-quiet-btn',
    'aria-expanded': open ? 'true' : 'false',
    'aria-controls': `hive-closed-${cell.id}`,
    'data-focus-key': `closed-open:${cell.id}`,
    title: 'Archived workstreams in this hive: their history, showing them on the map, and reopening them',
    onclick: () => {
      ui.setForm(`info:${cell.id}`, null);
      ui.setForm(completeKey(cell.id), null);
      ui.setForm(k, open ? null : {});
      if (!open) focusKey(`closed-close:${cell.id}`);
    },
  }, `Closed workstreams (${n})`);
}

function reply(ctx, k, done) {
  return (frame) => {
    if (!frame.ok) {
      if (ctx.ui.form(k)) ctx.ui.patchForm(k, { error: frame.error || 'That did not work.', pending: null });
      else ctx.notice(frame.error || 'That did not work.', { severity: 'error' });
      ctx.ui.setForm(k, ctx.ui.form(k));
      return;
    }
    done?.(frame);
  };
}

export function archiveReply(ctx) {
  return (frame) => {
    if (!frame.ok) ctx.notice(frame.error || 'That did not work.', { severity: 'error' });
    else if (frame.waitingMessages) ctx.notice(`Archived. ${frame.waitingMessages} message${frame.waitingMessages === 1 ? '' : 's'} about this work still wait${frame.waitingMessages === 1 ? 's' : ''} for an answer or acknowledgement. Archiving does not answer or dismiss ${frame.waitingMessages === 1 ? 'it' : 'them'}; ${frame.waitingMessages === 1 ? 'it stays' : 'they stay'} in the conversation and inbox.`);
  };
}

function entry(ctx, cell, id, rec, form, hidden) {
  const { hive, ui, send } = ctx;
  const k = closedKey(cell.id);
  const bead = hive.beads[id];
  const gone = hidden.has(id);
  const back = !rec.shown && !gone;
  const reopening = form.reopen === id;
  const ancestors = closedAncestors(hive.beads, cell.rootBeadId, id);
  const busy = Boolean(form.pending);
  let where = 'Not on the map';
  if (rec.shown) where = 'Shown on the map';
  else if (back) where = 'Back on the map: work under it changed since it was archived';
  const outcome = bead.outcome || rec.outcome;
  const when = bead.closedAt || rec.closedAt;
  return h('li', { class: 'hive-closed-item' },
    h('div', { class: 'hive-closed-title' }, h('strong', {}, bead.title || id), ' ', h('span', { class: 'hive-muted' }, id)),
    h('p', { class: 'hive-muted' },
      [outcome ? `Closed, ${outcome}` : 'Closed', when ? `, ${relativeTime(Date.parse(when))}` : '', `. ${rec.itemCount ?? 0} item${rec.itemCount === 1 ? '' : 's'} kept. ${where}.`].join('')),
    bead.summaryLine || rec.summary ? h('p', {}, firstLine(bead.summaryLine || rec.summary)) : null,
    reopening ? h('form', {
      class: 'hive-form',
      onsubmit: (e) => {
        e.preventDefault();
        const cur = ui.form(k);
        if (!cur || cur.pending) return;
        if (!cur.reason?.trim()) {
          ui.setForm(k, { ...cur, error: 'Say why it is being reopened.' });
          return;
        }
        ui.setForm(k, { ...cur, pending: true, error: null });
        send({ type: 'hive-ws-reopen', cellId: cell.id, headId: id, reason: cur.reason, confirmAncestors: ancestors }, {
          onReply: reply(ctx, k, (frame) => {
            ui.setForm(k, {});
            if (frame.note) ctx.notice(frame.note);
          }),
        });
      },
    },
    h('p', {}, ancestors.length
      ? `Reopening it also reopens the closed workstream${ancestors.length === 1 ? '' : 's'} around it: ${ancestors.map((a) => hive.beads[a]?.title || a).join(', ')}. Work already finished under it stays finished.`
      : 'Work already finished under it stays finished. Its summary and evidence are kept.'),
    h('label', { class: 'hive-field' }, h('span', {}, 'Why reopen it'),
      h('input', { type: 'text', value: form.reason || '', maxlength: '2000', oninput: (e) => ui.patchForm(k, { reason: e.target.value }), 'data-focus-key': `reopen-reason:${id}` })),
    h('div', { class: 'hive-actions' },
      h('button', { type: 'submit', class: 'hive-btn hive-btn-primary', disabled: busy }, busy ? 'Reopening…' : 'Reopen'),
      h('button', { type: 'button', class: 'hive-btn', onclick: () => ui.setForm(k, {}) }, 'Cancel')))
      : h('div', { class: 'hive-actions' },
        h('button', { type: 'button', class: 'hive-btn', onclick: () => { ui.setForm(k, null); ui.selectBead(id); } }, 'History'),
        rec.shown
          ? h('button', { type: 'button', class: 'hive-btn', disabled: busy, onclick: () => send({ type: 'hive-ws-archive', cellId: cell.id, headId: id }, { onReply: archiveReply(ctx) }) }, 'Hide again')
          : h('button', { type: 'button', class: 'hive-btn', disabled: busy || back, onclick: () => send({ type: 'hive-ws-show', cellId: cell.id, headId: id }) }, 'Show on map'),
        h('button', { type: 'button', class: 'hive-btn', disabled: busy, onclick: () => { ui.setForm(k, { reopen: id, reason: '' }); focusKey(`reopen-reason:${id}`); } }, 'Reopen…')));
}

function closedDrawer(ctx, cell) {
  const { ui, hive } = ctx;
  const k = closedKey(cell.id);
  const form = ui.form(k);
  if (!form) return null;
  const close = () => {
    ui.setForm(k, null);
    focusKey(`closed-open:${cell.id}`);
  };
  const list = closedWorkstreams(hive, cell);
  const hidden = archiveHidden({ beads: hive.beads, rootId: cell.rootBeadId, archived: cell.archived || {} });
  return h('aside', {
    class: 'hive-info hive-closed',
    id: `hive-closed-${cell.id}`,
    role: 'dialog',
    'aria-label': 'Closed workstreams',
    onkeydown: (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } },
  },
  h('div', { class: 'hive-info-head' },
    h('h3', {}, 'Closed workstreams'),
    h('button', { type: 'button', class: 'hive-quiet-btn', onclick: close, 'data-focus-key': `closed-close:${cell.id}` }, 'Close')),
  h('div', { class: 'hive-info-body', dataset: { scrollKey: `closed:${cell.id}` } },
    h('p', { class: 'hive-muted' }, 'Archived workstreams keep their items, evidence, links, conversations and sessions. Showing one puts it back on the map while it stays closed.'),
    form.error ? h('p', { class: 'hive-dialog-error', role: 'alert' }, form.error) : null,
    list.length
      ? h('ul', { class: 'hive-closed-list' }, list.map(([id, rec]) => entry(ctx, cell, id, rec, form, hidden)))
      : h('p', { class: 'hive-muted' }, 'No closed workstreams are archived in this hive.')));
}

export function openComplete(ctx, cell, headId) {
  const { ui, send } = ctx;
  const k = completeKey(cell.id);
  ui.setForm(`info:${cell.id}`, null);
  ui.setForm(closedKey(cell.id), null);
  ui.setForm(k, { headId, outcome: 'done', summary: '', archive: true, check: null, error: null, pending: null });
  send({ type: 'hive-ws-check', cellId: cell.id, headId }, {
    onReply: (frame) => {
      if (ui.form(k)?.headId !== headId) return;
      if (frame.ok) ui.setForm(k, { ...ui.form(k), check: frame });
      else ui.setForm(k, { ...ui.form(k), error: frame.error || 'Hive could not check this workstream.' });
    },
  });
  focusKey(`complete-outcome:${cell.id}`);
}

function completeDrawer(ctx, cell) {
  const { ui, hive, send } = ctx;
  const k = completeKey(cell.id);
  const form = ui.form(k);
  if (!form) return null;
  const head = hive.beads[form.headId];
  const close = () => {
    ui.setForm(k, null);
  };
  const check = form.check;
  const problems = check?.problems || [];
  const ready = Boolean(check) && !problems.length && !form.pending;
  return h('aside', {
    class: 'hive-info hive-complete',
    role: 'dialog',
    'aria-label': 'Complete workstream',
    onkeydown: (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } },
  },
  h('div', { class: 'hive-info-head' },
    h('h3', {}, `Complete ${head?.title || form.headId}`),
    h('button', { type: 'button', class: 'hive-quiet-btn', onclick: close }, 'Close')),
  h('form', {
    class: 'hive-info-body hive-form',
    onsubmit: (e) => {
      e.preventDefault();
      const cur = ui.form(k);
      if (!cur || cur.pending || !cur.check || cur.check.problems?.length) return;
      if (!cur.summary?.trim()) {
        ui.setForm(k, { ...cur, error: 'Write a summary of what it achieved, or why it ended.' });
        return;
      }
      const reqId = `${Date.now().toString(36)}`;
      ui.setForm(k, { ...cur, pending: reqId, error: null });
      send({ type: 'hive-ws-complete', cellId: cell.id, headId: cur.headId, outcome: cur.outcome, summary: cur.summary, archive: cur.archive !== false }, {
        onReply: (frame) => {
          const mine = ui.form(k)?.pending === reqId;
          if (!frame.ok) {
            if (mine) ui.setForm(k, { ...ui.form(k), pending: null, error: frame.error || 'The workstream was not completed.' });
            else ctx.notice(`The workstream was not completed: ${frame.error || ''}`, { severity: 'error' });
            return;
          }
          if (mine) ui.setForm(k, null);
          if (frame.archiveError) ctx.notice(frame.archiveError, { severity: 'error' });
        },
      });
    },
  },
  h('p', { class: 'hive-muted' }, 'Completing closes the heading with an outcome and summary. Nothing under it is finished for you, and no session is stopped.'),
  check ? null : h('p', { class: 'hive-muted', role: 'status' }, 'Checking everything under it…'),
  problems.length ? h('div', { class: 'hive-dialog-error', role: 'alert' }, h('p', {}, 'It cannot be completed yet:'), h('ul', {}, problems.map((p) => h('li', {}, p)))) : null,
  check?.waitingMessages ? h('p', { class: 'hive-warning' }, `${check.waitingMessages} message${check.waitingMessages === 1 ? '' : 's'} about this work still wait${check.waitingMessages === 1 ? 's' : ''} for an answer or acknowledgement. Completing does not answer or dismiss ${check.waitingMessages === 1 ? 'it' : 'them'}; ${check.waitingMessages === 1 ? 'it stays' : 'they stay'} in the conversation and inbox.`) : null,
  h('label', { class: 'hive-field' }, h('span', {}, 'Outcome'),
    h('select', { onchange: (e) => ui.patchForm(k, { outcome: e.target.value }), 'data-focus-key': `complete-outcome:${cell.id}` },
      OUTCOMES.map(([v, label]) => h('option', { value: v, selected: v === form.outcome }, label)))),
  h('label', { class: 'hive-field' }, h('span', {}, 'Summary'),
    h('textarea', { rows: '4', value: form.summary || '', placeholder: 'What this workstream achieved, or why it ended.', oninput: (e) => ui.patchForm(k, { summary: e.target.value }), 'data-focus-key': `complete-summary:${cell.id}` })),
  head?.parentId !== cell.rootBeadId ? null : h('label', { class: 'hive-check' }, h('input', { type: 'checkbox', checked: form.archive !== false, onchange: (e) => ui.patchForm(k, { archive: e.target.checked }) }), ' Archive it once complete, freeing its space on the map'),
  form.error ? h('p', { class: 'hive-dialog-error', role: 'alert' }, form.error) : null,
  h('div', { class: 'hive-actions' },
    h('button', { type: 'submit', class: 'hive-btn hive-btn-primary', disabled: !ready }, form.pending ? 'Completing…' : 'Complete'),
    h('button', { type: 'button', class: 'hive-btn', onclick: close }, 'Cancel'))));
}

export function workstreamDrawer(ctx, cell) {
  if (cell.snapshot || !cell.enabled) return null;
  return completeDrawer(ctx, cell) || closedDrawer(ctx, cell);
}
