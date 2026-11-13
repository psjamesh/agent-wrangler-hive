import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionLinkId, sessionLinkProblem, bareSessionLinks } from './session-links.js';

const ID = '00000000-0000-4000-8000-0000000000a1';

test('a session fragment href yields its decoded id', () => {
  assert.equal(sessionLinkId(`#session=${ID}`), ID);
  assert.equal(sessionLinkId('#session=a%20b'), 'a b');
  for (const href of ['', '#session=', '#view=search', `http://localhost:7777/#session=${ID}`, '#session=%E0%A4%A', `#session=${ID}&x=1`]) assert.equal(sessionLinkId(href), null);
});

test('unknown and archived sessions give a message, known ones none', () => {
  const sessions = [{ sessionId: 'live' }];
  const history = [{ sessionId: 'old' }];
  assert.equal(sessionLinkProblem(sessions, history, 'live'), null);
  assert.match(sessionLinkProblem(sessions, history, 'old'), /archived/);
  assert.match(sessionLinkProblem(sessions, history, 'nope'), /not on the board/);
  assert.match(sessionLinkProblem(sessions, undefined, 'old'), /not on the board/);
  assert.match(sessionLinkProblem(null, history, 'nope'), /unknown/);
});

test('bare session fragments are found, URLs are left to the renderer', () => {
  assert.deepEqual(bareSessionLinks(`see #session=${ID}, thanks`).map(f => [f.index, f.id]), [[4, ID]]);
  assert.equal(bareSessionLinks(`http://localhost:7777/#session=${ID}`).length, 0);
  assert.equal(bareSessionLinks('#session=').length, 0);
});
