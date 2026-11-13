import fs from 'node:fs';
import path from 'node:path';
import { execFile as nodeExecFile } from 'node:child_process';
import { buildGraph, parseExport, isBeadId, encodeMeta, HIVE_META, HUMAN_ACTOR } from './bead-model.js';
import { newId } from './metadata-store.js';

export const SUPPORTED_BD = { major: 1, minor: 3, minPatch: 4, schemaVersion: 1, label: '>=1.3.4 <1.4.0' };
const READ_TIMEOUT_MS = 20000;
const WRITE_TIMEOUT_MS = 30000;
const INIT_TIMEOUT_MS = 120000;
const MAX_BUFFER = 64 * 1024 * 1024;
const MAX_QUEUE = 64;
const EXIT_GUARD_FAILED = 13;
const STDERR_LIMIT = 4000;
const CANDIDATE_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/home/linuxbrew/.linuxbrew/bin', '/usr/bin'];

export class BeadsError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    Object.assign(this, extra);
  }
}

function clip(s, n = STDERR_LIMIT) {
  const str = String(s || '');
  return str.length > n ? `${str.slice(0, n)}…` : str;
}

function isExecutable(file) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return false;
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveExecutable(configured, env = process.env) {
  if (configured) {
    if (!path.isAbsolute(configured)) return { executable: null, detail: `The configured bd path "${configured}" is not absolute.` };
    return isExecutable(configured)
      ? { executable: configured, detail: '' }
      : { executable: null, detail: `No executable bd at the configured path ${configured}.` };
  }
  const dirs = [...(env.PATH || '').split(path.delimiter).filter((d) => path.isAbsolute(d)), ...CANDIDATE_DIRS];
  if (env.HOME) dirs.push(path.join(env.HOME, '.local', 'bin'), path.join(env.HOME, 'go', 'bin'));
  for (const dir of [...new Set(dirs)]) {
    const file = path.join(dir, 'bd');
    if (isExecutable(file)) return { executable: file, detail: '' };
  }
  return { executable: null, detail: 'bd was not found on the server PATH or in the usual install locations. Install Beads or set its absolute path in Hive settings.' };
}

export function parseVersion(stdout) {
  const m = /\bbd version (\d+)\.(\d+)\.(\d+)/.exec(String(stdout || ''));
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), text: `${m[1]}.${m[2]}.${m[3]}` };
}

export function versionSupported(v) {
  return Boolean(v && v.major === SUPPORTED_BD.major && v.minor === SUPPORTED_BD.minor && v.patch >= SUPPORTED_BD.minPatch);
}

function nearestExisting(dir) {
  let probe = dir;
  while (!fs.existsSync(probe)) {
    const up = path.dirname(probe);
    if (up === probe) return probe;
    probe = up;
  }
  return probe;
}

function insideGitWorkTree(dir, execFile) {
  const probe = nearestExisting(dir);
  return new Promise((resolve) => {
    const child = execFile('git', ['-C', probe, 'rev-parse', '--is-inside-work-tree'], { timeout: 10000, encoding: 'utf8' }, (err, stdout) => {
      resolve(!err && String(stdout).trim() === 'true');
    });
    child.stdin?.end();
  });
}

