const TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const MIME_EXT = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
export const imageMimeOf = (file) => TYPES.has(file?.type) ? file.type : !file?.type ? MIME_EXT[file?.name?.split('.').at(-1)?.toLowerCase()] || null : null;
export function imageSources(dt) {
  const files = Array.from(dt?.files || []);
  if (!files.length) for (const item of Array.from(dt?.items || [])) if (item.kind === 'file') { const f = item.getAsFile(); if (f) files.push(f); }
  if (files.length) return files.map((file) => ({ file }));
  const plain = dt?.getData?.('text/plain')?.trim() || '';
  const html = dt?.getData?.('text/html') || '';
  const urls = [...html.matchAll(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]);
  if (/^data:image\//i.test(plain)) urls.push(plain);
  return [...new Set(urls)].filter((src) => /^data:image\/(png|jpeg|gif|webp);base64,[a-z0-9+/=\s]+$/i.test(src) || /^https?:\/\//i.test(src)).map((src) => ({ src }));
}
export async function sourceToFrame(source) {
  const blob = source.file || await fetch(source.src).then((r) => { if (!r.ok) throw new Error('Could not read that image.'); return r.blob(); });
  const mime = imageMimeOf(blob);
  if (!mime) throw new Error('Use PNG, JPEG, GIF or WebP images.');
  if (blob.size > 5 * 1024 * 1024) throw new Error('Image is over 5 MB.');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return { mime, dataBase64: btoa(binary) };
}
