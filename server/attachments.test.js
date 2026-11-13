import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MetadataStore } from './metadata-store.js';
import { attachmentsInbox, imageName, cleanupOrphanAttachments, messageDir, readAttachment, attachmentThumbnail, MAX_IMAGE_BYTES } from './attachments.js';
import { publish, recordHumanInput, cellContextConversation } from './conversation.js';
import { resolveCaller } from './access.js';
import { configHandlers } from './handlers.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nGQAAAAASUVORK5CYII=', 'base64');
const JPG = Buffer.from([255, 216, 255, 0]);
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-images-test-'));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const metadata = new MetadataStore({ file: path.join(root, 'metadata.json') });
  const cell = { id: 'cell_test', enabled: true, queenSessionId: '11111111-1111-4111-8111-111111111111' };
  metadata.mutate((d) => { d.cells[cell.id] = cell; });
  const rt = { host: { tasks: { forSession: () => null } }, pendingParticipants: new Map(), paths: { root }, metadata, snapshots: { graph: { beads: {} } }, changed() {}, log() {} };
  const actor = { cell, role: 'queen', sessionId: '11111111-1111-4111-8111-111111111111' };
  const inbox = (await attachmentsInbox(rt, cell.id));
  const put = (name, bytes = PNG) => fs.writeFileSync(path.join(inbox, name), bytes);
  const send = async (attachments, rest = {}) => (await publish(rt, actor, { text: 'Look at this', attachments, ...rest }));
  const list = () => metadata.read().conversation[cell.id] || [];
  return { rt, cell, actor, inbox, put, send, list };
}

test('bare names: exact character, length and extension limits', () => {
  for (const n of ['a.png', 'Shot-1.JPEG', 'x'.repeat(96) + '.png']) assert.equal(imageName(n), true, n);
  for (const n of ['../a.png', '/a.png', 'a/b.png', 'a\\b.png', 'C:a.png', '.a.png', 'a b.png', 'x'.repeat(97) + '.png', 'a.svg', 'a.webm', 'a.png\0', '', null]) assert.equal(imageName(n), false, String(n));
});

test('publish copies only named files, keeps original bytes and survives source removal and restart', async (t) => {
  const f = (await fixture(t)); f.put('a.png'); f.put('unused.png');
  const out = await f.send([{ file: 'a.png', alt: 'Screen before the change' }]);
  fs.rmSync(path.join(f.inbox, 'a.png'));
  const dir = messageDir(f.rt, f.cell.id, out.message_id);
  assert.deepEqual(fs.readdirSync(dir), ['a.png']);
  assert.deepEqual((await readAttachment(f.rt, f.cell.id, out.message_id, 'a.png')).bytes, PNG);
  f.rt.metadata = new MetadataStore({ file: f.rt.metadata.file });
  assert.equal((await readAttachment(f.rt, f.cell.id, out.message_id, 'a.png')).mime, 'image/png');
  const m = f.rt.metadata.read().conversation[f.cell.id][0];
  assert.deepEqual(m.attachments, [{ file: 'a.png', alt: 'Screen before the change', mime: 'image/png' }]);
  assert.equal(JSON.stringify(m).includes('dataBase64'), false);
  assert.equal((await cellContextConversation(f.rt, f.rt.host, f.actor)).attachments_inbox, f.inbox);
});

test('all supported magic signatures must match the extension', async (t) => {
  const f = (await fixture(t));
  const images = [['a.png', PNG], ['a.jpeg', JPG], ['a.gif', Buffer.from('GIF89a')], ['a.webp', Buffer.from('RIFF1234WEBP')]];
  for (const [file, bytes] of images) f.put(file, bytes);
  assert.equal((await f.send(images.map(([file]) => ({ file })))).message_id.startsWith('msg_'), true);
  for (const [file, bytes] of [['bad.png', JPG], ['bad.jpg', PNG], ['bad.gif', Buffer.from('<svg/>')], ['bad.webp', PNG]]) {
    f.put(file, bytes);
    await assert.rejects(async () => await f.send([{ file }]), new RegExp(`${file}.*magic`));
  }
});

