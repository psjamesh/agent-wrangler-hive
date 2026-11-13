import test from 'node:test';
import assert from 'node:assert/strict';
import { HIVE_VIEW, hiveLink, parseHiveLink, installHiveLinks, revealMessage, syncHiveSelection } from './deep-links.js';

test('topic and message links round trip through the registered Hive overview', () => {
  assert.equal(hiveLink('cell_one', 'thr_two', 'msg_three'), `${HIVE_VIEW}&cell=cell_one&topic=thr_two&message=msg_three`);
  assert.deepEqual(parseHiveLink(hiveLink('cell_one', 'thr_two')), { cellId: 'cell_one', threadId: 'thr_two', messageId: null });
  assert.deepEqual(parseHiveLink(`${HIVE_VIEW}&cell=%3Cbad%3E&topic=%E0%A4%A`), { cellId: null, threadId: null, messageId: null });
  for (const hash of ['', '#view=search', HIVE_VIEW, '#view=ext:hive:overview-other']) assert.equal(parseHiveLink(hash), null);
});

function browser(hash, { followup = true, popstate = true } = {}) {
  const listeners = [], queue = [];
  const win = {
    location: { hash, replace(hash) { win.queue(hash, followup); } },
    history: { replaceState(_s, _t, hash) { win.location.hash = hash; } },
    addEventListener(type, fn, capture) { listeners.push({ type, fn, capture }); },
    removeEventListener(type, fn) { listeners.splice(listeners.findIndex(x => x.type === type && x.fn === fn), 1); },
    queue(hash, enqueue = true) {
      const oldURL = `https://board.test/${win.location.hash}`;
      win.location.hash = hash;
      if (popstate) for (const x of [...listeners].filter(x => x.type === 'popstate')) x.fn({});
      if (enqueue) queue.push({ oldURL, newURL: `https://board.test/${hash}`, stopped: false, stopImmediatePropagation() { this.stopped = true; } });
    },
    step() {
      if (!queue.length) return false;
      const event = queue.shift();
      for (const x of [...listeners].filter(x => x.type === 'hashchange')) x.fn(event);
      return true;
    },
    flush() {
      while (queue.length) {
        const event = queue.shift();
        for (const x of [...listeners].filter(x => x.type === 'hashchange')) {
          x.fn(event);
          if (event.stopped) break;
        }
      }
    },
    paste(hash) { win.queue(hash); win.flush(); },
  };
  return win;
}

test('cold load normalizes before host registration and restores a reloadable target', () => {
  const link = hiveLink('cell_one', 'thr_two', 'msg_three');
  const win = browser(link), targets = [];
  const bridge = installHiveLinks(win, target => targets.push(target));
  assert.equal(win.location.hash, HIVE_VIEW);
  assert.equal(targets[0].messageId, 'msg_three');
  bridge.restore();
  assert.equal(win.location.hash, link);
  installHiveLinks(win, target => targets.push(target));
  assert.equal(targets.length, 2);
});

test('pasting from outside Hive reaches the host through its exact registered view', () => {
  const win = browser('#view=search'), targets = [], host = [];
  win.addEventListener('hashchange', () => host.push(win.location.hash === HIVE_VIEW ? 'hive' : 'grid'));
  const bridge = installHiveLinks(win, target => targets.push(target));
  const link = hiveLink('cell_one', 'thr_two');
  win.paste(link);
  assert.equal(host.at(-1), 'hive');
  assert.equal(targets[0].threadId, 'thr_two');
  bridge.restore();
  assert.equal(win.location.hash, link);
  win.paste('#view=search');
  bridge.restore();
  assert.equal(win.location.hash, '#view=search');
  bridge.dispose();
});

test('message reveal waits for the visible panel and scrolls the exact target into its centre', () => {
  const calls = [];
  const item = { dataset: { id: 'msg_target' }, getBoundingClientRect: () => ({ width: 300 }), scrollIntoView: options => calls.push(options) };
  const root = { clientWidth: 0, querySelectorAll: () => [item] };
  assert.equal(revealMessage(root, 'msg_target'), false);
  root.clientWidth = 800;
  assert.equal(revealMessage(root, 'msg_missing'), false);
  assert.equal(revealMessage(root, 'msg_target'), true);
  assert.deepEqual(calls, [{ block: 'center', behavior: 'instant' }]);
});

test('a pending resolution cannot restore its hash over a later outside navigation', () => {
  const win = browser(hiveLink('cell_one', 'thr_two'));
  const bridge = installHiveLinks(win, () => {});
  win.paste('#view=search');
  bridge.restore();
  assert.equal(win.location.hash, '#view=search');
});

test('leaving and returning to plain Hive invalidates a pending hash restoration', () => {
  const win = browser(hiveLink('cell_old', 'thr_old', 'msg_old'));
  let cancelled = 0;
  const bridge = installHiveLinks(win, () => {}, () => cancelled++);
  win.paste('#view=search');
  win.paste(HIVE_VIEW);
  bridge.restore();
  assert.equal(win.location.hash, HIVE_VIEW);
  assert.equal(cancelled, 2);
});

