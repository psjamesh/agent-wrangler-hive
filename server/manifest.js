import { onArchive } from './archived-claims.js';
import { workerLaunchContext } from './workers.js';
import { WORK_LIMIT_SETTING } from './admission.js';
import { HiveRuntime, BD_PATH_SETTING } from './runtime.js';
import { setupHandlers, configHandlers } from './handlers.js';
import { workTools } from './tools.js';
import { participation } from './access.js';
import { onBeforeDispatch, prepareSession } from './sessions.js';

export const HIVE_ID = 'hive';
export const SKILLS = ['hive-queen', 'hive-worker'];
const REFRESH_EVERY_MS = 60000;

function rolesFor(host, sessionId) {
  const rt = host?.stores?.hive;
  if (!rt) return [];
  return participation(rt, host, sessionId).map((p) => p.role);
}

// Role instructions only for sessions in an enabled cell; Hive's own skills
// only. Native requests steer participants to the Hive queue.
export function skillsFor({ sessionId, host }) {
  const roles = rolesFor(host, sessionId);
  if (!roles.length) return [];
  const keep = [];
  if (roles.includes('queen') || roles.includes('coordinator')) keep.push('hive-queen');
  if (roles.some((r) => r !== 'queen')) keep.push('hive-worker');
  return keep;
}

export function hideTool({ host, caller, tool }) {
  if (tool === 'request_human_input') return rolesFor(host, caller).length > 0 && !host.stores.hive.metadata.error;
  if (['hive_list_my_requests', 'hive_withdraw_request'].includes(tool) && Object.values(host?.stores?.hive?.metadata.read().requests || {}).some(r => r.requesterSessionId === caller)) return false;
  if (typeof tool !== 'string' || !tool.startsWith('hive_')) return false;
  return rolesFor(host, caller).length === 0;
}

export function createManifest({ dir }) {
  return {
    id: HIVE_ID,
    dir,
    label: 'Hive',
    description: 'Opt tasks into Hive cells: a nominated queen and its workers keep a Beads work graph that the human can steer from a hexagonal view.',
    help: 'Adds a Hive view to the rail. Each opted-in task is a cell with a nominated queen; the cell\'s durable work lives in a private Beads store under the wrangler data directory, maintained through hive_* tools. Turning Hive off removes the view and tools; the store and Hive metadata are kept.',
    author: 'Agent Wrangler Hive contributors',
    defaultEnabled: false,
    engines: { wranglerApi: '^1.71.0' },
    requires: ['tasks:read', 'tasks:write', 'sessions:read', 'sessions:spawn', 'sessions:archive', 'deliver', 'board:rebuild', 'links:read'],
    settings: [{
      key: BD_PATH_SETTING,
      hidden: true,
      type: 'text',
      label: 'bd executable',
      help: 'Absolute path to the Beads bd binary. Leave empty to search the server PATH and common install locations.',
      placeholder: '/opt/homebrew/bin/bd',
      maxLength: 1024,
    }, {
      key: WORK_LIMIT_SETTING,
      hidden: true,
      type: 'number',
      label: 'Maximum active workers',
      placeholder: '8',
      help: 'Counts claimed beads, open reviews and launching workers across all hives. A review shares its work bead slot. Default: 8. Set 0 for Unlimited. Lowering the limit keeps current work and prevents new claims until there is room.',
      min: 0,
      step: 1,
    }, {
      key: 'requestNotifications',
      hidden: true,
      type: 'toggle',
      label: 'Pop up when a Hive request needs you',
      help: 'Shows a card anywhere in Agent Wrangler when a queen forwards you a request or your answer could not be delivered. Requests always appear in the Hive conversation either way.',
    }, {
      key: 'beeLevel',
      type: 'number',
      label: 'Number of bees',
      help: 'How many bees fly across the honeycomb, from 0 (None) through 2 (About right) to 4 (Frankly too many bees). Shown as a slider in Hive → Settings.',
      min: 0,
      max: 4,
      step: 1,
      hidden: true,
    }, {
      key: 'showBees',
      type: 'toggle',
      label: 'Show bees',
      help: 'Read by Hive 0.1.9 and earlier, and kept in step with Number of bees: off when it is None.',
      hidden: true,
    }],
    stores: { hive: ({ settings, log } = {}) => new HiveRuntime({ settings, log }) },
    activate({ host }) {
      host.stores.hive.attach(host);
    },
    deactivate({ host }) {
      host.stores.hive.detach();
    },
    handlers: [...setupHandlers, ...configHandlers],
    tools: [...workTools],
    skills: SKILLS,
    skillsFor,
    hideTool,
    session: { onBeforeDispatch, onArchive },
    hooks: { 'session.prepare': prepareSession, 'session.launchContext': workerLaunchContext },
    graph: ({ host }) => ({ hive: host.stores.hive.projection() }),
    sweeps: [{
      id: 'refresh',
      everyMs: REFRESH_EVERY_MS,
      run: async ({ host }) => {
        const rt = host.stores.hive;
        rt.snapshots.maybeRefresh();
        await rt.recover();
        await rt.watchdog?.run();
      },
    }, {
      id: 'pr-labels',
      everyMs: REFRESH_EVERY_MS,
      run: ({ host }) => host.stores.hive.prLabels?.run(),
    }],
    client: 'public/client.js',
    styles: 'public/styles.css',
  };
}