test('publish refuses paths, missing files, symlinks, directories, oversized images and more than four', async (t) => {
  const f = (await fixture(t)); f.put('a.png');
  fs.symlinkSync(path.join(f.inbox, 'a.png'), path.join(f.inbox, 'link.png'));
  fs.mkdirSync(path.join(f.inbox, 'dir.png'));
  f.put('large.png', Buffer.alloc(MAX_IMAGE_BYTES + 1));
  for (const [file, why] of [['../a.png', 'bare'], ['missing.png', 'could not read'], ['link.png', 'regular'], ['dir.png', 'regular'], ['large.png', '5 MB']]) await assert.rejects(async () => await f.send([{ file }]), (e) => e.message.includes(file) && e.message.includes(why));
  await assert.rejects(async () => await f.send(Array(5).fill({ file: 'a.png' })), /at most 4/);
  assert.equal(f.list().length, 0);
});

test('a symlinked inbox cannot expose files outside Hive storage', async (t) => {
  const f = (await fixture(t));
  fs.rmSync(f.inbox, { recursive: true });
  const outside = path.join(f.rt.paths.root, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'a.png'), PNG);
  fs.symlinkSync(outside, f.inbox);
  await assert.rejects(async () => await f.send([{ file: 'a.png' }]), /symlink/);
});

test('a failed attachment or metadata write leaves no message or partial kept files', async (t) => {
  const f = (await fixture(t)); f.put('good.png'); f.put('bad.png', JPG);
  await assert.rejects(async () => await f.send([{ file: 'good.png' }, { file: 'bad.png' }]), /bad.png/);
  assert.deepEqual(fs.readdirSync(path.dirname(f.inbox)), ['inbox']);
  const mutate = f.rt.metadata.mutate.bind(f.rt.metadata);
  f.rt.metadata.mutate = (fn) => mutate((d) => { fn(d); throw new Error('disk failed'); });
  await assert.rejects(async () => await f.send([{ file: 'good.png' }]), /disk failed/);
  assert.deepEqual(fs.readdirSync(path.dirname(f.inbox)), ['inbox']);
  assert.equal(f.list().length, 0);
});

test('only the queen publishes images', async (t) => {
  const f = (await fixture(t)); f.put('a.png');
  f.rt.metadata.mutate(d => { d.cells[f.cell.id].queenSessionId = null; d.bindings[f.cell.id] = [{ sessionId: f.actor.sessionId, active: true, role: 'worker' }]; });
  await assert.rejects(async () => (await publish(f.rt, { ...f.actor, role: 'worker' }, { text: 'x', attachments: [{ file: 'a.png' }] })), /queen/);
});

test('human bytes use server-generated names and identical validation', async (t) => {
  const f = (await fixture(t));
  const image = { mime: 'image/png', dataBase64: PNG.toString('base64'), alt: 'Human screenshot' };
  const out = (await recordHumanInput(f.rt, { cellId: f.cell.id, text: 'Please fix this', images: [image] }));
  assert.deepEqual(out.attachments, [{ file: 'image-1.png', mime: 'image/png', alt: 'Human screenshot' }]);
  assert.deepEqual((await readAttachment(f.rt, f.cell.id, out.id, 'image-1.png')).bytes, PNG);
  for (const images of [[{ ...image, mime: 'image/jpeg' }], [{ ...image, dataBase64: 'not base64!' }], [{ ...image, dataBase64: Buffer.alloc(MAX_IMAGE_BYTES + 1).toString('base64') }], Array(5).fill(image)]) await assert.rejects(async () => (await recordHumanInput(f.rt, { cellId: f.cell.id, text: 'x', images })));
  assert.equal(f.list().length, 1);
});

test('a client-sent attachment never reaches the thread', async (t) => {
  const f = (await fixture(t));
  const host = { stores: { hive: f.rt } };
  let reply;
  await configHandlers.find((h) => h.type === 'hive-send').handler({ cellId: f.cell.id, text: 'No local files', attachments: [{ file: 'a.png', path: '/etc/passwd' }], images: ['/etc/passwd', null, { path: '/etc/passwd' }, { file: '../secret.png', mime: 'image/png', dataBase64: PNG.toString('base64') }] }, host, (r) => { reply = r; });
  assert.equal(reply.ok, true);
  assert.deepEqual(f.list()[0].attachments, []);
  assert.equal(JSON.stringify(f.list()).includes('/etc/passwd'), false);
});