test('selection URLs preserve topic, bead and tab without adding history entries or routing again', () => {
  const win = browser(HIVE_VIEW);
  let routes = 0;
  win.addEventListener('hashchange', () => routes++);
  win.history.pushState = () => assert.fail('selection must not push history');
  syncHiveSelection(win, { cellId: 'cell_one', threadId: 'thr_one', beadId: 'hive-one', pane: 'details' });
  assert.deepEqual(parseHiveLink(win.location.hash), { cellId: 'cell_one', threadId: 'thr_one', messageId: null, beadId: 'hive-one', pane: 'details' });
  syncHiveSelection(win, { cellId: 'cell_one', threadId: 'thr_two', pane: 'conversation' });
  assert.equal(parseHiveLink(win.location.hash).threadId, 'thr_two');
  assert.equal(routes, 0);
  syncHiveSelection(win, { cellId: null, threadId: 'thr_two', beadId: 'hive-one', pane: 'details' });
  assert.equal(win.location.hash, HIVE_VIEW);
  win.paste('#view=search');
  syncHiveSelection(win, { cellId: 'cell_one' });
  assert.equal(win.location.hash, '#view=search');
});

test('queued hashchanges route only the latest link and keep its delayed resolution current', () => {
  const win = browser('#view=search'), targets = [], host = [];
  win.addEventListener('hashchange', () => {
    host.push(win.location.hash === HIVE_VIEW ? 'hive' : 'grid');
    if (win.location.hash !== HIVE_VIEW) win.history.replaceState(null, '', '');
  });
  let request = null;
  const bridge = installHiveLinks(win, target => { targets.push(target); request = target; }, () => { request = null; });
  win.queue(hiveLink('cell_one', 'thr_one', 'msg_one'));
  const newest = hiveLink('cell_one', 'thr_one', 'msg_two');
  win.queue(newest);
  win.flush();
  assert.equal(targets.length, 1);
  assert.equal(request.messageId, 'msg_two');
  assert.equal(host.at(-1), 'hive');
  assert.equal(bridge.isCurrent(), true);
  bridge.restore();
  assert.equal(win.location.hash, newest);
});

test('queued leave and return still cancel a pending response', () => {
  const win = browser(hiveLink('cell_one', 'thr_one', 'msg_one'));
  let request = true;
  const bridge = installHiveLinks(win, () => { request = true; }, () => { request = false; });
  win.queue('#view=search');
  win.queue(HIVE_VIEW);
  win.flush();
  assert.equal(request, false);
  assert.equal(bridge.isCurrent(), false);
  bridge.restore();
  assert.equal(win.location.hash, HIVE_VIEW);
});

test('stale queued hashchanges preserve a newer replaceState selection URL', () => {
  const win = browser(HIVE_VIEW);
  let requests = 0;
  const bridge = installHiveLinks(win, () => requests++);
  win.queue(hiveLink('cell_old', 'thr_old', 'msg_old'));
  bridge.cancel();
  syncHiveSelection(win, { cellId: 'cell_new', threadId: 'thr_new', beadId: 'hive-new', pane: 'details' });
  const selected = win.location.hash;
  win.flush();
  assert.equal(requests, 0);
  assert.equal(win.location.hash, selected);
  bridge.restore();
  assert.equal(win.location.hash, selected);
});

test('an unavailable-cell fallback keeps the registered overview hash instead of restoring the broken target', () => {
  const win = browser(hiveLink('cell_unavailable', 'thr_old', 'msg_old'));
  const bridge = installHiveLinks(win, () => {});
  bridge.restore(HIVE_VIEW);
  assert.equal(win.location.hash, HIVE_VIEW);
});

test('a host-first listener may erase the target hash without losing in-page Hive navigation', () => {
  const win = browser(HIVE_VIEW), views = [], targets = [];
  win.addEventListener('hashchange', () => {
    const view = win.location.hash === HIVE_VIEW ? 'hive' : 'grid';
    views.push(view);
    if (view === 'grid') win.history.replaceState(null, '', '');
  });
  const bridge = installHiveLinks(win, target => targets.push(target));
  const link = hiveLink('cell_one', 'thr_one');
  win.paste(link);
  assert.equal(views.at(-1), 'hive');
  assert.equal(targets.at(-1)?.threadId, 'thr_one');
  assert.equal(bridge.isCurrent(), true);
  bridge.restore();
  assert.equal(win.location.hash, link);
});

