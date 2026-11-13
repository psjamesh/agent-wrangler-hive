const camel = name => name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());

export class Node {
  constructor() { this.parentNode = null; }
  get parentElement() { return this.parentNode instanceof Element ? this.parentNode : null; }
  get isConnected() { let n = this; while (n.parentNode) n = n.parentNode; return n === document.documentElement; }
  remove() { this.parentNode?.removeChild(this); }
}

export class Text extends Node {
  constructor(data) { super(); this.data = String(data); this.nodeType = 3; }
  get textContent() { return this.data; }
}

export class Element extends Node {
  constructor(tag) {
    super();
    this.tagName = tag; this.nodeType = 1;
    this.childNodes = []; this.attributes = {}; this.listeners = {}; this.dataset = {}; this.style = {};
  }
  get children() { return this.childNodes.filter(n => n instanceof Element); }
  get firstChild() { return this.childNodes[0] ?? null; }
  get lastChild() { return this.childNodes.at(-1) ?? null; }
  get textContent() { return this.childNodes.map(n => n.textContent).join(''); }
  setAttribute(k, v) { this.attributes[k] = String(v); if (k.startsWith('data-')) this.dataset[camel(k)] = String(v); }
  getAttribute(k) { return this.attributes[k] ?? null; }
  removeAttribute(k) { delete this.attributes[k]; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  dispatchEvent(event) { event.target = this; for (const fn of this.listeners[event.type] || []) fn(event); return !event.defaultPrevented; }
  click() { fire(this, 'click'); }
  focus() { document.activeElement = this; }
  contains(node) { for (let n = node; n; n = n.parentNode) if (n === this) return true; return false; }
  insertBefore(node, ref) {
    node.parentNode?.removeChild(node);
    const at = ref ? this.childNodes.indexOf(ref) : this.childNodes.length;
    this.childNodes.splice(at, 0, node);
    node.parentNode = this;
    return node;
  }
  append(...nodes) { for (const n of nodes) this.insertBefore(typeof n === 'object' ? n : new Text(n), null); }
  removeChild(node) { this.childNodes.splice(this.childNodes.indexOf(node), 1); node.parentNode = null; return node; }
  replaceChildren(...nodes) { for (const n of [...this.childNodes]) this.removeChild(n); this.append(...nodes); }
  querySelectorAll(selector) {
    const attr = selector.match(/^\[([\w-]+)\]$/);
    const match = el => attr ? el.attributes[attr[1]] !== undefined : el.tagName === selector;
    return this.children.flatMap(c => [...(match(c) ? [c] : []), ...c.querySelectorAll(selector)]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  isEqualNode(other) {
    if (!(other instanceof Element) || other.tagName !== this.tagName) return false;
    if (JSON.stringify([this.attributes, this.dataset]) !== JSON.stringify([other.attributes, other.dataset])) return false;
    if (this.childNodes.length !== other.childNodes.length) return false;
    return this.childNodes.every((n, i) => n instanceof Text ? other.childNodes[i] instanceof Text && n.data === other.childNodes[i].data : n.isEqualNode(other.childNodes[i]));
  }
  showModal() { this.open = true; }
  close(value) {
    if (value !== undefined) this.returnValue = String(value);
    if (!this.open) return;
    this.open = false;
    fire(this, 'close');
  }
}

export function fire(el, type, props = {}) {
  const event = { type, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...props };
  el.dispatchEvent(event);
  return event;
}

export const press = (el, key, props = {}) => fire(el, 'keydown', { key, ...props });
export const walk = el => [el, ...el.children.flatMap(walk)];
export const byTag = (root, tag) => walk(root).filter(e => e.tagName === tag);

export function installDom(t) {
  const previous = { document: globalThis.document, Node: globalThis.Node };
  const documentElement = new Element('html');
  const body = new Element('body');
  documentElement.append(body);
  const document = {
    documentElement, body, activeElement: body,
    createElement: tag => new Element(tag),
    createElementNS: (_, tag) => new Element(tag),
    createTextNode: text => new Text(text),
    querySelector: s => body.querySelector(s),
    querySelectorAll: s => body.querySelectorAll(s),
  };
  Object.assign(globalThis, { document, Node });
  t.after(() => Object.assign(globalThis, previous));
  return document;
}
