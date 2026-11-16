import { chmodSync, existsSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const DENIED_CLIS = ['claude', 'codex', 'gemini', 'gh', 'ssh', 'open', 'osascript', 'curl', 'wget'];
const TMUX_ALLOWED = ['start-server', 'kill-server', 'list-sessions', 'ls', 'list-windows', 'list-panes', 'list-clients', 'has-session', 'has', 'display-message', 'display', 'show-options', 'show', 'show-environment', 'kill-session', 'kill-window', 'kill-pane', 'refresh-client', 'capture-pane', 'set-option', 'set', 'set-environment', 'set-window-option', 'setw', 'show-window-options', 'showw', 'list-buffers', 'info'];

const find = (name) => {
  try { return realpathSync(execFileSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).trim()); } catch { return ''; }
};

export function createGuard(dataDir) {
  const guard = join(dataDir, 'guard');
  const bin = join(guard, 'bin');
  const log = join(guard, 'denied.log');
  mkdirSync(bin, { recursive: true });
  writeFileSync(log, '');

  const deny = (name, why) => `#!/bin/sh\nprintf '%s\\t%s\\t%s\\n' "$(date +%s)" '${name}' "$*" >> '${log}'\necho 'Blocked by the capture-only guard: ${why}' >&2\nexit 126\n`;
  for (const cli of DENIED_CLIS) {
    const file = join(bin, cli);
    writeFileSync(file, deny(cli, `${cli} is never launched in the disposable capture instance`));
    chmodSync(file, 0o755);
  }

  const realTmux = find('tmux');
  if (!realTmux) throw new Error('tmux not found.');
  const allow = TMUX_ALLOWED.join('|');
  const socket = `awcap-${randomBytes(5).toString('hex')}`;
  const tmuxWrapper = `#!/bin/sh
deny() {
  printf '%s\\t%s\\t%s\\n' "$(date +%s)" tmux "$*" >> '${log}'
  echo 'Blocked by the capture-only guard: tmux cannot create or drive panes in the disposable capture instance' >&2
  exit 126
}
while [ $# -gt 0 ]; do
  case "$1" in
    -L|-S|-f) if [ $# -ge 2 ]; then printf '%s\\tredirect\\t%s %s\\n' "$(date +%s)" "$1" "$2" >> '${log}'; shift 2; else shift; fi ;;
    -c|-C|-CC|-D) deny "$@" ;;
    -*) shift ;;
    *) break ;;
  esac
done
sub="$1"
case "$sub" in
  ${allow}|"") exec '${realTmux}' -L '${socket}' -f /dev/null "$@" ;;
esac
deny "$@"
`;
  writeFileSync(join(bin, 'tmux'), tmuxWrapper);
  chmodSync(join(bin, 'tmux'), 0o755);

  for (const name of ['node', 'bd', 'dolt', 'git']) {
    const target = name === 'node' ? process.execPath : find(name);
    if (target && !existsSync(join(bin, name))) symlinkSync(target, join(bin, name));
  }

  const PATH = `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`;
  const keep = ['TMPDIR', 'LANG', 'LC_ALL', 'TERM', 'USER', 'LOGNAME', 'SHELL'];
  const env = { PATH, HOME: join(dataDir, 'home') };
  for (const key of keep) if (process.env[key]) env[key] = process.env[key];
  Object.assign(env, { AW_NO_OPEN: '1', AW_OPEN_BROWSER: '', GITHUB_TOKEN: '', GH_TOKEN: '', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' });
  mkdirSync(env.HOME, { recursive: true });

  return { bin, log, env, PATH, realTmux, socket };
}

export function verifyGuard(guard) {
  const run = (cmd, args) => { try { execFileSync(cmd, args, { env: guard.env, stdio: 'ignore' }); return 0; } catch (e) { return e.status ?? 1; } };
  const checks = [];
  for (const cli of ['claude', 'codex', 'gemini', 'gh']) checks.push([`${cli} blocked`, run(cli, ['--version']) === 126]);
  checks.push(['tmux new-session blocked', run('tmux', ['new-session', '-d', '-s', 'guardcheck']) === 126]);
  checks.push(['tmux send-keys blocked', run('tmux', ['send-keys', '-t', 'guardcheck', 'x']) === 126]);
  checks.push(['tmux run-shell blocked', run('tmux', ['run-shell', 'true']) === 126]);
  checks.push(['tmux respawn-pane blocked', run('tmux', ['respawn-pane', '-k']) === 126]);
  checks.push(['no provider binary resolves outside the guard', ['claude', 'codex', 'gemini'].every(c => execFileSync('sh', ['-c', `command -v ${c}`], { env: guard.env, encoding: 'utf8' }).trim().startsWith(guard.bin))]);
  const pinned = (args) => { try { return execFileSync('tmux', args, { env: guard.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { return `${e.stdout || ''}${e.stderr || ''}`; } };
  pinned(['-L', 'default', 'list-sessions']); pinned(['-S', '/tmp/not-the-capture-socket', 'list-sessions']); pinned(['list-sessions']);
  const redirects = execFileSync('cat', [guard.log], { encoding: 'utf8' }).split('\n').filter(l => l.includes('\tredirect\t'));
  checks.push(['tmux -L and -S requests are redirected to the capture-only socket', redirects.length >= 2]);
  checks.push(['tmux -c / -C top-level commands blocked', run('tmux', ['-c', 'true']) === 126 && run('tmux', ['-C']) === 126]);
  const failed = checks.filter(([, ok]) => !ok).map(([n]) => n);
  if (failed.length) throw new Error(`Inert guard self-check failed: ${failed.join(', ')}`);
  return checks.map(([n]) => n);
}

export const guardLog = (guard) => { try { return execFileSync('cat', [guard.log], { encoding: 'utf8' }).trim().split('\n').filter(Boolean); } catch { return []; } };
