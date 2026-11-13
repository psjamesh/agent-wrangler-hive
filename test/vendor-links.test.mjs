import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const vendor = path.join(root, 'public', 'vendor');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

const links = fs.existsSync(vendor) ? fs.readdirSync(vendor, { withFileTypes: true }) : [];

test('public/vendor holds only symlinks into node_modules', () => {
  for (const e of links) {
    assert.ok(e.isSymbolicLink(), `public/vendor/${e.name} must be a symlink, not a copied file`);
    const target = path.resolve(vendor, fs.readlinkSync(path.join(vendor, e.name)));
    assert.ok(target.startsWith(path.join(root, 'node_modules') + path.sep), `public/vendor/${e.name} must point into node_modules`);
  }
});

test('every vendored package is a runtime dependency and the link resolves', () => {
  for (const e of links) {
    const target = path.resolve(vendor, fs.readlinkSync(path.join(vendor, e.name)));
    const rel = path.relative(path.join(root, 'node_modules'), target).split(path.sep);
    const name = rel[0].startsWith('@') ? `${rel[0]}/${rel[1]}` : rel[0];
    assert.ok(pkg.dependencies?.[name], `${name} must be in dependencies (the host installs with --omit=dev)`);
    assert.ok(fs.existsSync(target), `${target} is missing; run npm ci`);
  }
});
