import { inboxRows, needsRows, mergeRows, inboxRow, inboxFilters, inboxTotals, searchedInbox, inboxSearchBox } from './global-inbox.js';
import { searchTerms } from './inbox-search.js';
import { beadReferences } from './bead-references.js';
import { requestCard, needsHuman } from './requests.js';
import { conversationEpoch } from './view-state.js';
import { confirmHive } from './confirm-dialog.js';
import { imageDraft, imageComposer, messageImages } from './attachments.js';
import { conversationInputs } from './view-inputs.js';
import { h, syncChildren, markdown, relativeTime, sessionReference } from './dom.js';
import { hiveLink } from './deep-links.js';
import { reactionGlyph } from './reaction-glyphs.js';

const WINDOW = 40;
const BRIDGE = 100;

const REACTIONS = [['seen', 'Read'], ['approve', 'Yes'], ['decline', 'No']];
const INBOX_NAME = { human: 'Inbox', queen: 'Waiting for queen' };

const DELIVERY_TEXT = {
  pending: 'Sending…',
  delivered: 'Delivered',
  failed: 'Not delivered',
  uncertain: 'Delivery unconfirmed',
  'no-queen': 'Waiting for a queen',
};

export function sessionName(graph, sessionId) {
  const s = (graph?.sessions || []).find((x) => x.sessionId === sessionId);
  return s ? (s.name || s.label || s.lastLabel || sessionId.slice(0, 8)) : (sessionId ? sessionId.slice(0, 8) : '');
}

function deliveryControls(m, cell, ctx) {
  const d = m.delivery || {};
  const state = m.acknowledgedAt ? 'acknowledged' : d.state;
  const out = [];
  if (m.response?.withdrawn && !m.response.answers?.length && state !== 'acknowledged' && state !== 'delivered') return out;
  if (state === 'acknowledged') {
    out.push(h('span', { class: 'hive-badge hive-badge-ok' }, 'Received'));
    return out;
  }
  out.push(h('span', { class: `hive-badge hive-badge-${state || 'pending'}`, title: d.error || '' }, DELIVERY_TEXT[state] || state || ''));
  const deliverBtn = (label, force) => h('button', {
    type: 'button',
    class: 'hive-link-btn',
    disabled: ctx.busy('hive-deliver'),
    onclick: () => ctx.send({ type: 'hive-deliver', cellId: cell.id, messageId: m.id, force }),
  }, label);
  if (state === 'failed' || state === 'no-queen') {
    if (cell.queenSessionId && cell.enabled) out.push(deliverBtn('Send to queen', false));
  } else if (state === 'uncertain' || (state === 'pending' && (d.attempts || []).length && Date.now() - (d.attempts.at(-1)?.at || 0) > 60000)) {
    out.push(h('button', { type: 'button', class: 'hive-link-btn', onclick: () => ctx.send({ type: 'hive-mark-received', cellId: cell.id, messageId: m.id }) }, 'Queen has it'));
    if (cell.enabled) out.push(h('button', {
      type: 'button',
      class: 'hive-link-btn',
      'data-focus-key': `resend:${m.id}`,
      onclick: async () => {
        if (await confirmHive('The last attempt may already have reached the queen. Send this message again anyway?')) {
          ctx.send({ type: 'hive-deliver', cellId: cell.id, messageId: m.id, force: true });
        }
      },
    }, 'Send again…'));
  }
  if (d.error && state !== 'delivered') out.push(h('span', { class: 'hive-muted' }, d.error));
  return out;
}


function authorName(graph, cell, m) {
  return m.author === 'human' ? 'You' : `${sessionName(graph, m.sessionId)}${m.sessionId === cell.queenSessionId ? ' (queen)' : m.role ? ` (${m.role})` : ''}`;
}

// Whether the queen has answered one of the human's messages. A copy loaded
// earlier may be out of date; when every waiting message is on the inbox's
// first page, one missing from it has been answered since.
function answerState(m, cell) {
  if (!m.response?.required) return null;
  if (m.response.answers?.length) return 'answered';
  if (m.response.withdrawn) return 'withdrawn';
  const first = cell.inbox?.queen;
  if (first && !first.more && !first.ids.includes(m.id)) return 'answered';
  return 'waiting';
}

function answerBadge(m, cell) {
  const s = answerState(m, cell);
  if (!s) return null;
  if (s === 'withdrawn') return h('span', { class: 'hive-badge hive-badge-withdrawn' }, 'Withdrawn');
  return s === 'answered'
    ? h('span', { class: 'hive-badge hive-badge-ok' }, 'Answered')
    : h('span', { class: 'hive-badge hive-badge-waiting' }, 'Waiting for the queen\'s answer');
}

// Withdraw takes one of the human's own waiting messages out of every
// waiting count without a queen reply; Undo puts it back while the queen
// has not answered it.
function withdrawButton(m, cell, ctx, type, label, scope = 'message', ui = null) {
  return h('button', {
    type: 'button',
    class: 'hive-link-btn',
    'aria-disabled': ctx.busy('hive-withdraw') || ctx.busy('hive-withdraw-undo') ? 'true' : 'false',
    'data-focus-key': `withdraw:${scope}:${m.id}:${type === 'hive-withdraw' ? 'do' : 'undo'}`,
    onclick: () => {
      if (ctx.busy('hive-withdraw') || ctx.busy('hive-withdraw-undo')) return;
      ctx.send({ type, cellId: cell.id, messageId: m.id }, {
        onReply: (frame) => {
          if (!frame.ok) ctx.notice(frame.error || 'Could not update the message.');
          else if (scope === 'inbox') ui?.setForm(`withdrawn:${cell.id}`, type === 'hive-withdraw' ? { id: m.id, text: m.text.replace(/\s+/g, ' ').slice(0, 80) } : null);
        },
      });
    },
  }, label);
}

export function ackControls(m, cell, ui, ctx) {
  const ack = ui.ackOf(cell.id, m);
  if (!ack?.required) return null;
  const busy = ctx.busy('hive-ack') || ctx.busy('hive-ack-undo');
  const send = (type, extra) => !busy && ctx.send({ type, cellId: cell.id, messageId: m.id, rev: ack.rev, ...extra }, {
    onReply: (frame) => {
      if (frame.ok) {
        if (type === 'hive-ack') ui.markRead(cell.id, m.threadId, m.at);
        ui.noteAck(cell.id, m.id, frame.ack, frame.marked || []);
      } else {
        ctx.notice(frame.error || 'Could not update the message.', { severity: 'error' });
      }
    },
  });
  const s = ack.state;
  const selected = !s ? null : s.kind === 'read' ? 'seen' : s.reaction;
  return h('div', { class: 'hive-ack', role: 'group', 'aria-label': 'Message reactions' },
    REACTIONS.map(([name, label]) => h('button', {
      type: 'button', class: 'hive-ack-glyph',
      'aria-disabled': busy ? 'true' : 'false', 'aria-pressed': String(selected === name),
      'data-focus-key': `ack:${m.id}:${name}`, 'aria-label': label, title: label,
      onclick: () => selected === name ? send('hive-ack-undo', {}) : send('hive-ack', name === 'seen' ? { kind: 'read' } : { kind: 'reaction', reaction: name }),
    }, reactionGlyph(name), label)),
    s?.emoji ? h('span', { class: 'hive-badge', title: 'Earlier reaction' }, `You reacted ${s.emoji}`) : null,
    s?.kind === 'reply' ? h('span', { class: 'hive-badge' }, 'Answered by your reply') : null);
}

