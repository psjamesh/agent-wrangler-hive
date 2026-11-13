import test from 'node:test';
import assert from 'node:assert/strict';
import { renderHexMap } from '../public/hex-grid.js';
import { renderHive } from '../public/hive-view.js';
import client, { createUi } from '../public/client.js';
import { projectForGraph } from '../server/projection.js';

class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.attributes = {}; this.events = {}; this.dataset = {}; this.style = {}; this.value = ''; this.clientWidth = 1000; this.clientHeight = 700; }
  setAttribute(k, v) { this.attributes[k] = String(v); if (k.startsWith('data-')) this.dataset[k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(v); }
  getAttribute(k) { return this.attributes[k] ?? (k.startsWith('data-') ? this.dataset[k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] : undefined) ?? null; }
  removeAttribute(k) { delete this.attributes[k]; }
  get classList() { const el = this; const get = () => new Set((el.attributes.class || '').split(' ').filter(Boolean)); return { contains: n => get().has(n), add(...ns) { const s = get(); ns.forEach(n => s.add(n)); el.attributes.class = [...s].join(' '); }, remove(...ns) { const s = get(); ns.forEach(n => s.delete(n)); el.attributes.class = [...s].join(' '); }, toggle(n, on) { const s = get(); if (on ?? !s.has(n)) s.add(n); else s.delete(n); el.attributes.class = [...s].join(' '); } }; }
  get childNodes() { return this.children; }
  get firstChild() { return this.children[0]; }
  get lastChild() { return this.children.at(-1); }
  get parentElement() { return this.parentNode; }
  removeChild(n) { this.children.splice(this.children.indexOf(n), 1); n.parentNode = null; return n; }
  append(...ns) { for (let n of ns) { if (!(n instanceof Element)) n = Object.assign(new Element('#text'), { text: String(n) }); n.parentNode?.removeChild(n); n.parentNode = this; this.children.push(n); } }
  insertBefore(n, before) { if (n === before) return; n.parentNode?.removeChild(n); n.parentNode = this; const i = this.children.indexOf(before); this.children.splice(i < 0 ? this.children.length : i, 0, n); }
  replaceChildren(...ns) { this.children.forEach(n => n.parentNode = null); this.children = []; this.append(...ns); }
  get textContent() { return this.text ?? this.children.map(n => n.textContent).join(''); }
  set textContent(v) { this.replaceChildren(); this.text = String(v); }
  matches(selector) { return selector.split(',').some(part => { const s = part.trim(); if (s.startsWith('.')) return s.slice(1).split('.').every(c => this.classList.contains(c)); const a = s.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/); return a ? this.getAttribute(a[1]) !== null && (a[2] === undefined || this.getAttribute(a[1]) === a[2]) : this.tagName === s; }); }
  closest(s) { for (let el = this; el; el = el.parentNode) if (el.matches(s)) return el; return null; }
  querySelectorAll(s) { return this.children.flatMap(n => [...(n.matches(s) ? [n] : []), ...n.querySelectorAll(s)]); }
  querySelector(s) { return this.querySelectorAll(s)[0] || null; }
  contains(n) { return n === this || this.children.some(c => c.contains(n)); }
  focus() { document.activeElement = this; }
  addEventListener(type, fn, capture = false) { (this.events[type] ||= []).push({ fn, capture: capture === true }); }
  removeEventListener(type, fn) { this.events[type] = (this.events[type] || []).filter(e => e.fn !== fn); }
  fire(type, props = {}) { const e = { type, target: this, key: '', preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, ...props }; const path = []; for (let el = this; el; el = el.parentNode) path.push(el); for (const capture of [true, false]) for (const el of capture ? [...path].reverse() : path) { for (const h of el.events[type] || []) if (h.capture === capture) h.fn(e); if (e.stopped) return e; } return e; }
  getBoundingClientRect() { return { left: 0, top: 0, right: 1000, bottom: 700, width: 1000, height: 700 }; }
}

function fixture(t) {
  const saved = Object.fromEntries(['Node', 'document', 'requestAnimationFrame', 'cancelAnimationFrame', 'CSS'].map(k => [k, globalThis[k]]));
  Object.assign(globalThis, { Node: Element, document: { createElement: t => new Element(t), createElementNS: (_, t) => new Element(t), createTextNode: t => Object.assign(new Element('#text'), { text: t }), body: new Element('body') }, requestAnimationFrame: () => 1, cancelAnimationFrame() {}, CSS: { escape: s => s } });
  t.after(() => Object.assign(globalThis, saved));
  const store = new Map();
  client.register({ api: { storage: { get: (k) => store.get(k), set: (k, v) => store.set(k, v), remove: (k) => store.delete(k) } }, register() {} });
  const cells = {
    live: { id: 'live', taskId: 't1', enabled: true, rootBeadId: 'r1', queenSessionId: 'q', position: { q: 0, r: 0 } },
  };
  const beads = { r1: { id: 'r1', title: 'Live', kind: 'goal', status: 'in_progress' } };
  const doc = { cells, conversation: {}, threads: {}, inbox: {}, bindings: {}, beadLayout: {}, arrangeAspect: {}, restoreNotices: {}, operations: {}, launches: {}, requests: {}, archived: {} };
  const runtime = { metadata: { read: () => doc, cells: () => Object.values(doc.cells) }, beads: { status: { state: 'missing' } }, paths: {} };
  const ui = createUi();
  const sent = [];
  const hive = () => projectForGraph({ runtime, snapshot: { graph: { beads, edges: [] } } });
  const draw = () => renderHive({ ui, hive: hive(), graph: { sessions: [{ sessionId: 'worker' }, { sessionId: 'old', archived: true }] }, api: {}, notices: [], busy: () => false, send: (m) => sent.push(m), notice() {} });
  return { doc, ui, draw, hive, sent };
}

