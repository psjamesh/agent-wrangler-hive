import test from 'node:test';
import assert from 'node:assert/strict';
import { imageSources, sourceToFrame } from './clipboard-images.js';
import { imageComposer, imageDraft, messageImages } from './attachments.js';

class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.attributes = {}; this.events = {}; this.style = {}; this.dataset = {}; this.classList = { add() {}, remove() {} }; }
  setAttribute(k, v) { this.attributes[k] = v; if (k === 'data-focus-key') this.dataset.focusKey = v; if (k === 'disabled') this.disabled = true; }
  addEventListener(k, fn) { (this.events[k] ||= []).push(fn); }
  fire(k, props = {}) { const e = { preventDefault() { this.prevented = true; }, stopPropagation() {}, ...props }; for (const fn of this.events[k] || []) fn(e); this['on' + k]?.(e); return e; }
  append(...nodes) { this.children.push(...nodes); for (const n of nodes) if (n instanceof Element) { n.parent = this; n.isConnected = true; } }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  showModal() { this.open = true; }
  close() { this.open = false; this.fire('close'); }
  focus() { document.activeElement = this; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((n) => n !== this); this.isConnected = false; }
}
const descendants = (el) => [el, ...el.children.filter((n) => n instanceof Element).flatMap(descendants)];
function dom(t) {
  const before = { document: globalThis.document, Node: globalThis.Node };
  globalThis.Node = Element;
  globalThis.document = { createElement: (tag) => new Element(tag), createTextNode: (text) => String(text), querySelector: () => null, querySelectorAll: () => [], body: new Element('body') };
  t.after(() => Object.assign(globalThis, before));
}
const settle = () => new Promise((r) => setImmediate(r));
const png = () => Object.assign(new Blob(['original bytes'], { type: 'image/png' }), { name: 'shot.png' });

test('clipboard finds pasted files, Finder items and readable image sources without local paths', () => {
  const file = png();
  assert.equal(imageSources({ files: [file] })[0].file, file);
  assert.equal(imageSources({ items: [{ kind: 'file', getAsFile: () => file }] })[0].file, file);
  const dt = (html) => ({ getData: (type) => type === 'text/html' ? html : '' });
  assert.deepEqual(imageSources(dt('<img src="file:///private/x.png"><img src="blob:secret"><img src="https://example.com/a.png">')), [{ src: 'https://example.com/a.png' }]);
});

test('staging sends allowed original bytes without re-encoding and refuses unsupported or large images', async () => {
  const frame = await sourceToFrame({ file: png() });
  assert.equal(frame.mime, 'image/png');
  assert.equal(Buffer.from(frame.dataBase64, 'base64').toString(), 'original bytes');
  await assert.rejects(sourceToFrame({ file: new Blob(['<svg/>'], { type: 'image/svg+xml' }) }), /PNG/);
  await assert.rejects(sourceToFrame({ file: { type: 'image/png', size: 5 * 1024 * 1024 + 1 } }), /5 MB/);
});

test('paste stages a tray, blocks Send until bytes are read and preserves it across redraws', async (t) => {
  dom(t);
  const ui = {}, key = 'cell:new', images = imageDraft(ui, key);
  let finish, blocked;
  const file = { name: 'before.png', type: 'image/png', size: 1, arrayBuffer: () => new Promise((r) => { finish = r; }) };
  const textarea = new Element('textarea'), root = new Element('div');
  imageComposer({ ui, key, textarea, root, onChange: () => { blocked = images.busy(); } });
  const paste = textarea.fire('paste', { clipboardData: { files: [file] } });
  assert.equal(paste.prevented, true); assert.equal(blocked, true);
  const next = imageComposer({ ui, key, textarea: new Element('textarea'), root: new Element('div'), onChange: () => { blocked = images.busy(); } });
  assert.equal(descendants(next).some((el) => el.attributes['aria-label'] === 'Image description'), true);
  finish(new Uint8Array([1]).buffer); await settle();
  assert.equal(blocked, false); assert.equal(images.frames()[0].alt, 'before.png');
  const alt = descendants(next).find((el) => el.attributes['aria-label'] === 'Image description');
  alt.value = 'Settings before'; alt.fire('input');
  assert.equal(images.frames()[0].alt, 'Settings before');
  const sent = images.snapshot(); images.clear(sent); assert.deepEqual(images.frames(), []);
});