function messageItem({ m, cell, beads, graph, api, ui, ctx, target, replyKey }) {
  const controls = [
    cell.enabled && !cell.snapshot ? h('button', { type: 'button', class: 'hive-link-btn', onclick: () => ui.setReplyFor(replyKey, m.id) }, 'Reply') : null,
    m.author === 'session' ? ackControls(m, cell, ui, ctx) : null,
    m.author === 'human' && !cell.snapshot && answerState(m, cell) === 'waiting' ? withdrawButton(m, cell, ctx, 'hive-withdraw', 'Withdraw') : null,
    m.author === 'human' && !cell.snapshot && answerState(m, cell) === 'withdrawn' ? withdrawButton(m, cell, ctx, 'hive-withdraw-undo', 'Undo') : null,
  ].filter(Boolean);
  const reaction = m.author === 'human' && ['approve', 'decline'].includes(m.reaction) && m.replyTo ? m.reaction : null;
  const reactionLabel = reaction === 'approve' ? 'Yes' : 'No';
  let pointerFocus = false;
  const select = () => { if (!ui.restoringFocus?.()) ui.selectConversationMessage?.(cell.id, m.threadId, m.id); };
  const item = h('li', {
    tabindex: '0',
    'data-focus-key': `message:${cell.id}:${m.id}`,
    onpointerdown: () => { pointerFocus = true; },
    onpointerup: () => { pointerFocus = false; },
    onpointercancel: () => { pointerFocus = false; },
    onclick: select,
    onfocusin: e => { if (e.target === item && !pointerFocus) select(); },
    onkeydown: e => {
      if (e.key === 'Escape') {
        e.preventDefault();
        ui.selectConversationMessage?.(cell.id, m.threadId, null);
      }
    },
    class: `hive-message hive-message-${m.author}${ui.conversationMessage?.(cell.id, m.threadId) === m.id ? ' is-conversation-selected' : ''}${ui.linkedMessage?.(cell.id, m.threadId)?.messageId === m.id ? ' is-link-target' : ''}`,
    dataset: { id: m.id },
  },
    h('div', { class: 'hive-message-head' },
      h('strong', {}, authorName(graph, cell, m)),
      h('span', { class: 'hive-muted' }, relativeTime(m.at)),
      m.beadId ? h('button', { type: 'button', class: 'hive-chip', onclick: () => ui.selectBead(m.beadId) }, beads[m.beadId]?.title || m.beadId) : null),
    target && !reaction ? h('div', { class: 'hive-quote' }, `↪ ${target.text.slice(0, 160)}`) : null,
    m.requestId ? requestCard(cell.requests?.[m.requestId], { cell, graph, api, ui, ctx }) : reaction ? h('a', { class: 'hive-reaction-reply', href: hiveLink(cell.id, m.threadId, m.replyTo), 'aria-label': `${reactionLabel} — view source message`, title: target?.text || 'View source message' }, reactionGlyph(reaction), reactionLabel) : markdown(api, m.text, {
      sessions: graph?.sessions || [],
      beadIds: beneath({ beads }, cell.rootBeadId), cellId: cell.id,
      onHighlight: (id, source) => ctx.beadReference?.highlight?.(id, source),
      onOpen: id => { ui.setPane('details', { render: false }); ui.selectBead(id); },
    }),
    !m.requestId && m.sessionLink ? h('p', { class: 'hive-session-links' }, sessionReference(graph, m.sessionLink)) : null,
    messageImages(m, cell, ui, ctx),
    m.author === 'human' ? h('div', { class: 'hive-delivery' }, deliveryControls(m, cell, ctx), answerBadge(m, cell)) : null,
    controls.length ? h('div', { class: 'hive-message-foot' }, controls) : null);
  for (const tag of ['a', 'button', 'input', 'textarea', 'select', 'summary']) {
    item.querySelectorAll(tag).forEach((control, index) => {
      if (!control.dataset.focusKey) control.dataset.focusKey = `message:${cell.id}:${m.id}:${tag}:${index}`;
    });
  }
  item.hiveRevision = JSON.stringify([m, ui.ackOf(cell.id, m), cell.requests?.[m.requestId]]);
  return item;
}

