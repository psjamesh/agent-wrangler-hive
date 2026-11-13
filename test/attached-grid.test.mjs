import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { key, neighbour, DIRECTIONS } from '../public/hex-layout.js';

const source=fs.readFileSync(new URL('../public/hex-grid.js',import.meta.url),'utf8');

test('pointer release uses the drop resolver and arrow keys use the exact one-step move',()=>{
  const events={},moves=[],drops=[];
  const g={classList:{add(){},remove(){}},setPointerCapture(){},setAttribute(){},addEventListener:(name,fn)=>{events[name]=fn;}};
  const sandbox={key,neighbour,DIRECTIONS,DRAG_THRESHOLD:6,args:{
    g,it:{id:'child',x:0,y:0,local:{q:0,r:0}},toWorld:(e)=>({x:e.clientX,y:e.clientY}),snap:(p)=>({q:p.x/10,r:0}),
    onMove:(id,p)=>moves.push(p),onDrop:(id,p)=>drops.push(p),onDragState(){},aid:()=>({start(){},follow(){},stop(){}}),
  }};
  vm.runInNewContext(source.slice(source.indexOf('function wireTile('))+'\nwireTile(args);',sandbox);
  const event=(extra={})=>({button:0,pointerType:'mouse',pointerId:1,clientX:0,clientY:0,stopPropagation(){},preventDefault(){},...extra});
  events.pointerdown(event());events.pointermove(event({clientX:20}));events.pointerup(event({clientX:20}));
  assert.deepEqual(drops,[{q:2,r:0}]);assert.equal(moves.length,0);
  events.keydown(event({key:'ArrowRight',shiftKey:true}));
  assert.deepEqual(moves,[{q:1,r:0}]);assert.equal(drops.length,1);
});

test('all descendant outlines follow and reset with the dragged constellation',()=>{
  const outline=()=>({classes:new Set(),attributes:{},classList:{add(...names){for(const name of names)this.owner.classes.add(name);},remove(...names){for(const name of names)this.owner.classes.delete(name);}},setAttribute(k,v){this.attributes[k]=v;},removeAttribute(k){delete this.attributes[k];}});
  const parent=outline(),child=outline(),unrelated=outline();
  for(const o of [parent,child,unrelated])o.classList.owner=o;
  const sandbox={dragGroup:()=>({ids:['parent'],outlines:['parent','child']}),movePreview:()=>({ok:true,moves:{}}),
    onDragStart(){},outlineEls:new Map([['parent',parent],['child',child],['other',unrelated]]),tileEls:new Map(),dropLayer:{replaceChildren(){}},
    h(){},toPixel(){},size:60,id:'fixture',key,
  };
  const start=source.indexOf('  const place = (el, x, y)');
  const end=source.indexOf('  const setMark =',start);
  const aid=vm.runInNewContext(source.slice(start,end)+'\ndragAid;',sandbox);
  aid.start('parent');aid.follow({id:'parent',x:0,y:0,local:{q:0,r:0}},{x:10,y:20},{q:1,r:0});
  assert.equal(parent.attributes.transform,'translate(10.0 20.0)');
  assert.equal(child.attributes.transform,'translate(10.0 20.0)');
  assert.equal(unrelated.attributes.transform,undefined);
  aid.stop();
  assert.equal(parent.attributes.transform,undefined);assert.equal(child.attributes.transform,undefined);
});
