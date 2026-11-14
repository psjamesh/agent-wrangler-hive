import { h } from './dom.js';
import { eligibleHandoverSources } from './model.js';

export function handoverError(hive, value, taskId) {
  return value.handoverSourceSessionId && !eligibleHandoverSources(hive, taskId).some(s => s.sessionId === value.handoverSourceSessionId)
    ? 'The selected handover source is no longer eligible. Choose another source or clear it.' : null;
}

export function handoverFields(hive, value, set, taskId, replacing = false) {
  const source = value.handoverSourceSessionId || '';
  const sources = eligibleHandoverSources(hive, taskId);
  const missing = source && !sources.some(s => s.sessionId === source);
  return h('div', { class: 'hive-handover' },
    h('label', { class: 'hive-field' }, h('span', {}, 'Request a handover from'),
      h('select', { 'data-focus-key': 'handover-source', onchange: e => set({ handoverSourceSessionId: e.target.value, archiveSourceAfterHandover: true }) },
        h('option', { value: '', selected: !source }, 'No session selected'),
        missing ? h('option', { value: source, selected: true }, `${source.slice(0, 8)} (no longer eligible)`) : null,
        sources.map(s => h('option', { value: s.sessionId, selected: s.sessionId === source }, `${s.name} · ${s.taskName} · ${s.sessionId.slice(0, 8)}`)))),
    source ? h('label', { class: 'hive-check' },
      h('input', { type: 'checkbox', checked: value.archiveSourceAfterHandover !== false, 'data-focus-key': 'handover-archive', onchange: e => set({ archiveSourceAfterHandover: e.target.checked }) }), ' Archive source after handover') : null,
    h('p', { class: 'hive-muted hive-dialog-hint' }, source
      ? `The new queen asks this session by mail. ${value.archiveSourceAfterHandover === false ? 'The source stays active after handover.' : 'It archives the source after checking its handover and settling its work. Its children are kept.'}`
      : replacing ? 'A new queen is launched; it requests no handover and archives nobody. Existing claims remain for the new queen to inspect.'
        : 'Optional. With no source, the new queen requests no handover and archives nobody.'));
}