for (const midRepair of [false, true]) {
  test(`host-first queued targets are invalidated by cancellation ${midRepair ? 'during repair' : 'before delivery'}`, () => {
    const win = browser(HIVE_VIEW), targets = [];
    win.addEventListener('hashchange', () => {
      if (win.location.hash !== HIVE_VIEW) win.history.replaceState(null, '', '');
    });
    const bridge = installHiveLinks(win, target => targets.push(target));
    win.queue(hiveLink('cell_a', 'thr_a', 'msg_a'));
    win.queue(hiveLink('cell_b', 'thr_b', 'msg_b'));
    if (midRepair) win.step();
    bridge.cancel();
    syncHiveSelection(win, { cellId: 'cell_c', threadId: 'thr_c', beadId: 'hive-c', pane: 'details' });
    win.flush();
    bridge.restore();
    assert.deepEqual(targets, []);
    assert.equal(win.location.hash, hiveLink('cell_c', 'thr_c', null, { beadId: 'hive-c', pane: 'details' }));
    bridge.dispose();
  });
}

test('a missing repair event clears within a bounded time and does not block a later link', async () => {
  const win = browser(HIVE_VIEW, { followup: false }), targets = [];
  win.addEventListener('hashchange', () => {
    if (win.location.hash !== HIVE_VIEW) win.history.replaceState(null, '', '');
  });
  const bridge = installHiveLinks(win, target => targets.push(target));
  win.paste(hiveLink('cell_a', 'thr_a'));
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(bridge.isCurrent(), false);
  win.location.replace = hash => win.queue(hash);
  win.paste(hiveLink('cell_b', 'thr_b'));
  assert.equal(targets.at(-1)?.threadId, 'thr_b');
  bridge.restore();
  assert.equal(win.location.hash, hiveLink('cell_b', 'thr_b'));
  bridge.dispose();
});

for (const midRepair of [false, true]) {
  test(`untracked queued events cannot revive a cancelled generation ${midRepair ? 'during repair' : 'before delivery'}`, () => {
    const win = browser(HIVE_VIEW, { popstate: false }), targets = [];
    win.addEventListener('hashchange', () => {
      if (win.location.hash !== HIVE_VIEW) win.history.replaceState(null, '', '');
    });
    const bridge = installHiveLinks(win, target => targets.push(target));
    win.queue(hiveLink('cell_a', 'thr_a'));
    win.queue(hiveLink('cell_b', 'thr_b'));
    if (midRepair) win.step();
    bridge.cancel();
    syncHiveSelection(win, { cellId: 'cell_c', threadId: 'thr_c' });
    win.flush();
    bridge.restore();
    assert.deepEqual(targets, []);
    assert.equal(win.location.hash, hiveLink('cell_c', 'thr_c'));
    bridge.dispose();
  });
}

test('cancellation clears a missing repair immediately and accepts a fresh navigation in the same task', () => {
  const win = browser(HIVE_VIEW, { followup: false }), targets = [];
  win.addEventListener('hashchange', () => {
    if (win.location.hash !== HIVE_VIEW) win.history.replaceState(null, '', '');
  });
  const bridge = installHiveLinks(win, target => targets.push(target));
  win.paste(hiveLink('cell_a', 'thr_a'));
  bridge.cancel();
  win.location.replace = hash => win.queue(hash);
  win.paste(hiveLink('cell_b', 'thr_b'));
  assert.equal(targets.at(-1)?.threadId, 'thr_b');
  bridge.restore();
  assert.equal(win.location.hash, hiveLink('cell_b', 'thr_b'));
  bridge.dispose();
});

test('outside navigation invalidates a pending reply before queued hashchange delivery', () => {
  const win = browser(hiveLink('cell_a', 'thr_a'));
  const bridge = installHiveLinks(win, () => {});
  win.queue('#view=search');
  win.queue(HIVE_VIEW);
  assert.equal(bridge.isCurrent(), false);
  bridge.restore();
  assert.equal(win.location.hash, HIVE_VIEW);
  win.flush();
  assert.equal(bridge.isCurrent(), false);
  bridge.dispose();
});

test('a later popstate to the overview cancels a pending resolution after repair', () => {
  const win = browser(HIVE_VIEW), targets = [];
  const bridge = installHiveLinks(win, target => targets.push(target));
  win.paste(hiveLink('cell_a', 'thr_a'));
  assert.equal(bridge.isCurrent(), true);
  win.queue(HIVE_VIEW);
  assert.equal(bridge.isCurrent(), false);
  bridge.restore();
  assert.equal(win.location.hash, HIVE_VIEW);
  bridge.dispose();
});

test('a user popstate to the overview during repair invalidates the repairing target', () => {
  const win = browser(HIVE_VIEW), targets = [];
  const bridge = installHiveLinks(win, target => targets.push(target));
  win.queue(hiveLink('cell_a', 'thr_a'));
  win.step();
  win.queue(HIVE_VIEW);
  win.flush();
  bridge.restore();
  assert.deepEqual(targets, []);
  assert.equal(win.location.hash, HIVE_VIEW);
  bridge.dispose();
});
