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
  client.register({ api: { storage: { get() {}, set() {}, remove() {} } }, register() {} });
  const cell = { id: 'cell_test', taskId: 'Test hive', enabled: true, rootBeadId: 'root', queenSessionId: 'queen', position: {q:0,r:0} };
  const beads = { root: { id:'root', title:'Test hive', kind:'goal', status:'in_progress' }, work: {id:'work', title:'Work', parentId:'root', status:'in_progress', assignee:'aw:worker'}, done: {id:'done', title:'Done', parentId:'root', status:'closed'}, other: {id:'other', title:'Other hive', status:'in_progress'} };
  const doc = { cells: { [cell.id]: cell }, conversation: {}, threads: {}, inbox: {}, bindings: {}, beadLayout: {}, arrangeAspect: {}, restoreNotices: {}, operations: {}, launches: {}, requests: {} };
  const runtime = { metadata: { read: () => doc, cells: () => Object.values(doc.cells) }, beads: { status: {state:'missing'} }, paths: {} };
  const ui = createUi();
  let hive;
  const draw = () => {
    hive = projectForGraph({runtime, snapshot:{graph:{beads,edges:[]}}});
    return renderHive({ui,hive,graph:{sessions:[]},api:{},notices:[],busy:()=>false,send(){},notice(){}}).top.querySelector('[data-tile-id="cell_test"]');
  };
  return {doc,cell,beads,draw,get hive(){return hive;}};
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
