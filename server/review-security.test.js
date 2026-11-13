import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MetadataStore } from './metadata-store.js';
import { attachmentsInbox, messageDir, attachmentThumbnail, MAX_IMAGE_BYTES } from './attachments.js';
import { publish, recordHumanInput } from './conversation.js';
import { configHandlers } from './handlers.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nGQAAAAASUVORK5CYII=', 'base64');
const JPG = Buffer.from([255, 216, 255, 0]);
async function fixture(t) {
  const root = fs.mkdtempSync(path.join('/private/tmp', 'hive-security-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const metadata = new MetadataStore({ file: path.join(root, 'metadata.json') });
  const cell = { id: 'cell_review', enabled: true, queenSessionId: '11111111-1111-4111-8111-111111111111' };
  metadata.mutate(d => { d.cells[cell.id] = cell; });
  const rt = { host: { tasks: { forSession: () => null } }, pendingParticipants: new Map(), paths: { root }, metadata, snapshots: { graph: { beads: {} } }, changed() {}, log() {} };
  const actor = { cell, role: 'queen', sessionId: '11111111-1111-4111-8111-111111111111' };
  const inbox = (await attachmentsInbox(rt, cell.id));
  fs.writeFileSync(path.join(inbox, 'a.png'), PNG);
  const send = async () => (await publish(rt, actor, { text: 'review', attachments: [{ file: 'a.png' }] }));
  return { root, metadata, cell, rt, inbox, send };
}
async function seeded(t) {
  const f = (await fixture(t)), out = await f.send();
  const dir = messageDir(f.rt, f.cell.id, out.message_id);
  return { ...f, out, dir };
}

test('R1: thumbnail handler must refuse a cached file symlink outside storage', async t => {
  const f = (await seeded(t)), secret = path.join(f.root, 'private.jpg');
  fs.writeFileSync(secret, Buffer.concat([JPG, Buffer.from('PRIVATE PHOTO')]));
  fs.mkdirSync(path.join(f.dir, 'thumbs'));
  fs.symlinkSync(secret, path.join(f.dir, 'thumbs', 'a.png.jpg'));
  let reply;
  await configHandlers.find(h => h.type === 'hive-image').handler({ cellId: f.cell.id, messageId: f.out.message_id, file: 'a.png' }, { stores: { hive: f.rt } }, r => { reply = r; });
  assert.equal(reply.missing, true, `outside bytes returned: ${Buffer.from(reply.dataBase64 || '', 'base64').toString('hex')}`);
});

test('R1: real sips must not write through a symlinked thumbs directory', async t => {
  const f = (await seeded(t)), outside = path.join(f.root, 'outside');
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(f.dir, 'thumbs'));
  await attachmentThumbnail(f.rt, f.cell.id, f.out.message_id, 'a.png');
  assert.equal(fs.existsSync(path.join(outside, 'a.png.jpg')), false, 'sips wrote outside the message folder');
});

test('R1: cached thumbnails must have a bounded read size', async t => {
  const f = (await seeded(t));
  fs.mkdirSync(path.join(f.dir, 'thumbs'));
  const bytes = Buffer.alloc(MAX_IMAGE_BYTES + 1); JPG.copy(bytes);
  fs.writeFileSync(path.join(f.dir, 'thumbs', 'a.png.jpg'), bytes);
  const got = await attachmentThumbnail(f.rt, f.cell.id, f.out.message_id, 'a.png');
  assert.equal(got?.bytes.length > MAX_IMAGE_BYTES, false, `returned ${got?.bytes.length} bytes`);
});

test('R2: replacing the checked inbox with a symlink must not publish an outside image', async t => {
  const f = (await fixture(t)), outside = path.join(f.root, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'a.png'), Buffer.concat([PNG, Buffer.from('OUTSIDE')]));
  const pending = f.send();
  fs.renameSync(f.inbox, `${f.inbox}-real`); fs.symlinkSync(outside, f.inbox);
  await assert.rejects(pending, /symlink/);
  assert.equal(f.metadata.read().conversation[f.cell.id]?.length || 0, 0);
});