function fillForPrune(f) {
  f.rt.metadata.mutate((d) => {
    const m = d.conversation[f.cell.id][0];
    m.ack.state = { kind: 'read', by: 'aw:human', at: 1 };
    for (let i = 0; i < 1999; i++) d.conversation[f.cell.id].push({ id: `msg_old${i}`, author: 'session', text: 'old', at: 1, threadId: m.threadId, n: i + 2 });
  });
}
test('prune deletes files only after metadata removal commits and ledger keeps only the count', async (t) => {
  const f = (await fixture(t)); f.put('a.png');
  const first = await f.send([{ file: 'a.png', alt: 'Do not keep me in ledger' }]);
  const dir = messageDir(f.rt, f.cell.id, first.message_id);
  fillForPrune(f);
  const mutate = f.rt.metadata.mutate.bind(f.rt.metadata);
  f.rt.metadata.mutate = (fn) => mutate((d) => { fn(d); assert.equal(fs.existsSync(dir), true); });
  await f.send([]);
  assert.equal(fs.existsSync(dir), false);
  assert.equal(f.list().some((m) => m.id === first.message_id), false);
  const ledger = f.rt.metadata.read().inbox[f.cell.id].ledger;
  assert.equal(ledger[0].attachmentCount, 1);
  assert.equal(JSON.stringify(ledger).includes('a.png'), false);
  assert.equal(JSON.stringify(ledger).includes('Do not keep'), false);
});

test('a failed prune commit retains the original image and message', async (t) => {
  const f = (await fixture(t)); f.put('a.png');
  const first = await f.send([{ file: 'a.png' }]); fillForPrune(f);
  const mutate = f.rt.metadata.mutate.bind(f.rt.metadata);
  f.rt.metadata.mutate = (fn) => mutate((d) => { fn(d); throw new Error('disk failed'); });
  await assert.rejects(async () => await f.send([{ file: 'a.png' }]), /disk failed/);
  assert.equal(fs.existsSync(messageDir(f.rt, f.cell.id, first.message_id)), true);
  assert.equal(f.list().some((m) => m.id === first.message_id), true);
  assert.equal(fs.readdirSync(path.dirname(f.inbox)).length, 2);
});

test('outstanding message images are protected from pruning', async (t) => {
  const f = (await fixture(t)); f.put('a.png'); const first = await f.send([{ file: 'a.png' }]); fillForPrune(f);
  f.rt.metadata.mutate((d) => { d.conversation[f.cell.id][0].ack.state = null; });
  await f.send([]);
  assert.ok((await readAttachment(f.rt, f.cell.id, first.message_id, 'a.png')));
});

test('thumbnail uses sips once, keeps full bytes and falls back on failure', async (t) => {
  const f = (await fixture(t)); f.put('a.png'); f.put('b.png');
  const out = await f.send([{ file: 'a.png' }, { file: 'b.png' }]);
  let calls = 0;
  const run = async (bin, args) => { calls++; assert.equal(bin, 'sips'); assert.deepEqual(args.slice(0, 5), ['-s', 'format', 'jpeg', '-Z', '320']); fs.writeFileSync(args.at(-1), JPG); };
  assert.equal((await attachmentThumbnail(f.rt, f.cell.id, out.message_id, 'a.png', run)).mime, 'image/jpeg');
  await attachmentThumbnail(f.rt, f.cell.id, out.message_id, 'a.png', run); assert.equal(calls, 1);
  assert.deepEqual((await readAttachment(f.rt, f.cell.id, out.message_id, 'a.png')).bytes, PNG);
  assert.equal(await attachmentThumbnail(f.rt, f.cell.id, out.message_id, 'b.png', async () => { throw Error('no sips'); }), null);
  assert.equal((await readAttachment(f.rt, f.cell.id, out.message_id, '../metadata.json')), null);
  assert.equal((await readAttachment(f.rt, f.cell.id, 'msg_missing', 'a.png')), null);
});

