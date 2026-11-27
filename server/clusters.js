import { descendantIds } from './bead-model.js';

export const CANDIDATE_LIMIT = 15;

export function needsCluster(kind) {
  return kind !== 'workstream' && kind !== 'goal';
}

export function clusterAt(beads, rootId, fromId) {
  const seen = new Set();
  for (let p = fromId; p && p !== rootId && beads[p] && !seen.has(p); p = beads[p].parentId) {
    seen.add(p);
    if (beads[p].kind === 'workstream') return p;
  }
  return null;
}

export function closedClusterAt(beads, rootId, fromId) {
  const seen = new Set();
  for (let p = fromId; p && p !== rootId && beads[p] && !seen.has(p); p = beads[p].parentId) {
    seen.add(p);
    if (beads[p].kind === 'workstream' && beads[p].status === 'closed') return p;
  }
  return null;
}

export function orphanIds(beads, rootId) {
  if (!rootId || !beads[rootId]) return [];
  return [...descendantIds(beads, rootId)]
    .filter((id) => id !== rootId && beads[id] && needsCluster(beads[id].kind) && !clusterAt(beads, rootId, beads[id].parentId))
    .sort();
}

export function clusterCandidates(beads, rootId, hidden = new Set(), limit = CANDIDATE_LIMIT) {
  const all = rootId && beads[rootId]
    ? [...descendantIds(beads, rootId)].filter((id) => id !== rootId && beads[id]?.kind === 'workstream').map((id) => beads[id])
    : [];
  all.sort((a, b) => (a.status === 'closed') - (b.status === 'closed')
    || String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''))
    || a.id.localeCompare(b.id));
  const shown = all.slice(0, limit).map((b) => {
    const path = [];
    for (let p = b.parentId; p && p !== rootId && beads[p] && path.length < 10; p = beads[p].parentId) {
      if (beads[p].kind === 'workstream') path.unshift(beads[p].title || p);
    }
    return { bead_id: b.id, title: b.title, status: b.status, archived: hidden.has(b.id), path };
  });
  return { shown, more: all.length - shown.length };
}

const EXAMPLE = 'hive_create_beads({ beads: [{ ref: "c", kind: "workstream", title: "<outcome the group delivers>", goal: "...", acceptance: "..." }, { title: "...", parent: "c" }] })';

export function clusterRefusal(subject, { shown, more }, { queen = true } = {}) {
  const lines = [
    `${subject} must sit inside a cluster (a cell of kind workstream). Only clusters may sit directly under the hive goal. Nothing was changed.`,
    queen
      ? 'Name the cluster that shares its outcome as its parent (parent in hive_create_beads, parent_id in hive_update_bead), or create a cluster in the same call, for example:'
      : 'Name the cluster that shares its outcome as its parent, create a new cluster for it in the same call, or ask the queen which cluster it belongs to. For example:',
    EXAMPLE,
    'Filing under a closed cluster reopens it; only the queen or human can do that.',
  ];
  if (!shown.length) {
    lines.push('This hive has no clusters yet.');
  } else {
    lines.push('Candidate clusters (open first, most recently updated first):');
    for (const c of shown) {
      const state = [c.status === 'closed' ? 'closed' : 'open', ...(c.archived ? ['archived'] : [])].join(', ');
      lines.push(`- ${c.bead_id} "${c.title}" (${state})${c.path.length ? ` in ${c.path.join(' › ')}` : ''}`);
    }
    if (more > 0) lines.push(`…and ${more} more; read hive_context for the full list.`);
  }
  return lines.join('\n');
}

export function closedClusterRefusal(subject, clusterId, title) {
  return `${subject} would sit under closed cluster ${clusterId} "${title}", which reopens it. Only the queen or human can file work under a closed cluster; ask the queen with hive_request_input. Nothing was changed.`;
}