test('All hives puts the global inbox in the side dock, not under the map', (t) => {
  const f = fixture(t);
  const out = f.draw();
  assert.deepEqual(out.view, { overview: true, panels: true, pane: null });
  assert.ok(out.bottom.classList.contains('hive-dock'));
  const panel = out.bottom.querySelector('.hive-global-inbox');
  assert.ok(panel.classList.contains('hive-panel'));
  assert.ok(panel.classList.contains('hive-conversation'));
  assert.equal(panel.getAttribute('data-pane'), 'conversation');
  assert.equal(out.top.querySelector('.hive-global-inbox'), null);
});

test('the side inbox defaults to the merged Inbox with separate header totals', (t) => {
  const f = fixture(t);
  const out = f.draw();
  const on = out.bottom.querySelectorAll('.hive-inbox-filter').filter(b => b.getAttribute('aria-pressed') === 'true');
  assert.equal(on.length, 1);
  assert.equal(out.bottom.querySelectorAll('.hive-inbox-filter').length, 2);
  assert.equal(out.bottom.querySelector('.hive-inbox-totals').textContent, '0 messages');
  assert.equal(out.bottom.querySelector('.hive-needs-count'), null);
  assert.match(on[0].textContent, /Inbox/);
});

test('hiding the panels collapses the side inbox and the toggle brings it back', (t) => {
  const f = fixture(t);
  const toggle = out => out.top.querySelector('[data-focus-key="global-inbox-toggle"]');
  assert.match(toggle(f.draw()).textContent, /Hide inbox/);
  f.ui.setDockOpen(false);
  const closed = f.draw();
  assert.equal(closed.bottom, null);
  assert.deepEqual(closed.view, { overview: true, panels: false, pane: null });
  assert.match(toggle(closed).textContent, /Show inbox/);
  f.ui.setDockOpen(true);
  assert.ok(f.draw().bottom);
});


test('merged Inbox session actions stay outside the thread anchor and disable unavailable sessions', t => {
  const f = fixture(t);
  f.doc.requests = { r: { cellId: 'live', id: 'r', audience: 'human', state: 'open', createdAt: 1, title: 'Decision', body: 'Choose', threadId: 't', messageId: 'm', requesterSessionId: 'worker', sessionLink: { sessionId: 'old', label: 'Archived worker' } } };
  const row = f.draw().bottom.querySelector('.hive-inbox-item');
  assert.ok(row);
  const topic = row.querySelector('.hive-topic-btn');
  assert.equal(topic.querySelector('a'), null);
  const actions = row.querySelector('.hive-inbox-session-links');
  assert.equal(actions.querySelector('a').getAttribute('href'), '#session=worker');
  assert.match(actions.textContent, /Archived worker/);
  assert.equal(actions.querySelectorAll('a').length, 1);
  assert.equal(row.querySelector('.hive-needs-count').textContent, '1');
});


test('merged Inbox keeps the first structured label when session links repeat', t => {
  const f = fixture(t);
  f.doc.requests = { r: { cellId: 'live', id: 'r', audience: 'human', state: 'open', createdAt: 1, title: 'Decision', body: 'Choose', threadId: 't', messageId: 'm', requesterSessionId: 'worker', sessionLink: { sessionId: 'worker', label: 'Open session' }, requesterSessionLink: { sessionId: 'worker', label: 'Open requester session' } } };
  const actions = f.draw().bottom.querySelector('.hive-inbox-session-links');
  assert.equal(actions.querySelectorAll('a').length, 1);
  assert.equal(actions.querySelector('a').textContent, 'Open session');
});


