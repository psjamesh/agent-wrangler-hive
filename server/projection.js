import { capacity, occupiedWorkIds } from './admission.js';
import { needsHuman } from './requests.js';
import { waitingProjection } from './waiting.js';
import { slimBead } from './bead-detail.js';
import { layoutCell } from '../public/cell-layout.js';
import { stackable } from '../public/layout-base.js';
import { descendantIds } from './bead-model.js';
import { SUPPORTED_BD } from './beads.js';
import { archivedHere, archiveHidden, activeKids } from '../public/archive-layout.js';
import { humanConversationDoc, threadIndex, threadSummary, threadRecords, ownThreads, byRecent, inboxSlice, linkedTargets, THREAD_PAGE, INBOX_BACKLOG } from './conversation.js';

const THREAD_WINDOW = 40;
const OPERATION_WINDOW = 50;

function freeze(obj) {
  if (obj === null || typeof obj !== 'object' || Object.isFrozen(obj)) return obj;
  Object.freeze(obj);
  for (const v of Object.values(obj)) freeze(v);
  return obj;
}

export function cellBeadIds(beads, cell) {
  if (!cell?.rootBeadId || !beads[cell.rootBeadId]) return new Set();
  return descendantIds(beads, cell.rootBeadId);
}

// The newest topics, and every topic holding an unreceived message or one
// on the first page of an inbox, with the newest messages of each, every
// such message, the newest message each such topic still owes either side,
// the messages each one replies to or answers and the first
// page of each inbox. A hive that is turned off keeps its conversation and
// inbox here, so what is owed stays in reach. Older topics and messages are
// fetched on request. A topic's windowFrom is the oldest message of its
// unbroken newest run; older held messages sent along with it may sit apart
// from that run.
function projectConversation(doc, cellId) {
  doc = humanConversationDoc(doc, cellId);
  const list = doc.conversation[cellId] || [];
  const index = threadIndex(list);
  const records = threadRecords(doc, cellId);
  const human = inboxSlice(doc, cellId, 'human');
  const queen = inboxSlice(doc, cellId, 'queen');
  const requests = Object.fromEntries(Object.entries(doc.requests || {}).filter(([, r]) => r.cellId === cellId));
  const listed = new Set([...human.ids, ...queen.ids, ...Object.values(requests).filter(r => r.state === 'open' || needsHuman(r)).map(r => r.messageId)]);
  const open = new Set(list.filter((m) => (m.author === 'human' && !m.acknowledgedAt) || listed.has(m.id)).map((m) => m.threadId));
  const first = new Set([...listed, ...[...open].flatMap((id) => ['human', 'queen'].map((k) => index.get(id)?.awaiting[k]?.newest.id)).filter(Boolean)]);
  const held = (m) => (m.author === 'human' && !m.acknowledgedAt) || first.has(m.id);
  const quoted = new Set(list.filter((m) => first.has(m.id)).flatMap(linkedTargets));
  const all = ownThreads(records).sort(byRecent);
  const shown = all.filter((t, i) => i < THREAD_PAGE || open.has(t.id));
  const room = new Map(shown.map((t) => [t.id, THREAD_WINDOW]));
  const keep = new Set();
  const from = new Map();
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const m = list[i];
    const inRun = room.get(m.threadId) > 0;
    if (inRun) from.set(m.threadId, m.id);
    if (held(m) || quoted.has(m.id)) keep.add(i);
    else if (inRun) {
      room.set(m.threadId, room.get(m.threadId) - 1);
      keep.add(i);
    }
  }
  return {
    requests,
    conversationRevision: doc.conversationRevision,
    requestCounts: { human: Object.values(requests).filter(needsHuman).length, queen: 0 },
    threads: shown.map((t) => ({ ...threadSummary(t, index.get(t.id)), windowFrom: from.get(t.id) || null })),
    messages: list.filter((m, i) => keep.has(i)),
    threadsTruncated: shown.length < all.length,
    threadsAfter: all.length > THREAD_PAGE ? { id: all[THREAD_PAGE - 1].id, lastAt: all[THREAD_PAGE - 1].lastAt } : null,
    inbox: { human, queen, enabledAt: doc.inbox?.[cellId]?.enabledAt || null, backlog: human.count + queen.count > INBOX_BACKLOG },
  };
}

