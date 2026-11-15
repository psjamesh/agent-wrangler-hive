import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MetadataStore } from '../server/metadata-store.js';
import { createPrLabelSweep } from '../server/pr-label-discovery.js';
import { createPrLabeler } from '../server/pr-labels.js';
import { createPrTracker } from '../server/pr-tracking.js';

const SID = '22222222-2222-4222-8222-222222222222';
const PR = 'https://github.com/example/repo/pull/42';
const OTHER = 'https://github.com/example/repo/pull/43';
function fixture() {
  const doc = { cells: { cell: { id: 'cell', taskId: 'task', rootBeadId: 'hive-root', enabled: true } }, bindings: { cell: [] }, prLabels: {} };
  const runtime = { metadata: { read: () => doc, mutate: fn => fn(doc) }, pendingParticipants: new Map() };
  const f = { doc, runtime, time: 0, links: [PR], searches: [], views: [], additions: [], labelled: new Set(), states: new Map([[PR, 'OPEN'], [OTHER, 'MERGED']]), searchResults: [], stateError: null, ids: new Map(), createdAt: '1970-01-01T00:00:00Z' };
  f.host = { version: '1.70.0', sessions: { list: () => [{ sessionId: SID }] }, tasks: { forSession: () => ({ taskId: 'task' }) }, links: { get: () => f.links.map(url => ({ type: 'pr', url, checkStatusFetchedAt: f.linkCheckedAt })) } };
  f.gh = async args => {
    if (args[0] === 'search') {
      assert.deepEqual(args, ['search', 'prs', '--repo', 'example/repo', '--label', 'hive', '--state', 'open', '--sort', 'updated', '--order', 'desc', '--limit', '100', '--json', 'url,id,createdAt']);
      f.searches.push(args);
      return JSON.stringify(f.searchResults.map(url => ({ url, id: f.ids.get(url) || `node:${url}`, createdAt: f.createdAt })));
    }
    if (args[1] === 'view') {
      f.views.push(args);
      if (args[4] === 'labels') return JSON.stringify({ labels: f.labelled.has(args[2]) ? [{ name: 'hive' }] : [] });
      assert.match(args[4], /^state,/);
      if (f.stateError) throw new Error(f.stateError);
      return JSON.stringify({ state: f.states.get(args[2]), id: f.ids.get(args[2]) || `node:${args[2]}`, createdAt: f.createdAt });
    }
    assert.deepEqual(args, ['pr', 'edit', args[2], '--add-label', 'hive']);
    f.additions.push(args[2]);
    f.labelled.add(args[2]);
    return '';
  };
  f.restart = () => {
    f.sweep = createPrLabelSweep({ runtime, host: f.host, now: () => f.time,
      labeler: createPrLabeler({ gh: f.gh, now: () => f.time }), tracker: createPrTracker({ gh: f.gh, now: () => f.time }) });
  };
  f.restart();
  return f;
}

test('first sight captures every active bead binding and preserves it after AW cleanup', async () => {
  const f = fixture();
  f.doc.bindings.cell = [{ active: true, sessionId: SID, beadId: 'hive-a' }, { active: true, sessionId: SID, beadId: 'hive-b' }, { active: false, sessionId: SID, beadId: 'hive-c' }];
  await f.sweep.run();
  assert.deepEqual(f.doc.prLabels[PR].beadIds, ['hive-a', 'hive-b']);
  assert.deepEqual(f.doc.prLabels[PR].associations, [{ cellId: 'cell', beadId: 'hive-a', kind: 'binding' }, { cellId: 'cell', beadId: 'hive-b', kind: 'binding' }]);
  f.links = [];
  f.doc.bindings.cell = [];
  f.doc.cells.cell.enabled = false;
  f.time = 60000;
  f.states.set(PR, 'MERGED');
  f.restart();
  await f.sweep.run();
  assert.equal(f.doc.prLabels[PR].state, 'MERGED');
  assert.equal(f.doc.prLabels[PR].sessionId, SID);
  assert.deepEqual(f.doc.prLabels[PR].beadIds, ['hive-a', 'hive-b']);
  assert.deepEqual(f.additions, [PR]);
});

