import test from 'node:test';
import assert from 'node:assert/strict';

class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.attributes = {}; this.events = {}; this.dataset = {}; this.isConnected = false; }
  setAttribute(k, v) { this.attributes[k] = v; if (k === 'data-focus-key') this.dataset.focusKey = v; }
  addEventListener(k, fn) { (this.events[k] ||= []).push(fn); }
  fire(k, props = {}) { const e = { preventDefault() { this.prevented = true; }, stopPropagation() {}, ...props }; for (const fn of this.events[k] || []) fn(e); return e; }
  append(...nodes) { this.children.push(...nodes); for (const n of nodes) if (n instanceof Element) { n.parent = this; n.isConnected = true; } }
  showModal() { this.open = true; }
  close() { this.open = false; this.fire('close'); }
  focus() { document.activeElement = this; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(n => n !== this); this.isConnected = false; }
}
const all = el => [el, ...el.children.filter(n => n instanceof Element).flatMap(all)];
function dom(t) {
  const before = { document: globalThis.document, Node: globalThis.Node };
  globalThis.Node = Element;
  const body = new Element('body');
  globalThis.document = { body, createElement: tag => new Element(tag), createTextNode: String, querySelectorAll: () => all(body) };
  const opener = new Element('button'); opener.setAttribute('data-focus-key', 'opener'); body.append(opener); opener.focus();
  t.after(() => Object.assign(globalThis, before));
  return { body, opener };
}

test('Hive confirmation defaults to Cancel, traps Tab, and Escape cancels and restores focus', async t => {
  const { body, opener } = dom(t);
  const { confirmHive } = await import('../public/confirm-dialog.js');
  const result = confirmHive('Send again?');
  const dialog = all(body).find(e => e.tagName === 'dialog');
  const buttons = all(dialog).filter(e => e.tagName === 'button');
  assert.equal(dialog.open, true);
  assert.equal(document.activeElement, buttons[0]);
  dialog.fire('keydown', { key: 'Tab', shiftKey: true });
  assert.equal(document.activeElement, buttons.at(-1));
  dialog.fire('keydown', { key: 'Tab' });
  assert.equal(document.activeElement, buttons[0]);
  dialog.fire('cancel');
  assert.equal(await result, false);
  assert.equal(document.activeElement, opener);
  assert.equal(body.children.includes(dialog), false);
});

test('confirmation accepts explicitly and restores a replacement opener after rerender', async t => {
  const { body, opener } = dom(t);
  const { confirmHive } = await import('../public/confirm-dialog.js');
  const result = confirmHive('Rearrange?');
  const dialog = all(body).find(e => e.tagName === 'dialog');
  opener.remove();
  const replacement = new Element('button'); replacement.setAttribute('data-focus-key', 'opener'); body.append(replacement);
  assert.equal(dialog.isConnected, true);
  all(dialog).filter(e => e.tagName === 'button').at(-1).fire('click');
  assert.equal(await result, true);
  assert.equal(document.activeElement, replacement);
});

test('Hive text prompt returns entered text on submit and null on Cancel', async t => {
  const { body } = dom(t);
  const { promptHive } = await import('../public/confirm-dialog.js');
  const result = promptHive('Why release?');
  let dialog = all(body).find(e => e.tagName === 'dialog');
  const input = all(dialog).find(e => e.tagName === 'textarea');
  assert.equal(document.activeElement, input);
  input.value = 'Finished work';
  all(dialog).filter(e => e.tagName === 'button').at(-1).fire('click');
  assert.equal(await result, 'Finished work');
  const cancelled = promptHive('What happened?');
  dialog = all(body).find(e => e.tagName === 'dialog');
  all(dialog).filter(e => e.tagName === 'button')[0].fire('click');
  assert.equal(await cancelled, null);
});
