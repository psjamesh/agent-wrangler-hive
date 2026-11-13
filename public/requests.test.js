import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequestNotifications } from './requests.js';
const request = (id, extra = {}) => ({ id, cellId: 'cell', threadId: 'topic', messageId: 'message', title: 'API decision', state: 'open', audience: 'human', routeRevision: 1, revision: 1, ...extra });
const graph = (...items) => ({ cells: { cell: { requests: Object.fromEntries(items.map(r => [r.id, r])) } } });
test('notifications seed backlog, dedupe episodes, use host action promise and withdraw settled cards', async () => {
  const shown = [], withdrawn = [], opened = [];
  let action;
  const api = { settings: () => ({}), ui: { notify: args => { shown.push(args); return new Promise(r => { action = r; }); }, withdraw: id => withdrawn.push(id) } };
  const notify = createRequestNotifications(api, { open: href => opened.push(href) });
  notify(graph(request('old')));
  assert.equal(shown.length, 0);
  const r = request('fresh');
  notify(graph(r)); notify(graph(r));
  assert.equal(shown.length, 1);
  assert.equal(shown[0].actions[0].id, 'open');
  action('open'); await Promise.resolve();
  assert.match(opened[0], /message=message/);
  notify(graph({ ...r, state: 'answered', delivery: { state: 'delivered' } }));
  assert.equal(withdrawn.length, 1);
});
test('worker queen-stage requests do not toast human and mute is respected', () => {
  let count = 0;
  const api = { settings: () => ({ requestNotifications: false }), ui: { notify() { count++; } } };
  const notify = createRequestNotifications(api);
  notify(graph()); notify(graph(request('worker', { audience: 'queen' }))); notify(graph(request('human')));
  assert.equal(count, 0);
});
test('saving an answer does not toast a repair until delivery fails or is uncertain', () => {
  let count = 0;
  const notify = createRequestNotifications({ settings: () => ({}), ui: { notify() { count++; } } });
  notify(graph());
  const r = request('answer', { state: 'answered', delivery: { state: 'pending', attempts: [{ id: 'first' }] } });
  notify(graph(r)); assert.equal(count, 0);
  notify(graph({ ...r, delivery: { ...r.delivery, state: 'uncertain' } })); assert.equal(count, 1);
});

test('failed queen answer delivery never creates a human alert', () => {
  let count = 0;
  const notify = createRequestNotifications({ settings: () => ({}), ui: { notify() { count++; } } });
  notify(graph());
  notify(graph(request('queen-answer', { audience: 'queen', state: 'answered', delivery: { state: 'failed' } })));
  assert.equal(count, 0);
});

test('pop-up offers all options in order and submits choice with captured revisions once', async () => {
  const shown = [], sent = [], opened = [];
  let action;
  const api = { settings: () => ({}), ui: { notify: args => { shown.push(args); return new Promise(resolve => { action = resolve; }); } } };
  const notify = createRequestNotifications(api, { open: href => opened.push(href), answer: (r, optionId) => sent.push({ r, optionId }) });
  notify(graph());
  const r = request('choices', { options: [{ id: 'a', label: 'A (Recommended)' }, { id: 'b', label: 'B' }] });
  notify(graph(r));
  assert.deepEqual(shown[0].actions.map(a => a.label), ['A (Recommended)', 'B', 'View request']);
  action('option:a'); await Promise.resolve();
  assert.deepEqual(sent.map(x => [x.r.revision, x.optionId]), [[1, 'a']]);
  assert.equal(opened.length, 0);
});

test('obsolete pop-up actions cannot answer after options change or request settles', async () => {
  let resolve;
  const sent = [], opened = [], shown = [];
  const notify = createRequestNotifications({ settings: () => ({}), ui: { notify: args => { shown.push(args); return new Promise(r => { resolve = r; }); }, withdraw() {} } }, { answer: (...args) => sent.push(args), open: url => opened.push(url) });
  notify(graph());
  const r = request('stale', { contentRevision: 1, options: [{ id: 'a', label: 'A' }] });
  notify(graph(r));
  const old = resolve;
  notify(graph({ ...r, revision: 2, contentRevision: 2, options: [{ id: 'b', label: 'B' }] }));
  old('option:a'); await Promise.resolve();
  assert.equal(sent.length, 0);
  assert.equal(shown.length, 2);
  notify(graph({ ...r, state: 'answered', delivery: { state: 'delivered' } }));
  resolve('option:b'); await Promise.resolve();
  assert.equal(sent.length, 0);
});

for (const count of [0, 1, 2, 3, 6]) test(`pop-up with ${count} options respects the host limit without showing a biased subset`, () => {
  const shown = [];
  const notify = createRequestNotifications({ settings: () => ({}), ui: { notify: args => { shown.push(args); return new Promise(() => {}); } } }, { answer() {} });
  notify(graph());
  const options = Array.from({ length: count }, (_, i) => ({ id: `o${i}`, label: `Choice ${i}` }));
  notify(graph(request(`count-${count}`, { options })));
  assert.deepEqual(shown[0].actions.map(a => a.label), [...(count > 0 && count <= 2 ? options.map(o => o.label) : []), 'View request']);
  assert.ok(shown[0].actions.length <= 3);
});
