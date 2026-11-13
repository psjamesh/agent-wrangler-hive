import { allSettings, settingsButton } from './settings-view.js';
import { h } from './dom.js';
import { noticesEl } from './widgets.js';

const STATE_TEXT = {
  unknown: 'Checking for Beads…',
  'missing-binary': 'Beads (bd) is not available to the server.',
  incompatible: 'This Beads version or store is not supported.',
  uninitialized: 'Beads is installed. Hive\'s private store has not been created yet.',
  damaged: 'Hive\'s store location is occupied by something Hive did not create.',
  error: 'The Beads store could not be opened.',
  ready: 'Ready.',
};

export function setupNeeded(hive) {
  return Boolean(hive.metadataError) || hive.backend.state !== 'ready';
}

export function renderSetup(ctx) {
  const { hive, send, busy } = ctx;
  const b = hive.backend;
  const rows = [
    ['Status', STATE_TEXT[b.state] || b.state],
    ['Detail', b.detail || ''],
    ['bd', b.executable ? `${b.executable}${b.version ? ` (${b.version})` : ''}` : 'not found'],
    ['Supported', `bd ${b.supported}, embedded Dolt`],
    ['Store', b.workspaceDir],
  ];
  const actions = [
    h('button', { type: 'button', class: 'hive-btn', disabled: busy('hive-setup-recheck'), onclick: () => send({ type: 'hive-setup-recheck' }) }, busy('hive-setup-recheck') ? 'Checking…' : 'Recheck'),
  ];
  if (b.state === 'uninitialized' && !hive.metadataError) {
    actions.push(h('button', {
      type: 'button',
      class: 'hive-btn hive-btn-primary',
      disabled: busy('hive-setup-init'),
      onclick: () => send({ type: 'hive-setup-init' }),
    }, busy('hive-setup-init') ? 'Creating…' : 'Create Hive store'));
  }
  return h('section', { class: 'hive-setup', 'aria-labelledby': 'hive-setup-title' },
    h('div', { class: 'hive-overhead' }, h('h2', { id: 'hive-setup-title' }, 'Set up Hive'), settingsButton(ctx), allSettings(ctx)),
    hive.metadataError ? h('p', { class: 'hive-error', role: 'alert' }, hive.metadataError) : null,
    h('dl', { class: 'hive-setup-facts' }, rows.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])),
    b.state === 'uninitialized'
      ? h('p', {}, 'Creating the store runs bd init in the folder above, outside any source repository, with agent-instruction files and git hooks turned off. bd makes that folder a private git repository of its own. No product repository is touched.')
      : null,
    b.state === 'missing-binary'
      ? h('div', { class: 'hive-help' },
        h('p', {}, 'Install Beads, then press Recheck. With Homebrew: '), h('code', {}, 'brew install beads'),
        h('p', {}, 'Other platforms: follow the Beads installation guide. If bd is installed somewhere the server cannot see, set its absolute path in Hive → Settings.'))
      : null,
    h('div', { class: 'hive-actions' }, actions),
    noticesEl(ctx),
    h('p', { class: 'hive-muted' }, 'Until the store is ready, Hive tools refuse to make changes. Existing Hive metadata is kept.'));
}
