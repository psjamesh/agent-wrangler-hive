import { prRepository } from './pr-labels.js';

const SHA = /^[a-f0-9]{40}$/i;
const FRESH_MS = 180000;
const QUIET_MS = 150000;
const NO_RUNS_MS = 600000;
const stamp = value => Date.parse(value) || 0;
const passed = new Set(['success', 'neutral', 'skipped']);
const failed = new Set(['failure', 'timed_out', 'action_required', 'startup_failure', 'stale']);

async function pages(gh, path, field) {
  const rows = [];
  for (let page = 1; page <= 40; page++) {
    const data = JSON.parse(await gh(['api', `${path}${path.includes('?') ? '&' : '?'}per_page=25&page=${page}`]));
    if (!Array.isArray(data?.[field]) || data.total_count > 1000) throw Error('Incomplete GitHub CI inventory.');
    rows.push(...data[field]);
    if (data[field].length < 25 || rows.length >= data.total_count) {
      if (data.total_count > rows.length) throw Error('Incomplete GitHub CI inventory.');
      return rows;
    }
  }
  throw Error('Incomplete GitHub CI inventory.');
}

function row(value, kind) {
  if (!value?.id || !SHA.test(value.head_sha || '') || !value.status || (kind === 'run' && (!value.workflow_id || !value.name))) throw Error('GitHub CI identity is unavailable.');
  return {
    id: `${kind}:${value.id}`, workflowId: value.workflow_id || null, name: value.name || value.app?.name || 'Check suite',
    sha: value.head_sha.toLowerCase(), status: value.status, conclusion: value.conclusion || null,
    attempt: value.run_attempt || 1, url: value.html_url || value.url, createdAt: stamp(value.created_at),
  };
}

export async function observePostMerge(wait, gh, now = Date.now()) {
  const repo = prRepository(wait.url);
  if (!repo) throw Error('Invalid post-merge PR URL.');
  const previous = wait.postMerge;
  let identity = previous?.mergeSha ? previous : null;
  if (!identity) {
    const pr = JSON.parse(await gh(['api', `repos/${repo}/pulls/${wait.url.split('/').at(-1)}`]));
    if (!pr.node_id || !SHA.test(pr.head?.sha || '')) throw Error('GitHub PR identity is unavailable.');
    const nodeId = wait.nodeId || previous?.nodeId;
    if ((nodeId && nodeId !== pr.node_id) || pr.head.sha.toLowerCase() !== wait.headSha) return { fetchedAt: now, outcome: 'superseded', detail: 'Expected PR head or identity changed before merge.' };
    if (!pr.merged) return { fetchedAt: now, nodeId: pr.node_id, outcome: pr.state === 'closed' ? 'cancelled' : null, runs: [] };
    if (!SHA.test(pr.merge_commit_sha || '') || !pr.base?.ref || !stamp(pr.merged_at)) throw Error('GitHub merge identity is unavailable.');
    identity = { mergeSha: pr.merge_commit_sha.toLowerCase(), branch: pr.base.ref, mergedAt: stamp(pr.merged_at), nodeId: pr.node_id };
  }
  const branch = encodeURIComponent(identity.branch);
  const [rawRuns, rawSuites] = await Promise.all([
    pages(gh, `repos/${repo}/actions/runs?branch=${branch}&head_sha=${identity.mergeSha}`, 'workflow_runs'),
    wait.workflowName ? [] : pages(gh, `repos/${repo}/commits/${identity.mergeSha}/check-suites`, 'check_suites'),
  ]);
  const onBranch = run => run.head_branch === identity.branch && run.head_repository?.full_name?.toLowerCase() === repo.toLowerCase() && !['pull_request', 'pull_request_target', 'merge_group'].includes(run.event);
  const matching = rawRuns.filter(run => run.head_sha?.toLowerCase() === identity.mergeSha && onBranch(run) && (!wait.workflowName || run.name === wait.workflowName));
  const suiteIds = new Set(matching.map(run => run.check_suite_id));
  const runs = matching.map(run => row(run, 'run'));
  runs.push(...rawSuites.filter(suite => suite.head_sha?.toLowerCase() === identity.mergeSha && (!suite.head_branch || suite.head_branch === identity.branch) && !suiteIds.has(suite.id) && !(suite.status !== 'completed' && suite.latest_check_runs_count === 0)).map(suite => row(suite, 'suite')));
  const cancelled = runs.filter(run => run.workflowId && run.conclusion === 'cancelled');
  const successors = {};
  if (cancelled.length) {
    const readHead = async () => {
      const value = JSON.parse(await gh(['api', `repos/${repo}/branches/${branch}`]));
      if (!SHA.test(value.commit?.sha || '')) throw Error('GitHub base-branch identity is unavailable.');
      return value.commit.sha.toLowerCase();
    };
    const branchHead = await readHead();
    const ancestry = new Map();
    const workflows = new Map();
    for (const original of cancelled) {
      if (!workflows.has(original.workflowId)) workflows.set(original.workflowId, await pages(gh, `repos/${repo}/actions/workflows/${original.workflowId}/runs?branch=${branch}&created=${encodeURIComponent('>=' + new Date(identity.mergedAt).toISOString())}`, 'workflow_runs'));
      const candidates = workflows.get(original.workflowId).filter(run => run.workflow_id === original.workflowId && onBranch(run) && SHA.test(run.head_sha || '') && run.head_sha.toLowerCase() !== identity.mergeSha && stamp(run.created_at) >= identity.mergedAt)
        .sort((a, b) => stamp(b.created_at) - stamp(a.created_at) || b.id - a.id);
      for (const candidate of candidates) {
        const sha = candidate.head_sha.toLowerCase();
        if (!ancestry.has(sha)) {
          const comparison = JSON.parse(await gh(['api', `repos/${repo}/compare/${identity.mergeSha}...${sha}`]));
          if (!['ahead', 'behind', 'identical', 'diverged'].includes(comparison.status) || !SHA.test(comparison.merge_base_commit?.sha || '')) throw Error('GitHub ancestry evidence is unavailable.');
          let contains = comparison.status === 'ahead' && comparison.merge_base_commit.sha.toLowerCase() === identity.mergeSha;
          if (contains) {
            const reachable = JSON.parse(await gh(['api', `repos/${repo}/compare/${sha}...${branchHead}`]));
            if (!['ahead', 'behind', 'identical', 'diverged'].includes(reachable.status) || !SHA.test(reachable.merge_base_commit?.sha || '')) throw Error('GitHub base-branch reachability is unavailable.');
            contains = ['ahead', 'identical'].includes(reachable.status) && reachable.merge_base_commit.sha.toLowerCase() === sha;
          }
          ancestry.set(sha, contains);
        }
        if (ancestry.get(sha)) { successors[original.id] = row(candidate, 'run'); break; }
      }
    }
    if (await readHead() !== branchHead) throw Error('GitHub base branch changed during successor discovery.');
  }
  const selected = runs.map(run => successors[run.id] || run).sort((a, b) => a.id.localeCompare(b.id));
  const inventory = JSON.stringify({ runs: selected, originals: runs.map(run => run.id).sort() });
  const continuous = previous?.fetchedAt && now - previous.fetchedAt <= FRESH_MS && !previous.error;
  return {
    mergeSha: identity.mergeSha, branch: identity.branch, mergedAt: identity.mergedAt, nodeId: identity.nodeId,
    fetchedAt: now, runs: selected, superseded: Object.keys(successors).length > 0, inventory,
    quietSince: continuous && previous.inventory === inventory ? previous.quietSince : now,
  };
}

