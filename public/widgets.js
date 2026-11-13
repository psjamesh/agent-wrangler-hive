import { confirmHive, promptHive } from './confirm-dialog.js';
import { h, relativeTime } from './dom.js';
import { taskName } from './model.js';

const STALE_PENDING_MS = 60000;

// Notices are Agent Wrangler toasts, which cannot be withdrawn when the
// condition clears, so an incomplete snapshot is the one state shown here.
export function noticesEl(ctx) {
  const snapshotError = ctx.hive?.backend?.snapshotError;
  if (!snapshotError) return null;
  return h('div', { class: 'hive-notices hive-warning', role: 'status', 'aria-live': 'polite' },
    `Some work could not be refreshed. Showing available work. ${snapshotError}`);
}

export function attentionEl(ctx, { cellId = null } = {}) {
  const { hive, send, graph } = ctx;
  const items = [];
  // Only an interrupted cell creation reaches the human: Hive and the cell's
  // agents settle every other unfinished write themselves.
  for (const op of hive.operations) {
    if (op.kind !== 'cell-create') continue;
    if (cellId && op.cellId !== cellId) continue;
    if (op.state === 'pending' && Date.now() - (op.updatedAt || 0) < STALE_PENDING_MS) continue;
    const actions = [];
    actions.push(h('button', {
      type: 'button',
      class: 'hive-btn',
      'data-focus-key': `resolve:${op.id}`,
      onclick: async () => {
        const note = await promptHive('Mark this operation resolved. What did you find? (Nothing is retried.)');
        if (note !== null && note !== undefined) send({ type: 'hive-op-resolve', opId: op.id, note });
      },
    }, 'Mark resolved…'));
    items.push(h('li', { class: 'hive-attention-item' },
      h('div', {}, h('strong', {}, 'New hive: task may exist'), ` · ${op.summary || op.kind}`,
        h('span', { class: 'hive-muted' }, ` · ${op.actor || ''} · ${relativeTime(op.updatedAt)}`)),
      op.error ? h('div', { class: 'hive-muted' }, op.error) : null,
      h('div', { class: 'hive-actions' }, actions)));
  }
  for (const l of hive.launches) {
    if (cellId && l.cellId !== cellId) continue;
    if (l.state === 'pending' && Date.now() - (l.updatedAt || 0) < STALE_PENDING_MS) continue;
    const actions = [];
    if (l.state === 'failed') {
      actions.push(h('button', { type: 'button', class: 'hive-btn', onclick: () => send({ type: 'hive-launch-reconcile', launchId: l.id, dismiss: true }) }, 'Dismiss'));
    } else {
      actions.push(h('button', { type: 'button', class: 'hive-btn', onclick: () => send({ type: 'hive-launch-reconcile', launchId: l.id }) }, 'Check the session'));
      actions.push(h('button', {
        type: 'button',
        class: 'hive-btn',
        'data-focus-key': `abandon:${l.id}`,
        onclick: async () => {
          if (await confirmHive('Abandon this launch? Do this only after checking the board: if the session is still starting, it may still become a queen-less session.')) {
            send({ type: 'hive-launch-reconcile', launchId: l.id, abandon: true });
          }
        },
      }, 'Abandon…'));
    }
    items.push(h('li', { class: 'hive-attention-item' },
      h('div', {}, h('strong', {}, l.state === 'failed' ? 'Queen launch failed' : l.state === 'bound' ? 'Queen launch in progress or unconfirmed' : 'Queen launch unconfirmed'), ` · ${taskName(graph, l.taskId)}`),
      l.error ? h('div', { class: 'hive-muted' }, l.error) : null,
      h('div', { class: 'hive-actions' }, actions)));
  }
  for (const cell of Object.values(hive.cells)) {
    if (cellId && cell.id !== cellId) continue;
    if (cell.rootBeadId || !cell.setup || cell.setup.state === 'ready') continue;
    if (cell.setup.state === 'pending') continue;
    items.push(h('li', { class: 'hive-attention-item' },
      h('div', {}, h('strong', {}, cell.setup.state === 'uncertain' ? 'Hive goal: outcome unknown' : 'Hive goal not created'), ` · ${taskName(graph, cell.taskId)}`),
      cell.setup.error ? h('div', { class: 'hive-muted' }, cell.setup.error) : null,
      h('div', { class: 'hive-actions' },
        cell.setup.state === 'failed'
          ? h('button', { type: 'button', class: 'hive-btn', onclick: () => send({ type: 'hive-cell-root-retry', cellId: cell.id }) }, 'Create the goal again')
          : h('button', { type: 'button', class: 'hive-btn', onclick: () => send({ type: 'hive-op-reconcile', opId: cell.setup.opId }) }, 'Check the store'))));
  }
  if (!items.length) return null;
  return h('section', { class: 'hive-attention', 'aria-label': 'Needs reconciliation' },
    h('h3', {}, 'To reconcile'),
    h('p', { class: 'hive-muted' }, 'These may or may not have happened. Hive never repeats them on its own.'),
    h('ul', {}, items));
}

