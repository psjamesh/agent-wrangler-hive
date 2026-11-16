import test from 'node:test';
import assert from 'node:assert/strict';
import { createWatchdogNotifications } from './watchdog-notifications.js';

for (const kind of ['stalled_worker', 'aborted_turn', 'errored_turn']) {
  test(`${kind} toasts dedupe durably per episode and link to session and bead`, async () => {
    const shown = [], opened = [], withdrawn = [];
    let saved = [], action;
    const api = { ui: { notify: args => { shown.push(args); return new Promise(resolve => { action = resolve; }); }, withdraw: id => withdrawn.push(id) } };
    const options = { read: () => saved, write: value => { saved = value; }, open: href => opened.push(href) };
    const graph = (episodeAt = 1, flagKind = kind) => ({ cells: { cell: { id: 'cell', enabled: true, watchdogFlags: { flag: { id: 'flag', kind: flagKind, episodeAt, reason: 'Worker idle', session_id: 'worker', session_link: '#session=worker', bead_id: 'work' } } } } });
    const notify = createWatchdogNotifications(api, options);
    notify(graph()); notify(graph());
    assert.equal(shown.length, 1);
    action('session'); await Promise.resolve();
    assert.equal(opened[0], '#session=worker');
    createWatchdogNotifications(api, options)(graph());
    assert.equal(shown.length, 1);
    notify({ cells: {} });
    assert.equal(withdrawn.length, 1);
    notify(graph(2));
    assert.equal(shown.length, 2);
    action('bead'); await Promise.resolve();
    assert.match(opened[1], /hive=cell&bead=work/);
    notify(graph(3, 'stale_wait'));
    assert.equal(shown.length, 2);
  });
}
