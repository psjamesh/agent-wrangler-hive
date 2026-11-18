import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom, byTag, fire, walk } from './helpers/dom.mjs';
import { openNewRoutine, newRoutineKey, routineDrawer, routineDetails } from '../public/routine-view.js';
import { beadTile, primaryKind } from '../public/cell-view.js';
import { messageAuthor } from '../public/conversation.js';

const config = { name: 'Check-in', days: [1, 3], time: '09:00', timeZone: 'Europe/London', message: 'Review priorities.', enabled: true, nextRunAt: Date.parse('2026-11-19T09:00:00Z'), lastRunAt: Date.parse('2026-11-18T09:00:00Z'), lastOutcome: 'delivered' };
const cell = { id: 'cell', enabled: true, rootBeadId: 'root' };
const bead = { id: 'routine', kind: 'routine', title: config.name, parentId: 'schedules', status: 'open', schedule: config };
const button = (node, text) => byTag(node, 'button').find(b => b.textContent === text);
const error = node => walk(node).find(n => n.getAttribute('class') === 'hive-dialog-error')?.textContent;

function fixture(t) {
  installDom(t);
  const forms = {}, sent = [], selected = [], refreshed = [];
  const ui = { form: key => forms[key] || null, setForm: (key, v) => { forms[key] = v; }, patchForm: (key, patch) => { forms[key] = { ...forms[key], ...patch }; }, selectBead: id => selected.push(id), retryBeadDetail: id => refreshed.push(id) };
  return { ui, forms, sent, selected, refreshed, ctx: { ui, send: (m, options) => sent.push([m, options.onReply]), notice() {} } };
}

test('creation validates, sends the normalized schedule once, preserves errors and selects the saved routine', t => {
  const f = fixture(t);
  openNewRoutine(f.ctx, cell);
  const key = newRoutineKey(cell.id);
  let drawer = routineDrawer(f.ctx, cell);
  fire(byTag(drawer, 'form')[0], 'submit');
  assert.equal(f.sent.length, 0);
  assert.match(error(routineDrawer(f.ctx, cell)), /Name/);
  f.ui.patchForm(key, config);
  fire(byTag(routineDrawer(f.ctx, cell), 'form')[0], 'submit');
  fire(byTag(routineDrawer(f.ctx, cell), 'form')[0], 'submit');
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0][0].action, 'create');
  assert.deepEqual(f.sent[0][0].schedule.days, [1, 3]);
  f.sent[0][1]({ ok: false, error: 'Store unavailable.' });
  assert.equal(error(routineDrawer(f.ctx, cell)), 'Store unavailable.');
  assert.equal(f.forms[key].message, config.message);
  fire(byTag(routineDrawer(f.ctx, cell), 'form')[0], 'submit');
  f.sent[1][1]({ ok: true, bead_id: bead.id });
  assert.equal(f.forms[key], null);
  assert.deepEqual(f.selected, [bead.id]);
});

test('Details shows cadence, runs and outcome, edits time zones and sends pause/resume/run/end actions', t => {
  const f = fixture(t);
  const render = b => routineDetails(f.ctx, cell, b || bead);
  assert.match(render().textContent, /Mon, Wed at 09:00 \(Europe\/London\)/);
  assert.match(render().textContent, /Next run:/);
  assert.match(render().textContent, /Last run:.*delivered/);
  button(render(), 'Edit schedule').click();
  const formKey = `routine:${cell.id}:${bead.id}`;
  f.ui.patchForm(formKey, { timeZone: 'No/Such_Zone' });
  fire(byTag(render(), 'form')[0], 'submit');
  assert.match(error(render()), /IANA/);
  f.ui.patchForm(formKey, { timeZone: 'America/New_York', time: '10:15' });
  fire(byTag(render(), 'form')[0], 'submit');
  assert.equal(f.sent[0][0].schedule.time, '10:15');
  f.sent[0][1]({ ok: true, bead_id: bead.id });
  for (const [label, action, enabled] of [['Pause', 'pause', true], ['Resume', 'resume', false], ['Run now', 'run-now', false], ['End schedule', 'end', true]]) {
    button(render({ ...bead, schedule: { ...config, enabled } }), label).click();
    const [msg, reply] = f.sent.at(-1);
    assert.deepEqual(msg, { type: 'hive-routine', cellId: cell.id, beadId: bead.id, action });
    reply({ ok: true });
  }
});

test('read-only and ended routines have no mutating controls; schedule tiles always use a clock and reserved colour', t => {
  const f = fixture(t);
  for (const c of [{ ...cell, enabled: false }, { ...cell, snapshot: {} }, { ...cell, retired: {} }]) {
    assert.equal(byTag(routineDetails(f.ctx, c, bead), 'button').length, 0);
    openNewRoutine(f.ctx, c);
    assert.equal(routineDrawer(f.ctx, c), null);
  }
  assert.equal(byTag(routineDetails(f.ctx, cell, { ...bead, status: 'closed' }), 'button').length, 0);
  assert.equal(primaryKind(bead, [], ['working']), 'clock');
  assert.equal(primaryKind({ system: 'schedules', status: 'open' }, [], []), 'clock');
  const hive = { cells: { cell }, beads: { routine: bead }, edges: [] };
  const tile = beadTile({ hive, graph: {} }, bead, { cellId: 'cell', layout: { groupHeads: [], parentHead: {}, halo: {} } }, new Map());
  assert.match(tile.classes, /hive-ws-cschedule/);
  assert.equal(tile.mark.kind, 'clock');
  assert.equal(messageAuthor({}, cell, { author: 'human', scheduled: { routineId: bead.id } }), 'Schedule');
});
