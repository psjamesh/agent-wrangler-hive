import test from 'node:test';
import assert from 'node:assert/strict';
import { createAutoFit, sameTransform } from './auto-fit.js';

function setup(t, options = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const calls = [], states = [], view = { auto: true };
  const control = createAutoFit({ view, fit: animate => calls.push(animate), changed: state => states.push(state), ...options });
  return { control, calls, states, view };
}

test('board and resize triggers debounce into one refit 200ms after the last change', t => {
  const { control, calls } = setup(t);
  control.schedule();
  t.mock.timers.tick(150);
  control.schedule();
  t.mock.timers.tick(199);
  assert.equal(calls.length, 0);
  t.mock.timers.tick(1);
  assert.deepEqual(calls, [undefined]);
  control.schedule();
  t.mock.timers.tick(200);
  assert.equal(calls.length, 2);
});

test('manual gestures cancel pending refits until Fit or toggle resumes', t => {
  const { control, calls, states, view } = setup(t);
  control.schedule();
  control.suspend();
  control.schedule();
  t.mock.timers.tick(500);
  assert.equal(calls.length, 0);
  assert.deepEqual(states.at(-1), { enabled: true, paused: true });
  control.resume();
  assert.equal(view.auto, true);
  assert.deepEqual(calls, [true]);
  control.suspend();
  control.toggle();
  assert.deepEqual(states.at(-1), { enabled: true, paused: false });
  assert.deepEqual(calls, [true, true]);
});

test('viewer preference defaults on, persists off and on, and tolerates storage failures', t => {
  const saved = new Map();
  const storage = { get: key => saved.get(key), set: (key, value) => saved.set(key, value) };
  const { control, calls, states } = setup(t, { storage });
  control.toggle();
  assert.equal(saved.get('autoFit'), 'false');
  control.resume();
  control.schedule();
  t.mock.timers.tick(200);
  assert.equal(calls.length, 1);
  assert.deepEqual(states.at(-1), { enabled: false, paused: false });
  const other = createAutoFit({ storage, view: { auto: true }, fit: () => calls.push('other') });
  other.schedule();
  t.mock.timers.tick(200);
  assert.equal(calls.length, 1);
  other.toggle();
  assert.equal(saved.get('autoFit'), 'true');
  const broken = createAutoFit({ storage: { get() { throw Error(); }, set() { throw Error(); } }, view: { auto: true }, fit() {} });
  assert.doesNotThrow(() => { broken.toggle(); broken.toggle(); });
});

test('disposed maps cancel pending work and cannot schedule more', t => {
  const { control, calls } = setup(t);
  control.schedule();
  control.dispose();
  control.schedule();
  t.mock.timers.tick(500);
  assert.equal(calls.length, 0);
});

test('unchanged rendered transforms are skipped at SVG precision', () => {
  const view = { k: 1, tx: 12, ty: -8 };
  assert.equal(sameTransform(view, { k: 1.000001, tx: 12.001, ty: -8.001 }), true);
  assert.equal(sameTransform(view, { ...view, tx: 12.2 }), false);
  assert.equal(sameTransform(view, null), null);
});
