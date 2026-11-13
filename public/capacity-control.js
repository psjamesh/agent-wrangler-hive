import { h } from './dom.js';

const FORM = 'global-capacity';
const focus = key => requestAnimationFrame(() => document.querySelector(`[data-focus-key="${key}"]`)?.focus());

export function restoreSettingsFocus(key) {
  requestAnimationFrame(() => {
    if (!document.activeElement || document.activeElement === document.body) document.querySelector(`[data-focus-key="${key}"]`)?.focus();
  });
}

export function capacityLimit(api, fallback = 8) {
  const value = api?.settings?.()?.maxClaimedWork;
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

export function openHiveSettings(ui, returnKey = 'open-settings') {
  ui.setForm('settings', { returnKey });
  focus('capacity-limit');
}

export function capacityControl({ hive, ui, api }) {
  const usage = hive.capacity;
  if (!usage) return null;
  const limit = capacityLimit(api, usage.limit);
  const breakdown = usage.breakdown;
  const detail = breakdown ? `Across all hives: ${breakdown.claimed} claimed, ${breakdown.reviews} additional open reviews, ${breakdown.launching} launching or claim reservations. Each work bead counts once; reviews and launches share its slot.` : 'Across all hives. Each work bead counts once.';
  return h('div', { class: 'hive-capacity-control' },
    h('button', {
      type: 'button', class: 'hive-quiet-btn hive-capacity-count',
      'data-focus-key': 'capacity-toggle', 'aria-expanded': String(Boolean(ui.form('settings'))), 'aria-controls': 'hive-all-settings',
      title: `${detail} Open Hive Settings.`, 'aria-label': `${usage.used}${limit ? ` of ${limit}` : ''} in progress. ${detail} Open Hive Settings.`,
      onclick: () => openHiveSettings(ui, 'capacity-toggle'),
    }, `${usage.used}${limit ? ` of ${limit}` : ''} in progress`),
    usage.outside > 0 ? h('span', { class: 'hive-capacity-note' }, `· ${usage.outside} outside a hive`) : null,
    limit > 0 && usage.used > limit ? h('span', { class: 'hive-capacity-note', role: 'status' }, 'Over limit. Current work continues; new work waits for room.') : null);
}

export function capacityEditor({ hive, ui, api }) {
  let form = ui.form(FORM);
  if (!form) {
    const limit = capacityLimit(api, hive.capacity?.limit ?? 8);
    form = { value: String(limit), unlimited: limit === 0 };
    ui.patchForm(FORM, form);
  }
  const change = value => ui.setForm(FORM, { ...ui.form(FORM), ...value });
  const save = async e => {
    e.preventDefault();
    const draft = ui.form(FORM);
    if (!draft || draft.saving) return;
    const value = draft.unlimited ? 0 : Number(draft.value);
    if (!draft.unlimited && (!String(draft.value).trim() || !Number.isSafeInteger(value) || value < 0)) {
      change({ error: 'Enter a whole number of 0 or more. 0 means Unlimited.' });
      return;
    }
    change({ saving: true, error: null });
    try {
      if (typeof api?.settings?.set !== 'function') throw new Error('Settings cannot be saved here.');
      await api.settings.set('maxClaimedWork', value);
      change({ saving: false, saved: true, error: null });
    } catch (err) {
      change({ saving: false, error: `Could not save limit: ${err.message}` });
    } finally {
      restoreSettingsFocus('capacity-save');
    }
  };
  return h('form', {
      id: 'hive-capacity-editor', novalidate: true, class: 'hive-capacity-editor', 'aria-label': 'Maximum active workers', onsubmit: save,
    },
    h('label', { for: 'hive-capacity-limit' }, 'Maximum active workers'),
    h('input', {
      id: 'hive-capacity-limit', type: 'number', min: 0, step: 1, value: form.value, disabled: form.saving,
      'data-focus-key': 'capacity-limit', 'aria-describedby': 'hive-capacity-help',
      oninput: e => change({ value: e.target.value, unlimited: false, saved: false }),
    }),
    h('label', { class: 'hive-capacity-unlimited' }, h('input', { type: 'checkbox', checked: form.unlimited, disabled: form.saving, 'data-focus-key': 'capacity-unlimited', onchange: e => change({ unlimited: e.target.checked, saved: false }) }), 'Unlimited'),
    h('button', { type: 'submit', class: 'hive-btn hive-btn-primary', disabled: form.saving, 'data-focus-key': 'capacity-save' }, form.saving ? 'Saving…' : 'Save'),
    form.saved ? h('span', { role: 'status' }, 'Worker limit saved.') : null,
    h('p', { id: 'hive-capacity-help', class: 'hive-muted' }, 'One limit across all hives. 0 means Unlimited. Lowering the limit keeps current work.'),
    form.error ? h('p', { role: 'alert' }, form.error) : null);
}