const byRecent = (a, b) => (b.lastAt || 0) - (a.lastAt || 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// The beads a selection covers: none means the whole hive; an item covers
// itself and everything beneath it.
function selectionScope(hive, cell, selected) {
  if (!selected || selected === cell.rootBeadId || !hive.beads[selected]) return null;
  return beneath(hive, selected);
}

function beneath(hive, top) {
  const kids = new Map();
  for (const b of Object.values(hive.beads)) {
    if (!b.parentId) continue;
    if (!kids.has(b.parentId)) kids.set(b.parentId, []);
    kids.get(b.parentId).push(b.id);
  }
  const out = new Set([top]);
  const stack = [top];
  while (stack.length) for (const c of kids.get(stack.pop()) || []) if (!out.has(c)) { out.add(c); stack.push(c); }
  return out;
}

export function renderRelatedBeads(related, renderChip) {
  const restoreFocus = related.el.contains?.(document.activeElement);
  related.expanded = false;
  const ids = [...related.ids];
  const label = h('span', { class: 'hive-muted' }, ids.length ? 'Related beads: ' : 'No related beads in this hive.');
  if (ids.length <= 3) {
    related.expanded = false;
    related.el.replaceChildren(label, ...ids.map(renderChip));
    return;
  }
  const panel = h('div', { class: 'hive-related-overflow', role: 'region', 'aria-label': 'More related beads' }, ...ids.slice(3).map(renderChip));
  const toggle = h('button', { type: 'button', class: 'hive-link-btn hive-related-toggle', 'data-focus-key': 'related-toggle' });
  const update = () => {
    panel.hidden = !related.expanded;
    toggle.setAttribute('aria-expanded', String(Boolean(related.expanded)));
    toggle.textContent = related.expanded ? 'Show fewer' : `+${ids.length - 3} more`;
  };
  toggle.addEventListener('click', e => {
    e.stopPropagation();
    related.expanded = !related.expanded;
    update();
    toggle.focus({ preventScroll: true });
  });
  const row = h('div', { class: 'hive-related-summary' }, label, ...ids.slice(0, 3).map(renderChip), toggle);
  const wrapper = h('div', { class: 'hive-related-disclosure', onclick: e => e.stopPropagation(), onkeydown: e => {
    if (e.key !== 'Escape' || !related.expanded) return;
    e.preventDefault();
    e.stopPropagation();
    related.expanded = false;
    update();
    toggle.focus({ preventScroll: true });
  }, onfocusout: e => {
    if (!e.relatedTarget || wrapper.contains(e.relatedTarget)) return;
    related.expanded = false;
    update();
  } }, row, panel);
  update();
  related.el.replaceChildren(wrapper);
  if (restoreFocus) toggle.focus({ preventScroll: true });
}

export function relatedBeads(hive, cell, topic, messages, messageId = null) {
  const members = beneath(hive, cell.rootBeadId);
  const ids = new Set([topic.beadId]);
  if (!messageId) for (const id of [...(topic.beads || []), ...(topic.references || [])]) ids.add(id);
  for (const m of messages) {
    if (messageId ? m.id !== messageId : Array.isArray(topic.references)) continue;
    if (m.beadId) ids.add(m.beadId);
    for (const id of beadReferences(m.text)) ids.add(id);
  }
  return new Set([...ids].filter(id => members.has(id) && hive.beads[id]));
}

function inScope(t, scope) {
  if (!scope) return true;
  if (t.beadId && scope.has(t.beadId)) return true;
  return (t.beads || []).some((id) => scope.has(id));
}

// What a message is about, as stored when it was sent; older messages have
// only their bead id.
function contextOf(m) {
  if (m.context !== undefined) return m.context;
  return m.beadId ? { beadId: m.beadId, title: null } : null;
}

function messageContextLabel(m, cell, beads, members) {
  const c = contextOf(m);
  if (!c?.beadId) return 'Hive-wide';
  if (!cell.enabled) return c.title || c.beadId;
  if (members.has(c.beadId)) return beads[c.beadId]?.title || c.title || c.beadId;
  const name = c.title || beads[c.beadId]?.title || c.beadId;
  return beads[c.beadId] ? `${name} (now in another hive)` : `${name} (removed)`;
}

function contextLabel(t, cell, beads) {
  if (!t.beadId) return 'Hive-wide';
  return beads[t.beadId]?.title || (cell.enabled ? 'removed item' : 'an item');
}

export const waitsFor = (ackOf) => (m) => m.author === 'session' && Boolean(ackOf(m)?.required) && !ackOf(m).state;

// The message a topic opens at: its earliest message still awaiting the
// human's acknowledgement, from the messages held and the server's
// `waitingFrom`, as acknowledgements confirmed here since then leave them.
// Null opens at the newest. When waitingFrom has been settled here, the
// held messages may skip later waiting ones, so the answer is only that it
// comes after waitingFrom ({ after }).
export function earliestWaiting(t, msgs, ackOf) {
  const waits = waitsFor(ackOf);
  const found = msgs.filter(waits).sort(inTopicOrder);
  const wf = t.waitingFrom;
  if (!wf || !Number.isInteger(wf.n)) return found[0] || null;
  const held = msgs.find((m) => m.id === wf.id);
  if (waits(held || { id: wf.id, author: 'session', ack: { required: true, state: null, rev: wf.rev } })) return [...found, ...(held ? [] : [wf])].sort(inTopicOrder)[0];
  return found.find((m) => m.n < wf.n) || { after: wf.n };
}

// Where an opened topic starts, found only in the newest unbroken run of the
// topic: the window from windowFrom, joined by a loaded page that reaches it.
// Messages held from elsewhere, such as the Inbox, may leave gaps, so the
// answer ({ id }, '' for the newest) is known once that run reaches back to
// the waiting message, or to the oldest one kept. Until then `before` is the
// message to load history before (null for the newest). Waiting only known
// to come after a message is the first one in the run after it that `waits`.
export function startTarget({ window, page, from, retained, waiting, waits = () => true }) {
  if (!retained || !waiting) return { id: '' };
  let run = from ? window.filter((m) => m.n >= from.n) : [];
  let start = Boolean(from) && run.length >= retained;
  if (page && (!from || !(from.n > page.anchorN))) {
    run = [...new Map([...page.messages, ...run].map((m) => [m.id, m])).values()];
    start = !page.more;
  }
  run.sort(inTopicOrder);
  const after = 'after' in waiting;
  const floor = after ? waiting.after : waiting.n;
  if (start || run.some((m) => m.n <= floor)) return { id: run.find((m) => (after ? m.n > floor && waits(m) : m.n >= floor))?.id || '' };
  return { before: run[0] || null };
}

function ackMessages(msgs) {
  const byId = new Map();
  for (const m of msgs) if (m && (!byId.has(m.id) || (m.ack?.rev ?? -1) >= (byId.get(m.id).ack?.rev ?? -1))) byId.set(m.id, m);
  return [...byId.values()];
}

function acknowledgementSnapshot(cell) {
  const records = cell.inbox?.human?.acknowledgements;
  if (!records) return null;
  const acks = new Map(), topics = new Map();
  for (const [id, record] of Object.entries(records)) {
    acks.set(id, { required: true, rev: record.rev, state: record.waiting ? null : {} });
    if (record.waiting) topics.set(record.threadId, (topics.get(record.threadId) || 0) + 1);
  }
  return { acks, topics };
}

function baselineAck(m, snapshot) {
  return snapshot ? snapshot.acks.get(m.id) : m.ack;
}

function effectiveAck(m, ackOf, snapshot) {
  const baseline = baselineAck(m, snapshot);
  const local = ackOf(m);
  if (snapshot && !baseline) return null;
  return baseline && !(local?.rev > baseline.rev) ? baseline : local;
}

function ackDelta(msgs, ackOf, snapshot) {
  return msgs.reduce((delta, m) => {
    const baseline = baselineAck(m, snapshot);
    if (m.author !== 'session' || !baseline?.required) return delta;
    return delta + Number(!effectiveAck(m, ackOf, snapshot)?.state) - Number(!baseline.state);
  }, 0);
}

function unreadIn(t, msgs, ackOf, snapshot) {
  const known = ackMessages([t.preview, ...msgs]);
  const n = snapshot ? snapshot.topics.get(t.id) || 0 : t.awaiting ? t.awaiting.human?.count || 0 : known.filter(waitsFor(m => m.ack)).length;
  return Math.max(0, n + ackDelta(known, ackOf, snapshot));
}

function composerRow({ cell, beads, ui, ctx, attach, selected, onSubmit, label }) {
  return h('div', { class: 'hive-composer-row' },
    attach ? h('label', { for: attach.id, class: 'hive-muted hive-attach' }, attach, selected ? ` About "${beads[selected]?.title || selected}" (untick to clear)` : ' Select a bead to attach it') : h('span'),
    h('button', { type: 'button', class: 'hive-btn hive-btn-primary', disabled: ctx.busy('hive-send'), onclick: onSubmit }, ctx.busy('hive-send') ? 'Sending…' : label));
}

// A draft may be longer than a message can be, for instance one kept from
// before topics with its title added. It stays whole, and Send waits until
// it is short enough.
function lengthGuard(ui, ctx, textarea, row, images) {
  const max = ui.messageMax;
  const send = row.querySelector('.hive-btn-primary');
  const note = h('p', { class: 'hive-composer-limit', role: 'status', 'aria-live': 'polite' });
  const over = () => Math.max(0, textarea.value.trim().length - max);
  const update = () => {
    const n = over();
    note.hidden = !n;
    note.textContent = n ? `This message is ${n.toLocaleString()} characters over the ${max.toLocaleString()}-character limit. Shorten it to send.` : '';
    if (send) send.disabled = Boolean(n) || images?.busy() || ctx.busy('hive-send');
  };
  const save = textarea.oninput;
  textarea.oninput = e => { save?.(e); update(); };
  update();
  return { note, over, update };
}

function sendOnCtrlEnter(el, submit) {
  el.onkeydown = (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    }
  };
}

// A hive that is off keeps its conversation in reach, read only: what each
// side still owes can be read and acknowledged, but nothing new is sent.
const conversationViews = new WeakMap();
const composers = new WeakMap();
const messageLists = new WeakMap();

export function disposeConversation(ui) { conversationViews.delete(ui); composers.delete(ui); messageLists.delete(ui); }

