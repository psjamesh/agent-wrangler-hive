import { h } from './dom.js';
import { imageSources, sourceToFrame } from './clipboard-images.js';

const drafts = new WeakMap();
function draft(ui, key) {
  if (!drafts.has(ui)) drafts.set(ui, new Map());
  const all = drafts.get(ui);
  if (!all.has(key)) all.set(key, { items: [], seq: 0, error: '', change: () => {} });
  return all.get(key);
}
export const imageDraft = (ui, key) => {
  const d = draft(ui, key);
  return {
    busy: () => d.items.some((i) => !i.frame),
    frames: () => d.items.map((i) => ({ ...i.frame, alt: i.alt })),
    snapshot: () => [...d.items],
    clear: (sent) => { d.items = d.items.filter((i) => !sent.includes(i)); d.change(); },
  };
};
export function imageComposer({ ui, key, textarea, root, onChange, disabled = false }) {
  const d = draft(ui, key);
  const tray = h('ul', { class: 'hive-image-tray', 'aria-label': 'Attached images' });
  const error = h('p', { role: 'alert', class: 'hive-image-error' });
  const picker = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp', multiple: true, hidden: true });
  const attach = h('button', { type: 'button', class: 'hive-link-btn', disabled, onclick: () => picker.click() }, 'Attach images');
  const panel = h('div', { class: 'hive-image-panel' }, tray, h('div', {}, attach, ' or paste / drop images', picker), error);
  const render = () => {
    tray.replaceChildren();
    for (const item of d.items) {
      const img = item.frame ? h('img', { src: `data:${item.frame.mime};base64,${item.frame.dataBase64}`, alt: item.alt }) : h('span', { role: 'status' }, 'Staging…');
      const alt = h('input', { type: 'text', maxlength: '500', value: item.alt, 'aria-label': 'Image description', 'data-focus-key': `image-description:${key}:${item.id}`, disabled });
      alt.addEventListener('input', () => { item.alt = alt.value; });
      tray.append(h('li', {}, img, alt, h('button', { type: 'button', disabled, 'aria-label': `Remove ${item.alt}`, onclick: () => { d.items = d.items.filter((i) => i !== item); render(); } }, '×')));
    }
    error.textContent = d.error;
    error.hidden = !d.error;
    tray.hidden = !d.items.length;
    attach.disabled = disabled || d.items.length >= 4;
    onChange();
  };
  d.change = render;
  const take = (dt) => {
    if (disabled) return;
    const sources = imageSources(dt);
    const chosen = sources.slice(0, Math.max(0, 4 - d.items.length));
    d.error = chosen.length < sources.length ? 'A message holds at most 4 images.' : '';
    for (const source of chosen) {
      const item = { id: ++d.seq, alt: source.file?.name || 'Pasted image', frame: null };
      d.items.push(item);
      sourceToFrame(source).then((frame) => { item.frame = frame; }).catch((err) => { d.items = d.items.filter((i) => i !== item); d.error = `${item.alt}: ${err.message || 'Could not stage image.'}`; }).finally(() => d.change());
    }
    render();
  };
  textarea.onpaste = (e) => { if (imageSources(e.clipboardData).length) { e.preventDefault(); take(e.clipboardData); } };
  const hasFiles = (e) => Array.from(e.dataTransfer?.types || []).includes('Files');
  root.ondragover = (e) => { if (hasFiles(e)) { e.preventDefault(); root.classList.add('hive-image-drag'); } };
  root.ondragleave = () => root.classList.remove('hive-image-drag');
  root.ondrop = (e) => { root.classList.remove('hive-image-drag'); if (hasFiles(e)) { e.preventDefault(); take(e.dataTransfer); } };
  picker.addEventListener('change', () => { take({ files: picker.files }); picker.value = ''; });
  render();
  return panel;
}