export function evaluatePostMerge(wait, now = Date.now()) {
  const observed = wait.postMerge;
  if (!observed?.fetchedAt) return { unavailable: 'No post-merge CI observation. Restore Hive GitHub polling.' };
  if (observed.error) return { unavailable: 'Hive could not refresh post-merge CI. Restore GitHub access.' };
  if (now - observed.fetchedAt > FRESH_MS) return { unavailable: 'Post-merge CI observation is stale. Restore Hive GitHub polling.' };
  if (observed.outcome) return { outcome: observed.outcome, detail: observed.detail };
  if (!observed.mergeSha) return {};
  if (!observed.runs.length) return now - observed.mergedAt >= NO_RUNS_MS ? { outcome: 'no-runs', detail: `No selected CI runs or suites started for ${observed.mergeSha} on ${observed.branch} within ten minutes.` } : {};
  if (observed.runs.some(run => run.status !== 'completed' || (!passed.has(run.conclusion) && !failed.has(run.conclusion) && run.conclusion !== 'cancelled'))) return {};
  if (now - observed.quietSince < QUIET_MS) return {};
  const result = observed.runs.some(run => failed.has(run.conclusion)) ? 'failed' : observed.runs.some(run => run.conclusion === 'cancelled') ? 'cancelled' : 'passed';
  const links = observed.runs.map(run => `${run.name} at ${run.sha}: ${run.conclusion} ${run.url}`).join('; ');
  const shas = [...new Set(observed.runs.filter(run => run.sha !== observed.mergeSha).map(run => run.sha))];
  const replacements = observed.runs.filter(run => run.sha !== observed.mergeSha);
  const laterFailure = replacements.some(run => failed.has(run.conclusion));
  const successorResult = laterFailure ? 'failed' : replacements.some(run => run.conclusion === 'cancelled') ? 'cancelled' : 'passed';
  return {
    outcome: observed.superseded ? 'superseded' : result,
    detail: `${observed.superseded ? `superseded → ${successorResult} at ${shas.join(', ')}. Overall pipeline: ${result}. ${laterFailure ? 'A later failure may come from a different change. ' : ''}` : `${result} at ${observed.mergeSha}. `}${links}`,
  };
}
