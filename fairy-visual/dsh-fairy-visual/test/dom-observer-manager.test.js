import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';

const managerSource = readFileSync(new URL('../src/client/dom-observer-manager.js', import.meta.url), 'utf8');
const require = createRequire(import.meta.url);
const { createFairyDiagnostics } = require('../../../fairy-contracts/client-diagnostics.cjs');

class FakeNode {
  constructor(parent = null) {
    this.parentElement = parent;
  }

  contains(node) {
    for (let current = node; current; current = current.parentElement) {
      if (current === this) return true;
    }
    return false;
  }
}

function createHarness() {
  const body = new FakeNode();
  const documentElement = new FakeNode();
  const document = { body, documentElement };
  const nativeObservers = [];
  const frames = [];
  let nextFrame = 1;

  class FakeMutationObserver {
    constructor(callback) {
      this.callback = callback;
      this.observations = [];
      this.disconnected = false;
      nativeObservers.push(this);
    }

    observe(target, options) {
      this.observations.push({ target, options });
    }

    disconnect() {
      this.disconnected = true;
    }
  }

  const context = {
    module: { exports: {} },
    exports: {},
    MutationObserver: FakeMutationObserver,
    requestAnimationFrame(callback) {
      frames.push(callback);
      return nextFrame++;
    },
    cancelAnimationFrame() {},
    setTimeout,
    require: (id) => {
      assert.equal(id, '../../../../fairy-contracts/client-diagnostics.cjs');
      return { createFairyDiagnostics };
    },
  };
  vm.runInNewContext(managerSource, context, { filename: 'dom-observer-manager.js' });
  return { ...context.module.exports, body, document, documentElement, frames, nativeObservers };
}

test('shares one native body observer while preserving subscription order', () => {
  const harness = createHarness();
  const manager = harness.createDomObserverManager(harness.document);
  const target = new FakeNode(harness.body);
  const calls = [];

  for (let index = 0; index < 10; index += 1) {
    const observer = {
      _callback: () => calls.push(index),
      _subscriptions: new Map(),
    };
    manager.observe(observer, harness.body, { childList: true, subtree: true });
  }

  assert.equal(harness.nativeObservers.length, 1);
  assert.equal(manager.inspect().bodyObserverCount, 1);
  harness.nativeObservers[0].callback([{ type: 'childList', target, addedNodes: [], removedNodes: [] }]);
  assert.deepEqual(calls, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test('filters shared records by target, subtree, type, and attribute name', () => {
  const harness = createHarness();
  const manager = harness.createDomObserverManager(harness.document);
  const branch = new FakeNode(harness.body);
  const leaf = new FakeNode(branch);
  const outside = new FakeNode(harness.body);
  const delivered = [];
  const observer = { _callback: (records) => delivered.push(...records), _subscriptions: new Map() };

  manager.observe(observer, branch, { subtree: true, attributes: true, attributeFilter: ['aria-expanded'] });
  harness.nativeObservers[0].callback([
    { type: 'attributes', target: leaf, attributeName: 'aria-expanded' },
    { type: 'attributes', target: leaf, attributeName: 'class' },
    { type: 'attributes', target: outside, attributeName: 'aria-expanded' },
    { type: 'childList', target: branch, addedNodes: [], removedNodes: [] },
  ]);

  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].target, leaf);
  assert.equal(delivered[0].attributeName, 'aria-expanded');
});

test('coalesces subsystem callbacks into one animation frame', () => {
  const harness = createHarness();
  const manager = harness.createDomObserverManager(harness.document);
  const calls = [];

  for (let index = 0; index < 20; index += 1) manager.scheduleFrame({ index }, () => calls.push(index));
  assert.equal(harness.frames.length, 1);
  assert.equal(manager.inspect().pendingFrameCount, 20);

  harness.frames[0]();
  assert.deepEqual(calls, Array.from({ length: 20 }, (_, index) => index));
  assert.equal(manager.inspect().pendingFrameCount, 0);
});

test('keeps streaming character data off the broad body registration', () => {
  const harness = createHarness();
  const manager = harness.createDomObserverManager(harness.document);
  const header = new FakeNode(harness.body);
  const bodyObserver = { _callback: () => {}, _subscriptions: new Map() };
  const headerObserver = { _callback: () => {}, _subscriptions: new Map() };

  manager.observe(bodyObserver, harness.body, { childList: true, subtree: true });
  manager.observe(headerObserver, header, { characterData: true, subtree: true });

  const latestByTarget = new Map(harness.nativeObservers[0].observations.map((entry) => [entry.target, entry.options]));
  assert.equal(latestByTarget.get(harness.body).characterData, false);
  assert.equal(latestByTarget.get(header).characterData, true);
});