test('a session without bead bindings has a distinguishable cell-root association', async () => {
  const f = fixture();
  await f.sweep.run();
  assert.deepEqual(f.doc.prLabels[PR].beadIds, ['hive-root']);
  assert.deepEqual(f.doc.prLabels[PR].associations, [{ cellId: 'cell', beadId: 'hive-root', kind: 'cell-root' }]);
});

for (const terminal of ['CLOSED', 'MERGED']) {
  test(`state polling stops after a final ${terminal} observation, including after restart`, async () => {
    const f = fixture();
    await f.sweep.run();
    f.links = [];
    f.time = 60000;
    f.states.set(PR, terminal);
    await f.sweep.run();
    const reads = f.views.length;
    assert.equal(f.doc.prLabels[PR].state, terminal);
    f.restart();
    f.time = 120000;
    await f.sweep.run();
    assert.equal(f.views.length, reads);
    assert.equal(f.doc.prLabels[PR].stateCheckedAt, 60000);
  });
}

test('open label discovery resumes observation of a reopened historical PR', async () => {
  const f = fixture();
  f.links = [];
  f.doc.prLabels[PR] = { url: PR, nodeId: `node:${PR}`, status: 'labelled', state: 'CLOSED', stateCheckedAt: 0 };
  await f.sweep.run();
  assert.equal(f.views.length, 0);
  f.time = 300000;
  f.searchResults = [PR];
  await f.sweep.run();
  assert.equal(f.doc.prLabels[PR].state, 'OPEN');
  assert.equal(f.doc.prLabels[PR].stateCheckedAt, 300000);
});

test('20 open and 100 historical PRs cost 20 state queries per sweep', async () => {
  const f = fixture();
  f.links = [];
  for (let number = 1; number <= 120; number++) {
    const url = `https://github.com/example/repo/pull/${number}`;
    f.doc.prLabels[url] = { url, nodeId: `node:${url}`, status: 'labelled', state: number <= 20 ? 'OPEN' : number % 2 ? 'MERGED' : 'CLOSED' };
    f.states.set(url, number <= 20 ? 'OPEN' : 'MERGED');
  }
  for (let minute = 0; minute < 60; minute++) {
    f.time = minute * 60000;
    await f.sweep.run();
  }
  assert.equal(f.views.length, 1200);
  assert.equal(f.searches.length, 12);
});

test('successful discovery is limited to once per five minutes per repository', async () => {
  const f = fixture();
  await f.sweep.run();
  for (const time of [0, 60000, 299999]) { f.time = time; await f.sweep.run(); }
  assert.equal(f.searches.length, 1);
  f.time = 300000;
  await f.sweep.run();
  assert.equal(f.searches.length, 2);
});

test('failed discovery backs off without preventing active PR observations', async () => {
  let time = 0, searches = 0;
  const tracker = createPrTracker({ now: () => time, gh: async args => {
    if (args[0] === 'search') { searches++; throw new Error('temporary search failure'); }
    return JSON.stringify({ state: 'OPEN', id: 'node:pr', createdAt: '1970-01-01T00:00:00Z' });
  } });
  await tracker.search('example/repo');
  await tracker.search('example/repo');
  assert.equal(searches, 1);
  assert.equal((await tracker.state(PR)).state, 'OPEN');
  time = 60000;
  await tracker.search('example/repo');
  time = 120000;
  await tracker.search('example/repo');
  assert.equal(searches, 2);
  time = 180000;
  await tracker.search('example/repo');
  assert.equal(searches, 3);
});

