import { h } from './dom.js';

export function agentProfileFields({ agents, value, disabled, prefix, change }) {
  const installed = agents.filter(a => a.available === true);
  const agent = installed.find(a => a.id === value.agent);
  const model = agent?.models?.find(m => m.value === value.model);
  const effortOptions = model?.efforts?.map(value => ({ value })) || agent?.efforts || [];
  const effort = (a, m) => m?.autoEffort || m?.efforts?.[0] || a?.efforts?.[0]?.value || '';
  const select = (name, title, options) => h('label', { class: 'hive-field' }, title, h('select', {
    name, value: value[name], disabled, required: name !== 'effort', 'data-focus-key': `${prefix}:${name}`,
    onchange: e => {
      const patch = { [name]: e.target.value };
      if (name === 'agent') {
        const a = installed.find(a => a.id === patch.agent);
        const m = a?.models?.find(m => m.default) || a?.models?.[0];
        Object.assign(patch, { model: m?.value || '', effort: effort(a, m) });
      }
      if (name === 'model') patch.effort = effort(agent, agent?.models?.find(m => m.value === patch.model));
      change(patch);
    },
  }, !options.some(o => o.value === value[name]) ? h('option', { value: value[name] || '', selected: true, disabled: true }, value[name] ? `${value[name]} (unavailable)` : 'Choose…') : null,
  options.map(o => h('option', { value: o.value, selected: o.value === value[name] }, o.label || o.value))));
  return [select('agent', 'Agent', installed.map(a => ({ value: a.id, label: a.label }))),
    select('model', 'Model', agent?.models || []),
    select('effort', 'Effort', effortOptions.length ? effortOptions : [{ value: '', label: 'No effort control' }])];
}
