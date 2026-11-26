import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { pickupFixture } from './helpers/pickup.mjs';
import { createBeadsTool } from './helpers/tools.mjs';
import { fakeTimers, flush } from './helpers/fake-timers.mjs';
import { hardenedAdapter } from './helpers/beads-fake.mjs';
import { reconcileOperation } from '../server/ops.js';
import { HIVE_META } from '../server/bead-model.js';

test('a create that times out after starting stays uncertain, is never retried and is reconciled by op id', async (t) => {
  const clock = fakeTimers();
  const store = [];
  const script = (args) => (child, close) => {
    if (args[0] === 'create') {
      const plan = JSON.parse(fs.readFileSync(args[args.indexOf('--graph') + 1], 'utf8'));
      child.kill = (sig) => {
        child.kills.push(sig);
        if (sig !== 'SIGKILL') return true;
        for (const node of plan.nodes) store.push({ id: `hive-${store.length + 1}`, metadata: node.metadata });
        setImmediate(() => { child.emit('exit', null, sig); close(Object.assign(new Error('killed'), { killed: true, signal: sig, code: null }), '', ''); });
        return true;
      };
      return;
    }
    if (args[0] === 'list') {
      const op = args[args.indexOf('--metadata-field') + 1].split('=')[1];
      setImmediate(() => close(null, JSON.stringify(store.filter((b) => b.metadata[HIVE_META.op] === op)), ''));
      return;
    }
    setImmediate(() => close(null, '', ''));
  };
  const real = await hardenedAdapter(t, { clock, script });
  const f = pickupFixture();
  f.rt.beads.hierarchy = { generation: 0, writing: false };
  f.rt.beads.createMany = (...args) => real.adapter.createMany(...args);
  f.rt.beads.findByOperation = (...args) => real.adapter.findByOperation(...args);

  let response;
  const call = createBeadsTool.handler({ host: f.host, caller: 'queen' }, { beads: [{ ref: 'new', title: 'New work', kind: 'investigation' }] }).then((out) => { response = out; });
  await flush();
  await clock.advance(40000);
  await call;
  assert.equal(response.isError, true);
  const text = response.content.map((c) => c.text).join('\n');
  assert.match(text, /did not finish in time; it may or may not have been applied/);
  assert.match(text, /ignored SIGTERM and was killed with SIGKILL/);
  assert.match(text, /Do not repeat it/);
  const [op] = Object.values(f.rt.metadata.read().operations).filter((o) => o.kind === 'create-beads');
  assert.equal(op.state, 'uncertain');

  await clock.advance(120000);
  assert.equal(real.spawned.filter((s) => s.args[0] === 'create').length, 1, 'the create is never retried');

  const reconcile = reconcileOperation(f.rt, { opId: op.id });
  await clock.advance(1000);
  const out = await reconcile;
  assert.equal(out.state, 'applied');
  assert.deepEqual(out.ids, ['hive-1']);
  assert.equal(f.rt.metadata.read().operations[op.id].state, 'applied');
  assert.equal(real.spawned.filter((s) => s.args[0] === 'create').length, 1);
});