test('label search in known repositories records unknown PRs as unassigned without writing labels', async () => {
  const f = fixture();
  f.searchResults = [PR, OTHER, 'https://github.com/unrelated/repo/pull/99'];
  f.labelled.add(OTHER);
  await f.sweep.run();
  const record = f.doc.prLabels[OTHER];
  assert.equal(record.source, 'label-search');
  assert.equal(record.sessionId, null);
  assert.deepEqual(record.cellIds, []);
  assert.deepEqual(record.beadIds, []);
  assert.equal(record.state, 'MERGED');
  assert.equal(record.status, 'labelled');
  assert.deepEqual(f.additions, [PR]);
  assert.equal(Object.keys(f.doc.prLabels).length, 2);
  f.links = [];
  f.restart();
  await f.sweep.run();
  assert.deepEqual(f.additions, [PR]);
  assert.equal(f.doc.prLabels[PR].sessionId, SID);
});

test('later AW evidence assigns an unassigned search record without relabelling it', async () => {
  const f = fixture();
  f.searchResults = [OTHER];
  f.labelled.add(OTHER);
  await f.sweep.run();
  f.time = 60000;
  f.links = [OTHER];
  f.doc.bindings.cell = [{ active: true, sessionId: SID, beadId: 'hive-new' }];
  await f.sweep.run();
  assert.equal(f.doc.prLabels[OTHER].sessionId, SID);
  assert.deepEqual(f.doc.prLabels[OTHER].beadIds, ['hive-new']);
  assert.equal(f.doc.prLabels[OTHER].firstSeenAt, 0);
  assert.equal(f.doc.prLabels[OTHER].enrolledAt, 60000);
  assert.deepEqual(f.additions, [PR]);
});

test('a failed state read preserves the last confirmed state and retries with backoff', async () => {
  const f = fixture();
  await f.sweep.run();
  f.links = [];
  f.stateError = 'HTTP 403 permission denied';
  f.time = 60000;
  await f.sweep.run();
  assert.equal(f.doc.prLabels[PR].state, 'OPEN');
  assert.equal(f.doc.prLabels[PR].stateCheckedAt, 0);
  const reads = f.views.length;
  await f.sweep.run();
  assert.equal(f.views.length, reads);
  f.time = 120000;
  f.stateError = null;
  f.states.set(PR, 'CLOSED');
  await f.sweep.run();
  assert.equal(f.doc.prLabels[PR].state, 'CLOSED');
});

test('an empty ledger or old host never starts a global label search', async () => {
  const f = fixture();
  f.links = [];
  await f.sweep.run();
  assert.deepEqual(f.searches, []);
  f.links = [PR];
  f.host.version = '1.69.0';
  await f.sweep.run();
  assert.deepEqual(f.searches, []);
  assert.deepEqual(f.views, []);
});

test('a repository permission failure does not fan out to every recorded PR', async () => {
  const f = fixture();
  f.links = [];
  for (let number = 1; number <= 100; number++) {
    const url = `https://github.com/example/repo/pull/${number}`;
    f.doc.prLabels[url] = { url, status: 'labelled', sessionId: null, cellIds: [], beadIds: [] };
  }
  f.stateError = 'HTTP 403 Resource not accessible by integration';
  await f.sweep.run();
  assert.equal(f.views.length, 1);
});

test('bead and state records survive a real metadata reload after link removal', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hive-tracking-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'metadata.json');
  const f = fixture();
  f.doc.bindings.cell = [{ active: true, sessionId: SID, beadId: 'hive-owned' }];
  f.runtime.metadata = new MetadataStore({ file });
  f.runtime.metadata.mutate(doc => Object.assign(doc, structuredClone(f.doc)));
  await f.sweep.run();
  f.links = [];
  f.runtime.metadata.mutate(doc => { doc.cells.cell.enabled = false; doc.bindings.cell = []; });
  f.runtime.metadata = new MetadataStore({ file });
  f.time = 60000;
  f.states.set(PR, 'CLOSED');
  f.restart();
  await f.sweep.run();
  const reopened = new MetadataStore({ file });
  assert.equal(reopened.read().prLabels[PR].state, 'CLOSED');
  assert.deepEqual(reopened.read().prLabels[PR].beadIds, ['hive-owned']);
  assert.equal(reopened.read().prLabels[PR].sessionId, SID);
  assert.deepEqual(f.additions, [PR]);
});

