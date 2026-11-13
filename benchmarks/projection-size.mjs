import { projectForGraph } from '../server/projection.js';
import { fullBead } from '../server/bead-detail.js';

const prose = 'Measured worker update: the conversation opens the task and explains the implementation, validation evidence and next action. **Validation** passed all focused checks.\n\n- Reproduce with isolated data.\n- Measure rendering and input latency.\n\n```js\nconst result = await investigate({ isolated: true });\n```\n\n';
const beads = {};
const doc = { cells: {}, bindings: {}, reviews: {}, beadLayout: {}, arrangeAspect: {}, archived: {}, restoreNotices: {}, conversation: {}, threads: {}, operations: {}, launches: {}, requests: {}, workstreamColours: {}, workstreamShades: {}, inbox: {} };
for (let c = 0; c < 5; c++) {
  const root = `root${c}`;
  doc.cells[`cell${c}`] = { id: `cell${c}`, enabled: true, rootBeadId: root };
  beads[root] = { id: root, title: `Project ${c}`, kind: 'goal', status: 'in_progress', parentId: null, goal: 'Profile the client', acceptance: prose, summary: '', evidence: [] };
  const n = c === 0 ? 196 : 6;
  for (let i = 1; i < n; i++) {
    beads[`b${c}-${i}`] = { id: `b${c}-${i}`, title: `Investigate component ${i}`, kind: i < 7 ? 'workstream' : 'work', status: i % 4 === 0 ? 'closed' : i % 9 === 0 ? 'in_progress' : 'open', parentId: i < 7 ? root : `b${c}-${1 + i % 6}`, ownerSessionId: null, assignee: null, goal: prose, acceptance: prose, summary: prose.repeat(6), nextAction: 'Next', waitingFor: '', evidence: Array.from({ length: 8 }, (_, j) => ({ label: `Validation ${j}`, detail: prose.repeat(8), kind: 'test' })) };
  }
}
const graph = { beads, edges: [] };
const runtime = { metadata: { read: () => doc, cells: () => Object.values(doc.cells) }, beads: { status: {} }, paths: {}, host: {}, snapshots: { graph, current: { graph, revision: 1 } } };
const slim = projectForGraph({ runtime, snapshot: runtime.snapshots.current });
const full = { ...slim, beads: Object.fromEntries(Object.keys(slim.beads).map((id) => [id, fullBead(runtime, graph, id)])) };
const parse = (text) => { const t = performance.now(); JSON.parse(text); return performance.now() - t; };
const median = (f) => { const xs = Array.from({ length: 20 }, f).sort((a, b) => a - b); return xs[10]; };
const a = JSON.stringify(full), b = JSON.stringify(slim);
console.log(JSON.stringify({ beads: Object.keys(beads).length, beforeBytes: a.length, afterBytes: b.length, reduction: `${Math.round((1 - b.length / a.length) * 100)}%`, beforeParseMs: median(() => parse(a)), afterParseMs: median(() => parse(b)) }, null, 1));
