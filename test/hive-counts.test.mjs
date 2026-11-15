import test from 'node:test';
import assert from 'node:assert/strict';
import { renderHexMap } from '../public/hex-grid.js';
import { renderHive } from '../public/hive-view.js';
import { needsRows, globalInbox } from '../public/global-inbox.js';
import { renderConversation } from '../public/conversation.js';
import client, { createUi } from '../public/client.js';
import { projectForGraph } from '../server/projection.js';

class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.attributes = {}; this.events = {}; this.dataset = {}; this.style = { setProperty(k, v) { this[k] = v; }, removeProperty(k) { delete this[k]; } }; this.value = ''; this.clientWidth = 1000; this.clientHeight = 700; }
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
  checkVisibility() { return false; }
  getBoundingClientRect() { return { left: 0, top: 0, right: 1000, bottom: 700, width: 1000, height: 700 }; }
}

function fixture(t) {
  const saved = Object.fromEntries(['Node', 'document', 'requestAnimationFrame', 'cancelAnimationFrame', 'CSS'].map(k => [k, globalThis[k]]));
  Object.assign(globalThis, { Node: Element, document: { createElement: t => new Element(t), createElementNS: (_, t) => new Element(t), createTextNode: t => Object.assign(new Element('#text'), { text: t }), body: new Element('body'), addEventListener() {}, removeEventListener() {} }, requestAnimationFrame: () => 1, cancelAnimationFrame() {}, CSS: { escape: s => s } });
  t.after(() => Object.assign(globalThis, saved));
  let view;
  client.register({ api: { settings: () => ({ beeLevel: 0, showBees: false }), storage: { get() {}, set() {}, remove() {} } }, register(kind, value) { if (kind === 'view') view = value; } });
  const cell = { id: 'cell_test', taskId: 'Test hive', enabled: true, rootBeadId: 'root', queenSessionId: 'queen', position: {q:0,r:0} };
  const beads = { root: { id:'root', title:'Test hive', kind:'goal', status:'in_progress' }, work: {id:'work', title:'Work', parentId:'root', status:'in_progress', assignee:'aw:worker'}, done: {id:'done', title:'Done', parentId:'root', status:'closed'}, other: {id:'other', title:'Other hive', status:'in_progress'} };
  const doc = { cells: { [cell.id]: cell }, conversation: {}, threads: {}, inbox: {}, bindings: {}, beadLayout: {}, arrangeAspect: {}, restoreNotices: {}, operations: {}, launches: {}, requests: {} };
  const runtime = { metadata: { read: () => doc, cells: () => Object.values(doc.cells) }, beads: { status: {state:'missing'} }, paths: {} };
  const ui = createUi();
  const graph = { sessions: [] };
  let hive, top;
  const draw = () => {
    hive = projectForGraph({runtime, snapshot:{graph:{beads,edges:[]}}});
    top = renderHive({ui,hive,graph,api:{},notices:[],busy:()=>false,send(){},notice(){}}).top;
    return top.querySelector('[data-tile-id="cell_test"]');
  };
  return {doc,cell,beads,draw,graph,ui,view,get hive(){return hive;},get top(){return top;}};
}
const counter = (tile, kind) => tile.querySelector(`[data-counter="${kind}"]`);

test('All hives uses projected human routing and settles answered/withdrawn requests', t => {
  const f=fixture(t);
  const cases = [
    ['forwarded','human','open',true,null,1],
    ['queen','human','open',false,null,1],
    ['no-queen','route-repair','open',false,'no-queen',1],
    ['private','queen','open',false,null,0],
    ['repair','route-repair','open',false,'unavailable',0],
    ['answered','human','answered',false,null,0],
    ['withdrawn','human','withdrawn',false,null,0],
  ];
  for(const [id,audience,state,forwarded,routeReason,want] of cases) {
    f.doc.requests = {[id]:{id,cellId:f.cell.id,threadId:id,messageId:id,title:id,audience,state,forwarded,routeReason,delivery:{state:'delivered'}}};
    const tile=f.draw();
    assert.equal(f.hive.cells[f.cell.id].requestCounts.human,want,id);
    assert.equal(counter(tile,'needs')?.querySelector('text')?.textContent ?? '0',String(want),id);
  }
  f.doc.requests = {a:{id:'a',cellId:f.cell.id,threadId:'a',messageId:'a',title:'Pending answer',audience:'human',state:'answered',delivery:{state:'failed'}}};
  assert.equal(counter(f.draw(),'needs').querySelector('text').textContent,'1');
  f.doc.requests = {a:{...f.doc.requests.a,delivery:{state:'delivered'}}};
  assert.equal(counter(f.draw(),'needs'),null);
});

