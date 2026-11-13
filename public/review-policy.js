import { h } from './dom.js';

const defaults = { primary: { agent: 'claude', model: 'opus', effort: 'medium' }, secondary: { agent: 'codex', model: 'gpt-6.1-sol', effort: 'medium' } };
const slots = [['primary', 'Primary reviewer'], ['secondary', 'Secondary reviewer']];
const fields = [['agent', 'Agent'], ['model', 'Model'], ['effort', 'Effort']];

export function reviewPolicyForm({ ui, send }, cell) {
  const key = `review-policy:${cell.id}`;
  let draft = ui.form(key);
  if (!draft) {
    draft = Object.fromEntries(slots.map(([slot]) => [slot, { ...defaults[slot], ...(cell.reviewPolicy?.[slot] || {}) }]));
    ui.setForm(key, draft);
  }
  return h('form', {
    class: 'hive-form hive-review-policy',
    onsubmit: event => {
      event.preventDefault();
      if (ui.form(key)?.saving) return;
      const current = ui.form(key);
      const policy = Object.fromEntries(slots.map(([slot]) => [slot, Object.fromEntries(fields.map(([name]) => [name, String(current[slot][name] || '').trim()]))]));
      ui.patchForm(key, { saving: true, error: '', saved: false });
      send({ type: 'hive-review-policy', cellId: cell.id, policy }, {
        onReply: reply => ui.patchForm(key, { saving: false, error: reply.ok ? '' : reply.error || 'Review policy could not be saved.', saved: Boolean(reply.ok) }),
      });
    },
  },
  h('h4', {}, 'Reviewers'),
  h('p', { class: 'hive-muted' }, 'Every review runs on the config whose provider differs from the builder’s; if neither differs it uses the primary and notes the same provider.'),
  ...slots.map(([slot, label]) => h('div', { class: 'hive-row' }, h('strong', {}, `${label} `), ...fields.map(([name, title]) => {
    const id = `hive-review-${cell.id}-${slot}-${name}`;
    return h('label', { for: id, class: 'hive-field' }, title, h('input', {
      id, type: 'text', maxlength: 120, required: true, value: draft[slot][name], disabled: draft.saving,
      'data-focus-key': `review-policy:${cell.id}:${slot}:${name}`,
      oninput: event => ui.patchForm(key, { [slot]: { ...ui.form(key)[slot], [name]: event.target.value }, saved: false }),
    }));
  }))),
  draft.error ? h('p', { class: 'hive-error', role: 'alert' }, draft.error) : null,
  draft.saved ? h('p', { role: 'status' }, 'Review policy saved.') : null,
  h('button', { type: 'submit', class: 'hive-btn', disabled: draft.saving }, draft.saving ? 'Saving…' : 'Save reviewers'));
}