export function keepMessageList(ui, key, next, ctx) {
  const saved = messageLists.get(ui);
  messageLists.set(ui, { key, list: next });
  if (!saved || saved.key !== key) return next;
  const list = saved.list;
  ctx.beforeReplace?.(list.parentElement || list);
  const rows = new Map([...list.children].filter(el => el.dataset.id).map(el => [el.dataset.id, el]));
  const wanted = [...next.children].map(el => {
    const old = rows.get(el.dataset.id);
    return old && old.hiveRevision === el.hiveRevision && old.isEqualNode(el) ? old : el;
  });
  syncChildren(list, wanted);
  list.setAttribute('aria-label', next.getAttribute('aria-label'));
  if ('startAt' in next.dataset) list.dataset.startAt = next.dataset.startAt;
  else delete list.dataset.startAt;
  list.hiveRebuilt = true;
  messageLists.set(ui, { key, list });
  return list;
}

function composerInput(ui, key, attrs) {
  let saved = composers.get(ui);
  if (!saved || saved.key !== key) {
    saved = { key, textarea: h('textarea'), root: h('div') };
    composers.set(ui, saved);
  }
  for (const [name, value] of Object.entries(attrs)) saved.textarea.setAttribute(name, value);
  const value = ui.draftFor(key);
  if (saved.textarea.value !== value) saved.textarea.value = value;
  saved.textarea.oninput = () => ui.setDraftFor(key, saved.textarea.value);
  return saved.textarea;
}

function composerShell(ui, key, attrs, ...children) {
  const saved = composers.get(ui);
  saved.root.setAttribute('class', attrs.class);
  return syncChildren(saved.root, children);
}

export function renderConversation(args) {
  const { cell, hive, ui, ctx } = args;
  const threadId = ui.openThread?.(cell.id);
  if (threadId) {
    const epoch = conversationEpoch(hive.metaEpoch, cell.conversationRevision);
    const token = ui.askRelations(cell.id, threadId, epoch, hive.metaVersion);
    if (token) ctx.send({ type: 'hive-thread-relations', cellId: cell.id, threadId }, {
      quiet: true, onReply: frame => ui.receiveRelations(token, frame),
    });
  }
  const sig = conversationInputs({ ...ctx, hive, graph: args.graph, ui }, cell);
  const cached = conversationViews.get(ui);
  if (ctx.uiVersion !== undefined && cached?.sig === sig) {
    cached.out.related?.updateHive?.(hive);
    return cached.out;
  }
  const out = Array.isArray(cell.threads)
    ? renderTopics(args)
    : { ...renderStream(args), head: null, scrollKey: `messages:${cell.id}`, follow: true, focusKey: `composer:${cell.id}` };
  out.toast = null;
  const result = cell.enabled ? out : { ...out, textarea: null, composer: h('p', { class: 'hive-muted' }, cell.retired ? 'This hive is retired. Reopen it to send messages.' : 'This hive is off. Turn it on to send messages.') };
  conversationViews.set(ui, { sig, out: result });
  return result;
}

function renderTopics({ cell, hive, graph, api, ui, ctx }) {
  const beads = hive.beads;
  const epoch = conversationEpoch(hive.metaEpoch, cell.conversationRevision);
  ui.syncConversation(cell.id, epoch);
  const selected = ui.selectedBeadId();
  const scope = selectionScope(hive, cell, selected);
  const all = ui.allTopics(cell.id);
  const known = new Map();
  const sigs = { human: inboxSig(cell, 'human'), queen: inboxSig(cell, 'queen') };
  const opened = ui.openedTopic(cell.id);
  const retained = ui.acknowledgedConversation(cell.id);
  for (const t of cell.threads) if (t.waitingFrom) ui.noteServerAck(cell.id, t.waitingFrom.id, { required: true, state: null, rev: t.waitingFrom.rev });
  for (const t of [...cell.threads, ...ui.olderTopics(cell.id, epoch), ...ui.inboxThreads(cell.id, epoch, sigs), ...(opened ? [opened] : []), ...retained.threads]) if (!known.has(t.id)) known.set(t.id, t);
  const topics = [...known.values()].sort(byRecent);
  const byThread = new Map();
  const counted = ackMessages([
    ...topics.filter(t => t.preview).map(t => ({ ...t.preview, threadId: t.id })),
    ...retained.messages,
    ...(ui.inboxPages(cell.id, 'human', epoch, sigs.human)?.messages || []),
    ...cell.messages,
  ]);
  ui.rememberConversation(cell.id, topics, counted);
  const snapshot = acknowledgementSnapshot(cell);
  for (const m of counted) {
    if (!byThread.has(m.threadId)) byThread.set(m.threadId, []);
    byThread.get(m.threadId).push(m);
  }
  const openId = ui.openThread(cell.id);
  const inbox = cell.inbox ? ui.inboxView(cell.id) : null;
  const open = openId && known.has(openId) && (all || inbox || inScope(known.get(openId), scope)) ? known.get(openId) : null;
  if (open) return threadView({ cell, hive, beads, graph, api, ui, ctx, t: open, window: cell.messages.filter(m => m.threadId === open.id), epoch });
  const out = listView({ cell, hive, beads, graph, ui, ctx, topics, byThread, counted, snapshot, scope, all, selected, epoch });
  if (inbox) {
    Object.assign(out, inboxList({ cell, hive, beads, graph, ui, ctx, known, counted, snapshot, epoch, kind: inbox }));
    out.head.insertBefore(out.search, out.head.querySelector('.hive-inbox-filters'));
  }
  return out;
}

function heldMessages(cell, hive, ui, kind) {
  const first = cell.inbox?.[kind];
  const epoch = conversationEpoch(hive.metaEpoch, cell.conversationRevision);
  const later = ui.inboxPages(cell.id, kind, epoch, inboxSig(cell, kind));
  const byId = new Map(ackMessages([...(kind === 'human' ? ui.acknowledgedConversation(cell.id).messages : []), ...(later?.messages || []), ...cell.messages]).map((m) => [m.id, m]));
  return { first, later, byId };
}

export function waitingMessages(cell, hive, ui, kind) {
  const { first, later, byId } = heldMessages(cell, hive, ui, kind);
  if (!first) return [];
  const snapshot = acknowledgementSnapshot(cell);
  const pending = kind === 'human' ? waitsFor(x => effectiveAck(x, y => ui.ackOf(cell.id, y), snapshot)) : (m) => answerState(m, cell) === 'waiting';
  const restored = kind === 'human' ? [...byId.values()].filter(m => baselineAck(m, snapshot)?.state && pending(m)).map(m => m.id) : [];
  return [...new Set([...first.ids, ...(later?.ids || []), ...restored])]
    .map((id) => byId.get(id))
    .filter((m) => m && pending(m))
    .sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1));
}

export function waitingCount(cell, hive, ui, kind) {
  if (!cell.inbox) return 0;
  if (kind !== 'human') return cell.inbox[kind]?.count || 0;
  const { byId } = heldMessages(cell, hive, ui, kind);
  return Math.max(0, (cell.inbox.human?.count || 0) + ackDelta([...byId.values()], m => ui.ackOf(cell.id, m), acknowledgementSnapshot(cell)));
}

export function topicTitles(cell, hive, ui) {
  const epoch = conversationEpoch(hive.metaEpoch, cell.conversationRevision);
  const sigs = { human: inboxSig(cell, 'human'), queen: inboxSig(cell, 'queen') };
  return new Map([...cell.threads, ...ui.inboxThreads(cell.id, epoch, sigs)].map((t) => [t.id, t.title]));
}

