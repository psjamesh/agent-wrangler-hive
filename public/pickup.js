import { h } from './dom.js';

const labels = { ready: 'Ready for pickup', queued: 'Ready for pickup · waiting', starting: 'Starting worker', attention: 'Pickup needs attention', consumed: 'Readiness consumed', unmarked: 'Automatic pickup' };

export function pickupDetails({ api, ui, send }, cell, bead) {
  const mark = bead.pickup || {};
  const key = `pickup:${bead.id}`;
  const agents = api?.agents?.() || [];
  let draft = ui.form(key);
  const editable = cell.enabled && !cell.snapshot && !cell.retired && bead.status !== 'closed' && !['goal', 'workstream', 'external', 'decision'].includes(bead.kind);
  if (!draft && editable) {
    const agent = agents.find(a => a.id === (mark.profile?.agent || 'claude')) || agents[0];
    const model = agent?.models?.find(m => m.value === mark.profile?.model) || agent?.models?.find(m => m.default) || agent?.models?.[0];
    draft = { agent: agent?.id || 'claude', model: model?.value || '', effort: model?.autoEffort || model?.efforts?.[0] || agent?.efforts?.[0]?.value || '', cwd: '', intent: '', ...mark.profile, auto: mark.profile?.worktree ? mark.profile.worktree.auto === true : true, reason: '' };
    ui.setForm(key, draft);
  }
  const sendMark = ready => {
    if (ui.form(key)?.saving) return;
    const current = ui.form(key);
    const profile = ready ? { agent: current.agent, model: current.model, effort: current.effort, cwd: current.cwd, intent: current.intent || undefined, ...(current.auto ? { worktree: { auto: true } } : {}) } : undefined;
    ui.patchForm(key, { saving: true, error: '' });
    send({ type: 'hive-bead-pickup', cellId: cell.id, beadId: bead.id, ready, ...(profile ? { profile } : {}), ...(ready && mark.armToken ? { rearm: true, expectedToken: mark.armToken, reason: current.reason } : {}) }, {
      onReply: reply => ui.patchForm(key, { saving: false, error: reply.ok ? '' : reply.error || 'Readiness could not be saved.' }),
    });
  };
  const field = (name, title, attributes = {}) => h('label', { class: 'hive-field' }, title, h('input', {
    name, value: draft[name], disabled: draft.saving, 'data-focus-key': `${key}:${name}`,
    oninput: e => ui.patchForm(key, { [name]: e.target.value }), ...attributes,
  }));
  const select = (name, title, options) => h('label', { class: 'hive-field' }, title, h('select', {
    name, value: draft[name], disabled: draft.saving, 'data-focus-key': `${key}:${name}`,
    onchange: e => {
      const patch = { [name]: e.target.value };
      if (name === 'agent') { const a = agents.find(a => a.id === patch.agent); const m = a?.models?.find(m => m.default) || a?.models?.[0]; Object.assign(patch, { model: m?.value || '', effort: m?.autoEffort || m?.efforts?.[0] || a?.efforts?.[0]?.value || '' }); }
      if (name === 'model') { const a = agents.find(a => a.id === draft.agent); const m = a?.models?.find(m => m.value === patch.model); patch.effort = m?.autoEffort || m?.efforts?.[0] || a?.efforts?.[0]?.value || ''; }
      ui.patchForm(key, patch);
    },
  }, options.map(o => h('option', { value: o.value, selected: o.value === draft[name] }, o.label || o.value))));
  const agent = agents.find(a => a.id === draft?.agent);
  const model = agent?.models?.find(m => m.value === draft?.model);
  const efforts = model?.efforts?.map(value => ({ value })) || agent?.efforts || [];
  return h('section', { class: 'hive-pickup', 'aria-label': 'Automatic pickup' },
    h('h4', {}, labels[mark.state] || 'Automatic pickup'),
    h('p', { role: 'status' }, mark.reason || 'The queen can mark this work ready for one automatic start.'),
    mark.armedBy ? h('p', { class: 'hive-muted' }, `Marked by ${mark.armedBy}`) : null,
    mark.profile ? h('p', { class: 'hive-muted' }, `${mark.profile.agent} · ${mark.profile.model} (${mark.profile.resolvedModel || 'unconfirmed'}) · ${mark.profile.effort || 'No effort control'} · ${mark.profile.cwd}${mark.profile.worktree ? ' · isolated worktree' : ' · shared folder'}`) : null,
    mark.launchId ? h('p', {}, 'Launch: ', h('code', {}, mark.launchId)) : null,
    editable ? h('details', {}, h('summary', {}, mark.armToken ? 'Change readiness…' : 'Mark ready for pickup…'),
      h('form', { class: 'hive-form', onsubmit: e => { e.preventDefault(); sendMark(true); } },
        h('p', { class: 'hive-muted' }, 'One worker start, subject to available work capacity and the start-rate guard. Restarts preserve readiness; failed starts need reconciliation and deliberate rearming.'),
        select('agent', 'Agent', agents.map(a => ({ value: a.id, label: a.label }))),
        select('model', 'Model', agent?.models || []),
        select('effort', 'Effort', efforts.length ? efforts : [{ value: '', label: 'No effort control' }]),
        draft.agent !== 'claude' ? h('p', { class: 'hive-warning' }, 'Spawn tools are unrestricted for this provider. Hive still claims and binds its worker before first action.') : null,
        field('cwd', 'Working folder', { required: true, placeholder: '/path/to/repository' }),
        h('label', {}, h('input', { type: 'checkbox', checked: draft.auto, disabled: draft.saving, onchange: e => ui.patchForm(key, { auto: e.target.checked }) }), 'Create an isolated worktree'),
        field('intent', 'Worker instructions (optional)'),
        mark.armToken ? field('reason', 'Reason for rearming', { required: true }) : null,
        draft.error ? h('p', { role: 'alert', class: 'hive-error' }, draft.error) : null,
        h('div', { class: 'hive-actions' }, h('button', { type: 'submit', class: 'hive-btn', disabled: draft.saving }, draft.saving ? 'Saving…' : mark.armToken ? 'Rearm once' : 'Mark ready once'),
          mark.armed ? h('button', { type: 'button', class: 'hive-btn', disabled: draft.saving, onclick: () => sendMark(false) }, 'Remove readiness') : null))) : null);
}
