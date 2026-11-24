export function monitoringProblem(rt) {
  if (rt.snapshots.current?.error) return `Hive cannot reconcile work because its Beads snapshot failed: ${rt.snapshots.current.error}`;
  const status = rt.beads?.status;
  if (status && !['ready', 'unknown'].includes(status.state)) return `Hive cannot reconcile work because Beads is unavailable: ${status.detail || status.state}`;
  return null;
}
