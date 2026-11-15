import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { versionChanges } from './version-policy.js';

const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
const pr = event.pull_request;
if (!pr) throw new Error('Expected a pull_request event');
const readAt = (sha, file) => JSON.parse(execFileSync('git', ['show', `${sha}:${file}`], { encoding: 'utf8' }));
const mergeBase = execFileSync('git', ['merge-base', pr.base.sha, pr.head.sha], { encoding: 'utf8' }).trim();
const changes = versionChanges(
  readAt(mergeBase, 'package.json'), readAt(pr.head.sha, 'package.json'),
  readAt(mergeBase, 'package-lock.json'), readAt(pr.head.sha, 'package-lock.json'),
);
if (changes.length && !pr.labels.some(({ name }) => name === 'release')) {
  console.error(`Feature PRs must not change versions: ${changes.join(', ')}. Use a named release PR labelled release.`);
  process.exitCode = 1;
}