// What the browser half reads from the board graph. Built only when the
// snapshot or metadata changed; never runs bd.
export function projectForGraph({ runtime, snapshot }) {
  const doc = runtime.metadata.read();
  const { beads, edges } = snapshot.graph;
  const status = runtime.beads.status;
  const cells = {};
  const included = new Set();
  for (const cell of Object.values(doc.cells)) {
    const viewable = cell.enabled || Boolean(cell.retired);
    const ids = viewable ? cellBeadIds(beads, cell) : new Set();
    for (const id of ids) included.add(id);
    let geometry = null, layoutWarning;
    if (viewable && beads[cell.rootBeadId]) {
      const options = {
        kids: activeKids(beads, archiveHidden({ beads, rootId: cell.rootBeadId, archived: doc.archived })),
        rootId: cell.rootBeadId, saved: doc.beadLayout[cell.id] || {}, aspect: doc.arrangeAspect[cell.id],
        yieldIds: new Set(Object.values(beads).filter(stackable).map((b) => b.id)),
      };
      try {
        geometry = layoutCell(options);
      } catch (err) {
        layoutWarning = `Layout fallback for ${cell.id}: ${err.message}`;
        runtime.log?.(`hive: ${layoutWarning}`);
        geometry = layoutCell({ ...options, fallback: true });
      }
    }
    cells[cell.id] = {
      ...cell,
      beadCount: ids.size,
      ...waitingProjection(runtime, cell, ids),
      regionAttachments: geometry?.attachments || {},
      detachedWorkstreams: geometry?.detachedHeads || [],
      bindings: (doc.bindings[cell.id] || []).filter((b) => b.active),
      beadLayout: doc.beadLayout[cell.id] || {},
      ...(layoutWarning ? { layoutWarning } : {}),
      arrangeAspect: doc.arrangeAspect[cell.id] ?? null,
      workstreamColours: doc.workstreamColours?.[cell.id] || {},
      workstreamShades: doc.workstreamShades?.[cell.id] || {},
      archived: cell.rootBeadId ? archivedHere({ beads, rootId: cell.rootBeadId, archived: doc.archived }) : {},
      restoreNotices: Array.isArray(doc.restoreNotices[cell.id]) ? doc.restoreNotices[cell.id] : [],
      ...(viewable || !cell.snapshot ? projectConversation(doc, cell.id) : { threads: [], messages: [], threadsTruncated: false, threadsAfter: null, inbox: null }),
    };
  }
  const roots = new Set(Object.values(cells).map((c) => c.rootBeadId));
  const occupied = occupiedWorkIds(runtime, snapshot.graph);
  const visibleBeads = {};
  for (const id of included) visibleBeads[id] = { ...slimBead(runtime, snapshot.graph, id, { root: roots.has(id) }), occupiesCapacity: occupied.has(id) };
  const visibleEdges = edges.filter((e) => included.has(e.dependent) || included.has(e.prerequisite));
  // Only cell creation is the human's to settle (it can leave a task with no
  // cell). Every other unfinished write is settled by Hive or the cell's
  // agents and stays out of the work view; its record remains in the journal.
  const operations = Object.values(doc.operations)
    .filter((op) => op.kind === 'cell-create' && ['pending', 'uncertain', 'partial'].includes(op.state))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .slice(0, OPERATION_WINDOW);
  const launches = Object.values(doc.launches)
    .filter((l) => !['launched', 'dismissed', 'abandoned'].includes(l.state))
    .slice(-OPERATION_WINDOW);
  return freeze({
    backend: {
      state: status.state,
      version: status.version,
      executable: status.executable,
      detail: status.detail,
      checkedAt: status.checkedAt,
      supported: SUPPORTED_BD.label,
      workspaceDir: runtime.paths.beadsWorkspace,
      snapshotError: snapshot.error,
      snapshotComplete: Boolean(snapshot.loadedAt && !snapshot.error),
      snapshotBeadIds: snapshot.loadedAt && !snapshot.error ? Object.keys(beads) : null,
      loadedAt: snapshot.loadedAt,
    },
    metadataError: runtime.metadata.error,
    requestCount: Object.values(doc.requests || {}).filter(needsHuman).length,
    revision: snapshot.revision,
    metaVersion: runtime.metadata.version,
    metaEpoch: runtime.metadata.epoch,
    cells,
    capacity: capacity(runtime, snapshot.graph, { breakdown: true }),
    beads: visibleBeads,
    edges: visibleEdges,
    operations,
    launches,
  });
}