test('image handler returns one full file as base64 only to its reply', async (t) => {
  const f = (await fixture(t)); f.put('a.png'); const out = await f.send([{ file: 'a.png' }]);
  const host = { stores: { hive: f.rt }, broadcast() { assert.fail('image must not be broadcast'); } };
  const handler = configHandlers.find((h) => h.type === 'hive-image');
  let frame;
  await handler.handler({ cellId: f.cell.id, messageId: out.message_id, file: 'a.png', full: true }, host, (r) => { frame = r; });
  assert.equal(frame.ok, true); assert.equal(frame.dataBase64, PNG.toString('base64'));
  await handler.handler({ cellId: f.cell.id, messageId: out.message_id, file: '../metadata.json', full: true }, host, (r) => { frame = r; });
  assert.equal(frame.missing, true); assert.equal(frame.dataBase64, undefined);
});


test('startup recovery cleans only unreferenced message folders and preserves inbox and live files', async (t) => {
  const f = (await fixture(t)); f.put('a.png'); const first = await f.send([{ file: 'a.png' }]);
  const orphan = messageDir(f.rt, f.cell.id, 'msg_123456789abc');
  fs.mkdirSync(orphan); fs.writeFileSync(path.join(orphan, 'a.png'), PNG);
  f.rt.metadata.error = 'metadata unavailable'; (await cleanupOrphanAttachments(f.rt));
  assert.equal(fs.existsSync(orphan), true);
  f.rt.metadata.error = null; (await cleanupOrphanAttachments(f.rt));
  assert.equal(fs.existsSync(orphan), false);
  assert.equal(fs.existsSync(path.join(f.inbox, 'a.png')), true);
  assert.ok((await readAttachment(f.rt, f.cell.id, first.message_id, 'a.png')));
});

test('concurrent thumbnail requests share one sips operation', async (t) => {
  const f = (await fixture(t)); f.put('a.png'); const out = await f.send([{ file: 'a.png' }]);
  let finish, calls = 0;
  const run = async (bin, args) => { calls++; await new Promise((r) => { finish = r; }); fs.writeFileSync(args.at(-1), JPG); };
  const first = attachmentThumbnail(f.rt, f.cell.id, out.message_id, 'a.png', run);
  const second = attachmentThumbnail(f.rt, f.cell.id, out.message_id, 'a.png', run);
  while (!finish) await new Promise(r => setImmediate(r));
  assert.equal(calls, 1); finish();
  const results = await Promise.all([first, second]);
  assert.equal(results[0].mime, 'image/jpeg'); assert.deepEqual(results[0], results[1]);
});


test('R6: four-image adoption and sixteen cached requests each use one asynchronous helper batch', async t => {
  const f = await fixture(t), files = ['a.png', 'b.png', 'c.png', 'd.png'];
  for (const file of files) f.put(file);
  const starts = []; f.rt.attachmentHelperStarted = action => starts.push(action);
  let adoptionTimer = false;
  setTimeout(() => { adoptionTimer = true; assert.equal(f.list().length, 0); }, 0);
  const out = await f.send(files.map(file => ({ file })));
  assert.equal(adoptionTimer, true); assert.deepEqual(starts, ['adopt']);
  const thumbs = path.join(messageDir(f.rt, f.cell.id, out.message_id), 'thumbs'); fs.mkdirSync(thumbs);
  for (const file of files) fs.writeFileSync(path.join(thumbs, file + '.jpg'), JPG);
  starts.length = 0;
  let imageTimer = false; setTimeout(() => { imageTimer = true; }, 0);
  const got = await Promise.all(Array.from({ length: 16 }, (_, i) => attachmentThumbnail(f.rt, f.cell.id, out.message_id, files[i % 4])));
  assert.equal(imageTimer, true); assert.deepEqual(starts, ['image-batch']);
  assert.ok(got.every(image => image?.mime === 'image/jpeg'));
});