for (const stage of ['search', 'state', 'edit', 'buffered-state']) {
  test(`a stopped ${stage} completion preserves replacement runtime metadata`, { timeout: 5000 }, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hive-pr-lifecycle-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const file = path.join(root, 'metadata.json');
    const oldStore = new MetadataStore({ file });
    oldStore.mutate(doc => {
      doc.prLabels[PR] = { url: PR, firstSeenAt: Date.now(), source: 'session-link', status: stage === 'edit' ? 'pending' : 'labelled' };
      if (stage === 'buffered-state') doc.prLabels[OTHER] = { url: OTHER, source: 'session-link', status: 'labelled' };
    });
    let enter, release;
    const entered = new Promise(resolve => { enter = resolve; });
    const blocked = new Promise(resolve => { release = resolve; });
    t.after(() => release());
    const labelled = new Set();
    const additions = [];
    const gh = async args => {
      const suspend = stage === 'search' ? args[0] === 'search'
        : stage === 'edit' ? args[1] === 'edit'
          : args[4]?.startsWith('state,') && args[2] === (stage === 'buffered-state' ? OTHER : PR);
      if (suspend) { enter(); await blocked; }
      if (args[0] === 'search') return JSON.stringify(stage === 'search' ? [{ url: OTHER }] : []);
      if (args[4]?.startsWith('state,')) {
        if (stage === 'buffered-state' && args[2] === OTHER) throw new Error('state unavailable');
        return JSON.stringify({ state: 'OPEN', id: 'node:pr', createdAt: '1970-01-01T00:00:00Z' });
      }
      if (args[4] === 'labels') return JSON.stringify({ labels: labelled.has(args[2]) ? [{ name: 'hive' }] : [] });
      assert.deepEqual(args, ['pr', 'edit', args[2], '--add-label', 'hive']);
      labelled.add(args[2]);
      additions.push(args[2]);
      return '';
    };
    const host = { version: '1.70.0', sessions: { list: () => [] }, links: { get: () => [] } };
    const makeSweep = metadata => createPrLabelSweep({ runtime: { metadata }, host,
      labeler: createPrLabeler({ gh }), tracker: createPrTracker({ gh }) });
    const oldSweep = makeSweep(oldStore);
    const pending = oldSweep.run();
    await entered;
    const oldVersion = oldStore.version;
    oldSweep.stop();
    const replacement = new MetadataStore({ file });
    const newPr = 'https://github.com/example/repo/pull/44';
    replacement.mutate(doc => {
      doc.prLabels[newPr] = { url: newPr, source: 'session-link', status: 'pending' };
      doc.cells.replacement = { id: 'replacement', rootBeadId: 'hive-replacement' };
    });
    const expected = structuredClone(replacement.read());
    release();
    await pending;
    assert.equal(oldStore.version, oldVersion, 'stopped sweeps must not mutate even their in-memory store');
    assert.deepEqual(new MetadataStore({ file }).read(), expected);
    if (stage === 'edit') {
      assert.equal(expected.prLabels[PR].status, 'pending');
      await makeSweep(replacement).run();
      assert.equal(new MetadataStore({ file }).read().prLabels[PR].status, 'labelled');
      assert.equal(additions.filter(url => url === PR).length, 1, 'replacement confirms the remotely completed edit without another add');
    }
  });
}

