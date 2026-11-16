import { hiveLink } from './deep-links.js';

export function createWatchdogNotifications(api, { read = () => [], write = () => {}, open = href => { globalThis.location.hash = href; } } = {}) {
  const seen = new Set(read() || []), shown = new Map();
  return hive => {
    if (!hive || hive.metadataError || hive.backend?.snapshotError) return;
    const current = new Map();
    for (const cell of Object.values(hive.cells || {})) {
      if (!cell.enabled || cell.snapshot) continue;
      for (const flag of Object.values(cell.watchdogFlags || {})) {
        if (!['stalled_worker', 'aborted_turn', 'errored_turn'].includes(flag.kind)) continue;
        const episode = JSON.stringify([cell.id, flag.id, flag.episodeAt ?? flag.since]);
        current.set(episode, { cell, flag });
      }
    }
    for (const [episode, token] of shown) if (!current.has(episode)) {
      api.ui?.withdraw?.(token.id);
      shown.delete(episode);
    }
    for (const [episode, { cell, flag }] of current) {
      if (seen.has(episode) || !api.ui?.notify) continue;
      const token = { id: `hive-stalled:${episode}` };
      const actions = [{ id: 'bead', label: 'View cell', primary: true }];
      if (flag.session_link) actions.push({ id: 'session', label: 'Open session' });
      seen.add(episode); shown.set(episode, token);
      write([...seen].slice(-2000));
      try {
        Promise.resolve(api.ui.notify({ id: token.id, title: 'Hive worker stalled', body: `${flag.bead_id}: ${flag.reason}`, actions })).then(action => {
          if (shown.get(episode) !== token || token.consumed) return;
          token.consumed = true;
          if (action === 'bead') open(hiveLink(cell.id, null, null, { beadId: flag.bead_id, pane: 'details' }));
          if (action === 'session' && flag.session_link) open(flag.session_link);
        }).catch(() => {});
      } catch {}
    }
  };
}
