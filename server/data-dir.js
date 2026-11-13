import os from 'node:os';
import path from 'node:path';

function expandTilde(p) {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

export function wranglerDataDir(env = process.env) {
  return env.AW_DATA_DIR ? path.resolve(expandTilde(env.AW_DATA_DIR)) : path.join(os.homedir(), '.agent-wrangler');
}

export function hivePaths(env = process.env) {
  const root = path.join(wranglerDataDir(env), 'hive');
  return {
    root,
    metadataFile: path.join(root, 'metadata.json'),
    beadsWorkspace: path.join(root, 'beads'),
    bdHome: path.join(root, 'bd-home'),
    scratch: path.join(root, 'tmp'),
  };
}