export function messageAuthor(graph, cell, m) { return authorName(graph, cell, m); }

// The inbox's membership revision as projected. Later pages loaded at
// another revision are dropped and loaded again.
function inboxSig(cell, kind) {
  const s = cell.inbox?.[kind];
  return s && Number.isInteger(s.rev) ? String(s.rev) : '';
}

function inboxHead(cell, hive, graph, ui) {
  if (!cell.inbox) return null;
  const context = { hive, graph, ui };
  const view = ui.inboxView(cell.id);
  const filters = inboxFilters(view, {
    human: inboxRows(context, [cell], 'human').length,
    queen: waitingCount(cell, hive, ui, 'queen'),
  }, kind => ui.setInboxView(cell.id, view === kind ? null : kind), `inbox:${cell.id}`);
  if (view) filters.append(h('button', { type: 'button', class: 'hive-link-btn', onclick: () => ui.setInboxView(cell.id, null) }, 'Show topics'));
  if (cell.inbox.backlog) filters.append(h('span', { class: 'hive-muted hive-inbox-backlog', role: 'note' }, 'More than 100 messages are waiting. Older ones stay until they are answered or acknowledged.'));
  return filters;
}

function inboxList({ cell, hive, beads, graph, ui, ctx, known, counted, snapshot, epoch, kind }) {
  const first = cell.inbox[kind] || { ids: [], more: false, after: null };
  const sig = inboxSig(cell, kind);
  const later = ui.inboxPages(cell.id, kind, epoch, sig);
  const byId = new Map((later?.messages || []).map((m) => [m.id, m]));
  for (const m of kind === 'human' ? counted : cell.messages) byId.set(m.id, m);
  const pending = (m) => (kind === 'human' ? waitsFor(x => effectiveAck(x, y => ui.ackOf(cell.id, y), snapshot))(m) : answerState(m, cell) === 'waiting');
  const restored = kind === 'human' ? counted.filter(m => baselineAck(m, snapshot)?.state && pending(m)).map(m => m.id) : [];
  const items = [...new Set([...first.ids, ...(later?.ids || []), ...restored])]
    .map((id) => byId.get(id))
    .filter((m) => m && pending(m))
    .sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1));
  const members = beneath(hive, cell.rootBeadId);
  const topicsOf = (msgs) => {
    const by = new Map();
    for (const m of msgs) {
      const k = m.threadId || m.id;
      if (!by.has(k)) by.set(k, []);
      by.get(k).push(m);
    }
    return [...by.values()];
  };
  const groups = topicsOf(items);
  const list = h('ol', { class: 'hive-topics hive-inbox', 'aria-label': INBOX_NAME[kind] });
  const lately = kind === 'queen' ? ui.form?.(`withdrawn:${cell.id}`) : null;
  const settled = lately && byId.get(lately.id)?.response;
  if (settled?.withdrawn && !settled.answers?.length) {
    list.append(h('li', { class: 'hive-inbox-withdrawn', role: 'status' },
      h('span', { class: 'hive-muted' }, `Withdrawn: ${lately.text}`),
      withdrawButton({ id: lately.id }, cell, ctx, 'hive-withdraw-undo', 'Undo', 'inbox', ui)));
  }
  const rows = [];
  for (const group of groups) {
    const t = known.get(group[0].threadId);
    const s = t?.awaiting?.[kind];
    const newest = s?.newest && byId.get(s.newest.id);
    const m = newest && pending(newest) ? newest : [...group].sort(inTopicOrder).at(-1);
    let n = group.length;
    if (s) {
      n = kind === 'human' ? unreadIn(t, [...byId.values()].filter(x => x.threadId === t.id), x => ui.ackOf(cell.id, x), snapshot) : Math.max(n, s.count);
    }
    rows.push({
      key: `message:${cell.id}:${group[0].id}`, cellId: cell.id, threadId: m.threadId,
      title: t?.title || 'Topic no longer kept', at: group[0].at, count: n, id: m.id,
      author: authorName(graph, cell, m), preview: m.text.replace(/\s+/g, ' ').slice(0, 200),
      texts: group.map(x => x.text), sessionLinks: group.map(x => x.sessionLink).filter(Boolean),
      hive: messageContextLabel(m, cell, beads, members), link: hiveLink(cell.id, m.threadId, group[0].id),
    });
  }
  const context = { ...ctx, hive, graph, ui };
  const merged = kind === 'human' ? mergeRows(rows, needsRows(context, [cell])) : rows;
  const query = ui.globalInboxQuery?.(cell.id) || '';
  const searching = searchTerms(query).length > 0;
  const found = searching ? searchedInbox(context, [cell], query, ui.askGlobalInboxSearch?.([cell.id], `${hive.revision}:${hive.metaVersion}`, hive.metaEpoch, cell.id)) : null;
  const shown = searching ? found.lists[kind] : merged;
  for (const row of shown) {
    const t = known.get(row.threadId);
    const message = byId.get(row.id || rows.find(r => r.threadId === row.threadId)?.id);
    list.append(inboxRow(context, row, {
      id: row.id || row.key, showContext: false, query: searching ? query : '',
      ...(t ? { open: () => openTopic(ui, ctx, cell, t, cell.threads.some(x => x.id === t.id), epoch) } : {}),
      action: kind === 'queen' && message && !cell.snapshot ? withdrawButton(message, cell, ctx, 'hive-withdraw', 'Withdraw', 'inbox', ui) : null,
    }));
  }
  if (!shown.length) {
    const none = kind === 'human' ? 'Nothing from the queen is waiting for you' : 'None of your messages is waiting for an answer';
    list.append(h('li', { class: 'hive-muted' }, searching ? `No topics match “${query.trim()}”.` : `${none}.`));
  }
  const more = later ? later.more : first.more;
  const after = later ? later.after : first.after;
  if (more && after) {
    list.append(h('li', {}, h('button', {
      type: 'button',
      class: 'hive-link-btn',
      disabled: ctx.busy('hive-inbox'),
      onclick: () => ctx.send({ type: 'hive-inbox', cellId: cell.id, awaiting: kind, after }, {
        onReply: (frame) => {
          if (frame.ok) ui.addInboxPage(cell.id, kind, epoch, sig, frame);
          else ctx.notice(frame.error || 'Could not load more.', { severity: 'error' });
        },
      }),
    }, 'Load more')));
  }
  return { list, search: inboxSearchBox(ui, query, shown, found, cell.id), scrollKey: `inbox:${cell.id}:${kind}` };
}

