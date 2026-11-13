import test from 'node:test';
import assert from 'node:assert/strict';
import * as view from './waiting-view.js';
import * as prv from './pr-view.js';
class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.attrs = {}; this.events = {}; this.dataset = {}; this.style = {}; this.isConnected = true; }
  setAttribute(k, v) { this.attrs[k] = v; }
  addEventListener(k, fn) { this.events[k] = fn; }
  append(...nodes) { for (const n of nodes) if (n instanceof Element) n.parentElement = this; this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  querySelectorAll(selector) { return all(this).filter(n => selector === '[data-wait-action]' ? Boolean(n.dataset.waitAction) : n.tag === 'button' || n.tag === 'a'); }
  closest() { return this.dataset.waitId ? this : this.parentElement?.closest() || null; }
  showModal() { this.open = true; }
  close() { this.open = false; this.events.close(); }
  remove() { this.removed = true; this.isConnected = false; }
  focus() { document.activeElement = this; }
}
const all = el => [el, ...(el?.children || []).flatMap(n => n instanceof Element ? all(n) : [])];
const text = el => (el?.children || []).map(n => n instanceof Element ? text(n) : n).join('');
function setup(t) {
  const old = { document: globalThis.document, Node: globalThis.Node };
  globalThis.Node = Element;
  globalThis.document = { body: new Element('body'), activeElement: new Element('button'), createElement: tag => new Element(tag), createTextNode: x => String(x) };
  t.after(() => Object.assign(globalThis, old));
  const cell = { id: 'c', enabled: true, rootBeadId: 'a', bindings: [], waits: [{ id: 'message:m', kind: 'message', title: 'Look here', reason: 'Awaiting acknowledgement', cellId: 'c', beadIds: ['a'], messageId: 'm', threadId: 'topic' }], pullRequests: [], threads: [{ id: 'topic', beadId: 'a' }] };
  const frames = [];
  const ctx = { hive: { cells: { c: cell }, beads: { a: { id: 'a', title: 'First bead' }, b: { id: 'b', title: 'Second bead', parentId: 'a' } } }, graph: { sessions: [] }, ui: { inspect: () => {} }, notice: () => {}, send: (...a) => frames.push(a) };
  return { ctx, cell, frames };
}
test('waiting modal uses native focus, closes on Escape and navigation, and labels every associated bead', t => {
  const f = setup(t), opener = document.activeElement;
  const items = [{ ...f.cell.waits[0], beadIds: ['a', 'b'] }];
  view.openWaitingMenu(f.ctx, items);
  const dialog = document.body.children[0];
  assert.equal(dialog?.tag, 'dialog');
  assert.equal(dialog.open, true);
  assert.match(text(dialog), /First bead.*Second bead/);
  const reply = all(dialog).find(n => n.tag === 'a' && text(n) === 'Reply');
  assert.match(reply.attrs.href, /message=m/);
  reply.events.click();
  assert.equal(dialog.removed, true);
  assert.equal(document.activeElement, opener);
  view.openWaitingMenu(f.ctx, items);
  const again = document.body.children[1];
  again.events.cancel({ preventDefault() {} });
  assert.equal(again.removed, true);
});
test('real PR actions open GitHub and ask the queen in the bead topic; checks and history stay collapsed', t => {
  const f = setup(t), pr = { url: 'https://github.com/example/repo/pull/7', number: 7, title: 'Ship', state: 'OPEN', headSha: 'a'.repeat(40), checks: 'failing', stateCheckedAt: Date.now(), beadIds: ['a'], cellId: 'c', humanAttention: { state: 'cannot-fix', headSha: 'a'.repeat(40), reason: 'Admin approval required' } };
  f.cell.pullRequests = [pr, { ...pr, state: 'MERGED' }];
  const section = prv.pullRequestsSection(f.ctx, f.ctx.hive.beads.a);
  assert.ok(section);
  assert.equal(all(section).some(n => /Merge/.test(text(n)) && n.tag === 'button'), false);
  const link = all(section).find(n => n.tag === 'a' && text(n) === 'Open on GitHub');
  assert.equal(link.attrs.href, pr.url);
  assert.equal(link.attrs.target, '_blank');
  assert.ok(all(section).filter(n => n.tag === 'details').length >= 2);
  assert.equal(all(section).filter(n => n.tag === 'details').some(n => 'open' in n.attrs), false);
  all(section).find(n => n.tag === 'button' && text(n) === 'Ask the queen to fix').events.click();
  assert.equal(f.frames[0][0].type, 'hive-send');
  assert.equal(f.frames[0][0].threadId, 'topic');
  assert.match(f.frames[0][0].text, /Admin approval required/);
});

