const RESTORE_GRACE_MS = 10 * 60 * 1000;

export function activeWorkerRestores(rt, now = Date.now()) {
  const restores = rt.workerRestores ||= new Map();
  for (const [sid, restore] of restores) if (now - restore.at >= RESTORE_GRACE_MS) restores.delete(sid);
  return restores;
}

export function onResume({ sessionId, host }) {
  host?.stores?.hive?.workerRestores?.delete(sessionId);
}
