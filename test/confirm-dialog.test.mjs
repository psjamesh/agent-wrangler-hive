import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom, byTag, press, fire } from './helpers/dom.mjs';

function dom(t) {
  installDom(t);
  const opener = document.createElement('button');
  opener.setAttribute('data-focus-key', 'opener');
  document.body.append(opener);
  opener.focus();
  return { body: document.body, opener };
}

const buttons = dialog => byTag(dialog, 'button');

test('Hive confirmation defaults to Cancel, traps Tab, and Escape cancels and restores focus', async t => {
  const { body, opener } = dom(t);
  const { confirmHive } = await import('../public/confirm-dialog.js');
  const result = confirmHive('Send again?');
  const dialog = body.querySelector('dialog');
  const [cancel, accept] = buttons(dialog);
  assert.equal(dialog.open, true);
  assert.equal(document.activeElement, cancel);
  press(dialog, 'Tab', { shiftKey: true });
  assert.equal(document.activeElement, accept);
  press(dialog, 'Tab');
  assert.equal(document.activeElement, cancel);
  const escape = press(dialog, 'Escape');
  assert.equal(escape.defaultPrevented, true);
  assert.equal(await result, false);
  assert.equal(document.activeElement, opener);
  assert.equal(body.contains(dialog), false);
});

test('a native cancel event resolves false, is default-prevented, removes the dialog and restores focus', async t => {
  const { body, opener } = dom(t);
  const { confirmHive } = await import('../public/confirm-dialog.js');
  const result = confirmHive('Send again?');
  const dialog = body.querySelector('dialog');
  const cancel = fire(dialog, 'cancel');
  assert.equal(cancel.defaultPrevented, true);
  assert.equal(await result, false);
  assert.equal(body.contains(dialog), false);
  assert.equal(document.activeElement, opener);
});

test('confirmation accepts explicitly and restores a replacement opener after rerender', async t => {
  const { body, opener } = dom(t);
  const { confirmHive } = await import('../public/confirm-dialog.js');
  const result = confirmHive('Rearrange?');
  const dialog = body.querySelector('dialog');
  opener.remove();
  const replacement = document.createElement('button');
  replacement.setAttribute('data-focus-key', 'opener');
  body.append(replacement);
  assert.equal(dialog.isConnected, true);
  buttons(dialog).at(-1).click();
  assert.equal(await result, true);
  assert.equal(document.activeElement, replacement);
});

test('Hive text prompt returns entered text on submit and null on Cancel', async t => {
  const { body } = dom(t);
  const { promptHive } = await import('../public/confirm-dialog.js');
  const result = promptHive('Why release?');
  let dialog = body.querySelector('dialog');
  const input = dialog.querySelector('textarea');
  assert.equal(document.activeElement, input);
  input.value = 'Finished work';
  buttons(dialog).at(-1).click();
  assert.equal(await result, 'Finished work');
  const cancelled = promptHive('What happened?');
  dialog = body.querySelector('dialog');
  buttons(dialog)[0].click();
  assert.equal(await cancelled, null);
});
