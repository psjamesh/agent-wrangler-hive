import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom, Element, fire, press } from './helpers/dom.mjs';
import { h } from '../public/dom.js';
import { openHivePopover, disposeHivePopover } from '../public/hive-popover.js';

function fixture(t) {
  installDom(t);
  t.after(() => disposeHivePopover(undefined));
  const create = document.createElement;
  document.createElement = tag => {
    const el = create(tag);
    el.style.setProperty = (key, value) => { el.style[key] = value; };
    if (tag === 'dialog') { el.offsetWidth = 300; el.offsetHeight = 200; }
    return el;
  };
  const oldWindow = globalThis.window;
  const oldRect = Element.prototype.getBoundingClientRect;
  globalThis.window = { innerWidth: 800, innerHeight: 600 };
  Element.prototype.getBoundingClientRect = () => ({ left: 100, right: 400, top: 100, bottom: 300 });
  t.after(() => { globalThis.window = oldWindow; Element.prototype.getBoundingClientRect = oldRect; });
  const anchor = h('button', { 'data-focus-key': 'info' }, 'i');
  document.body.append(anchor);
  const details = { name: 'A hive', goal: 'Full goal\nSecond line <script>', detail: '1 closed, 2 open', owed: '2 need your input, 1 from the queen to read, 3 awaiting the queen', queen: 'Queen: working' };
  const open = () => { const close = openHivePopover(details, anchor); return { close, dialog: document.querySelector('dialog') }; };
  return { anchor, details, open };
}

test('hive details show the full goal, counts, attention and queen as text', t => {
  const f = fixture(t), { dialog, close } = f.open();
  assert.equal(dialog.open, true);
  assert.equal(dialog.getAttribute('aria-label'), 'Details for A hive');
  for (const text of Object.values(f.details)) assert.ok(dialog.textContent.includes(text), text);
  assert.equal(dialog.querySelector('script'), null);
  assert.equal(document.activeElement, dialog.querySelector('button'));
  assert.equal(dialog.querySelector('button').textContent, '×');
  assert.equal(dialog.querySelector('button').getAttribute('aria-label'), 'Close details');
  assert.equal(f.anchor.getAttribute('aria-expanded'), 'true');
  close();
  assert.equal(document.querySelector('dialog'), null);
  assert.equal(document.activeElement, f.anchor);
  assert.equal(f.anchor.getAttribute('aria-expanded'), 'false');
});

test('Escape, native cancel, Close and outside click dismiss details and return focus', t => {
  const f = fixture(t);
  for (const dismiss of [d => press(d, 'Escape'), d => fire(d, 'cancel'), d => d.querySelector('button').click(), d => {
    fire(d, 'pointerdown', { clientX: 5, clientY: 5 });
    fire(d, 'click', { clientX: 5, clientY: 5 });
  }]) {
    const { dialog } = f.open();
    dismiss(dialog);
    assert.equal(document.querySelector('dialog'), null);
    assert.equal(document.activeElement, f.anchor);
  }
});

test('clicking within details or dragging out of it does not dismiss', t => {
  const { dialog, close } = fixture(t).open();
  fire(dialog, 'pointerdown', { clientX: 200, clientY: 200 });
  fire(dialog, 'click', { clientX: 200, clientY: 200 });
  assert.equal(dialog.open, true);
  fire(dialog, 'click', { clientX: 5, clientY: 5 });
  assert.equal(dialog.open, true);
  close();
});


test('empty goal and attention omit those paragraphs without placeholder text', t => {
  const f = fixture(t);
  f.details.goal = '';
  f.details.owed = '';
  const { dialog, close } = f.open();
  assert.equal(dialog.querySelectorAll('p').length, 2);
  assert.doesNotMatch(dialog.textContent, /null/);
  close();
});


test('popover caret flips above a low anchor and clamps inside the viewport', t => {
  const f = fixture(t);
  f.anchor.getBoundingClientRect = () => ({ left: 776, right: 800, top: 550, bottom: 574 });
  const { dialog, close } = f.open();
  assert.equal(dialog.getAttribute('data-side'), 'above');
  assert.equal(dialog.style.left, '492px');
  assert.equal(dialog.style.top, '338px');
  assert.equal(dialog.style['--hive-arrow-x'], '284px');
  close();
});

test('overview details explain activity sources, waits and reconciliation as text', t => {
  const f = fixture(t);
  Object.assign(f.details, {
    activitySummary: '1 working, 1 held, not working',
    beads: { item: { title: 'Build export' } },
    graph: { sessions: [{ sessionId: 'builder', name: 'Builder' }] },
    activity: [{ beadId: 'item', reason: 'Held, not working; CI wait; Queen reconciliation needed', participants: [{ source: 'claim', sessionId: 'builder', state: 'idle' }, { source: 'launch', sessionId: null, state: 'missing' }] }],
  });
  const { dialog, close } = f.open();
  for (const text of ['1 working, 1 held, not working', 'Build export', 'CI wait', 'Queen reconciliation needed', 'Owner: Builder (idle)', 'Starting worker: No session yet (missing)']) assert.ok(dialog.textContent.includes(text), text);
  close();
});
