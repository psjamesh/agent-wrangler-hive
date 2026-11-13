import { h } from './dom.js';
import { sessionLabel, sessionsInTask } from './model.js';
import { launchFields, launchSummary, instructionsField } from './widgets.js';

const FORM = 'cell-dialog';
const LAUNCH_NEW = '__launch';
const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

let seq = 0;
const nextId = () => `d${Date.now().toString(36)}${(seq += 1)}`;

// `opener` is the focus key of the button that opened the dialog, kept apart
// from the mode so focus returns there whichever mode the dialog ends in.
export function openCellDialog(ui, mode, opener) {
  const cur = ui.form(FORM);
  ui.setForm(FORM, cur ? { ...cur, opener: cur.pending ? cur.opener : opener } : { id: nextId(), mode, opener, error: null, autoCompactTokens: 250000 });
}

function closeDialog(ui) {
  const opener = ui.form(FORM)?.opener;
  ui.setForm(FORM, null);
  if (opener) requestAnimationFrame(() => document.querySelector(`[data-focus-key="${CSS.escape(opener)}"]`)?.focus());
}

function firstLine(text) {
  const line = String(text || '').split('\n').find((l) => l.trim())?.trim() || '';
  return line.length > 90 ? `${line.slice(0, 89)}…` : line;
}

function disclosure({ id, label, open, summary, onToggle, body }) {
  return h('div', { class: `hive-disclosure${open ? ' is-open' : ''}` },
    h('button', { type: 'button', class: 'hive-disclosure-btn', 'aria-expanded': open ? 'true' : 'false', 'aria-controls': id, onclick: onToggle, 'data-focus-key': `${id}-toggle` },
      h('span', { class: 'hive-disclosure-mark', 'aria-hidden': 'true' }),
      h('span', { class: 'hive-disclosure-label' }, label),
      !open && summary ? h('span', { class: 'hive-disclosure-summary' }, summary) : null),
    open ? h('div', { class: 'hive-disclosure-body', id }, body) : null);
}

