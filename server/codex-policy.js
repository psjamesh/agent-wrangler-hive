import { participation } from './access.js';
import { HiveError, ensureWritable } from './ops.js';

const POLICIES = new Map([
  ['config', undefined],
  ['approve-for-me', { approveForMe: true }],
  ['on-request', { approval: 'on-request' }],
  ['never', { approval: 'never' }],
]);

export function codexPolicy({ sessionId, parentId, phase, ext: host }) {
  const rt = host?.stores?.hive;
  if (!rt || rt.metadata.error) return;
  let parts = participation(rt, host, sessionId);
  if (!parts.length && phase === 'fork') parts = participation(rt, host, parentId);
  if (parts.length !== 1) return;
  const policy = POLICIES.get(parts[0].cell.codexApprovals);
  return policy ? { ...policy } : undefined;
}

export function setCodexApprovals(rt, { cellId, value }) {
  ensureWritable(rt);
  const cell = rt.metadata.cell(cellId);
  if (!cell) throw new HiveError('Unknown hive.');
  if (cell.snapshot) throw new HiveError('This hive is a captured snapshot and is read only.');
  if (!POLICIES.has(value)) throw new HiveError('Choose Use my Codex config, Approve for me, Ask me or Never ask.');
  rt.metadata.mutate(d => { d.cells[cellId].codexApprovals = value; });
  return { cellId, value };
}
