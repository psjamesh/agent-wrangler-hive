import test from 'node:test';
import assert from 'node:assert/strict';
import { submitForm } from '../public/form-submit.js';

function setup(initial = { text: 'a' }) {
  const forms = { k: initial };
  const sent = [], notices = [], replies = [];
  const ui = {
    form: (key) => forms[key] ?? null,
    setForm: (key, value) => { forms[key] = value; },
  };
  const ctx = { ui, send: (msg, { onReply }) => { sent.push(msg); replies.push(onReply); }, notice: (...args) => notices.push(args) };
  const calls = [];
  const options = {
    ctx, key: 'k', newId: () => 'r1',
    message: (cur) => ({ type: 'save', text: cur.text }),
    failed: 'Could not save.',
    lateFailure: (frame) => calls.push(['late', frame.error]),
    succeeded: (frame, mine) => calls.push(['ok', mine]),
  };
  return { forms, sent, notices, replies, calls, options };
}

test('submitting marks the form pending, clears the error and sends the message', () => {
  const s = setup({ text: 'a', error: 'old' });
  submitForm(s.options);
  assert.deepEqual(s.forms.k, { text: 'a', error: null, pending: 'r1' });
  assert.deepEqual(s.sent, [{ type: 'save', text: 'a' }]);
});

test('a missing form, a pending form or a failed allow check sends nothing', () => {
  const missing = setup(null);
  submitForm(missing.options);
  const pending = setup({ pending: 'x' });
  submitForm(pending.options);
  const blocked = setup();
  submitForm({ ...blocked.options, allow: () => false });
  for (const s of [missing, pending, blocked]) assert.deepEqual(s.sent, []);
  assert.deepEqual(pending.forms.k, { pending: 'x' });
  assert.deepEqual(blocked.forms.k, { text: 'a' });
});

test('a validation error is stored on the form without sending or marking it pending', () => {
  const s = setup({ text: '' });
  submitForm({ ...s.options, invalid: (cur) => !cur.text && 'Say something.' });
  assert.deepEqual(s.forms.k, { text: '', error: 'Say something.' });
  assert.deepEqual(s.sent, []);
});

test('the id is built from the current form', () => {
  const s = setup({ text: 'a', id: 'e7' });
  submitForm({ ...s.options, newId: (cur) => `${cur.id}:t` });
  assert.equal(s.forms.k.pending, 'e7:t');
});

test('a successful reply reports whether the same form is still waiting for it', () => {
  const live = setup();
  submitForm(live.options);
  live.replies[0]({ ok: true });
  assert.deepEqual(live.calls, [['ok', true]]);
  const gone = setup();
  submitForm(gone.options);
  gone.forms.k = null;
  gone.replies[0]({ ok: true });
  assert.deepEqual(gone.calls, [['ok', false]]);
  const newer = setup();
  submitForm(newer.options);
  newer.forms.k = { text: 'b', pending: 'r2' };
  newer.replies[0]({ ok: true });
  assert.deepEqual(newer.calls, [['ok', false]]);
});

test('a failed reply for the current form shows the error and clears pending, keeping edits made since', () => {
  const s = setup();
  submitForm(s.options);
  s.forms.k = { ...s.forms.k, text: 'edited' };
  s.replies[0]({ ok: false, error: 'No.' });
  assert.deepEqual(s.forms.k, { text: 'edited', error: 'No.', pending: null });
  assert.deepEqual(s.calls, []);
  const fallback = setup();
  submitForm(fallback.options);
  fallback.replies[0]({ ok: false });
  assert.equal(fallback.forms.k.error, 'Could not save.');
});

test('a failed reply for a closed or newer form goes to lateFailure and leaves the form alone', () => {
  const closed = setup();
  submitForm(closed.options);
  closed.forms.k = null;
  closed.replies[0]({ ok: false, error: 'Late.' });
  assert.deepEqual(closed.calls, [['late', 'Late.']]);
  assert.equal(closed.forms.k, null);
  const newer = setup();
  submitForm(newer.options);
  newer.forms.k = { text: 'b', pending: 'r2' };
  newer.replies[0]({ ok: false, error: 'Late.' });
  assert.deepEqual(newer.calls, [['late', 'Late.']]);
  assert.deepEqual(newer.forms.k, { text: 'b', pending: 'r2' });
});
