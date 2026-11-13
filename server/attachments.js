import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { HiveError } from './ops.js';
import { assertCurrent } from './lifetime.js';
import { MAX_IMAGE_BYTES, MAX_ATTACHMENTS, imageName, safeId } from './attachment-validation.js';
export { MAX_IMAGE_BYTES, MAX_ATTACHMENTS, imageName, sniffImage } from './attachment-validation.js';

const runFile = promisify(execFile);
const fileWorker = fileURLToPath(new URL('./attachment-files.js', import.meta.url));
async function pinned(rt, job, runs = []) {
  assertCurrent(rt);
  const st = fs.statSync(rt.paths.root);
  const scratch = job.action === 'image-batch' ? fs.mkdtempSync(path.join(os.tmpdir(), 'hive-thumbnail-')) : null;
  try {
    if (scratch) { fs.chmodSync(scratch, 0o700); job = { ...job, scratch: { path: scratch, dev: fs.statSync(scratch).dev, ino: fs.statSync(scratch).ino } }; }
    return await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [fileWorker], { cwd: rt.paths.root, stdio: ['pipe', 'pipe', 'pipe'] });
      rt.attachmentHelperStarted?.(job.action, child);
      const lines = readline.createInterface({ input: child.stdout });
      const controller = new AbortController(), running = new Map();
      let result, failure, received = 0, closed = false, timer;
      const cancel = error => {
        failure ||= error;
        controller.abort();
        for (const process of running.keys()) process.kill('SIGKILL');
        child.kill('SIGKILL');
      };
      const watchdog = () => {
        clearTimeout(timer);
        timer = setTimeout(() => cancel(new Error('Attachment helper timed out')), 60000);
      };
      watchdog();
      child.on('error', cancel);
      child.stdin.on('error', cancel);
      child.stderr.resume();
      lines.on('line', line => {
        if (closed || failure) return;
        received += line.length;
        if (received > 128 * 1024 * 1024) { cancel(new Error('Attachment helper reply is too large')); return; }
        let frame;
        try { frame = JSON.parse(line); } catch (e) { cancel(e); return; }
        if (frame.sips) {
          const { index, args } = frame.sips;
          watchdog();
          Promise.resolve().then(() => {
            assertCurrent(rt);
            if (controller.signal.aborted) throw new Error('Thumbnail cancelled');
            const task = (runs[index] || runFile)('sips', args, { timeout: 15000, killSignal: 'SIGKILL', signal: controller.signal });
            if (task.child) {
              const process = task.child;
              const drain = new Promise(resolve => process.once('close', resolve));
              running.set(process, drain);
              drain.then(() => running.delete(process));
            }
            return task;
          }).then(() => reply(true), () => reply(false));
          function reply(ok) {
            if (closed || controller.signal.aborted) return;
            watchdog();
            child.stdin.write(JSON.stringify({ ok }) + '\n');
          }
        } else result = frame;
      });
      child.on('close', async code => {
        closed = true; clearTimeout(timer); lines.close();
        const drains = [...running.values()];
        controller.abort();
        for (const process of running.keys()) process.kill('SIGKILL');
        await Promise.all(drains);
        if (failure || code !== 0 || !result?.ok) reject(new HiveError(failure?.message || result?.error || 'Attachment helper failed'));
        else resolve(result);
      });
      child.stdin.write(JSON.stringify({ pins: [{ dev: st.dev, ino: st.ino }], ...job }) + '\n');
    });
  } finally { if (scratch) await fs.promises.rm(scratch, { recursive: true, force: true }); }
}
const cellParts = cellId => ['attachments', safeId(cellId)];
export const messageDir = (rt, cellId, messageId) => path.join(rt.paths.root, ...cellParts(cellId), safeId(messageId));
export async function attachmentsInbox(rt, cellId) {
  await rt.attachmentRecovery;
  await pinned(rt, { action: 'ensure-inbox', cellId });
  return path.join(rt.paths.root, ...cellParts(cellId), 'inbox');
}
export async function adoptAttachments(rt, cellId, messageId, attachments = [], { client = false } = {}) {
  if (!Array.isArray(attachments) || attachments.length > MAX_ATTACHMENTS) throw new HiveError('Attach at most 4 images per message.');
  const sources = client ? attachments.filter(a => a && typeof a === 'object' && !Array.isArray(a) && !['path', 'file', 'filePath', 'file_path'].some(k => k in a)) : attachments;
  if (!sources.length) return [];
  await rt.attachmentRecovery;
  try {
    const out = await pinned(rt, { action: 'adopt', cellId, messageId, attachments: sources, client });
    return out.attachments;
  } catch (error) { await removeAttachments(rt, cellId, messageId); throw error; }
}
export async function removeAttachmentBatch(rt, cellId, messages) {
  const existing = messages.filter(id => fs.existsSync(messageDir(rt, cellId, id)));
  if (!existing.length) return;
  try { await pinned(rt, { action: 'remove-batch', messages: existing.map(messageId => ({ cellId, messageId })) }); }
  catch (e) { rt.log?.(`hive: attachment cleanup failed: ${e.message}`); }
}
export const removeAttachments = (rt, cellId, messageId) => removeAttachmentBatch(rt, cellId, [messageId]);
const queues = new WeakMap();
function imageRequest(rt, cellId, messageId, file, full, run) {
  const m = (rt.metadata.read().conversation[cellId] || []).find(x => x.id === messageId);
  if (!m?.attachments?.some(a => a.file === file) || !imageName(file)) return Promise.resolve(null);
  if (!queues.has(rt)) queues.set(rt, { pending: new Map(), ready: [], scheduled: false });
  const queue = queues.get(rt), key = `${cellId}/${messageId}/${file}/${full}`;
  if (queue.pending.has(key)) return queue.pending.get(key);
  const promise = new Promise(resolve => queue.ready.push({ cellId, messageId, file, full, run, resolve, key }));
  queue.pending.set(key, promise);
  if (!queue.scheduled) { queue.scheduled = true; setImmediate(() => flushImages(rt, queue)); }
  return promise;
}
async function flushImages(rt, queue) {
  const batch = queue.ready.splice(0, 16);
  queue.scheduled = false;
  if (queue.ready.length) { queue.scheduled = true; setImmediate(() => flushImages(rt, queue)); }
  let images = [];
  try { images = (await pinned(rt, { action: 'image-batch', images: batch.map(({ cellId, messageId, file, full }) => ({ cellId, messageId, file, full })) }, batch.map(x => x.run))).images; }
  catch {}
  for (let i = 0; i < batch.length; i++) {
    const item = batch[i], got = images.find(x => x.index === i);
    const cell = rt.metadata.cell(item.cellId);
    const retained = !rt.metadata.error && cell && !cell.snapshot && (rt.metadata.read().conversation[item.cellId] || []).some(m => m.id === item.messageId && m.attachments?.some(a => a.file === item.file));
    queue.pending.delete(item.key);
    item.resolve(retained && got?.dataBase64 ? { bytes: Buffer.from(got.dataBase64, 'base64'), mime: got.mime } : null);
  }
}
export const readAttachment = (rt, cellId, messageId, file) => imageRequest(rt, cellId, messageId, file, true);
export const attachmentThumbnail = (rt, cellId, messageId, file, run) => imageRequest(rt, cellId, messageId, file, false, run);
export async function cleanupOrphanAttachments(rt) {
  if (rt.metadata.error || !fs.existsSync(path.join(rt.paths.root, 'attachments'))) return;
  const doc = rt.metadata.read();
  try { await pinned(rt, { action: 'cleanup', cells: Object.keys(doc.cells).map(cellId => ({ cellId, messages: (doc.conversation[cellId] || []).map(m => m.id) })) }); }
  catch (e) { rt.log?.(`hive: attachment recovery failed: ${e.message}`); }
}
