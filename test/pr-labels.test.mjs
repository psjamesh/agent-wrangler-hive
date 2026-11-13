import assert from 'node:assert/strict';
import test from 'node:test';
import { createPrLabeler } from '../server/pr-labels.js';
import { createPrLabelSweep } from '../server/pr-label-discovery.js';

const PR = 'https://github.com/example/repo/pull/42';
const WORKER = '22222222-2222-4222-8222-222222222222';
const OUTSIDE = '33333333-3333-4333-8333-333333333333';
const QUEEN = '11111111-1111-4111-8111-111111111111';
const COORDINATOR = '44444444-4444-4444-8444-444444444444';

function fixture({ sid = WORKER, version = '1.70.0', labelled = false, labelExists = true } = {}) {
  const cell = { id: 'cell', taskId: 'task', enabled: true, queenSessionId: QUEEN };
  const doc = { cells: { cell }, bindings: { cell: [{ sessionId: COORDINATOR, role: 'coordinator', active: true }] }, prLabels: {} };
  const runtime = { metadata: { read: () => doc, mutate: fn => fn(doc) }, pendingParticipants: new Map() };
  const host = {
    version,
    sessions: { list: () => [{ sessionId: sid }] },
    tasks: { forSession: (id) => ({ taskId: id === WORKER ? 'task' : 'elsewhere' }) },
    links: { get: () => [{ type: 'pr', url: PR }] },
  };
  const f = { cell, doc, runtime, host, calls: [], labels: labelled ? [{ name: 'hive' }] : [], labelExists,
    state: 'OPEN', time: 0, body: 'Description\n\nModel: exact\n\nMade with Agent Wrangler', failure: null };
  f.gh = async (args, input) => {
    assert.equal(input, undefined);
    f.calls.push(args);
    if (f.failure) throw new Error(f.failure);
    if (args[0] === 'label') {
      assert.deepEqual(args, ['label', 'create', 'hive', '--repo', 'example/repo', '--description', 'Made with Hive', '--color', 'E0A82E']);
      f.labelExists = true;
      await f.afterCreate?.();
      return '';
    }
    if (args[1] === 'view') {
      assert.deepEqual(args, ['pr', 'view', args[2], '--json', 'labels']);
      const snapshot = JSON.stringify({ state: f.state, labels: f.labels });
      await f.afterView?.();
      return snapshot;
    }
    assert.deepEqual(args, ['pr', 'edit', args[2], '--add-label', 'hive']);
    if (!f.labelExists) throw new Error("could not add label: 'hive' not found");
    f.labels = [...f.labels, { name: 'hive' }];
    return '';
  };
  f.labeler = createPrLabeler({ gh: (...args) => f.gh(...args), now: () => f.time });
  f.sweep = createPrLabelSweep({ runtime, host, labeler: f.labeler, tracker: { search: async () => [], state: async () => null, stop() {} }, now: () => f.time });
  return f;
}

const edits = f => f.calls.filter(args => args[0] === 'pr' && args[1] === 'edit');
const creates = f => f.calls.filter(args => args[0] === 'label');

test('an unlabelled open Hive PR gets the label without touching its body or footer', async () => {
  const f = fixture();
  const body = f.body;
  await f.sweep.run();
  assert.deepEqual(f.labels, [{ name: 'hive' }]);
  assert.equal(f.body, body);
  assert.equal(edits(f).length, 1);
});

test('an already labelled PR is read without another edit', async () => {
  const f = fixture({ labelled: true });
  await f.sweep.run();
  assert.equal(edits(f).length, 0);
  assert.equal(creates(f).length, 0);
  assert.equal(f.calls.length, 1);
});

test('a missing repository label is created once and the additive edit is retried', async () => {
  const f = fixture({ labelExists: false });
  await f.sweep.run();
  assert.deepEqual(f.labels, [{ name: 'hive' }]);
  assert.equal(creates(f).length, 1);
  assert.equal(edits(f).length, 2);
  await f.sweep.run();
  assert.equal(creates(f).length, 1);
  assert.equal(edits(f).length, 2);
});