test('four plain counters update from snapshots without moving the tile label', t => {
  const f=fixture(t);
  f.cell.inbox = {};
  f.doc.conversation[f.cell.id] = [
    {id:'read',threadId:'topic',author:'session',text:'Read me',at:1,ack:{required:true,state:null,rev:0}},
    {id:'reply',threadId:'topic',author:'human',text:'Reply please',at:2,response:{required:true,answers:[]}},
  ];
  f.doc.requests = {a:{id:'a',cellId:f.cell.id,threadId:'a',messageId:'a',title:'Question',audience:'human',state:'open'}};
  const before=f.draw();
  for(const kind of ['needs','inbox','queen','progress']) {
    const c=counter(before,kind);
    assert.ok(c,kind);
    assert.equal(c.querySelector('text').textContent,'1',kind);
    assert.equal(c.querySelector('.hive-counter-hex'),null);
  }
  const positions = tile => tile.querySelectorAll('.hive-hex-title').map(n=>n.getAttribute('y'));
  f.beads.work.status='closed';
  f.doc.requests = {a:{...f.doc.requests.a,state:'withdrawn'}};
  f.doc.conversation[f.cell.id]=[];
  const after=f.draw();
  assert.equal(after.querySelectorAll('.hive-counter').length,0);
  assert.deepEqual(positions(after),positions(before));
  assert.equal(after.getAttribute('transform'),before.getAttribute('transform'));
});

test('large counts display 99+ while tooltips and accessible labels stay exact', t => {
  const f=fixture(t);
  for (const value of [99, 100, 12345]) {
    f.doc.requests = Object.fromEntries(Array.from({length:value},(_,i)=>[String(i),{id:String(i),cellId:f.cell.id,threadId:String(i),messageId:String(i),title:'Question',audience:'human',state:'open'}]));
    const tile=f.draw();
    const needs=counter(tile,'needs');
    assert.equal(needs.querySelector('text').textContent,value===99?'99':'99+');
    assert.equal(needs.querySelector('title').textContent,`Needs you: ${value}`);
    assert.match(tile.getAttribute('aria-label'),new RegExp(`${value} need your input`));
  }
  f.doc.requests={};
  assert.ok(counter(f.draw(),'progress'));
});

