import test from 'node:test';
import assert from 'node:assert/strict';
import * as ci from '../server/post-merge-ci.js';

const SHA = 'a'.repeat(40), NEXT = 'b'.repeat(40), NOW = 1800000000000;
const wait = (postMerge) => ({ url: 'https://github.com/example/repo/pull/7', headSha: SHA, target: 'post-merge', createdAt: NOW, deadline: NOW + 3600000, postMerge });
const run = (extra = {}) => ({ id: 1, workflow_id: 10, name: 'Build', head_sha: SHA, head_branch: 'main', status: 'completed', conclusion: 'success', created_at: new Date(NOW).toISOString(), html_url: 'https://github.com/example/repo/actions/runs/1', ...extra });
function github({ runs = [run()], suites = [], later = [], compare = 'ahead' } = {}) {
  return async args => {
    const path = args[1];
    if (path.endsWith('/pulls/7')) return JSON.stringify({ node_id: 'PR_7', head: { sha: SHA }, state: 'closed', merged: true, merge_commit_sha: SHA, base: { ref: 'main' }, merged_at: new Date(NOW).toISOString() });
    if (path.includes('/compare/')) return JSON.stringify({ status: compare, merge_base_commit: { sha: compare === 'ahead' ? SHA : NEXT } });
    if (path.includes('check-suites')) return JSON.stringify([{ check_suites: suites }]);
    if (path.includes('head_sha=')) return JSON.stringify([{ workflow_runs: runs }]);
    if (path.includes('/actions/runs?')) return JSON.stringify([{ workflow_runs: later }]);
    throw Error(path);
  };
}
async function observe(w, gh, time = NOW) { return { ...w, postMerge: await ci.observePostMerge(w, gh, time) }; }

for (const [conclusion, outcome] of [['success', 'passed'], ['failure', 'failed'], ['cancelled', 'cancelled']]) {
  test(`post-merge ${outcome} settles only after quiet period and retains run links`, async () => {
    const gh = github({ runs: [run({ conclusion })] });
    let w = await observe(wait(), gh);
    assert.equal(ci.evaluatePostMerge(w, NOW).outcome, undefined);
    w = await observe(w, gh, NOW + 150000);
    const result = ci.evaluatePostMerge(w, NOW + 150000);
    assert.equal(result.outcome, outcome);
    assert.match(result.detail, /Build.*https:\/\/github.com/);
  });
}
test('no-runs waits ten minutes and cannot pass on empty inventory', async () => {
  const gh = github({ runs: [] });
  let w = await observe(wait(), gh);
  assert.equal(ci.evaluatePostMerge(w, NOW + 1).outcome, undefined);
  w = await observe(w, gh, NOW + 600000);
  assert.equal(ci.evaluatePostMerge(w, NOW + 600000).outcome, 'no-runs');
});
test('workflow_run chains and reruns restart the quiet period', async () => {
  let w = await observe(wait(), github());
  w = await observe(w, github({ runs: [run(), run({ id: 2, name: 'Deploy', status: 'in_progress', conclusion: null })] }), NOW + 120000);
  assert.equal(ci.evaluatePostMerge(w, NOW + 120000).outcome, undefined);
  const gh = github({ runs: [run(), run({ id: 2, name: 'Deploy' })] });
  w = await observe(w, gh, NOW + 180000);
  w = await observe(w, gh, NOW + 330000);
  assert.equal(ci.evaluatePostMerge(w, NOW + 330000).outcome, 'passed');
  w = await observe(w, github({ runs: [run({ run_attempt: 2, status: 'queued', conclusion: null })] }), NOW + 340000);
  assert.equal(ci.evaluatePostMerge(w, NOW + 340000).outcome, undefined);
});
for (const conclusion of ['success', 'failure']) {
  test(`cancelled workflow follows containing successor to ${conclusion}`, async () => {
    const gh = github({ runs: [run({ conclusion: 'cancelled' })], later: [run({ id: 2, head_sha: NEXT, conclusion, created_at: new Date(NOW + 1000).toISOString() })] });
    let w = await observe(wait(), gh);
    w = await observe(w, gh, NOW + 150000);
    const result = ci.evaluatePostMerge(w, NOW + 150000);
    assert.equal(result.outcome, 'superseded');
    assert.match(result.detail, new RegExp(`superseded → ${conclusion === 'success' ? 'passed' : 'failed'} at ${NEXT}`));
    if (conclusion === 'failure') assert.match(result.detail, /different change/);
  });
}
test('unrelated or different-workflow runs never supersede cancelled merge CI', async () => {
  for (const options of [{ compare: 'diverged' }, { later: [run({ id: 2, workflow_id: 11, head_sha: NEXT })] }]) {
    const gh = github({ runs: [run({ conclusion: 'cancelled' })], later: [run({ id: 2, head_sha: NEXT })], ...options });
    let w = await observe(wait(), gh);
    w = await observe(w, gh, NOW + 150000);
    assert.equal(ci.evaluatePostMerge(w, NOW + 150000).outcome, 'cancelled');
  }
});
test('external suites participate and workflow-name narrowing selects only that workflow', async () => {
  const suite = { id: 5, head_sha: SHA, head_branch: 'main', status: 'completed', conclusion: 'failure', app: { name: 'External' }, url: 'https://api.github.com/suites/5' };
  const gh = github({ suites: [suite] });
  let w = await observe(wait(), gh);
  w = await observe(w, gh, NOW + 150000);
  assert.equal(ci.evaluatePostMerge(w, NOW + 150000).outcome, 'failed');
  w = await observe({ ...wait(), workflowName: 'Build' }, gh);
  w = await observe(w, gh, NOW + 150000);
  assert.equal(ci.evaluatePostMerge(w, NOW + 150000).outcome, 'passed');
});
test('stale or failed observations flag unavailable and never prove a terminal result', async () => {
  const w = await observe(wait(), github());
  assert.match(ci.evaluatePostMerge(w, NOW + 180001).unavailable, /stale/i);
  await assert.rejects(() => ci.observePostMerge(w, async () => { throw Error('access denied'); }, NOW + 60000), /access denied/);
});