function parseJson(stdout) {
  const t = String(stdout || '').trim();
  if (!t) return undefined;
  try {
    return JSON.parse(t);
  } catch {
    const start = t.search(/[[{]/);
    if (start > 0) {
      try { return JSON.parse(t.slice(start)); } catch { return undefined; }
    }
    return undefined;
  }
}

function failureText(res) {
  const json = parseJson(res.stdout);
  const fromJson = json && typeof json === 'object'
    ? [json.error, ...(Array.isArray(json.failed) ? json.failed.map((f) => f?.error) : [])].filter(Boolean).join('; ')
    : '';
  return clip(fromJson || String(res.stderr || '').trim() || String(res.stdout || '').trim() || `bd exited with code ${res.code}`, 1000);
}

function firstIssue(json) {
  if (Array.isArray(json)) return json[0] || null;
  if (json && typeof json === 'object' && typeof json.id === 'string') return json;
  return null;
}

function identityOf(exe) {
  try {
    const real = fs.realpathSync(exe);
    const st = fs.statSync(real);
    return { real, dev: st.dev, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
}

function sameIdentity(a, b) {
  return Boolean(a && b && a.real === b.real && a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs);
}

export function createBeadsAdapter({
  executable = null, workspaceDir, homeDir, scratchDir, execFile = nodeExecFile, env = process.env, log = () => {},
  configuredPath = () => null, onStateChange = () => {}, assertCurrent = () => {},
}) {
  const beadsDir = path.join(workspaceDir, '.beads');
  let queue = Promise.resolve();
  let pending = 0;
  // Writes that can change which beads sit under which (create, reparent,
  // kind or type change, delete) bump the generation when they start and
  // again when they end, whatever their outcome, so only a snapshot read
  // started after the last one ended can be current (see snapshots.js).
  let hierarchyGeneration = 0;
  let hierarchyWrites = 0;
  const hierarchyListeners = new Set();
  async function hierarchyWrite(fn) {
    hierarchyWrites += 1;
    hierarchyGeneration += 1;
    try {
      return await fn();
    } finally {
      hierarchyWrites -= 1;
      hierarchyGeneration += 1;
      for (const listener of hierarchyListeners) {
        try { listener(); } catch (err) { log(`hive: hierarchy listener failed: ${err.message}`); }
      }
    }
  }
  let state = { state: 'unknown', executable, version: null, detail: 'Not checked yet.', checkedAt: null };

  function childEnv({ withBeadsDir = true } = {}) {
    const out = {};
    for (const [k, v] of Object.entries(env)) {
      if (/^(BEADS_|BD_)/.test(k) || k === 'CLAUDE_SESSION_ID' || k === 'XDG_CONFIG_HOME') continue;
      out[k] = v;
    }
    return {
      ...out,
      HOME: homeDir,
      XDG_CONFIG_HOME: path.join(homeDir, '.config'),
      ...(withBeadsDir ? { BEADS_DIR: beadsDir } : {}),
      DO_NOT_TRACK: '1',
      BD_NON_INTERACTIVE: '1',
      BD_LAST_TOUCHED_FALLBACK: '0',
      BD_NO_DEP_TYPE_WARNING: '1',
      NO_COLOR: '1',
    };
  }

  function spawnOnce(exe, args, { cwd, timeout, withBeadsDir = true }) {
    assertCurrent();
    return new Promise((resolve) => {
      let child;
      try {
        child = execFile(exe, args, { cwd, env: childEnv({ withBeadsDir }), timeout, killSignal: 'SIGTERM', maxBuffer: MAX_BUFFER, encoding: 'utf8', windowsHide: true },
          (err, stdout, stderr) => {
            if (!err) return resolve({ code: 0, stdout, stderr, started: true });
            const timedOut = Boolean(err.killed || err.signal);
            const code = typeof err.code === 'number' ? err.code : null;
            resolve({ code, stdout: stdout || '', stderr: stderr || err.message || '', timedOut, spawnError: code === null && !timedOut ? err.code || err.message : null, started: code !== null || timedOut });
          });
      } catch (err) {
        resolve({ code: null, stdout: '', stderr: err.message, spawnError: err.message, started: false });
        return;
      }
      child.stdin?.end();
    });
  }

  function enqueue(fn) {
    if (pending >= MAX_QUEUE) return Promise.reject(new BeadsError('busy', 'Too many Beads operations are queued; try again shortly.'));
    pending += 1;
    const job = queue.then(fn);
    queue = job.then(() => {}, () => {});
    return job.finally(() => { pending -= 1; });
  }

  function setState(next, { fromRefresh = false } = {}) {
    state = next;
    try { onStateChange(state, { fromRefresh }); } catch (err) { log(`hive: state listener failed: ${err.message}`); }
  }

  // Checked inside the queued job, immediately before the command it
  // authorizes: a binary swapped underneath us (an upgrade through the same
  // symlink, a removal, a changed setting) is never used unchecked.
  function stillValid(exe) {
    if (state.state !== 'ready' || !state.identity) return false;
    if (exe !== state.executable) return false;
    if ((configuredPath() || null) !== state.identity.configured) return false;
    return sameIdentity(identityOf(exe), state.identity.file);
  }

  function run(args, { write = false, raw = false, probing = false, timeout, cwd = workspaceDir, exe = state.executable, withBeadsDir = true } = {}) {
    if (!exe) return Promise.reject(new BeadsError('setup-required', state.detail || 'bd is not available.'));
    const argv = write || raw ? args : ['--readonly', ...args];
    return enqueue(() => {
      if (!probing && invalidated(exe)) return STALE;
      return spawnOnce(exe, argv, { cwd, withBeadsDir, timeout: timeout ?? (write ? WRITE_TIMEOUT_MS : READ_TIMEOUT_MS) });
    });
  }

  function invalidated(exe) {
    if (stillValid(exe)) return false;
    if (state.state === 'ready') {
      setState({ state: 'unknown', executable: null, version: null, detail: 'bd, its location or the configured path changed since it was checked. Rechecking before any further use.', checkedAt: Date.now() });
    }
    return true;
  }

  const STALE = Object.freeze({ stale: true, code: null, stdout: '', stderr: '', started: false });

  function noteStartFailure(res) {
    if (!res.started && !res.stale && state.state === 'ready') {
      setState({ state: 'missing-binary', executable: null, version: null, detail: `bd could not be started: ${res.spawnError || res.stderr}`, checkedAt: Date.now() });
    }
  }

  function writeOutcome(res, what) {
    if (res.code === 0) return;
    if (res.stale) throw new BeadsError('setup-required', `${what} was not attempted: ${state.detail}`);
    noteStartFailure(res);
    if (res.timedOut) throw new BeadsError('uncertain', `${what} did not finish in time; it may or may not have been applied. It will not be retried automatically.`, { stderr: clip(res.stderr) });
    if (!res.started) throw new BeadsError('failed', `${what} could not start bd: ${res.spawnError || res.stderr}`);
    if (res.code === EXIT_GUARD_FAILED) throw new BeadsError('conflict', failureText(res), { stderr: clip(res.stderr), noWrite: true });
    if (res.code === null) throw new BeadsError('uncertain', `${what} ended abnormally; it may or may not have been applied.`, { stderr: clip(res.stderr) });
    throw new BeadsError('refused', failureText(res), { stderr: clip(res.stderr), exitCode: res.code });
  }

  function readOutcome(res, what) {
    if (res.code === 0) return;
    if (res.stale) throw new BeadsError('setup-required', `${what} was not attempted: ${state.detail}`);
    noteStartFailure(res);
    if (res.timedOut) throw new BeadsError('failed', `${what} timed out.`);
    throw new BeadsError('failed', `${what} failed: ${failureText(res)}`, { stderr: clip(res.stderr) });
  }

  function requireReady() {
    if (state.state !== 'ready') throw new BeadsError('setup-required', `Hive's Beads store is not ready (${state.state}): ${state.detail}`);
  }

  function checkId(id, field = 'bead id') {
    if (!isBeadId(id)) throw new BeadsError('invalid', `Invalid ${field} ${JSON.stringify(id)}.`);
  }

  function readWorkspaceMeta() {
    const file = path.join(beadsDir, 'metadata.json');
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      return err.code === 'ENOENT' ? null : { unreadable: err.message };
    }
  }

  async function probe({ configuredPath: configuredPathArg = configuredPath() } = {}) {
    const at = Date.now();
    if (state.state === 'ready') {
      setState({ state: 'unknown', executable: null, version: null, detail: 'Checking bd again…', checkedAt: at }, { fromRefresh: true });
    }
    const found = resolveExecutable(configuredPathArg, env);
    if (!found.executable) {
      setState({ state: 'missing-binary', executable: null, version: null, detail: found.detail, checkedAt: at });
      return state;
    }
    const exe = found.executable;
    const fileIdentity = identityOf(exe);
    try {
      fs.mkdirSync(homeDir, { recursive: true, mode: 0o700 });
    } catch (err) {
      setState({ state: 'error', executable: exe, version: null, detail: `Cannot create ${homeDir}: ${err.message}`, checkedAt: at });
      return state;
    }
    const neutralCwd = fs.existsSync(workspaceDir) ? workspaceDir : nearestExisting(workspaceDir);
    const ver = await run(['--version'], { raw: true, probing: true, exe, cwd: neutralCwd, withBeadsDir: false });
    const version = ver.code === 0 ? parseVersion(ver.stdout) : null;
    if (!version) {
      setState({ state: 'missing-binary', executable: exe, version: null, detail: `${exe} did not report a bd version: ${clip(ver.stderr || ver.stdout, 300)}`, checkedAt: at });
      return state;
    }
    if (!versionSupported(version)) {
      setState({ state: 'incompatible', executable: exe, version: version.text, detail: `bd ${version.text} is outside the supported range ${SUPPORTED_BD.label}. Hive will not read or write the store with it.`, checkedAt: at });
      return state;
    }
    const schema = await run(['schema'], { raw: true, probing: true, exe, cwd: neutralCwd, withBeadsDir: false });
    const schemaVersion = schema.code === 0 ? parseJson(schema.stdout)?.schema_version : undefined;
    if (schemaVersion !== SUPPORTED_BD.schemaVersion) {
      setState({ state: 'incompatible', executable: exe, version: version.text, detail: `bd reports JSON schema ${JSON.stringify(schemaVersion ?? null)}; Hive supports schema ${SUPPORTED_BD.schemaVersion}.`, checkedAt: at });
      return state;
    }
    const meta = readWorkspaceMeta();
    if (!meta) {
      const occupied = fs.existsSync(beadsDir);
      setState(occupied
        ? { state: 'damaged', executable: exe, version: version.text, detail: `${beadsDir} exists but has no metadata.json. Hive will not initialize over it; inspect or move it.`, checkedAt: at }
        : { state: 'uninitialized', executable: exe, version: version.text, detail: `No Hive Beads store at ${workspaceDir} yet.`, checkedAt: at });
      return state;
    }
    if (meta.unreadable || meta.backend !== 'dolt' || meta.dolt_mode !== 'embedded') {
      setState({ state: 'incompatible', executable: exe, version: version.text, detail: meta.unreadable ? `Cannot read ${beadsDir}/metadata.json: ${meta.unreadable}` : `The store at ${workspaceDir} is not an embedded Dolt store (backend ${meta.backend}, mode ${meta.dolt_mode}).`, checkedAt: at });
      return state;
    }
    const info = await run(['info', '--json'], { exe, probing: true });
    if (info.code !== 0) {
      setState({ state: 'error', executable: exe, version: version.text, detail: `bd could not open the store: ${failureText(info)}`, checkedAt: at });
      return state;
    }
    setState({
      state: 'ready', executable: exe, version: version.text, detail: `bd ${version.text}, embedded store at ${workspaceDir}.`, checkedAt: at,
      identity: { configured: configuredPathArg || null, file: fileIdentity },
    });
    return state;
  }

  async function initialize({ configuredPath: configuredPathArg = configuredPath() } = {}) {
    const before = await probe({ configuredPath: configuredPathArg });
    if (before.state === 'ready') return { initialized: false, state: before };
    if (before.state !== 'uninitialized') throw new BeadsError('setup-required', before.detail);
    if (await insideGitWorkTree(workspaceDir, execFile)) {
      throw new BeadsError('refused', `${workspaceDir} is inside a git work tree. Hive initializes its store only outside source checkouts; set AW_DATA_DIR to a location outside any repository.`);
    }
    fs.mkdirSync(workspaceDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(homeDir, { recursive: true, mode: 0o700 });
    const res = await run(['init', '--non-interactive', '--skip-agents', '--skip-hooks', '--role', 'maintainer', '--prefix', 'hive', '--quiet'],
      { write: true, probing: true, timeout: INIT_TIMEOUT_MS, exe: before.executable, withBeadsDir: false });
    try {
      writeOutcome(res, 'Initializing the Beads store');
    } finally {
      await probe({ configuredPath: configuredPathArg });
    }
    return { initialized: true, state };
  }

  async function loadSnapshot({ all = false } = {}) {
    requireReady();
    const res = await run(all ? ['export', '--all'] : ['export']);
    if (res.code !== 0 && res.started && !res.stale && state.state === 'ready') {
      setState({ ...state, state: 'error', identity: null, detail: `bd could not read the store: ${failureText(res)}. Recheck once it is fixed.`, checkedAt: Date.now() }, { fromRefresh: true });
    }
    readOutcome(res, 'Reading the Beads store');
    const { issues, errors } = parseExport(res.stdout);
    if (all && errors.length) throw new BeadsError('refused', 'Cannot read ownership from an incomplete Beads export.');
    const graph = buildGraph(issues);
    if (errors.length) {
      graph.snapshotError = `Reading the Beads export skipped ${errors.length} invalid line(s): ${errors.slice(0, 3).join('; ')}`;
      log(`hive: ${graph.snapshotError}`);
    }
    return graph;
  }

  async function show(id) {
    requireReady();
    checkId(id);
    const res = await run(['show', id, '--json']);
    if (res.code !== 0) {
      if (/not found|no issues found/i.test(failureText(res))) return null;
      readOutcome(res, `Reading ${id}`);
    }
    return firstIssue(parseJson(res.stdout));
  }

  async function findByOperation(opId) {
    requireReady();
    const res = await run(['list', '--all', '--flat', '--limit', '0', '--metadata-field', `${HIVE_META.op}=${opId}`, '--json']);
    readOutcome(res, 'Reconciling an operation');
    const json = parseJson(res.stdout);
    const rows = Array.isArray(json) ? json : Array.isArray(json?.issues) ? json.issues : [];
    return rows.filter((r) => r && typeof r.id === 'string').map((r) => r.id);
  }

  function metaFields(fields) {
    const out = [];
    for (const [key, metaKey] of [['kind', HIVE_META.kind], ['nextAction', HIVE_META.nextAction], ['waitingFor', HIVE_META.waitingFor], ['evidence', HIVE_META.evidence], ['outcome', HIVE_META.outcome], ['resume', HIVE_META.resume]]) {
      if (fields[key] !== undefined) out.push([metaKey, encodeMeta(fields[key])]);
    }
    return out;
  }

  function createMany(...args) {
    return hierarchyWrite(() => createManyNow(...args));
  }

  async function createManyNow({ nodes, edges = [] }, actor, opId) {
    requireReady();
    if (!Array.isArray(nodes) || !nodes.length) throw new BeadsError('invalid', 'Nothing to create.');
    for (const e of edges) {
      if (e.fromId) checkId(e.fromId, 'link end');
      if (e.toId) checkId(e.toId, 'link end');
    }
    const plan = {
      commit_message: `hive: create ${nodes.length} bead(s) (${opId})`,
      nodes: nodes.map((n) => {
        if (n.parentId) checkId(n.parentId, 'parent id');
        const metadata = { [HIVE_META.op]: opId };
        if (n.cellId) metadata[HIVE_META.cell] = n.cellId;
        for (const [k, v] of metaFields(n)) metadata[k] = v;
        return {
          key: n.key,
          title: n.title,
          type: n.issueType || 'task',
          ...(n.goal ? { description: n.goal } : {}),
          ...(n.acceptance ? { acceptance_criteria: n.acceptance } : {}),
          ...(n.summary ? { notes: n.summary } : {}),
          ...(n.status ? { status: n.status } : {}),
          ...(n.parentKey ? { parent_key: n.parentKey } : {}),
          ...(n.parentId ? { parent_id: n.parentId } : {}),
          metadata,
        };
      }),
      edges: edges.map((e) => ({
        ...(e.fromKey ? { from_key: e.fromKey } : { from_id: e.fromId }),
        ...(e.toKey ? { to_key: e.toKey } : { to_id: e.toId }),
        type: e.type || 'blocks',
      })),
    };
    fs.mkdirSync(scratchDir, { recursive: true, mode: 0o700 });
    const file = path.join(scratchDir, `plan-${opId}-${newId('p')}.json`);
    fs.writeFileSync(file, JSON.stringify(plan), { mode: 0o600 });
    try {
      const res = await run(['create', '--graph', file, '--json', '--actor', actor || HUMAN_ACTOR], { write: true });
      writeOutcome(res, 'Creating beads');
      const ids = parseJson(res.stdout)?.ids;
      if (!ids || typeof ids !== 'object') throw new BeadsError('uncertain', 'bd reported success but returned no ids; the beads may exist. Reconcile before retrying.');
      return { ids };
    } finally {
      fs.rmSync(file, { force: true });
    }
  }

  function update(id, patch, actor, check) {
    const reshapes = patch && (patch.parentId !== undefined || patch.kind !== undefined || patch.issueType !== undefined);
    return reshapes ? hierarchyWrite(() => updateNow(id, patch, actor, check)) : updateNow(id, patch, actor, check);
  }

  async function updateNow(id, patch, actor, check) {
    requireReady();
    if (check) {
      const exe = state.executable;
      const args = updateArgs(id, patch, actor);
      return enqueue(async () => {
        const exp = invalidated(exe) ? STALE : await spawnOnce(exe, ['--readonly', 'export', '--all'], { cwd: workspaceDir, timeout: READ_TIMEOUT_MS });
        readOutcome(exp, 'Reading the Beads store');
        const guard = check(parseExport(exp.stdout));
        const guardedArgs = [...args];
        if (guard) {
          if (typeof guard.assignee !== 'string' || typeof guard.status !== 'string') throw new BeadsError('invalid', 'An update guard needs an assignee and status.');
          guardedArgs.push('--if-assignee', guard.assignee, '--if-status', guard.status);
        }
        const res = invalidated(exe) ? STALE : await spawnOnce(exe, guardedArgs, { cwd: workspaceDir, timeout: WRITE_TIMEOUT_MS });
        writeOutcome(res, `Updating ${id}`);
        return firstIssue(parseJson(res.stdout));
      });
    }
    const res = await run(updateArgs(id, patch, actor), { write: true });
    writeOutcome(res, `Updating ${id}`);
    return firstIssue(parseJson(res.stdout));
  }

  function updateArgs(id, patch, actor) {
    checkId(id);
    const args = ['update', id, '--json', '--actor', actor || HUMAN_ACTOR];
    if (patch.title !== undefined) args.push('--title', patch.title);
    if (patch.goal !== undefined) args.push('--description', patch.goal);
    if (patch.acceptance !== undefined) args.push('--acceptance', patch.acceptance);
    if (patch.summary !== undefined) args.push('--notes', patch.summary);
    if (patch.status !== undefined) args.push('--status', patch.status);
    if (patch.issueType !== undefined) args.push('--type', patch.issueType);
    if (patch.parentId !== undefined) {
      if (patch.parentId) checkId(patch.parentId, 'parent id');
      args.push('--parent', patch.parentId || '');
    }
    for (const [k, v] of metaFields(patch)) args.push('--set-metadata', `${k}=${v}`);
    if (args.length === 5) throw new BeadsError('invalid', 'Nothing to update.');
    return args;
  }

  async function link({ dependent, prerequisite, type = 'blocks', remove = false }, actor) {
    requireReady();
    checkId(dependent, 'dependent id');
    checkId(prerequisite, 'prerequisite id');
    const args = remove
      ? ['dep', 'remove', dependent, prerequisite, '--json', '--actor', actor || HUMAN_ACTOR]
      : ['dep', 'add', dependent, prerequisite, '--type', type, '--json', '--actor', actor || HUMAN_ACTOR];
    const res = await run(args, { write: true });
    writeOutcome(res, remove ? 'Removing a link' : 'Adding a link');
    return parseJson(res.stdout) ?? {};
  }

  async function linkMany(links, actor, opId) {
    requireReady();
    if (!Array.isArray(links) || !links.length) throw new BeadsError('invalid', 'No links given.');
    const lines = links.map((l) => {
      checkId(l.dependent, 'dependent id');
      checkId(l.prerequisite, 'prerequisite id');
      if (l.remove) return `dep remove ${l.dependent} ${l.prerequisite}`;
      if (!/^[a-z-]{1,40}$/.test(l.type || 'blocks')) throw new BeadsError('invalid', `Invalid link type ${JSON.stringify(l.type)}.`);
      return `dep add ${l.dependent} ${l.prerequisite} ${l.type || 'blocks'}`;
    });
    fs.mkdirSync(scratchDir, { recursive: true, mode: 0o700 });
    const file = path.join(scratchDir, `links-${opId}-${newId('b')}.txt`);
    fs.writeFileSync(file, `${lines.join('\n')}\n`, { mode: 0o600 });
    try {
      const res = await run(['batch', '-f', file, '-m', `hive: ${links.length} link change(s) (${opId})`, '--json', '--actor', actor || HUMAN_ACTOR], { write: true });
      writeOutcome(res, 'Changing links');
      return parseJson(res.stdout) ?? {};
    } finally {
      fs.rmSync(file, { force: true });
    }
  }

  async function claim(id, actor, check) {
    requireReady();
    checkId(id);
    const exe = state.executable;
    return enqueue(async () => {
      const exp = invalidated(exe) ? STALE : await spawnOnce(exe, ['--readonly', 'export', '--all'], { cwd: workspaceDir, timeout: READ_TIMEOUT_MS });
      readOutcome(exp, 'Reading the Beads store');
      const context = parseExport(exp.stdout);
      const current = context.issues.find((b) => b.id === id);
      if (context.errors.length) throw new BeadsError('refused', 'Cannot claim from an incomplete Beads export.');
      if (!current) throw new BeadsError('refused', `Bead ${id} does not exist.`);
      check?.(context);
      if (current.assignee === actor) return { issue: current, already: true };
      if (current.assignee) throw new BeadsError('conflict', `Bead ${id} is already claimed by ${current.assignee}.`, { holder: current.assignee });
      if (current.status === 'closed') throw new BeadsError('refused', `Bead ${id} is closed; reopen it before claiming.`);
      const res = invalidated(exe) ? STALE : await spawnOnce(exe, ['update', id, '--if-assignee', '', '--assignee', actor, '--status', 'in_progress', '--json', '--actor', actor], { cwd: workspaceDir, timeout: WRITE_TIMEOUT_MS });
      writeOutcome(res, `Claiming ${id}`);
      return { issue: firstIssue(parseJson(res.stdout)), already: false };
    });
  }

  async function release(id, actor, { force = false, reason = '', holder = null, priorStatus, status, onStep, check } = {}) {
    requireReady();
    checkId(id);
    if (status !== undefined) return managedRelease(id, actor, { reason, holder, priorStatus, status, onStep, check });
    const args = ['unclaim', id, '--json', '--actor', actor || HUMAN_ACTOR];
    if (holder) args.push('--if-assignee', holder);
    else if (force) args.push('--force');
    else args.push('--if-assignee', actor);
    if (reason) args.push('--reason', reason);
    const res = await run(args, { write: true });
    if (res.code !== 0 && !res.timedOut && res.started && /assignee mismatch|is held by/i.test(failureText(res))) {
      throw new BeadsError('conflict', failureText(res), { noWrite: true });
    }
    writeOutcome(res, `Releasing ${id}`);
    return firstIssue(parseJson(res.stdout));
  }

  async function managedRelease(id, actor, { reason, holder, priorStatus, status, onStep, check }) {
    const statuses = ['open', 'in_progress', 'blocked', 'deferred'];
    if (!holder || !statuses.includes(priorStatus) || !statuses.includes(status)) {
      throw new BeadsError('invalid', 'A managed release needs a holder and supported prior and target statuses.');
    }
    const exe = state.executable;
    return enqueue(async () => {
      const command = (args, write = true) => invalidated(exe) ? STALE
        : spawnOnce(exe, write ? args : ['--readonly', ...args], { cwd: workspaceDir, timeout: write ? WRITE_TIMEOUT_MS : READ_TIMEOUT_MS });
      const read = await command(['show', id, '--json'], false);
      readOutcome(read, `Checking ${id} before release`);
      const current = firstIssue(parseJson(read.stdout));
      if (!current || current.assignee !== holder || current.status !== priorStatus) {
        throw new BeadsError('conflict', `${id} changed before release; nothing was changed.`);
      }
      check?.(current);
      const step = async (name, args) => {
        onStep?.({ step: name, state: 'started' });
        const res = await command(args);
        if (name === 'unclaim' && res.code !== 0 && !res.timedOut && res.started && /assignee mismatch|is held by/i.test(failureText(res))) {
          throw new BeadsError('conflict', failureText(res), { noWrite: true });
        }
        writeOutcome(res, `Release ${id}: ${name}`);
        onStep?.({ step: name, state: 'done' });
      };
      const guardedStatus = (next, expectedHolder, expectedStatus) => [
        'update', id, '--json', '--actor', actor || HUMAN_ACTOR,
        '--if-assignee', expectedHolder, '--if-status', expectedStatus, '--status', next,
      ];
      if (priorStatus === 'blocked' || priorStatus === 'deferred') {
        await step('prepare', guardedStatus('open', holder, priorStatus));
      }
      await step('unclaim', ['unclaim', id, '--json', '--actor', actor || HUMAN_ACTOR,
        '--if-assignee', holder, ...(reason ? ['--reason', reason] : [])]);
      if (status !== 'open') await step('restore', guardedStatus(status, '', 'open'));
      const result = await command(['show', id, '--json'], false);
      readOutcome(result, `Checking ${id} after release`);
      const after = firstIssue(parseJson(result.stdout));
      if (!after || after.assignee || after.status !== status) {
        throw new BeadsError('uncertain', `${id} no longer has the requested released status ${status}.`);
      }
      return after;
    });
  }

  async function close(id, reason, actor) {
    requireReady();
    checkId(id);
    const res = await run(['close', id, '--reason', reason, '--json', '--actor', actor || HUMAN_ACTOR], { write: true });
    writeOutcome(res, `Closing ${id}`);
    return firstIssue(parseJson(res.stdout));
  }

  // bd reopen sets each item back to open, clears its closed time and records
  // a Reopened event; notes, evidence and outcome stay as they were.
  // With `check`, the store is exported in the same queued job and `check`
  // runs on that read before the reopen, as for a fenced finish.
  async function reopen(ids, reason, actor, check) {
    requireReady();
    if (!Array.isArray(ids) || !ids.length) throw new BeadsError('invalid', 'Nothing to reopen.');
    for (const id of ids) checkId(id);
    const args = ['reopen', ...ids, '--reason', reason, '--json', '--actor', actor || HUMAN_ACTOR];
    if (!check) {
      const res = await run(args, { write: true });
      writeOutcome(res, 'Reopening');
      return parseJson(res.stdout) ?? {};
    }
    const exe = state.executable;
    return enqueue(async () => {
      const exp = invalidated(exe) ? STALE : await spawnOnce(exe, ['--readonly', 'export', '--all'], { cwd: workspaceDir, timeout: READ_TIMEOUT_MS });
      readOutcome(exp, 'Reading the Beads store');
      check(parseExport(exp.stdout));
      const res = invalidated(exe) ? STALE : await spawnOnce(exe, args, { cwd: workspaceDir, timeout: WRITE_TIMEOUT_MS });
      writeOutcome(res, 'Reopening');
      return parseJson(res.stdout) ?? {};
    });
  }

  // A finish whose checks must hold at the moment it writes: the store is
  // exported in the same queued job, `check` runs synchronously on that read,
  // and the writes follow with no other Hive command in between. `written(i)`
  // is told as each write succeeds; a failed write carries its index as
  // `step`.
  async function finishFenced(id, { summary, evidence, outcome, reason }, actor, check, written = () => {}) {
    requireReady();
    const who = actor || HUMAN_ACTOR;
    const writes = [
      { args: updateArgs(id, { summary, ...(evidence ? { evidence } : {}) }, who), label: `Updating ${id}` },
      { args: (checkId(id), ['close', id, '--reason', reason, '--json', '--actor', who]), label: `Closing ${id}` },
      { args: updateArgs(id, { outcome, waitingFor: '', nextAction: '' }, who), label: `Recording the outcome of ${id}` },
    ];
    const exe = state.executable;
    return enqueue(async () => {
      const exp = invalidated(exe) ? STALE : await spawnOnce(exe, ['--readonly', 'export', '--all'], { cwd: workspaceDir, timeout: READ_TIMEOUT_MS });
      readOutcome(exp, 'Reading the Beads store');
      check(parseExport(exp.stdout));
      for (const [i, w] of writes.entries()) {
        const res = invalidated(exe) ? STALE : await spawnOnce(exe, w.args, { cwd: workspaceDir, timeout: WRITE_TIMEOUT_MS });
        try {
          writeOutcome(res, w.label);
        } catch (err) {
          err.step = i;
          throw err;
        }
        written(i);
      }
      return { closed: true };
    });
  }

  // What a deletion is judged against: every record export gives, any lines
  // it could not parse, and each named item's direct neighbours in both
  // directions. Export can leave out records (owner exclusions in bd's
  // settings), so the neighbours come from bd's own dependency reads too,
  // which have no such filter.
  async function deletionReads(ids, read) {
    const exp = await read(['export', '--all']);
    readOutcome(exp, 'Reading the Beads store');
    const { issues, errors } = parseExport(exp.stdout);
    const neighbours = [];
    for (const id of ids) {
      for (const direction of ['up', 'down']) {
        const res = await read(['dep', 'list', id, '--direction', direction, '--json']);
        readOutcome(res, `Reading the links of ${id}`);
        const rows = parseJson(res.stdout);
        if (!Array.isArray(rows) || rows.some((r) => !r || typeof r.id !== 'string')) throw new BeadsError('failed', `bd returned unreadable links for ${id}.`);
        for (const issue of rows) neighbours.push({ anchor: id, direction, type: issue.dependency_type || null, issue });
      }
    }
    return { issues, errors, neighbours };
  }

  async function deletionContext(ids) {
    requireReady();
    for (const id of ids) checkId(id);
    return deletionReads(ids, (args) => run(args));
  }

  // bd deletes without a preview only with --force, which also orphans any
  // dependents outside the set; it has no guard of its own. So the store is
  // read and checked by the caller in the same queued job, and the check runs
  // synchronously right before the delete starts: no other Hive command, and
  // no other step of this process, runs in between.
  function deleteMany(...args) {
    return hierarchyWrite(() => deleteManyNow(...args));
  }

  async function deleteManyNow(ids, actor, check) {
    requireReady();
    if (!Array.isArray(ids) || !ids.length) throw new BeadsError('invalid', 'Nothing to delete.');
    for (const id of ids) checkId(id);
    const exe = state.executable;
    return enqueue(async () => {
      const read = (args) => (invalidated(exe) ? STALE : spawnOnce(exe, ['--readonly', ...args], { cwd: workspaceDir, timeout: READ_TIMEOUT_MS }));
      const context = await deletionReads(ids, read);
      check(context);
      const res = invalidated(exe) ? STALE : await spawnOnce(exe, ['delete', ...ids, '--force', '--json', '--actor', actor || HUMAN_ACTOR], { cwd: workspaceDir, timeout: WRITE_TIMEOUT_MS });
      try {
        writeOutcome(res, 'Deleting beads');
      } catch (err) {
        err.deleteStarted = Boolean(res.started);
        throw err;
      }
      return parseJson(res.stdout) ?? {};
    });
  }

  return {
    get status() { return state; },
    get hierarchy() { return { generation: hierarchyGeneration, writing: hierarchyWrites > 0 }; },
    onHierarchySettled(listener) {
      hierarchyListeners.add(listener);
      return () => hierarchyListeners.delete(listener);
    },
    workspaceDir,
    probe,
    initialize,
    loadSnapshot,
    show,
    findByOperation,
    createMany,
    update,
    link,
    linkMany,
    claim,
    release,
    close,
    reopen,
    finishFenced,
    deletionContext,
    deleteMany,
  };
}
