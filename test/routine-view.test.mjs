import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom, byTag, fire, walk } from './helpers/dom.mjs';
import { openNewRoutine, newRoutineKey, schedulesView, scheduleCard } from '../public/routine-view.js';
import { messageAuthor } from '../public/conversation.js';

const config = { name: 'Check-in', days: [1, 3], time: '09:00', timeZone: 'Europe/London', message: 'Review priorities.', enabled: true, nextRunAt: Date.parse('2026-11-19T09:00:00Z'), lastRunAt: Date.parse('2026-11-18T09:00:00Z'), lastOutcome: 'delivered' };
const cell = { id: 'cell', enabled: true, rootBeadId: 'root' };
const schedule = { id: 'sched_test', cellId: cell.id, threadId: 'thr_test', ...config };
cell.schedules = [schedule];
const button = (node, text) => byTag(node, 'button').find(b => b.textContent === text);
const error = node => walk(node).find(n => n.getAttribute('class') === 'hive-dialog-error')?.textContent;

function fixture(t) {
  installDom(t);
  const forms = {}, sent = [], selected = [], refreshed = [];
  const ui = { form: key => forms[key] || null, setForm: (key, v) => { forms[key] = v; }, patchForm: (key, patch) => { forms[key] = { ...forms[key], ...patch }; }, selectBead: id => selected.push(id), retryBeadDetail: id => refreshed.push(id) };
  return { ui, forms, sent, selected, refreshed, ctx: { ui, send: (m, options) => sent.push([m, options.onReply]), notice() {} } };
}

test('creation validates, sends the normalized schedule once, preserves errors and stays in Schedules', t => {
  const f = fixture(t);
  openNewRoutine(f.ctx, cell);
  const key = newRoutineKey(cell.id);
  let drawer = schedulesView(f.ctx, cell);
  fire(byTag(drawer, 'form')[0], 'submit');
  assert.equal(f.sent.length, 0);
  assert.match(error(schedulesView(f.ctx, cell)), /Name/);
  f.ui.patchForm(key, config);
  fire(byTag(schedulesView(f.ctx, cell), 'form')[0], 'submit');
  fire(byTag(schedulesView(f.ctx, cell), 'form')[0], 'submit');
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0][0].action, 'create');
  assert.deepEqual(f.sent[0][0].schedule.days, [1, 3]);
  f.sent[0][1]({ ok: false, error: 'Store unavailable.' });
  assert.equal(error(schedulesView(f.ctx, cell)), 'Store unavailable.');
  assert.equal(f.forms[key].message, config.message);
  fire(byTag(schedulesView(f.ctx, cell), 'form')[0], 'submit');
  f.sent[1][1]({ ok: true, schedule_id: schedule.id });
  assert.equal(f.forms[key], null);
  assert.deepEqual(f.selected, []);
});

test('Schedule cards show cadence and run outcomes, edit time zones and send pause/resume/run/delete actions', t => {
  const f = fixture(t);
  const render = b => scheduleCard(f.ctx, cell, b || schedule);
  assert.match(render().textContent, /Mon, Wed at 09:00 \(Europe\/London\)/);
  assert.match(render().textContent, /Next run:/);
  assert.match(render().textContent, /Last run:.*delivered/);
  button(render(), 'Edit schedule').click();
  const formKey = `routine:${cell.id}:${schedule.id}`;
  f.ui.patchForm(formKey, { timeZone: 'No/Such_Zone' });
  fire(byTag(render(), 'form')[0], 'submit');
  assert.match(error(render()), /IANA/);
  f.ui.patchForm(formKey, { timeZone: 'America/New_York', time: '10:15' });
  fire(byTag(render(), 'form')[0], 'submit');
  assert.equal(f.sent[0][0].schedule.time, '10:15');
  f.sent[0][1]({ ok: true, schedule_id: schedule.id });
  for (const [label, action, enabled] of [['Pause', 'pause', true], ['Resume', 'resume', false], ['Run now', 'run-now', false], ['Delete', 'delete', true]]) {
    button(render({ ...schedule, enabled }), label).click();
    const [msg, reply] = f.sent.at(-1);
    assert.deepEqual(msg, { type: 'hive-routine', cellId: cell.id, scheduleId: schedule.id, action });
    reply({ ok: true });
  }
});

test('Schedules view lists records and opens their topics, with no mutating controls in read-only hives', t => {
  const f = fixture(t);
  const opened = [];
  let view = schedulesView(f.ctx, cell, r => opened.push(r.threadId));
  assert.match(view.textContent, /Check-in/);
  button(view, 'Open topic').click();
  assert.deepEqual(opened, [schedule.threadId]);
  button(view, 'New schedule').click();
  assert.ok(f.ui.form(newRoutineKey(cell.id)));
  for (const c of [{ ...cell, enabled: false }, { ...cell, snapshot: {} }, { ...cell, retired: {} }]) {
    view = schedulesView(f.ctx, c);
    assert.deepEqual(byTag(view, 'button').map(b => b.textContent), ['Open topic']);
    assert.equal(byTag(view, 'form').length, 0);
  }
  assert.equal(messageAuthor({}, cell, { author: 'human', scheduled: { scheduleId: schedule.id } }), 'Schedule');
});