test('R6: a cell disabled during adoption is rechecked and the copied files are rolled back', async t => {
  const f = await fixture(t); f.put('a.png');
  f.rt.attachmentHelperStarted = action => { if (action === 'adopt') f.rt.metadata.mutate(d => { d.cells[f.cell.id].enabled = false; }); };
  await assert.rejects(f.send([{ file: 'a.png' }]), /turned off/);
  assert.equal(f.list().length, 0);
  assert.deepEqual(fs.readdirSync(path.dirname(f.inbox)), ['inbox']);
});

test('R6: concurrent sends serialize, and a rejected adoption leaves the following send intact', async t => {
  const f = await fixture(t); f.put('a.png'); f.put('bad.png', JPG);
  const results = await Promise.allSettled([f.send([{ file: 'bad.png' }]), f.send([{ file: 'a.png' }])]);
  assert.deepEqual(results.map(x => x.status), ['rejected', 'fulfilled']);
  assert.equal(f.list().length, 1);
  assert.deepEqual((await readAttachment(f.rt, f.cell.id, results[1].value.message_id, 'a.png')).bytes, PNG);
  assert.deepEqual(fs.readdirSync(path.dirname(f.inbox)).sort(), ['inbox', results[1].value.message_id].sort());
});

const WORKER = '22222222-2222-4222-8222-222222222222';
for (const change of ['binding', 'task', 'coordinator']) test(`queued publish rechecks revoked ${change} participation`, async t => {
  const f = await fixture(t); f.put('a.png');
  let task = change === 'task' ? 'task-one' : null;
  f.rt.host = { tasks: { forSession: () => ({ taskId: task }) } };
  f.rt.metadata.mutate(d => {
    d.cells[f.cell.id].taskId = 'task-one';
    if (change !== 'task') d.bindings[f.cell.id] = [{ sessionId: WORKER, active: true, role: change === 'coordinator' ? 'coordinator' : 'worker' }];
  });
  const worker = resolveCaller(f.rt, f.rt.host, WORKER, f.cell.id);
  f.rt.attachmentHelperStarted = action => {
    if (action !== 'adopt') return;
    task = 'task-two';
    f.rt.metadata.mutate(d => { d.bindings[f.cell.id] = []; });
  };
  const results = await Promise.allSettled([f.send([{ file: 'a.png' }]), publish(f.rt, worker, { text: 'revoked' }, f.rt.host)]);
  assert.equal(results[1].status, 'rejected');
  assert.match(results[1].reason.message, /do not take part/);
  assert.equal(f.list().some(m => m.text === 'revoked'), false);
});

test('publish rechecks current role after adoption and rolls back queen-only files', async t => {
  const f = await fixture(t); f.put('a.png');
  f.rt.attachmentHelperStarted = action => {
    if (action === 'adopt') f.rt.metadata.mutate(d => {
      d.cells[f.cell.id].queenSessionId = WORKER;
      d.bindings[f.cell.id] = [{ sessionId: f.actor.sessionId, active: true, role: 'coordinator' }];
    });
  };
  await assert.rejects(f.send([{ file: 'a.png' }]), /queen/);
  assert.equal(f.list().length, 0);
  assert.deepEqual(fs.readdirSync(path.dirname(f.inbox)), ['inbox']);
});

test('context refreshes authority and conversation after inbox work', async t => {
  const f = await fixture(t);
  f.rt.attachmentHelperStarted = action => {
    if (action === 'ensure-inbox') f.rt.metadata.mutate(d => { d.cells[f.cell.id].queenSessionId = WORKER; });
  };
  await assert.rejects(cellContextConversation(f.rt, f.rt.host, f.actor), /do not take part/);
});

for (const change of ['snapshot', 'file', 'metadata']) test(`image completion rechecks changed ${change}`, async t => {
  const f = await fixture(t); f.put('a.png'); const out = await f.send([{ file: 'a.png' }]);
  const image = await attachmentThumbnail(f.rt, f.cell.id, out.message_id, 'a.png', async (bin, args) => {
    fs.writeFileSync(args.at(-1), JPG);
    if (change === 'metadata') f.rt.metadata.error = 'unavailable';
    else f.rt.metadata.mutate(d => {
      if (change === 'snapshot') d.cells[f.cell.id].snapshot = true;
      else d.conversation[f.cell.id][0].attachments = [];
    });
  });
  assert.equal(image, null);
});

