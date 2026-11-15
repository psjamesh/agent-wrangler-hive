import test from 'node:test';
import assert from 'node:assert/strict';
import { revealMessage, cancelMessageReveal } from './deep-links.js';

function layout(t) {
  const before = { ResizeObserver: globalThis.ResizeObserver, MutationObserver: globalThis.MutationObserver };
  const observers = [];
  globalThis.ResizeObserver = class {
    constructor(fn) { this.fn = fn; observers.push(this); }
    observe() {}
    disconnect() { this.disconnected = true; }
  };
  globalThis.MutationObserver = undefined;
  t.after(() => Object.assign(globalThis, before));
  const events = {};
  let top = 0, offset = 700;
  const list = {
    dataset: { scrollKey: 'messages:c:t' }, style: { space: '', getPropertyValue() { return this.space; }, setProperty(_key, value) { this.space = value; } }, clientHeight: 500, clientWidth: 400,
    children: [], parentElement: null,
    getBoundingClientRect: () => ({ top: 100, width: 400 }),
    get scrollHeight() { return Math.max(this.clientHeight, offset + 100 + (parseFloat(this.style.space) || 0)); },
    get scrollTop() { return top; },
    set scrollTop(n) { top = Math.max(0, Math.min(n, this.scrollHeight - this.clientHeight)); },
  };
  const item = {
    dataset: { id: 'request' }, parentElement: list,
    getBoundingClientRect: () => ({ top: 100 + offset - top, width: 400, height: 100 }),
    scrollIntoView() { list.scrollTop = offset; },
  };
  list.children = [item];
  const root = {
    clientWidth: 800, querySelectorAll: () => [item],
    addEventListener(type, fn) { (events[type] ||= new Set()).add(fn); },
    removeEventListener(type, fn) { events[type]?.delete(fn); },
  };
  return { root, list, item, shift(n) { offset += n; }, resize() { for (const o of observers) if (!o.disconnected) o.fn([]); }, fire(type, props = {}) { for (const fn of events[type] || []) fn({ type, ...props }); } };
}

test('a short final request has enough trailing space to align at the pane top', t => {
  const f = layout(t);
  assert.equal(revealMessage(f.root, 'request'), true);
  assert.equal(f.item.getBoundingClientRect().top, 100);
});

test('late image/markdown layout and subsequent scroll restoration keep the request aligned', t => {
  const f = layout(t);
  revealMessage(f.root, 'request');
  f.shift(300);
  f.resize();
  assert.equal(f.item.getBoundingClientRect().top, 100);
  f.list.scrollTop = 10;
  revealMessage(f.root, 'request');
  assert.equal(f.item.getBoundingClientRect().top, 100);
  f.fire('wheel');
  f.list.scrollTop = 20;
  f.shift(200);
  f.resize();
  assert.equal(f.list.scrollTop, 20, 'reader scrolling releases the reveal');
  assert.notEqual(f.list.style.space, '', 'reader interaction preserves geometry to avoid moving a clicked answer');
  cancelMessageReveal(f.root);
  assert.equal(f.list.style.space, '', 'navigation releases temporary scroll space');
});

import { installDom, walk } from '../test/helpers/dom.mjs';
import { waitingSection, openWaitingMenu, disposeWaitingMenu } from './waiting-view.js';
import { needsRows, inboxRow } from './global-inbox.js';
import { createRequestNotifications } from './requests.js';
import { hiveLink, installHiveLinks } from './deep-links.js';

for (const path of ['waiting menu', 'request section', 'global inbox', 'notification popup', 'pasted deep link']) {
  test(`${path} opens the exact request through the shared reveal and survives late layout`, async t => {
    installDom(t);
    const f = layout(t);
    const request = { id: 'r', cellId: 'c', threadId: 'topic', messageId: 'request', beadId: 'b', audience: 'human', state: 'open', title: 'Choose', body: 'Pick one', routeRevision: 1, revision: 1 };
    const cell = { id: 'c', rootBeadId: 'b', enabled: true, requests: { r: request }, threads: [], messages: [], bindings: [] };
    const ctx = { hive: { cells: { c: cell }, beads: { b: { id: 'b', title: 'Work' } } }, graph: { sessions: [] }, ui: {} };
    let href;
    if (path === 'waiting menu' || path === 'request section') {
      let section;
      if (path === 'waiting menu') {
        openWaitingMenu(ctx, [{ id: 'request:r', kind: 'request', cellId: 'c', beadIds: ['b'], title: 'Choose', threadId: 'topic', messageId: 'request' }]);
        section = document.body;

      } else section = waitingSection(ctx, ctx.hive.beads.b);
      href = walk(section).find(el => el.tagName === 'a').getAttribute('href');
      if (path === 'waiting menu') disposeWaitingMenu();
    } else if (path === 'global inbox') {
      const row = needsRows(ctx, [cell])[0];
      href = walk(inboxRow(ctx, row)).find(el => el.tagName === 'a').getAttribute('href');
    } else if (path === 'notification popup') {
      let answer;
      const notify = createRequestNotifications({ ui: { notify: () => new Promise(resolve => { answer = resolve; }) } }, { open: url => { href = url; } });
      notify({ cells: {} });
      notify(ctx.hive);
      answer('open');
      await Promise.resolve();
    } else href = hiveLink('c', 'topic', 'request');
    let target;
    const win = { location: { hash: href }, history: { replaceState(_s, _t, hash) { win.location.hash = hash; } }, addEventListener() {}, removeEventListener() {} };
    const bridge = installHiveLinks(win, value => {
      target = value;
      revealMessage(f.root, value.messageId);
    });
    t.after(() => bridge.dispose());
    assert.deepEqual(target, { cellId: 'c', threadId: 'topic', messageId: 'request' });
    assert.equal(f.item.getBoundingClientRect().top, 100);
    f.shift(250);
    f.resize();
    assert.equal(f.item.getBoundingClientRect().top, 100);
  });
}

test('untracked scrolling releases alignment for focus, find and assistive technology', t => {
  const f = layout(t);
  let cancelled = false;
  revealMessage(f.root, 'request', () => { cancelled = true; });
  f.list.scrollTop = 15;
  f.fire('scroll', { target: f.list });
  assert.equal(cancelled, true);
  f.shift(200);
  f.resize();
  assert.equal(f.list.scrollTop, 15);
  assert.equal(f.list.style.space, '');
});


test('a topic shorter than its viewport still reserves only the space below the target', t => {
  const f = layout(t);
  f.shift(-700);
  revealMessage(f.root, 'request');
  assert.equal(f.list.style.space, '400px');
});
