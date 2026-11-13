import { h } from './dom.js';

const fields = [
  ['workerMinutes', 'Dormant claim (minutes)', 30],
  ['idleMinutes', 'Idle holder without a terminal report (minutes)', 30],
  ['reviewMinutes', 'Review without verdict (minutes)', 60],
  ['messageMinutes', 'Unanswered message (minutes)', 30],
  ['waitHours', 'Untouched blocked or waiting work (hours)', 24],
  ['deferredDays', 'Deferred without a resume condition (days)', 7],
  ['untrackedMinutes', 'Untracked or finished-but-open work (minutes)', 30],
  ['waitGraceMinutes', 'Grace after a wait\'s named time (minutes)', 30],
  ['humanWaitMinutes', 'Waiting on the human with no open request (minutes)', 10],
];

export function watchdogSettingsForm({ ui, send }, cell) {
  const key = `watchdog:${cell.id}`;
  let draft = ui.form(key);
  if (!draft) {
    draft = Object.fromEntries(fields.map(([name, , fallback]) => [name, cell.watchdogSettings?.[name]
      ?? (name === 'idleMinutes' ? cell.watchdogSettings?.workerMinutes : null) ?? fallback]));
    ui.setForm(key, draft);
  }
  return h('form', {
    class: 'hive-form hive-watchdog',
    onsubmit: event => {
      event.preventDefault();
      if (ui.form(key)?.saving) return;
      const settings = Object.fromEntries(fields.map(([name]) => [name, Number(ui.form(key)[name])]));
      ui.patchForm(key, { saving: true, error: '', saved: false });
      send({ type: 'hive-watchdog-settings', cellId: cell.id, settings }, {
        onReply: reply => ui.patchForm(key, { saving: false, error: reply.ok ? '' : reply.error || 'Settings could not be saved.', saved: Boolean(reply.ok) }),
      });
    },
  },
  h('h4', {}, 'Settings'),
  h('p', { class: 'hive-muted' }, 'Watchdog thresholds for this hive. New flags wake the queen once; quiet checks never wake it.'),
  ...fields.map(([name, label]) => {
    const id = `hive-watchdog-${cell.id}-${name}`;
    return h('label', { for: id, class: 'hive-field' }, label, h('input', {
      id, type: 'number', min: 0.01, max: 525600, step: 'any', required: true, value: draft[name], disabled: draft.saving,
      'data-focus-key': `watchdog:${cell.id}:${name}`,
      oninput: event => ui.patchForm(key, { [name]: event.target.value, saved: false }),
    }));
  }),
  draft.error ? h('p', { class: 'hive-error', role: 'alert' }, draft.error) : null,
  draft.saved ? h('p', { role: 'status' }, 'Watchdog settings saved.') : null,
  h('button', { type: 'submit', class: 'hive-btn', disabled: draft.saving }, draft.saving ? 'Saving…' : 'Save watchdog settings'));
}
