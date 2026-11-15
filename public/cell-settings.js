import { h } from './dom.js';
import { cellName } from './model.js';

export function cellTitle({ graph, ui, send }, cell) {
  const name = cellName(graph, cell);
  const key = `rename:${cell.id}`;
  const focusKey = `rename-open:${cell.id}`;
  const focus = target => requestAnimationFrame(() => document.querySelector(`[data-focus-key="${target}"]`)?.focus());
  const draft = ui.form(key);
  if (cell.snapshot || cell.retired) return h('span', {}, name);
  if (!draft) return h('button', {
    type: 'button', class: 'hive-title-btn', title: 'Rename hive', 'aria-label': `Rename hive: ${name}`, 'data-focus-key': focusKey,
    onclick: () => { ui.setForm(key, { name }); focus(key); },
  }, name);
  const cancel = () => { if (!ui.form(key)?.saving) { ui.setForm(key, null); focus(focusKey); } };
  return h('form', {
    class: 'hive-title-edit', onsubmit: e => {
      e.preventDefault();
      const current = ui.form(key);
      if (current.saving) return;
      ui.patchForm(key, { saving: true, error: '' });
      send({ type: 'hive-cell-rename', cellId: cell.id, name: current.name }, { onReply: reply => {
        if (reply.ok) { ui.setForm(key, null); focus(focusKey); }
        else { ui.patchForm(key, { saving: false, error: reply.error || 'Could not rename hive.' }); focus(key); }
      } });
    },
    onkeydown: e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); } },
  }, h('input', {
    type: 'text', value: draft.name, required: true, maxlength: 200, disabled: draft.saving,
    'aria-label': 'Hive name', 'data-focus-key': key,
    oninput: e => ui.patchForm(key, { name: e.target.value }),
  }), h('button', { type: 'submit', class: 'hive-quiet-btn', disabled: draft.saving }, draft.saving ? 'Saving…' : 'Save'),
  h('button', { type: 'button', class: 'hive-quiet-btn', disabled: draft.saving, onclick: cancel }, 'Cancel'),
  draft.error ? h('span', { role: 'alert', class: 'hive-error' }, draft.error) : null);
}

export function cellGoalForm({ hive, ui, send }, cell) {
  const root = hive.beads[cell.rootBeadId];
  const key = `goal:${cell.id}`;
  const readOnly = Boolean(cell.snapshot || cell.retired || !root);
  let draft = ui.form(key);
  if (!draft) {
    draft = { goal: root?.goal || '', acceptance: root?.acceptance || '', expectedUpdatedAt: root?.updatedAt };
    ui.patchForm(key, draft);
  }
  return h('form', {
    class: 'hive-form hive-goal', onsubmit: event => {
      event.preventDefault();
      if (readOnly || ui.form(key)?.saving) return;
      const current = ui.form(key);
      ui.patchForm(key, { saving: true, error: '', saved: false });
      send({ type: 'hive-cell-goal', cellId: cell.id, goal: current.goal, acceptance: current.acceptance, expectedUpdatedAt: current.expectedUpdatedAt }, {
        onReply: reply => ui.patchForm(key, { saving: false, error: reply.ok ? '' : reply.error || 'Could not save goal.', saved: Boolean(reply.ok), ...(reply.ok ? { expectedUpdatedAt: reply.updatedAt } : {}) }),
      });
    },
  }, ...[['goal', 'Goal'], ['acceptance', 'Done when']].map(([field, label]) => h('label', { class: 'hive-field', for: `${key}:${field}` }, label,
    h('textarea', { id: `${key}:${field}`, rows: 4, maxlength: 20000, value: draft[field], disabled: readOnly || draft.saving,
      'data-focus-key': `${key}:${field}`, oninput: e => ui.patchForm(key, { [field]: e.target.value, saved: false }),
    }))),
  h('p', { class: 'hive-muted' }, 'Markdown supported. Edits are recorded as human input for the queen.'),
  draft.error ? h('p', { role: 'alert', class: 'hive-error' }, draft.error) : null,
  draft.saved ? h('p', { role: 'status' }, 'Goal and done when saved.') : null,
  readOnly ? null : h('button', { type: 'submit', class: 'hive-btn', disabled: draft.saving }, draft.saving ? 'Saving…' : 'Save goal and done when'));
}
