import { canonicalPrUrl } from '../public/pr-url.js';
import { cellOfBead } from './access.js';

export function trackEvidencePrs(runtime, cell, bead, now = Date.now()) {
  const urls = [...new Set((bead.evidence || []).map(entry => canonicalPrUrl(entry.url)).filter(Boolean))];
  if (!urls.length) return;
  const known = runtime.metadata.read().prLabels || {};
  const keys = new Map(Object.entries(known).map(([key, record]) => [canonicalPrUrl(record?.url), key]));
  const missing = urls.map(url => ({ url, key: keys.get(url) || url })).filter(({ key }) =>
    !known[key]?.associations?.some(a => a.cellId === cell.id && a.beadId === bead.id));
  if (!missing.length) return;
  runtime.metadata.mutate(doc => {
    doc.prLabels ||= {};
    for (const { url, key } of missing) {
      const record = doc.prLabels[key] ||= { url, source: 'bead-evidence', sessionId: null,
        firstSeenAt: now, enrolledAt: now, status: 'unlabelled', labelledAt: null, state: null, stateCheckedAt: null };
      if (record.associations?.some(a => a.cellId === cell.id && a.beadId === bead.id)) continue;
      record.cellIds = [...new Set([...(record.cellIds || []), cell.id])];
      record.beadIds = [...new Set([...(record.beadIds || []), bead.id])];
      record.associations = [...(record.associations || []), { cellId: cell.id, beadId: bead.id, kind: 'bead-evidence' }];
    }
  });
}

export function backfillEvidencePrs(runtime, now = Date.now()) {
  for (const bead of Object.values(runtime.snapshots?.graph?.beads || {})) {
    if (!bead.evidence?.some(entry => canonicalPrUrl(entry.url))) continue;
    const cell = cellOfBead(runtime, bead.id);
    if (cell?.enabled && !cell.snapshot) trackEvidencePrs(runtime, cell, bead, now);
  }
}
