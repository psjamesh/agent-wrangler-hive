import { h } from './dom.js';
import { capacityEditor, openHiveSettings, restoreSettingsFocus } from './capacity-control.js';

export function settingsButton({ ui }) {
  return h('button', {
    type: 'button', class: 'hive-quiet-btn',
    'aria-expanded': String(Boolean(ui.form('settings'))), 'aria-controls': 'hive-all-settings', 'data-focus-key': 'open-settings',
    onclick: () => openHiveSettings(ui),
  }, 'Settings');
}

function bdSetting({ ui, api, send, busy }) {
  const key = 'global-bd';
  let form = ui.form(key);
  if (!form) {
    form = { value: api?.settings?.()?.bdPath || '' };
    ui.patchForm(key, form);
  }
  const change = patch => ui.setForm(key, { ...ui.form(key), ...patch });
  const save = async e => {
    e.preventDefault();
    const draft = ui.form(key);
    if (draft.saving) return;
    change({ saving: true, error: null, saved: false });
    try {
      if (typeof api?.settings?.set !== 'function') throw new Error('Settings cannot be saved here.');
      await api.settings.set('bdPath', draft.value.trim());
      change({ saving: false, saved: true });
      send({ type: 'hive-setup-recheck' });
    } catch (err) {
      change({ saving: false, error: `Could not save bd executable: ${err.message}` });
    } finally {
      restoreSettingsFocus('settings-bd-save');
    }
  };
  return h('form', { id: 'hive-bd-setting', class: 'hive-bd-setting', 'aria-label': 'bd executable', onsubmit: save },
    h('label', { for: 'hive-settings-bd' }, 'bd executable'),
    h('input', {
      id: 'hive-settings-bd', type: 'text', maxlength: 1024, value: form.value, disabled: form.saving,
      placeholder: '/opt/homebrew/bin/bd', 'data-focus-key': 'settings-bd-path', 'aria-describedby': 'hive-bd-help',
      oninput: e => change({ value: e.target.value, saved: false }),
    }),
    h('p', { class: 'hive-muted', id: 'hive-bd-help' }, 'Absolute path to bd. Leave empty to search the server PATH and common locations. Saving rechecks Beads.'),
    h('div', { class: 'hive-actions' },
      h('button', { type: 'submit', class: 'hive-btn', disabled: form.saving, 'data-focus-key': 'settings-bd-save' }, form.saving ? 'Saving…' : 'Save path'),
      h('button', { type: 'button', class: 'hive-quiet-btn', disabled: busy('hive-setup-recheck'), 'data-focus-key': 'settings-bd-recheck', onclick: () => send({ type: 'hive-setup-recheck' }) }, busy('hive-setup-recheck') ? 'Checking…' : 'Recheck')),
    form.saved ? h('p', { role: 'status' }, 'bd executable saved.') : null,
    form.error ? h('p', { role: 'alert' }, form.error) : null);
}

function notificationSetting({ ui, api }) {
  const key = 'global-notifications';
  let form = ui.form(key);
  if (!form?.saving) {
    const value = api?.settings?.()?.requestNotifications !== false;
    form = { ...form, value, saved: form?.value === value && form?.saved };
    ui.patchForm(key, form);
  }
  const change = patch => ui.setForm(key, { ...ui.form(key), ...patch });
  const save = async e => {
    const draft = ui.form(key);
    if (draft.saving) return;
    const value = e.target.checked;
    change({ value, saving: true, saved: false, error: null });
    try {
      if (typeof api?.settings?.set !== 'function') throw new Error('Settings cannot be saved here.');
      await api.settings.set('requestNotifications', value);
      change({ saving: false, saved: true });
    } catch (err) {
      change({ value: draft.value, saving: false, error: `Could not save notification preference: ${err.message}` });
    } finally {
      restoreSettingsFocus('settings-notifications');
    }
  };
  return h('div', { class: 'hive-notification-setting' },
    h('label', { class: 'hive-check' }, h('input', {
      type: 'checkbox', checked: form.value, disabled: form.saving, 'data-focus-key': 'settings-notifications',
      'aria-describedby': 'hive-notifications-help', onchange: save,
    }), 'Pop up when a Hive request needs you'),
    h('p', { class: 'hive-muted', id: 'hive-notifications-help' }, 'Shows a card anywhere in Agent Wrangler when a queen forwards you a request or your answer could not be delivered. Requests always appear in the Hive conversation either way.'),
    form.saved ? h('p', { role: 'status' }, 'Notification preference saved.') : null,
    form.error ? h('p', { role: 'alert' }, form.error) : null);
}

export function allSettings(ctx) {
  const { ui } = ctx;
  const form = ui.form('settings');
  if (!form) return null;
  const saving = () => ui.form('global-capacity')?.saving || ui.form('global-bd')?.saving || ui.form('global-notifications')?.saving;
  const close = () => {
    if (saving()) return;
    ui.setForm('settings', null);
    ui.setForm('global-capacity', null);
    ui.setForm('global-bd', null);
    ui.setForm('global-notifications', null);
    requestAnimationFrame(() => (document.querySelector(`[data-focus-key="${form.returnKey || 'open-settings'}"]`) || document.querySelector('[data-focus-key="open-settings"]'))?.focus());
  };
  return h('div', {
    class: 'hive-allsettings', id: 'hive-all-settings', role: 'group', 'aria-label': 'Settings for all hives',
    onkeydown: e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } },
  },
  h('div', { class: 'hive-allsettings-head' }, h('h3', {}, 'Settings for all hives'),
    h('button', { type: 'button', class: 'hive-quiet-btn', disabled: saving(), 'data-focus-key': 'settings-close', onclick: close }, 'Close')),
  capacityEditor(ctx),
  ctx.bees.slider('all'),
  h('p', { class: 'hive-muted' }, 'Bees are decoration and mean nothing about the work. Reduced-motion settings stop them.'),
  bdSetting(ctx),
  notificationSetting(ctx));
}