test('one to four counters form a measured centred row without zero slots', t => {
  fixture(t);
  const kinds = ['inbox', 'queen', 'needs', 'progress'];
  const x = el => Number(el.getAttribute('transform').match(/translate\(([-\d.]+)/)[1]);
  for (const values of [[0,0,1,0], [10,0,1,0], [10,0,1,10], [1,10,99,100]]) {
    const counters = kinds.map((kind,i) => ({kind, count:values[i], label:kind}));
    const map = renderHexMap({viewKey:'counter-layout', size:92,
      items:[{id:'example', x:0, y:0, titleText:'AI Tooling', counters}],
      bounds:{minX:-100,maxX:100,minY:-100,maxY:100}});
    const visible = map.el.querySelectorAll('.hive-counter');
    assert.deepEqual(visible.map(el=>el.dataset.counter), kinds.filter((_,i)=>values[i]>0));
    const widths = visible.map(el => 14 + el.querySelector('text').textContent.length * 9 * 0.58);
    const starts = visible.map(el => x(el) - 5);
    assert.ok(Math.abs(starts[0] + starts.at(-1) + widths.at(-1)) < 0.02, 'row centred around tile origin');
    for (let i=1;i<visible.length;i++) {
      assert.ok(Math.abs(starts[i] - starts[i-1] - widths[i-1] - 10) < 0.02, 'even edge spacing');
    }
  }
});

test('occupied counters remain on disabled and retired cards, nested work counts once, and remainder explains off-card slots', t => {
  const f = fixture(t);
  f.cell.enabled = false;
  f.doc.cells.nested = { id: 'nested', rootBeadId: 'nested', enabled: true, position: { q: 2, r: 0 } };
  f.doc.cells.retired = { id: 'retired', rootBeadId: 'retired', enabled: false, position: { q: 4, r: 0 }, retired: { outcome: 'done' } };
  Object.assign(f.beads, {
    nested: { id: 'nested', parentId: 'root', kind: 'goal', status: 'in_progress' },
    n: { id: 'n', parentId: 'nested', kind: 'work', status: 'in_progress', assignee: 'aw:builder' },
    retired: { id: 'retired', kind: 'goal', status: 'closed' },
    r: { id: 'r', parentId: 'retired', kind: 'work', status: 'in_progress', assignee: 'aw:builder' },
  });
  f.doc.workerLaunches = { missing: { beadId: 'missing', state: 'reserved' } };
  f.draw();
  for (const id of ['cell_test', 'nested', 'retired']) {
    const tile = f.top.querySelector(`[data-tile-id="${id}"]`);
    assert.ok(tile, id);
    assert.equal(counter(tile, 'progress').querySelector('text').textContent, '1', id);
  }
  assert.equal(f.top.querySelector('[data-focus-key="show-retired"]'), null);
  assert.match(f.top.textContent, /1 outside a hive/);
  const sum = f.top.querySelectorAll('[data-counter="progress"]').reduce((n, el) => n + Number(el.querySelector('text').textContent), 0);
  assert.equal(sum + f.hive.capacity.outside, f.hive.capacity.used);
  delete f.doc.workerLaunches.missing;
  f.draw();
  assert.doesNotMatch(f.top.textContent, /outside a hive/);
});

test('metadata-only launch and claim reservations refresh the cached card counter', t => {
  const f = fixture(t);
  f.beads.pending = { id: 'pending', parentId: 'root', kind: 'work', status: 'open' };
  const progress = () => Number(counter(f.draw(), 'progress').querySelector('text').textContent);
  assert.equal(progress(), 1);
  const unchanged = JSON.stringify(f.beads);
  const reservations = [
    ['workerLaunches', { beadId: 'pending', state: 'reserved' }],
    ['workerLaunches', { beadId: 'pending', state: 'uncertain' }],
    ['operations', { kind: 'claim', state: 'partial', intent: { beadId: 'pending' } }],
  ];
  for (const [collection, reservation] of reservations) {
    (f.doc[collection] ||= {}).pending = reservation;
    assert.equal(progress(), 2, `${collection}: ${reservation.state}`);
    assert.equal(f.hive.capacity.used, 2);
    assert.equal(JSON.stringify(f.beads), unchanged);
    delete f.doc[collection].pending;
    assert.equal(progress(), 1, `${collection}: removed`);
    assert.equal(f.hive.capacity.used, 1);
  }
});


test('queen attention joins Needs you with a session link and clears on resume', t => {
  const f = fixture(t);
  const sessionId = 'a1234567-1234-4567-8901-123456789abc';
  f.cell.queenSessionId = sessionId;
  f.doc.requests = { a: { id: 'a', cellId: f.cell.id, title: 'Existing request', audience: 'human', state: 'open' } };
  const queen = { sessionId, name: 'Queen', status: 'needs-input' };
  f.graph.sessions.push(queen);
  f.ui.setInboxView(f.cell.id, 'human');
  for (const status of ['needs-input', 'working', 'idle', 'needs-you', 'working']) {
    queen.status = status;
    const needs = status.startsWith('needs-');
    const tile = f.draw();
    assert.equal(counter(tile, 'needs').querySelector('text').textContent, needs ? '2' : '1');
    assert.equal(counter(tile, 'needs').querySelector('title').textContent, `Needs you: ${needs ? 2 : 1}`);
    assert.match(tile.getAttribute('aria-label'), new RegExp(`${needs ? 2 : 1} need your input`));
    assert.equal(tile.querySelector('.hive-pm'), null);
    const context = { hive: f.hive, graph: f.graph, ui: f.ui, api: {}, ctx: { uiVersion: 1, busy: () => false, send() {} } };
    const projected = f.hive.cells[f.cell.id];
    const global = globalInbox(context, [projected]);
    const local = renderConversation({ ...context, cell: projected }).list;
    for (const list of [global, local]) {
      assert.equal(list.textContent.includes('Queen needs attention'), needs);
      if (needs) {
        const row = list.querySelectorAll('.hive-inbox-item').find(item => item.textContent.includes('Queen needs attention'));
        assert.equal(row.querySelector('.hive-topic-time'), null);
      }
      const links = list.querySelectorAll('a').filter(a => a.getAttribute('href') === `#session=${sessionId}`);
      assert.equal(links.some(a => a.textContent === 'Open session'), needs);
    }
    assert.match(tile.getAttribute('aria-label'), needs ? /waiting for input/ : new RegExp(status));
  }
});


test('client clock refreshes overdue queen attention without a new snapshot and disposes on unmount', t => {
  const f = fixture(t);
  const start = Date.parse('2026-01-01T12:00:00Z');
  let clock = start + 29 * 60000;
  t.mock.method(Date, 'now', () => clock);
  let tick, interval, cleared;
  t.mock.method(globalThis, 'setInterval', (fn, ms) => { tick = fn; interval = ms; return 42; });
  t.mock.method(globalThis, 'clearInterval', id => { cleared = id; });
  f.doc.conversation[f.cell.id] = [{ author: 'human', at: start, response: { required: true } }];
  f.doc.requests.private = { cellId: f.cell.id, audience: 'queen', state: 'open', createdAt: start };
  f.doc.requests.human = { cellId: f.cell.id, audience: 'human', state: 'open', title: 'Question' };
  f.graph.sessions.push({ sessionId: 'queen', status: 'idle', lastActivity: clock });
  f.draw();
  f.graph.hive = f.hive;
  const root = new Element('div');
  f.view.mount(root);
  try {
    f.view.update(root, null, f.graph);
    assert.equal(interval, 30000);
    assert.doesNotMatch(root.textContent, /Queen queen: not responding/);
    assert.equal(f.view.badge(f.graph), 1);
    clock = start + 30 * 60000;
    tick();
    assert.match(root.textContent, /Queen queen: not responding/);
    assert.equal(f.view.badge(f.graph), 2);
    clock += 30000;
    tick();
    assert.match(root.textContent, /Queen queen: not responding/);
    f.graph.sessions[0].status = 'needs-input';
    f.view.update(root, null, f.graph);
    assert.match(root.textContent, /Queen queen: waiting for input/);
    assert.doesNotMatch(root.textContent, /Queen queen: not responding/);
    assert.equal(f.view.badge(f.graph), 2);
    f.graph.sessions[0].status = 'working';
    f.view.update(root, null, f.graph);
    assert.doesNotMatch(root.textContent, /Queen queen: waiting for input/);
    assert.equal(f.view.badge(f.graph), 1);
    assert.equal(f.view.badge({ ...f.graph, hive: { ...f.hive, metadataError: 'unavailable' } }), 0);
  } finally { f.view.unmount(root); }
  assert.equal(cleared, 42);
});

test('stopped queens appear in global and hive inboxes and tab badge until running again', t => {
  const f = fixture(t);
  f.cell.queenSessionId = 'queen';
  f.doc.requests = { private: { id: 'private', cellId: f.cell.id, title: 'Private question', audience: 'queen', state: 'open', createdAt: Date.now() - 120000 } };
  const queen = { sessionId: 'queen', status: 'exited' };
  f.graph.sessions.push(queen);
  f.ui.setInboxView(f.cell.id, 'human');
  for (const state of [{ status: 'idle', exitOutput: 'Process exited' }, { status: 'unknown', exitOutput: 'Process crashed' }, { status: 'idle', archived: true }, { status: 'idle', archived: false, exitOutput: null, dormant: true }, { status: 'working', archived: false, exitOutput: null, dormant: false }]) {
    Object.assign(queen, state);
    const stopped = queen.status !== 'working';
    const tile = f.draw();
    f.graph.hive = f.hive;
    assert.equal(f.view.badge(f.graph), Number(stopped));
    assert.equal(counter(tile, 'needs')?.querySelector('text')?.textContent ?? '0', String(Number(stopped)));
    const context = { hive: f.hive, graph: f.graph, ui: f.ui, api: {}, ctx: { uiVersion: 1, busy: () => false, send() {} } };
    const projected = f.hive.cells[f.cell.id];
    for (const list of [globalInbox(context, [projected]), renderConversation({ ...context, cell: projected }).list]) {
      const rows = list.querySelectorAll('.hive-inbox-item').filter(row => row.textContent.includes('Queen stopped'));
      assert.equal(rows.length, Number(stopped));
      assert.equal(list.textContent.includes('Private question'), false);
      if (stopped) {
        assert.equal(rows[0].querySelector('a').getAttribute('href'), queen.dormant ? '#session=queen' : '#view=ext:hive:overview&cell=cell_test');
        const sessionLinks = rows[0].querySelectorAll('a').filter(link => link.textContent === 'Open session');
        assert.equal(sessionLinks.length, queen.archived ? 0 : 1, JSON.stringify({state, list: list.textContent}));
      }
    }
  }
});


test('tile and header share counts for blocked work, requests, worker input and PR actions', t => {
  const f = fixture(t);
  f.beads.blocked = { id: 'blocked', parentId: 'root', status: 'open' };
  f.beads.review = { id: 'review', parentId: 'root', status: 'in_progress', reviewState: 'in_review' };
  f.beads.inactive = { id: 'inactive', parentId: 'root', status: 'in_progress' };
  f.beads.blocker = { id: 'blocker', parentId: 'root', status: 'open' };
  f.doc.requests = { question: { id: 'question', cellId: f.cell.id, beadId: 'blocked', title: 'Decision', audience: 'human', state: 'open' } };
  f.graph.tasks = { assignments: { worker: f.cell.taskId } };
  const worker = { sessionId: 'worker', status: 'needs-you' };
  f.graph.sessions.push(worker);
  const first = f.draw();
  assert.equal(counter(first, 'needs').querySelector('text').textContent, '2');
  const hive = structuredClone(f.hive);
  hive.edges.push({ dependent: 'blocked', prerequisite: 'blocker', blocking: true });
  const ctx = () => ({ ui: f.ui, hive, graph: f.graph, api: {}, notices: [], busy: () => false, send() {}, notice() {} });
  const cell = hive.cells[f.cell.id];
  const check = needs => {
    const overview = renderHive(ctx()).top;
    const tile = overview.querySelector('[data-tile-id="cell_test"]');
    const local = renderHive({ ...ctx(), ui: { ...f.ui, cellId: () => f.cell.id } }).top;
    const header = local.querySelector('.hive-cellhead');
    assert.equal(counter(tile, 'needs')?.querySelector('text')?.textContent || '0', String(needs));
    assert.equal(f.view.badge({ ...f.graph, hive }), needs);
    assert.equal(header.querySelector('[data-focus-key="waiting-header"]')?.textContent || '', needs ? `${needs} need you` : '');
    assert.equal(header.querySelector('.hive-headprogress').textContent, '1/6 closed');
    assert.match(tile.getAttribute('aria-label'), /1 in progress, 1 in review, 1 not active, 1 waiting, 2 open, 1 of 6 closed/);
    assert.equal(header.querySelector('.hive-headprogress').getAttribute('title'), '1 in progress, 1 in review, 1 not active, 1 waiting, 2 open, 1 of 6 closed');
    assert.equal(counter(tile, 'progress').querySelector('text').textContent, '1');
    assert.equal(header.querySelector('.hive-capacity-count').textContent, overview.querySelector('.hive-capacity-count').textContent);
  };
  check(2);
  worker.status = 'working';
  check(1);
  const head = 'a'.repeat(40);
  cell.pullRequests = [{ url: 'https://github.com/example/repo/pull/1', number: 1, title: 'Ready work', beadIds: ['work'], state: 'OPEN', headSha: head, isDraft: false, checks: 'green', stateCheckedAt: Date.now(), humanAttention: { state: 'ready', headSha: head, reason: 'Ready for merge' } }];
  check(2);
  cell.pullRequests[0].humanAttention.state = 'cannot-fix';
  check(2);
  cell.pullRequests[0].stateCheckedAt = 0;
  check(1);
  cell.requests = {};
  check(0);
});


test('Off hive request needs agree in tile, header and global Inbox without live waits', t => {
  const f = fixture(t);
  f.cell.enabled = false;
  f.doc.requests = { r: { id: 'r', cellId: f.cell.id, audience: 'human', state: 'open', title: 'Still owed' } };
  f.graph.tasks = { assignments: { worker: f.cell.taskId } };
  f.graph.sessions.push({ sessionId: 'worker', status: 'needs-you' });
  const tile = f.draw();
  const cell = f.hive.cells[f.cell.id];
  const ctx = { ui: f.ui, hive: f.hive, graph: f.graph, api: {}, notices: [], busy: () => false, send() {}, notice() {} };
  const header = renderHive({ ...ctx, ui: { ...f.ui, cellId: () => cell.id } }).top.querySelector('.hive-cellhead');
  assert.equal(counter(tile, 'needs')?.querySelector('text')?.textContent, '1');
  assert.equal(header.querySelector('[data-focus-key="waiting-header"]').textContent, '1 need you');
  assert.equal(needsRows(ctx, [cell]).reduce((n, row) => n + row.needsCount, 0), 1);
});

test('captured hive request totals agree in tile and header without live actions', t => {
  const f = fixture(t);
  f.draw();
  const hive = structuredClone(f.hive);
  const cell = hive.cells[f.cell.id];
  cell.snapshot = {};
  cell.requests = { r: { id: 'r', audience: 'human', state: 'open', title: 'Captured request' } };
  cell.requestCounts = { human: 1 };
  f.graph.tasks = { assignments: { worker: f.cell.taskId } };
  f.graph.sessions.push({ sessionId: 'worker', status: 'needs-you' });
  const ctx = { ui: f.ui, hive, graph: f.graph, api: {}, notices: [], busy: () => false, send() {}, notice() {} };
  const tile = renderHive(ctx).top.querySelector('[data-tile-id="cell_test"]');
  const header = renderHive({ ...ctx, ui: { ...f.ui, cellId: () => cell.id } }).top.querySelector('.hive-cellhead');
  assert.equal(counter(tile, 'needs')?.querySelector('text')?.textContent, '1');
  const needs = header.querySelector('.hive-waiting');
  assert.equal(needs.textContent, '1 need you');
  assert.equal(needs.tagName, 'span');
  assert.equal(needs.getAttribute('aria-haspopup'), null);
});


test('navigation badge matches rendered tiles when a hive task is archived', t => {
  const f = fixture(t);
  delete f.beads.work.assignee;
  f.doc.requests = { r: { id: 'r', cellId: f.cell.id, beadId: 'root', title: 'Decision', audience: 'human', state: 'open' } };
  f.graph.tasks = { tasks: [{ id: f.cell.taskId }] };
  for (const archived of [false, true, false]) {
    f.graph.tasks.tasks[0].archived = archived;
    const tile = f.draw();
    const count = tile ? Number(counter(tile, 'needs')?.querySelector('text')?.textContent || 0) : 0;
    assert.equal(count, archived ? 0 : 1);
    assert.equal(f.view.badge({ ...f.graph, hive: f.hive }), count);
  }
});
