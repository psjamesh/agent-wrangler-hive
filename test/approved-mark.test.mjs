import test from 'node:test';
import assert from 'node:assert/strict';
import { beadTile, primaryKind, markWords, legend } from '../public/cell-view.js';
import { primaryMark } from '../public/hex-grid.js';
import { childrenMap } from '../public/model.js';

test('approved open and in-progress beads remain visible without a live owner', () => {
  for (const status of ['open', 'in_progress']) {
    const bead = { id: 'work', title: 'Release feature', kind: 'work', status, reviewState: 'approved' };
    const hive = { cells: { cell: {} }, beads: { work: bead }, edges: [] };
    const tile = beadTile({ hive, graph: { sessions: [] } }, bead, {
      cellId: 'cell', x: 0, y: 0, layout: { groupHeads: [], parentHead: {}, halo: {}, rootId: 'root' },
    }, childrenMap(hive.beads));
    assert.equal(tile.mark.kind, 'approved');
    for (const words of [tile.title, tile.ariaLabel, tile.mark.title, tile.marks[0].title]) assert.match(words, /Approved, awaiting release/);
    assert.equal(primaryKind(bead, ['prerequisite'], ['idle'], 0, 'idle'), 'approved');
    assert.equal(primaryKind(bead, [], ['working']), 'busy');
    assert.equal(primaryKind(bead, [], ['needs']), 'person');
    assert.equal(primaryKind(bead, [], [], 1), 'person');
  }
});

test('approval does not replace closed, blocked or deferred status marks', () => {
  for (const [status, outcome, expected] of [
    ['closed', 'done', 'done'], ['closed', 'dropped', 'closed'], ['closed', undefined, 'closed'],
    ['blocked', undefined, 'waiting'], ['deferred', undefined, 'deferred'],
  ]) assert.equal(primaryKind({ status, outcome, reviewState: 'approved' }, [], []), expected);
});

test('approved rocket is a plain glyph with a title and live and snapshot legend entries', t => {
  const previousDocument = globalThis.document; const previousNode = globalThis.Node;
  class Element {
    constructor(tag, text = '') { this.tag = tag; this.text = text; this.attrs = {}; this.children = []; this.dataset = {}; this.style = {}; }
    setAttribute(key, value) { this.attrs[key] = value; }
    append(child) { this.children.push(child); }
    addEventListener() {}
  }
  globalThis.Node = Element;
  globalThis.document = {
    createElement: tag => new Element(tag), createElementNS: (_, tag) => new Element(tag), createTextNode: text => new Element('#text', text),
  };
  t.after(() => { globalThis.document = previousDocument; globalThis.Node = previousNode; });
  const nodes = node => [node, ...node.children.flatMap(nodes)];
  const words = node => nodes(node).map(n => n.text).join(' ');
  const mark = primaryMark('approved', markWords('approved', {}));
  assert.ok(mark);
  assert.match(words(mark), /Approved, awaiting release/);
  assert.ok(nodes(mark).some(n => n.tag === 'path'));
  assert.ok(!nodes(mark).some(n => n.attrs.class === 'hive-pm-bg'));
  for (const snapshot of [false, true]) assert.match(words(legend(snapshot)), /Approved, awaiting release/i);
});