test('drop caps the tray at four and remove does not revive an unfinished image', async (t) => {
  dom(t); const ui = {}, key = 'reply', images = imageDraft(ui, key), root = new Element('div');
  let finish;
  const file = { name: 'slow.png', type: 'image/png', size: 1, arrayBuffer: () => new Promise((r) => { finish = r; }) };
  const panel = imageComposer({ ui, key, textarea: new Element('textarea'), root, onChange() {} });
  root.fire('drop', { dataTransfer: { types: ['Files'], files: [file, png(), png(), png(), png()] } });
  assert.equal(images.snapshot().length, 4);
  const remove = descendants(panel).find((el) => el.attributes['aria-label'] === 'Remove slow.png'); remove.fire('click');
  finish(new Uint8Array([1]).buffer); await settle();
  assert.equal(images.frames().length, 3); assert.equal(images.busy(), false);
});

test('thumbnail requests are deferred and opening a message uses full replies, arrows and Escape', async (t) => {
  dom(t); const ui = {}, requests = [];
  const ctx = { send(msg, options) { requests.push(msg); options.onReply({ ok: true, mime: 'image/png', dataBase64: 'AQ==' }); } };
  const m = { id: 'msg_test', attachments: [{ file: 'a.png', alt: 'Before' }, { file: 'b.png', alt: 'After' }] };
  const row = messageImages(m, { id: 'cell_test' }, ui, ctx);
  assert.equal(requests.length, 0); await settle(); assert.equal(requests.length, 2);
  assert.equal(row.children[0].children[0].attributes.alt, 'Before');
  row.children[0].fire('click');
  const dialog = document.body.children[0]; assert.equal(dialog.open, true);
  await settle(); assert.equal(requests.at(-1).full, true); assert.equal(requests.at(-1).file, 'a.png');
  dialog.fire('keydown', { key: 'ArrowRight' }); await settle(); assert.equal(requests.at(-1).file, 'b.png');
  assert.equal(dialog.fire('keydown', { key: 'Escape' }).prevented, true); assert.equal(dialog.isConnected, false);
});


test('R5: closing after a redraw restores focus by logical thumbnail identity', async (t) => {
  dom(t); const ui = {}, requests = [];
  const ctx = { send(msg, options) { requests.push(msg); assert.equal(options.quiet, true); options.onReply({ ok: true, mime: 'image/png', dataBase64: 'AQ==' }); } };
  const m = { id: 'msg_focus', attachments: [{ file: 'a.png', alt: 'Before' }] };
  const row = messageImages(m, { id: 'cell_test' }, ui, ctx); await settle();
  const old = row.children[0]; old.isConnected = true; old.focus(); old.fire('click');
  const dialog = document.body.children[0];
  const close = descendants(dialog).find((el) => el.attributes['aria-label'] === 'Close image (Escape)');
  assert.equal(document.activeElement, close);
  const replacement = new Element('button'); replacement.dataset.focusKey = old.dataset.focusKey; replacement.isConnected = true;
  old.isConnected = false;
  document.querySelectorAll = () => [replacement];
  await settle(); dialog.fire('keydown', { key: 'Escape' });
  assert.equal(document.activeElement, replacement);
});

test('R4: browser observation fetches only nearby thumbnails and uses quiet replies', async (t) => {
  dom(t); const before = globalThis.IntersectionObserver; t.after(() => { globalThis.IntersectionObserver = before; });
  let observe;
  globalThis.IntersectionObserver = class { constructor(fn) { observe = fn; } observe() {} unobserve() {} disconnect() {} };
  const requests = [], ui = {};
  const row = messageImages({ id: 'msg_lazy', attachments: [{ file: 'a.png' }, { file: 'b.png' }] }, { id: 'cell_test' }, ui, { send(msg, options) { requests.push(msg); assert.equal(options.quiet, true); options.onReply({ ok: true, mime: 'image/jpeg', dataBase64: 'AQ==' }); } });
  for (const el of row.children) el.isConnected = true;
  await settle(); assert.equal(requests.length, 0);
  observe([{ target: row.children[0], isIntersecting: true }, { target: row.children[1], isIntersecting: false }]);
  await settle(); assert.equal(requests.length, 1);
  assert.equal(requests[0].file, 'a.png');
});

test('retained textarea and composer paste/drop handlers stage each image once after redraw', async t => {
  dom(t);
  const ui = {}, key = 'retained', textarea = new Element('textarea'), root = new Element('div');
  for (let i = 0; i < 3; i++) imageComposer({ ui, key, textarea, root, onChange() {} });
  textarea.fire('paste', { clipboardData: { files: [png()] } });
  root.fire('drop', { dataTransfer: { types: ['Files'], files: [png()] } });
  await settle();
  assert.equal(imageDraft(ui, key).frames().length, 2);
});
