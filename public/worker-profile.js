import { h } from './dom.js';
import { agentProfileFields } from './agent-profile.js';

export function workerProfileForm({ api, ui, send }, cell, workstream) {
  const key = `worker-profile:${cell.id}:${workstream.id}`;
  let draft = ui.form(key);
  if (!draft) {
    const profile = workstream.pickup?.workerProfile;
    draft = { agent: '', model: '', effort: '', cwd: '', ...profile, worktreeAuto: profile ? Boolean(profile.worktree) : true, auto: workstream.pickup?.auto === true, briefTemplate: workstream.pickup?.briefTemplate || '' };
    ui.patchForm(key, draft);
  }
  const change = patch => ui.patchForm(key, { ...patch, saved: false });
  const save = clear => {
    const current = ui.form(key);
    if (current.saving) return;
    const profile = clear ? null : { agent: current.agent, model: current.model, effort: current.effort, cwd: current.cwd,
      ...(current.intent ? { intent: current.intent } : {}), ...(current.worktreeAuto ? { worktree: current.worktree || { auto: true } } : {}) };
    ui.patchForm(key, { saving: true, error: '', saved: false });
    send({ type: 'hive-worker-profile', cellId: cell.id, beadId: workstream.id, profile, auto: current.auto, briefTemplate: current.briefTemplate }, { onReply: reply => {
      ui.patchForm(key, { saving: false, saved: Boolean(reply.ok), error: reply.ok ? '' : reply.error || 'Worker profile could not be saved.',
        ...(reply.ok && clear ? { agent: '', model: '', effort: '', cwd: '', intent: '', worktree: undefined, worktreeAuto: true } : {}) });
    } });
  };
  return h('form', { class: 'hive-form', 'aria-label': 'Workstream worker profile', onsubmit: e => { e.preventDefault(); save(false); } },
    h('h4', {}, `Default worker · ${workstream.title || workstream.id}`),
    h('p', { class: 'hive-muted' }, 'New scoped work inherits its nearest workstream profile. Existing unmarked work stays held unless this workstream is switched to auto. Explicit readiness marks keep their own profiles. Starts are limited to one per hive and two overall per minute.'),
    ...agentProfileFields({ agents: api?.agents?.() || [], value: draft, disabled: draft.saving, prefix: key, change }),
    h('label', { class: 'hive-field' }, 'Working folder', h('input', { value: draft.cwd, required: true, maxlength: 2000, disabled: draft.saving,
      'data-focus-key': `${key}:cwd`, placeholder: '/path/to/repository', oninput: e => change({ cwd: e.target.value }) })),
    h('label', {}, h('input', { type: 'checkbox', checked: draft.worktreeAuto, disabled: draft.saving, onchange: e => change({ worktreeAuto: e.target.checked }) }), 'Create an isolated worktree'),
    h('label', {}, h('input', { type: 'checkbox', checked: draft.auto, disabled: draft.saving, onchange: e => change({ auto: e.target.checked }) }), 'Auto: include existing unmarked work in this workstream'),
    h('label', { class: 'hive-field' }, 'Brief template', h('textarea', { value: draft.briefTemplate, maxlength: 12000, disabled: draft.saving, 'data-focus-key': `${key}:brief-template`,
      placeholder: 'Repository commands; commit identity; push and PR commands; review rounds; hand back with a merge wait, do not close.', oninput: e => change({ briefTemplate: e.target.value }) })),
    h('p', { class: 'hive-muted' }, 'Appended to each default worker’s instructions. Configure the repository checks, delivery commands and handoff contract here.'),
    h('label', { class: 'hive-field' }, 'Worker instructions (optional)', h('textarea', { value: draft.intent || '', maxlength: 12000, disabled: draft.saving,
      'data-focus-key': `${key}:intent`, oninput: e => change({ intent: e.target.value }) })),
    draft.error ? h('p', { role: 'alert' }, draft.error) : null,
    draft.saved ? h('p', { role: 'status' }, 'Default worker profile saved.') : null,
    h('div', { class: 'hive-actions' }, h('button', { type: 'submit', class: 'hive-btn', disabled: draft.saving }, draft.saving ? 'Saving…' : 'Save default worker'),
      h('button', { type: 'button', class: 'hive-quiet-btn', disabled: draft.saving, onclick: () => save(true) }, 'Clear default worker')));
}

export function workstreamProfileSettings(ctx, cell) {
  const { ui, hive } = ctx;
  const workstreams = Object.values(hive?.beads || {}).filter(b => b.kind === 'workstream' && b.status !== 'closed' && (() => {
    const seen = new Set();
    for (let node = b; node && !seen.has(node.id); node = hive.beads[node.parentId]) {
      if (node.id === cell.rootBeadId) return true;
      seen.add(node.id);
    }
    return false;
  })());
  const selectedId = ui.form('settings')?.workerWorkstreamId;
  const selected = workstreams.find(b => b.id === selectedId) || workstreams.find(b => b.id === ui.selectedBeadId?.()) || workstreams[0];
  const detail = selected && ui.beadDetail?.(selected);
  return h('section', { 'aria-label': 'Default worker' }, h('h4', {}, 'Default worker'),
    h('label', { class: 'hive-field' }, 'Workstream', h('select', { disabled: !workstreams.length || workstreams.some(b => ui.form(`worker-profile:${cell.id}:${b.id}`)?.saving), 'data-focus-key': 'worker-workstream',
      onchange: e => ui.patchForm('settings', { workerWorkstreamId: e.target.value }) },
    !workstreams.length ? h('option', { value: '' }, 'Create a workstream first') : workstreams.map(b => h('option', { value: b.id, selected: b.id === selected?.id }, b.title || b.id)))),
    detail?.bead ? workerProfileForm(ctx, cell, detail.bead) : selected ? h('p', { role: 'status' }, detail?.error || 'Loading workstream profile…') : null);
}
