import test from 'node:test';
import assert from 'node:assert/strict';
import { actionMetadata } from '../public/action-diagnostics.js';
import client, { send } from '../public/client.js';
import { humanHandler, configHandlers } from '../server/handlers.js';

const secret = 'private message body';
const args = { cellId: 'cell_demo', beadId: 'hive-demo', threadId: 'thr_demo', messageId: 'msg_demo', request: { request_id: 'req_demo', text: secret }, text: secret, queen: { intent: secret } };
const parsed = logs => logs.map(line => {
  assert.ok(line.startsWith('hive: action-timing '));
  assert.ok(!line.includes(secret));
  return JSON.parse(line.slice('hive: action-timing '.length));
});

for (const outcome of ['ok', 'error', 'transport']) {
  test(`client timeout and late ${outcome} reach the server logger without content`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
    const logs = [], replies = [], reports = [], notices = [];
    const rt = { log: line => logs.push(line), changed() {} };
    const diagnostic = configHandlers.find(h => h.type === 'hive-action-diagnostic');
    let resolve, reject;
    client.register({ api: { ui: { toast: notice => { notices.push(notice); return true; } }, act(type, data) {
      if (type === 'hive-action-diagnostic') {
        reports.push(data);
        assert.ok(diagnostic, 'diagnostic action is registered');
        return diagnostic.handler(data, { stores: { hive: rt } }, () => {}).then(() => ({ ok: true }));
      }
      return new Promise((yes, no) => { resolve = yes; reject = no; });
    } }, register() {} });
    const requestId = send({ type: 'hive-human-message', ...args }, { quiet: true, onReply: r => replies.push(r) });
    t.mock.timers.tick(30000);
    assert.equal(replies.length, 1);
    assert.equal(replies[0].timeout, true);
    assert.equal(reports.length, 1);
    t.mock.timers.tick(7000);
    if (outcome === 'transport') reject(new Error(`Failed: ${secret}`));
    else resolve(outcome === 'ok' ? { ok: true, data: { ok: true } } : { ok: true, data: { ok: false, error: `Refused: ${secret}` } });
    await new Promise(queueMicrotask);
    const events = parsed(logs);
    assert.deepEqual(events.map(e => e.event), ['client-timeout', 'late-reply']);
    for (const event of events) {
      assert.equal(event.action, 'hive-human-message');
      assert.equal(event.requestId, requestId);
      assert.equal(event.ids.cellId, args.cellId);
      assert.equal(event.ids.beadId, args.beadId);
      assert.equal(event.ids['request.request_id'], 'req_demo');
    }
    assert.equal(events[0].elapsedMs, 30000);
    assert.equal(events[0].timestamp, new Date(130000).toISOString());
    assert.equal(events[1].elapsedMs, 37000);
    assert.equal(events[1].outcome, outcome === 'ok' ? 'ok' : 'error');
    if (outcome !== 'ok') assert.match(events[1].error, /\[redacted\]/);
    assert.equal(replies.length, 1, 'late reply must not repeat the callback');
    assert.equal(notices.length, outcome === 'ok' ? 0 : 1);
    if (outcome !== 'ok') {
      assert.equal(notices[0].severity, 'error');
      assert.equal(notices[0].text, `${outcome === 'transport' ? 'Failed' : 'Refused'}: ${secret}`);
    }
    assert.ok(!JSON.stringify(reports).includes(secret));
  });
}

for (const fail of [false, true]) {
  test(`server logs slow ${fail ? 'failed' : 'successful'} action using rt.log`, async t => {
    t.mock.timers.enable({ apis: ['Date'], now: 100000 });
    const logs = [], replies = [];
    const handler = humanHandler('hive-example', async () => {
      t.mock.timers.tick(5001);
      if (fail) throw Object.assign(new Error(`Refused: ${secret}`), { code: 'refused' });
    });
    await handler.handler({ ...args, requestId: 'r_demo' }, { stores: { hive: { log: line => logs.push(line), changed() {} } } }, r => replies.push(r));
    const [event] = parsed(logs);
    assert.equal(logs.length, 1);
    assert.equal(event.event, 'server-slow');
    assert.equal(event.action, 'hive-example');
    assert.equal(event.requestId, 'r_demo');
    assert.equal(event.elapsedMs, 5001);
    assert.equal(event.outcome, fail ? 'error' : 'ok');
    assert.equal(event.ids.messageId, 'msg_demo');
    if (fail) assert.equal(event.error, 'Refused: [redacted]');
    assert.equal(replies[0].ok, !fail);
  });
}

