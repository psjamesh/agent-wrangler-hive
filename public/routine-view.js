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

export function routineForm(ctx, cell, key, form, scheduleId = null) {
  const patch = change => ctx.ui.patchForm(key, change);
  const submit = e => {
    e.preventDefault();
    submitForm({ ctx, key,
      invalid: cur => { try { validateSchedule(cur); return null; } catch (err) { return err.message; } },
      message: cur => ({ type: 'hive-routine', cellId: cell.id, ...(scheduleId ? { scheduleId } : {}), action: scheduleId ? 'update' : 'create', schedule: validateSchedule(cur) }),
      failed: 'The schedule could not be saved.',
      lateFailure: frame => ctx.notice(`The schedule could not be saved: ${frame.error || ''}`),
      succeeded: (frame, mine) => {
        if (mine) ctx.ui.setForm(key, null);
      },
    });
  };
  const prefix = scheduleId || 'new';
  return h('form', { class: 'hive-routine-form hive-form', onsubmit: submit, 'aria-label': scheduleId ? 'Edit schedule' : 'New schedule' },
    field('Name', h('input', { value: form.name, maxlength: '200', oninput: e => patch({ name: e.target.value }), 'data-focus-key': `routine:${prefix}:name` })),
    h('fieldset', { disabled: Boolean(form.pending) }, h('legend', {}, 'Days'), h('div', { class: 'hive-routine-days' }, WEEKDAYS.map((day, i) =>
      h('label', {}, h('input', { type: 'checkbox', checked: form.days.includes(i), onchange: e => patch({ days: e.target.checked ? [...new Set([...ctx.ui.form(key).days, i])].sort() : ctx.ui.form(key).days.filter(d => d !== i) }), 'data-focus-key': `routine:${prefix}:day:${i}` }), day)))),
    field('Time (24-hour)', h('input', { type: 'time', value: form.time, oninput: e => patch({ time: e.target.value }), 'data-focus-key': `routine:${prefix}:time` })),
    field('Time zone', h('input', { value: form.timeZone, placeholder: 'Europe/London', maxlength: '100', oninput: e => patch({ timeZone: e.target.value }), 'data-focus-key': `routine:${prefix}:zone` })),
    field('Message to the queen', h('textarea', { value: form.message, maxlength: '19780', rows: '5', oninput: e => patch({ message: e.target.value }), 'data-focus-key': `routine:${prefix}:message` })),
    h('p', { class: 'hive-muted' }, 'After sleep, missed runs fire once. When clocks change, a missing local time skips that date; a repeated time runs at its first occurrence.'),
    errorNote(form.error),
    h('div', { class: 'hive-actions' },
      h('button', { type: 'submit', class: 'hive-btn hive-btn-primary', disabled: Boolean(form.pending) }, form.pending ? 'Saving…' : scheduleId ? 'Save schedule' : 'Create schedule'),
      h('button', { type: 'button', class: 'hive-btn', onclick: () => ctx.ui.setForm(key, null) }, 'Cancel')));
}

function act(ctx, cell, schedule, action) {
  const key = actionKey(schedule.id);
  if (ctx.ui.form(key)?.pending) return;
  ctx.ui.setForm(key, {});
  submitForm({ ctx, key,
    message: () => ({ type: 'hive-routine', cellId: cell.id, scheduleId: schedule.id, action }),
    failed: 'The schedule action failed.',
    lateFailure: frame => ctx.notice(`The schedule action failed: ${frame.error || ''}`),
    succeeded: (frame, mine) => {
      if (mine) ctx.ui.setForm(key, null);
      if (action === 'delete') ctx.ui.setForm(editKey(cell.id, schedule.id), null);
      if (action === 'run-now') ctx.notice('Scheduled message saved for the queen.', { severity: 'info' });
    },
  });
}

export function scheduleCard(ctx, cell, schedule, openTopic = () => {}) {
  const key = editKey(cell.id, schedule.id);
  const form = ctx.ui.form(key);
  const state = ctx.ui.form(actionKey(schedule.id));
  const canEdit = writable(cell);
  const when = at => Number.isFinite(at) ? new Date(at).toLocaleString(undefined, { timeZone: schedule.timeZone, timeZoneName: 'short' }) : '—';
  return h('section', { class: 'hive-schedule-card', 'aria-label': schedule.name },
    h('h4', {}, schedule.name),
    h('p', {}, schedule.enabled ? 'Active' : 'Paused', ` · ${schedule.days.map(d => WEEKDAYS[d]).join(', ')} at ${schedule.time} (${schedule.timeZone})`),
    h('p', { class: 'hive-routine-next' }, `Next run: ${when(schedule.nextRunAt)}`),
    h('p', { class: 'hive-routine-last' }, `Last run: ${when(schedule.lastRunAt)}${schedule.lastOutcome ? ` · ${schedule.lastOutcome}` : ''}`),
    form && canEdit ? routineForm(ctx, cell, key, form, schedule.id) : h('p', { class: 'hive-routine-message' }, schedule.message),
    h('div', { class: 'hive-actions' },
      canEdit ? [
        h('button', { type: 'button', class: 'hive-btn', disabled: Boolean(state?.pending), onclick: () => ctx.ui.setForm(key, { ...schedule }) }, 'Edit schedule'),
        h('button', { type: 'button', class: 'hive-btn', disabled: Boolean(state?.pending), onclick: () => act(ctx, cell, schedule, schedule.enabled ? 'pause' : 'resume') }, schedule.enabled ? 'Pause' : 'Resume'),
        h('button', { type: 'button', class: 'hive-btn', disabled: Boolean(state?.pending), onclick: () => act(ctx, cell, schedule, 'run-now') }, 'Run now'),
        h('button', { type: 'button', class: 'hive-btn', disabled: Boolean(state?.pending), onclick: () => act(ctx, cell, schedule, 'delete') }, 'Delete'),
      ] : null,
      h('button', { type: 'button', class: 'hive-link-btn', onclick: () => openTopic(schedule) }, 'Open topic')),
    errorNote(state?.error));
}

export function schedulesView(ctx, cell, openTopic) {
  const key = newRoutineKey(cell.id);
  const form = ctx.ui.form(key);
  const schedules = cell.schedules || [];
  return h('div', { class: 'hive-schedules', 'aria-label': 'Schedules' },
    h('div', { class: 'hive-schedules-head' }, h('h3', {}, 'Schedules'),
      writable(cell) ? h('button', { type: 'button', class: 'hive-btn', onclick: () => openNewRoutine(ctx, cell) }, 'New schedule') : null),
    form && writable(cell) ? routineForm(ctx, cell, key, form) : null,
    schedules.length ? schedules.map(s => scheduleCard(ctx, cell, s, openTopic)) : h('p', { class: 'hive-muted' }, 'No schedules yet. Create one to send a recurring message to the queen.'));
}
