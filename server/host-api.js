export function hostApiAtLeast(host, major, minor, patch = 0) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:\+[\w.-]+)?$/.exec(host?.version || '');
  if (!match) return false;
  const actual = match.slice(1).map(Number);
  const required = [major, minor, patch];
  for (let i = 0; i < required.length; i++) {
    if (actual[i] !== required[i]) return actual[i] > required[i];
  }
  return true;
}