test('fast actions do not produce timing logs', async () => {
  const logs = [];
  await humanHandler('hive-example', async () => {}).handler({}, { stores: { hive: { log: line => logs.push(line), changed() {} } } }, () => {});
  assert.deepEqual(logs, []);
});

test('metadata includes only named identifiers, including nested ids and lists', () => {
  const metadata = actionMetadata('hive-example', 'r_demo', {
    ...args, sessionIds: ['session-demo', secret], text: secret,
    messages: [{ messageId: 'msg_nested', text: secret }],
    [secret]: { messageId: 'msg_hidden' },
  });
  assert.equal(metadata.ids['messages.0.messageId'], 'msg_nested');
  assert.deepEqual(metadata.ids.sessionIds, ['session-demo']);
  assert.ok(!JSON.stringify(metadata).includes(secret));
  assert.ok(!JSON.stringify(metadata).includes('msg_hidden'));
});

test('diagnostic action discards content fields and invalid reports', async () => {
  const logs = [];
  const diagnostic = configHandlers.find(h => h.type === 'hive-action-diagnostic');
  const host = { stores: { hive: { log: line => logs.push(line) } } };
  await diagnostic.handler({ event: 'client-timeout', action: 'hive-example', requestId: 'r_demo', elapsedMs: 30000, timestamp: new Date(0).toISOString(), text: secret, ids: { text: secret, cellId: 'cell_demo', [secret]: 'cell_bad', 'confidential.beadId': 'hive-hidden' } }, host, () => {});
  assert.deepEqual(parsed(logs)[0].ids, { cellId: 'cell_demo' });
  await diagnostic.handler({ event: secret, elapsedMs: Infinity }, host, () => {});
  assert.equal(logs.length, 1);
});

test('failed diagnostic delivery does not create another timed request', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 200000 });
  const calls = [];
  client.register({ api: { act(type) {
    calls.push(type);
    return type === 'hive-action-diagnostic' ? Promise.reject(new Error('offline')) : new Promise(() => {});
  } }, register() {} });
  send({ type: 'hive-example' }, { quiet: true, onReply() {} });
  t.mock.timers.tick(30000);
  await new Promise(queueMicrotask);
  t.mock.timers.tick(300000);
  assert.deepEqual(calls, ['hive-example', 'hive-action-diagnostic']);
});

test('promise replies remain correlated after the bounded notification cache evicts them', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 300000 });
  const reports = [], resolvers = [];
  client.register({ api: { act(type, args) {
    if (type === 'hive-action-diagnostic') { reports.push(args); return Promise.resolve({ ok: true }); }
    return new Promise(resolve => resolvers.push(resolve));
  } }, register() {} });
  const first = send({ type: 'hive-example' }, { quiet: true, onReply() {} });
  for (let i = 0; i < 256; i++) send({ type: 'hive-example' }, { quiet: true, onReply() {} });
  t.mock.timers.tick(30000);
  resolvers[0]({ ok: true, data: { ok: true } });
  await new Promise(queueMicrotask);
  assert.equal(reports.at(-1).event, 'late-reply');
  assert.equal(reports.at(-1).requestId, first);
});

test('a late pushed reply is logged and shown without repeating the original callback', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 400000 });
  const reports = [], notices = [], replies = [];
  let deliver;
  client.register({ api: {
    ui: { toast: notice => { notices.push(notice); return true; } },
    act(type, args) {
      if (type === 'hive-action-diagnostic') { reports.push(args); return Promise.resolve({ ok: true }); }
      return new Promise(() => {});
    },
  }, register() {}, onMessage: callback => { deliver = callback; } });
  const requestId = send({ type: 'hive-example', cellId: 'cell_demo' }, { quiet: true, onReply: reply => replies.push(reply) });
  t.mock.timers.tick(30000);
  t.mock.timers.tick(1000);
  deliver({ op: 'hive-example', requestId, ok: false, error: 'The action was refused.' });
  assert.deepEqual(reports.map(report => report.event), ['client-timeout', 'late-reply']);
  assert.equal(reports[1].ids.cellId, 'cell_demo');
  assert.equal(reports[1].elapsedMs, 31000);
  assert.deepEqual(notices, [{ severity: 'error', text: 'The action was refused.' }]);
  assert.equal(replies.length, 1);
  assert.equal(replies[0].timeout, true);
});
