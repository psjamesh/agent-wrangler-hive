import test from 'node:test';
import assert from 'node:assert/strict';
import { layoutCell } from '../public/cell-layout.js';
import { activeKids } from '../public/archive-layout.js';
import { previewMove, planMove } from '../public/cell-move.js';

const p = (q, r = 0) => ({ q, r });
const beads = Object.fromEntries([
  ['root', null, 'goal'], ['parent', 'root', 'workstream'], ['a', 'parent', 'work'],
  ['child', 'parent', 'workstream'], ['b', 'child', 'work'],
  ['deep', 'child', 'workstream'], ['c', 'deep', 'work'],
].map(([id, parentId, kind]) => [id, { id, parentId, kind, status: 'open' }]));
const saved = { parent: p(0), a: p(1), child: p(2), b: p(3), deep: p(4), c: p(5) };
const fixture = (positions = saved, graph = beads) => {
  const kids = activeKids(graph);
  return { kids, saved: positions, rootId: 'root', layout: layoutCell({ kids, saved: positions, rootId: 'root' }) };
};

test('a parent heading carries its entire rigid subtree', () => {
  const f = fixture();
  const out = planMove({ ...f, id: 'parent', target: p(80, 10) });
  assert.equal(out.ok, true, out.reason);
  for (const [id, at] of Object.entries(saved)) assert.deepEqual(out.moves[id], p(at.q + 80, at.r + 10));
});

test('a child heading can move around the boundary but cannot detach', () => {
  const f = fixture();
  const attached = previewMove({ ...f, id: 'child', target: p(0, 1) });
  assert.equal(attached.ok, true, attached.reason);
  assert.deepEqual(attached.moves.deep, p(2, 1));
  assert.equal(previewMove({ ...f, id: 'child', target: p(20) }).ok, false);
});

test('ordinary tile moves cannot remove the last attachment of a child region', () => {
  const f = fixture();
  const out = previewMove({ ...f, id: 'a', target: p(-1) });
  assert.equal(out.ok, false);
  assert.match(out.reason, /attach/i);
});

test('detached migrated regions remain pinned and flagged until their own drag reattaches', () => {
  const original = { ...saved, child: p(40), b: p(41), deep: p(42), c: p(43) };
  const f = fixture(original);
  assert.deepEqual(f.layout.positions, original);
  assert.deepEqual(f.layout.detachedHeads, ['child']);
  assert.equal(previewMove({ ...f, id: 'child', target: p(60) }).ok, false);
  assert.equal(previewMove({ ...f, id: 'child', target: p(2) }).ok, true);
});

test('new child placement attaches its own region rather than a grandparent', () => {
  const f = fixture({ parent: p(0), a: p(1), child: p(40), b: p(41) });
  const pos = f.layout.positions.deep;
  const distance = (a,b) => Math.max(Math.abs(a.q-b.q),Math.abs(a.r-b.r),Math.abs(a.q+a.r-b.q-b.r));
  assert.ok([f.layout.positions.child, f.layout.positions.b].some((p) => distance(pos, p) === 1));
});

test('pointer snapping resolves to the nearest valid attached rigid shape', async () => {
  const mod = await import('../public/cell-move.js');
  assert.equal(typeof mod.planDrag, 'function');
  const f = fixture();
  const target = p(0);
  const out = mod.planDrag({ ...f, id: 'child', target });
  assert.equal(out.ok, true, out.reason);
  assert.notDeepEqual(out.target, target);
  assert.equal(previewMove({ ...f, id: 'child', target: out.target }).ok, true);
  const span = (p) => Math.max(Math.abs(p.q), Math.abs(p.r), Math.abs(p.q + p.r));
  const distance = span({ q: out.target.q - target.q, r: out.target.r - target.r });
  for (let q = -distance; q <= distance; q++) for (let r = -distance; r <= distance; r++) {
    if (span({ q, r }) >= distance) continue;
    assert.equal(previewMove({ ...f, id: 'child', target: p(q, r) }).ok, false);
  }
});

test('a parent cavity does not count as exterior attachment', async () => {
  const { regionBoundary } = await import('../public/region-attachments.js');
  const ring = [p(1), p(1,-1), p(0,-1), p(-1), p(-1,1), p(0,1)];
  const border = regionBoundary(ring);
  assert.equal(border.exterior.has('0,0'), false);
  assert.equal(border.outside(p(0)), false);
  assert.equal(border.exterior.has('2,0'), true);
  const graph = { root: beads.root, parent: beads.parent, child: beads.child };
  const positions = { parent: ring[0], child: p(0) };
  ring.slice(1).forEach((at,i) => { const id = `p${i}`; graph[id] = { id, parentId: 'parent', kind: 'work' }; positions[id] = at; });
  const f = fixture(positions, graph);
  assert.deepEqual(f.layout.detachedHeads, ['child']);
  assert.equal(previewMove({ ...f, id:'child', target:p(2) }).ok, true);
});

