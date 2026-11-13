import { h, markdown, relativeTime, sessionReference } from './dom.js';
import { hiveLink } from './deep-links.js';

const visibleToHuman = r => r && (r.audience === 'human' || (r.audience === 'route-repair' && Boolean(r.forwarded || r.routeReason === 'no-queen')));
export const needsHuman = r => visibleToHuman(r) && (r.state === 'open' || (r.state === 'answered' && r.delivery?.state !== 'delivered'));
const forms = new WeakMap();
function formFor(ui, r) {
  if (!forms.has(ui)) forms.set(ui, new Map());
  const all = forms.get(ui);
  if (!all.has(r.id)) all.set(r.id, { signature: signature(r), pending: false });
  return all.get(r.id);
}
export function requestAuthor(graph, r) {
  const requester = (graph?.sessions || []).find(s => s.sessionId === r.requesterSessionId);
  return requester?.name || requester?.label || r.requesterSessionId || '';
}
const signature = r => `${r.contentRevision || 1}:${r.routeRevision}:${r.state}`;
function submitRequest(ui, r, ctx, type, extra = {}) {
  const form = formFor(ui, r), key = `request:${r.id}`;
  if (form.pending) return false;
  form.pending = true;
  const draftRev = ui.draftRev(key);
  ctx.send({ type, request_id: r.id, revision: r.revision, route_revision: r.routeRevision, receipt: form.receipt ||= `req-${Date.now()}-${Math.random().toString(36).slice(2)}`, ...extra }, {
    onReply(frame) {
      form.pending = false;
      if (frame.ok) {
        if (type === 'hive-request-answer') ui.clearDraftIf(key, draftRev);
        ctx.notice(type === 'hive-request-dismiss' ? 'Request dismissed.' : type === 'hive-request-retry' ? 'Delivery retried.' : 'Answer saved.', { severity: 'success' });
      } else {
        ctx.notice(frame.error || 'Could not update request. Review its current state before retrying.', { severity: 'error' });
        ctx.onError?.();
      }
      ui.setForm(`request-update:${r.id}`, Date.now());
    },
  });
  ui.setForm(`request-update:${r.id}`, Date.now());
  return true;
}
export function answerRequestOption(r, optionId, { ui, ctx }) {
  if (signature(r) !== formFor(ui, r).signature) { ctx.onError?.(); return false; }
  return submitRequest(ui, r, ctx, 'hive-request-answer', { option_id: optionId, text: ui.draftFor(`request:${r.id}`).trim() });
}
export function requestCard(r, { cell, graph, api, ui, ctx }) {
  if (!r) return h('div', { class: 'hive-muted' }, 'This request is no longer available.');
  if (!visibleToHuman(r)) return null;
  const form = formFor(ui, r), key = `request:${r.id}`, sig = signature(r);
  const changed = sig !== form.signature;
  const busy = form.pending || ctx.busy('hive-request-answer') || ctx.busy('hive-request-dismiss') || ctx.busy('hive-request-retry');
  const author = requestAuthor(graph, r);
  const md = text => markdown(api, text, { sessions: graph?.sessions || [] });
  const requesterLink = r.requesterSessionLink || (r.forwarded ? { sessionId: r.requesterSessionId, label: 'Open requester session' } : null);
  const sessionLinks = [r.sessionLink, requesterLink].filter((link, i, all) => link && all.findIndex(other => other?.sessionId === link.sessionId) === i);
  const focusFallback = { focusFallback: `request-card:${r.id}`, focusFinal: `request-list:${cell.id}` };
  const out = h('article', { class: 'hive-request', tabindex: -1, 'data-focus-key': `request-card:${r.id}`, dataset: { requestId: r.id, focusFinal: `request-list:${cell.id}` }, 'aria-label': `Request: ${r.title}` },
    h('h4', {}, r.title),
    h('p', { class: 'hive-muted' }, `${author} · ${relativeTime(r.createdAt)} · ${r.state === 'open' ? r.audience === 'queen' ? 'Worker request · Waiting for queen' : 'Needs you' : r.state}`),
    r.warning ? h('p', { class: 'hive-warning' }, r.warning) : null,
    md(r.body),
    sessionLinks.length ? h('p', { class: 'hive-session-links' }, sessionLinks.map((link, i) => [i ? ' · ' : null, sessionReference(graph, link)])) : null,
    r.forwarded?.recommendation ? h('div', { class: 'hive-quote' }, 'Queen recommendation: ', md(r.forwarded.recommendation)) : null);
  if (r.audience === 'queen' && ['failed', 'uncertain'].includes(r.queenNotification?.state)) out.append(h('p', { class: 'hive-warning' }, `Queen notification ${r.queenNotification.state}: ${r.queenNotification.error || 'Check with the queen.'}`));
  if (r.answer) out.append(h('div', { class: 'hive-request-answer' }, h('strong', {}, r.answer.author === 'human' ? 'Human answer' : 'Queen answer'), r.answer.optionId ? h('p', {}, `Choice: ${(r.options || []).find(o => o.id === r.answer.optionId)?.label || r.answer.optionId} (${r.answer.optionId})`) : null, r.answer.text ? md(r.answer.optionId ? `Note: ${r.answer.text}` : r.answer.text) : null, h('p', { class: 'hive-muted' }, `Answer delivery: ${r.delivery?.state || 'pending'}`, r.delivery?.error ? ` — ${r.delivery.error}` : '')));
  if (r.resolution) out.append(h('p', { class: 'hive-muted' }, `Closed: ${r.resolution.reason} by ${r.resolution.by}`));
  const submit = (type, extra = {}) => submitRequest(ui, r, ctx, type, extra);
  if (r.state === 'open' && r.audience !== 'queen') {
    const options = r.options || [];
    const sendText = () => { const text = ui.draftFor(key).trim(); if (text) submit('hive-request-answer', { text }); else ctx.notice('Write an answer first.'); };
    if (options.length) out.append(h('div', { class: 'hive-request-options', role: 'group', 'aria-label': 'Options' }, options.map((o, i) => h('button', { type: 'button', class: 'hive-request-option', disabled: busy || changed, 'data-focus-key': `request-option:${r.id}:${o.id}`, dataset: focusFallback, onclick: () => submit('hive-request-answer', { option_id: o.id, text: ui.draftFor(key).trim() }) }, h('span', { class: 'hive-request-option-num', 'aria-hidden': 'true' }, i + 1), h('span', { class: 'hive-request-option-text' }, h('span', { class: 'hive-request-option-label' }, o.label), o.description ? h('span', { class: 'hive-request-option-description' }, o.description) : null)))));
    const textarea = h('textarea', { rows: 3, maxlength: options.length ? 4000 : 20000, disabled: busy, onkeydown: e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); e.stopPropagation(); if (!busy && !changed) sendText(); } }, 'aria-label': `Answer request ${r.title}`, 'data-focus-key': `request-answer:${r.id}`, dataset: focusFallback, value: ui.draftFor(key), oninput: e => ui.setDraftFor(key, e.target.value) });
    out.append(h('label', {}, options.length ? 'Your answer, or a note with your choice' : 'Your answer', textarea));
    if (changed) out.append(h('p', { role: 'status', class: 'hive-warning' }, 'This request or route changed. Review the current question; your draft is kept.'), h('button', { type: 'button', class: 'hive-btn', onclick: () => { form.signature = sig; form.receipt = null; ui.setForm(`request-update:${r.id}`, Date.now()); } }, 'Review current request'));
    out.append(h('div', { class: 'hive-request-actions' },
      h('button', { type: 'button', class: 'hive-btn hive-btn-primary', disabled: busy || changed, 'data-focus-key': `request-submit:${r.id}`, dataset: focusFallback, onclick: sendText }, options.length ? 'Send' : 'Answer request'),
      h('button', { type: 'button', class: 'hive-quiet-btn', disabled: busy || changed, 'data-focus-key': `request-dismiss:${r.id}`, dataset: focusFallback, onclick: () => submit('hive-request-dismiss') }, 'Dismiss request')));
  }
  if (r.state === 'answered' && r.delivery?.state !== 'delivered') {
    out.append(h('p', { class: 'hive-warning' }, 'The answer is saved. Check whether the requester received it before sending again.'),
      h('button', { type: 'button', class: 'hive-btn', disabled: busy, 'data-focus-key': `request-retry:${r.id}`, dataset: focusFallback, onclick: () => submit('hive-request-retry', { confirm_uncertain: true }) }, 'Send answer again'));
  }
  return out;
}
export function requestList({ cell, kind, scope = null, all = true, ...ctx }) {
  const items = Object.values(cell.requests || {}).filter(needsHuman).sort((a, b) => Number(b.blocking) - Number(a.blocking) || a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  const list = h('ol', { class: 'hive-topics hive-request-list', tabindex: -1, 'data-focus-key': `request-list:${cell.id}`, 'aria-label': kind === 'needs' ? 'Needs you' : 'Worker requests waiting for queen' });
  const shown = items.filter(r => all || !scope || scope.has(r.beadId));
  for (const r of shown) list.append(h('li', {}, requestCard(r, { cell, ...ctx })));
  if (shown.length < items.length) list.append(h('li', {}, h('button', { type: 'button', class: 'hive-link-btn', onclick: () => ctx.ui.setAllTopics(cell.id, true) }, `Show all in this hive (${items.length - shown.length} more requests)`)));
  if (!shown.length) list.append(h('li', { class: 'hive-muted' }, 'No native requests waiting.'));
  return list;
}

export function createRequestNotifications(api, { read = () => null, write = () => {}, answer = null, open = url => { globalThis.location.hash = url; } } = {}) {
  let seeded = false;
  const shown = new Map(), seen = new Set(read() || []);
  return hive => {
    if (!hive || hive.metadataError) return;
    const current = new Map();
    for (const cell of Object.values(hive.cells || {})) for (const r of Object.values(cell.requests || {})) if (needsHuman(r) && (r.state !== 'answered' || ['failed', 'uncertain'].includes(r.delivery?.state))) {
      const episode = `${r.id}:${r.routeRevision}:${r.state === 'answered' ? `repair:${r.delivery?.attempts?.at(-1)?.id || r.revision}` : 'human'}`;
      current.set(episode, r);
    }
    for (const episode of shown.keys()) if (!current.has(episode)) { api.ui?.withdraw?.(`native:${episode}`); shown.delete(episode); }
    const enabled = api.settings?.()?.requestNotifications !== false;
    for (const [episode, r] of current) {
      if (!seeded || !enabled) { seen.add(episode); continue; }
      const previous = shown.get(episode);
      if (seen.has(episode) && (!previous || previous.consumed || previous.revision === r.revision)) continue;
      if (previous) api.ui?.withdraw?.(`native:${episode}`);
      const token = { revision: r.revision };
      seen.add(episode); shown.set(episode, token);
      const options = r.state === 'open' && answer && r.options?.length <= 2 ? r.options || [] : [];
      const actions = [...options.map(o => ({ id: `option:${o.id}`, label: o.label, primary: /\(Recommended\)/i.test(o.label) })), { id: 'open', label: 'View request', primary: !options.length }];
      try {
        Promise.resolve(api.ui?.notify?.({ id: `native:${episode}`, title: r.state === 'answered' ? 'Hive answer needs delivery repair' : r.title, body: r.warning || 'Hive request needs you', actions })).then(action => {
          if (shown.get(episode) !== token || token.consumed || api.settings?.()?.requestNotifications === false) return;
          token.consumed = true;
          if (action === 'open') open(hiveLink(r.cellId, r.threadId, r.messageId));
          else if (typeof action === 'string' && action.startsWith('option:') && options.some(o => o.id === action.slice(7))) answer(r, action.slice(7));
        }).catch(() => {});
      } catch { shown.delete(episode); }
    }
    if (!enabled) for (const episode of shown.keys()) { api.ui?.withdraw?.(`native:${episode}`); shown.delete(episode); }
    seeded = true;
    write([...seen].slice(-2000));
  };
}
