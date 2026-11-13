import { h } from './dom.js';

let sequence = 0;
let active = null;

function ask(message, { title = 'Please confirm', accept = 'Continue', input = false } = {}) {
  if (active) return Promise.resolve(input ? null : false);
  const opener = document.activeElement;
  const focusKey = opener?.dataset?.focusKey;
  const id = `hive-confirm-${++sequence}`;
  return new Promise(resolve => {
    const dialog = h('dialog', { class: 'hive-dialog hive-confirm', 'aria-labelledby': `${id}-title`, 'aria-describedby': `${id}-message` });
    const field = input ? h('textarea', { 'aria-labelledby': `${id}-message` }) : null;
    const finish = value => { dialog.returnValue = value; dialog.close(); };
    const cancel = h('button', { type: 'button', class: 'hive-quiet-btn', onclick: () => finish('cancel') }, 'Cancel');
    const submit = h('button', { type: 'button', class: 'hive-btn', onclick: () => finish('accept') }, accept);
    const controls = [field, cancel, submit].filter(Boolean);
    dialog.append(
      h('div', { class: 'hive-dialog-head' }, h('h2', { id: `${id}-title` }, title)),
      h('div', { class: 'hive-dialog-body' }, h('p', { id: `${id}-message`, class: 'hive-dialog-lead' }, message), field),
      h('div', { class: 'hive-dialog-foot' }, cancel, submit),
    );
    dialog.addEventListener('cancel', e => { e.preventDefault(); e.stopPropagation(); finish('cancel'); });
    dialog.addEventListener('keydown', e => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish('cancel'); }
      if (e.key !== 'Tab') return;
      e.preventDefault();
      const i = controls.indexOf(document.activeElement);
      controls[(i + (e.shiftKey ? -1 : 1) + controls.length) % controls.length].focus();
    });
    dialog.addEventListener('close', () => {
      active = null;
      dialog.remove();
      const target = opener?.isConnected ? opener : focusKey ? [...document.querySelectorAll('[data-focus-key]')].find(el => el.dataset.focusKey === focusKey) : null;
      target?.focus();
      resolve(dialog.returnValue === 'accept' ? (input ? field.value : true) : (input ? null : false));
    });
    active = dialog;
    document.body.append(dialog);
    dialog.showModal();
    (field || cancel).focus();
  });
}

export const confirmHive = (message, options) => ask(message, options);
export const promptHive = (message, options) => ask(message, { title: 'Add a note', accept: 'Save', ...options, input: true });

export function disposeConfirm() { active?.close(); }
