import fs from 'node:fs';
import { spawn as nodeSpawn, execFile as nodeExecFile } from 'node:child_process';

export const KEEP_AWAKE_SETTING = 'keepAwake';
export const KEEP_AWAKE_AC_SETTING = 'keepAwakeAcOnly';
export const CAFFEINATE = '/usr/bin/caffeinate';
const POWER_TTL_MS = 30000;
const POWER_TIMEOUT_MS = 5000;
const STABLE_MS = 60000;
const BACKOFF_MS = [5000, 30000, 120000, 600000];

const REASONS = {
  'env-off': 'Turned off for this process by HIVE_KEEP_AWAKE=off.',
  unsupported: 'Only available on macOS.',
  missing: `${CAFFEINATE} is not available.`,
  disabled: 'Off in Hive settings.',
  idle: 'No active Hive work.',
  checking: 'Checking the power source…',
  battery: 'Paused while the Mac is on battery power.',
  'power-unknown': 'Paused because the power source could not be read.',
  backoff: 'caffeinate stopped unexpectedly; Hive will retry shortly.',
  starting: 'Starting caffeinate…',
  held: 'Keeping the Mac awake while Hive work is active.',
  stopped: 'Stopped.',
};

export function parsePowerSource(text) {
  const m = /Now drawing from '([^']+)'/.exec(String(text || ''));
  if (!m) return null;
  return /^AC Power$/i.test(m[1].trim()) ? 'ac' : 'battery';
}

export function keepAwakeSettings(get) {
  return { enabled: get(KEEP_AWAKE_SETTING) !== false, acOnly: get(KEEP_AWAKE_AC_SETTING) !== false };
}

// Holds one `caffeinate -i -w <pid>` while Hive work is active, so idle sleep
// cannot suspend it, and never outlives this process: -w ends it with the
// service, and stop/dispose/process exit kill it.
export function createKeepAwake({
  platform = process.env.HIVE_KEEP_AWAKE === 'off' ? 'off' : process.platform, pid = process.pid, spawn = nodeSpawn, execFile = nodeExecFile,
  exists = (file) => fs.existsSync(file), now = () => Date.now(), log = () => {}, onChange = () => {},
  exitHooks = { add: (fn) => process.on('exit', fn), remove: (fn) => process.off('exit', fn) },
} = {}) {
  let child = null;
  let stopping = null;
  let startedAt = null;
  let failures = 0;
  let retryAt = 0;
  let disposed = false;
  let wanted = false;
  let input = { enabled: false, acOnly: true, active: false, work: 0, ciWaits: 0 };
  const power = { source: null, checkedAt: 0, seq: 0, inflight: false };
  let status = snapshot('stopped');

  function snapshot(reason) {
    return {
      supported: platform === 'darwin',
      enabled: input.enabled,
      acOnly: input.acOnly,
      active: input.active,
      work: input.work,
      ciWaits: input.ciWaits,
      power: power.source,
      holding: Boolean(child && !stopping),
      pid: child && !stopping ? child.pid ?? null : null,
      since: child && !stopping ? startedAt : null,
      reason,
      detail: REASONS[reason] || reason,
    };
  }

  function publish(reason) {
    const next = snapshot(reason);
    if (JSON.stringify(next) === JSON.stringify(status)) return;
    status = next;
    try { onChange(status); } catch (err) { log(`hive: keep-awake listener failed: ${err.message}`); }
  }

  function killOnExit() {
    try { child?.kill('SIGTERM'); } catch {}
  }

  function release() {
    if (!child) return;
    const current = child;
    child = null;
    startedAt = null;
    exitHooks.remove(killOnExit);
    if (current.exitCode !== null && current.exitCode !== undefined) return;
    stopping = current;
    try { current.kill('SIGTERM'); } catch (err) { log(`hive: could not stop caffeinate: ${err.message}`); }
  }

  function hold() {
    if (child || stopping || disposed) return;
    if (now() < retryAt) return publish('backoff');
    let proc;
    try {
      proc = spawn(CAFFEINATE, ['-i', '-w', String(pid)], { stdio: 'ignore' });
    } catch (err) {
      log(`hive: could not start caffeinate: ${err.message}`);
      failed();
      return publish('backoff');
    }
    child = proc;
    startedAt = now();
    exitHooks.add(killOnExit);
    proc.unref?.();
    proc.on?.('error', (err) => {
      log(`hive: caffeinate failed: ${err.message}`);
      exited(proc);
    });
    proc.on?.('exit', () => exited(proc));
  }

  function failed() {
    retryAt = now() + BACKOFF_MS[Math.min(failures, BACKOFF_MS.length - 1)];
    failures += 1;
  }

  function exited(proc) {
    if (stopping === proc) {
      stopping = null;
    } else if (child === proc) {
      if (now() - startedAt >= STABLE_MS) failures = 0;
      child = null;
      startedAt = null;
      exitHooks.remove(killOnExit);
      if (!disposed) {
        log('hive: caffeinate exited unexpectedly.');
        failed();
      }
    } else {
      return;
    }
    if (!disposed && wanted) evaluate(input);
  }

  function checkPower() {
    if (power.inflight || disposed) return;
    power.inflight = true;
    const seq = ++power.seq;
    const done = (source) => {
      if (seq !== power.seq) return;
      power.inflight = false;
      power.source = source;
      power.checkedAt = now();
      if (!disposed && wanted) evaluate(input);
    };
    try {
      const proc = execFile('/usr/bin/pmset', ['-g', 'batt'], { timeout: POWER_TIMEOUT_MS, encoding: 'utf8' }, (err, stdout) => done(err ? null : parsePowerSource(stdout)));
      proc?.stdin?.end?.();
    } catch {
      done(null);
    }
  }

  function evaluate(next = input) {
    if (disposed) return status;
    input = { enabled: Boolean(next.enabled), acOnly: next.acOnly !== false, active: Boolean(next.active), work: next.work || 0, ciWaits: next.ciWaits || 0 };
    const reason = decide();
    wanted = reason === 'held' || reason === 'checking';
    if (reason === 'held') hold();
    else release();
    publish(reason === 'held' && !child ? (now() < retryAt ? 'backoff' : 'starting') : reason);
    return status;
  }

  function decide() {
    if (platform === 'off') return 'env-off';
    if (platform !== 'darwin') return 'unsupported';
    if (!exists(CAFFEINATE)) return 'missing';
    if (!input.enabled) return 'disabled';
    if (!input.active) return 'idle';
    if (input.acOnly) {
      if (!power.checkedAt || now() - power.checkedAt >= POWER_TTL_MS) checkPower();
      if (!power.checkedAt) return 'checking';
      if (power.source === 'battery') return 'battery';
      if (power.source !== 'ac') return 'power-unknown';
    }
    return 'held';
  }

  function stop() {
    wanted = false;
    release();
    power.seq += 1;
    power.inflight = false;
    publish('stopped');
  }

  function dispose() {
    disposed = true;
    stop();
  }

  return {
    get status() { return status; },
    evaluate,
    stop,
    dispose,
  };
}