test('a permission failure is silent and deferred with backoff', async () => {
  const f = fixture();
  f.failure = 'HTTP 403 Resource not accessible by integration';
  await assert.doesNotReject(f.sweep.run());
  assert.equal(f.calls.length, 1);
  f.failure = null;
  await f.sweep.run();
  assert.equal(f.calls.length, 1);
  f.time = 60000;
  await f.sweep.run();
  assert.deepEqual(f.labels, [{ name: 'hive' }]);
});

test('a session outside every Hive cell causes no gh operations', async () => {
  const f = fixture({ sid: OUTSIDE });
  await f.sweep.run();
  assert.deepEqual(f.calls, []);
});

for (const sid of [QUEEN, COORDINATOR, WORKER]) {
  test(`Hive participation for ${sid[0]} is discovered across roles`, async () => {
    const f = fixture({ sid });
    await f.sweep.run();
    assert.equal(edits(f).length, 1);
  });
}

for (const version of ['1.69.0', undefined]) {
  test(`a host without links:read is a quiet no-op (${version})`, async () => {
    const f = fixture();
    f.host.version = version;
    let reads = 0;
    f.host.links.get = () => { reads++; return []; };
    await assert.doesNotReject(f.sweep.run());
    assert.deepEqual(f.calls, []);
    assert.equal(reads, 0);
  });
}

test('a host without the links getter is a quiet no-op', async () => {
  const f = fixture();
  delete f.host.links;
  await assert.doesNotReject(f.sweep.run());
  assert.deepEqual(f.calls, []);
});

for (const state of ['MERGED', 'CLOSED']) {
  test(`${state} PRs seen in Hive retain their attribution eligibility`, async () => {
    const f = fixture();
    f.state = state;
    await f.sweep.run();
    assert.equal(edits(f).length, 1);
    assert.equal(creates(f).length, 0);
  });
}

for (const revoke of ['cell', 'binding', 'link']) {
  test(`removing ${revoke} after first sight preserves recorded eligibility`, async () => {
    const f = fixture({ sid: COORDINATOR });
    f.afterView = () => {
      if (revoke === 'cell') f.cell.enabled = false;
      if (revoke === 'binding') f.doc.bindings.cell[0].active = false;
      if (revoke === 'link') f.host.links.get = () => [];
    };
    await f.sweep.run();
    assert.equal(edits(f).length, 1);
  });
}

test('shared links are deduplicated before gh is called', async () => {
  const f = fixture({ labelled: true });
  f.host.sessions.list = () => Array.from({ length: 100 }, () => ({ sessionId: WORKER }));
  await f.sweep.run();
  assert.equal(f.calls.length, 1);
});

test('stopping a sweep while a read is pending prevents edits', async () => {
  const f = fixture();
  let release;
  f.afterView = () => new Promise(resolve => { release = resolve; });
  const pending = f.sweep.run();
  await new Promise(setImmediate);
  f.sweep.stop();
  release();
  await pending;
  assert.equal(edits(f).length, 0);
});

test('a label creation permission failure backs off the whole repo and retries after one minute', async () => {
  const f = fixture({ labelExists: false });
  f.host.links.get = () => [PR, PR.replace('/42', '/43')].map(url => ({ type: 'pr', url }));
  const gh = f.gh;
  let denyCreate = true;
  f.gh = async (args, input) => {
    if (args[0] === 'label' && denyCreate) { f.calls.push(args); throw new Error('HTTP 403 label creation permission denied'); }
    return gh(args, input);
  };
  await f.sweep.run();
  assert.equal(f.calls.length, 3);
  assert.equal(creates(f).length, 1);
  await f.sweep.run();
  assert.equal(f.calls.length, 3);
  denyCreate = false;
  f.time = 60000;
  await f.sweep.run();
  assert.deepEqual(f.labels, [{ name: 'hive' }]);
  assert.equal(creates(f).length, 2);
});

test('a concurrently created repository label is reused without changing its metadata', async () => {
  const f = fixture({ labelExists: false });
  const gh = f.gh;
  f.gh = async (args, input) => {
    if (args[0] === 'label') { f.calls.push(args); f.labelExists = true; throw new Error('label with name "hive" already exists'); }
    return gh(args, input);
  };
  await f.sweep.run();
  assert.deepEqual(f.labels, [{ name: 'hive' }]);
  assert.equal(creates(f).length, 1);
  assert.equal(edits(f).length, 2);
});