test('Inbox filter counts merged rows and message chips appear only above one', t => {
  const f = fixture(t);
  f.doc.requests = { r: { cellId: 'live', id: 'r', audience: 'human', state: 'open', createdAt: 1, title: 'Decision', body: 'Choose', threadId: 'request', messageId: 'rmsg', requesterSessionId: 'worker' } };
  f.doc.conversation = { live: [{ id: 'm', threadId: 'topic', author: 'session', sessionId: 'worker', text: 'Update', at: 2, ack: { required: true, rev: 1 } }] };
  f.doc.inbox = { live: { rev: 1 } };
  let panel = f.draw().bottom;
  assert.match(panel.querySelector('.hive-inbox-totals').textContent, /1 needs you.*1 message$/);
  assert.equal(panel.querySelector('.hive-inbox-filter').querySelector('.hive-inbox-count').textContent, '2');
  assert.equal(panel.querySelectorAll('.hive-unread').length, 0);
  f.doc.conversation.live.push({ ...f.doc.conversation.live[0], id: 'm2', at: 3 });
  panel = f.draw().bottom;
  assert.equal(panel.querySelector('.hive-inbox-filter').querySelector('.hive-inbox-count').textContent, '2');
  assert.equal(panel.querySelector('.hive-unread').textContent, '2');
  assert.equal(panel.querySelector('.hive-unread').getAttribute('aria-label'), '2 messages');
});


test('cell Inbox merges only its own messages and needs using the shared row presentation', t => {
  const f = fixture(t);
  f.doc.cells.other = { ...f.doc.cells.live, id: 'other', taskId: 't2' };
  f.doc.requests = {
    r: { cellId: 'live', id: 'r', audience: 'human', state: 'open', createdAt: 1, title: 'Decision', body: '#session=worker', threadId: 'topic', messageId: 'm', requesterSessionId: 'worker', sessionLink: { sessionId: 'old', label: 'Archived worker' } },
    extra: { cellId: 'live', id: 'extra', audience: 'human', state: 'open', createdAt: 3, title: 'Separate need', body: 'Choose', threadId: 'extra', messageId: 'extra' },
    elsewhere: { cellId: 'other', id: 'elsewhere', audience: 'human', state: 'open', createdAt: 1, title: 'Other hive need', body: 'Choose', threadId: 'other', messageId: 'other' },
  };
  f.doc.conversation = { live: [{ id: 'm', threadId: 'topic', author: 'session', sessionId: 'worker', text: 'Update', at: 2, ack: { required: true, rev: 1 } }] };
  f.doc.inbox = { live: { rev: 1 } };
  f.ui.openCell('live');
  f.ui.setInboxView('live', 'human');
  let panel = f.draw().bottom;
  assert.equal(panel.querySelectorAll('.hive-inbox-filter').length, 2);
  assert.equal(panel.querySelector('.hive-inbox-filters').querySelector('.hive-inbox-count').textContent, '2');
  assert.equal(panel.querySelectorAll('.hive-inbox-item').length, 2);
  assert.doesNotMatch(panel.querySelector('.hive-inbox').textContent, /Other hive need/);
  assert.equal(panel.querySelectorAll('.hive-unread').length, 0);
  assert.equal(panel.querySelectorAll('.hive-inbox-session-links').length, 1);
  assert.match(panel.querySelector('.hive-inbox-session-links').textContent, /Archived worker/);
  assert.equal(panel.querySelector('.hive-inbox-session-links').querySelectorAll('a').length, 1);
  f.doc.conversation.live.push({ ...f.doc.conversation.live[0], id: 'm2', at: 4 });
  panel = f.draw().bottom;
  assert.equal(panel.querySelector('.hive-unread').textContent, '2');
});


test('cell Inbox search stays in the cell and zero filter badges are absent', t => {
  const f = fixture(t);
  f.doc.cells.other = { ...f.doc.cells.live, id: 'other', taskId: 't2' };
  f.doc.requests = {
    r: { cellId: 'live', id: 'r', audience: 'human', state: 'open', createdAt: 1, title: 'Database', body: 'SQLite', threadId: 'topic', messageId: 'm' },
    other: { cellId: 'other', id: 'other', audience: 'human', state: 'open', createdAt: 1, title: 'Other database', body: 'SQLite', threadId: 'other', messageId: 'other' },
  };
  f.ui.openCell('live');
  f.ui.setInboxView('live', 'human');
  f.ui.setGlobalInboxQuery('SQLite', 'live');
  const panel = f.draw().bottom;
  assert.equal(panel.querySelectorAll('.hive-inbox-item').length, 1);
  assert.match(panel.querySelector('.hive-inbox-item').textContent, /Database/);
  assert.equal(panel.querySelector('.hive-inbox-search-input').value, 'SQLite');
  const head = panel.querySelector('.hive-inbox-head');
  assert.ok(head.children.indexOf(head.querySelector('.hive-inbox-search')) < head.children.indexOf(head.querySelector('.hive-inbox-filters')));
  assert.equal(panel.querySelector('.hive-inbox').querySelector('.hive-topic-context'), null);
  assert.equal(panel.querySelector('.hive-search-hit').textContent, 'SQLite');
  assert.deepEqual(panel.querySelector('.hive-inbox-filters').querySelectorAll('.hive-inbox-count').map(e => e.textContent), ['1']);
  f.ui.setGlobalInboxQuery('does not match', 'live');
  assert.equal(f.draw().bottom.querySelectorAll('.hive-inbox-item').length, 0);
});