test('a real tile gets one person and the exact unified badge count, while ordinary review marks survive', async t => {
  const f = setup(t);
  const { beadTile } = await import('./cell-view.js');
  const bead = f.ctx.hive.beads.a;
  Object.assign(bead, { status: 'in_progress', kind: 'work', reviewState: 'in_review', reviewWorking: true });
  f.ctx.hive.edges = [];
  const tile = { cellId: 'c', layout: { groupHeads: [], parentHead: {}, halo: {} } };
  let output = beadTile(f.ctx, bead, tile, new Map());
  assert.equal(output.mark.kind, 'person');
  assert.equal(output.mark.count, 1);
  assert.equal(typeof output.onMark, 'function');
  assert.match(output.ariaLabel, /Enter opens/);
  const fresh = { ...f.ctx, hive: { ...f.ctx.hive, cells: { c: { ...f.cell, waits: [] } } } };
  output = beadTile(fresh, bead, tile, new Map());
  assert.equal(output.mark.kind, 'review-working');
});

test('refreshing away the last wait closes the modal without leaving a stale action', t => {
  const f = setup(t);
  view.openWaitingMenu(f.ctx, f.cell.waits);
  const dialog = document.body.children[0];
  view.refreshWaitingMenu({ ...f.ctx, hive: { ...f.ctx.hive, cells: { c: { ...f.cell, waits: [] } } } });
  assert.equal(dialog.removed, true);
});

test('an unchanged PR poll does not replace modal controls or re-enable a sent queen request', t => {
  const f = setup(t), sha = 'a'.repeat(40);
  const pr = { url: 'https://github.com/example/repo/pull/7', number: 7, title: 'Ship', state: 'OPEN', headSha: sha, checks: 'failing', stateCheckedAt: Date.now(), beadIds: ['a'], cellId: 'c', humanAttention: { state: 'cannot-fix', headSha: sha, reason: 'Admin approval' } };
  f.cell.waits = [];
  f.cell.pullRequests = [pr];
  view.openWaitingMenu(f.ctx, view.cellWaitingItems(f.ctx, f.cell));
  const dialog = document.body.children[0];
  const ask = all(dialog).find(n => n.tag === 'button' && text(n) === 'Ask the queen to fix');
  ask.events.click();
  const fresh = { ...f.ctx, hive: { ...f.ctx.hive, cells: { c: { ...f.cell, pullRequests: [{ ...pr, stateCheckedAt: Date.now() + 1000 }] } } } };
  view.refreshWaitingMenu(fresh);
  const nextAsk = all(dialog).find(n => n.tag === 'button' && text(n) === 'Ask the queen to fix');
  assert.equal(nextAsk, ask);
  assert.equal(nextAsk.disabled, true);
});

test('shared PR actions from the second bead keep that bead and topic in Details and the tile dialog', t => {
  const f = setup(t), sha = 'a'.repeat(40);
  f.cell.waits = [];
  f.cell.threads.push({ id: 'topic-b', beadId: 'b' });
  f.cell.pullRequests = [{ url: 'https://github.com/example/repo/pull/8', number: 8, title: 'Shared', state: 'OPEN', headSha: sha, checks: 'green', stateCheckedAt: Date.now(), beadIds: ['a', 'b'], cellId: 'c', humanAttention: { state: 'cannot-fix', headSha: sha, reason: 'Conflict' } }];
  const section = view.waitingSection(f.ctx, f.ctx.hive.beads.b);
  all(section).find(n => n.tag === 'button' && text(n) === 'Ask the queen to fix').events.click();
  assert.equal(f.frames[0][0].beadId, 'b');
  assert.equal(f.frames[0][0].threadId, 'topic-b');
  const modalCtx = { ...f.ctx, ui: {} };
  view.openWaitingMenu(modalCtx, view.waitingItems(modalCtx, f.ctx.hive.beads.b), null, { cellId: 'c', beadId: 'b' });
  const dialog = document.body.children[0];
  all(dialog).find(n => n.tag === 'button' && text(n) === 'Ask the queen to fix').events.click();
  assert.equal(f.frames[1][0].beadId, 'b');
  assert.equal(f.frames[1][0].threadId, 'topic-b');
  assert.match(f.frames[1][0].text, /Second bead/);
});

test('a failed observation displays the retained success as stale with its error outside collapsed checks', t => {
  const f = setup(t), sha = 'a'.repeat(40);
  f.cell.pullRequests = [{ url: 'https://github.com/example/repo/pull/8', number: 8, title: 'Stale', state: 'OPEN', headSha: sha, checks: 'green', stateCheckedAt: Date.now(), beadIds: ['a'], cellId: 'c', humanAttention: { state: 'ready', headSha: sha, reason: 'Reviewed' }, observationError: { message: 'Permission denied', at: Date.now(), retryAt: Date.now() + 60000 } }];
  const section = prv.pullRequestsSection(f.ctx, f.ctx.hive.beads.a);
  const row = all(section).find(n => n.tag === 'article');
  assert.match(row.attrs.class, /hive-pr-stale/);
  assert.ok(row.children.some(n => n.tag === 'p' && /Permission denied/.test(text(n))));
});

