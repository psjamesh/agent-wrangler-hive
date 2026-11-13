import { h } from './dom.js';
import { RETIRE_OUTCOMES, retireKey, isRetired } from './retired.js';

function focusKey(k) {
  globalThis.document?.querySelector(`.hive-root [data-focus-key="${CSS.escape(k)}"]`)?.focus();
}

export function openRetire(ctx, cell) {
  const { ui, send } = ctx;
  const k = retireKey(cell.id);
  ui.setForm(`info:${cell.id}`, null);
  ui.setForm(k, { mode: 'retire', outcome: 'done', summary: '', override: false, archiveSessions: false, check: null, error: null, pending: null });
  send({ type: 'hive-cell-retire-check', cellId: cell.id }, {
    onReply: (frame) => {
      if (ui.form(k)?.mode !== 'retire') return;
      if (frame.ok) ui.setForm(k, { ...ui.form(k), check: frame });
      else ui.setForm(k, { ...ui.form(k), error: frame.error || 'Hive could not check this hive.' });
    },
  });
  focusKey(`retire-outcome:${cell.id}`);
}

export function openReopen(ctx, cell) {
  ctx.ui.setForm(`info:${cell.id}`, null);
  ctx.ui.setForm(retireKey(cell.id), { mode: 'reopen', reason: '', error: null, pending: null });
  focusKey(`reopen-reason:${cell.id}`);
}

const sessionLine = (s) => `${s.name || s.session_id}${s.role ? ` (${s.role})` : ''}`;

function retireForm(ctx, cell, form) {
  const { ui, send } = ctx;
  const k = retireKey(cell.id);
  const check = form.check;
  const problems = check?.problems || [];
  const sessions = check?.sessions || [];
  const blocked = problems.length > 0 && !form.override;
  const ready = Boolean(check) && !blocked && !form.pending;
  return h('form', {
    class: 'hive-info-body hive-form',
    onsubmit: (e) => {
      e.preventDefault();
      const cur = ui.form(k);
      if (!cur || cur.pending || !cur.check) return;
      if (cur.check.problems?.length && !cur.override) return;
      if (!cur.summary?.trim()) {
        ui.setForm(k, { ...cur, error: 'Write a short summary of what the hive achieved, or why it ended.' });
        return;
      }
      const reqId = Date.now().toString(36);
      ui.setForm(k, { ...cur, pending: reqId, error: null });
      send({ type: 'hive-cell-retire', cellId: cell.id, outcome: cur.outcome, summary: cur.summary, override: cur.override === true, archiveSessions: cur.archiveSessions === true, sessionIds: (cur.check.sessions || []).map((s) => s.session_id) }, {
        onReply: (frame) => {
          const mine = ui.form(k)?.pending === reqId;
          if (!frame.ok) {
            if (mine) ui.setForm(k, { ...ui.form(k), pending: null, error: frame.error || 'The hive was not retired.' });
            else ctx.notice(`The hive was not retired: ${frame.error || ''}`);
            return;
          }
          if (mine) ui.setForm(k, null);
          if (frame.archiveFailed?.length) ctx.notice(`The hive is retired, but ${frame.archiveFailed.length} session${frame.archiveFailed.length === 1 ? ' was' : 's were'} not archived: ${frame.archiveFailed.map((f) => `${f.name || f.sessionId} (${f.error})`).join(', ')}.`);
          else if (frame.archived?.length) ctx.notice(`The hive is retired and ${frame.archived.length} session${frame.archived.length === 1 ? ' was' : 's were'} archived.`);
          ui.closeCell();
        },
      });
    },
  },
  h('p', { class: 'hive-muted' }, 'Retiring turns the hive off and takes it off the All hives map. Its work, conversation, requests and attachments are kept, and agents can no longer use it. Reopen it later if needed. No session is archived or stopped unless you tick the option below.'),
  check ? null : h('p', { class: 'hive-muted', role: 'status' }, 'Checking what is still open…'),
  problems.length ? h('div', { class: 'hive-warning', role: 'alert' },
    h('p', {}, 'Still open in this hive:'),
    h('ul', {}, problems.map((p) => h('li', {}, p))),
    check.openBeads?.length ? h('ul', { class: 'hive-muted' }, check.openBeads.map((b) => h('li', {}, `${b.title || b.id} (${b.id})${b.assignee ? `, claimed by ${b.assignee}` : ''}`))) : null,
    h('label', { class: 'hive-check' }, h('input', { type: 'checkbox', checked: form.override === true, onchange: (e) => ui.patchForm(k, { override: e.target.checked }), 'data-focus-key': `retire-override:${cell.id}` }), ' Retire anyway')) : null,
  h('label', { class: 'hive-field' }, h('span', {}, 'Outcome'),
    h('select', { onchange: (e) => ui.patchForm(k, { outcome: e.target.value }), 'data-focus-key': `retire-outcome:${cell.id}` },
      RETIRE_OUTCOMES.map(([v, label]) => h('option', { value: v, selected: v === form.outcome }, label)))),
  h('label', { class: 'hive-field' }, h('span', {}, 'Summary'),
    h('textarea', { rows: '4', value: form.summary || '', maxlength: '2000', placeholder: 'What this hive achieved, or why it ended.', oninput: (e) => ui.patchForm(k, { summary: e.target.value }), 'data-focus-key': `retire-summary:${cell.id}` })),
  check ? h('section', { class: 'hive-retire-sessions' },
    h('h4', {}, `Live sessions (${sessions.length})`),
    sessions.length ? h('ul', {}, sessions.map((s) => h('li', {}, sessionLine(s)))) : h('p', { class: 'hive-muted' }, 'No live sessions belong to this hive.'),
    sessions.length ? h('label', { class: 'hive-check' }, h('input', { type: 'checkbox', checked: form.archiveSessions === true, onchange: (e) => ui.patchForm(k, { archiveSessions: e.target.checked }), 'data-focus-key': `retire-archive:${cell.id}` }), ' Archive these sessions too') : null) : null,
  form.error ? h('p', { class: 'hive-dialog-error', role: 'alert' }, form.error) : null,
  h('div', { class: 'hive-actions' },
    h('button', { type: 'submit', class: 'hive-btn hive-btn-primary', disabled: !ready }, form.pending ? 'Retiring…' : 'Retire hive'),
    h('button', { type: 'button', class: 'hive-btn', onclick: () => ui.setForm(k, null) }, 'Cancel')));
}

