import { createDrafts, DRAFT_PREFIX, DRAFT_TEXT_MAX } from './ui-drafts.js';
import { capacityLimit } from './capacity-control.js';
import { createRequestNotifications, answerRequestOption } from './requests.js';
import { installPanelSplit } from './panel-split.js';
import { readScrollState, saveScrollState, conversationEpoch } from './view-state.js';
import { createReadTracker, afterFrame } from './auto-read.js';
import { waitingGraphKey } from './waiting-model.js';
import { refreshWaitingMenu, disposeWaitingMenu } from './waiting-view.js';
import { installHiveLinks, revealMessage, syncHiveSelection, hiveLink } from './deep-links.js';
import { createToaster, announceRestoreNotices } from './toasts.js';
import { disposeConfirm } from './confirm-dialog.js';
import { disposeConversation } from './conversation.js';
import { disposePanels } from './cell-view.js';
import { disposeImages } from './attachments.js';
import { h, clear, syncChildren, visibleBand, HIVE_ICON, setSessionLinkGuard } from './dom.js';
import { sessionLinkProblem } from './session-links.js';
import { renderSetup, setupNeeded } from './setup.js';
import { renderHive, disposeHiveView, menuRenderStart, menuRenderEnd, disposeMenuWatch } from './hive-view.js';
import { reducedMotion } from './hex-grid.js';
import {
  createBees, beeLevelOf, beeSlider, BEE_LEVEL_SETTING, BEES_SETTING,
} from './bees.js';

const SEND_TIMEOUT_MS = 30000;
const RELATION_RETRY_MS = 1000;
const COMPACT_MAX_WIDTH = 600;
// A following list counts as at the bottom within this many pixels of it.
const FOLLOW_SLACK_PX = 40;

const state = {
  api: null,
  requestNotifications: null,
  bees: null,
  beePending: null,
  graph: null,
  history: [],
  root: null,
  pending: new Map(),
  placements: [],
  restoreToasted: new Set(),
  focusNext: null,
  dragging: false,
  lastSig: '',
  uiVersion: 0,
  inspector: null,
  layout: null,
  ui: null,
  zoom: null,
  pendingCell: null,
  highlightCell: null,
  revealCell: null,
  scrollMemo: new Map(),
  follow: new Map(),
  reveal: new Set(),
  startAt: new Map(),
  followObserver: null,
  followed: new Set(),
  sizer: null,
  linkBridge: null,
  linkRequest: null,
  hiveShown: false,
  linkMessage: null,
  pageHide: null,
  restoringFocus: false,
};

