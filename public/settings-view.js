import { h } from './dom.js';
import { capacityEditor, openHiveSettings, restoreSettingsFocus } from './capacity-control.js';

export function settingsButton({ ui }, cell = null) {
  return h('button', {
    type: 'button', class: 'hive-quiet-btn hive-settings-cog', 'aria-label': 'Settings',
    title: 'Settings', 'aria-haspopup': 'dialog', 'aria-expanded': String(Boolean(ui.form('settings'))), 'aria-controls': 'hive-settings', 'data-focus-key': 'open-settings',
    onclick: () => openHiveSettings(ui, 'open-settings', cell && !cell.snapshot ? cell.id : null),
  }, h('svg:svg', { viewBox: '0 0 24 24', width: '18', height: '18', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.7', 'aria-hidden': 'true' },
    h('svg:path', { d: 'M9 3h6l.6 3 2 1.2 2.9-.9 3 5.2-2.3 2v2.3l2.3 2-3 5.2-2.9-.9-2 1.2-.6 3H9l-.6-3-2-1.2-2.9.9-3-5.2 2.3-2v-2.3l-2.3-2 3-5.2 2.9.9L8.4 6z', transform: 'translate(2 0) scale(.83)' }),
    h('svg:circle', { cx: '12', cy: '12', r: '3' })));
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

function toggleSetting({ ui, api }, { key, setting, label, help, disabled = false, focusKey, savedText }) {
  let form = ui.form(key);
  if (!form?.saving) {
    const value = api?.settings?.()?.[setting] !== false;
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
      await api.settings.set(setting, value);
      change({ saving: false, saved: true });
    } catch (err) {
      change({ value: draft.value, saving: false, error: `Could not save ${label}: ${err.message}` });
    } finally {
      restoreSettingsFocus(focusKey);
    }
  };
  const helpId = `hive-${focusKey}-help`;
  return [
    h('label', { class: 'hive-check' }, h('input', {
      type: 'checkbox', checked: form.value, disabled: form.saving || disabled, 'data-focus-key': focusKey,
      'aria-describedby': helpId, onchange: save,
    }), label),
    h('p', { class: 'hive-muted', id: helpId }, help),
    form.saved ? h('p', { role: 'status' }, savedText) : null,
    form.error ? h('p', { role: 'alert' }, form.error) : null,
  ];
}

export function keepAwakeSetting(ctx) {
  const status = ctx.hive?.keepAwake;
  const enabled = ctx.api?.settings?.()?.keepAwake !== false;
  return h('div', { class: 'hive-keep-awake-setting' },
    ...toggleSetting(ctx, {
      key: 'global-keep-awake', setting: 'keepAwake', label: 'Keep Mac awake while Hive work is active', focusKey: 'settings-keep-awake',
      help: 'Stops idle sleep while any hive has a claimed worker, an open review or a pending CI wait, and lets the Mac sleep again when Hive is idle. The display can still sleep. macOS only.',
      savedText: 'Keep-awake preference saved.',
    }),
    h('div', { class: 'hive-settings-suboption' }, ...toggleSetting(ctx, {
      key: 'global-keep-awake-ac', setting: 'keepAwakeAcOnly', label: 'Only on AC power', focusKey: 'settings-keep-awake-ac', disabled: !enabled,
      help: 'Lets the Mac sleep normally on battery power.',
      savedText: 'Power preference saved.',
    })),
    status ? h('p', { class: 'hive-muted', role: 'status', id: 'hive-keep-awake-status' },
      status.holding ? `Now: keeping the Mac awake (caffeinate pid ${status.pid ?? 'unknown'}).` : `Now: not keeping the Mac awake. ${status.detail || ''}`.trim()) : null);
}

const sections = { hive: ['general', 'agents', 'lifecycle', 'advanced'], all: ['general', 'advanced'] };
const sectionKey = tab => `hive:settings-section:${tab}`;

function savedSection(tab) {
  try { return localStorage.getItem(sectionKey(tab)); } catch { return null; }
}

export function advancedSettings(ui, scope, summary, ...children) {
  const key = `settings-advanced:${scope}`;
  return h('details', {
    class: 'hive-settings-advanced', open: Boolean(ui.form('settings')?.[key]),
    ontoggle: event => {
      const open = event.target.open;
      if (Boolean(ui.form('settings')?.[key]) !== open) ui.patchForm('settings', { [key]: open });
    },
  }, h('summary', { 'data-focus-key': `settings-advanced:${scope}` }, 'Advanced',
    h('span', { class: 'hive-settings-summary' }, summary)), ...children);
}

export function settingsModal(ctx, cell = null, thisHive = () => null) {
  const { ui } = ctx;
  const form = ui.form('settings');
  if (!form) return null;
  const local = cell && !cell.snapshot;
  const tab = local && form.tab !== 'all' ? 'hive' : 'all';
  const selected = form[`section:${tab}`] || savedSection(tab);
  const section = sections[tab].includes(selected) ? selected : 'general';
  const selectSection = id => {
    ui.setForm('settings', { ...ui.form('settings'), [`section:${tab}`]: id });
    try { localStorage.setItem(sectionKey(tab), id); } catch { }
    requestAnimationFrame(() => document.querySelector(`[data-focus-key="settings-section-${tab}-${id}"]`)?.focus());
  };
  const sectionButton = id => h('button', {
    type: 'button', role: 'tab', class: 'hive-tab', id: `hive-settings-section-${tab}-${id}`,
    'aria-selected': String(section === id), 'aria-controls': 'hive-settings-section-panel',
    tabindex: section === id ? '0' : '-1', 'data-focus-key': `settings-section-${tab}-${id}`,
    onclick: () => selectSection(id),
    onkeydown: event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const ids = sections[tab];
      selectSection(event.key === 'Home' ? ids[0] : event.key === 'End' ? ids.at(-1)
        : ids[(ids.indexOf(id) + (event.key === 'ArrowLeft' ? ids.length - 1 : 1)) % ids.length]);
    },
  }, id[0].toUpperCase() + id.slice(1));
  const keys = ['global-capacity', 'global-bd', 'global-notifications', 'global-keep-awake', 'global-keep-awake-ac',
    ...(cell ? [`settings-rename:${cell.id}`, `goal:${cell.id}`, `instructions:${cell.id}`, `watchdog:${cell.id}`, `codex-approvals:${cell.id}`, `review-policy:${cell.id}`, `worker-profile:${cell.id}`] : [])];
  const saving = () => keys.some(key => ui.form(key)?.saving || ui.form(key)?.pending) || ctx.bees.saving?.() || Object.values(ctx.hive?.beads || {}).some(b => ui.form(`worker-profile:${cell?.id}:${b.id}`)?.saving);
  const close = (restore = true) => {
    if (saving()) return false;
    ui.setForm('settings', null);
    ui.setForm('global-capacity', null);
    ui.setForm('global-bd', null);
    ui.setForm('global-notifications', null);
    ui.setForm('global-keep-awake', null);
    ui.setForm('global-keep-awake-ac', null);
    if (cell) { ui.setForm(`settings-rename:${cell.id}`, null); ui.setForm(`goal:${cell.id}`, null); }
    if (restore) requestAnimationFrame(() => (document.querySelector(`[data-focus-key="${form.returnKey || 'open-settings'}"]`) || document.querySelector('[data-focus-key="open-settings"]'))?.focus());
    return true;
  };
  const select = id => {
    ui.setForm('settings', { ...ui.form('settings'), tab: id });
    requestAnimationFrame(() => document.querySelector(`[data-focus-key="settings-tab-${id}"]`)?.focus());
  };
  const tabButton = (id, label) => h('button', {
    type: 'button', role: 'tab', class: 'hive-tab', id: `hive-settings-tab-${id}`,
    'aria-selected': String(tab === id), 'aria-controls': 'hive-settings-panel', tabindex: tab === id ? '0' : '-1',
    'data-focus-key': `settings-tab-${id}`, onclick: () => select(id),
    onkeydown: event => { if (local && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { event.preventDefault(); select(event.key === 'Home' ? 'hive' : event.key === 'End' ? 'all' : id === 'hive' ? 'all' : 'hive'); } },
  }, label);
  return h('div', { class: 'hive-modal' }, h('div', {
    class: 'hive-dialog hive-settings', id: 'hive-settings', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'hive-settings-title',
    onkeydown: e => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
      if (e.key !== 'Tab') return;
      const controls = [...e.currentTarget.querySelectorAll('button, input, select, textarea, summary, a[href], [tabindex]')].filter(el => !el.disabled && el.getAttribute('tabindex') !== '-1' && (el.offsetParent !== null || el === document.activeElement));
      if (!controls.length) return;
      const index = controls.indexOf(document.activeElement);
      if (index === -1 || (e.shiftKey ? index === 0 : index === controls.length - 1)) { e.preventDefault(); controls[e.shiftKey ? controls.length - 1 : 0].focus(); }
    },
  },
  h('div', { class: 'hive-dialog-head' }, h('h2', { id: 'hive-settings-title' }, 'Settings'),
    h('button', { type: 'button', class: 'hive-quiet-btn', disabled: saving(), 'data-autofocus': '', 'data-focus-key': 'settings-close', onclick: close }, 'Close')),
  h('div', { class: 'hive-tabs', role: 'tablist', 'aria-label': 'Settings scope' }, local ? tabButton('hive', 'This hive') : null, tabButton('all', 'All hives')),
  h('div', { class: 'hive-dialog-body', id: 'hive-settings-panel', role: 'tabpanel', 'aria-labelledby': `hive-settings-tab-${tab}`, dataset: { scrollKey: `settings:${tab}` } },
    h('div', { class: 'hive-tabs hive-settings-sections', role: 'tablist', 'aria-label': 'Settings section' }, sections[tab].map(sectionButton)),
    h('div', { id: 'hive-settings-section-panel', role: 'tabpanel', 'aria-labelledby': `hive-settings-section-${tab}-${section}`, dataset: { scrollKey: `settings:${tab}:${section}` } },
      tab === 'hive' ? thisHive(() => close(false), section)
        : section === 'advanced' ? advancedSettings(ui, 'all', `bd: ${ctx.api?.settings?.()?.bdPath || 'Automatic'}`, bdSetting(ctx),
          h('button', { type: 'button', class: 'hive-quiet-btn', disabled: ui.form('global-bd')?.saving,
            onclick: () => ui.setForm('global-bd', { ...ui.form('global-bd'), value: '', saved: false, error: null }) }, 'Reset to defaults'),
          h('p', { class: 'hive-muted' }, 'Reset clears the draft path. Save path to apply it.'))
          : [capacityEditor(ctx), notificationSetting(ctx), keepAwakeSetting(ctx), ctx.bees.slider('all'),
            h('p', { class: 'hive-muted' }, 'Bees are decoration and mean nothing about the work. Reduced-motion settings stop them.')]))));
}