function reopenForm(ctx, cell, form) {
  const { ui, send } = ctx;
  const k = retireKey(cell.id);
  return h('form', {
    class: 'hive-info-body hive-form',
    onsubmit: (e) => {
      e.preventDefault();
      const cur = ui.form(k);
      if (!cur || cur.pending) return;
      if (!cur.reason?.trim()) {
        ui.setForm(k, { ...cur, error: 'Say why the hive is being reopened.' });
        return;
      }
      const reqId = Date.now().toString(36);
      ui.setForm(k, { ...cur, pending: reqId, error: null });
      send({ type: 'hive-cell-reopen', cellId: cell.id, reason: cur.reason }, {
        onReply: (frame) => {
          const mine = ui.form(k)?.pending === reqId;
          if (!frame.ok) {
            if (mine) ui.setForm(k, { ...ui.form(k), pending: null, error: frame.error || 'The hive was not reopened.' });
            else ctx.notice(`The hive was not reopened: ${frame.error || ''}`);
            return;
          }
          if (mine) ui.setForm(k, null);
        },
      });
    },
  },
  h('p', { class: 'hive-muted' }, 'Reopening turns the hive back on and returns it to the All hives map, at its old place if that is free, otherwise the nearest free one. Nothing else moves.'),
  h('label', { class: 'hive-field' }, h('span', {}, 'Why reopen it'),
    h('input', { type: 'text', value: form.reason || '', maxlength: '2000', oninput: (e) => ui.patchForm(k, { reason: e.target.value }), 'data-focus-key': `reopen-reason:${cell.id}` })),
  form.error ? h('p', { class: 'hive-dialog-error', role: 'alert' }, form.error) : null,
  h('div', { class: 'hive-actions' },
    h('button', { type: 'submit', class: 'hive-btn hive-btn-primary', disabled: Boolean(form.pending) }, form.pending ? 'Reopening…' : 'Reopen hive'),
    h('button', { type: 'button', class: 'hive-btn', onclick: () => ui.setForm(k, null) }, 'Cancel')));
}

export function retireDrawer(ctx, cell) {
  const { ui } = ctx;
  const k = retireKey(cell.id);
  const form = ui.form(k);
  if (!form || cell.snapshot) return null;
  if (form.mode === 'retire' && isRetired(cell)) return null;
  if (form.mode === 'reopen' && !isRetired(cell)) return null;
  const close = () => ui.setForm(k, null);
  return h('aside', {
    class: 'hive-info hive-retire',
    role: 'dialog',
    'aria-label': form.mode === 'reopen' ? 'Reopen hive' : 'Retire hive',
    onkeydown: (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } },
  },
  h('div', { class: 'hive-info-head' },
    h('h3', {}, form.mode === 'reopen' ? 'Reopen hive' : 'Retire hive'),
    h('button', { type: 'button', class: 'hive-quiet-btn', onclick: close }, 'Close')),
  form.mode === 'reopen' ? reopenForm(ctx, cell, form) : retireForm(ctx, cell, form));
}