test('legacy terminal URLs get one identity observation before terminal polling stops', async () => {
  const f = fixture();
  f.links = [];
  f.doc.prLabels[PR] = { url: PR, source: 'session-link', status: 'labelled', state: 'MERGED', firstSeenAt: 0, beadIds: ['old'] };
  f.states.set(PR, 'MERGED');
  await f.sweep.run();
  assert.equal(f.views.length, 1);
  assert.equal(f.doc.prLabels[PR].nodeId, `node:${PR}`);
  f.restart();
  await f.sweep.run();
  assert.equal(f.views.length, 1);
});

for (const existing of [
  { state: 'MERGED', nodeId: 'old-node', createdAt: '1970-01-01T00:00:00Z' },
  { state: 'MERGED' },
  { state: 'OPEN', nodeId: 'old-node', createdAt: '1970-01-01T00:00:00Z' },
]) {
  test(`reused URL replaces stale ${existing.state} attribution (${existing.nodeId || 'legacy'})`, async () => {
    const f = fixture();
    f.time = 100000;
    f.createdAt = '1970-01-01T00:01:00Z';
    f.ids.set(PR, 'new-node');
    f.doc.bindings.cell = [{ active: true, sessionId: SID, beadId: 'new-bead' }];
    f.doc.prLabels[PR] = { url: PR, source: 'session-link', sessionId: 'old-session', cellIds: ['old-cell'], associations: [{ cellId: 'old-cell', beadId: 'old-bead' }], beadIds: ['old-bead'], firstSeenAt: 0, status: 'labelled', humanAttention: { headSha: 'old' }, ...existing };
    await f.sweep.run();
    const saved = f.doc.prLabels[PR];
    assert.equal(saved.nodeId, 'new-node');
    assert.equal(saved.state, 'OPEN');
    assert.equal(saved.sessionId, SID);
    assert.deepEqual(saved.beadIds, ['new-bead']);
    assert.equal(saved.firstSeenAt, 100000);
    assert.equal(saved.humanAttention, null);
    assert.deepEqual(f.additions, [PR], 'new PR receives its own label attribution');
  });
}

test('open discovery detects a reused terminal URL even without a current link', async () => {
  const f = fixture();
  f.links = [];
  f.searchResults = [PR];
  f.doc.prLabels[PR] = { url: PR, source: 'session-link', sessionId: 'old-session', beadIds: ['old-bead'], status: 'labelled', state: 'MERGED', nodeId: 'old-node' };
  await f.sweep.run();
  const saved = f.doc.prLabels[PR];
  assert.equal(saved.nodeId, `node:${PR}`);
  assert.equal(saved.source, 'label-search');
  assert.equal(saved.sessionId, null);
  assert.deepEqual(saved.beadIds, []);
});

test('failed identity migration cannot confirm stale terminal identity', async () => {
  const f = fixture();
  f.links = [];
  f.doc.prLabels[PR] = { url: PR, status: 'labelled', state: 'MERGED' };
  f.stateError = 'temporary outage';
  await f.sweep.run();
  assert.ok(f.doc.prLabels[PR].observationError);
  assert.equal(f.doc.prLabels[PR].nodeId, undefined);
  f.time = 60000;
  f.stateError = null;
  await f.sweep.run();
  assert.equal(f.doc.prLabels[PR].state, 'OPEN');
});

test('a newer core OPEN link observation rechecks an unlabelled reopened PR', async () => {
  const f = fixture();
  f.states.set(PR, 'CLOSED');
  await f.sweep.run();
  const reads = f.views.length;
  f.time = 60000;
  f.states.set(PR, 'OPEN');
  f.linkCheckedAt = new Date(60000).toISOString();
  await f.sweep.run();
  assert.equal(f.doc.prLabels[PR].state, 'OPEN');
  assert.equal(f.views.length, reads + 1);
});

test('failed rediscovery leaves terminal state confirmed instead of exposing stale OPEN checks', async () => {
  const f = fixture();
  f.links = [];
  f.doc.prLabels[PR] = { url: PR, nodeId: `node:${PR}`, firstSeenAt: 0, status: 'labelled', state: 'CLOSED', headSha: 'old-head', checks: 'green' };
  f.searchResults = [PR];
  f.stateError = 'offline';
  await f.sweep.run();
  assert.equal(f.doc.prLabels[PR].state, 'CLOSED');
  assert.ok(f.doc.prLabels[PR].observationError);
});

