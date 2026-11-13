import { key, neighbour, landscapeOffsets, blockedPoints, restPoints, occupiedIn } from './hex-layout.js';
import { freeShifts, inRange, span, nearestFree } from './hex-search.js';
import { attachmentState, subtreeMembers, regionBoundary, attachedCandidates, nearestTarget, preservesAttachments } from './region-attachments.js';

export function growAttachedRegion({ members, todo, layout, kids, taken, aspect, carried, automatic, hidden }) {
  const head = members[0], parent = layout.regionParents[head];
  const hasChildren = Object.values(layout.regionParents).includes(head);
  if (!parent && !hasChildren) return false;
  const positions = layout.positions;
  let top = head;
  while (layout.regionParents[top]) top = layout.regionParents[top];
  const family = subtreeMembers(layout, kids, top);
  const rank = (a,b,anchor) => span({q:a.q-anchor.q,r:a.r-anchor.r}) - span({q:b.q-anchor.q,r:b.r-anchor.r}) ||
    3 * ((a.q-anchor.q+(a.r-anchor.r)/2)/aspect)**2 + 2.25*(a.r-anchor.r)**2 -
    3 * ((b.q-anchor.q+(b.r-anchor.r)/2)/aspect)**2 - 2.25*(b.r-anchor.r)**2 || a.r-b.r || a.q-b.q;
  const detached = (ids, anchor) => {
    for (const id of ids) {
      const off = nearestFree([anchor], blockedPoints(taken));
      const p = { q: anchor.q + off.q, r: anchor.r + off.r };
      positions[id] = p;
      taken.add(key(p));
    }
  };
  const shifted = (extra) => {
    const ids = [...family].filter((id) => positions[id]);
    const own = new Set(ids.map((id) => key(positions[id])));
    const rest = restPoints(taken, own);
    const shape = {...Object.fromEntries(ids.map((id)=>[id,positions[id]])),...extra};
    const carriedIds = [...family].filter((id)=>carried[id]);
    const off = freeShifts([{shape:Object.values(shape),taken:rest},{shape:carriedIds.map((id)=>carried[id]),taken:[]}]).next().value;
    if (!off) return false;
    for (const id of ids) taken.delete(key(positions[id]));
    for (const [id,p] of Object.entries(shape)) {
      positions[id]={q:p.q+off.q,r:p.r+off.r};
      taken.add(key(positions[id]));
      automatic.add(id);
    }
    for (const id of carriedIds) {
      carried[id]={q:carried[id].q+off.q,r:carried[id].r+off.r};
      automatic.add(id);
    }
    return true;
  };
  const attachedPlacement = (shape, busy, anchor) => {
    const state = attachmentState(layout,kids,positions,hidden);
    const border = state.familyBounds.get(head);
    let best = null;
    for (const candidate of attachedCandidates(shape,border,anchor)) {
      const dq=candidate.q-anchor.q,dr=candidate.r-anchor.r;
      const points=shape.map((p)=>({q:p.q+dq,r:p.r+dr}));
      if (!points.every((p)=>inRange(p)&&!busy.has(key(p))&&border.outside(p))) continue;
      const extra=Object.fromEntries(todo.map((id,i)=>[id,points[i]]));
      if (!preservesAttachments(layout,kids,{...positions,...extra},hidden,null,hidden,state)) continue;
      if (!best || nearestTarget(candidate,best.candidate,anchor)<0) best={candidate,extra};
    }
    return best;
  };
  const placed=members.filter((id)=>positions[id]);
  if (!placed.length) {
    if (!parent) return false;
    const anchor=positions[parent];
    const shape=landscapeOffsets(todo.length,aspect).map((p)=>({q:p.q+anchor.q,r:p.r+anchor.r}));
    let spot=attachedPlacement(shape,taken,anchor)||attachedPlacement(shape,{has:(k)=>occupiedIn(taken,k)},anchor);
    if (spot) {
      for (const [id,p] of Object.entries(spot.extra)) { positions[id]=p;taken.add(key(p)); }
    } else {
      const own=new Set([...family].filter((id)=>positions[id]).map((id)=>key(positions[id])));
      spot=attachedPlacement(shape,own,anchor);
      if (!spot || !shifted(spot.extra)) detached(todo, anchor);
    }
    return true;
  }
  for (const id of todo) {
    const anchor=positions[head]||positions[placed[0]];
    const group=subtreeMembers(layout,kids,head);
    const border=regionBoundary([...group].filter((id)=>positions[id]&&!hidden.has(id)).map((id)=>positions[id]));
    const baseline=attachmentState(layout,kids,positions,hidden);
    const valid=(p)=>preservesAttachments(layout,kids,{...positions,[id]:p},hidden,null,hidden,baseline);
    const ranked=[...border.frontier.values()].filter((p)=>!occupiedIn(taken,key(p))&&valid(p)).sort((a,b)=>rank(a,b,anchor));
    const spots=ranked.some((p)=>!taken.has(key(p)))?ranked.filter((p)=>!taken.has(key(p))):ranked;
    if (spots.length) {
      positions[id]=spots[0];taken.add(key(spots[0]));
    } else {
      const own=new Set([...family].filter((id)=>positions[id]).map((id)=>key(positions[id])));
      const candidates=[...border.frontier.values()].filter((p)=>!own.has(key(p))&&valid(p)).sort((a,b)=>rank(a,b,anchor));
      if (!candidates.length || !shifted({[id]:candidates[0]})) detached([id], anchor);
    }
    placed.push(id);
  }
  return true;
}
