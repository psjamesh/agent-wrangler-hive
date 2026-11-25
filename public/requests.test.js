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
  assert.match(opened[0], /hive=cell&topic=topic$/);
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

test('rewritten notification uses the queen title and body', () => {
  const shown = [];
  const notify = createRequestNotifications({ ui: { notify: args => { shown.push(args); return new Promise(() => {}); } } });
  notify(graph());
  notify(graph(request('rewrite', { forwarded: { title: 'Plain title', body: 'Plain body' } })));
  assert.equal(shown[0].title, 'Plain title');
  assert.equal(shown[0].body, 'Plain body');
});

test('notification after a worker edit uses its current title rather than the stale rewrite', () => {
  const shown = [];
  const notify = createRequestNotifications({ ui: { notify: args => { shown.push(args); return new Promise(() => {}); } } });
  notify(graph());
  notify(graph(request('edited', { title: 'Current title', contentRevision: 2, forwarded: { title: 'Earlier title', body: 'Earlier body', contentRevision: 1 } })));
  assert.equal(shown[0].title, 'Current title');
  assert.notEqual(shown[0].body, 'Earlier body');
});

test('delivery-repair notifications preserve their exact request card link', async () => {
  let action, href;
  const notify = createRequestNotifications({ ui: { notify: () => new Promise(resolve => { action = resolve; }) } }, { open: url => { href = url; } });
  notify(graph());
  notify(graph(request('repair', { state: 'answered', delivery: { state: 'failed' } })));
  action('open');
  await Promise.resolve();
  assert.match(href, /hive=cell&topic=topic&message=message$/);
});

function notificationFor(extra) {
  let shown;
  const notify = createRequestNotifications({ ui: { notify(args) { shown = args; } } });
  notify(graph());
  const r = request('excerpt', { forwarded: { title: extra.title, body: extra.body }, ...extra }), original = structuredClone(r);
  notify(graph(r));
  assert.deepEqual(r, original);
  return shown;
}

test('notification excerpts keep short and exact-boundary text intact', () => {
  for (const [title, body] of [['Short title', 'A short body.'], ['t'.repeat(80), 'b'.repeat(120)]]) {
    const shown = notificationFor({ title, body });
    assert.equal(shown.title, title);
    assert.equal(shown.body, body);
  }
});

for (const state of ['open', 'answered']) test(`${state} notification excerpts truncate whole words and flatten Markdown`, () => {
  const title = 'Review '.repeat(20).trim();
  const body = '# **Please review** [the proposal](https://example.com/proposal).\n\n> - Choose `option_one` and ~~obsolete~~ *details*.\n'.repeat(6);
  const shown = notificationFor({ title, body, forwarded: { title, body }, state, delivery: { state: 'failed' } });
  assert.equal(shown.title, state === 'answered' ? 'Hive answer needs delivery repair' : `${'Review '.repeat(11).trim()}…`);
  assert.equal(shown.body, 'Please review the proposal. Choose option_one and obsolete details. Please review the proposal. Choose option_one and…');
  assert.ok(shown.title.length <= 80);
  assert.ok(shown.body.length <= 120);
  assert.doesNotMatch(shown.body, /[\n\r#*`>~]|https:/);
});

test('notification truncation does not cut the final word or add an ellipsis to whitespace', () => {
  const shown = notificationFor({ title: `${'t'.repeat(79)} word`, body: `${'b'.repeat(119)} word` });
  assert.equal(shown.title, `${'t'.repeat(79)}…`);
  assert.equal(shown.body, `${'b'.repeat(119)}…`);
  assert.equal(notificationFor({ body: '  Short\n\ttext  ' }).body, 'Short text');
  assert.equal(notificationFor({ body: 'b'.repeat(121) }).body, `${'b'.repeat(119)}…`);
});

test('overlong first tokens stay informative without splitting Unicode characters', () => {
  for (const body of [`https://example.com/${'a'.repeat(120)} needs a decision`, '🔥'.repeat(121)]) {
    assert.equal(notificationFor({ body }).body, `${Array.from(body).slice(0, 119).join('')}…`);
  }
  const title = '🔥'.repeat(81);
  assert.equal(notificationFor({ title }).title, `${'🔥'.repeat(79)}…`);
  assert.equal(notificationFor({ title: '🔥'.repeat(80) }).title, '🔥'.repeat(80));
});

test('plain excerpts preserve angle brackets in comparisons, types and literal HTML', () => {
  for (const body of ['Should limit be x < 5 and y > 3 for the retry policy?', 'Use Map<string, number> for the cache?', 'Return Promise<void> from the handler?', 'Use List<T> or Array<string>?', 'Is a<b and c>d true?']) {
    assert.equal(notificationFor({ body }).body, body);
  }
  const html = '<STRONG>Review</STRONG> <a href="https://example.com">the proposal</a>.';
  assert.equal(notificationFor({ body: html }).body, html);
});

for (const state of ['open', 'answered']) test(`${state} notifications preserve warning and generic fallbacks for unrewritten requests`, () => {
  const extra = { body: 'Original question stays in the request card.', forwarded: null, state, delivery: { state: 'failed' } };
  for (const warning of ['No queen in this hive', 'Hive is unavailable; queen routing is paused']) {
    assert.equal(notificationFor({ ...extra, warning }).body, warning);
  }
  assert.equal(notificationFor(extra).body, 'Hive request needs you');
});