test('helper timeout aborts active conversion and removes parent-owned scratch', async t => {
  const f = await fixture(t); f.put('a.png'); const out = await f.send([{ file: 'a.png' }]);
  const original = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...args) => original(fn, ms === 60000 ? 1000 : ms, ...args);
  let temp, aborted = false;
  try {
    const image = await attachmentThumbnail(f.rt, f.cell.id, out.message_id, 'a.png', async (bin, args, options) => {
      temp = path.dirname(args.at(-1));
      options.signal.addEventListener('abort', () => { aborted = true; });
      await new Promise(() => {});
    });
    assert.equal(image, null);
    assert.equal(aborted, true);
    assert.ok(temp);
    assert.equal(fs.existsSync(temp), false);
    assert.equal(fs.existsSync(path.dirname(temp)), false);
  } finally { globalThis.setTimeout = original; if (temp) fs.rmSync(temp, { recursive: true, force: true }); }
});

test('conversion failure and success both remove parent-owned scratch', async t => {
  const f = await fixture(t); f.put('a.png'); f.put('b.png');
  const out = await f.send([{ file: 'a.png' }, { file: 'b.png' }]);
  const temps = [];
  const run = async (bin, args) => {
    temps.push(path.dirname(args.at(-1)));
    if (temps.length === 1) throw new Error('failed conversion');
    fs.writeFileSync(args.at(-1), JPG);
  };
  const got = await Promise.all(['a.png', 'b.png'].map(file => attachmentThumbnail(f.rt, f.cell.id, out.message_id, file, run)));
  assert.equal(got[0], null); assert.equal(got[1].mime, 'image/jpeg');
  assert.equal(temps.length, 2);
  for (const temp of temps) { assert.equal(fs.existsSync(temp), false); assert.equal(fs.existsSync(path.dirname(temp)), false); }
});

for (const change of ['binding', 'task']) test(`publish rechecks ${change} participation immediately before commit`, async t => {
  const f = await fixture(t);
  let task = 'task-one';
  f.rt.host = { tasks: { forSession: sessionId => sessionId === WORKER ? { taskId: task } : null } };
  f.rt.metadata.mutate(d => {
    d.cells[f.cell.id].taskId = change === 'task' ? task : null;
    if (change === 'binding') d.bindings[f.cell.id] = [{ sessionId: WORKER, active: true, role: 'worker' }];
  });
  const actor = resolveCaller(f.rt, f.rt.host, WORKER, f.cell.id);
  const pending = publish(f.rt, actor, { text: 'revoked at await' }, f.rt.host);
  queueMicrotask(() => {
    task = 'task-two';
    f.rt.metadata.mutate(d => { d.bindings[f.cell.id] = []; });
  });
  await assert.rejects(pending, /do not take part/);
  assert.equal(f.list().length, 0);
});

test('queued publish records the current role and its obligations', async t => {
  const f = await fixture(t); f.put('a.png');
  f.rt.metadata.mutate(d => { d.bindings[f.cell.id] = [{ sessionId: WORKER, active: true, role: 'worker' }]; });
  const actor = resolveCaller(f.rt, f.rt.host, WORKER, f.cell.id);
  f.rt.attachmentHelperStarted = action => {
    if (action === 'adopt') f.rt.metadata.mutate(d => { d.bindings[f.cell.id][0].role = 'coordinator'; });
  };
  const results = await Promise.allSettled([f.send([{ file: 'a.png' }]), publish(f.rt, actor, { text: 'now coordinating' }, f.rt.host)]);
  assert.equal(results[1].status, 'fulfilled');
  const message = f.list().find(m => m.text === 'now coordinating');
  assert.equal(message.role, 'coordinator'); assert.equal(message.ack, undefined);
});

