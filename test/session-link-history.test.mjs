import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { sessionLinkProblem } from '../public/session-links.js';

const source = fs.readFileSync(new URL('../public/client.js', import.meta.url), 'utf8');
const start = source.indexOf('  update(el, session, graph) {');
const updateCode = source.slice(start, source.indexOf('  unmount(el)', start));

test('archived history survives frames that omit it and follows ones that carry it', () => {
  const state = { history: [], ui: { retryRelations: () => false }, requestNotifications() {} };
  const update = vm.runInNewContext(`({${updateCode}}).update`, { state, settlePlacements() {}, rerender() {} });
  update({}, null, { sessions: [], history: [{ sessionId: 'old' }] });
  update({}, null, { sessions: [] });
  assert.match(sessionLinkProblem(state.graph.sessions, state.history, 'old'), /archived/);
  update({}, null, { sessions: [], history: null });
  assert.match(sessionLinkProblem(state.graph.sessions, state.history, 'old'), /not on the board/);
});
