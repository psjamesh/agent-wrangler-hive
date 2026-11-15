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