function load(key, fallback) {
  try {
    const raw = state.api?.storage?.get(key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function save(key, value) {
  try { state.api?.storage?.set(key, JSON.stringify(value)); } catch { }
}

const READ_KEEP = 500;
const { draftOf, putDraft, editDraft, sameRev, newRev } = createDrafts({
  load,
  save,
  get remove() {
    const storage = state.api?.storage;
    return storage?.remove ? (key) => storage.remove(key) : null;
  },
});
const joinRuns = (a, b) => {
  const byId = new Map([...a, ...b].map((m) => [m.id, m]));
  return [...byId.values()].sort((x, y) => x.n - y.n);
};

function cancelDeepLink() {
  state.linkRequest = null;
  state.linkMessage = null;
  state.startAt.clear();
  state.linkBridge?.cancel();
}

export function createUi() {
  const cleanedVisibility = new Set();
  const mem = { drafts: new Map(), forms: {}, thread: {}, all: {}, history: {}, older: {}, renames: {}, inboxView: {}, globalInbox: 'needs', inbox: {}, acks: new Map(), acknowledgementMessages: new Map(), acknowledgementTopics: new Map(), opened: {}, readers: new Map(), conversationMessage: {}, relations: null, relationFailure: null, conversationEpoch: {}, detail: new Map() };
  const rememberConversation = (cellId, topics, messages) => {
    for (const t of topics) if (t) mem.acknowledgementTopics.set(`${cellId}:${t.id}`, t);
    const previews = topics.filter(t => t?.preview).map(t => ({ ...t.preview, threadId: t.id }));
    for (const m of [...previews, ...messages]) {
      if (m.author !== 'session' || !m.ack?.required) continue;
      const key = `${cellId}:${m.id}`, old = mem.acknowledgementMessages.get(key);
      const message = old && Number.isInteger(old.n) && !Number.isInteger(m.n) ? { ...m, ...old } : { ...old, ...m };
      message.ack = old?.ack.rev > m.ack.rev ? old.ack : m.ack;
      mem.acknowledgementMessages.set(key, message);
    }
  };
  const bump = () => { state.uiVersion += 1; rerender(); };
  const refreshRelations = () => {
    const relations = state.root?.querySelector('.hive-conversation-relations');
    if (relations?.hiveSelectMessage) relations.hiveSelectMessage();
    else bump();
  };
  const navigate = (render = true) => {
    const cellId = load('cell', null);
    syncHiveSelection(globalThis.window, { cellId, threadId: mem.thread[cellId], beadId: load(`bead:${cellId}`, null), pane: load('pane', 'conversation') });
    if (render) bump();
    persistView();
  };
  // Another tab of this board saved a draft: read it again next time, without
  // redrawing under the reader's cursor.
  globalThis.addEventListener?.('storage', (e) => {
    if (e.key === null) { mem.drafts.clear(); return; }
    const at = typeof e.key === 'string' ? e.key.indexOf(DRAFT_PREFIX) : -1;
    if (at >= 0) mem.drafts.delete(e.key.slice(at + DRAFT_PREFIX.length));
  });
  return {
    rememberConversation,
    acknowledgedConversation(cellId) {
      const messages = [...mem.acknowledgementMessages].filter(([key]) => key.startsWith(`${cellId}:`) && mem.acks.has(key)).map(([, m]) => m);
      const threads = [...new Set(messages.map(m => m.threadId))].map(id => mem.acknowledgementTopics.get(`${cellId}:${id}`)).filter(Boolean);
      return { messages, threads };
    },
    readTracker(cellId, threadId) {
      const key = `${cellId}:${threadId}`;
      if (!mem.readers.has(key)) mem.readers.set(key, createReadTracker(this, cellId, threadId));
      return mem.readers.get(key);
    },
    noteReadBatch(cellId, acks) {
      for (const x of acks) this.noteServerAck(cellId, x.messageId, x.ack);
      bump();
    },
    restoringFocus: () => state.restoringFocus,
    linkedMessage: (cellId, threadId) => state.linkMessage?.cellId === cellId && state.linkMessage.threadId === threadId ? state.linkMessage : null,
    openDeepLink(frame, epoch, { restore = false } = {}) {
      epoch = conversationEpoch(epoch, frame.conversationRevision);
      this.syncConversation(frame.cellId, epoch);
      state.startAt.clear();
      const cellId = frame.cellId || null;
      closeInspector();
      state.pendingCell = null;
      state.linkMessage = null;
      save('cell', cellId);
      if (cellId) {
        mem.thread[cellId] = frame.thread?.id || null;
        mem.conversationMessage = {};
        mem.relations = null;
        mem.relationFailure = null;
        if (frame.thread && frame.messageId) mem.conversationMessage[`${cellId}:${frame.thread.id}`] = frame.messageId;
        mem.opened[cellId] = frame.thread || null;
        mem.all[cellId] = true;
        mem.inboxView[cellId] = null;
        mem.forms.renameTopic = null;
        save('dock', true);
        save('pane', frame.pane === 'details' ? 'details' : 'conversation');
        if (frame.beadId) save(`bead:${cellId}`, frame.beadId);
        if (frame.thread) {
          const threadId = frame.thread.id;
          mem.history[`${cellId}:${threadId}`] = { epoch, messages: frame.messages || [], more: Boolean(frame.more), anchorN: frame.anchorN };
          rememberConversation(cellId, [frame.thread], frame.messages || []);
          const scrollKey = `messages:${cellId}:${threadId}`;
          if (!restore) {
            state.follow.set(scrollKey, !frame.messageId);
            state.scrollMemo.delete(scrollKey);
          }
          state.reveal.delete(scrollKey);
          if (frame.messageId && !restore) state.linkMessage = { cellId, threadId, messageId: frame.messageId, pending: true };
          else if (!restore) this.openAtWaiting(`${cellId}:${threadId}`);
        }
      }
      bump();
    },
    cellId: () => load('cell', null),
    openCell(id, from = null) { cancelDeepLink(); mem.forms.wsMenu = null; state.zoom = { dir: 'in', from }; state.pendingCell = id; state.highlightCell = null; state.revealCell = null; save('cell', id); navigate(); },
    // Shows a cell on the overview without opening it: it is marked and
    // brought into view, once the graph that contains it has arrived.
    highlightCell(id) { cancelDeepLink(); state.highlightCell = id; state.revealCell = id; state.pendingCell = null; save('cell', null); navigate(); },
    highlightedCell: () => state.highlightCell,
    clearHighlight() { if (state.highlightCell) { state.highlightCell = null; state.revealCell = null; bump(); } },
    closeCell() { cancelDeepLink(); mem.forms.wsMenu = null; state.zoom = { dir: 'out', cellId: load('cell', null) }; state.pendingCell = null; save('cell', null); closeInspector(); navigate(); },
    pendingCell: () => state.pendingCell,
    selectedBeadId: () => load(`bead:${load('cell', '')}`, null),
    // The full record of a bead, which the board graph leaves out. A stale
    // copy stays on show while the current one loads.
    beadDetail(bead) {
      const stamp = `${bead.updatedAt}|${bead.status}|${bead.reviewState || ''}`;
      const cur = mem.detail.get(bead.id);
      if (!cur || (cur.stamp !== stamp && !cur.loading)) {
        const entry = { ...cur, stamp, loading: true, error: null };
        mem.detail.delete(bead.id);
        mem.detail.set(bead.id, entry);
        for (const key of mem.detail.keys()) { if (mem.detail.size <= 40) break; mem.detail.delete(key); }
        queueMicrotask(() => send({ type: 'hive-bead-detail', beadId: bead.id }, {
          quiet: true,
          onReply: (frame) => {
            if (mem.detail.get(bead.id) !== entry) return;
            if (frame.ok && frame.bead) mem.detail.set(bead.id, { bead: frame.bead, stamp, loading: false, error: null });
            else mem.detail.set(bead.id, { bead: entry.bead, stamp, loading: false, error: frame.timeout ? 'The server did not reply.' : frame.error || 'Could not load the details.' });
            bump();
          },
        }));
        return { bead: entry.bead || null, loading: true, error: null };
      }
      return { bead: cur.bead || null, loading: cur.loading, error: cur.error };
    },
    retryBeadDetail(id) { const cur = mem.detail.get(id); if (cur) mem.detail.set(id, { bead: cur.bead, stamp: null, loading: false, error: null }); bump(); },
    selectBead(id) { cancelDeepLink(); save(`bead:${load('cell', '')}`, id); navigate(); },
    hideDoneForHive(cellId) {
      if (!cleanedVisibility.has(cellId)) {
        try {
          state.api?.storage?.remove?.(`hideDone:${cellId}`);
          state.api?.storage?.remove?.(`regionHiding:${cellId}`);
          cleanedVisibility.add(cellId);
        } catch { }
      }
      return load(`hideDoneForHive:${cellId}`, false) === true;
    },
    setHideDoneForHive(cellId, on) {
      save(`hideDoneForHive:${cellId}`, Boolean(on));
      bump();
    },
    showRetired: () => load('showRetired', false) === true,
    setShowRetired(on) { save('showRetired', Boolean(on)); bump(); },
    detachedRegions: (cellId) => new Set(load(`detachedRegions:${cellId}`, [])),
    setDetachedRegions: (cellId, ids) => save(`detachedRegions:${cellId}`, [...ids]),
    dockOpen: () => load('dock', true),
    setDockOpen(open) { cancelDeepLink(); save('dock', Boolean(open)); navigate(); },
    pane: () => load('pane', 'conversation'),
    setPane(pane, { render = true } = {}) { cancelDeepLink(); save('pane', pane); navigate(render); },
    // Unsent text is kept per composer in this browser, so a reload or
    // leaving the hive keeps it. It is cleared only by a confirmed send of
    // the same revision; any change made while sending is kept.
    draftFor: (key) => draftOf(mem, key).text,
    messageMax: DRAFT_TEXT_MAX,
    setDraftFor(key, v) { editDraft(mem, key, { text: String(v) }); },
    draftRev: (key) => draftOf(mem, key).rev,
    clearDraftIf(key, rev) {
      if (!sameRev(mem, key, rev)) return;
      putDraft(mem, key, { ...draftOf(mem, key), text: '', title: '', about: null, aboutAuto: false, detach: null, reply: null, rev: newRev() });
      bump();
    },
    replyFor: (key) => draftOf(mem, key).reply,
    setReplyFor(key, id) { editDraft(mem, key, { reply: id || null }); bump(); },
    // A reply carries the selected item unless the human removed that item
    // from this composer; choosing another item attaches it again.
    attachFor: (key, selected) => Boolean(selected) && draftOf(mem, key).detach !== selected,
    setAttachFor(key, on, selected) { editDraft(mem, key, { detach: on ? null : selected || null }); bump(); },
    // Drafts saved while the composer had a topic field may hold a title.
    // It is kept as the message's first line, which also names the topic.
    // A draft is kept whole even past the send limit; the composer says how
    // much to cut.
    foldTopicTitle(cellId) {
      const key = `${cellId}:new`;
      const d = draftOf(mem, key);
      if (d.title.trim()) editDraft(mem, key, { text: d.text.trim() ? `${d.title}\n\n${d.text}` : d.title, title: '' });
    },
    // A topic is hive-wide unless the human explicitly chooses an item.
    topicAboutFor: (cellId) => draftOf(mem, `${cellId}:new`).about,
    setTopicAbout(cellId, about) {
      editDraft(mem, `${cellId}:new`, { about: about === '' ? '' : about || null, aboutAuto: false });
      bump();
    },
    // Opening or sending also scrolls the panel around the list, if it
    // scrolls, until the newest message shows.
    followMessages(cellId) {
      const key = `messages:${cellId}`;
      state.startAt.delete(key);
      state.follow.set(key, true);
      state.reveal.add(key);
      for (const el of state.root?.querySelectorAll('[data-scroll-follow]') || []) if (el.dataset.scrollKey === key) stick(el);
    },
    // Opening a topic starts at its earliest message still awaiting the
    // human's acknowledgement, or at the newest when none is. Until that
    // place is found the list neither follows the newest message nor reads
    // anything.
    openAtWaiting(key) {
      this.followMessages(key);
      state.startAt.set(`messages:${key}`, { asked: new Set() });
    },
    startPending: (key) => state.startAt.has(`messages:${key}`),
    // The opening a start request belongs to, so a request from an earlier
    // opening of the topic cannot fail a later one.
    startToken: (key) => state.startAt.get(`messages:${key}`) || null,
    // A failed history request opens the topic at the oldest message it has
    // in its newest run, with the gap above it still offered.
    failStart(key, token) {
      const s = state.startAt.get(`messages:${key}`);
      if (!s || s !== token || s.failed) return;
      s.failed = true;
      bump();
    },
    startFailed: (key) => Boolean(state.startAt.get(`messages:${key}`)?.failed),
    // True the first time the history before `id` ('' for the newest) is
    // needed to find where an opened topic starts.
    askStart(key, id) {
      const s = state.startAt.get(`messages:${key}`);
      if (!s || s.asked.has(id)) return false;
      s.asked.add(id);
      return true;
    },
    relationsFor(cellId, threadId, epoch, version) {
      const r = mem.relations;
      return r && r.cellId === cellId && r.threadId === threadId && r.epoch === epoch && r.version === version ? r.relations : null;
    },
    askRelations(cellId, threadId, epoch, version) {
      const r = mem.relations;
      if (r && r.cellId === cellId && r.threadId === threadId && r.epoch === epoch && r.version === version) return null;
      const failed = mem.relationFailure;
      if (failed && failed.cellId === cellId && failed.threadId === threadId && failed.epoch === epoch && failed.version === version && Date.now() < failed.retryAt) return null;
      mem.relationFailure = null;
      return (mem.relations = { cellId, threadId, epoch, version, relations: null });
    },
    retryRelations() {
      const failed = mem.relationFailure;
      return Boolean(failed && Date.now() >= failed.retryAt && load('cell', null) === failed.cellId && mem.thread[failed.cellId] === failed.threadId);
    },
    receiveRelations(token, frame) {
      if (mem.relations !== token || mem.thread[token.cellId] !== token.threadId) return;
      if (!frame.ok || (frame.conversationRevision && !token.epoch.endsWith(`:${frame.conversationRevision}`))) {
        mem.relations = null;
        mem.relationFailure = { ...token, retryAt: Date.now() + RELATION_RETRY_MS };
        return;
      }
      token.relations = frame.relations;
      refreshRelations();
    },
    conversationMessage: (cellId, threadId) => mem.conversationMessage[`${cellId}:${threadId}`] || null,
    selectConversationMessage(cellId, threadId, messageId) {
      const key = `${cellId}:${threadId}`;
      if ((mem.conversationMessage[key] || null) === messageId) return;
      mem.conversationMessage[key] = messageId;
      refreshRelations();
    },
    openThread: (cellId) => mem.thread[cellId] || null,
    // The open topic's summary is kept with it, so a topic reached through a
    // later inbox page stays open when that page is dropped.
    openThreadFor(cellId, threadId, summary = null, { atWaiting = false } = {}) { cancelDeepLink();
      mem.thread[cellId] = threadId;
      mem.conversationMessage = {};
      mem.relations = null;
      mem.relationFailure = null;
      mem.opened[cellId] = summary?.id === threadId ? summary : null;
      rememberConversation(cellId, [mem.opened[cellId]], []);
      mem.forms.renameTopic = null;
      if (atWaiting) this.openAtWaiting(`${cellId}:${threadId}`);
      const token = this.startToken(`${cellId}:${threadId}`);
      navigate();
      return token;
    },
    openedTopic(cellId) { const t = mem.opened[cellId]; return t && t.id === mem.thread[cellId] ? t : null; },
    closeThread(cellId) { cancelDeepLink();
      const id = mem.thread[cellId];
      mem.thread[cellId] = null;
      mem.conversationMessage = {};
      mem.relations = null;
      mem.relationFailure = null;
      mem.opened[cellId] = null;
      if (id) delete mem.history[`${cellId}:${id}`];
      mem.forms.renameTopic = null;
      navigate();
    },
    allTopics: (cellId) => Boolean(mem.all[cellId]),
    setAllTopics(cellId, on) { cancelDeepLink(); mem.all[cellId] = Boolean(on); navigate(); },
    historyFor(cellId, threadId, epoch) {
      const page = mem.history[`${cellId}:${threadId}`];
      return page && page.epoch === epoch ? page : null;
    },
    syncConversation(cellId, epoch) {
      if (mem.conversationEpoch[cellId] && mem.conversationEpoch[cellId] !== epoch) {
        for (const key of Object.keys(mem.history)) if (key.startsWith(`${cellId}:`)) delete mem.history[key];
        for (const key of Object.keys(mem.inbox)) if (key.startsWith(`${cellId}:`)) delete mem.inbox[key];
        for (const key of mem.readers.keys()) if (key.startsWith(`${cellId}:`)) mem.readers.delete(key);
        for (const key of state.startAt.keys()) if (key.startsWith(`${cellId}:`)) state.startAt.delete(key);
        delete mem.older[cellId];
        delete mem.opened[cellId];
        for (const records of [mem.acknowledgementMessages, mem.acknowledgementTopics]) for (const key of records.keys()) if (key.startsWith(`${cellId}:`)) records.delete(key);
      }
      mem.conversationEpoch[cellId] = epoch;
    },
    // A page is one unbroken run of a topic ending just before position
    // `anchorN`, which the server gives. A reply joins it only when the two
    // provably touch: it ends at the page's oldest message, or it reaches
    // back to the page's anchor. Any other newer reply replaces the page; an
    // older one is dropped.
    addHistory(cellId, threadId, epoch, frame, beforeN) {
      if ((mem.conversationEpoch[cellId] && mem.conversationEpoch[cellId] !== epoch) || (frame.conversationRevision && !epoch.endsWith(`:${frame.conversationRevision}`))) return;
      const key = `${cellId}:${threadId}`;
      const got = frame.messages || [];
      const anchorN = Number.isInteger(frame.anchorN) ? frame.anchorN : beforeN;
      if (!Number.isInteger(anchorN)) return;
      const cur = mem.history[key]?.epoch === epoch ? mem.history[key] : null;
      const start = cur ? cur.messages[0]?.n ?? cur.anchorN : null;
      let next;
      if (!cur) next = { epoch, messages: got, more: Boolean(frame.more), anchorN };
      else if (anchorN === start) next = { ...cur, messages: joinRuns(got, cur.messages), more: Boolean(frame.more) };
      else if (anchorN > cur.anchorN && got.length && got[0].n <= cur.anchorN) next = { ...cur, messages: joinRuns(cur.messages, got), anchorN };
      else if (anchorN > cur.anchorN) next = { epoch, messages: got, more: Boolean(frame.more), anchorN };
      else return;
      mem.history[key] = next;
      rememberConversation(cellId, [mem.opened[cellId]], got);
      bump();
    },
    olderTopics(cellId, epoch) { const o = mem.older[cellId]; return o && o.epoch === epoch ? o.threads : []; },
    // Which list the topic list shows instead of topics: 'human' for queen
    // messages waiting for the human, 'queen' for the human's messages
    // waiting for an answer, or null.
    inboxView: (cellId) => mem.inboxView[cellId] || null,
    globalInboxView: () => mem.globalInbox,
    setGlobalInboxView(kind) { mem.globalInbox = ['needs', 'human', 'queen'].includes(kind) ? kind : 'needs'; navigate(); },
    setInboxView(cellId, kind) { cancelDeepLink(); mem.inboxView[cellId] = ['human', 'queen', 'needs'].includes(kind) ? kind : null; navigate(); },
    // The server's acknowledgement revision for a message it names without
    // sending it, which wins over any older copy held here.
    noteServerAck(cellId, messageId, ack) {
      const key = `${cellId}:${messageId}`;
      if (Number.isInteger(ack?.rev) && !(mem.acks.get(key)?.rev >= ack.rev)) mem.acks.set(key, ack);
    },
    // Inbox pages after the first, which comes with the cell. Each page
    // continues from the last one's cursor; items already shown are skipped.
    // The pages hold only while the inbox's membership revision (sig) is the
    // one they were loaded at, so an item that arrives or settles later is
    // never missed; pages from another revision are dropped.
    inboxPages(cellId, kind, epoch, sig) {
      const key = `${cellId}:${kind}`;
      const p = mem.inbox[key];
      if (!p) return null;
      if (p.epoch === epoch && p.sig === sig) return p;
      delete mem.inbox[key];
      return null;
    },
    addInboxPage(cellId, kind, epoch, sig, frame) {
      if ((mem.conversationEpoch[cellId] && mem.conversationEpoch[cellId] !== epoch) || (frame.conversationRevision && !epoch.endsWith(`:${frame.conversationRevision}`))) return;
      const key = `${cellId}:${kind}`;
      const old = mem.inbox[key];
      const cur = old?.epoch === epoch && old.sig === sig ? old : { epoch, sig, ids: [], messages: [], threads: [] };
      const merge = (a, b) => [...new Map([...a, ...b].map((x) => [x.id, x])).values()];
      mem.inbox[key] = {
        epoch,
        sig,
        ids: [...new Set([...cur.ids, ...(frame.ids || [])])],
        messages: merge(cur.messages, frame.messages || []),
        threads: merge(cur.threads, frame.threads || []),
        more: Boolean(frame.more),
        after: frame.after || null,
      };
      rememberConversation(cellId, frame.threads || [], frame.messages || []);
      bump();
    },
    inboxThreads(cellId, epoch, sigs) {
      const out = [];
      for (const kind of ['human', 'queen']) {
        const key = `${cellId}:${kind}`;
        const p = mem.inbox[key];
        if (!p) continue;
        if (p.epoch === epoch && p.sig === sigs[kind]) out.push(...p.threads);
        else delete mem.inbox[key];
      }
      return out;
    },
    // An acknowledgement the server confirmed shows at once, even on a copy
    // of the message loaded earlier; a newer revision from the server wins.
    ackOf(cellId, m) {
      const o = mem.acks.get(`${cellId}:${m.id}`);
      return o && o.rev > (m.ack?.rev ?? -1) ? o : m.ack || null;
    },
    noteAck(cellId, messageId, ack, also = []) {
      if (ack && !ack.state) for (const reader of mem.readers.values()) reader.undo(messageId);
      for (const x of [...also, { messageId, ack }]) if (x?.ack && Number.isInteger(x.ack.rev)) this.noteServerAck(cellId, x.messageId, x.ack);
      state.focusNext = `ack:${messageId}:${(['approve', 'decline'].includes(ack?.state?.reaction) ? ack.state.reaction : 'seen')}`;
      bump();
    },
    olderCursor(cellId, epoch) {
      const o = mem.older[cellId];
      if (!o || o.epoch !== epoch) return undefined;
      return o.more ? o.after : null;
    },
    // A rename confirmed by the server shows at once on a topic loaded with
    // Show older topics. Only the latest rename of a topic applies.
    startRename(cellId, threadId) {
      const k = `${cellId}:${threadId}`;
      mem.renames[k] = (mem.renames[k] || 0) + 1;
      return mem.renames[k];
    },
    renamed(cellId, threadId, seq, title) {
      if (mem.renames[`${cellId}:${threadId}`] !== seq) return;
      const o = mem.older[cellId];
      const t = o?.threads.find((x) => x.id === threadId);
      if (t) o.threads = o.threads.map((x) => (x === t ? { ...x, title, titleBy: 'human' } : x));
      const held = mem.acknowledgementTopics.get(`${cellId}:${threadId}`);
      if (held) mem.acknowledgementTopics.set(`${cellId}:${threadId}`, { ...held, title, titleBy: 'human' });
      const open = mem.opened[cellId];
      if (open?.id === threadId) mem.opened[cellId] = { ...open, title, titleBy: 'human' };
      const f = mem.forms.renameTopic;
      if (f?.cellId === cellId && f.threadId === threadId) mem.forms.renameTopic = null;
      bump();
    },
    addOlderTopics(cellId, epoch, threads, more, after, revision) {
      if ((mem.conversationEpoch[cellId] && mem.conversationEpoch[cellId] !== epoch) || (revision && !epoch.endsWith(`:${revision}`))) return;
      const o = mem.older[cellId]?.epoch === epoch ? mem.older[cellId] : { epoch, threads: [] };
      const byId = new Map(o.threads.map((t) => [t.id, t]));
      for (const t of threads) byId.set(t.id, t);
      mem.older[cellId] = { epoch, threads: [...byId.values()], more: Boolean(more), after: after || null };
      rememberConversation(cellId, threads, []);
      bump();
    },
    readMarks(cellId) {
      const key = `read:${cellId}`;
      const got = load(key, null);
      if (got && Number.isFinite(got.baseline) && got.threads && typeof got.threads === 'object') return got;
      const fresh = { baseline: Date.now(), threads: {} };
      save(key, fresh);
      return fresh;
    },
    markMessageRead(cellId, messageId, at) {
      const marks = this.readMarks(cellId);
      marks.messages ||= {};
      marks.messages[messageId] = at;
      const ids = Object.keys(marks.messages).sort((a, b) => marks.messages[b] - marks.messages[a]);
      for (const id of ids.slice(2000)) delete marks.messages[id];
      save(`read:${cellId}`, marks);
    },
    markRead(cellId, threadId, at) {
      const key = `read:${cellId}`;
      const marks = load(key, null) || { baseline: 0, threads: {} };
      if (!marks.threads || typeof marks.threads !== 'object') marks.threads = {};
      if ((marks.threads[threadId] ?? marks.baseline ?? 0) >= at) return;
      marks.threads[threadId] = at;
      const ids = Object.keys(marks.threads);
      if (ids.length > READ_KEEP) {
        ids.sort((a, b) => marks.threads[b] - marks.threads[a]);
        for (const id of ids.slice(READ_KEEP)) {
          marks.baseline = Math.max(marks.baseline || 0, marks.threads[id]);
          delete marks.threads[id];
        }
      }
      save(key, marks);
    },
    form: (name) => mem.forms[name] || null,
    setForm(name, value) { mem.forms[name] = value; bump(); },
    dropForm(name) { mem.forms[name] = null; },
    patchForm(name, patch) { mem.forms[name] = { ...(mem.forms[name] || {}), ...patch }; },
    inspect: (sessionId) => { cancelDeepLink(); openInspector(sessionId); },
    closeInspector: () => { cancelDeepLink(); closeInspector(); bump(); },
    inspecting: () => state.inspector?.sessionId || null,
    placements: () => state.placements,
    sendPlacement,
    setDragging(on) {
      state.dragging = on;
      if (!on) { state.lastSig = ''; setTimeout(rerender, 0); }
    },
    bump,
  };
}

function openInspector(sessionId) {
  if (!state.api?.mountSession) {
    state.api?.openSession?.(sessionId);
    return;
  }
  if (!state.inspector) {
    const el = h('div', { class: 'hive-inspector-panel' });
    state.inspector = { el, handle: null, sessionId: null };
  }
  const ins = state.inspector;
  ins.sessionId = sessionId;
  state.uiVersion += 1;
  rerender();
  if (ins.handle && ins.handle.sessionId) ins.handle.show(sessionId);
  else ins.handle = state.api.mountSession(ins.el, sessionId);
}

function closeInspector() {
  const ins = state.inspector;
  if (!ins) return;
  try { ins.handle?.unmount(); } catch { }
  state.inspector = null;
}

export function send(frame, { onReply, quiet = false } = {}) {
  const requestId = `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const timer = setTimeout(() => {
    const p = state.pending.get(requestId);
    if (!p) return;
    state.pending.delete(requestId);
    p.onReply?.({ op: frame.type, requestId, ok: false, error: 'No reply from the server yet. The action may still complete; check before repeating it.', timeout: true });
    if (!p.onReply) notice('No reply from the server yet. The action may still complete; check before repeating it.');
    if (!quiet) forceRender();
  }, SEND_TIMEOUT_MS);
  state.pending.set(requestId, { type: frame.type, onReply, timer, quiet });
  state.api.send({ ...frame, requestId });
  if (!quiet) forceRender();
  return requestId;
}

// A dropped tile is drawn where it was dropped until the graph includes the
// saved move. Versions count writes within one metadata epoch, which changes
// whenever the server reloads its metadata, so a move only ever compares
// versions of the epoch it was planned in. A refused, unanswered or
// other-epoch save is dropped at once and the map shows the saved layout.
// `onSaved` runs once the server has saved it.
function sendPlacement(frame, placement, { onSaved = null } = {}) {
  const entry = { ...placement, epoch: state.graph?.hive?.metaEpoch, until: null };
  state.placements = [...state.placements, entry];
  const drop = () => { state.placements = state.placements.filter((p) => p !== entry); };
  return send(frame, {
    onReply: (reply) => {
      if (reply.ok && typeof entry.epoch === 'string' && reply.metaEpoch === entry.epoch && Number.isInteger(reply.metaVersion)) {
        entry.until = reply.metaVersion;
        settlePlacements();
        onSaved?.();
        return;
      }
      drop();
      if (reply.ok) onSaved?.();
      else notice(reply.error || 'The move was not saved.', { severity: 'error' });
    },
  });
}

function settlePlacements() {
  const hive = state.graph?.hive;
  if (!hive) return;
  state.placements = state.placements.filter((p) => p.epoch === hive.metaEpoch && (p.until === null || hive.metaVersion < p.until));
}

function busy(type) {
  for (const p of state.pending.values()) if (p.type === type) return true;
  return false;
}

const toast = createToaster(() => state.api);

function notice(text, opts) {
  if (!toast(text, opts)) console.warn('hive: Agent Wrangler could not show a toast:', text);
}

setSessionLinkGuard((id) => {
  const problem = sessionLinkProblem(state.graph?.sessions, state.history, id);
  if (!problem) return true;
  notice(problem, { brief: true });
  return false;
});

function announceRestores(hive) {
  if (hive) announceRestoreNotices(state.restoreToasted, hive, toast, send, document.visibilityState === 'visible');
}

function onFrame(frame) {
  if (!frame || typeof frame !== 'object' || typeof frame.op !== 'string') return;
  const p = frame.requestId ? state.pending.get(frame.requestId) : null;
  if (p) {
    clearTimeout(p.timer);
    state.pending.delete(frame.requestId);
    try { p.onReply?.(frame); } catch (err) { console.error('hive: reply handler failed', err); }
  }
  if (p?.quiet) return;
  if (!frame.ok && frame.error && !p?.onReply) notice(frame.error, { severity: 'error' });
  else forceRender();
}

function forceRender() {
  state.lastSig = '';
  rerender();
}

function signature(hive, graph) {
  const tasks = new Set(Object.values(hive.cells).map((c) => c.taskId));
  const assignments = graph?.tasks?.assignments || {};
  const shown = new Set();
  for (const c of Object.values(hive.cells)) {
    if (c.queenSessionId) shown.add(c.queenSessionId);
    for (const b of c.bindings || []) shown.add(b.sessionId);
  }
  for (const b of Object.values(hive.beads || {})) if (b.ownerSessionId) shown.add(b.ownerSessionId);
  const sessions = (graph?.sessions || [])
    .filter((s) => tasks.has(assignments[s.sessionId]) || shown.has(s.sessionId))
    .map((s) => `${s.sessionId}:${s.status}:${s.waitingReason || ''}:${s.exitOutput ? 'x' : ''}:${s.archived ? 'a' : ''}:${s.name || s.label || ''}`)
    .join('|');
  const names = (graph?.tasks?.tasks || []).map((t) => `${t.id}:${t.name}`).join('|');
  return [hive.revision, hive.metaEpoch, hive.metaVersion, hive.backend.state, hive.backend.checkedAt, hive.metadataError || '', sessions, waitingGraphKey(graph), Object.values(hive.cells).some(c => c.pullRequests?.length) ? Math.floor(Date.now() / 60000) : '', names, state.uiVersion, state.pending.size, state.placements.length, beeLevel(), JSON.stringify(hive.capacity), capacityLimit(state.api), state.api?.settings?.()?.requestNotifications !== false].join('#');
}

export function captureFocus(root) {
  const a = document.activeElement;
  if (!a || !root.contains(a)) return null;
  return {
    tileId: a.dataset?.tileId || null,
    focusKey: a.dataset?.focusKey || null,
    focusFallback: a.dataset?.focusFallback || null,
    focusFinal: a.dataset?.focusFinal || null,
    start: typeof a.selectionStart === 'number' ? a.selectionStart : null,
    end: typeof a.selectionEnd === 'number' ? a.selectionEnd : null,
  };
}

export function restoreFocus(root, f) {
  const next = state.focusNext;
  state.focusNext = null;
  if (!f) return;
  let el = null;
  if (f.focusKey) el = root.querySelector(`[data-focus-key="${CSS.escape(f.focusKey)}"]`);
  else if (f.tileId) el = root.querySelector(`[data-tile-id="${CSS.escape(f.tileId)}"]`);
  if (el?.disabled) el = null;
  if (!el && next) el = root.querySelector(`[data-focus-key="${CSS.escape(next)}"]`);
  if (!el && f.focusFallback) el = root.querySelector(`[data-focus-key="${CSS.escape(f.focusFallback)}"]`);
  if (!el && f.focusFinal) el = root.querySelector(`[data-focus-key="${CSS.escape(f.focusFinal)}"]`);
  if (!el || el === document.activeElement) return;
  state.restoringFocus = true;
  try { el.focus({ preventScroll: true }); } finally { state.restoringFocus = false; }
  if (f.start !== null && typeof el.setSelectionRange === 'function') {
    try { el.setSelectionRange(f.start, f.end); } catch { }
  }
}

// Scroll positions are remembered by key, including for a panel that is
// hidden behind another tab, so it comes back where it was left. A list
// marked to follow (the conversation) opens at its newest entry and stays
// there as entries arrive or the list resizes, until the reader scrolls up;
// scrolling back to the bottom, or sending, follows again. A list that is
// not laid out yet (a hidden tab, a pane not yet shown) is put back when it
// first gets a size, and is not remembered before then.
function persistView() {
  const hash = globalThis.window?.location?.hash;
  if (typeof hash === 'string') saveScrollState(hash, state.scrollMemo, state.follow);
}

function captureScroll(root) {
  for (const el of [...(root.matches?.('[data-scroll-key]') ? [root] : []), ...root.querySelectorAll('[data-scroll-key]')]) {
    if (el.clientWidth > 0 && !el.hivePending) {
      state.scrollMemo.set(el.dataset.scrollKey, { left: el.scrollLeft, top: el.scrollTop, anchor: anchorOf(el) });
      if ('scrollFollow' in el.dataset && !scrolling(el)) state.follow.set(el.dataset.scrollKey, atBottom(el));
    }
  }
}

// The first message the reader can see, counting a scrolling panel around
// the list, and how far it sits from the list's top, so the reader keeps
// their place when messages are added or dropped above it.
function anchorOf(el) {
  const top = el.getBoundingClientRect().top;
  const seen = visibleBand(el).top;
  for (const item of el.children) {
    if (!item.dataset?.id) continue;
    const r = item.getBoundingClientRect();
    if (r.bottom > seen) return { id: item.dataset.id, offset: r.top - top };
  }
  return null;
}

function putBack(el, retained = false) {
  el.hivePending = false;
  const key = el.dataset.scrollKey;
  if (state.startAt.has(key)) {
    if (!('startAt' in el.dataset)) return;
    state.startAt.delete(key);
    const item = el.dataset.startAt && [...el.children].find((c) => c.dataset?.id === el.dataset.startAt);
    if (item) { showFrom(el, item); return; }
    state.follow.set(key, true);
  }
  if ('scrollFollow' in el.dataset && state.follow.get(el.dataset.scrollKey) !== false) { stick(el); return; }
  if (retained && scrolling(el)) return;
  const saved = state.scrollMemo.get(el.dataset.scrollKey);
  if (!saved) return;
  el.scrollLeft = saved.left;
  el.scrollTop = saved.top;
  const item = saved.anchor && [...el.children].find((c) => c.dataset?.id === saved.anchor.id);
  if (item) el.scrollTop += item.getBoundingClientRect().top - el.getBoundingClientRect().top - saved.anchor.offset;
  el.hiveSetTop = el.scrollTop;
}

// Puts `item` at the top of the list, and of the panel around it when that
// scrolls, and stops following the newest message until the reader scrolls
// back to the bottom.
function showFrom(el, item) {
  state.follow.set(el.dataset.scrollKey, false);
  state.reveal.delete(el.dataset.scrollKey);
  el.scrollTop += item.getBoundingClientRect().top - el.getBoundingClientRect().top;
  el.hiveSetTop = el.scrollTop;
  const panel = el.parentElement?.closest('[data-scroll-key]');
  if (!panel || panel.clientHeight <= 0) return;
  panel.scrollTop += item.getBoundingClientRect().top - panel.getBoundingClientRect().top;
  panel.hiveSetTop = panel.scrollTop;
}

function atBottom(el) {
  return el.scrollHeight - el.clientHeight - el.scrollTop <= FOLLOW_SLACK_PX;
}

function stick(el) {
  if (!el.isConnected || el.clientWidth <= 0 || state.follow.get(el.dataset.scrollKey) === false || state.startAt.has(el.dataset.scrollKey)) return;
  el.scrollTop = el.scrollHeight;
  el.hiveSetTop = el.scrollTop;
  if (state.reveal.has(el.dataset.scrollKey) && revealEnd(el)) state.reveal.delete(el.dataset.scrollKey);
}

// Scrolls the panel around a list until the list's newest message shows.
// False while there is no message yet (only Loading) or the panel has no
// size, so the request waits for the messages to arrive. The reader's own
// scrolling of the panel, told apart from these writes and from putting a
// place back by the position they left, cancels the wait.
function revealEnd(el) {
  const panel = el.parentElement?.closest('[data-scroll-key]');
  if (!panel) return true;
  const last = [...el.children].reverse().find((c) => c.dataset?.id);
  if (!last || panel.clientHeight <= 0) return false;
  const p = panel.getBoundingClientRect();
  const r = last.getBoundingClientRect();
  const bottom = Math.min(r.bottom, el.getBoundingClientRect().bottom);
  if (bottom > p.bottom) panel.scrollTop += bottom - p.bottom;
  else if (r.top < p.top) panel.scrollTop -= p.top - r.top;
  panel.hiveSetTop = panel.scrollTop;
  return true;
}

function scrolling(el) {
  for (let node = el; node; node = node.parentElement) {
    if (node.hiveTouching || node.hiveScrollUntil > Date.now()) return true;
  }
  return false;
}

function watchScroll(el) {
  if (!el.hiveScrollWatch) {
    el.hiveScrollWatch = true;
    const active = () => { el.hiveScrollUntil = Date.now() + 300; };
    el.addEventListener('wheel', event => {
      active();
      if (event.deltaY < 0 && el.scrollTop > 0 && 'scrollFollow' in el.dataset) state.follow.set(el.dataset.scrollKey, false);
    }, { passive: true });
    el.addEventListener('touchstart', () => { el.hiveTouching = true; active(); }, { passive: true });
    for (const type of ['touchend', 'touchcancel']) el.addEventListener(type, () => { el.hiveTouching = false; active(); }, { passive: true });
    el.addEventListener('scroll', () => {
      if (Math.abs(el.scrollTop - (el.hiveSetTop ?? -2)) > 1) active();
    }, { passive: true });
  }
  if (!('scrollFollow' in el.dataset) && !el.hiveFollowing) {
    el.hiveFollowing = true;
    el.addEventListener('scroll', () => {
      if (Math.abs(el.scrollTop - (el.hiveSetTop ?? -2)) > 1) for (const x of el.querySelectorAll('[data-scroll-follow]')) state.reveal.delete(x.dataset.scrollKey);
      for (const x of el.querySelectorAll('[data-on-shown]')) x.hiveShown?.();
    }, { passive: true });
  }
  if ('scrollFollow' in el.dataset && !el.hiveFollowing) {
    el.hiveFollowing = true;
    el.addEventListener('scroll', () => {
      if (!el.isConnected || el.clientWidth <= 0) return;
      const following = atBottom(el);
      state.follow.set(el.dataset.scrollKey, following);
      if (!following) state.reveal.delete(el.dataset.scrollKey);
    }, { passive: true });
    el.addEventListener('load', () => stick(el), true);
    document.fonts?.ready?.then(() => stick(el));
  }
  if (!state.followObserver && typeof ResizeObserver === 'function') {
    state.followObserver = new ResizeObserver((entries) => {
      for (const { target } of entries) {
        if (target.hivePending) { if (target.clientWidth > 0) { putBack(target); settleShown(target); } } else if ('scrollFollow' in target.dataset) stick(target);
        target.hiveShown?.();
      }
      revealLinkMessage(state.root);
    });
  }
  state.followObserver?.observe(el);
  state.followed.add(el);
}

function releaseFollowers(all = true) {
  for (const el of state.followed) if (all || !el.isConnected) {
    state.followObserver?.unobserve(el);
    state.followed.delete(el);
  }
}

// Three stable regions. Re-renders replace only `top` and `bottom`; the
// embedded session panel lives in `slot` and stays connected, so AW's own chat
// composer or terminal keeps focus and selection across Hive updates.
function layoutOf(root) {
  const l = state.layout;
  if (l && l.root === root && l.top.parentNode === root) return l;
  clear(root);
  const top = h('div', { class: 'hive-region' });
  const slot = h('div', { class: 'hive-inspector-slot' });
  const bottom = h('div', { class: 'hive-region' });
  const divider = h('div', { class: 'hive-divider', role: 'separator', tabindex: '0',
    'aria-label': 'Map and panel width', 'aria-orientation': 'vertical', 'data-focus-key': 'panel-divider' });
  root.append(top, slot, bottom, divider);
  const resize = installPanelSplit(root, divider);
  state.layout = { root, top, slot, bottom, resize };
  return state.layout;
}

export function resolveLink(hive) {
  const request = state.linkRequest;
  if (!request || request.sent || !state.api?.send) return;
  request.sent = true;
  const scrollKey = `messages:${request.target.cellId}:${request.target.threadId}`;
  const messageId = request.restore ? state.scrollMemo.get(scrollKey)?.anchor?.id || request.target.messageId : request.target.messageId;
  send({ type: 'hive-deep-link', ...request.target, messageId, restore: request.restore === true }, {
    quiet: true,
    onReply(frame) {
      if (state.linkRequest !== request) return;
      if (state.linkBridge && !state.linkBridge.isCurrent()) { cancelDeepLink(); forceRender(); return; }
      const current = state.graph?.hive?.cells?.[request.target.cellId];
      if (frame.conversationRevision && current?.conversationRevision && frame.conversationRevision !== current.conversationRevision) {
        if (request.refreshed) { cancelDeepLink(); notice('That conversation changed. Open the link again.', { severity: 'info' }); return; }
        request.refreshed = true;
        request.sent = false;
        resolveLink(state.graph.hive);
        return;
      }
      state.linkRequest = null;
      const got = frame.ok ? frame : { cellId: hive.cells[request.target.cellId] ? request.target.cellId : null, notice: 'That link is unavailable.' };
      if (got.cellId && !state.graph?.hive?.cells?.[got.cellId]) {
        got.cellId = null;
        got.notice = 'That hive is unavailable. Showing all hives.';
      }
      state.ui.openDeepLink({ ...got, beadId: request.target.beadId, pane: request.target.pane }, state.graph?.hive?.metaEpoch || '', { restore: request.restore });
      state.linkBridge?.restore(got.notice ? hiveLink(got.cellId) : undefined);
      persistView();
      if (got.notice) notice(got.notice, { severity: 'info' });
    },
  });
}

function revealLinkMessage(root) {
  const link = state.linkMessage;
  if (!link?.pending) return;
  state.follow.set(`messages:${link.cellId}:${link.threadId}`, false);
  if (!revealMessage(root, link.messageId)) return;
  link.pending = false;
  setTimeout(() => {
    if (state.linkMessage !== link) return;
    state.linkMessage = null;
    forceRender();
  }, 2500);
}

export function restoreScroll(root) {
  for (const el of root.querySelectorAll('[data-scroll-key]')) {
    const retained = state.followed.has(el);
    if (retained && !el.hiveRebuilt) continue;
    el.hiveRebuilt = false;
    watchScroll(el);
    if (el.clientWidth > 0) putBack(el, retained);
    else el.hivePending = true;
    if ('onShown' in el.dataset) settleShown(el);
  }
  revealLinkMessage(root);
}

function settleShown(el) {
  el.hiveReadReady = false;
  const token = {};
  el.hiveReadToken = token;
  afterFrame(() => afterFrame(() => {
    if (el.hiveReadToken !== token || !el.isConnected || el.hivePending) return;
    el.hiveReadReady = true;
    el.hiveShown?.();
  }));
}

// Read marks advance only while the page is in view; returning to the tab
// checks again.
function onVisible() {
  announceRestores(state.graph?.hive);
  if (document.visibilityState === 'visible' && state.root) for (const el of state.root.querySelectorAll('[data-on-shown]')) el.hiveShown?.();
}

function watchSize(root) {
  if (state.sizer?.root === root) return;
  state.sizer?.observer?.disconnect();
  const apply = () => {
    if (root.clientWidth < COMPACT_MAX_WIDTH) root.dataset.compact = ''; else delete root.dataset.compact;
    state.layout?.resize();
    state.bees?.keep();
  };
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(apply) : null;
  observer?.observe(root);
  state.sizer = { root, observer };
  apply();
}

function setView(root, view) {
  const set = (k, v) => { if (v) root.dataset[k] = v; else delete root.dataset[k]; };
  set('view', view?.inspecting ? 'cell-inspecting' : view ? 'cell' : null);
  set('panels', view ? (view.panels ? 'open' : 'closed') : null);
  set('pane', view?.pane || null);
}

export function rerender() {
  const root = state.root;
  if (!root || state.dragging) return;
  const hive = state.graph?.hive || null;
  if (!hive) {
    disposeMenuWatch();
    releaseFollowers();
    const l = layoutOf(root);
    setView(root, null);
    clear(l.top).append(h('div', { class: 'hive-empty' }, 'Waiting for Hive data from the server…'));
    clear(l.bottom);
    return;
  }
  resolveLink(hive);
  if (state.linkRequest && !state.hiveShown && state.api?.send) {
    const l = layoutOf(root);
    setView(root, null);
    clear(l.top).append(h('div', { class: 'hive-empty', role: 'status' }, 'Opening link…'));
    clear(l.bottom);
    return;
  }
  state.hiveShown = true;
  const sig = signature(hive, state.graph);
  if (sig === state.lastSig) return;
  state.lastSig = sig;
  menuRenderStart();
  const focus = captureFocus(root);
  const ctx = { hive, graph: state.graph, api: state.api, send, busy, notice, ui: state.ui, uiVersion: state.uiVersion, beforeReplace: captureScroll, bees: beeControls };
  let out;
  if (setupNeeded(hive) && (hive.metadataError || !Object.values(hive.cells || {}).some(c => Object.keys(c.requests || {}).length))) {
    out = { top: renderSetup(ctx) };
  } else {
    // A cell just created or added may be opened before the graph that
    // contains it arrives; it stays requested until then rather than being
    // dropped back to the overview.
    const cellId = state.ui.cellId();
    if (cellId && hive.cells[cellId] && state.pendingCell === cellId) state.pendingCell = null;
    else if (cellId && !hive.cells[cellId] && state.pendingCell !== cellId) save('cell', null);
    out = renderHive(ctx);
  }
  const l = layoutOf(root);
  watchSize(root);
  setView(root, out.view || null);
  syncChildren(l.top, [out.top], captureScroll);
  syncChildren(l.bottom, [out.bottom], captureScroll);
  releaseFollowers(false);
  const ins = out.inspector ? state.inspector : null;
  if (ins) {
    if (ins.el.parentNode !== l.slot) {
      clear(l.slot);
      l.slot.append(ins.el);
    }
  } else if (l.slot.firstChild) {
    clear(l.slot);
  }
  restoreScroll(root);
  for (const el of root.querySelectorAll('.hive-canvas')) if (!el.hiveMounted) { el.hiveMounted = true; el.hiveViewMounted?.(); }
  restoreFocus(root, focus);
  announceRestores(hive);
  menuRenderEnd();
  refreshWaitingMenu(ctx);
  if (state.revealCell) {
    const tile = root.querySelector(`.hive-overview [data-tile-id="${CSS.escape(state.revealCell)}"]`);
    if (tile && !root.querySelector('.hive-dialog')) {
      state.revealCell = null;
      tile.focus();
    }
  }
  const dialog = root.querySelector('.hive-dialog');
  if (dialog && !dialog.contains(document.activeElement)) dialog.querySelector('[data-autofocus]')?.focus();
  const zoom = state.zoom;
  state.zoom = null;
  if (zoom) playZoom(root, zoom);
  state.bees?.keep();
}

// Number of bees is one preference for every hive, kept in Hive's own AW
// settings. While a slider is moving, or its value is being saved, that value
// is shown and flown.
function beeLevel() {
  if (state.beePending !== null) return state.beePending;
  try { return beeLevelOf(state.api?.settings?.()); } catch { return beeLevelOf(null); }
}

// Every movement and every release of a slider is a new intent. Saves run
// one at a time, always for the latest released level, and each writes the
// level and then the older Show bees switch that earlier Hive builds read, so
// two saves never interleave. A finished save drops the shown preview only
// when nothing has moved since the last release.
let beeIntent = 0;
let beeCommitted = 0;
let beeWant = null;
let beeSaving = false;

function previewBees(level) {
  beeIntent += 1;
  state.beePending = level;
  state.bees?.sync();
}

function commitBees(level) {
  beeIntent += 1;
  beeCommitted = beeIntent;
  state.beePending = level;
  state.bees?.sync();
  beeWant = level;
  if (!beeSaving) saveBees();
}

async function setSetting(key, value) {
  if (typeof state.api?.settings?.set !== 'function') throw new Error('settings cannot be saved here.');
  await state.api.settings.set(key, value);
}

async function saveBees() {
  beeSaving = true;
  let failed = null;
  let legacyFailed = null;
  while (beeWant !== null) {
    const want = beeWant;
    beeWant = null;
    failed = null;
    legacyFailed = null;
    try { await setSetting(BEE_LEVEL_SETTING, want); } catch (err) { failed = err; continue; }
    try { await setSetting(BEES_SETTING, want > 0); } catch (err) { legacyFailed = err; }
  }
  beeSaving = false;
  if (beeIntent === beeCommitted) {
    state.beePending = null;
    state.bees?.sync();
  }
  if (failed) notice(`Number of bees was not saved: ${failed?.message || failed}`, { severity: 'error' });
  else if (legacyFailed) notice(`Number of bees is saved. The matching setting older Hive versions read was not updated (${legacyFailed?.message || legacyFailed}); Hive tries again the next time it opens.`);
  forceRender();
}

// Brings the older Show bees switch back in step with a saved level, for
// example after its half of a save failed. It writes only when they differ.
let beeRepairing = false;
async function repairLegacyBees() {
  if (beeRepairing || beeSaving) return;
  let values;
  try { values = state.api?.settings?.(); } catch { return; }
  const saved = values?.[BEE_LEVEL_SETTING];
  if (saved === undefined || beeLevelOf(values) !== saved || values[BEES_SETTING] === (saved > 0)) return;
  beeRepairing = true;
  try { await setSetting(BEES_SETTING, saved > 0); } catch { } finally { beeRepairing = false; }
}

// Re-renders wait while a slider is held, as they do for a dragged tile.
// Only a hold this control started is released, and only once.
let beeHeld = false;
function holdBees(on) {
  if (on === beeHeld) return;
  beeHeld = on;
  state.ui?.setDragging(on);
}

const beeControls = {
  slider: (idKey) => beeSlider({ value: beeLevel(), onInput: previewBees, onCommit: commitBees, onHold: holdBees, idKey }),
};

const EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)';

// Entering a cell grows its bead map out of the hex that was clicked; leaving
// it shrinks the overview back down onto that cell. Skipped under reduced
// motion.
function playZoom(root, zoom) {
  if (reducedMotion() || typeof Element.prototype.animate !== 'function') return;
  if (zoom.dir === 'in') {
    const stage = root.querySelector('.hive-cellview .hive-canvas');
    if (stage && zoom.from) {
      const c = stage.getBoundingClientRect();
      if (c.width && c.height) {
        const s = Math.max(0.12, Math.min(1, zoom.from.width / c.width));
        const dx = zoom.from.left + zoom.from.width / 2 - (c.left + c.width / 2);
        const dy = zoom.from.top + zoom.from.height / 2 - (c.top + c.height / 2);
        stage.animate([
          { transform: `translate(${dx}px, ${dy}px) scale(${s})`, opacity: 0, borderRadius: '48px' },
          { transform: 'none', opacity: 1, borderRadius: '14px' },
        ], { duration: 320, easing: EASE });
      }
    }
    for (const el of root.querySelectorAll('.hive-cellhead, .hive-dock')) {
      el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 240, delay: 60, easing: 'ease-out', fill: 'backwards' });
    }
  } else if (zoom.cellId) {
    const stage = root.querySelector('.hive-overview .hive-canvas');
    const r = stage?.hiveTileRect?.(zoom.cellId);
    if (!stage || !r) return;
    const c = stage.getBoundingClientRect();
    const origin = `${r.left + r.width / 2 - c.left}px ${r.top + r.height / 2 - c.top}px`;
    stage.animate([
      { transformOrigin: origin, transform: 'scale(3)', opacity: 0 },
      { transformOrigin: origin, transform: 'none', opacity: 1 },
    ], { duration: 300, easing: EASE });
  }
}

const overview = {
  id: 'overview',
  label: 'Hive',
  icon: HIVE_ICON,
  badge(graph) { return graph?.hive?.metadataError ? 0 : graph?.hive?.requestCount || 0; },
  mount(el, api) {
    state.api = api || state.api;
    state.root = el;
    el.classList.add('hive-root');
    document.addEventListener('visibilitychange', onVisible);
    globalThis.window?.addEventListener('focus', onVisible);
    state.lastSig = '';
    rerender();
    state.bees?.mount(el);
    state.bees?.sync();
    repairLegacyBees();
  },
  update(el, session, graph) {
    if (graph) {
      state.graph = graph;
      if ('history' in graph) state.history = graph.history || [];
      state.requestNotifications?.(graph.hive);
      settlePlacements();
    }
    state.root = el;
    if (state.ui.retryRelations()) state.lastSig = '';
    rerender();
    state.bees?.mount(el);
    state.bees?.sync();
  },
  unmount(el) {
    if (state.root === el) {
      cancelDeepLink();
      document.removeEventListener('visibilitychange', onVisible);
      globalThis.window?.removeEventListener('focus', onVisible);
      disposeConfirm();
      disposeWaitingMenu();
      disposeImages(state.ui);
      disposeConversation(state.ui);
      disposePanels(state.ui);
      disposeHiveView(state.ui);
      disposeMenuWatch();
      state.bees?.unmount();
      closeInspector();
      state.root = null;
      state.layout = null;
      state.sizer?.observer?.disconnect();
      state.sizer = null;
      state.followObserver?.disconnect();
      state.followObserver = null;
      state.followed.clear();
      state.restoreToasted.clear();
      state.lastSig = '';
      state.hiveShown = false;
      setView(el, null);
      delete el.dataset.layout;
      delete el.dataset.compact;
    }
    clear(el);
  },
};

export default {
  register(registrar) {
    state.api = registrar.api;
    state.requestNotifications = createRequestNotifications(state.api, { read: () => load('requestEpisodes', []), write: v => save('requestEpisodes', v), answer: (r, optionId) => answerRequestOption(r, optionId, { ui: state.ui, ctx: { send, notice, onError: () => { globalThis.location.hash = hiveLink(r.cellId, r.threadId, r.messageId); } } }) });
    state.ui = createUi();
    const saved = readScrollState(globalThis.window?.location?.hash);
    if (saved) { state.scrollMemo = saved.scroll; state.follow = saved.follow; }
    state.linkBridge?.dispose();
    if (state.pageHide) globalThis.window?.removeEventListener('pagehide', state.pageHide);
    state.pageHide = () => { if (state.root) captureScroll(state.root); persistView(); };
    globalThis.window?.addEventListener('pagehide', state.pageHide);
    let restore = Boolean(saved?.restore);
    if (globalThis.window?.history) state.linkBridge = installHiveLinks(window, target => {
      state.linkRequest = { target, sent: false, restore };
      restore = false;
      state.linkMessage = null;
      state.lastSig = '';
      rerender();
    }, () => {
      restore = false;
      state.linkRequest = null;
      state.linkMessage = null;
      state.startAt.clear();
      if (state.root && !state.hiveShown) forceRender();
    });
    state.bees = createBees({ level: beeLevel });
    registrar.api?.settings?.onChange?.(() => {
      state.bees?.sync();
      rerender();
      repairLegacyBees();
    });
    registrar.onMessage?.(onFrame);
    registrar.register('view', overview);
  },
};
