import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HiveRuntime } from '../server/runtime.js';
import { collectWatchdog } from '../server/watchdog.js';
import { reviewFields, staleApproval } from '../server/review-state.js';
import { waitingProjection } from '../server/waiting.js';
import { slimBead } from '../server/bead-detail.js';
import { prState } from '../public/waiting-model.js';
import { primaryKind, markWords } from '../public/cell-view.js';

const URL = 'https://github.com/example/desktop/pull/4884';
const APPROVED = 'cb1535e' + '1'.repeat(33);
const MOVED = 'ec57ebb' + '2'.repeat(33);

function fixture(t, { headSha, reviewCommit = APPROVED.slice(0, 7), prState: state = 'OPEN' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-stale-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const rt = new HiveRuntime({ env: { AW_DATA_DIR: dir } });
  const now = 200000000;
  const host = { stores: { hive: rt }, sessions: { get: () => ({ status: 'idle' }) }, deliver: async () => ({ mode: 'live' }) };
  rt.metadata.lifetime.attach(rt, host);
  const beads = { root: { id: 'root', status: 'open', evidence: [] }, work: { id: 'work', parentId: 'root', status: 'in_progress', ownerSessionId: 'worker', updatedAt: now, evidence: [] } };
  rt.snapshots = { current: { loadedAt: now, error: null, graph: { beads, edges: [] } }, get graph() { return this.current.graph; } };
  rt.beads.status.state = 'ready';
  rt.metadata.mutate(d => {
    d.cells.cell = { id: 'cell', rootBeadId: 'root', enabled: true, queenSessionId: 'queen' };
    d.reviews.r = { id: 'r', cellId: 'cell', workBeadId: 'work', reviewerSessionId: 'reviewer', state: 'approved', commit: reviewCommit, verdict: { by: 'reviewer', value: 'approved', at: now - 1000 }, createdAt: now - 5000 };
    d.prLabels[URL] = { url: URL, state, headSha, stateCheckedAt: now, checks: 'green', isDraft: false, associations: [{ cellId: 'cell', beadId: 'work' }],
      humanAttention: headSha ? { state: 'ready', headSha, reason: 'Ready to merge', at: now } : null };
  });
  return { rt, host, now, cell: () => rt.metadata.cell('cell'), doc: () => rt.metadata.read() };
}

test('matching head keeps the approval current', t => {
  const f = fixture(t, { headSha: APPROVED });
  assert.equal(staleApproval(f.doc(), f.doc().reviews.r), null);
  const fields = reviewFields(f.rt, 'work');
  assert.equal(fields.reviewState, 'approved');
  assert.equal(fields.reviewStale, undefined);
  const [pr] = waitingProjection(f.rt, f.cell(), new Set(['work'])).pullRequests;
  assert.equal(pr.reviewStale, undefined);
  assert.equal(prState(pr, f.now), 'ready');
  assert.equal(primaryKind({ status: 'in_progress', ...fields }, [], []), 'approved');
  assert.ok(!collectWatchdog(f.rt, f.host, f.cell(), f.now).some(x => x.kind === 'stale_approval'));
});

test('moved head marks the approval stale everywhere and names both SHAs', t => {
  const f = fixture(t, { headSha: MOVED });
  const text = 'approved at cb1535e; head now ec57ebb, re-review needed';
  const fields = reviewFields(f.rt, 'work');
  assert.equal(fields.reviewState, 'stale');
  assert.deepEqual(fields.reviewStale, { url: URL, approved: 'cb1535e', head: MOVED, text });
  const slim = slimBead(f.rt, f.rt.snapshots.graph, 'work');
  assert.equal(slim.reviewState, 'stale');
  assert.equal(slim.reviewStale.text, text);
  const [pr] = waitingProjection(f.rt, f.cell(), new Set(['work'])).pullRequests;
  assert.equal(pr.reviewStale, text);
  assert.equal(prState(pr, f.now), 'working', 'a ready report on a moved head is not ready to ship');
  const bead = { status: 'in_progress', ...fields };
  assert.equal(primaryKind(bead, [], []), 'review-stale');
  assert.equal(markWords('review-stale', bead), `Approval stale: ${text}`);
  const flag = collectWatchdog(f.rt, f.host, f.cell(), f.now).find(x => x.kind === 'stale_approval');
  assert.ok(flag);
  assert.equal(flag.bead_id, 'work');
  assert.equal(flag.pr_url, URL);
  assert.equal(flag.review_id, 'r');
  assert.match(flag.reason, /approved at cb1535e; head now ec57ebb/);
});

test('unknown head makes no stale claim', t => {
  for (const options of [{ headSha: null }, { headSha: 'not-a-sha' }, { headSha: MOVED, prState: 'MERGED' }]) {
    const f = fixture(t, options);
    const fields = reviewFields(f.rt, 'work');
    assert.equal(fields.reviewState, 'approved', JSON.stringify(options));
    assert.equal(fields.reviewStale, undefined);
    assert.ok(!collectWatchdog(f.rt, f.host, f.cell(), f.now).some(x => x.kind === 'stale_approval'));
  }
});

test('a head observed before the verdict is treated as unknown', t => {
  const f = fixture(t, { headSha: MOVED });
  f.rt.metadata.mutate(d => { d.prLabels[URL].stateCheckedAt = f.now - 2000; });
  assert.equal(reviewFields(f.rt, 'work').reviewState, 'approved');
});
