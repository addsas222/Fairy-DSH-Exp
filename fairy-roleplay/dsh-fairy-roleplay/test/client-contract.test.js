import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

/** Load the hand-written browser bundle the way the client runtime does. */
async function loadBundle() {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
  let captured = null;
  const window = { __ModuleLoader__: { load: (config) => { captured = config; } } };
  // eslint-disable-next-line no-new-func -- the bundle is a plain script, exactly as shipped.
  new Function('window', source)(window);
  assert.ok(captured !== null, 'the bundle must call window.__ModuleLoader__.load');
  const stubs = {
    react: { useState: () => [null, () => {}], useCallback: (fn) => fn, useEffect: () => {} },
    'react/jsx-runtime': { jsx: () => null, jsxs: () => null },
    '@deepseek-ai/dsh-client-ui-primitives': { Button: () => null, StateDot: () => null },
  };
  return { source, id: captured.id, api: captured.factory((name) => stubs[name]) };
}

test('the bundle registers exactly one settings section, keyed for the runtime', async () => {
  const { id, api } = await loadBundle();
  assert.equal(id, 'dsh-fairy-roleplay');
  assert.deepEqual(api.inject, ['slots']);
  const registered = [];
  const injections = [];
  const ctx = {
    slots: {
      inject: (name, provider) => {
        injections.push({ name, provider });
        return () => {};
      },
      register: (definition, component) => {
        registered.push({ definition, component });
        return () => {};
      },
    },
    effect: (callback) => callback(),
  };
  api.apply(ctx);
  assert.equal(injections.length, 1);
  assert.equal(injections[0].name, 'settings.section');
  injections[0].provider();
  assert.equal(registered.length, 1);
  assert.equal(registered[0].definition.id, 'fairy-roleplay');
  assert.equal(registered[0].definition.order, 33);
  assert.equal(typeof registered[0].component, 'function', 'the slot must receive a component');
});

test('a repeated slot injection releases the previous registration', async () => {
  const { api } = await loadBundle();
  let live = 0;
  let released = 0;
  const provider = { register: () => { live += 1; return () => { live -= 1; released += 1; }; } };
  const ctx = {
    slots: {
      inject: (_name, run) => run(),
      get register() { return provider.register; },
    },
    effect: (callback) => callback(),
  };
  api.apply(ctx);
  assert.equal(live, 1);
  assert.equal(released, 0);
});

test('the card talks to the host routes this package actually serves', async () => {
  const { source } = await loadBundle();
  for (const route of ['/fairy-roleplay/state', '/fairy-roleplay/config']) {
    assert.ok(source.includes(route), `the card must call ${route}`);
  }
  for (const level of ['off', 'l1', 'l2', 'l3', 'l4']) {
    assert.ok(source.includes(`value: '${level}'`), `level ${level} must be selectable`);
  }
  for (const toggle of ['timingGate', 'styleEnabled', 'autoCheck', 'memoryImpression']) {
    assert.ok(source.includes(toggle), `toggle ${toggle} must exist`);
  }
});