const caches = new WeakMap();
const completed = new WeakMap();
const observers = new WeakMap();
const dialogs = new WeakMap();
export function disposeImages(ui) {
  drafts.delete(ui);
  caches.delete(ui);
  completed.delete(ui);
  observers.get(ui)?.observer.disconnect();
  observers.delete(ui);
  for (const dialog of dialogs.get(ui) || []) dialog.close();
  dialogs.delete(ui);
}
export function messageImages(m, cell, ui, ctx) {
  if (!m.attachments?.length) return null;
  if (!caches.has(ui)) caches.set(ui, new Map());
  const cache = caches.get(ui);
  if (!completed.has(ui)) completed.set(ui, new Set());
  const fetched = completed.get(ui);
  const get = (a, full, done, visible = false) => {
    const key = `${cell.id}/${m.id}/${a.file}/${full}`;
    const got = cache.get(key);
    if (got) { if (got.pending) got.pending.push(done); else done(got); return; }
    if (!visible && fetched.has(key)) { done({ missing: true }); return; }
    const entry = { pending: [done] };
    cache.set(key, entry);
    queueMicrotask(() => ctx.send({ type: 'hive-image', cellId: cell.id, messageId: m.id, file: a.file, full }, { onReply: (frame) => {
      const callbacks = entry.pending;
      const value = frame.ok && frame.dataBase64 ? { src: `data:${frame.mime};base64,${frame.dataBase64}` } : { missing: true };
      cache.set(key, value);
      fetched.add(key);
      let held = [...cache.values()].reduce((n, v) => n + (v.src?.length || 0), 0);
      for (const [oldKey, v] of cache) {
        if (held <= 40 * 1024 * 1024 && cache.size <= 160) break;
        if (v.pending || oldKey === key) continue;
        held -= v.src?.length || 0;
        cache.delete(oldKey);
      }
      for (const cb of callbacks) cb(value);
    }, quiet: true }));
  };
  const zoom = (index) => {
    const dialog = h('dialog', { class: 'hive-image-zoom', 'aria-label': 'Message images' });
    const openerKey = `image:${cell.id}:${m.id}:${m.attachments[index].file}`;
    const themeRoot = document.querySelector('.hive-root');
    if (themeRoot) { const style = getComputedStyle(themeRoot); dialog.style.background = style.getPropertyValue('--surface') || style.backgroundColor; dialog.style.color = style.getPropertyValue('--fg') || style.color; }
    for (const attr of ['data-theme', 'data-aw-theme']) if (themeRoot?.hasAttribute(attr)) dialog.setAttribute(attr, themeRoot.getAttribute(attr));
    const stage = h('div', { class: 'hive-image-stage', 'aria-live': 'polite' });
    const close = h('button', { type: 'button', onclick: () => dialog.close(), 'aria-label': 'Close image (Escape)' }, 'Close');
    const prev = h('button', { type: 'button', onclick: () => show(index - 1), 'aria-label': 'Previous image' }, '←');
    const next = h('button', { type: 'button', onclick: () => show(index + 1), 'aria-label': 'Next image' }, '→');
    const label = h('span');
    function show(at) {
      index = Math.max(0, Math.min(m.attachments.length - 1, at));
      const current = index, a = m.attachments[index];
      prev.disabled = index === 0; next.disabled = index === m.attachments.length - 1;
      label.textContent = `${index + 1} of ${m.attachments.length} · ${a.alt || a.file}`;
      stage.textContent = 'Loading image…';
      get(a, true, (g) => { if (index === current && dialog.isConnected) stage.replaceChildren(g.src ? h('img', { src: g.src, alt: a.alt || a.file }) : h('span', {}, 'Image unavailable')); }, true);
    }
    dialog.append(stage, h('div', { class: 'hive-image-controls' }, prev, label, next, close));
    dialog.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); dialog.close(); return; } if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); show(index + (e.key === 'ArrowLeft' ? -1 : 1)); } });
    dialog.addEventListener('cancel', (e) => { e.preventDefault(); e.stopPropagation(); dialog.close(); });
    if (!dialogs.has(ui)) dialogs.set(ui, new Set());
    dialogs.get(ui).add(dialog);
    dialog.addEventListener('close', () => {
      dialogs.get(ui)?.delete(dialog); dialog.remove();
      const opener = [...document.querySelectorAll('[data-focus-key]')].find((el) => el.dataset.focusKey === openerKey && el.isConnected);
      if (opener) opener.focus();
      else { const fallback = document.querySelector('.hive-composer-input') || document.querySelector('.hive-root'); if (fallback) { if (fallback.classList.contains('hive-root')) fallback.setAttribute('tabindex', '-1'); fallback.focus(); } }
    });
    document.body.append(dialog); dialog.showModal(); show(index); close.focus();
  };
  return h('div', { class: 'hive-message-images' }, m.attachments.map((a, i) => {
    const button = h('button', { type: 'button', class: 'hive-image-thumb', 'data-focus-key': `image:${cell.id}:${m.id}:${a.file}`, 'aria-label': `Open ${a.alt || a.file}`, onclick: () => zoom(i) }, 'Image · open');
    const fill = (visible = false) => get(a, false, (got) => { if (got.src) button.replaceChildren(h('img', { src: got.src, alt: a.alt || a.file })); }, visible);
    if (typeof IntersectionObserver === 'function') {
      if (!observers.has(ui)) {
        const callbacks = new WeakMap(), targets = new Set();
        const observer = new IntersectionObserver((entries) => {
          for (const e of entries) if (e.isIntersecting && e.target.isConnected) callbacks.get(e.target)?.();
        }, { rootMargin: '160px' });
        observers.set(ui, { observer, callbacks, targets });
      }
      const watched = observers.get(ui);
      watched.callbacks.set(button, () => fill(true));
      watched.targets.add(button); watched.observer.observe(button);
      if (!watched.scheduled) {
        watched.scheduled = true;
        queueMicrotask(() => { watched.scheduled = false; for (const target of watched.targets) if (!target.isConnected) { watched.observer.unobserve(target); watched.targets.delete(target); } });
      }
    } else fill();
    return button;
  }));
}