test('truncated API inventory cannot establish completion', async () => {
  const gh = github();
  await assert.rejects(() => ci.observePostMerge(wait(), async args => {
    if (args[1].includes('head_sha=')) return JSON.stringify([{ total_count: 1001, workflow_runs: [run()] }]);
    return gh(args);
  }, NOW), /incomplete/i);
});

test('quiet period restarts after an observation gap and malformed CI remains unavailable', async () => {
  let w = await observe(wait(), github());
  w = await observe(w, github(), NOW + 600000);
  assert.equal(ci.evaluatePostMerge(w, NOW + 600000).outcome, undefined);
  await assert.rejects(() => ci.observePostMerge(wait(), github({ runs: [run({ workflow_id: null })] }), NOW), /identity/i);
});

test('latest containing workflow run is followed across repeated cancellations', async () => {
  const third = 'c'.repeat(40);
  const gh = github({ runs: [run({ conclusion: 'cancelled' })], later: [
    run({ id: 2, head_sha: NEXT, conclusion: 'cancelled', created_at: new Date(NOW + 1000).toISOString() }),
    run({ id: 3, head_sha: third, created_at: new Date(NOW + 2000).toISOString() }),
  ] });
  let w = await observe(wait(), gh);
  w = await observe(w, gh, NOW + 150000);
  const result = ci.evaluatePostMerge(w, NOW + 150000);
  assert.equal(result.outcome, 'superseded');
  assert.match(result.detail, new RegExp(third));
});

test('PR node identity stays pinned while waiting for merge without a ledger node', async () => {
  let w = await observe(wait(), async () => JSON.stringify({ node_id: 'PR_7', head: { sha: SHA }, merged: false, state: 'open' }));
  w = await observe(w, async () => JSON.stringify({ node_id: 'PR_other', head: { sha: SHA }, merged: false, state: 'open' }), NOW + 60000);
  assert.equal(ci.evaluatePostMerge(w, NOW + 60000).outcome, 'superseded');
});

test('a containing successor still counts when the cancelled original was a later rerun', async () => {
  const gh = github({ runs: [run({ conclusion: 'cancelled', created_at: new Date(NOW + 120000).toISOString() })], later: [run({ id: 2, head_sha: NEXT, created_at: new Date(NOW + 60000).toISOString() })] });
  let w = await observe(wait(), gh);
  w = await observe(w, gh, NOW + 150000);
  assert.equal(ci.evaluatePostMerge(w, NOW + 150000).outcome, 'superseded');
});