function listView({ cell, hive, beads, graph, ui, ctx, topics, byThread, counted, snapshot, scope, all, selected, epoch }) {
  const shown = topics.filter((t) => all || inScope(t, scope));
  const ackOf = m => ui.ackOf(cell.id, m);
  const elsewhere = all ? 0 : topics.filter((t) => !inScope(t, scope)).reduce((n, t) => n + unreadIn(t, byThread.get(t.id) || [], ackOf, snapshot), 0);
  const scopeName = scope ? (beads[selected]?.title || selected) : null;
  const toggle = h('button', { type: 'button', class: 'hive-link-btn', 'aria-pressed': all ? 'true' : 'false', onclick: () => ui.setAllTopics(cell.id, !all) }, all ? 'Only this selection' : 'All topics');
  const inbox = cell.inbox ? ui.inboxView(cell.id) : null;
  const what = inbox ? (inbox === 'human' ? 'Waiting for you' : 'Waiting for the queen') : 'Topics';
  const head = h('div', { class: `hive-topics-head${inbox ? ' hive-inbox-head' : ''}` },
    cell.inbox ? h('div', { class: 'hive-inbox-totals' }, inboxTotals({ needs: needsRows({ hive, graph, ui }, [cell]).length, human: waitingCount(cell, hive, ui, 'human') })) : null,
    inboxHead(cell, hive, graph, ui),
    h('span', { class: 'hive-muted' }, inbox || all || !scope ? `${inbox ? what : 'All topics'} in this hive` : [`${what} about `, h('strong', {}, scopeName), ' (and its items)']),
    scope && !inbox ? toggle : null,
    elsewhere && !inbox ? h('button', { type: 'button', class: 'hive-link-btn', onclick: () => ui.setAllTopics(cell.id, true) }, `${elsewhere} unread in other topics`) : null);
  const list = h('ol', { class: 'hive-topics', 'aria-label': 'Topics' });
  const requestsByThread = new Map();
  for (const r of Object.values(cell.requests || {})) {
    if (needsHuman(r)) requestsByThread.set(r.threadId, (requestsByThread.get(r.threadId) || 0) + 1);
  }
  for (const t of shown) {
    const needs = requestsByThread.get(t.id) || 0;
    const unread = unreadIn(t, byThread.get(t.id) || [], ackOf, snapshot);
    const count = unread || needs;
    const waiting = `${needs} request${needs === 1 ? '' : 's'} waiting for you`;
    const label = needs ? `${unread ? `${unread} unread; ` : ''}${waiting}` : `${unread} unread`;
    const p = t.preview;
    list.append(h('li', { class: `hive-topic${count ? ' is-unread' : ''}` },
      h('button', {
        type: 'button',
        class: 'hive-topic-btn',
        'data-focus-key': `topic:${cell.id}:${t.id}`,
        onclick: () => openTopic(ui, ctx, cell, t, cell.threads.some((x) => x.id === t.id), epoch),
      },
      h('span', { class: 'hive-topic-line' },
        h('strong', { class: 'hive-topic-title' }, t.title),
        count ? h('span', { class: `hive-unread${needs ? ' is-needs-you' : ''}`, 'aria-label': label }, String(count)) : null,
        h('span', { class: 'hive-muted hive-topic-time' }, relativeTime(t.lastAt))),
      h('span', { class: 'hive-topic-line' },
        h('span', { class: 'hive-chip hive-topic-context' }, contextLabel(t, cell, beads)),
        p ? h('span', { class: 'hive-muted hive-topic-preview' }, `${p.author === 'human' ? 'You' : sessionName(graph, p.sessionId)}: ${p.text}`) : h('span', { class: 'hive-muted hive-topic-preview' }, 'Earlier messages were removed.')))));
  }
  if (!shown.length) list.append(h('li', { class: 'hive-muted' }, topics.length ? 'No topics about this yet.' : 'No messages yet. The queen and workers publish decisions and questions here; what you send goes to the queen.'));
  const older = ui.olderCursor(cell.id, epoch);
  const after = older === undefined ? cell.threadsAfter : older;
  if (cell.threadsTruncated && after) {
    list.append(h('li', {}, h('button', {
      type: 'button',
      class: 'hive-link-btn',
      disabled: ctx.busy('hive-thread-list'),
      onclick: () => ctx.send({ type: 'hive-thread-list', cellId: cell.id, after }, {
        onReply: (frame) => {
          if (frame.ok) ui.addOlderTopics(cell.id, epoch, frame.threads || [], frame.more, frame.after, frame.conversationRevision);
          else ctx.notice(frame.error || 'Could not load older topics.', { severity: 'error' });
        },
      }),
    }, 'Show older topics')));
  }
  return { head, list, ...newTopicComposer({ cell, hive, beads, ui, ctx, selected }), scrollKey: `topics:${cell.id}`, follow: false };
}

// Server order within a topic: `n` counts messages as they were added.
const inTopicOrder = (a, b) => (a.n ?? 0) - (b.n ?? 0) || a.at - b.at || (a.id < b.id ? -1 : 1);

function openTopic(ui, ctx, cell, t, projected, epoch) {
  const token = ui.openThreadFor(cell.id, t.id, t, { atWaiting: true });
  if (!projected && !ui.historyFor(cell.id, t.id, epoch) && !token.asked.has('')) {
    token.asked.add('');
    loadHistory(ui, ctx, cell, t.id, null, epoch, WINDOW, () => ui.failStart(`${cell.id}:${t.id}`, token));
  }
}

// Messages before `before` (a message, or null for the newest). The reply is
// one unbroken run of the topic, ending just before it.
function loadHistory(ui, ctx, cell, threadId, before, epoch, limit = WINDOW, onFail = null) {
  ctx.send({ type: 'hive-thread-history', cellId: cell.id, threadId, before: before?.id || null, limit }, {
    onReply: (frame) => {
      if (frame.ok) ui.addHistory(cell.id, threadId, epoch, frame, Number.isInteger(before?.n) ? before.n : null);
      else {
        ctx.notice(frame.error || 'Could not load earlier messages.', { severity: 'error' });
        onFail?.();
      }
    },
  });
}

// A message that is not a reply starts its own topic, named from its first
// line; replying happens inside an open topic.
function newTopicComposer({ cell, beads, ui, ctx, selected }) {
  const key = `${cell.id}:new`;
  const images = imageDraft(ui, key);
  ui.foldTopicTitle(cell.id);
  const currentAnchor = () => {
    const saved = ui.topicAboutFor(cell.id);
    if (saved === '') return null;
    if (saved) return saved;
    const now = ui.selectedBeadId();
    return now && now !== cell.rootBeadId && beads[now] ? now : null;
  };
  const anchor = currentAnchor();
  const picked = ui.selectedBeadId();
  const reattach = !anchor && ui.topicAboutFor(cell.id) === '' && picked && picked !== cell.rootBeadId && beads[picked] ? picked : null;
  const textarea = composerInput(ui, key, {
    class: 'hive-composer-input',
    rows: '3',
    placeholder: cell.queenSessionId ? 'Message the queen…' : 'No queen yet: messages are kept until you nominate or launch one.',
    'aria-label': 'Message to the queen',
  });
  const submit = () => {
    const raw = textarea.value;
    const value = raw.trim();
    if (!value || guard.over() || images.busy() || ctx.busy('hive-send')) return;
    ui.setDraftFor(key, raw);
    const rev = ui.draftRev(key);
    const sentImages = images.snapshot();
    const about = currentAnchor();
    ctx.send({ type: 'hive-send', images: images.frames(), cellId: cell.id, text: value, beadId: about, newThread: { beadId: about } }, {
      onReply: (frame) => {
        if (frame.ok) {
          ui.clearDraftIf(key, rev);
          images.clear(sentImages);
          if (frame.delivery?.state === 'failed') ctx.notice(`Saved, but not delivered: ${frame.delivery.error || 'delivery failed'}.`, { severity: 'error' });
        } else {
          ctx.notice(frame.error || 'Could not send.', { severity: 'error' });
        }
      },
    });
  };
  sendOnCtrlEnter(textarea, submit);
  const aboutEl = h('span', { class: 'hive-muted hive-topic-about' },
    anchor ? ['About ', h('span', { class: 'hive-chip' }, beads[anchor]?.title || 'removed item'), ' ',
      h('button', { type: 'button', class: 'hive-link-btn', onclick: () => ui.setTopicAbout(cell.id, '') }, 'Make hive-wide')]
      : ['Hive-wide', reattach ? [' ', h('button', { type: 'button', class: 'hive-link-btn', onclick: () => ui.setTopicAbout(cell.id, null) }, `About "${beads[reattach].title}"`)] : null]);
  const row = composerRow({ cell, beads, ui, ctx, attach: null, selected, onSubmit: submit, label: 'Send' });
  const guard = lengthGuard(ui, ctx, textarea, row, images);
  const composer = composerShell(ui, key, { class: 'hive-composer hive-new-topic' },
    h('div', { class: 'hive-composer-head' }, aboutEl),
    textarea,
    guard.note,
    row);
  composer.insertBefore(imageComposer({ ui, key, textarea, root: composer, onChange: guard.update, disabled: ctx.busy('hive-send') }), row);
  return { composer, textarea, focusKey: `composer:${key}` };
}

