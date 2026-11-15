import { h } from './dom.js';

const fields = [
  ['workerMinutes', 'Dormant claim (minutes)', 30],
  ['idleMinutes', 'Idle holder without a terminal report (minutes)', 30],
  ['reviewMinutes', 'Review without verdict (minutes)', 60],
  ['messageMinutes', 'Unanswered message (minutes)', 30],
  ['waitHours', 'Untouched waiting work (hours)', 24],
  ['deferredDays', 'Deferred without a resume condition (days)', 7],
  ['untrackedMinutes', 'Untracked or finished-but-open work (minutes)', 30],
  ['waitGraceMinutes', 'Grace after a wait\'s named time (minutes)', 30],
  ['pickupHeldMinutes', 'Automatic pickup held (minutes)', 5],
  ['queenResponseMinutes', 'Queen not responding (minutes)', 30],
  ['humanWaitMinutes', 'Waiting on the human with no open request (minutes)', 10],
];

function threshold(cell, name, fallback) {
  return cell.watchdogSettings?.[name]
    ?? (name === 'idleMinutes' ? cell.watchdogSettings?.workerMinutes : null) ?? fallback;
}

export function watchdogSummary(cell) {
  return fields.map(([name, label, fallback]) => `${label.replace(/ \(.*$/, '')}: ${threshold(cell, name, fallback)}${name.endsWith('Hours') ? 'h' : name.endsWith('Days') ? 'd' : 'm'}`).join(' · ');
}

export function watchdogSettingsForm({ ui, send }, cell) {
  const key = `watchdog:${cell.id}`;
  let draft = ui.form(key);
  if (!draft) {
    draft = Object.fromEntries(fields.map(([name, , fallback]) => [name, threshold(cell, name, fallback)]));
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
  h('h4', {}, 'Watchdog'),
  h('p', { class: 'hive-muted' }, 'Watchdog thresholds for this hive. New flags wake the queen once; quiet checks never wake it. Queen not responding appears in Needs you when pending input has no queen activity for that long.'),
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
  h('div', { class: 'hive-actions' },
    h('button', { type: 'submit', class: 'hive-btn', disabled: draft.saving }, draft.saving ? 'Saving…' : 'Save watchdog settings'),
    h('button', { type: 'button', class: 'hive-quiet-btn', disabled: draft.saving,
      onclick: () => ui.setForm(key, { ...ui.form(key), ...Object.fromEntries(fields.map(([name, , fallback]) => [name, fallback])), saved: false, error: '' }) }, 'Reset to defaults')),
  h('p', { class: 'hive-muted' }, 'Reset changes the draft. Save watchdog settings to apply it.'));
}
