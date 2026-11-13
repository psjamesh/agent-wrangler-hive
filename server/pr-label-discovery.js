import { participation } from './access.js';
import { isCurrent } from './lifetime.js';
import { createPrLabeler, prRepository } from './pr-labels.js';
import { createPrTracker } from './pr-tracking.js';

function canReadLinks(host) {
  const [major, minor] = String(host?.version || '').split('.').map(Number);
  return major === 1 && minor >= 70 && typeof host?.links?.get === 'function';
}

export function createPrLabelSweep({ runtime, host, labeler = createPrLabeler(), tracker = createPrTracker(), now = Date.now }) {
  let running = false;
  let stopped = false;
  const active = () => !stopped && isCurrent(runtime, host);
  function eligible(prUrl) {
    const record = runtime.metadata.read().prLabels?.[prUrl];
    return active() && canReadLinks(host) && record?.url === prUrl && record.source === 'session-link' && record.status === 'pending';
  }
  return {
    stop() { stopped = true; labeler.stop(); tracker.stop(); },
    async run() {
      if (running || !active() || !canReadLinks(host)) return;
      running = true;
      try {
        const discovered = new Map();
        for (const session of host.sessions.list()) {
          try {
            const sid = session.sessionId;
            const cells = participation(runtime, host, sid).map(({ cell }) => cell);
            const bindings = runtime.metadata.read().bindings;
            const associations = cells.flatMap(cell => {
              const beads = [...new Set((bindings[cell.id] || []).filter(binding => binding.active && binding.sessionId === sid && binding.beadId).map(binding => binding.beadId))];
              if (beads.length) return beads.map(beadId => ({ cellId: cell.id, beadId, kind: 'binding' }));
              return cell.rootBeadId ? [{ cellId: cell.id, beadId: cell.rootBeadId, kind: 'cell-root' }] : [];
            });
            if (!cells.length) continue;
            for (const link of host.links.get(sid)) {
              if (link.type !== 'pr' || !prRepository(link.url) || discovered.has(link.url)) continue;
              discovered.set(link.url, { url: link.url, source: 'session-link', sessionId: sid, cellIds: cells.map(cell => cell.id), associations, beadIds: [...new Set(associations.map(row => row.beadId))], firstSeenAt: now(), enrolledAt: now(), status: 'pending', labelledAt: null, state: null, stateCheckedAt: null });
            }
          } catch {}
        }
        const known = runtime.metadata.read().prLabels || {};
        const fresh = [...discovered.values()].filter(record => !Object.hasOwn(known, record.url) || known[record.url]?.source === 'label-search');
        if (active() && fresh.length) runtime.metadata.mutate(doc => {
          doc.prLabels ||= {};
          for (const record of fresh) {
            const existing = doc.prLabels[record.url];
            if (!existing) doc.prLabels[record.url] = record;
            else if (existing.source === 'label-search') Object.assign(existing, { source: record.source, sessionId: record.sessionId, cellIds: record.cellIds, associations: record.associations, beadIds: record.beadIds, enrolledAt: record.enrolledAt });
          }
        });
        const repos = [...new Set(Object.values(runtime.metadata.read().prLabels || {}).map(record => prRepository(record?.url)).filter(Boolean))];
        for (const repo of repos) {
          if (!active()) break;
          const found = await tracker.search(repo);
          if (!active()) return;
          const unknown = found.filter(url => !Object.hasOwn(runtime.metadata.read().prLabels || {}, url));
          if (unknown.length) runtime.metadata.mutate(doc => {
            for (const url of unknown) if (!Object.hasOwn(doc.prLabels, url)) doc.prLabels[url] = { url, source: 'label-search', sessionId: null, cellIds: [], associations: [], beadIds: [], firstSeenAt: now(), enrolledAt: null, status: 'labelled', labelledAt: now(), state: null, stateCheckedAt: null };
          });
        }
        for (const record of Object.values(runtime.metadata.read().prLabels || {})) {
          if (!active() || !canReadLinks(host)) break;
          if (!record || !prRepository(record.url) || !eligible(record.url)) continue;
          try {
            const result = await labeler.apply(record.url, () => eligible(record.url));
            if (!active()) return;
            if (result !== 'labelled' && result !== 'present') continue;
            runtime.metadata.mutate(doc => {
              const saved = doc.prLabels[record.url];
              if (saved?.status === 'pending') { saved.status = 'labelled'; saved.labelledAt = now(); }
            });
          } catch {}
        }
        const observations = [];
        for (const record of Object.values(runtime.metadata.read().prLabels || {})) {
          if (!active() || !canReadLinks(host)) break;
          const observed = await tracker.state(record?.url);
          if (!active()) return;
          if (observed) observations.push({ url: record.url, ...observed });
        }
        if (active() && observations.length) runtime.metadata.mutate(doc => {
          for (const observed of observations) {
            const saved = doc.prLabels[observed.url];
            if (saved && observed.observationError) {
              saved.observationError = observed.observationError;
            } else if (saved) {
              const { url, checkedAt, ...fields } = observed;
              Object.assign(saved, fields, { stateCheckedAt: checkedAt });
              if (saved.humanAttention?.headSha !== saved.headSha) saved.humanAttention = null;
            }
          }
        });
      } catch {} finally {
        running = false;
      }
    },
  };
}
