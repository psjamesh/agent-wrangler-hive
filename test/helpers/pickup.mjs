import { buildGraph } from '../../server/bead-model.js';
import { RuntimeLifetime } from '../../server/lifetime.js';
import { workerBeforeDispatch, workerLaunchContext } from '../../server/workers.js';

export function pickupFixture(limit = 8) {
  let version = 0;
  let now = 100000;
  let doc = { cells: {}, bindings: {}, operations: {}, workerLaunches: {}, reviews: {}, launches: {}, pickupReceipts: {}, pickupAttempts: {}, pickupRates: {} };
  const raw = (id, parentId = null) => ({ id, title: id, description: `Build ${id}`, acceptance_criteria: `Verify ${id}`, status: 'open', updated_at: `v${++version}`, metadata: { hive_kind: parentId ? 'work' : 'goal' }, dependencies: parentId ? [{ issue_id: id, depends_on_id: parentId, type: 'parent-child' }] : [] });
  const live = { root: raw('root'), a: raw('a', 'root'), b: raw('b', 'root') };
  doc.cells.cell = { id: 'cell', taskId: 'task', rootBeadId: 'root', enabled: true, queenSessionId: 'queen', queenGeneration: 1, setup: { state: 'ready' } };
  const board = new Map([['queen', { sessionId: 'queen', taskId: 'task', status: 'idle' }]]);
  const catalog = [{ id: 'claude', available: true, models: [{ value: 'sonnet', resolved: 'claude-sonnet-fixed', efforts: ['medium'] }], efforts: [{ value: 'medium' }], capabilities: { disallowedTools: true } }];
  const graph = () => buildGraph(Object.values(live));
  const context = () => ({ issues: structuredClone(Object.values(live)), errors: [] });
  const bump = id => { live[id].updated_at = `v${++version}`; };
  const rt = {
    metadata: { lifetime: new RuntimeLifetime(), read: () => doc, cell: id => doc.cells[id], cells: () => Object.values(doc.cells), mutate: fn => { const next = structuredClone(doc); const r = fn(next); doc = next; return r; } },
    snapshots: { graph: graph(), current: { error: null, loadedAt: 1 }, hierarchyCurrent: true, refresh: async () => { rt.snapshots.graph = graph(); return rt.snapshots.current; }, invalidate() {} },
    settings: { get: () => limit }, pendingParticipants: new Map(), changed() {}, log() {},
    beads: {
      status: { state: 'ready' }, loadSnapshot: async () => graph(), show: async id => structuredClone(live[id]),
      update: async (id, patch, who, check) => {
        check?.(context());
        for (const [key, value] of Object.entries(patch)) {
          const native = { goal: 'description', acceptance: 'acceptance_criteria', summary: 'notes', nextAction: 'hive_next_action', waitingFor: 'hive_waiting_for', pickup: 'hive_pickup', kind: 'hive_kind', evidence: 'hive_evidence' }[key] || key;
          if (native.startsWith('hive_')) live[id].metadata[native] = value; else live[id][native] = value;
        }
        bump(id);
        return structuredClone(live[id]);
      },
      claim: async (id, who, check) => { check?.(context()); if (live[id].assignee && live[id].assignee !== who) throw new Error('claimed'); live[id].assignee = who; live[id].status = 'in_progress'; bump(id); return { already: false }; },
    },
  };
  const spawned = [], delivered = [];
  const host = { stores: { hive: rt }, settings: rt.settings, agents: { list: async () => structuredClone(catalog) }, tasks: { get: id => ({ id, taskId: id }), forSession: id => board.has(id) ? { taskId: board.get(id).taskId } : null }, sessions: { get: id => board.get(id), forTask: id => [...board.values()].filter(s => s.taskId === id) }, deliver: async (id, message) => { delivered.push({ id, message }); return { mode: 'live' }; } };
  host.sessions.spawn = async opts => {
    spawned.push(opts);
    const sid = `worker-${spawned.length}`;
    board.set(sid, { sessionId: sid, taskId: opts.taskId, status: 'working' });
    workerBeforeDispatch({ sessionId: sid, ext: opts.ext.hive, host });
    const out = await workerLaunchContext({ sid, task: { id: opts.taskId }, ext: opts.ext.hive, reason: 'spawn', host });
    if (out?.refuse) throw new Error(out.refuse);
    return { sessionId: sid };
  };
  rt.host = host;
  rt.metadata.lifetime.attach(rt, host);
  const actor = (id = 'queen', role = 'queen') => ({ sessionId: id, role, cell: doc.cells.cell, cells: [{ cell: doc.cells.cell, role }] });
  const profile = { agent: 'claude', model: 'sonnet', effort: 'medium', cwd: '/tmp/fake-repo', worktree: { auto: true }, intent: 'Use the mob-worker skill.' };
  return { rt, host, live, board, catalog, spawned, delivered, actor, profile, doc: () => doc, bump, graph, now: () => now, advance: ms => { now += ms; }, setLimit: n => { limit = n; } };
}
