import test from 'node:test';
import assert from 'node:assert/strict';
import { markdown } from '../public/dom.js';
import client, { createUi } from '../public/client.js';
import { renderConversation } from '../public/conversation.js';
import { renderHexMap } from '../public/hex-grid.js';

class Node {
  constructor(tag, text = '') { this.tagName = tag?.toUpperCase(); this.nodeType = tag ? 1 : 3; this.data = text; this.childNodes = []; this.attributes = {}; this.dataset = {}; this.style = {}; this.events = {}; this.classes = new Set(); this.classList = { add: (...xs) => xs.forEach(x => this.classes.add(x)), remove: (...xs) => xs.forEach(x => this.classes.delete(x)), contains: x => this.classes.has(x), toggle: (x, on) => on ? this.classes.add(x) : this.classes.delete(x) }; }
  get children() { return this.childNodes.filter(n => n.nodeType === 1); }
  append(...nodes) { for (const node of nodes) { node.parentNode = this; this.childNodes.push(node); } }
  insertBefore(node, ref) { if (node.parentNode) node.parentNode.removeChild(node); node.parentNode = this; const i = ref ? this.childNodes.indexOf(ref) : -1; if (i < 0) this.childNodes.push(node); else this.childNodes.splice(i, 0, node); }
  removeChild(node) { const i = this.childNodes.indexOf(node); if (i >= 0) this.childNodes.splice(i, 1); node.parentNode = null; }
  get lastChild() { return this.childNodes.at(-1) || null; }
  setAttribute(k, v) { this.attributes[k] = v; if (k === 'class') this.classes = new Set(v.split(' ')); }
  getAttribute(k) { return this.attributes[k]; }
  removeAttribute(k) { delete this.attributes[k]; }
  addEventListener(k, fn) { (this.events[k] ||= []).push(fn); }
  fire(k) { const e = { preventDefault() {}, stopPropagation() {} }; for (const fn of this.events[k] || []) fn(e); }
  replaceWith(...nodes) { const p = this.parentNode; const i = p.childNodes.indexOf(this); p.childNodes.splice(i, 1, ...nodes); for (const n of nodes) n.parentNode = p; }
  get textContent() { return this.nodeType === 3 ? this.data : this.childNodes.map(n => n.textContent).join(''); }
  set textContent(s) { this.childNodes = []; this.append(new Node(null, s)); }
  set innerHTML(s) { const stack = [this]; for (const part of s.split(/(<[^>]+>)/).filter(Boolean)) { if (part.startsWith('</')) stack.pop(); else if (part.startsWith('<')) { const n = new Node(part.match(/^<(\w+)/)[1]); const href = part.match(/href="([^"]+)"/); if (href) n.setAttribute('href', href[1]); stack.at(-1).append(n); stack.push(n); } else stack.at(-1).append(new Node(null, part)); } }
  querySelectorAll(selector) { return this.childNodes.flatMap(n => [...(n.nodeType === 1 && (selector === 'a[href]' ? n.tagName === 'A' && n.getAttribute('href') : n.tagName === selector.toUpperCase()) ? [n] : []), ...n.querySelectorAll(selector)]); }
  getBoundingClientRect() { return { x: 0, y: 0, width: 800, height: 600, left: 0, top: 0, right: 800, bottom: 600 }; }
}
function dom(t) {
  const old = { document: globalThis.document, Node: globalThis.Node, requestAnimationFrame: globalThis.requestAnimationFrame };
  globalThis.requestAnimationFrame = () => {};
  globalThis.Node = Node;
  globalThis.document = { createElement: tag => new Node(tag), createElementNS: (_, tag) => new Node(tag), createTextNode: s => new Node(null, s) };
  t.after(() => Object.assign(globalThis, old));
}

test('message markdown links known cell beads across formatting but leaves code, existing links and unknown ids alone', t => {
  dom(t);
  const text = 'hive-one, hive-unknown; xhive-one hive-one_extra hive-one.txt';
  const el = markdown({ ui: { markdownPreview: () => `<p>${text} <strong>hive-two</strong> <code>hive-one</code></p><pre><code>hive-two</code></pre><a href="https://example.com">hive-one</a>` } }, '', {
    beadIds: new Set(['hive-one', 'hive-two']), cellId: 'cell-one',
  });
  assert.deepEqual(el.querySelectorAll('a').map(a => a.textContent), ['hive-one', 'hive-two', 'hive-one']);
  assert.equal(el.querySelectorAll('a')[0].getAttribute('href'), '#view=ext:hive:overview&cell=cell-one&bead=hive-one&pane=details');
  assert.equal(el.querySelectorAll('code').map(n => n.textContent).join(','), 'hive-one,hive-two');
  assert.equal(el.querySelectorAll('a').at(-1).getAttribute('href'), 'https://example.com');
});

test('plain messages linkify safely and pointer, focus and click call the bead actions', t => {
  dom(t);
  const actions = [];
  const el = markdown({}, '<img> hive-one & hive-one.', { beadIds: new Set(['hive-one']), cellId: 'c', onHighlight: (id, source) => actions.push([id, source]), onOpen: id => actions.push(['open', id]) });
  assert.equal(el.textContent, '<img> hive-one & hive-one.');
  const [a, b] = el.querySelectorAll('a');
  assert.ok(a); assert.ok(b);
  a.fire('pointerenter'); a.fire('pointerleave'); a.fire('focus'); a.fire('blur'); a.fire('click');
  assert.deepEqual(actions, [['hive-one', 'pointer'], [null, 'pointer'], ['hive-one', 'focus'], [null, 'focus'], ['open', 'hive-one']]);
});

test('reference highlighting reuses map focus and restores pointer, keyboard and selection highlights', t => {
  dom(t);
  const map = renderHexMap({ viewKey: 'reference-test', size: 60, bounds: { x: 0, y: 0, w: 200, h: 200 }, selectedId: 'hive-one', items: ['hive-one', 'hive-two'].map((id, i) => ({ id, x: i * 100, y: 0, local: { q: i, r: 0 }, titleText: id })), relations: new Map(['hive-one', 'hive-two'].map(id => [id, { prereq: [], dependents: [] }])) });
  const all = n => [n, ...n.childNodes.flatMap(all)];
  const tile = id => all(map.el).find(n => n.dataset.tileId === id);
  map.highlightReference('hive-two', 'pointer');
  assert.ok(tile('hive-two').classes.has('is-focus'));
  map.highlightReference('hive-one', 'focus');
  map.highlightReference(null, 'pointer');
  assert.ok(tile('hive-one').classes.has('is-focus'));
  tile('hive-two').fire('pointerenter');
  assert.ok(tile('hive-two').classes.has('is-focus'));
  tile('hive-two').fire('pointerleave');
  assert.ok(tile('hive-one').classes.has('is-focus'));
  map.highlightReference(null, 'focus');
  assert.ok(tile('hive-one').classes.has('is-focus'));
  assert.ok(!tile('hive-two').classes.has('is-focus'));
});

for (const sessionId of ['queen', 'worker']) {
  test(`${sessionId} messages only link beads belonging to their cell and open Details`, t => {
    dom(t);
    const values = new Map([['cell', JSON.stringify('cell-one')]]);
    client.register({ api: { storage: { get: k => values.get(k), set: (k, v) => values.set(k, v), remove: k => values.delete(k) } }, register() {} });
    const ui = createUi();
    const highlights = [];
    const hive = { beads: {
      'hive-root': { id: 'hive-root' },
      'hive-one': { id: 'hive-one', parentId: 'hive-root', title: 'One' },
      'hive-two': { id: 'hive-two', parentId: 'another-root' },
    } };
    const cell = { id: 'cell-one', rootBeadId: 'hive-root', enabled: true, queenSessionId: 'queen', messages: [{ id: 'm', author: 'session', sessionId, text: 'hive-one hive-two hive-missing', at: 1 }] };
    const out = renderConversation({ cell, hive, graph: { sessions: [] }, api: {}, ui, ctx: { busy: () => false, beadReference: { highlight: (...args) => highlights.push(args) } } });
    const links = out.list.querySelectorAll('a');
    assert.deepEqual(links.map(a => a.textContent), ['hive-one']);
    links[0].fire('focus');
    assert.deepEqual(highlights, [['hive-one', 'focus']]);
    links[0].fire('click');
    assert.equal(ui.selectedBeadId(), 'hive-one');
    assert.equal(ui.pane(), 'details');
  });
}

for (const rendered of [false, true]) {
  test(`bead links exclude URI contents with ${rendered ? 'rendered Markdown' : 'the plain text fallback'}`, t => {
    dom(t);
    const text = 'ssh://example.com/hive-one file:///tmp/hive-one mailto:hive-one@example.com hive-one';
    const api = rendered ? { ui: { markdownPreview: () => `<p>${text}</p>` } } : {};
    const el = markdown(api, text, { beadIds: new Set(['hive-one']), cellId: 'cell-one' });
    assert.deepEqual(el.querySelectorAll('a').map(a => a.textContent), ['hive-one']);
  });
}

test('inline formatting preserves visible word and URI boundaries', t => {
  dom(t);
  const html = '<p>t<strong>hive-one</strong> <em>hive-one</em>t ssh://example.com/<strong>hive-one</strong> <code>t</code><em>hive-one</em> <strong>hive-one</strong><a href="https://example.com">t</a></p>';
  const el = markdown({ ui: { markdownPreview: () => html } }, '', { beadIds: new Set(['hive-one']), cellId: 'cell-one' });
  assert.deepEqual(el.querySelectorAll('a').map(a => a.textContent), ['t']);
});

test('paragraphs and line breaks separate words while punctuation preserves formatted references', t => {
  dom(t);
  const html = '<p>t</p><p><strong>hive-one</strong></p><p>(<em>hive-one</em>),</p><p>t<br></br><strong>hive-one</strong></p>';
  const el = markdown({ ui: { markdownPreview: () => html } }, '', { beadIds: new Set(['hive-one']), cellId: 'cell-one' });
  assert.deepEqual(el.querySelectorAll('a').map(a => a.textContent), ['hive-one', 'hive-one', 'hive-one']);
});

test('request-body Hive message links stay navigable in the same tab, other hash and relative links stay inert', t => {
  dom(t);
  const link = '#view=ext:hive:overview&cell=cell_x&topic=thr_other&message=msg_target';
  const html = `<p><a href="${link}">Open Hive message</a> <a href="#view=search">grid</a> <a href="javascript:alert(1)">js</a> <a href="https://example.com">web</a></p>`;
  const el = markdown({ ui: { markdownPreview: () => html } }, '');
  const anchors = el.querySelectorAll('a');
  assert.deepEqual(anchors.map(a => a.getAttribute('href')), [link, undefined, undefined, 'https://example.com']);
  assert.equal(anchors[0].target, undefined);
  assert.equal(anchors[3].target, '_blank');
});
