import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export function launchDirectory(t, git = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-worker-cwd-'));
  const previous = process.env.GIT_CEILING_DIRECTORIES;
  process.env.GIT_CEILING_DIRECTORIES = fs.realpathSync(path.dirname(dir));
  t.after(() => {
    if (previous === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
    else process.env.GIT_CEILING_DIRECTORIES = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  if (git) execFileSync('git', ['init', dir], { stdio: 'pipe' });
  const cwd = path.join(dir, 'nested');
  fs.mkdirSync(cwd);
  return cwd;
}
