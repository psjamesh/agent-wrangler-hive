import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeLifetime } from '../server/lifetime.js';

function wrapStore(store) {
  return new Proxy(store, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? (...args) => value.apply(target, args) : value;
    },
  });
}

function runtimeWith(lifetime) {
  return { metadata: { lifetime }, attach(host) { this.metadata.lifetime.attach(this, host); } };
}

test('a runtime behind a host store proxy stays current', () => {
  const lifetime = new RuntimeLifetime();
  const host = { stores: {} };
  host.stores.hive = wrapStore(runtimeWith(lifetime));
  host.stores.hive.attach(host);
  assert.equal(lifetime.isCurrent(host), true);
  assert.doesNotThrow(() => lifetime.assertCurrent());
});

test('a replaced or stopped runtime is not current', () => {
  const lifetime = new RuntimeLifetime();
  const host = { stores: {} };
  host.stores.hive = wrapStore(runtimeWith(lifetime));
  host.stores.hive.attach(host);
  host.stores.hive = wrapStore(runtimeWith(new RuntimeLifetime()));
  assert.equal(lifetime.isCurrent(host), false);
  host.stores.hive = { metadata: { lifetime } };
  lifetime.stop();
  assert.throws(() => lifetime.assertCurrent(), { code: 'runtime-stopped' });
});