test('a saturated parent accepts a new child via an attached sibling', () => {
  const graph = { root: beads.root, parent: beads.parent };
  const positions = { parent: p(0) };
  [p(1),p(1,-1),p(0,-1),p(-1),p(-1,1),p(0,1)].forEach((at,i) => {
    const id = `s${i}`; graph[id] = { id, kind:'workstream', parentId:'parent' }; positions[id] = at;
  });
  graph.new = { id:'new', kind:'workstream', parentId:'parent' };
  const f = fixture(positions, graph);
  assert.equal(f.layout.attachments.new.status, 'sibling');
  assert.ok(f.layout.attachments.new.via);
  for (const [id,at] of Object.entries(positions)) assert.deepEqual(f.layout.positions[id], at);
});

test('hiding the only visible contact reattaches the child at the nearest visible edge', async () => {
  const mod = await import('../public/cell-move.js');
  assert.equal(typeof mod.planHide, 'function');
  const graph = { root:beads.root, parent:beads.parent, a:{...beads.a,status:'closed'}, child:beads.child, b:beads.b };
  const f = fixture({ parent:p(0),a:p(1),child:p(2),b:p(3) },graph);
  const hidden = new Set(['a']);
  const out = mod.planHide({ ...f, hidden, yieldIds:hidden });
  assert.equal(out.ok,true,out.reason);
  const next = layoutCell({ ...f, saved:{...f.saved,...out.positions}, hidden, yieldIds:hidden });
  assert.equal(next.attachments.child.status,'direct');
  assert.deepEqual(next.positions.parent,p(0));
  assert.deepEqual(out.positions.b, p(out.positions.child.q+1,out.positions.child.r));
});

test('a new child remains attached when unrelated work encloses the parent', () => {
  const graph = { root:beads.root, parent:beads.parent, child:beads.child };
  const positions = { parent:p(0) };
  [p(1),p(1,-1),p(0,-1),p(-1),p(-1,1),p(0,1)].forEach((at,i) => {
    const id=`wall${i}`; graph[id]={id,parentId:'root',kind:'work'}; positions[id]=at;
  });
  const f=fixture(positions,graph);
  assert.equal(f.layout.attachments.child.status,'direct');
  for(const [id,at] of Object.entries(positions)) if(id!=='parent') assert.deepEqual(f.layout.positions[id],at);
  assert.notDeepEqual(f.layout.positions.parent,p(0));
});

test('enclosed growth translates the whole constellation without breaking its attachments', () => {
  const graph = { root:beads.root, parent:beads.parent, child:beads.child, b:beads.b, fresh:{id:'fresh',parentId:'parent',kind:'work'} };
  const positions={parent:p(0),child:p(1),b:p(2)};
  [p(1,-1),p(0,-1),p(-1),p(-1,1),p(0,1)].forEach((at,i)=>{
    const id=`wall${i}`;graph[id]={id,parentId:'root',kind:'work'};positions[id]=at;
  });
  const f=fixture(positions,graph);
  assert.equal(f.layout.attachments.child.status,'direct');
  assert.deepEqual(f.layout.positions.child,p(f.layout.positions.parent.q+1,f.layout.positions.parent.r));
  assert.deepEqual(f.layout.positions.b,p(f.layout.positions.parent.q+2,f.layout.positions.parent.r));
  for(const [id,at] of Object.entries(positions)) if(id.startsWith('wall')) assert.deepEqual(f.layout.positions[id],at);
});

test('new parent work grows on the family boundary when its own tile is surrounded', () => {
  const graph={root:beads.root,parent:beads.parent,fresh:{id:'fresh',parentId:'parent',kind:'work'}};
  const positions={parent:p(0)};
  [p(1),p(1,-1),p(0,-1),p(-1),p(-1,1),p(0,1)].forEach((at,i)=>{
    const id=`s${i}`;graph[id]={id,parentId:'parent',kind:'workstream'};positions[id]=at;
  });
  const f=fixture(positions,graph);
  for(const [id,at]of Object.entries(positions)) assert.deepEqual(f.layout.positions[id],at);
  assert.equal(f.layout.parentHead.fresh,'parent');
  assert.deepEqual(f.layout.detachedHeads,[]);
});