test('changed waits preserve focus by wait/action identity and keep submitted queen help disabled across surfaces', t => {
  const f = setup(t), sha = 'a'.repeat(40), pr = { url: 'https://github.com/example/repo/pull/9', number: 9, title: 'Focus', state: 'OPEN', headSha: sha, checks: 'green', stateCheckedAt: Date.now(), beadIds: ['a'], cellId: 'c', humanAttention: { state: 'cannot-fix', headSha: sha, reason: 'Conflict', at: 1 } };
  f.cell.waits = [];
  f.cell.pullRequests = [pr];
  view.openWaitingMenu(f.ctx, view.cellWaitingItems(f.ctx, f.cell));
  const dialog = document.body.children[0];
  all(dialog).find(n => n.tag === 'button' && text(n) === 'Ask the queen to fix').events.click();
  all(dialog).find(n => n.tag === 'a' && text(n) === 'Open on GitHub').focus();
  const message = { id: 'message:new', kind: 'message', title: 'New message', reason: 'Read me', beadIds: ['a'], cellId: 'c', threadId: 'new-topic', messageId: 'new' };
  const next = { ...f.ctx, hive: { ...f.ctx.hive, cells: { c: { ...f.cell, waits: [message] } } } };
  view.refreshWaitingMenu(next);
  assert.equal(text(document.activeElement), 'Open on GitHub');
  assert.equal(document.activeElement.attrs.href, pr.url);
  const ask = all(dialog).find(n => n.tag === 'button' && text(n) === 'Ask the queen to fix');
  assert.equal(ask.disabled, true);
  ask.events.click();
  assert.equal(f.frames.length, 1);
  const details = prv.pullRequestsSection(next, next.hive.beads.a);
  assert.equal(all(details).find(n => n.tag === 'button' && text(n) === 'Ask the queen to fix').disabled, true);
  const withoutPr = { ...next, hive: { ...next.hive, cells: { c: { ...next.hive.cells.c, pullRequests: [] } } } };
  view.refreshWaitingMenu(withoutPr);
  assert.equal(document.activeElement.attrs['aria-label'], 'Close waiting for you');
});

test('the header chooses and names a stable queen-help bead regardless of PR association order', t => {
  const f = setup(t), sha = 'a'.repeat(40);
  f.cell.waits = [];
  f.cell.pullRequests = [{ url: 'https://github.com/example/repo/pull/10', number: 10, title: 'Shared header', state: 'OPEN', headSha: sha, checks: 'green', stateCheckedAt: Date.now(), beadIds: ['b', 'a'], cellId: 'c', humanAttention: { state: 'cannot-fix', headSha: sha, reason: 'Conflict' } }];
  view.openWaitingMenu(f.ctx, view.cellWaitingItems(f.ctx, f.cell));
  const dialog = document.body.children[0];
  assert.match(text(dialog), /Queen help will be posted under “First bead”/);
  all(dialog).find(n => n.tag === 'button' && text(n) === 'Ask the queen to fix').events.click();
  assert.equal(f.frames[0][0].beadId, 'a');
});

test('native waits open the exact request card without adding answer controls and disappear after delivery', t => {
  const f = setup(t);
  const request = { id: 'native', cellId: 'c', audience: 'human', state: 'open', title: 'Choose an API', beadId: 'b', threadId: 'native-topic', messageId: 'native-message' };
  f.cell.requests = { native: request };
  const items = view.waitingItems(f.ctx, f.ctx.hive.beads.b);
  assert.equal(items.length, 1);
  const section = view.waitingSection(f.ctx, f.ctx.hive.beads.b);
  const link = all(section).find(n => n.tag === 'a' && text(n) === 'Open request');
  assert.match(link?.attrs.href || '', /cell=c&topic=native-topic&message=native-message/);
  assert.equal(all(section).some(n => n.tag === 'textarea' || (n.tag === 'button' && /Answer|Dismiss|Retry/.test(text(n)))), false);
  assert.equal(f.frames.length, 0);
  view.openWaitingMenu(f.ctx, items, null, { cellId: 'c', beadId: 'b' });
  const dialog = document.body.children[0];
  const next = { ...f.ctx, hive: { ...f.ctx.hive, cells: { c: { ...f.cell, requests: { native: { ...request, state: 'answered', delivery: { state: 'delivered' } } } } } } };
  view.refreshWaitingMenu(next);
  assert.equal(dialog.removed, true);
});
