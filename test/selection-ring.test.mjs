import test from 'node:test';
import assert from 'node:assert/strict';
import { hexTile } from '../public/hex-grid.js';
import { hiveTile } from '../public/hive-shape.js';

test('selection rings follow the outer rim on bead and overview tiles', () => {
  for (const tile of [hexTile(55.2), hiveTile(60)]) {
    assert.equal(tile.ring, tile.d);
  }
});

test('moving the selection ring preserves the content geometry', () => {
  const radius = 55.2;
  const tile = hexTile(radius);
  const contentRadius = radius * 0.945 - 1.5;
  assert.equal(tile.half(0), Math.sqrt(3) / 2 * contentRadius);
  assert.equal(tile.top, -contentRadius * 0.84);
  assert.equal(tile.bottom, contentRadius * 0.84);
  assert.equal(tile.markY(1), ((radius * 0.945 - 1) * (Math.sqrt(3) / 2) - 8.1 - 4) / (Math.sqrt(3) / 2));
});
