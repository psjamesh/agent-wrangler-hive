import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom, Element, fire, press } from './helpers/dom.mjs';
import { h } from '../public/dom.js';
import { openHivePopover } from '../public/hive-popover.js';

function fixture(t) {
  installDom(t);
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
