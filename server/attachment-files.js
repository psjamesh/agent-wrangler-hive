import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { MAX_IMAGE_BYTES, MAX_ATTACHMENTS, KINDS, safeId, imageName, validate, decodeImageFrame, sniffImage } from './attachment-validation.js';

const name = (s) => {
  if (typeof s !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,109}$/.test(s)) throw new Error('Invalid stored image name');
  return s;
};
const identity = (st) => ({ dev: st.dev, ino: st.ino });
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
function directory(st) { if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('Attachment directory must not be a symlink'); return st; }
function enter(file, create = false, exclusive = false) {
  name(file);
  if (create) { try { fs.mkdirSync(file, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST' || exclusive) throw e; } }
  const st = directory(fs.lstatSync(file));
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_DIRECTORY);
  try {
    if (!same(st, fs.fstatSync(fd))) throw new Error('Attachment directory changed while opening');
    process.chdir(file);
    if (!same(st, fs.statSync('.'))) throw new Error('Attachment directory changed while entering');
  } finally { fs.closeSync(fd); }
  return identity(st);
}
function regular(file, max = MAX_IMAGE_BYTES) {
  const st = fs.lstatSync(name(file));
  if (!st.isFile() || st.isSymbolicLink()) throw new Error('Must be a regular file, not a symlink');
  if (st.size > max) throw new Error('Image is over 5 MB');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const got = fs.fstatSync(fd);
    if (!got.isFile() || !same(got, st)) throw new Error('Image changed while opening');
    const bytes = Buffer.alloc(max + 1);
    let n = 0;
    while (n < bytes.length) { const size = fs.readSync(fd, bytes, n, bytes.length - n, null); if (!size) break; n += size; }
    if (n > max) throw new Error('Image is over 5 MB');
    return bytes.subarray(0, n);
  } finally { fs.closeSync(fd); }
}
function write(file, bytes) { fs.writeFileSync(name(file), bytes, { mode: 0o600, flag: fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW }); }
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const input = lines[Symbol.asyncIterator]();
const emit = (value) => process.stdout.write(JSON.stringify(value) + '\n');
try {
  const job = JSON.parse((await input.next()).value);
  const { pins, action, file, max, files, exclusive } = job;
  for (let i = pins.length - 1, up = '.'; i >= 0; i--, up += '/..') {
    const st = fs.statSync(up);
    if (!st.isDirectory() || !same(st, pins[i])) throw new Error('Attachment directory changed while opening');
  }
  const root = process.cwd(), rootId = identity(fs.statSync('.'));
  const reset = () => { process.chdir(root); if (!same(rootId, fs.statSync('.'))) throw new Error('Attachment root changed'); };
  const cell = (id, create = false) => { reset(); enter('attachments', create); enter(safeId(id), create); };
  let result = {};
  if (action === 'adopt') {
    if (!Array.isArray(job.attachments) || job.attachments.length > MAX_ATTACHMENTS) throw new Error('Attach at most 4 images per message.');
    cell(job.cellId, true);
    const parent = process.cwd(), parentId = identity(fs.statSync('.'));
    if (!job.client) enter('inbox', true);
    const all = job.attachments.map((a, i) => {
      const file = job.client ? `image-${i + 1}${KINDS.find(k => k.mime === a.mime)?.exts[0] || '.invalid'}` : a?.file;
      try {
        if (!imageName(file)) validate(file, Buffer.alloc(0));
        const bytes = job.client ? decodeImageFrame(a.dataBase64, file) : regular(file);
        const kind = validate(file, bytes);
        return { file, bytes, mime: kind.mime, alt: typeof a.alt === 'string' ? a.alt.slice(0, 500) : file };
      } catch (e) { throw new Error(`${file}: could not read image: ${e.message}`); }
    });
    process.chdir(parent); if (!same(parentId, fs.statSync('.'))) throw new Error('Attachment parent changed');
    let made;
    try {
      made = enter(safeId(job.messageId), true, true);
      for (const a of all) write(a.file, a.bytes);
    } catch (e) {
      if (made) { process.chdir(parent); if (same(parentId, fs.statSync('.')) && same(made, fs.lstatSync(job.messageId))) fs.rmSync(job.messageId, { recursive: true, force: true }); }
      throw new Error(`${all.map(a => a.file).join(', ')}: ${e.message}`);
    }
    result = { attachments: all.map(({ bytes, ...a }) => a) };
  } else if (action === 'ensure-inbox') { cell(job.cellId, true); enter('inbox', true); }
  else if (action === 'image-batch') {
    const images = [];
    for (const [index, request] of job.images.entries()) {
      let temp;
      try {
        cell(request.cellId); enter(safeId(request.messageId));
        const source = regular(request.file); validate(request.file, source);
        if (request.full) { images.push({ index, mime: sniffImage(source).mime, dataBase64: source.toString('base64') }); continue; }
        const cacheId = enter('thumbs', true), cachePath = process.cwd();
        const thumb = `${request.file}.jpg`;
        let bytes;
        try { bytes = regular(thumb); } catch (e) { if (e.code !== 'ENOENT') throw e; }
        if (!bytes) {
          const scratchId = directory(fs.lstatSync(job.scratch.path));
          if (!same(scratchId, job.scratch)) throw new Error('Temporary directory changed');
          process.chdir(job.scratch.path);
          if (!same(scratchId, fs.statSync('.'))) throw new Error('Temporary directory changed');
          enter(String(index), true, true);
          temp = process.cwd();
          const sourcePath = path.join(temp, `source${path.extname(request.file)}`), out = path.join(temp, 'thumbnail.jpg');
          fs.writeFileSync(sourcePath, source, { flag: 'wx', mode: 0o600 });
          emit({ sips: { index, args: ['-s', 'format', 'jpeg', '-Z', '320', sourcePath, '--out', out] } });
          const reply = JSON.parse((await input.next()).value);
          if (!reply.ok) throw new Error('Thumbnail generation failed');
          const tempId = identity(fs.lstatSync(temp));
          process.chdir(temp); if (!same(tempId, fs.statSync('.'))) throw new Error('Temporary directory changed');
          bytes = regular('thumbnail.jpg');
          if (sniffImage(bytes)?.mime !== 'image/jpeg') throw new Error('Invalid thumbnail');
          process.chdir(cachePath);
          if (!same(cacheId, directory(fs.lstatSync(cachePath))) || !same(cacheId, fs.statSync('.'))) throw new Error('Thumbnail directory changed');
          write(thumb, bytes);
        }
        if (sniffImage(bytes)?.mime !== 'image/jpeg') throw new Error('Invalid thumbnail');
        images.push({ index, mime: 'image/jpeg', dataBase64: bytes.toString('base64') });
      } catch { images.push({ index, missing: true }); }
      finally { if (temp) fs.rmSync(temp, { recursive: true, force: true }); }
    }
    result = { images };
  } else if (action === 'remove-batch') {
    for (const request of job.messages) { try { cell(request.cellId); fs.rmSync(safeId(request.messageId), { recursive: true, force: true }); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
  } else if (action === 'cleanup') {
    for (const entry of job.cells) { try { cell(entry.cellId); const kept = new Set(entry.messages); for (const id of fs.readdirSync('.')) if (/^msg_[0-9a-f]{12}$/.test(id) && !kept.has(id)) fs.rmSync(id, { recursive: true, force: true }); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
  } else if (action === 'read') result = { dataBase64: regular(file, max).toString('base64') };
  else if (action === 'mkdir') { try { fs.mkdirSync(name(file), { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST' || exclusive) throw e; } result = identity(directory(fs.lstatSync(file))); }
  else if (action === 'write') { for (const item of files) write(item.file, Buffer.from(item.dataBase64, 'base64')); }
  else if (action === 'remove') fs.rmSync(name(file), { recursive: true, force: true });
  else if (action === 'list') result = { files: fs.readdirSync('.') };
  else throw new Error('Unknown attachment file operation');
  emit({ ok: true, ...result });
} catch (e) { emit({ ok: false, error: e.message, code: e.code }); }
finally { lines.close(); process.stdin.destroy(); }
