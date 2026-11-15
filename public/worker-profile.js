import { h } from './dom.js';
import { agentProfileFields } from './agent-profile.js';

export function workerProfileForm({ api, ui, send }, cell) {
  const key = `worker-profile:${cell.id}`;
  let draft = ui.form(key);
  if (!draft) {
    draft = { agent: '', model: '', effort: '', cwd: '', ...cell.workerProfile, auto: cell.workerProfile ? Boolean(cell.workerProfile.worktree) : true };
    ui.patchForm(key, draft);
  }
  const change = patch => ui.patchForm(key, { ...patch, saved: false });
  const save = clear => {
    const current = ui.form(key);
    if (current.saving) return;
    const profile = clear ? null : { agent: current.agent, model: current.model, effort: current.effort, cwd: current.cwd,
      ...(current.intent ? { intent: current.intent } : {}), ...(current.auto ? { worktree: current.worktree || { auto: true } } : {}) };
    ui.patchForm(key, { saving: true, error: '', saved: false });
    send({ type: 'hive-worker-profile', cellId: cell.id, profile }, { onReply: reply => {
      ui.patchForm(key, { saving: false, saved: Boolean(reply.ok), error: reply.ok ? '' : reply.error || 'Worker profile could not be saved.',
        ...(reply.ok && clear ? { agent: '', model: '', effort: '', cwd: '', intent: '', worktree: undefined, auto: true } : {}) });
    } });
  };
  return h('form', { class: 'hive-form', 'aria-label': 'Default worker profile', onsubmit: e => { e.preventDefault(); save(false); } },
    h('h4', {}, 'Default worker'),
    h('p', { class: 'hive-muted' }, 'Scoped open work starts with this profile when prerequisites are complete and capacity is available. Hold work from its panel to keep it pending. Explicit readiness marks keep their own profiles. Starts are limited to one per hive and two overall per minute.'),
    ...agentProfileFields({ agents: api?.agents?.() || [], value: draft, disabled: draft.saving, prefix: key, change }),
    h('label', { class: 'hive-field' }, 'Working folder', h('input', { value: draft.cwd, required: true, maxlength: 2000, disabled: draft.saving,
      'data-focus-key': `${key}:cwd`, placeholder: '/path/to/repository', oninput: e => change({ cwd: e.target.value }) })),
    h('label', {}, h('input', { type: 'checkbox', checked: draft.auto, disabled: draft.saving, onchange: e => change({ auto: e.target.checked }) }), 'Create an isolated worktree'),
    h('label', { class: 'hive-field' }, 'Worker instructions (optional)', h('textarea', { value: draft.intent || '', maxlength: 12000, disabled: draft.saving,
      'data-focus-key': `${key}:intent`, oninput: e => change({ intent: e.target.value }) })),
    draft.error ? h('p', { role: 'alert' }, draft.error) : null,
    draft.saved ? h('p', { role: 'status' }, 'Default worker profile saved.') : null,
    h('div', { class: 'hive-actions' }, h('button', { type: 'submit', class: 'hive-btn', disabled: draft.saving }, draft.saving ? 'Saving…' : 'Save default worker'),
      h('button', { type: 'button', class: 'hive-quiet-btn', disabled: draft.saving, onclick: () => save(true) }, 'Clear default worker')));
}
