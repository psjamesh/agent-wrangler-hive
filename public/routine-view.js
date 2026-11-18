import { h } from './dom.js';
import { field, errorNote } from './widgets.js';
import { submitForm } from './form-submit.js';
import { validateSchedule, WEEKDAYS } from './schedule.js';

export const newRoutineKey = cellId => `new-routine:${cellId}`;
const editKey = (cellId, id) => `routine:${cellId}:${id}`;
const actionKey = id => `routine-action:${id}`;
const writable = cell => cell.enabled && !cell.snapshot && !cell.retired;

export function openNewRoutine(ctx, cell) {
  ctx.ui.setForm(newRoutineKey(cell.id), { name: '', days: [1, 2, 3, 4, 5], time: '09:00', timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', message: '', enabled: true });
  globalThis.document?.querySelector('[data-focus-key="routine:new:name"]')?.focus();
}

export function routineForm(ctx, cell, key, form, beadId = null) {
  const patch = change => ctx.ui.patchForm(key, change);
  const submit = e => {
    e.preventDefault();
    submitForm({ ctx, key,
      invalid: cur => { try { validateSchedule(cur); return null; } catch (err) { return err.message; } },
      message: cur => ({ type: 'hive-routine', cellId: cell.id, ...(beadId ? { beadId } : {}), action: beadId ? 'update' : 'create', schedule: validateSchedule(cur) }),
      failed: 'The schedule could not be saved.',
      lateFailure: frame => ctx.notice(`The schedule could not be saved: ${frame.error || ''}`),
      succeeded: (frame, mine) => {
        if (mine) ctx.ui.setForm(key, null);
        if (frame.bead_id) { ctx.ui.selectBead(frame.bead_id); ctx.ui.setPane?.('details'); ctx.ui.retryBeadDetail?.(frame.bead_id); }
      },
    });
  };
  const prefix = beadId || 'new';
  return h('form', { class: 'hive-routine-form hive-form', onsubmit: submit, 'aria-label': beadId ? 'Edit schedule' : 'New schedule' },
    field('Name', h('input', { value: form.name, maxlength: '200', oninput: e => patch({ name: e.target.value }), 'data-focus-key': `routine:${prefix}:name` })),
    h('fieldset', { disabled: Boolean(form.pending) }, h('legend', {}, 'Days'), h('div', { class: 'hive-routine-days' }, WEEKDAYS.map((day, i) =>
      h('label', {}, h('input', { type: 'checkbox', checked: form.days.includes(i), onchange: e => patch({ days: e.target.checked ? [...new Set([...ctx.ui.form(key).days, i])].sort() : ctx.ui.form(key).days.filter(d => d !== i) }), 'data-focus-key': `routine:${prefix}:day:${i}` }), day)))),
    field('Time (24-hour)', h('input', { type: 'time', value: form.time, oninput: e => patch({ time: e.target.value }), 'data-focus-key': `routine:${prefix}:time` })),
    field('Time zone', h('input', { value: form.timeZone, placeholder: 'Europe/London', maxlength: '100', oninput: e => patch({ timeZone: e.target.value }), 'data-focus-key': `routine:${prefix}:zone` })),
    field('Message to the queen', h('textarea', { value: form.message, maxlength: '19780', rows: '5', oninput: e => patch({ message: e.target.value }), 'data-focus-key': `routine:${prefix}:message` })),
    h('p', { class: 'hive-muted' }, 'After sleep, missed runs fire once. When clocks change, a missing local time skips that date; a repeated time runs at its first occurrence.'),
    errorNote(form.error),
    h('div', { class: 'hive-actions' },
      h('button', { type: 'submit', class: 'hive-btn hive-btn-primary', disabled: Boolean(form.pending) }, form.pending ? 'Saving…' : beadId ? 'Save schedule' : 'Create schedule'),
      h('button', { type: 'button', class: 'hive-btn', onclick: () => ctx.ui.setForm(key, null) }, 'Cancel')));
}

function act(ctx, cell, bead, action) {
  const key = actionKey(bead.id);
  if (ctx.ui.form(key)?.pending) return;
  ctx.ui.setForm(key, {});
  submitForm({ ctx, key,
    message: () => ({ type: 'hive-routine', cellId: cell.id, beadId: bead.id, action }),
    failed: 'The schedule action failed.',
    lateFailure: frame => ctx.notice(`The schedule action failed: ${frame.error || ''}`),
    succeeded: (frame, mine) => {
      if (mine) ctx.ui.setForm(key, null);
      ctx.ui.retryBeadDetail?.(bead.id);
      if (action === 'run-now') ctx.notice('Scheduled message saved for the queen.', { severity: 'info' });
    },
  });
}

export function routineDetails(ctx, cell, bead) {
  const schedule = bead.schedule;
  const key = editKey(cell.id, bead.id);
  const form = ctx.ui.form(key);
  const state = ctx.ui.form(actionKey(bead.id));
  const canEdit = writable(cell) && bead.status !== 'closed';
  const when = at => at ? new Date(at).toLocaleString(undefined, { timeZone: schedule.timeZone, timeZoneName: 'short' }) : '—';
  return h('section', { class: 'hive-routine-details', 'aria-label': 'Schedule' },
    h('h4', {}, 'Schedule'),
    h('p', {}, bead.status === 'closed' ? 'Ended' : schedule.enabled ? 'Active' : 'Paused', ` · ${schedule.days.map(d => WEEKDAYS[d]).join(', ')} at ${schedule.time} (${schedule.timeZone})`),
    h('p', { class: 'hive-routine-next' }, `Next run: ${when(schedule.nextRunAt)}`),
    h('p', { class: 'hive-routine-last' }, `Last run: ${when(schedule.lastRunAt)}${schedule.lastOutcome ? ` · ${schedule.lastOutcome}` : ''}`),
    form && canEdit ? routineForm(ctx, cell, key, form, bead.id) : [
      h('p', { class: 'hive-routine-message' }, schedule.message),
      canEdit ? h('div', { class: 'hive-actions' },
        h('button', { type: 'button', class: 'hive-btn', disabled: Boolean(state?.pending), onclick: () => ctx.ui.setForm(key, { ...schedule }) }, 'Edit schedule'),
        h('button', { type: 'button', class: 'hive-btn', disabled: Boolean(state?.pending), onclick: () => act(ctx, cell, bead, schedule.enabled ? 'pause' : 'resume') }, schedule.enabled ? 'Pause' : 'Resume'),
        h('button', { type: 'button', class: 'hive-btn', disabled: Boolean(state?.pending), onclick: () => act(ctx, cell, bead, 'run-now') }, 'Run now'),
        h('button', { type: 'button', class: 'hive-btn', disabled: Boolean(state?.pending), onclick: () => act(ctx, cell, bead, 'end') }, 'End schedule')) : null,
    ],
    errorNote(state?.error));
}

export function routineDrawer(ctx, cell) {
  const key = newRoutineKey(cell.id);
  const form = ctx.ui.form(key);
  if (!form || !writable(cell)) return null;
  const close = () => ctx.ui.setForm(key, null);
  return h('aside', { class: 'hive-info hive-routine-drawer', role: 'dialog', 'aria-label': 'New schedule', onkeydown: e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } } },
    h('div', { class: 'hive-info-head' }, h('h3', {}, 'New schedule'), h('button', { type: 'button', class: 'hive-quiet-btn', onclick: close }, 'Close')),
    h('div', { class: 'hive-info-body' }, routineForm(ctx, cell, key, form)));
}