function fullSizePNG(size) {
  const data = Buffer.alloc(size - PNG.length - 12, 65);
  Buffer.from('Comment\0').copy(data);
  const kind = Buffer.from('tEXt');
  let crc = 0xffffffff;
  for (const b of Buffer.concat([kind, data])) {
    crc ^= b;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  const length = Buffer.alloc(4), checksum = Buffer.alloc(4);
  length.writeUInt32BE(data.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([PNG.subarray(0, -12), length, kind, data, checksum, PNG.subarray(-12)]);
}
test('R3: a valid PNG at the promised 5 MiB limit must publish from client bytes', async t => {
  const f = (await fixture(t)), bytes = fullSizePNG(MAX_IMAGE_BYTES);
  assert.equal(bytes.length, MAX_IMAGE_BYTES);
  await assert.doesNotReject(async () => (await recordHumanInput(f.rt, { cellId: f.cell.id, text: 'large', images: [{ mime: 'image/png', dataBase64: bytes.toString('base64') }] })));
});

test('control: another cell cannot retrieve a message merely by knowing its id', async t => {
  const f = (await seeded(t));
  f.metadata.mutate(d => { d.cells.cell_other = { id: 'cell_other', enabled: true }; });
  let reply;
  await configHandlers.find(h => h.type === 'hive-image').handler({ cellId: 'cell_other', messageId: f.out.message_id, file: 'a.png', full: true }, { stores: { hive: f.rt } }, r => { reply = r; });
  assert.equal(reply.missing, true);
});

test('R3: near-limit bytes succeed while malformed large frames are rejected without stack overflow', async t => {
  const f = (await fixture(t));
  const bytes = fullSizePNG(MAX_IMAGE_BYTES - 2);
  const good = bytes.toString('base64');
  await assert.doesNotReject(async () => (await recordHumanInput(f.rt, { cellId: f.cell.id, text: 'near limit', images: [{ mime: 'image/png', dataBase64: good }] })));
  for (const bad of [good.slice(0, -4) + '!===', good.slice(0, -1), 'AA=A', 'A===', '====']) await assert.rejects(async () => (await recordHumanInput(f.rt, { cellId: f.cell.id, text: 'malformed', images: [{ mime: 'image/png', dataBase64: bad }] })), e => !(e instanceof RangeError));
});

test('R1/R2: replacing the cache directory during sips cannot install into the outside directory', async t => {
  const f = (await seeded(t)), outside = path.join(f.root, 'outside');
  fs.mkdirSync(outside);
  const got = await attachmentThumbnail(f.rt, f.cell.id, f.out.message_id, 'a.png', async (bin, args) => {
    fs.renameSync(path.join(f.dir, 'thumbs'), path.join(f.dir, 'thumbs-original'));
    fs.symlinkSync(outside, path.join(f.dir, 'thumbs'));
    fs.writeFileSync(args.at(-1), JPG);
  });
  assert.equal(got, null);
  assert.deepEqual(fs.readdirSync(outside), []);
});


test('R2: a running helper keeps its original directory after the pathname is replaced', async t => {
  const f = (await fixture(t)), outside = path.join(f.root, 'outside');
  fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'a.png'), Buffer.concat([PNG, Buffer.from('OUTSIDE')]));
  const folders = [f.root, path.join(f.root, 'attachments'), path.join(f.root, 'attachments', f.cell.id), f.inbox];
  const pins = folders.map(dir => { const st = fs.statSync(dir); return { dev: st.dev, ino: st.ino }; });
  const child = spawn(process.execPath, [fileURLToPath(new URL('./attachment-files.js', import.meta.url))], { cwd: f.inbox, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', b => { output += b; });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  fs.renameSync(f.inbox, f.inbox + '-original'); fs.symlinkSync(outside, f.inbox);
  child.stdin.end(JSON.stringify({ pins, action: 'read', file: 'a.png', max: MAX_IMAGE_BYTES }));
  const code = await new Promise(resolve => child.once('close', resolve));
  assert.equal(code, 0); const result = JSON.parse(output); assert.equal(result.ok, true);
  assert.deepEqual(Buffer.from(result.dataBase64, 'base64'), PNG);
});