test('a PR merged during label creation remains eligible on the retry', async () => {
  const f = fixture({ labelExists: false });
  f.afterCreate = () => { f.state = 'MERGED'; };
  await f.sweep.run();
  assert.equal(edits(f).length, 2);
  assert.deepEqual(f.labels, [{ name: 'hive' }]);
});

test('recorded eligibility survives revoked Hive participation during label creation', async () => {
  const f = fixture({ labelExists: false });
  f.afterCreate = () => { f.cell.enabled = false; };
  await f.sweep.run();
  assert.equal(edits(f).length, 2);
  assert.deepEqual(f.labels, [{ name: 'hive' }]);
});

test('concurrent body edits remain untouched by label attribution', async () => {
  const f = fixture();
  f.afterView = () => { f.body += '\n\nHuman release note'; };
  await f.sweep.run();
  assert.ok(f.body.endsWith('Human release note'));
  assert.ok(f.body.includes('Made with Agent Wrangler'));
  assert.deepEqual(f.labels, [{ name: 'hive' }]);
});

test('the label applier can be used independently of session link discovery', async () => {
  const f = fixture({ sid: OUTSIDE });
  await f.labeler.apply(PR, () => true);
  assert.deepEqual(f.labels, [{ name: 'hive' }]);
});

test('an applier call without an eligibility check is a no-op', async () => {
  const f = fixture();
  await f.labeler.apply(PR);
  assert.deepEqual(f.calls, []);
});

test('negative permission results retry with bounded exponential backoff', async () => {
  const f = fixture();
  f.failure = 'HTTP 403 permission denied';
  await f.sweep.run();
  let attempts = 1;
  for (const seconds of [60, 120, 240, 480, 900, 900]) {
    f.time += seconds * 1000 - 1;
    await f.sweep.run();
    assert.equal(f.calls.length, attempts);
    f.time++;
    await f.sweep.run();
    assert.equal(f.calls.length, ++attempts);
  }
});

test('a global auth failure suppresses other repositories until the next retry', async () => {
  const f = fixture();
  f.failure = 'HTTP 401 authentication required';
  f.host.links.get = () => Array.from({ length: 100 }, (_, index) => ({ type: 'pr', url: `https://github.com/example/repo${index}/pull/42` }));
  await f.sweep.run();
  assert.equal(f.calls.length, 1);
  await f.sweep.run();
  assert.equal(f.calls.length, 1);
  f.time = 60000;
  await f.sweep.run();
  assert.equal(f.calls.length, 2);
});

test('overlapping discovery sweeps do not duplicate label edits', async () => {
  const f = fixture();
  let release;
  f.afterView = () => { f.afterView = null; return new Promise(resolve => { release = resolve; }); };
  const pending = f.sweep.run();
  await new Promise(setImmediate);
  await f.sweep.run();
  release();
  await pending;
  assert.equal(edits(f).length, 1);
});

test('non-PR and invalid URL links cause no gh operations', async () => {
  const f = fixture();
  f.host.links.get = () => [{ type: 'jira', url: PR }, { type: 'pr', url: 'https://other.example/org/repo/pull/42' }, { type: 'pr', url: `${PR};echo` }];
  await f.sweep.run();
  assert.deepEqual(f.calls, []);
});

test('existing labels are compared without case sensitivity', async () => {
  const f = fixture();
  f.labels = [{ name: 'Hive' }];
  await f.sweep.run();
  assert.equal(edits(f).length, 0);
});

