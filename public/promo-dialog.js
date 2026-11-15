import { h } from './dom.js';
import { PROMO } from './promo-content.js';
import { createPromoStorage, regularHexagon } from './promo-policy.js';

export function aboutHive({ ui }, options = {}) {
  return h('button', { type: 'button', class: 'hive-quiet-btn', 'aria-haspopup': 'dialog', 'data-focus-key': 'about-hive', onclick: event => {
    if (options.leave && !options.leave()) return;
    ui.openPromo?.(event.currentTarget);
  } }, 'About Hive');
}

export function createPromo({ root, storage, buildVersion, notice = () => {}, pause = () => {}, manifest = PROMO }) {
  const saved = createPromoStorage(storage);
  let active = null;
  const button = (label, onclick, attrs = {}) => h('button', { type: 'button', class: 'hive-btn', onclick, ...attrs }, label);
  const restore = opener => {
    const target = opener?.isConnected ? opener
      : [...document.querySelectorAll('[data-focus-key]')].find(el => el.dataset.focusKey === 'about-hive')
        || root()?.querySelector('h2');
    if (target) { if (target.tagName?.toLowerCase() === 'h2') target.setAttribute('tabindex', '-1'); target.focus(); }
  };
  const end = (dismiss = false) => {
    if (!active) return;
    const current = active;
    active = null;
    current.observer?.disconnect();
    if (current.fitFrame) cancelAnimationFrame(current.fitFrame);
    current.dialog.close();
    current.dialog.remove();
    pause(false);
    if (dismiss) {
      if (!saved.dismiss(current.edition, current.build)) notice('Dismissal could not be saved on this browser');
      restore(current.opener);
    }
  };
  const image = page => h('div', { class: 'hive-promo-art' }, ['', '-light'].map(theme => h('img', {
    class: theme ? 'hive-promo-art-light' : 'hive-promo-art-dark',
    src: new URL(`./promo/${page.id}${theme}.svg`, import.meta.url).href,
    alt: page.alt,
    onerror: event => {
      event.target.hidden = true;
      if (!event.target.parentNode.querySelector('p')) event.target.parentNode.append(h('p', { class: 'hive-promo-image-fallback' }, `Example unavailable. ${page.alt}`));
    },
  })));
  const open = (opener = document.activeElement, offer = { page: 0, changes: [], digest: '' }) => {
    if (active || !root()) return false;
    const dialog = h('dialog', { class: 'hive-promo', 'aria-label': 'Introducing Hive' });
    const current = { dialog, opener, page: offer.page || 0, edition: manifest.contentVersion, build: buildVersion?.() || null, enlarged: false };
    active = current;
    const shape = regularHexagon(1000);
    const silhouette = h('svg:svg', { class: 'hive-promo-shape', viewBox: `0 0 1000 ${shape.height}`, 'aria-hidden': 'true' }, h('svg:polygon', { points: shape.points.map(point => point.join(',')).join(' ') }));
    const navButtons = manifest.pages.map((page, index) => button(`${index + 1} · ${page.label}${offer.changes.some(change => change.pageId === page.id) ? ' · New' : ''}`, () => draw(index, false), { 'data-page': page.id }));
    const nav = h('nav', { class: 'hive-promo-nav', 'aria-label': 'Introduction pages' }, h('ol', {}, navButtons.map(btn => h('li', {}, btn))));
    const status = h('span', { class: 'hive-sr-only', role: 'status', 'aria-live': 'polite' });
    const select = h('select', { id: 'hive-promo-jump', onchange: event => draw(Number(event.target.value), false) }, manifest.pages.map((page, index) => h('option', { value: String(index) }, `${index + 1} · ${page.label}`)));
    const jump = h('label', { class: 'hive-promo-jump', for: 'hive-promo-jump' }, 'Jump to page', select);
    const pageSlot = h('div', { class: 'hive-promo-page' });
    const counter = h('span', { class: 'hive-promo-counter' });
    const back = button('← Back', () => draw(current.page - 1, true));
    const next = button('', () => current.page === manifest.pages.length - 1 ? end(true) : draw(current.page + 1, true), { class: 'hive-btn hive-promo-next' });
    const enlarge = button('Enlarge example', () => enlargePage(true), { class: 'hive-quiet-btn hive-promo-enlarge' });
    const body = h('section', { class: 'hive-promo-inner' },
      h('div', { class: 'hive-promo-eyebrow' }, h('span', {}, 'Introducing Hive'), counter),
      offer.digest ? h('p', { class: 'hive-promo-digest' }, offer.digest) : null,
      jump, pageSlot, enlarge,
      h('footer', { class: 'hive-promo-footer' }, button('Close intro', () => end(true), { class: 'hive-quiet-btn' }), back, next));
    const enlarged = h('section', { class: 'hive-promo-large', hidden: true });
    function enlargePage(on) {
      current.enlarged = on;
      const page = manifest.pages[current.page];
      body.hidden = on; nav.hidden = on; silhouette.hidden = on;
      enlarged.hidden = !on;
      dialog.setAttribute('aria-label', on ? `${page.label} example — demo hive` : 'Introducing Hive');
      dialog.setAttribute('data-enlarged', String(on));
      if (on) {
        const close = button('Back to intro', () => enlargePage(false));
        enlarged.replaceChildren(h('h2', {}, `${page.label} example`), h('p', {}, 'Demo hive · drawn example'), image(page), h('p', {}, page.caption), close);
        close.focus();
      } else enlarge.focus();
    }
    function draw(index, focus) {
      current.page = Math.max(0, Math.min(manifest.pages.length - 1, index));
      const page = manifest.pages[current.page];
      const title = h('h2', { tabindex: '-1', id: 'hive-promo-page-title' }, page.title);
      const figure = h('figure', {}, h('div', { class: 'hive-promo-image' }, image(page)), h('figcaption', {}, page.caption));
      pageSlot.replaceChildren(title, h('p', {}, page.text), figure);
      pageSlot.setAttribute('data-page', page.id);
      counter.textContent = `Page ${current.page + 1} of ${manifest.pages.length}`;
      status.textContent = `${page.label}, page ${current.page + 1} of ${manifest.pages.length}`;
      select.value = String(current.page);
      navButtons.forEach((btn, i) => { if (i === current.page) btn.setAttribute('aria-current', 'step'); else btn.removeAttribute('aria-current'); });
      back.style.visibility = current.page ? 'visible' : 'hidden';
      back.disabled = !current.page;
      next.textContent = page.next + (current.page === manifest.pages.length - 1 ? '' : ' →');
      if (focus) title.focus();
      body.scrollTop = 0;
      if (globalThis.requestAnimationFrame) {
        if (current.fitFrame) cancelAnimationFrame(current.fitFrame);
        current.fitFrame = requestAnimationFrame(() => { current.fitFrame = null; fitContent(); });
      }
    }
    function fitContent() {
      if (active !== current || current.enlarged) return;
      if (body.scrollHeight > body.clientHeight + 2 || pageSlot.scrollHeight > pageSlot.clientHeight + 2) dialog.setAttribute('data-rectangle', 'true');
    }
    const close = button('Close intro ×', () => end(true), { class: 'hive-quiet-btn hive-promo-close' });
    dialog.append(silhouette, nav, body, close, status, enlarged);
    dialog.addEventListener('cancel', event => { event.preventDefault(); current.enlarged ? enlargePage(false) : end(true); });
    dialog.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); current.enlarged ? enlargePage(false) : end(true); }
      if (event.key !== 'Tab') return;
      const controls = [...dialog.querySelectorAll('*')].filter(el => ['button', 'select'].includes(el.tagName.toLowerCase())).filter(el => !el.disabled && !el.hidden && !el.closest?.('[hidden]') && (el.getClientRects ? el.getClientRects().length > 0 : true));
      const first = controls[0], last = controls.at(-1), at = document.activeElement;
      if (controls.length && ((!controls.includes(at)) || (event.shiftKey ? at === first : at === last))) { event.preventDefault(); (event.shiftKey ? last : first).focus(); }
    });
    root().append(dialog);
    pause(true);
    dialog.showModal();
    draw(current.page, true);
    if (globalThis.ResizeObserver) {
      current.observer = new ResizeObserver(fitContent);
      current.observer.observe(body);
    }
    return true;
  };
  return {
    open,
    offer({ blocked = false } = {}) {
      if (blocked || active) return false;
      const offer = saved.offer(manifest);
      return offer.show ? open(document.activeElement, offer) : false;
    },
    isOpen: () => Boolean(active),
    dispose: () => end(false),
  };
}