function threadView({ cell, hive, beads, graph, api, ui, ctx, t, window, epoch }) {
  const key = `${cell.id}:${t.id}`;
  const images = imageDraft(ui, key);
  const page = ui.historyFor(cell.id, t.id, epoch);
  const seen = new Map();
  for (const m of [...(page?.messages || []), ...window]) seen.set(m.id, m);
  const msgs = [...seen.values()].sort(inTopicOrder);
  ui.rememberConversation(cell.id, [t], msgs);
  const byId = new Map(msgs.map((m) => [m.id, m]));
  const renaming = ui.form('renameTopic');
  const isRenaming = cell.enabled && renaming?.cellId === cell.id && renaming.threadId === t.id;
  let titleEl;
  if (isRenaming) {
    const input = h('input', { type: 'text', class: 'hive-topic-title-input', maxlength: '120', value: renaming.value ?? t.title, 'aria-label': 'Topic title', 'data-focus-key': `rename:${key}` });
    input.addEventListener('input', () => ui.patchForm('renameTopic', { value: input.value }));
    const save = () => {
      const value = input.value.trim();
      if (!value) return;
      const seq = ui.startRename(cell.id, t.id);
      ctx.send({ type: 'hive-thread-rename', cellId: cell.id, threadId: t.id, title: value }, {
        onReply: (frame) => {
          if (frame.ok) ui.renamed(cell.id, t.id, seq, frame.title || value);
          else ctx.notice(frame.error || 'Could not rename the topic.', { severity: 'error' });
        },
      });
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); save(); }
      if (e.key === 'Escape') { e.preventDefault(); ui.setForm('renameTopic', null); }
    });
    titleEl = h('span', { class: 'hive-topic-rename' }, input,
      h('button', { type: 'button', class: 'hive-link-btn', disabled: ctx.busy('hive-thread-rename'), onclick: save }, 'Save'),
      h('button', { type: 'button', class: 'hive-link-btn', onclick: () => ui.setForm('renameTopic', null) }, 'Cancel'));
  } else {
    titleEl = h('span', { class: 'hive-topic-name' }, h('strong', {}, t.title), ' ',
      cell.enabled ? h('button', { type: 'button', class: 'hive-link-btn', onclick: () => ui.setForm('renameTopic', { cellId: cell.id, threadId: t.id, value: t.title }) }, 'Rename') : null);
  }
  const relations = ui.relationsFor(cell.id, t.id, epoch, hive.metaVersion) || (cell.topicRelations ? cell.topicRelations[t.id] || { references: [] } : t);
  const related = { ids: relatedBeads(hive, cell, relations, msgs, ui.conversationMessage?.(cell.id, t.id)), el: h('div', { class: 'hive-conversation-relations', 'aria-label': 'Related beads' }) };
  const head = h('div', { class: 'hive-topics-head hive-thread-head', onclick: () => ui.selectConversationMessage?.(cell.id, t.id, null) },
    h('button', { type: 'button', class: 'hive-link-btn', 'data-focus-key': `topics-back:${cell.id}`, onclick: () => ui.closeThread(cell.id) }, '← Topics'),
    titleEl,
    h('span', { class: 'hive-chip hive-topic-context' }, contextLabel(t, cell, beads)), related.el);
  let list = h('ol', { class: 'hive-messages', 'aria-label': `Messages in ${t.title}` });
  related.updateHive = next => { hive = next; };
  related.refresh = () => {
    const messageId = ui.conversationMessage?.(cell.id, t.id);
    related.ids = relatedBeads(hive, cell, ui.relationsFor(cell.id, t.id, epoch, hive.metaVersion) || relations, msgs, messageId);
    for (const item of list.querySelectorAll('.hive-message')) item.classList.toggle('is-conversation-selected', item.dataset.id === messageId);
  };
  const loading = !msgs.length && t.retained > 0;
  // The window's newest run starts at windowFrom. A loaded page joins it only
  // when it reaches that far; otherwise the messages in between are offered.
  const from = t.windowFrom ? window.find((m) => m.id === t.windowFrom) || null : null;
  const gap = page && from && Number.isInteger(from.n) && from.n > page.anchorN;
  const oldest = page ? page.messages[0] : from;
  const busy = ctx.busy('hive-thread-history');
  if ((page ? page.more : window.length < t.retained) && oldest) {
    list.append(h('li', { class: 'hive-earlier' }, h('button', {
      type: 'button',
      class: 'hive-link-btn',
      disabled: busy,
      onclick: () => loadHistory(ui, ctx, cell, t.id, oldest, epoch),
    }, 'Load earlier')));
  } else if (t.earlierRemoved && !loading) {
    list.append(h('li', { class: 'hive-muted hive-earlier' }, 'Earlier messages were removed.'));
  }
  const pageEnd = page?.messages.at(-1)?.n ?? -Infinity;
  let bridged = !gap;
  for (const m of msgs) {
    if (!bridged && !(m.n <= pageEnd)) {
      bridged = true;
      list.append(h('li', { class: 'hive-earlier' }, h('button', {
        type: 'button',
        class: 'hive-link-btn',
        disabled: busy,
        onclick: () => loadHistory(ui, ctx, cell, t.id, from, epoch, BRIDGE),
      }, 'Load the messages in between')));
    }
    const target = m.replyTo ? byId.get(m.replyTo) : null;
    list.append(messageItem({ m, cell, beads, graph, api, ui, ctx, target, replyKey: key }));
  }
  if (loading) list.append(h('li', { class: 'hive-muted' }, 'Loading…'));
  if (ui.startPending(key)) {
    const ackOf = (m) => ui.ackOf(cell.id, m);
    const waiting = earliestWaiting(t, msgs, ackOf);
    const s = startTarget({ window, page, from, retained: t.retained, waiting, waits: waitsFor(ackOf) });
    if ('id' in s) list.dataset.startAt = s.id;
    else if (ui.startFailed(key)) list.dataset.startAt = s.before?.id || '';
    else if (ui.askStart(key, s.before?.id || '')) {
      const token = ui.startToken(key);
      loadHistory(ui, ctx, cell, t.id, s.before, epoch, BRIDGE, () => ui.failStart(key, token));
    }
  }
  list = keepMessageList(ui, key, list, ctx);
  const reader = ui.readTracker(cell.id, t.id);
  reader.attach(list, msgs, ctx);
  list.hiveShown = () => reader.shown();
  const onReadInteraction = event => {
    if (event.isTrusted === false || (event.type === 'focusin' && ui.restoringFocus?.())) return;
    list.hiveShown();
  };
  if (!list.hiveReading) {
    list.hiveReading = true;
    list.addEventListener('scroll', () => list.hiveShown(), { passive: true });
    list.addEventListener('load', () => list.hiveShown(), true);
    document.fonts?.ready?.then(() => list.hiveShown());
  }
  list.dataset.onShown = '';

  const textarea = composerInput(ui, key, {
    class: 'hive-composer-input',
    rows: '3',
    placeholder: cell.queenSessionId ? 'Reply in this topic…' : 'No queen yet: messages are kept until you nominate or launch one.',
    'aria-label': `Message in ${t.title}`,
  });
  const selected = ui.selectedBeadId();
  const attach = h('input', { type: 'checkbox', id: `hive-attach-${cell.id}`, checked: ui.attachFor(key, selected), disabled: !selected });
  attach.addEventListener('change', () => ui.setAttachFor(key, attach.checked, selected));
  const replyId = ui.replyFor(key);
  const replyTarget = replyId ? byId.get(replyId) : null;
  const submit = () => {
    const raw = textarea.value;
    const value = raw.trim();
    if (!value || guard.over() || images.busy() || ctx.busy('hive-send')) return;
    const replyTo = replyTarget ? replyTarget.id : null;
    ui.setDraftFor(key, raw);
    const rev = ui.draftRev(key);
    const sentImages = images.snapshot();
    const ackRev = replyTarget ? ui.ackOf(cell.id, replyTarget)?.rev ?? null : null;
    const shown = msgs.at(-1);
    const about = ui.selectedBeadId();
    ctx.send({ type: 'hive-send', images: images.frames(), cellId: cell.id, threadId: t.id, text: value, beadId: ui.attachFor(key, about) ? about : null, replyTo, ackRev, readThrough: shown?.id || null }, {
      onReply: (frame) => {
        if (frame.ok) {
          if (shown) ui.markRead(cell.id, t.id, shown.at);
          ui.followMessages(key);
          ui.clearDraftIf(key, rev);
          images.clear(sentImages);
          if (frame.delivery?.state === 'failed') ctx.notice(`Saved, but not delivered: ${frame.delivery.error || 'delivery failed'}.`, { severity: 'error' });
          else if (frame.ackSettled === false) ctx.notice('Sent. The message you replied to changed since you saw it, so it was not marked answered.');
        } else {
          ctx.notice(frame.error || 'Could not send.', { severity: 'error' });
        }
      },
    });
  };
  sendOnCtrlEnter(textarea, submit);
  const row = composerRow({ cell, beads, ui, ctx, attach, selected, onSubmit: submit, label: 'Send' });
  const guard = lengthGuard(ui, ctx, textarea, row, images);
  const composer = composerShell(ui, key, { class: 'hive-composer' },
    replyTarget ? h('div', { class: 'hive-quote' }, `Replying to: ${replyTarget.text.slice(0, 120)} `,
      h('button', { type: 'button', class: 'hive-link-btn', onclick: () => ui.setReplyFor(key, null) }, 'Cancel')) : null,
    textarea,
    guard.note,
    row);
  composer.insertBefore(imageComposer({ ui, key, textarea, root: composer, onChange: guard.update, disabled: ctx.busy('hive-send') }), row);
  const widen = e => { if (e.key === 'Escape') ui.selectConversationMessage?.(cell.id, t.id, null); };
  head.addEventListener('keydown', widen);
  composer.onkeydown = widen;
  return { head, list, composer, textarea, related, onReadInteraction, scrollKey: `messages:${key}`, follow: true, focusKey: `composer:${key}` };
}

