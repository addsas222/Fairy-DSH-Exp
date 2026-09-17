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
    setInterval,
    clearInterval,
    AbortController,
    require: (id) => {
      assert.equal(id, '../../../../fairy-contracts/client-diagnostics.cjs');
      return { createFairyDiagnostics };
    },
  }, { filename: 'lifecycle.js' });
  return module.exports;
}

test('keyed lifecycle frames run once with the latest callback', () => {
  const previousRaf = globalThis.requestAnimationFrame;
  const previousCancel = globalThis.cancelAnimationFrame;
  const queued = new Map();
  let nextId = 0;
  globalThis.requestAnimationFrame = (callback) => {
    const id = ++nextId;
    queued.set(id, callback);
    return id;
  };
  globalThis.cancelAnimationFrame = (id) => queued.delete(id);
  try {
    const { createLifecycleScope } = loadLifecycle(globalThis.requestAnimationFrame, globalThis.cancelAnimationFrame);
    const lifecycle = createLifecycleScope('test-keyed-frames');
    const calls = [];
    const first = lifecycle.scheduleFrame('geometry', () => calls.push('first'));
    const second = lifecycle.scheduleFrame('geometry', () => calls.push('latest'));
    assert.equal(first, second);
    assert.equal(queued.size, 1);
    queued.get(first)();
    assert.deepEqual(calls, ['latest']);
    lifecycle.dispose();
  } finally {
    globalThis.requestAnimationFrame = previousRaf;
    globalThis.cancelAnimationFrame = previousCancel;
  }
});

test('replaceBinding disposes the previous node binding before the next one', () => {
  const { createLifecycleScope } = loadLifecycle(() => 1, () => {});
  const lifecycle = createLifecycleScope('test-replace-binding');
  const calls = [];
  lifecycle.replaceBinding('surface', () => calls.push('old'));
  lifecycle.replaceBinding('surface', () => calls.push('new'));
  assert.deepEqual(calls, ['old']);
  lifecycle.dispose();
  assert.deepEqual(calls, ['old', 'new']);
});

test('replaceBinding disposes a late binding when the scope is already disposed', () => {
  const { createLifecycleScope } = loadLifecycle(() => 1, () => {});
  const lifecycle = createLifecycleScope('test-late-binding');
  lifecycle.dispose();
  let disposed = 0;
  const returned = lifecycle.replaceBinding('surface', () => { disposed += 1; });
  assert.equal(disposed, 1);
  assert.equal(typeof returned, 'function');
  returned();
  assert.equal(disposed, 1);
});

test('lifecycle disposal owns intervals and AbortControllers', () => {
  const { createLifecycleScope } = loadLifecycle(() => 1, () => {});
  const lifecycle = createLifecycleScope('test-intervals-and-abort');
  const controller = lifecycle.abortController();
  const interval = lifecycle.interval(() => {}, 1000);
  assert.equal(controller.signal.aborted, false);
  assert.notEqual(interval, 0);
  lifecycle.dispose();
  assert.equal(controller.signal.aborted, true);
});

test('lifecycle inspection exposes labels without passing metadata to browser APIs', () => {
  const { createLifecycleScope } = loadLifecycle(() => 1, () => {});
  const calls = [];
  const target = {
    addEventListener(type, listener, options) { calls.push({ phase: 'add', type, listener, options }); },
    removeEventListener(type, listener, options) { calls.push({ phase: 'remove', type, listener, options }); },
  };
  const lifecycle = createLifecycleScope('test-inspection');
  lifecycle.add(() => {}, 'test:cleanup');
  lifecycle.on(target, 'resize', () => {}, { passive: true, label: 'test:resize' });
  assert.deepEqual(Array.from(lifecycle.inspect(), ({ label }) => label), ['test:cleanup', 'test:resize']);
  assert.equal('label' in calls[0].options, false);
  lifecycle.dispose();
  assert.equal(calls[1].phase, 'remove');
  assert.equal(calls[1].options, calls[0].options);
});
