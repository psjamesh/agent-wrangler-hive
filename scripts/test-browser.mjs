import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const chrome = process.env.HIVE_TEST_CHROME;
if (!chrome) {
  console.log('Browser tests skipped: set HIVE_TEST_CHROME to a Chrome binary.');
  process.exit(0);
}
assert.ok(process.env.HIVE_CORE_PUBLIC, 'Set HIVE_CORE_PUBLIC to the Agent Wrangler core public directory.');

const profile = await mkdtemp(join(tmpdir(), 'hive-browser-ci-'));
const child = spawn(chrome, [
  '--headless=new', `--user-data-dir=${profile}`, '--disable-gpu',
  '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });
let errors = '', launchError;
child.stderr.on('data', data => { errors += data; });
child.on('error', error => { launchError = error; });
const exited = new Promise(resolve => { child.once('exit', resolve); child.once('error', resolve); });
try {
  let port;
  for (let i = 0; i < 100; i++) {
    try { port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); break; } catch { }
    if (launchError || child.exitCode !== null || child.signalCode !== null) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(Number.isInteger(port) && port > 0 && port !== 7777, `Isolated Chrome did not launch: ${launchError || errors}`);
  const files = (await readdir('test')).filter(name =>
    name.endsWith('.browser.mjs') || /(?:\.browser|-browser)\.test\.mjs$/.test(name));
  const tests = files.filter(name => name !== 'global-inbox.browser.mjs').sort();
  const output = resolve(process.env.HIVE_SCREENSHOT_DIR || join(tmpdir(), 'hive-browser-artifacts'));
  for (const file of tests) {
    const shots = join(output, file);
    await mkdir(shots, { recursive: true });
    console.log(`\nRunning ${file}`);
    const test = spawn(process.execPath, ['--test', '--test-timeout=120000', join('test', file)], {
      stdio: 'inherit',
      env: { ...process.env, HIVE_TEST_CDP: String(port), HIVE_AUTO_FIT_BROWSER: '1', HIVE_SCREENSHOT_DIR: shots, HIVE_SHOT_DIR: shots },
      timeout: 150000,
    });
    await new Promise((resolve, reject) => {
      test.once('error', reject);
      test.once('exit', (code, signal) => code === 0 ? resolve() : reject(Error(`${file} failed (${signal || code})`)));
    });
  }
} finally {
  if (child.exitCode === null && child.signalCode === null && !launchError) child.kill();
  await exited;
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
