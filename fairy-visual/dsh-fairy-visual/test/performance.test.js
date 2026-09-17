import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import test from 'node:test';

const lifecycleSource = readFileSync(new URL('../src/client/lifecycle.js', import.meta.url), 'utf8');
const require = createRequire(import.meta.url);
const { createFairyDiagnostics } = require('../../../fairy-contracts/client-diagnostics.cjs');

function loadLifecycle(raf, cancel) {
  const module = { exports: {} };
  vm.runInNewContext(lifecycleSource, {
    module,
    exports: module.exports,
    requestAnimationFrame: raf,
    cancelAnimationFrame: cancel,
    setTimeout,
    clearTimeout,
    require: (id) => {
      assert.equal(id, '../../../../fairy-contracts/client-diagnostics.cjs');
      return { createFairyDiagnostics };
    },
  }, { filename: 'lifecycle.js' });
  return module.exports;
}

test('observer bursts produce one layout sync per frame', () => {
  const queued = new Map();
  let nextFrame = 0;
  let observerCallbacks = 0;
  let layoutSyncs = 0;
  const raf = (callback) => {
    const id = ++nextFrame;
    queued.set(id, callback);
    return id;
  };
  const cancel = (id) => queued.delete(id);
  const { createLifecycleScope } = loadLifecycle(raf, cancel);
  const lifecycle = createLifecycleScope('performance-observer-burst');
  const observerCallback = () => {
    observerCallbacks += 1;
    lifecycle.scheduleFrame('layout-sync', () => { layoutSyncs += 1; });
  };

  for (let index = 0; index < 100; index += 1) observerCallback();
  assert.equal(observerCallbacks, 100);
  assert.equal(queued.size, 1);
  queued.values().next().value();
  assert.equal(layoutSyncs, 1);
  lifecycle.dispose();
});

test('repeated mounts leave one active owner and dispose every predecessor', () => {
  const { createLifecycleScope, claimSingleton } = loadLifecycle(() => 0, () => {});
  const owner = {};
  let disposed = 0;
  let active = 0;
  for (let index = 0; index < 20; index += 1) {
    const scope = claimSingleton(owner, 'measured-mount', createLifecycleScope(`mount-${index}`));
    scope.add(() => { disposed += 1; active -= 1; });
    active += 1;
  }
  assert.equal(disposed, 19);
  assert.equal(active, 1);
});
