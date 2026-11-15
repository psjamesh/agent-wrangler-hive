import { test } from 'node:test';
import assert from 'node:assert/strict';
import { versionChanges } from '../scripts/version-policy.js';

const pkg = { version: '1.0.0' };
const lock = { version: '1.0.0', packages: { '': { version: '1.0.0' }, 'node_modules/example': { version: '1.0.0' } } };

test('feature dependency updates do not require a release', () => {
  const updated = structuredClone(lock);
  updated.packages['node_modules/example'].version = '2.0.0';
  assert.deepEqual(versionChanges(pkg, pkg, lock, updated), []);
});

test('detects each release version field, including removal', () => {
  assert.deepEqual(versionChanges(pkg, {}, lock, lock), ['package.json version']);
  assert.deepEqual(versionChanges(pkg, pkg, lock, { ...lock, version: '2.0.0' }), ['package-lock.json version']);
  const updated = structuredClone(lock);
  delete updated.packages[''].version;
  assert.deepEqual(versionChanges(pkg, pkg, lock, updated), ['package-lock.json packages[""] version']);
});

test('PR guard ignores a release merged after the feature branched and enforces labels', async (t) => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join, resolve } = await import('node:path');
  const { execFileSync, spawnSync } = await import('node:child_process');
  const dir = mkdtempSync(join(tmpdir(), 'hive-version-policy-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '--quiet');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
  const writeVersions = (version) => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ version }));
    writeFileSync(join(dir, 'package-lock.json'), JSON.stringify({ version, packages: { '': { version } } }));
  };
  const commit = () => {
    git('add', '.');
    git('commit', '--quiet', '-m', 'fixture');
    return git('rev-parse', 'HEAD');
  };
  writeVersions('1.0.0');
  const ancestor = commit();
  writeVersions('2.0.0');
  const base = commit();
  git('checkout', '--quiet', '--detach', ancestor);
  writeFileSync(join(dir, 'feature.txt'), 'feature');
  const feature = commit();
  const run = (head, labels = []) => {
    const eventPath = join(dir, 'event.json');
    writeFileSync(eventPath, JSON.stringify({ pull_request: { base: { sha: base }, head: { sha: head }, labels } }));
    return spawnSync(process.execPath, [resolve('scripts/check-release-version.js')], {
      cwd: dir, encoding: 'utf8', env: { ...process.env, GITHUB_EVENT_PATH: eventPath },
    });
  };
  const unchanged = run(feature);
  assert.equal(unchanged.status, 0, unchanged.stderr);
  writeVersions('3.0.0');
  const release = commit();
  const rejected = run(release);
  assert.equal(rejected.status, 1, rejected.stderr);
  assert.match(rejected.stderr, /Feature PRs must not change versions/);
  const allowed = run(release, [{ name: 'release' }]);
  assert.equal(allowed.status, 0, allowed.stderr);
});
