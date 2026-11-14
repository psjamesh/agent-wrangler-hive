import { h } from './dom.js';

const choices = [['config', 'Use my Codex config'], ['approve-for-me', 'Approve for me'], ['on-request', 'Ask me'], ['never', 'Never ask']];

export function codexApprovalsForm({ ui, send }, cell) {
  const key = `codex-approvals:${cell.id}`;
  let draft = ui.form(key);
  if (!draft) {
    draft = { value: cell.codexApprovals || 'config' };
    ui.setForm(key, draft);
  }
  const id = `hive-codex-approvals-${cell.id}`;
  return h('form', {
    class: 'hive-form',
    onsubmit: event => {
      event.preventDefault();
      if (ui.form(key)?.saving) return;
      const value = ui.form(key).value;
      ui.patchForm(key, { saving: true, error: '', saved: false });
      send({ type: 'hive-codex-approvals', cellId: cell.id, value }, {
        onReply: reply => ui.patchForm(key, { saving: false, error: reply.ok ? '' : reply.error || 'Codex approvals could not be saved.', saved: Boolean(reply.ok) }),
      });
    },
  },
  h('label', { for: id }, 'Codex approvals'),
  h('select', {
    id, disabled: draft.saving, 'data-focus-key': key, 'aria-describedby': `${id}-help`,
    onchange: event => ui.patchForm(key, { value: event.target.value, saved: false }),
  }, ...choices.map(([value, label]) => h('option', { value, selected: draft.value === value }, label))),
  h('p', { id: `${id}-help`, class: 'hive-muted' }, 'Applies to this hive’s Codex queens, workers and reviewers on their next launch, resume or fork. Use my Codex config keeps Agent Wrangler and Codex defaults and allows a per-launch approval choice. Other choices take precedence over per-launch approvals.'),
  draft.error ? h('p', { class: 'hive-error', role: 'alert' }, draft.error) : null,
  draft.saved ? h('p', { role: 'status' }, 'Codex approvals saved.') : null,
  h('button', { type: 'submit', class: 'hive-btn', disabled: draft.saving }, draft.saving ? 'Saving…' : 'Save Codex approvals'));
}
