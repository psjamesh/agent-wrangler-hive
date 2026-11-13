import test from 'node:test';
import assert from 'node:assert/strict';
import { messageImages, disposeImages } from './attachments.js';
import { installDom } from '../test/helpers/dom.mjs';


test('R4: loaded history over 160 thumbnails must reach an idle request state', async t => {
  installDom(t);
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
