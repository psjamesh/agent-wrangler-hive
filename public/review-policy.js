import { h } from './dom.js';

const defaults = { primary: { agent: 'claude', model: 'opus', effort: 'medium' }, secondary: { agent: 'codex', model: 'gpt-6.1-sol', effort: 'medium' } };
const slots = [['primary', 'Primary reviewer'], ['secondary', 'Secondary reviewer']];
const fields = [['agent', 'Agent'], ['model', 'Model'], ['effort', 'Effort']];

export function reviewPolicyForm({ ui, send, hive }, cell) {
  const key = `review-policy:${cell.id}`;
  let draft = ui.form(key);
  if (!draft) {
    draft = Object.fromEntries(slots.map(([slot]) => [slot, { ...defaults[slot], ...(cell.reviewPolicy?.[slot] || {}) }]));
    ui.setForm(key, draft);
  }
  const agents = hive?.agents || [];
  const catalogReady = Array.isArray(hive?.agents) && !hive?.agentsError;
  const reason = agent => agent.reason || 'CLI not installed or unavailable';
  const effortsFor = (agent, model) => model ? (model.efforts ?? (agent?.efforts || []).map(e => e.value)) : [];
  const defaultModel = agent => agent?.models?.find(m => m.default) || agent?.models?.[0];
  const defaultEffort = (agent, model) => {
    const values = effortsFor(agent, model);
    return values.includes(model?.autoEffort) ? model.autoEffort : values[0] || '';
  };
  const optionsFor = (value, name) => {
    const agent = agents.find(a => a.id === value.agent);
    const model = agent?.models?.find(m => m.value === value.model);
    if (name === 'agent') return agents.map(a => ({ value: a.id, label: `${a.label || a.id}${a.available === true ? '' : ` — unavailable: ${reason(a)}`}`, disabled: a.available !== true }));
    if (name === 'model') return (agent?.models || []).map(m => ({ value: m.value, label: `${m.label || m.value}${m.default ? ' (default)' : ''}` }));
    const values = effortsFor(agent, model);
    return values.length ? values.map(value => ({ value, label: agent.efforts?.find(e => e.value === value)?.label || value })) : model ? [{ value: '', label: 'No effort control' }] : [];
  };
  const invalid = (value, name) => !optionsFor(value, name).some(o => o.value === value[name] && !o.disabled);
  const canSave = current => catalogReady && slots.every(([slot]) => fields.every(([name]) => !invalid(current[slot], name)));
  return h('form', {
    class: 'hive-form hive-review-policy',
    onsubmit: event => {
      event.preventDefault();
      if (ui.form(key)?.saving || !canSave(ui.form(key))) return;
      const current = ui.form(key);
      const policy = Object.fromEntries(slots.map(([slot]) => [slot, { mode: 'pinned', ...Object.fromEntries(fields.map(([name]) => [name, String(current[slot][name] || '').trim()])) }]));
      ui.patchForm(key, { saving: true, error: '', saved: false });
      send({ type: 'hive-review-policy', cellId: cell.id, policy }, {
        onReply: reply => ui.patchForm(key, { saving: false, error: reply.ok ? '' : reply.error || 'Review policy could not be saved.', saved: Boolean(reply.ok) }),
      });
    },
  },
  h('h4', {}, 'Reviewers'),
  h('p', { class: 'hive-muted' }, 'Every review runs on the config whose provider differs from the builder’s; if neither differs it uses the primary and notes the same provider.'),
  ...slots.map(([slot, label]) => h('div', { class: 'hive-row' }, h('strong', {}, `${label} (Pinned) `),
    catalogReady && fields.some(([name]) => invalid(draft[slot], name)) ? h('p', { class: 'hive-error', role: 'status' }, 'Pinned model no longer available, using Automatic host defaults at launch. The saved pin is kept.') : null, ...fields.map(([name, title]) => {
    const id = `hive-review-${cell.id}-${slot}-${name}`;
    const value = draft[slot];
    const options = optionsFor(value, name);
    const stale = !options.some(o => o.value === value[name]);
    const flagged = catalogReady && invalid(value, name);
    return h('label', { for: id, class: 'hive-field' }, title, h('select', {
      id, disabled: draft.saving || !catalogReady,
      'aria-invalid': flagged ? 'true' : null,
      'data-focus-key': `review-policy:${cell.id}:${slot}:${name}`,
      onchange: event => {
        const next = { ...ui.form(key)[slot], [name]: event.target.value };
        const agent = agents.find(a => a.id === next.agent);
        if (name === 'agent') {
          const model = defaultModel(agent);
          next.model = model?.value || '';
          next.effort = defaultEffort(agent, model);
        } else if (name === 'model') {
          const model = agent?.models?.find(m => m.value === next.model);
          if (invalid(next, 'effort')) next.effort = defaultEffort(agent, model);
        }
        ui.patchForm(key, { [slot]: next, saved: false, error: '' });
      },
    }, stale ? h('option', { value: value[name], selected: true, disabled: true }, `${value[name] || '(empty)'} — ${catalogReady ? 'not installed' : 'catalogue unavailable'}`) : null,
    ...options.map(option => h('option', { value: option.value, selected: option.value === value[name], disabled: option.disabled }, option.label))),
    flagged ? h('span', { class: 'hive-error' }, stale ? `${title} not installed. Choose an installed value.` : 'Agent unavailable. Choose an available agent.') : null);
  }))),
  !catalogReady ? h('p', { class: 'hive-error', role: 'status' }, hive?.agentsError || 'Loading installed agents…') : null,
  draft.error ? h('p', { class: 'hive-error', role: 'alert' }, draft.error) : null,
  draft.saved ? h('p', { role: 'status' }, 'Review policy saved.') : null,
  h('button', { type: 'submit', class: 'hive-btn', disabled: draft.saving || !canSave(draft) }, draft.saving ? 'Saving…' : 'Save reviewers'));
}