test('thumbnail batch watchdog allows sequential bounded conversions beyond one idle interval', async t => {
  const f = await fixture(t), files = ['a.png', 'b.png', 'c.png', 'd.png'], requests = [];
  for (const file of files) f.put(file);
  for (let i = 0; i < 4; i++) {
    const out = await f.send(files.map(file => ({ file })));
    for (const file of files) requests.push({ id: out.message_id, file });
  }
  const original = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...args) => original(fn, ms === 60000 ? 600 : ms, ...args);
  let calls = 0;
  try {
    const got = await Promise.all(requests.map(({ id, file }) => attachmentThumbnail(f.rt, f.cell.id, id, file, async (bin, args) => {
      calls++;
      await new Promise(resolve => original(resolve, 100));
      fs.writeFileSync(args.at(-1), JPG);
    })));
    assert.equal(calls, 16);
    assert.ok(got.every(image => image?.mime === 'image/jpeg'));
  } finally { globalThis.setTimeout = original; }
});

test('helper timeout kills and drains a real conversion before scratch cleanup', async t => {
  const f = await fixture(t); f.put('a.png'); const out = await f.send([{ file: 'a.png' }]);
  const bin = path.join(f.rt.paths.root, 'bin'), marker = path.join(f.rt.paths.root, 'conversion.json');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'sips'), `#!${process.execPath}\nimport fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({pid: process.pid, temp: process.argv.at(-1)}));\nsetInterval(() => {}, 1000);\n`, { mode: 0o700 });
  const original = globalThis.setTimeout, priorPath = process.env.PATH;
  process.env.PATH = bin + path.delimiter + priorPath;
  globalThis.setTimeout = (fn, ms, ...args) => original(fn, ms === 60000 ? 1500 : ms, ...args);
  try {
    const image = await attachmentThumbnail(f.rt, f.cell.id, out.message_id, 'a.png');
    const { pid, temp } = JSON.parse(fs.readFileSync(marker, 'utf8'));
    assert.equal(image, null);
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    assert.equal(fs.existsSync(path.dirname(temp)), false);
    assert.equal(fs.existsSync(path.dirname(path.dirname(temp))), false);
  } finally { globalThis.setTimeout = original; process.env.PATH = priorPath; }
});

test('context renders one fresh role and conversation snapshot after inbox preparation', async t => {
  const f = await fixture(t);
  f.rt.attachmentHelperStarted = action => {
    if (action !== 'ensure-inbox') return;
    f.rt.metadata.mutate(d => {
      d.cells[f.cell.id].queenSessionId = WORKER;
      d.bindings[f.cell.id] = [{ sessionId: f.actor.sessionId, active: true, role: 'coordinator' }];
      d.conversation[f.cell.id] = [{ id: 'msg_123456789abc', author: 'human', text: 'arrived while waiting', at: Date.now() }];
    });
  };
  const out = await cellContextConversation(f.rt, f.rt.host, f.actor, {}, (conversation, actor) => ({ conversation, role: actor.role }));
  assert.equal(out.role, 'coordinator');
  assert.equal(out.conversation.conversation[0].text, 'arrived while waiting');
  assert.equal(out.conversation.attachments_inbox, undefined);
  assert.equal(out.conversation.unacknowledged_input, undefined);
});

test('unexpected helper exit aborts conversion and removes scratch before replying', async t => {
  const f = await fixture(t); f.put('a.png'); const out = await f.send([{ file: 'a.png' }]);
  let helper, temp, aborted = false;
  f.rt.attachmentHelperStarted = (action, child) => { if (action === 'image-batch') helper = child; };
  const image = await attachmentThumbnail(f.rt, f.cell.id, out.message_id, 'a.png', async (bin, args, options) => {
    temp = path.dirname(args.at(-1));
    options.signal.addEventListener('abort', () => { aborted = true; });
    helper.kill('SIGKILL');
    await new Promise(() => {});
  });
  assert.equal(image, null); assert.equal(aborted, true);
  assert.equal(fs.existsSync(temp), false);
  assert.equal(fs.existsSync(path.dirname(temp)), false);
});
