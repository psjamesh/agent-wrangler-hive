import test from 'node:test';
import assert from 'node:assert/strict';
import { progressBar } from '../public/progress-bar.js';

class Element {
  constructor() { this.style = {}; this.attrs = {}; this.children = []; }
  setAttribute(key, value) { this.attrs[key] = value; }
  append(child) { this.children.push(child); }
}

test('small bars share a fill and clamp empty and over-limit ratios', t => {
  const previous = { document: globalThis.document, Node: globalThis.Node };
  globalThis.Node = Element;
  globalThis.document = { createElement: () => new Element() };
  t.after(() => Object.assign(globalThis, previous));
  for (const [used, total, width] of [[12, 20, '60%'], [5, 8, '63%'], [0, 0, '0%'], [9, 8, '100%']]) {
    const bar = progressBar(used, total);
    assert.equal(bar.attrs.class, 'hive-progress-inline');
    assert.equal(bar.attrs['aria-hidden'], 'true');
    assert.equal(bar.children[0].style.width, width);
  }
});