function renderStream({ cell, hive, graph, api, ui, ctx }) {
  const key = cell.id;
  const beads = hive.beads;
  let list = h('ol', { class: 'hive-messages', 'aria-label': 'Conversation' });
  const byId = new Map(cell.messages.map((m) => [m.id, m]));
  for (const m of cell.messages) {
    const target = m.replyTo ? byId.get(m.replyTo) : null;
    list.append(messageItem({ m, cell, beads, graph, api, ui, ctx, target, replyKey: cell.id }));
  }
  if (!cell.messages.length) list.append(h('li', { class: 'hive-muted' }, 'No messages yet. The queen and workers publish decisions and questions here; what you send goes to the queen.'));

  const textarea = composerInput(ui, key, {
    class: 'hive-composer-input',
    rows: '3',
    placeholder: cell.queenSessionId ? 'Message the queen…' : 'No queen yet: messages are kept until you nominate or launch one.',
    'aria-label': 'Message to the queen',
  });
  const selected = ui.selectedBeadId();
  const attach = h('input', { type: 'checkbox', id: `hive-attach-${cell.id}`, checked: ui.attachFor(cell.id, selected), disabled: !selected });
  attach.addEventListener('change', () => ui.setAttachFor(cell.id, attach.checked, selected));
  const submit = () => {
    const raw = textarea.value;
    const value = raw.trim();
    if (!value || ctx.busy('hive-send')) return;
    const cellId = cell.id;
    const replyTo = ui.replyFor(cellId);
    ui.setDraftFor(cellId, raw);
    const rev = ui.draftRev(cellId);
    const target = replyTo ? byId.get(replyTo) : null;
    const ackRev = target ? ui.ackOf(cellId, target)?.rev ?? null : null;
    const shown = target ? cell.messages.filter((m) => m.threadId === target.threadId).at(-1) : null;
    const about = ui.selectedBeadId();
    ctx.send({ type: 'hive-send', cellId, text: value, beadId: ui.attachFor(cellId, about) ? about : null, replyTo, ackRev, readThrough: shown?.id || null }, {
      onReply: (frame) => {
        if (frame.ok) {
          if (shown) ui.markRead(cellId, shown.threadId, shown.at);
          ui.followMessages(cellId);
          ui.clearDraftIf(cellId, rev);
          if (frame.delivery?.state === 'failed') ctx.notice(`Saved, but not delivered: ${frame.delivery.error || 'delivery failed'}.`, { severity: 'error' });
          else if (frame.ackSettled === false) ctx.notice('Sent. The message you replied to changed since you saw it, so it was not marked answered.');
        } else {
          ctx.notice(frame.error || 'Could not send.', { severity: 'error' });
        }
      },
    });
  };
  textarea.onkeydown = (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    }
  };
  const replyTarget = ui.replyFor(cell.id) ? byId.get(ui.replyFor(cell.id)) : null;
  const composer = composerShell(ui, key, { class: 'hive-composer' },
    replyTarget ? h('div', { class: 'hive-quote' }, `Replying to: ${replyTarget.text.slice(0, 120)} `,
      h('button', { type: 'button', class: 'hive-link-btn', onclick: () => ui.setReplyFor(cell.id, null) }, 'Cancel')) : null,
    textarea,
    h('div', { class: 'hive-composer-row' },
      h('label', { for: `hive-attach-${cell.id}`, class: 'hive-muted' }, attach, selected ? ` About "${beads[selected]?.title || selected}"` : ' Select a bead to attach it'),
      h('button', { type: 'button', class: 'hive-btn hive-btn-primary', disabled: ctx.busy('hive-send'), onclick: submit }, ctx.busy('hive-send') ? 'Sending…' : 'Send')));
  list = keepMessageList(ui, key, list, ctx);
  return { list, composer, textarea };
}