// New cell or existing task, in one dialog. Only what a cell needs is shown
// first; how the queen works and the launch details are opened on request.
export function cellDialog(ctx) {
  const { ui, send, busy, graph, hive, api } = ctx;
  const v = ui.form(FORM);
  if (!v) return null;
  const mode = v.mode === 'adopt' ? 'adopt' : 'new';
  const patch = (p) => ui.patchForm(FORM, p);
  const set = (p) => ui.setForm(FORM, { ...ui.form(FORM), ...p });
  const used = new Set(Object.values(hive.cells).map((c) => c.taskId));
  const tasks = (graph?.tasks?.tasks || []).filter((t) => !t.archivedAt && !t.archived && !used.has(t.id) && t.id !== 'adhoc');
  // The task is only ever the one the human picked. If it leaves the list
  // (archived, already a cell), the choice is cleared rather than moved to
  // another task.
  const taskGone = Boolean(v.taskId) && !tasks.some((t) => t.id === v.taskId);
  const taskId = taskGone ? '' : v.taskId || '';
  const members = taskId ? sessionsInTask(graph, taskId) : [];
  const launching = mode === 'new' || (Boolean(taskId) && v.queen === LAUNCH_NEW);
  const nominating = mode === 'adopt' && Boolean(taskId) && v.queen && v.queen !== LAUNCH_NEW && members.some((s) => s.sessionId === v.queen);
  const kind = mode === 'new' ? 'hive-cell-create' : 'hive-cell-adopt';
  // A create or adopt still in flight blocks another, even from a dialog
  // reopened after Cancel: the old request may yet create its task.
  const inFlight = () => busy('hive-cell-create') || busy('hive-cell-adopt');
  const working = Boolean(v.pending) || inFlight();
  const titleId = 'hive-dialog-title';
  const what = mode === 'new' ? 'New hive' : 'Add existing task';

  const fail = (text) => set({ error: text });
  // A reply belongs to the request that sent it. If the dialog was closed,
  // reopened or resubmitted since, the outcome becomes a notice and never
  // reopens, clears or redirects the newer dialog.
  const current = (reqId) => ui.form(FORM)?.pending === reqId;
  const submit = () => {
    const cur = ui.form(FORM) || {};
    if (cur.pending || inFlight()) return;
    const typed = cur.instructions?.trim() || '';
    const instructions = mode === 'new' ? typed : (typed || undefined);
    const queen = { agent: cur.agent, model: cur.model, effort: cur.effort, autoCompactTokens: cur.autoCompactTokens, cwd: cur.cwd };
    let msg;
    if (mode === 'new') {
      if (!cur.name?.trim()) return fail('Give the hive a name.');
      msg = { type: kind, name: cur.name, goal: cur.goal || '', acceptance: cur.acceptance || '', instructions, queen };
    } else {
      if (!taskId) return fail('Choose a task.');
      if (!launching && !nominating) return fail('Choose the queen: a session on this task, or launch a new one.');
      msg = {
        type: kind,
        taskId,
        goal: cur.goal || '',
        acceptance: cur.acceptance || '',
        instructions,
        queenSessionId: nominating ? cur.queen : null,
        queen: launching ? queen : null,
        sendBrief: cur.brief !== false,
      };
    }
    const reqId = nextId();
    set({ error: null, pending: reqId });
    send(msg, {
      onReply: (frame) => {
        const mine = current(reqId);
        if (!frame.ok) {
          const error = frame.error || (mode === 'new' ? 'Could not create the hive.' : 'Could not add the task.');
          if (mine) set({ error, pending: null });
          else ctx.notice(`${what} (closed earlier): ${error}`, { severity: 'error' });
          return;
        }
        if (!mine) {
          ctx.notice(`${what} (closed earlier) finished: the hive was added. Open it from All hives.`, { severity: 'info' });
          if (frame.rootError) ctx.notice(`Its goal was not created: ${frame.rootError}`, { severity: 'error' });
          if (frame.brief && frame.brief.state !== 'delivered') ctx.notice(`Its queen was nominated; the activation brief is ${frame.brief.state}${frame.brief.error ? `: ${frame.brief.error}` : ''}.`);
          if (frame.launchError) ctx.notice(`Its queen did not launch: ${frame.launchError}. Launch it again from the hive; the task is kept.`, { severity: 'error' });
          return;
        }
        ui.setForm(FORM, null);
        if (frame.rootError) ctx.notice(`The hive was added, but its goal was not created: ${frame.rootError}`, { severity: 'error' });
        if (frame.brief && frame.brief.state !== 'delivered') ctx.notice(`The queen was nominated; the activation brief is ${frame.brief.state}${frame.brief.error ? `: ${frame.brief.error}` : ''}.`);
        if (frame.launchError) ctx.notice(`The hive was added, but its queen did not launch: ${frame.launchError}. Launch it again from the hive; the task is kept.`, { severity: 'error' });
        if (mode === 'new') ui.openCell(frame.cellId);
        else {
          if (!frame.reenabled) ctx.notice('The task is now a hive, shown in All hives. Once its queen is active, it maps the existing work into beads and links its sessions.', { severity: 'info' });
          ui.highlightCell(frame.cellId);
        }
      },
    });
  };

  const field = (label, control, hint) => h('label', { class: 'hive-field' }, h('span', {}, label), control, hint ? h('small', { class: 'hive-muted' }, hint) : null);
  const queenRow = launching
    ? h('div', { class: 'hive-queen-summary' },
      h('span', { class: 'hive-fact-label' }, 'Queen'),
      h('span', {}, `Launches a new session: ${launchSummary(api, v)}`),
      h('button', { type: 'button', class: 'hive-link-btn', onclick: () => set({ more: true }) }, 'Change'))
    : null;

  const how = disclosure({
    id: 'hive-dialog-how',
    label: 'How the queen works',
    open: Boolean(v.how),
    summary: v.instructions?.trim() ? firstLine(v.instructions) : 'Optional instructions',
    onToggle: () => set({ how: !v.how }),
    body: instructionsField(v.instructions, (text) => patch({ instructions: text }), 'dialog-instructions'),
  });

  const moreBody = [
    mode === 'adopt' ? field('Goal', h('textarea', { rows: '2', value: v.goal || '', oninput: (e) => patch({ goal: e.target.value }), 'data-focus-key': 'dialog-goal' }), 'Optional. You can work the goal out with the queen later.') : null,
    field('Done when', h('textarea', { rows: '2', value: v.acceptance || '', oninput: (e) => patch({ acceptance: e.target.value }), 'data-focus-key': 'dialog-acceptance' })),
    launching ? h('div', { class: 'hive-dialog-grid' }, launchFields(api, v, (next) => set(next), (p) => patch(p))) : null,
  ];
  const more = disclosure({
    id: 'hive-dialog-more',
    label: 'More options',
    open: Boolean(v.more),
    summary: launching ? 'Done when, agent, model, effort, auto-compaction, folder' : (mode === 'adopt' ? 'Goal, done when' : 'Done when'),
    onToggle: () => set({ more: !v.more }),
    body: moreBody,
  });

  const body = mode === 'new'
    ? [
      field('Name', h('input', { type: 'text', required: true, maxlength: '200', value: v.name || '', oninput: (e) => patch({ name: e.target.value }), 'data-focus-key': 'dialog-name', 'data-autofocus': '' })),
      field('Goal', h('textarea', { rows: '2', value: v.goal || '', placeholder: 'Optional. The outcome you want; you can refine it with the queen.', oninput: (e) => patch({ goal: e.target.value }), 'data-focus-key': 'dialog-goal' })),
      queenRow,
      how,
      more,
    ]
    : [
      tasks.length
        ? field('Task', h('select', { onchange: (e) => set({ taskId: e.target.value, queen: '' }), 'data-focus-key': 'dialog-task', 'data-autofocus': '' },
          h('option', { value: '', selected: !taskId }, 'Choose a task…'),
          tasks.map((t) => h('option', { value: t.id, selected: t.id === taskId }, t.name))),
        taskGone ? 'The task you chose is no longer available. Choose a task and its queen again.' : null)
        : h('p', { class: 'hive-muted', 'data-autofocus': '', tabindex: '-1' }, 'Every task on the board is already a hive.'),
      tasks.length && taskId ? field('Queen', h('select', { onchange: (e) => set({ queen: e.target.value }), 'data-focus-key': 'dialog-queen' },
        h('option', { value: '' }, 'Choose…'),
        members.map((s) => h('option', { value: s.sessionId, selected: s.sessionId === v.queen }, sessionLabel(graph, s.sessionId))),
        h('option', { value: LAUNCH_NEW, selected: v.queen === LAUNCH_NEW }, 'Launch a new queen')),
      members.length ? 'Nominating keeps that session running with its own instructions; Hive\'s are added.' : 'No session is on this task yet, so launch a new queen.') : null,
      nominating ? h('label', { class: 'hive-check' }, h('input', { type: 'checkbox', checked: v.brief !== false, onchange: (e) => set({ brief: e.target.checked }), 'data-focus-key': 'dialog-brief' }), ' Send it an activation brief (it is not restarted)') : null,
      nominating ? h('p', { class: 'hive-muted hive-dialog-hint' }, 'It keeps its conversation and instructions. If its agent is already running, Hive\'s skills and tools may appear only after you restart or resume that agent\'s terminal; the hive will show an Open queen session link. This does not restart Agent Wrangler.') : null,
      queenRow,
      tasks.length ? how : null,
      tasks.length ? more : null,
    ];

  const dialog = h('form', {
    class: 'hive-dialog',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-labelledby': titleId,
    onsubmit: (e) => { e.preventDefault(); if (!working) submit(); },
    onkeydown: (e) => {
      if (e.key === 'Escape') { e.preventDefault(); closeDialog(ui); return; }
      if (e.key !== 'Tab') return;
      const items = [...e.currentTarget.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    },
  },
  h('header', { class: 'hive-dialog-head' },
    h('h2', { id: titleId }, mode === 'new' ? 'New hive' : 'Add an existing task'),
    h('div', { class: 'hive-segmented', role: 'group', 'aria-label': 'Kind of hive' },
      h('button', { type: 'button', 'aria-pressed': mode === 'new' ? 'true' : 'false', disabled: working, onclick: () => set({ mode: 'new', error: null }), 'data-focus-key': 'dialog-mode-new' }, 'New hive'),
      h('button', { type: 'button', 'aria-pressed': mode === 'adopt' ? 'true' : 'false', disabled: working, onclick: () => set({ mode: 'adopt', error: null }), 'data-focus-key': 'dialog-mode-adopt' }, 'Existing task'))),
  h('div', { class: 'hive-dialog-body', dataset: { scrollKey: 'cell-dialog' } },
    h('p', { class: 'hive-muted hive-dialog-lead' }, mode === 'new'
      ? 'Creates a task on the board and launches its queen. If the launch fails, the task is kept and you launch again from the hive.'
      : 'Turns a task already on the board into a hive, with a queen you choose. Once active, the queen maps the task\'s existing work into beads and links its sessions; existing sessions are not turned into beads automatically.'),
    body),
  !v.pending && inFlight() ? h('p', { class: 'hive-dialog-note', role: 'status' }, 'An earlier request is still running. You can submit once it finishes; its outcome appears as a notice.') : null,
  v.error ? h('p', { class: 'hive-dialog-error', role: 'alert' }, v.error) : null,
  h('footer', { class: 'hive-dialog-foot' },
    h('button', { type: 'button', class: 'hive-btn', onclick: () => closeDialog(ui), 'data-focus-key': 'dialog-cancel' }, 'Cancel'),
    h('button', { type: 'submit', class: 'hive-btn hive-btn-primary', disabled: working || (mode === 'adopt' && !tasks.length), 'data-focus-key': 'dialog-submit' },
      working ? (mode === 'new' ? 'Creating…' : 'Adding…') : (mode === 'new' ? 'Create hive' : 'Add task'))));

  return h('div', { class: 'hive-modal' }, dialog);
}