test('real gh subprocesses add labels and suppress permission stderr without changing bodies', async (t) => {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const { spawn } = await import('node:child_process');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hive-labels-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'pr.json');
  const initial = { state: 'OPEN', labels: [], labelExists: false, body: 'Description\r\n\r\nModel: exact\r\n\r\nMade with Agent Wrangler' };
  await fs.writeFile(file, JSON.stringify(initial));
  await fs.writeFile(path.join(root, 'gh'), `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
const file = process.env.TEST_PR_FILE;
const value = JSON.parse(fs.readFileSync(file, 'utf8'));
if (process.env.TEST_DENY) { process.stderr.write('HTTP 403 permission denied; synthetic-private-marker'); process.exit(1); }
if (args[0] === 'pr' && args[1] === 'view' && args[4] === 'labels') process.stdout.write(JSON.stringify({state: value.state, labels: value.labels}));
else if (args[0] === 'pr' && args[1] === 'edit' && args[3] === '--add-label' && args[4] === 'hive') {
  if (!value.labelExists) { process.stderr.write("could not add label: 'hive' not found"); process.exit(1); }
  value.labels.push({name: 'hive'}); fs.writeFileSync(file, JSON.stringify(value));
} else if (args[0] === 'label' && args[1] === 'create' && args[2] === 'hive' && args[5] === '--description' && args[6] === 'Made with Hive') {
  value.labelExists = true; fs.writeFileSync(file, JSON.stringify(value));
} else { process.stderr.write('unexpected arguments'); process.exit(1); }
`, { mode: 0o700 });
  const source = `import {createPrLabeler} from ${JSON.stringify(new URL('../server/pr-labels.js', import.meta.url).href)}; await createPrLabeler().apply(${JSON.stringify(PR)}, () => true);`;
  const run = async deny => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
      env: { ...process.env, PATH: `${root}${path.delimiter}${process.env.PATH}`, TEST_PR_FILE: file, TEST_DENY: deny ? '1' : '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
    assert.equal(code, 0);
    assert.equal(output, '');
  };
  await run(false);
  const labelled = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.deepEqual(labelled.labels, [{ name: 'hive' }]);
  assert.equal(labelled.body, initial.body);
  await fs.writeFile(file, JSON.stringify(initial));
  await run(true);
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), initial);
});

test('a repository label removed later can be recreated after its creation cooldown', async () => {
  const f = fixture({ labelExists: false });
  await f.labeler.apply(PR, () => true);
  assert.equal(creates(f).length, 1);
  f.labels = [];
  f.labelExists = false;
  f.time = 60000;
  await f.labeler.apply(PR, () => true);
  assert.equal(creates(f).length, 2);
  assert.deepEqual(f.labels, [{ name: 'hive' }]);
});

test('two unlabelled PRs in one repo share one label creation', async () => {
  const f = fixture();
  const other = PR.replace('/42', '/43');
  const labels = new Map([[PR, []], [other, []]]);
  let repoLabel = false;
  let creations = 0;
  let additions = 0;
  f.host.links.get = () => [...labels.keys()].map(url => ({ type: 'pr', url }));
  f.gh = async args => {
    if (args[0] === 'label') { creations++; repoLabel = true; return ''; }
    if (args[1] === 'view') return JSON.stringify({ state: 'OPEN', labels: labels.get(args[2]) });
    if (!repoLabel) throw new Error("could not add label: 'hive' not found");
    additions++;
    labels.set(args[2], [{ name: 'hive' }]);
    return '';
  };
  await f.sweep.run();
  assert.equal(creations, 1);
  assert.equal(additions, 2);
  assert.deepEqual([...labels.values()], [[{ name: 'hive' }], [{ name: 'hive' }]]);
});

async function durableFixture(t, options) {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const { MetadataStore } = await import('../server/metadata-store.js');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hive-pr-records-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'metadata.json');
  const f = fixture(options);
  f.runtime.metadata = new MetadataStore({ file });
  f.runtime.metadata.mutate(doc => Object.assign(doc, structuredClone(f.doc)));
  f.restart = () => {
    f.runtime.metadata = new MetadataStore({ file });
    f.labeler = createPrLabeler({ gh: (...args) => f.gh(...args), now: () => f.time });
    f.sweep = createPrLabelSweep({ runtime: f.runtime, host: f.host, labeler: f.labeler, tracker: { search: async () => [], state: async () => null, stop() {} }, now: () => f.time });
  };
  return f;
}

test('first sight is stored durably before any gh attempt', async t => {
  const f = await durableFixture(t);
  const gh = f.gh;
  f.gh = async (...args) => {
    const record = f.runtime.metadata.read().prLabels[PR];
    assert.equal(record.url, PR);
    assert.equal(record.sessionId, WORKER);
    assert.deepEqual(record.cellIds, ['cell']);
    assert.equal(record.status, 'pending');
    return gh(...args);
  };
  await f.sweep.run();
  assert.equal(f.runtime.metadata.read().prLabels[PR].status, 'labelled');
});