test('a done transition under an existing hide preference reattaches without a manual toggle', () => {
  const graph={root:beads.root,parent:beads.parent,a:{...beads.a,status:'closed'},child:beads.child,b:beads.b};
  const hidden=new Set(['a']);
  const f=fixture({parent:p(0),a:p(1),child:p(2),b:p(3)},graph);
  const next=layoutCell({...f,hidden,yieldIds:hidden});
  assert.notDeepEqual(next.positions.child,p(2));
  assert.equal(next.attachments.child.status,'direct');
  assert.ok(next.automatic.child);
  assert.deepEqual(next.positions.parent,p(0));
});

test('a repeated snap on a large fragmented constellation is served from the cache', async () => {
  const { createDragPlanner }=await import('../public/cell-move.js');
  const graph={root:beads.root,parent:beads.parent,a:beads.a,child:beads.child,sibling:{id:'sibling',parentId:'parent',kind:'workstream'}};
  const positions={parent:p(0),a:p(1),child:p(2),sibling:p(0,1)};
  for(let i=0;i<800;i++) {const id=`tile${i}`;graph[id]={id,parentId:'child',kind:'work'};positions[id]=p(100+i*3,(i%3)*3);}
  const f=fixture(positions,graph);
  let clock=0,calls=0;
  const resolve=createDragPlanner({...f,id:'child'},{budgetMs:2,now:()=>{calls++;return clock++;}});
  const plan=resolve(p(0));
  assert.equal(plan.ok,true,plan.reason);
  const callsAfterFirst=calls;
  assert.ok(callsAfterFirst>0);
  assert.equal(resolve(p(0)),plan);
  assert.equal(calls,callsAfterFirst);
});

test('time-budget fallback returns a valid cached placement without a distance cutoff', async()=>{
  const { createDragPlanner }=await import('../public/cell-move.js');
  const f=fixture();let ticks=0;
  const resolve=createDragPlanner({...f,id:'child'},{budgetMs:2,now:()=>ticks++});
  const out=resolve(p(100000));
  assert.equal(out.ok,true,out.reason);
  assert.equal(previewMove({...f,id:'child',target:out.target}).ok,true);
  assert.equal(resolve(p(100000)),out);
  assert.ok(ticks<10);
});

test('attachment can use a sibling descendant anywhere on the connected parent boundary',()=>{
  const graph={root:beads.root,parent:beads.parent,branch:{id:'branch',parentId:'parent',kind:'workstream'},leaf:{id:'leaf',parentId:'branch',kind:'workstream'},child:beads.child};
  const f=fixture({parent:p(0),branch:p(1),leaf:p(2),child:p(3)},graph);
  assert.equal(f.layout.attachments.child.status,'sibling');
  assert.equal(f.layout.attachments.child.via,'leaf');
});

test('a sibling cycle detached from the parent cannot supply an attachment',()=>{
  const graph={root:beads.root,parent:beads.parent,child:beads.child,other:{id:'other',parentId:'parent',kind:'workstream'}};
  const f=fixture({parent:p(0),child:p(40),other:p(41)},graph);
  assert.deepEqual(f.layout.detachedHeads.sort(),['child','other']);
});

test('growth cannot seal a child inside a cavity of its parent region',()=>{
  const graph={root:beads.root,parent:beads.parent,child:beads.child,fresh:{id:'fresh',kind:'work',parentId:'parent'}};
  const positions={parent:p(1),child:p(0)};
  [p(1,-1),p(0,-1),p(-1),p(-1,1)].forEach((at,i)=>{const id=`tile${i}`;graph[id]={id,parentId:'parent',kind:'work'};positions[id]=at;});
  const f=fixture(positions,graph);
  assert.equal(f.layout.attachments.child.status,'direct');
  assert.notDeepEqual(f.layout.positions.fresh,p(0,1));
});

test('revealing closed parent work preserves the child attachment and leaves the child fixed',async()=>{
  const {planHide,planReveal}=await import('../public/cell-move.js');
  const graph={root:beads.root,parent:beads.parent,a:{...beads.a,status:'closed'},child:beads.child,b:beads.b};
  const f=fixture({parent:p(0),a:p(1),child:p(2),b:p(3)},graph);
  const hidden=new Set(['a']);
  const hide=planHide({...f,hidden,yieldIds:hidden});
  assert.equal(hide.ok,true,hide.reason);
  const currentSaved={...f.saved,...hide.positions};
  const layout=layoutCell({...f,saved:currentSaved,hidden,yieldIds:hidden});
  const out=planReveal({...f,layout,saved:currentSaved,headId:'parent',back:hidden,hidden:new Set(),yieldIds:hidden});
  assert.equal(out.ok,true,out.reason);
  assert.equal(out.same,undefined);
  const shown=layoutCell({...f,saved:{...currentSaved,...out.positions},yieldIds:hidden});
  assert.equal(shown.attachments.child.status,'direct');
  assert.deepEqual(shown.positions.child,layout.positions.child);
  assert.deepEqual(shown.positions.b,layout.positions.b);
});


