import test from 'node:test';
import assert from 'node:assert/strict';
import { messageImages, disposeImages } from './attachments.js';

class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.attributes = {}; this.events = {}; this.style = {}; this.dataset = {}; this.classList = { contains() { return false; } }; }
  setAttribute(k, v) { this.attributes[k] = v; if (k === 'data-focus-key') this.dataset.focusKey = v; }
  addEventListener(k, fn) { (this.events[k] ||= []).push(fn); }
  fire(k, props = {}) { for (const fn of this.events[k] || []) fn({ preventDefault() {}, stopPropagation() {}, ...props }); }
  append(...nodes) { this.children.push(...nodes); for (const n of nodes) if (n instanceof Element) { n.parent = this; n.isConnected = true; } }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  showModal() { this.open = true; }
  close() { this.open = false; this.fire('close'); }
  focus() { document.activeElement = this; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(n => n !== this); this.isConnected = false; }
}
const settle = () => new Promise(r => setImmediate(r));
test('R7: an evicted full image must be fetched again when explicitly reopened', async t => {
  const before = { document: globalThis.document, Node: globalThis.Node };
  globalThis.Node = Element;
  globalThis.document = { createElement: tag => new Element(tag), createTextNode: text => String(text), querySelector: () => null, querySelectorAll: () => [], body: new Element('body') };
  t.after(() => Object.assign(globalThis, before));
  const ui = {}, requests = [];
  const big = 'A'.repeat(Math.ceil((5 * 1024 * 1024) / 3) * 4);
  const ctx = { send(msg, { onReply }) { requests.push(msg); onReply({ ok: true, mime: 'image/png', dataBase64: msg.full ? big : 'AQ==' }); } };
  const rows = Array.from({ length: 7 }, (_, i) => messageImages({ id: `msg_${i}`, attachments: [{ file: 'a.png' }] }, { id: 'cell_review' }, ui, ctx));
  await settle();
  for (const row of rows) {
    row.children[0].fire('click'); await settle();
    document.body.children[0].close();
  }
  const firstRequests = requests.filter(r => r.full && r.messageId === 'msg_0').length;
  rows[0].children[0].fire('click'); await settle();
  const secondRequests = requests.filter(r => r.full && r.messageId === 'msg_0').length;
  const stage = document.body.children[0].children[0];
  disposeImages(ui);
  assert.equal(secondRequests, firstRequests + 1, `no new request; stage says ${stage.children[0]?.children[0]}`);
});
