export const ACTOR_PREFIX = 'aw:';
export const HUMAN_ACTOR = 'aw:human';

export const HIVE_META = {
  kind: 'hive_kind',
  pickup: 'hive_pickup',
  nextAction: 'hive_next_action',
  waitingFor: 'hive_waiting_for',
  evidence: 'hive_evidence',
  outcome: 'hive_outcome',
  resume: 'hive_resume',
  op: 'hive_op',
  cell: 'hive_cell',
};

export const OPEN_STATUSES = ['open', 'in_progress', 'blocked', 'deferred'];
export const SETTABLE_STATUSES = ['open', 'in_progress', 'blocked', 'deferred'];
export const BLOCKING_EDGE_TYPES = new Set(['blocks', 'waits-for', 'conditional-blocks']);
export const LINK_TYPES = ['blocks', 'related', 'tracks', 'discovered-from', 'validates', 'supersedes'];
export const OUTCOMES = ['done', 'dropped', 'superseded', 'duplicate'];
export const GROUP_KINDS = new Set(['goal', 'workstream']);

const BEAD_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function isBeadId(value) {
  return typeof value === 'string' && BEAD_ID.test(value);
}

export function isSessionId(value) {
  return typeof value === 'string' && SESSION_ID.test(value);
}

export function actorFor(sessionId) {
  return sessionId ? `${ACTOR_PREFIX}${sessionId}` : HUMAN_ACTOR;
}

export function sessionFromAssignee(assignee) {
  if (typeof assignee !== 'string' || !assignee.startsWith(ACTOR_PREFIX)) return null;
  const sid = assignee.slice(ACTOR_PREFIX.length);
  return sid && sid !== 'human' ? sid : null;
}

export function issueTypeForKind(kind) {
  if (GROUP_KINDS.has(kind)) return 'epic';
  if (kind === 'decision') return 'decision';
  if (kind === 'fix') return 'bug';
  return 'task';
}

export function encodeMeta(value) {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

export function decodeMeta(value) {
  if (typeof value !== 'string') return value ?? null;
  const t = value.trim();
  if (!t.startsWith('[') && !t.startsWith('{')) return value;
  try {
    return JSON.parse(t);
  } catch {
    return value;
  }
}

function asObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string' && value.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

function text(value) {
  return typeof value === 'string' ? value : '';
}

function evidenceList(value) {
  const decoded = decodeMeta(value);
  if (!Array.isArray(decoded)) return [];
  return decoded.filter((e) => e && typeof e === 'object' && typeof e.label === 'string');
}

export function normalizeIssue(raw) {
  const metadata = asObject(raw.metadata);
  const deps = Array.isArray(raw.dependencies) ? raw.dependencies : [];
  const parent = deps.find((d) => d && d.type === 'parent-child' && d.issue_id === raw.id);
  const kind = decodeMeta(metadata[HIVE_META.kind]);
  const nextAction = decodeMeta(metadata[HIVE_META.nextAction]);
  const waitingFor = decodeMeta(metadata[HIVE_META.waitingFor]);
  const outcome = decodeMeta(metadata[HIVE_META.outcome]);
  const resume = asObject(decodeMeta(metadata[HIVE_META.resume]));
  const op = decodeMeta(metadata[HIVE_META.op]);
  return {
    id: raw.id,
    pickup: asObject(decodeMeta(metadata[HIVE_META.pickup])),
    parentId: parent ? parent.depends_on_id : null,
    title: text(raw.title),
    kind: typeof kind === 'string' && kind ? kind : (raw.issue_type === 'epic' ? 'workstream' : 'work'),
    issueType: raw.issue_type || 'task',
    status: raw.status || 'open',
    goal: text(raw.description),
    acceptance: text(raw.acceptance_criteria),
    summary: text(raw.notes),
    nextAction: typeof nextAction === 'string' ? nextAction : '',
    waitingFor: typeof waitingFor === 'string' ? waitingFor : '',
    evidence: evidenceList(metadata[HIVE_META.evidence]),
    outcome: typeof outcome === 'string' ? outcome : '',
    resume: (typeof resume.reviewAt === 'string' && resume.reviewAt) || (typeof resume.afterBead === 'string' && resume.afterBead)
      ? { ...(typeof resume.reviewAt === 'string' && resume.reviewAt ? { reviewAt: resume.reviewAt } : {}), ...(typeof resume.afterBead === 'string' && resume.afterBead ? { afterBead: resume.afterBead } : {}) } : null,
    closeReason: text(raw.close_reason),
    assignee: raw.assignee || null,
    ownerSessionId: sessionFromAssignee(raw.assignee),
    priority: Number.isInteger(raw.priority) ? raw.priority : null,
    labels: Array.isArray(raw.labels) ? raw.labels.filter((l) => typeof l === 'string') : [],
    isBlocked: Boolean(raw.is_blocked),
    createdAt: raw.created_at || null,
    createdBy: raw.created_by || null,
    updatedAt: raw.updated_at || null,
    closedAt: raw.closed_at || null,
    opId: typeof op === 'string' ? op : null,
    nativeMetadataKeys: Object.keys(metadata).filter((k) => !Object.values(HIVE_META).includes(k)),
  };
}

export function edgesOf(raw) {
  const deps = Array.isArray(raw.dependencies) ? raw.dependencies : [];
  return deps
    .filter((d) => d && d.type !== 'parent-child' && d.issue_id === raw.id && typeof d.depends_on_id === 'string')
    .map((d) => ({
      dependent: d.issue_id,
      prerequisite: d.depends_on_id,
      type: d.type || 'blocks',
      blocking: BLOCKING_EDGE_TYPES.has(d.type || 'blocks'),
      createdBy: d.created_by || null,
    }));
}

export function parseExport(stdout) {
  const issues = [];
  const errors = [];
  for (const [i, line] of stdout.split('\n').entries()) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let row;
    try {
      row = JSON.parse(trimmed);
    } catch (err) {
      errors.push(`line ${i + 1}: ${err.message}`);
      continue;
    }
    if (row && row._type !== undefined && row._type !== 'issue') continue;
    if (!row || typeof row.id !== 'string' || !isBeadId(row.id)) {
      errors.push(`line ${i + 1}: issue has no valid bead id`);
      continue;
    }
    issues.push(row);
  }
  return { issues, errors };
}

export function buildGraph(issues) {
  const beads = {};
  const edges = [];
  for (const raw of issues) {
    beads[raw.id] = normalizeIssue(raw);
    edges.push(...edgesOf(raw));
  }
  return { beads, edges };
}

export function openDescendants(beads, id) {
  return [...descendantIds(beads, id)].filter((d) => d !== id && beads[d] && beads[d].status !== 'closed');
}

export function descendantIds(beads, rootId) {
  const children = new Map();
  for (const b of Object.values(beads)) {
    if (!b.parentId) continue;
    if (!children.has(b.parentId)) children.set(b.parentId, []);
    children.get(b.parentId).push(b.id);
  }
  const out = new Set();
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop();
    if (out.has(id)) continue;
    out.add(id);
    for (const c of children.get(id) || []) stack.push(c);
  }
  return out;
}

export function rootOf(beads, beadId) {
  const seen = new Set();
  let cursor = beads[beadId];
  while (cursor && cursor.parentId && beads[cursor.parentId] && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    cursor = beads[cursor.parentId];
  }
  return cursor ? cursor.id : null;
}
