import { execFile } from 'node:child_process';

const PR_URL = /^https:\/\/github\.com\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_.-]+)\/pull\/[1-9]\d*$/;

export function prRepository(prUrl) {
  const match = PR_URL.exec(prUrl);
  return match ? `${match[1]}/${match[2]}` : null;
}

export function runGh(args) {
  return new Promise((resolve, reject) => {
    const child = execFile('gh', args, { timeout: 15000, maxBuffer: 2 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
    child.stdin.on('error', () => {});
    child.stdin.end();
  });
}

export function createPrLabeler({ gh = runGh, now = Date.now } = {}) {
  let stopped = false;
  let remoteFailures = 0;
  let remoteRetryAt = 0;
  const negatives = new Map();
  const repoNegatives = new Map();
  const createdRepos = new Map();
  const creations = new Map();
  const inFlight = new Set();
  const delay = (failures) => Math.min(60000 * (2 ** Math.min(failures - 1, 4)), 900000);
  function defer(cache, key) {
    const failures = Math.min((cache.get(key)?.failures || 0) + 1, 5);
    cache.delete(key);
    cache.set(key, { failures, retryAt: now() + delay(failures) });
    if (cache.size > 1000) cache.delete(cache.keys().next().value);
  }
  async function view(prUrl) {
    const value = JSON.parse(await gh(['pr', 'view', prUrl, '--json', 'labels']));
    if (!Array.isArray(value.labels)) throw new Error('Invalid PR labels');
    return { labelled: value.labels.some(label => label?.name?.toLowerCase() === 'hive') };
  }
  async function createLabel(repo) {
    const key = repo.toLowerCase();
    if (now() < (createdRepos.get(key) || 0)) return;
    if (!creations.has(key)) {
      creations.set(key, (async () => {
        try {
          await gh(['label', 'create', 'hive', '--repo', repo, '--description', 'Made with Hive', '--color', 'E0A82E']);
        } catch (err) {
          if (!/already exists/i.test(`${err?.message || ''} ${err?.stderr || ''}`)) throw err;
        }
        createdRepos.delete(key);
        createdRepos.set(key, now() + 60000);
        if (createdRepos.size > 1000) createdRepos.delete(createdRepos.keys().next().value);
      })());
    }
    try { await creations.get(key); } finally { creations.delete(key); }
  }
  return {
    stop() { stopped = true; },
    async apply(prUrl, eligible = () => false) {
      const repo = prRepository(prUrl);
      const repoKey = repo?.toLowerCase();
      if (!repo || stopped || inFlight.has(prUrl) || now() < remoteRetryAt
        || now() < (negatives.get(prUrl)?.retryAt || 0) || now() < (repoNegatives.get(repoKey)?.retryAt || 0)) return;
      inFlight.add(prUrl);
      try {
        if (!eligible()) return;
        let current = await view(prUrl);
        if (current.labelled) { negatives.delete(prUrl); return 'present'; }
        if (stopped || !eligible()) return;
        try {
          await gh(['pr', 'edit', prUrl, '--add-label', 'hive']);
        } catch (err) {
          const message = `${err?.message || ''} ${err?.stderr || ''}`;
          if (!/label.*(?:not found|does not exist)/i.test(message) || now() < (createdRepos.get(repoKey) || 0)) throw err;
          if (stopped || !eligible()) return;
          try { await createLabel(repo); } catch (creationError) { defer(repoNegatives, repoKey); throw creationError; }
          if (stopped || !eligible()) return;
          current = await view(prUrl);
          if (!current.labelled && !stopped && eligible()) await gh(['pr', 'edit', prUrl, '--add-label', 'hive']);
          else if (!current.labelled) return;
        }
        negatives.delete(prUrl);
        repoNegatives.delete(repoKey);
        remoteFailures = 0;
        return 'labelled';
      } catch (err) {
        defer(negatives, prUrl);
        const message = `${err?.message || ''} ${err?.stderr || ''}`;
        if (/HTTP 403|forbidden|permission|not accessible|not permitted|write access/i.test(message)
          && now() >= (repoNegatives.get(repoKey)?.retryAt || 0)) defer(repoNegatives, repoKey);
        if (err?.code === 'ENOENT' || /not authenticated|not logged in|gh auth login|authentication|HTTP (?:401|429)|rate.?limit/i.test(message)) {
          remoteFailures = Math.min(remoteFailures + 1, 5);
          remoteRetryAt = now() + delay(remoteFailures);
        }
      } finally {
        inFlight.delete(prUrl);
      }
    },
  };
}
