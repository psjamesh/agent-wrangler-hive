import assert from 'node:assert/strict';
import test from 'node:test';
import { hostApiAtLeast } from '../server/host-api.js';

for (const [version, minimum, supported] of [
  ['1.69.9', [1, 70], false],
  ['1.70.0', [1, 70], true],
  ['1.94.9', [1, 95], false],
  ['1.95.0', [1, 95], true],
  ['1.95.0+build.1', [1, 95], true],
  ['2.0.0', [1, 95], true],
  ['2.2.0', [1, 95], true],
  ['3.0.0', [1, 95], true],
  ['2.1.9', [2, 2], false],
  ['2.2.0', [2, 2, 1], false],
  ['2.2.1', [2, 2, 1], true],
  ['1.95.0-beta.1', [1, 95], false],
  ['2.2', [1, 95], false],
  ['invalid', [1, 95], false],
  [undefined, [1, 95], false],
]) test(`host API ${version} >= ${minimum.join('.')}: ${supported}`, () => {
  assert.equal(hostApiAtLeast({ version }, ...minimum), supported);
});
