import { prRepository, runGh } from './pr-labels.js';

export function checkState(rows) {
  if (!Array.isArray(rows) || !rows.length) return 'unknown';
  const states = rows.map(row => row?.state || (row?.status === 'COMPLETED' ? row.conclusion : row?.status));
  if (states.some(s => ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'STALE'].includes(s))) return 'failing';
  if (states.every(s => ['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(s))) return 'green';
  return 'pending';
}

export function createPrTracker({ gh = runGh, now = Date.now } = {}) {
  let stopped = false;
  let remoteRetryAt = 0;
  let remoteFailures = 0;
  let remoteError = null;
  const negatives = new Map();
  const delay = failures => Math.min(60000 * (2 ** Math.min(failures - 1, 4)), 900000);
  function defer(key, message) {
    const failures = Math.min((negatives.get(key)?.failures || 0) + 1, 5);
    negatives.delete(key);
    const entry = { failures, message, at: now(), retryAt: now() + delay(failures) };
    negatives.set(key, entry);
    if (negatives.size > 1000) negatives.delete(negatives.keys().next().value);
    return entry;
  }
  async function read(key, repo, args, parse, reportFailure = false) {
    const repoKey = `repo:${repo.toLowerCase()}`;
    if (stopped) return null;
    const blocked = now() < remoteRetryAt ? remoteError : [negatives.get(key), negatives.get(repoKey)].find(entry => now() < (entry?.retryAt || 0));
    if (blocked) return reportFailure ? { observationError: { message: blocked.message, at: blocked.at, retryAt: blocked.retryAt } } : null;
    try {
      const value = parse(JSON.parse(await gh(args)));
      negatives.delete(key);
      remoteFailures = 0;
      return value;
    } catch (err) {
      const message = String(err?.message || err?.stderr || 'GitHub refresh failed.').replace(/\s+/g, ' ').slice(0, 500);
      const failure = defer(key, message);
      if (/HTTP 403|forbidden|permission|not accessible|not permitted/i.test(`${err?.message || ''} ${err?.stderr || ''}`)) defer(repoKey, message);
      if (err?.code === 'ENOENT' || /not authenticated|not logged in|gh auth login|authentication|HTTP (?:401|429)|rate.?limit/i.test(`${err?.message || ''} ${err?.stderr || ''}`)) {
        remoteFailures = Math.min(remoteFailures + 1, 5);
        remoteRetryAt = now() + delay(remoteFailures);
        remoteError = { message, at: now(), retryAt: remoteRetryAt };
      }
      return reportFailure ? { observationError: { message, at: failure.at, retryAt: Math.max(failure.retryAt, remoteRetryAt) } } : null;
    }
  }
  return {
    stop() { stopped = true; },
    async search(repo) {
      if (!prRepository(`https://github.com/${repo}/pull/1`)) return [];
      return await read(`search:${repo.toLowerCase()}`, repo, ['search', 'prs', '--repo', repo, '--label', 'hive', '--limit', '1000', '--json', 'url'], rows => {
        if (!Array.isArray(rows)) throw new Error('Invalid PR search');
        return [...new Set(rows.map(row => row?.url).filter(url => prRepository(url)?.toLowerCase() === repo.toLowerCase()))];
      }) || [];
    },
    async state(prUrl) {
      if (!prRepository(prUrl)) return null;
      return read(`state:${prUrl}`, prRepository(prUrl), ['pr', 'view', prUrl, '--json', 'state,number,title,isDraft,headRefOid,reviewDecision,statusCheckRollup,mergeable,mergeStateStatus'], value => {
        if (!['OPEN', 'MERGED', 'CLOSED'].includes(value?.state)) throw new Error('Invalid PR state');
        return { state: value.state, checkedAt: now(), observationError: null, number: Number.isInteger(value.number) ? value.number : null, title: typeof value.title === 'string' ? value.title.slice(0, 500) : '', headSha: /^[a-f0-9]{40}$/i.test(value.headRefOid) ? value.headRefOid : null, isDraft: value.isDraft !== false, reviewDecision: value.reviewDecision || null, checks: checkState(value.statusCheckRollup), mergeable: value.mergeable || null, mergeStateStatus: value.mergeStateStatus || null };
      }, true);
    },
  };
}