function agentOptions(api) {
  try {
    const list = api?.agents?.();
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

// Agent Wrangler presets plus the default for new queens.
function compactPresets(agents, agentId) {
  const presets = agents.find((a) => a.id === agentId)?.controls?.autoCompact?.presets;
  return Array.isArray(presets) ? [...new Set([...presets, 250000].filter((t) => Number.isInteger(t) && t >= 50000 && t <= 1000000))].sort((a, b) => a - b) : [];
}

function formatTokens(tokens) {
  if (tokens % 1_000_000 === 0) return `${tokens / 1_000_000}m`;
  if (tokens % 1000 === 0) return `${tokens / 1000}k`;
  return tokens.toLocaleString('en-US');
}

// Agent, model, effort, auto-compaction threshold and folder for a queen
// launch. How the queen should work is the separate, saved Queen instructions
// field.
export const field = (label, control, hint) => h('label', { class: 'hive-field' }, h('span', {}, label), control, hint ? h('small', { class: 'hive-muted' }, hint) : null);

export const errorNote = (error) => error ? h('p', { class: 'hive-dialog-error', role: 'alert' }, error) : null;

export function launchFields(api, value, onChange, onPatch = onChange) {
  const agents = agentOptions(api);
  const agent = value.agent || agents[0]?.id || '';
  const models = agents.find((a) => a.id === agent)?.models || [];
  const efforts = agents.find((a) => a.id === agent)?.efforts || [];
  const presets = compactPresets(agents, agent);
  const compactChoices = Number.isInteger(value.autoCompactTokens) && !presets.includes(value.autoCompactTokens) ? [...presets, value.autoCompactTokens] : presets;
  const set = (k) => (e) => onChange({ [k]: e.target.value });
  const setAgent = (e) => {
    const next = e.target.value;
    const keep = compactPresets(agents, next).includes(value.autoCompactTokens);
    onChange({ agent: next, autoCompactTokens: keep ? value.autoCompactTokens : undefined });
  };
  const patch = (k) => (e) => onPatch({ [k]: e.target.value });
  return [
    agents.length ? field('Agent', h('select', { onchange: setAgent, 'data-focus-key': 'launch-agent' },
      agents.map((a) => h('option', { value: a.id, selected: a.id === agent }, a.label || a.id)))) : null,
    models.length ? field('Model', h('select', { onchange: set('model'), 'data-focus-key': 'launch-model' },
      h('option', { value: '' }, 'Default'), models.map((m) => h('option', { value: m.value, selected: m.value === value.model }, m.label || m.value)))) : null,
    efforts.length ? field('Effort', h('select', { onchange: set('effort'), 'data-focus-key': 'launch-effort' },
      h('option', { value: '' }, 'Default'), efforts.map((e) => {
        const v = typeof e === 'string' ? e : e.value;
        return h('option', { value: v, selected: v === value.effort }, typeof e === 'string' ? e : e.label || v);
      }))) : null,
    compactChoices.length ? field('Auto-compaction threshold', h('select', { onchange: (e) => onChange({ autoCompactTokens: e.target.value ? Number(e.target.value) : undefined }), 'data-focus-key': 'launch-auto-compact' },
      h('option', { value: '' }, 'Default'),
      compactChoices.map((t) => h('option', { value: String(t), selected: t === value.autoCompactTokens }, formatTokens(t))))) : null,
    field('Working folder', h('input', { type: 'text', value: value.cwd || '', placeholder: 'Default folder', oninput: patch('cwd'), 'data-focus-key': 'launch-cwd' })),
  ];
}

// One line describing what a launch with these settings will use.
export function launchSummary(api, value) {
  const agents = agentOptions(api);
  const a = agents.find((x) => x.id === (value.agent || agents[0]?.id)) || null;
  const model = a?.models?.find((m) => m.value === value.model);
  return [
    a ? a.label || a.id : 'default agent',
    model ? model.label || model.value : 'default model',
    value.effort ? `${value.effort} effort` : 'default effort',
    Number.isInteger(value.autoCompactTokens) ? `compacts at ${formatTokens(value.autoCompactTokens)}` : null,
    value.cwd?.trim() ? value.cwd.trim() : 'default folder',
  ].filter(Boolean).join(' · ');
}

export function instructionsField(value, onPatch, focusKey) {
  return h('label', { class: 'hive-field' },
    h('span', {}, 'Queen instructions'),
    h('textarea', {
      rows: '4',
      maxlength: '8000',
      value: value || '',
      placeholder: 'Optional. How the queen should work, e.g. "Use the mob-boss skill alongside hive-queen. Require mob-worker for delegated implementation."',
      oninput: (e) => onPatch(e.target.value),
      'data-focus-key': focusKey,
    }),
    h('small', { class: 'hive-muted' }, 'Saved with the hive and given to every queen of it, including a replacement. Guidance for the queen; Hive does not check it.'));
}