test('an enclosed child stays pinned and flagged when hiding leaves no free attached placement', async () => {
  const { planHide } = await import('../public/cell-move.js');
  const graph = { root: beads.root, parent: beads.parent, child: beads.child, b: beads.b,
    a: { ...beads.a, status: 'closed' } };
  const positions = { parent: p(0), a: p(1), child: p(2), b: p(2, 1) };
  const occupied = new Set(Object.values(positions).map((at) => `${at.q},${at.r}`));
  for (let q = -4; q <= 4; q++) for (let r = -4; r <= 4; r++) {
    if (Math.max(Math.abs(q), Math.abs(r), Math.abs(q + r)) > 4 || occupied.has(`${q},${r}`)) continue;
    const id = `wall_${q}_${r}`;
    graph[id] = { id, parentId: 'root', kind: 'work' };
    positions[id] = p(q, r);
  }
  const f = fixture(positions, graph);
  assert.equal(f.layout.attachments.child.status, 'direct');
  const hidden = new Set(['a']);
  const out = planHide({ ...f, hidden, yieldIds: hidden });
  assert.equal(out.ok, true, out.reason);
  const next = layoutCell({ ...f, saved: { ...positions, ...out.positions }, hidden, yieldIds: hidden });
  assert.equal(next.attachments.child.status, 'detached');
  assert.deepEqual(next.positions.child, positions.child);
  assert.deepEqual(next.positions.b, positions.b);
  assert.deepEqual(next.positions.parent, positions.parent);
  for (const id of Object.keys(positions).filter((id) => id.startsWith('wall_'))) assert.deepEqual(next.positions[id], positions[id]);
  assert.equal(previewMove({ ...f, layout: next, hidden, id: 'child', target: p(50) }).ok, false);
  const automatic = layoutCell({ ...f, hidden, yieldIds: hidden });
  assert.equal(automatic.attachments.child.status, 'detached');
  assert.deepEqual(automatic.positions.child, positions.child);
  assert.ok(next.detachedPinned.has('child'));
  const target = p(30);
  const moveArgs = { ...f, layout: next, hidden, yieldIds: hidden, id: 'wall_1_-1', target };
  assert.equal(previewMove(moveArgs).ok, true);
  const move = planMove(moveArgs);
  assert.equal(move.ok, true, move.reason);
  const freed = { ...positions, ...move.positions };
  for (const changed of [freed, { ...positions, 'wall_1_-1': target }]) {
    const rerendered = layoutCell({ ...f, saved: changed, hidden, yieldIds: hidden, detachedPinned: next.detachedPinned });
    assert.equal(rerendered.attachments.child.status, 'detached');
    assert.deepEqual(rerendered.positions.child, positions.child);
    assert.deepEqual(rerendered.positions.b, positions.b);
    const repair = planMove({ ...f, layout: rerendered, saved: changed, hidden, yieldIds: hidden, id: 'child', target: p(1, -1) });
    assert.equal(repair.ok, true, repair.reason);
    const attached = layoutCell({ ...f, saved: { ...changed, ...repair.positions }, hidden, yieldIds: hidden, detachedPinned: rerendered.detachedPinned });
    assert.equal(attached.attachments.child.status, 'direct');
    assert.equal(attached.detachedPinned.has('child'), false);
  }
});


test('an incomplete display defers automatic hide repair and does not record a new fallback', () => {
  const graph={root:beads.root,parent:beads.parent,a:{...beads.a,status:'closed'},child:beads.child,b:beads.b};
  const f=fixture({parent:p(0),a:p(1),child:p(2),b:p(3)},graph);
  const hidden=new Set(['a']);
  const partial=layoutCell({...f,hidden,yieldIds:hidden,snapshotComplete:false});
  assert.deepEqual(partial.positions.child,p(2));
  assert.deepEqual(partial.automatic,{});
  assert.equal(partial.detachedPinned.size,0);
  const complete=layoutCell({...f,hidden,yieldIds:hidden,snapshotComplete:true});
  assert.equal(complete.attachments.child.status,'direct');
  assert.notDeepEqual(complete.positions.child,p(2));
});
