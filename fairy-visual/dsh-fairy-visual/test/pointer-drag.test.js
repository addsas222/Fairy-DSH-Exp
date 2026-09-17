import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../src/client/pointer-drag.js', import.meta.url), 'utf8');
const require = createRequire(import.meta.url);
const { createFairyDiagnostics } = require('../../../fairy-contracts/client-diagnostics.cjs');

function createWindow() {
  const listeners = new Map();
  return {
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    dispatch(type, event = {}) {
      [...(listeners.get(type) || [])].forEach((listener) => listener(event));
    },
    listenerCount(type) {
      return listeners.get(type)?.size || 0;
    },
  };
}

function createRaf() {
  let nextId = 1;
  const callbacks = new Map();
  return {
    request(callback) {
      const id = nextId++;
      callbacks.set(id, callback);
      return id;
    },
    cancel(id) {
      callbacks.delete(id);
    },
    flush() {
      const pending = [...callbacks.values()];
      callbacks.clear();
      pending.forEach((callback) => callback());
    },
  };
}

function createTarget() {
  return {
    attributes: new Map(),
    captures: [],
    releases: [],
    setAttribute(name, value) { this.attributes.set(name, String(value)); },
    removeAttribute(name) { this.attributes.delete(name); },
    setPointerCapture(pointerId) { this.captures.push(pointerId); },
    releasePointerCapture(pointerId) { this.releases.push(pointerId); },
  };
}

function event(pointerId = 1) {
  return {
    pointerId,
    button: 0,
    clientY: 100,
    prevented: false,
    preventDefault() { this.prevented = true; },
  };
}

// Evaluate the CommonJS source with a temporary browser-like global scope.
function loadControllerSafely(fakeWindow, raf, fakeDocument = null) {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousRequest = globalThis.requestAnimationFrame;
  const previousCancel = globalThis.cancelAnimationFrame;
  globalThis.window = fakeWindow;
  globalThis.document = fakeDocument;
  globalThis.requestAnimationFrame = raf.request;
  globalThis.cancelAnimationFrame = raf.cancel;
  const module = { exports: {} };
  const runner = new vm.Script(`(function (module, exports, require) {\n${source}\n})`).runInThisContext();
  runner(module, module.exports, (id) => {
    assert.equal(id, '../../../../fairy-contracts/client-diagnostics.cjs');
    return { createFairyDiagnostics };
  });
  return {
    createPointerDrag: module.exports.createPointerDrag,
    restore() {
      globalThis.window = previousWindow;
      globalThis.document = previousDocument;
      globalThis.requestAnimationFrame = previousRequest;
      globalThis.cancelAnimationFrame = previousCancel;
    },
  };
}

test('pointer drag owns capture, fallback listeners, and release-frame locking', () => {
  const fakeWindow = createWindow();
  const raf = createRaf();
  const loaded = loadControllerSafely(fakeWindow, raf);
  const { createPointerDrag } = loaded;
  const target = createTarget();
  const lock = createTarget();
  const moves = [];
  const ends = [];
  const drag = createPointerDrag({
    getTarget: () => target,
    getLockNodes: () => [lock],
    onMove: (move, session) => moves.push([move.clientY, session.payload]),
    onEnd: (_event, session, reason) => ends.push([session.payload, reason]),
  });
  const down = event();
  assert.equal(drag.start(down, { token: 'composer' }), true);
  assert.equal(down.prevented, true);
  assert.deepEqual(target.captures, [1]);
  assert.equal(target.attributes.get('data-dragging'), 'true');
  assert.equal(lock.attributes.get('data-dragging'), 'true');
  assert.equal(fakeWindow.listenerCount('pointermove'), 1);

  fakeWindow.dispatch('pointermove', { ...event(), clientY: 130 });
  assert.deepEqual(moves, [[130, { token: 'composer' }]]);
  fakeWindow.dispatch('pointerup', event());
  assert.deepEqual(ends, [[{ token: 'composer' }, 'pointerup']]);
  assert.equal(drag.active, null);
  assert.equal(fakeWindow.listenerCount('pointermove'), 0);
  assert.equal(target.attributes.get('data-dragging'), 'true');
  raf.flush();
  assert.equal(target.attributes.has('data-dragging'), false);
  assert.equal(lock.attributes.has('data-dragging'), false);
  assert.deepEqual(target.releases, [1]);
  loaded.restore();
});

test('pointer cancel, blur, replacement, dispose, and callback failures always close a session', () => {
  const fakeWindow = createWindow();
  const raf = createRaf();
  const loaded = loadControllerSafely(fakeWindow, raf);
  const { createPointerDrag } = loaded;
  const target = createTarget();
  const lock = createTarget();
  const cancellations = [];
  let shouldThrow = false;
  const drag = createPointerDrag({
    getTarget: () => target,
    getLockNodes: () => [lock],
    onMove: () => { if (shouldThrow) throw new Error('move'); },
    onCancel: (_event, _session, reason) => cancellations.push(reason),
  });

  drag.start(event(1), { token: 'first' });
  fakeWindow.dispatch('pointercancel', event(1));
  assert.equal(drag.active, null);
  assert.deepEqual(cancellations, ['pointercancel']);
  raf.flush();

  drag.start(event(2), { token: 'second' });
  drag.start(event(3), { token: 'third' });
  assert.deepEqual(cancellations, ['pointercancel', 'replaced']);
  fakeWindow.dispatch('blur');
  assert.deepEqual(cancellations, ['pointercancel', 'replaced', 'blur']);
  raf.flush();

  drag.start(event(4), { token: 'error' });
  shouldThrow = true;
  const previousError = console.error;
  console.error = () => {};
  try {
    fakeWindow.dispatch('pointermove', event(4));
  } finally {
    console.error = previousError;
  }
  assert.equal(drag.active, null);
  assert.deepEqual(cancellations, ['pointercancel', 'replaced', 'blur', 'error']);
  raf.flush();

  drag.start(event(5), { token: 'dispose' });
  drag.dispose();
  assert.equal(drag.active, null);
  assert.deepEqual(cancellations, ['pointercancel', 'replaced', 'blur', 'error', 'dispose']);
  assert.equal(fakeWindow.listenerCount('pointermove'), 0);
  assert.equal(target.attributes.has('data-dragging'), false);
  assert.equal(lock.attributes.has('data-dragging'), false);
  loaded.restore();
});

test('page hiding releases drag capture and all global listeners', () => {
  const fakeWindow = createWindow();
  const fakeDocument = createWindow();
  fakeDocument.visibilityState = 'visible';
  const raf = createRaf();
  const loaded = loadControllerSafely(fakeWindow, raf, fakeDocument);
  const target = createTarget();
  const reasons = [];
  const drag = loaded.createPointerDrag({
    getTarget: () => target,
    onCancel: (_event, _session, reason) => reasons.push(reason),
  });
  drag.start(event(), { token: 'pagehide' });
  assert.equal(fakeDocument.listenerCount('visibilitychange'), 1);
  assert.equal(fakeWindow.listenerCount('pagehide'), 1);
  fakeDocument.visibilityState = 'hidden';
  fakeDocument.dispatch('visibilitychange');
  assert.equal(drag.active, null);
  assert.deepEqual(reasons, ['visibilitychange']);
  assert.equal(fakeDocument.listenerCount('visibilitychange'), 0);
  assert.equal(fakeWindow.listenerCount('pagehide'), 0);
  raf.flush();
  assert.equal(target.attributes.has('data-dragging'), false);
  loaded.restore();
});
