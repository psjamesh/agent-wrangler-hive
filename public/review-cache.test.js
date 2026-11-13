import test from 'node:test';
import assert from 'node:assert/strict';
import { messageImages, disposeImages } from './attachments.js';

class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.events = {}; this.dataset = {}; this.style = {}; }
  setAttribute() {}
  addEventListener(k, fn) { this.events[k] = fn; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
}
test('R4: loaded history over 160 thumbnails must reach an idle request state', async t => {
  const previous = { document: globalThis.document, Node: globalThis.Node };
  globalThis.Node = Element;
  globalThis.document = { createElement: tag => new Element(tag), createTextNode: text => text };
  t.after(() => Object.assign(globalThis, previous));
  const ui = {}, cell = { id: 'cell_review' };
  const messages = Array.from({ length: 41 }, (_, i) => ({ id: `msg_${i}`, attachments: Array.from({ length: 4 }, (_, k) => ({ file: `shot-${k}.png` })) }));
  let count = 0;
  const replies = [];
  const render = () => { for (const m of messages) messageImages(m, cell, ui, ctx); };
  const ctx = { send(msg, { onReply }) { count++; replies.push(onReply); render(); } };
  render();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(count, 164);
  for (let i = 0; i < 350 && replies.length; i++) {
    replies.shift()({ ok: true, mime: 'image/jpeg', dataBase64: '/9j/AA==' });
    render();
    await new Promise(resolve => setImmediate(resolve));
  }
  disposeImages(ui);
  assert.equal(count, 164, `164 distinct thumbnails caused ${count} requests; ${replies.length} still pending after 350 replies`);
});