test('an unlinked identity replacement remains unlabelled and is attributed on a later session link', async () => {
  const f = fixture();
  f.links = [];
  f.doc.prLabels[PR] = { url: PR, nodeId: 'old-node', source: 'session-link', sessionId: 'old', beadIds: ['old'], state: 'OPEN', status: 'labelled' };
  await f.sweep.run();
  assert.equal(f.doc.prLabels[PR].status, 'unlabelled');
  assert.equal(f.doc.prLabels[PR].labelledAt, null);
  f.links = [PR];
  await f.sweep.run();
  assert.equal(f.doc.prLabels[PR].status, 'labelled');
  assert.equal(f.doc.prLabels[PR].sessionId, SID);
  assert.deepEqual(f.additions, [PR]);
});

for (const terminal of ['MERGED', 'CLOSED']) {
  test(`${terminal} pending labels get only one final attempt across restarts`, async () => {
    const f = fixture();
    f.states.set(PR, terminal);
    let attempts = 0;
    const start = () => { f.sweep = createPrLabelSweep({ runtime: f.runtime, host: f.host, now: () => f.time,
      tracker: createPrTracker({ gh: f.gh, now: () => f.time }), labeler: { stop() {}, async apply() { attempts++; } } }); };
    start();
    await f.sweep.run();
    assert.equal(f.doc.prLabels[PR].status, 'unlabelled');
    assert.equal(f.doc.prLabels[PR].terminalLabelAttempted, true);
    f.links = [];
    for (let minute = 1; minute < 60; minute++) { f.time = minute * 60000; start(); await f.sweep.run(); }
    assert.equal(attempts, 1);
    f.states.set(PR, 'OPEN');
    f.searchResults = [PR];
    f.time = 3600000;
    start(); await f.sweep.run();
    assert.equal(attempts, 2, 'reopening resets attribution eligibility');
  });
}

test('repo label configuration failure is persisted and gates every pending PR until retry', async () => {
  const f = fixture();
  f.links = [PR, OTHER];
  f.states.set(OTHER, 'OPEN');
  let edits = 0;
  const gh = f.gh;
  f.gh = async args => {
    if (args[1] === 'edit') { edits++; throw new Error('HTTP 403 write access denied'); }
    return gh(args);
  };
  f.restart();
  await f.sweep.run();
  assert.equal(edits, 1);
  assert.match(f.doc.prLabelRepos['example/repo'].message, /403/);
  f.time = 60000;
  f.restart();
  await f.sweep.run();
  assert.equal(edits, 1, 'restart cannot fan out repository failures');
  f.time = 900000;
  await f.sweep.run();
  assert.equal(edits, 2);
});

test('global label backoff defers terminal records without spending their final attempt', async () => {
  const f = fixture();
  f.links = [PR, OTHER];
  f.states.set(PR, 'MERGED'); f.states.set(OTHER, 'MERGED');
  const gh = f.gh;
  let labelReads = 0;
  f.gh = async args => {
    if (args[4] === 'labels' && ++labelReads === 1) throw new Error('HTTP 429 rate limit');
    return gh(args);
  };
  f.restart();
  await f.sweep.run();
  assert.equal(f.doc.prLabels[PR].status, 'unlabelled', 'the attempted failure spends its budget');
  assert.equal(labelReads, 1);
  assert.equal(f.doc.prLabels[OTHER].status, 'pending', 'a deferred PR keeps its budget');
  assert.equal(f.doc.prLabels[OTHER].terminalLabelAttempted, false);
  f.time = 60000;
  await f.sweep.run();
  assert.equal(labelReads, 2);
  assert.equal(f.doc.prLabels[OTHER].status, 'labelled');
});
