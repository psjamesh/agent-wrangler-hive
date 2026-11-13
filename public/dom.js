import { beadReferenceMatches } from './bead-references.js';
import { hiveLink, parseHiveLink } from './deep-links.js';
import { sessionLinkId, bareSessionLinks } from './session-links.js';

let sessionLinkGuard = null;
export function setSessionLinkGuard(fn) { sessionLinkGuard = fn; }

export function h(tag, attrs = {}, ...children) {
  const svg = tag.startsWith('svg:');
  const el = svg ? document.createElementNS('http://www.w3.org/2000/svg', tag.slice(4)) : document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.setAttribute('class', value);
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'value' && !svg) el.value = value;
    else if (value === true) el.setAttribute(key, '');
    else el.setAttribute(key, String(value));
  }
  append(el, children);
  return el;
}

export function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export function markdown(api, text, references = null) {
  const el = h('div', { class: 'hive-md' });
  const html = api?.ui?.markdownPreview ? api.ui.markdownPreview(String(text || '')) : '';
  if (html) el.innerHTML = html;
  else el.textContent = String(text || '');
  linkBareSessions(el);
  for (const a of el.querySelectorAll('a[href]')) {
    const sessionId = sessionLinkId(a.getAttribute('href'));
    if (sessionId) {
      a.addEventListener('click', (e) => {
        if (sessionLinkGuard && sessionLinkGuard(sessionId) === false) e.preventDefault();
      });
      continue;
    }
    if (parseHiveLink(a.getAttribute('href'))) continue;
    if (!/^https?:\/\//i.test(a.getAttribute('href') || '')) a.removeAttribute('href');
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
  }
  if (references) linkBeads(el, references);
  return el;
}

function linkBareSessions(el) {
  const walk = (node) => {
    for (const child of [...(node.childNodes || [])]) {
      if (child.nodeType === 3) {
        const found = bareSessionLinks(child.data);
        if (!found.length) continue;
        const parts = [];
        let from = 0;
        for (const f of found) {
          parts.push(document.createTextNode(child.data.slice(from, f.index)), h('a', { href: f.text }, f.text));
          from = f.index + f.text.length;
        }
        child.replaceWith(...parts, document.createTextNode(child.data.slice(from)));
      } else if (!['A', 'CODE', 'PRE'].includes(child.tagName?.toUpperCase())) walk(child);
    }
  };
  walk(el);
}

function linkBeads(el, { beadIds, cellId, onHighlight, onOpen }) {
  const blocks = new Set(['DIV', 'P', 'BR', 'HR', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'PRE', 'UL', 'OL', 'LI', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD']);
  const segments = [];
  let text = '';
  const read = (node, linkable = true) => {
    if (node.nodeType === 3) {
      segments.push({ node, start: text.length, end: text.length + node.data.length, linkable });
      text += node.data;
      return;
    }
    const tag = node.tagName?.toUpperCase();
    if (blocks.has(tag)) text += '\n';
    for (const child of node.childNodes || []) read(child, linkable && !['A', 'CODE', 'PRE'].includes(tag));
    if (blocks.has(tag)) text += '\n';
  };
  read(el);
  const urls = [...text.matchAll(/(?:[a-z][a-z0-9+.-]*:\/\/|file:|mailto:|\/\/|www\.)[^\s<>]+/gi)];
  const replacements = new Map();
  let index = 0;
  for (const match of beadReferenceMatches(text)) {
    const id = match[0];
    if (!beadIds.has(id) || urls.some(url => match.index >= url.index && match.index < url.index + url[0].length)) continue;
    while (segments[index] && segments[index].end <= match.index) index += 1;
    const segment = segments[index];
    if (!segment?.linkable || match.index < segment.start || match.index + id.length > segment.end) continue;
    if (!replacements.has(segment)) replacements.set(segment, []);
    replacements.get(segment).push({ id, offset: match.index - segment.start });
  }
  for (const [{ node }, matches] of replacements) {
    const parts = [];
    let from = 0;
    for (const { id, offset } of matches) {
      parts.push(document.createTextNode(node.data.slice(from, offset)), h('a', {
        href: hiveLink(cellId, null, null, { beadId: id, pane: 'details' }),
        class: 'hive-bead-reference',
        onpointerenter: () => onHighlight?.(id, 'pointer'),
        onpointerleave: () => onHighlight?.(null, 'pointer'),
        onfocus: () => onHighlight?.(id, 'focus'),
        onblur: () => onHighlight?.(null, 'focus'),
        onfocusin: e => e.stopPropagation(),
        onclick: e => { e.preventDefault(); e.stopPropagation(); onOpen?.(id); },
      }, id));
      from = offset + id.length;
    }
    node.replaceWith(...parts, document.createTextNode(node.data.slice(from)));
  }
}

export function safeHref(url) {
  return typeof url === 'string' && /^https?:\/\//i.test(url) ? url : null;
}

// The part of an element, top to bottom, that can be seen through every
// scrolling box around it and the window.
export function visibleBand(el) {
  const r = el.getBoundingClientRect();
  let top = Math.max(r.top, 0);
  let bottom = Math.min(r.bottom, globalThis.innerHeight || r.bottom);
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    if (!/auto|scroll|hidden/.test(getComputedStyle(p).overflowY)) continue;
    const b = p.getBoundingClientRect();
    top = Math.max(top, b.top);
    bottom = Math.min(bottom, b.bottom);
  }
  return { top, bottom };
}

export function relativeTime(at, now = Date.now()) {
  const t = typeof at === 'number' ? at : Date.parse(at);
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export const HIVE_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="M7 3.5h4l2 3.5-2 3.5H7L5 7z"/><path d="M15 9h4l2 3.5-2 3.5h-4l-2-3.5z"/><path d="M7 14.5h4l2 3.5-2 3.5H7L5 18z"/></svg>';

export function syncChildren(el, children, beforeRemove) {
  const wanted = children.flat(Infinity).filter(x => x !== null && x !== undefined && x !== false);
  for (const child of [...el.childNodes]) if (!wanted.includes(child)) { beforeRemove?.(child); el.removeChild(child); }
  for (let i = 0; i < wanted.length; i++) {
    if (el.childNodes[i] !== wanted[i]) el.insertBefore(wanted[i], el.childNodes[i] || null);
  }
  while (el.childNodes.length > wanted.length) el.removeChild(el.lastChild);
  return el;
}
