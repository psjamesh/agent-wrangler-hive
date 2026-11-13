const fields = ['title', 'id', 'goal', 'summary', 'acceptance', 'nextAction', 'evidence'];

export const SEARCH_FIELD_LABELS = { id: 'bead id', nextAction: 'next action' };

export function rankBeads(beads, query) {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const results = [];
  for (const bead of beads) {
    for (let rank = 0; rank < fields.length; rank++) {
      const field = fields[rank];
      const value = field === 'evidence'
        ? (bead.evidence || []).map(e => [e.label, e.detail, e.url].filter(Boolean).join(' ')).join(' ')
        : bead[field];
      if (String(value || '').toLowerCase().includes(needle)) {
        results.push({ id: bead.id, field, rank });
        break;
      }
    }
  }
  return results.sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id));
}