test('a pending PR record survives lost AW links and a process restart', async t => {
  const f = await durableFixture(t);
  f.failure = 'gh executable unavailable';
  await f.sweep.run();
  assert.equal(f.runtime.metadata.read().prLabels[PR].status, 'pending');
  f.host.links.get = () => [];
  f.host.sessions.list = () => [];
  f.failure = null;
  f.restart();
  await f.sweep.run();
  assert.deepEqual(f.labels, [{ name: 'hive' }]);
  assert.equal(f.runtime.metadata.read().prLabels[PR].status, 'labelled');
});

test('a completed record survives restart and never labels the PR again', async t => {
  const f = await durableFixture(t);
  await f.sweep.run();
  assert.equal(edits(f).length, 1);
  f.labels = [];
  f.host.links.get = () => [];
  f.restart();
  const calls = f.calls.length;
  await f.sweep.run();
  assert.equal(f.calls.length, calls);
  assert.equal(f.runtime.metadata.read().prLabels[PR].status, 'labelled');
});

test('a durable enrollment failure prevents all GitHub work', async () => {
  const f = fixture();
  f.runtime.metadata.mutate = () => { throw new Error('disk full'); };
  await assert.doesNotReject(f.sweep.run());
  assert.deepEqual(f.calls, []);
});

test('an old host retains pending records without GitHub work', async t => {
  const f = await durableFixture(t);
  f.failure = 'gh executable unavailable';
  await f.sweep.run();
  f.restart();
  f.host.version = '1.69.0';
  f.host.links = undefined;
  const calls = f.calls.length;
  await f.sweep.run();
  assert.equal(f.calls.length, calls);
  assert.equal(f.runtime.metadata.read().prLabels[PR].status, 'pending');
});

for (const state of ['MERGED', 'CLOSED']) {
  test(`pending first-sight enrollment labels after AW cleanup and ${state}`, async t => {
    const f = await durableFixture(t);
    f.failure = 'HTTP 401 not authenticated';
    await f.sweep.run();
    f.host.links.get = () => [];
    f.host.sessions.list = () => [];
    f.runtime.metadata.mutate(doc => { doc.cells.cell.enabled = false; });
    f.state = state;
    f.failure = null;
    f.restart();
    await f.sweep.run();
    assert.deepEqual(f.labels, [{ name: 'hive' }]);
    assert.equal(f.runtime.metadata.read().prLabels[PR].status, 'labelled');
  });
}

test('a completion-write failure recovers by observing the label without adding it again', async t => {
  const f = await durableFixture(t);
  const mutate = f.runtime.metadata.mutate.bind(f.runtime.metadata);
  f.runtime.metadata.mutate = fn => {
    if (f.runtime.metadata.read().prLabels[PR]) throw new Error('cannot save completion');
    return mutate(fn);
  };
  await f.sweep.run();
  assert.equal(edits(f).length, 1);
  assert.equal(f.runtime.metadata.read().prLabels[PR].status, 'pending');
  f.host.links.get = () => [];
  f.restart();
  await f.sweep.run();
  assert.equal(edits(f).length, 1);
  assert.equal(f.runtime.metadata.read().prLabels[PR].status, 'labelled');
});

for (const revoke of ['cell', 'binding']) {
  test(`an ineligible ${revoke} before first sight is never enrolled`, async () => {
    const f = fixture({ sid: COORDINATOR });
    if (revoke === 'cell') f.cell.enabled = false;
    else f.doc.bindings.cell[0].active = false;
    await f.sweep.run();
    assert.deepEqual(f.doc.prLabels, {});
    assert.deepEqual(f.calls, []);
  });
}

test('already-present labels receive a persistent completion record with no label edits', async t => {
  const f = await durableFixture(t, { labelled: true });
  await f.sweep.run();
  const record = f.runtime.metadata.read().prLabels[PR];
  assert.equal(record.status, 'labelled');
  assert.equal(record.labelledAt, 0);
  f.restart();
  await f.sweep.run();
  assert.equal(f.calls.length, 1);
  assert.equal(edits(f).length, 0);
});
