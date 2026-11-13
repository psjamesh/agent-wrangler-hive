import path from 'node:path';
import { HiveError } from './ops.js';
export const MAX_ATTACHMENTS = 4;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const KINDS = [
  { mime: 'image/png', exts: ['.png'], magic: [137, 80, 78, 71, 13, 10, 26, 10] },
  { mime: 'image/jpeg', exts: ['.jpg', '.jpeg'], magic: [255, 216, 255] },
  { mime: 'image/gif', exts: ['.gif'], magic: [71, 73, 70, 56] },
  { mime: 'image/webp', exts: ['.webp'], magic: [82, 73, 70, 70, null, null, null, null, 87, 69, 66, 80] },
];
export const imageName = (n) => typeof n === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(n) && KINDS.some((k) => k.exts.includes(path.extname(n).toLowerCase()));
export const sniffImage = (bytes) => KINDS.find((k) => k.magic.every((b, i) => b === null || bytes[i] === b)) || null;
export const safeId = (id) => { if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(id)) throw new HiveError('Invalid attachment owner.'); return id; };
const fail = (file, why) => { throw new HiveError(`${file}: ${why}`); };
export function validate(file, bytes) {
  if (!imageName(file)) fail(String(file), 'use a bare PNG, JPEG, GIF or WebP name (up to 100 characters), never a path');
  if (bytes.length > MAX_IMAGE_BYTES) fail(file, 'image is over 5 MB');
  const kind = sniffImage(bytes);
  if (!kind || !kind.exts.includes(path.extname(file).toLowerCase())) fail(file, 'image magic bytes do not match its extension (PNG, JPEG, GIF or WebP only)');
  return kind;
}
export function decodeImageFrame(data, file) {
  if (typeof data !== 'string' || data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 || data.length % 4 !== 0) fail(file, 'invalid image bytes or image is over 5 MB');
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  for (let i = 0; i < data.length - padding; i++) {
    const c = data.charCodeAt(i);
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 47)) fail(file, 'invalid base64 image bytes');
  }
  return Buffer.from(data, 'base64');
}
