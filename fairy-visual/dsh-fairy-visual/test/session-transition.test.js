import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../src/client/visual-transitions.js', import.meta.url), 'utf8');
const require = createRequire(import.meta.url);
const { createFairyDiagnostics } = require('../../../fairy-contracts/client-diagnostics.cjs');

class FakeNode {
  static cloneCount = 0;
  static queryCount = 0;

  constructor(name, rect = null) {
    this.name = name;
    this.tagName = name;
    this.namespaceURI = ['svg', 'filter', 'image', 'clip', 'use'].includes(name) ? 'http://www.w3.org/2000/svg' : null;
    this.rect = rect;
    this.attributes = new Map();
    this.children = [];
    this.parentNode = null;
    this.style = {
      properties: new Map(),
      setProperty: (name, value) => this.style.properties.set(name, value),
      removeProperty: (name) => this.style.properties.delete(name),
    };
    this.animations = [];
  }

  get firstElementChild() { return this.children[0] || null; }
  get parentElement() { return this.parentNode; }

  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  removeAttribute(name) { this.attributes.delete(name); }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  insertBefore(child, reference) {
    const index = this.children.indexOf(reference);
    if (index < 0) return this.appendChild(child);
    child.parentNode = this;
    this.children.splice(index, 0, child);
    return child;
  }

  replaceChildren(...children) {
    this.children.forEach((child) => { child.parentNode = null; });
    this.children = [];
    children.forEach((child) => this.appendChild(child));
  }

  remove() {
    const index = this.parentNode?.children.indexOf(this) ?? -1;
    if (index >= 0) this.parentNode.children.splice(index, 1);
    this.parentNode = null;
  }

  querySelectorAll(selector) {
    FakeNode.queryCount += 1;
    const descendants = [];
    const visit = (node) => node.children.forEach((child) => {
      descendants.push(child);
      visit(child);
    });
    visit(this);
    if (selector === '*') return descendants;
    if (selector === '[id]') return descendants.filter((node) => node.getAttribute('id'));
    if (selector === '[data-dsh-fairy-brand-anchor="true"]') return descendants.filter((node) => node.getAttribute('data-dsh-fairy-brand-anchor') === 'true');
    if (selector === '[data-dsh-fairy-mascot-root="true"]') return descendants.filter((node) => node.getAttribute('data-dsh-fairy-mascot-root') === 'true');
    if (selector === '[data-dsh-fairy-mascot-root="true"] .dsh-fairy-signal') return descendants.filter((node) => node.getAttribute('class') === 'dsh-fairy-signal' && node.parentNode?.getAttribute('data-dsh-fairy-mascot-root') === 'true');
    if (selector === '.dsh-fairy-eye') return descendants.filter((node) => node.getAttribute('class') === 'dsh-fairy-eye');
    return [];
  }

  cloneNode(deep) {
    FakeNode.cloneCount += 1;
    const clone = new FakeNode(this.name, this.rect);
    this.attributes.forEach((value, key) => clone.setAttribute(key, value));
    if (deep) this.children.forEach((child) => clone.appendChild(child.cloneNode(true)));
    return clone;
  }

  getBoundingClientRect() { return this.rect; }

  animate(keyframes, options) {
    const animation = { keyframes, options, cancelled: false, cancel() { this.cancelled = true; } };
    this.animations.push(animation);
    return animation;
  }
}

function loadTransitions(document, window, globals = {}) {
  const module = { exports: {} };
  vm.runInNewContext(source, {
    module,
    exports: module.exports,
    document,
    window,
    setTimeout: () => 1,
    clearTimeout() {},
    console,
    require: (id) => {
      assert.equal(id, '../../../../fairy-contracts/client-diagnostics.cjs');
      return { createFairyDiagnostics };
    },
    ...globals,
  }, { filename: 'visual-transitions.js' });
  return module.exports;
}

test('session transitions use the layout phase instead of the display-contents conversation slot and never create color bars', () => {
  const body = new FakeNode('body');
  const frame = new FakeNode('frame', { left: 0, top: 0, right: 1200, bottom: 800, width: 1200, height: 800 });
  const fairyRoot = new FakeNode('fairy-root');
  fairyRoot.setAttribute('id', 'dsh-fairy-root');
  fairyRoot.setAttribute('data-dsh-fairy-mascot-root', 'true');
  fairyRoot.setAttribute('data-state', 'thinking');
  const eye = new FakeNode('eye');
  eye.setAttribute('class', 'dsh-fairy-eye');
  const signal = new FakeNode('signal');
  signal.setAttribute('class', 'dsh-fairy-signal');
  const svg = new FakeNode('svg');
  const filter = new FakeNode('filter');
  filter.setAttribute('id', 'dsh-fairy-interference');
  const image = new FakeNode('image');
  image.setAttribute('id', 'dsh-fairy-image');
  const thinkingClip = new FakeNode('clip');
  thinkingClip.setAttribute('id', 'dsh-fairy-thinking-eye-clip');
  const slice = new FakeNode('clip');
  slice.setAttribute('id', 'dsh-fairy-slice-1');
  const use = new FakeNode('use');
  use.setAttribute('href', '#dsh-fairy-image');
  use.setAttribute('clip-path', 'url(#dsh-fairy-slice-1)');
  svg.appendChild(filter);
  svg.appendChild(image);
  svg.appendChild(thinkingClip);
  svg.appendChild(slice);
  svg.appendChild(use);
  signal.appendChild(eye);
  signal.appendChild(svg);
  fairyRoot.appendChild(signal);
  frame.appendChild(fairyRoot);
  const surface = new FakeNode('conversation', { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 });
  const regionSurface = new FakeNode('phase', { left: 280, top: 44, right: 1200, bottom: 800, width: 920, height: 756 });
  const seat = new FakeNode('composer-seat');
  const composer = new FakeNode('composer', { left: 320, top: 668, right: 1160, bottom: 788, width: 840, height: 120 });
  const document = {
    body,
    documentElement: { clientWidth: 1200, clientHeight: 800 },
    createElement: (name) => new FakeNode(name),
    getElementById: () => null,
  };
  const window = { innerWidth: 1200, innerHeight: 800, matchMedia: () => ({ matches: false }) };
  const { createVisualTransitions } = loadTransitions(document, window);
  const transitions = createVisualTransitions({
    rootSlot: () => ({ firstElementChild: frame }),
    conversation: () => surface,
    anyPhase: (scope) => scope === surface ? regionSurface : null,
    composerSeat: (scope) => scope === surface ? seat : null,
    composerCard: (scope) => scope === seat ? composer : null,
  });

  const transition = transitions.createSessionTransition();
  transition.trigger();

  const container = body.firstElementChild;
  const overlay = container.firstElementChild;
  const region = overlay.firstElementChild;
  assert.match(container.style.cssText, /z-index:2147483000/);
  assert.equal(overlay.className, 'dsh-hdd-session-transition');
  assert.match(region.style.cssText, /clip-path:inset\(44px 0px 132px 280px\)/);
  assert.equal(region.children.length, 4);
  assert.equal(region.children.filter((node) => node.getAttribute('data-dsh-transition-layer') === 'bar').length, 0);
  assert.equal(region.children.every((node) => node.getAttribute('data-dsh-transition-frame') === ''), true);
  region.children.forEach((clone) => {
    const cloneRoot = clone.querySelectorAll('[data-dsh-fairy-mascot-root="true"]')[0];
    assert.equal(cloneRoot.getAttribute('id'), null);
    const ids = clone.querySelectorAll('[id]').map((node) => node.getAttribute('id'));
    assert.equal(ids.every((id) => id.startsWith('dsh-fairy-transition-') || id === 'dsh-fairy-root'), true);
    const cloneUse = clone.querySelectorAll('*').find((node) => node.name === 'use');
    assert.match(cloneUse.getAttribute('href'), /^#dsh-fairy-transition-\d+-dsh-fairy-image$/);
    assert.match(cloneUse.getAttribute('clip-path'), /^url\(#dsh-fairy-transition-\d+-dsh-fairy-slice-1\)$/);
    const cloneEye = clone.querySelectorAll('.dsh-fairy-eye')[0];
    assert.match(cloneEye.style.properties.get('clip-path'), /^url\(#dsh-fairy-transition-\d+-dsh-fairy-thinking-eye-clip\)$/);
  });

  const animations = region.children.flatMap((node) => node.animations);
  transition.dispose();
  assert.equal(container.children.length, 0);
  assert.equal(animations.every((animation) => animation.cancelled), true);
});

test('mode transition captures once before paint and prunes only offscreen list-item descendants', () => {
  const body = new FakeNode('body');
  const documentElement = new FakeNode('html');
  documentElement.clientWidth = 1200;
  documentElement.clientHeight = 800;
  const frame = new FakeNode('frame', { left: 0, top: 0, right: 1200, bottom: 800, width: 1200, height: 800 });
  const flow = new FakeNode('flow');
  flow.setAttribute('data-chat-flow', '');
  frame.appendChild(flow);
  for (let itemIndex = 0; itemIndex < 12; itemIndex += 1) {
    const visible = itemIndex < 2;
    const top = visible ? 80 + itemIndex * 180 : 900 + itemIndex * 100;
    const item = new FakeNode('message', { left: 300, top, right: 1100, bottom: top + 140, width: 800, height: 140 });
    item.setAttribute('data-item', String(itemIndex));
    for (let childIndex = 0; childIndex < 8; childIndex += 1) item.appendChild(new FakeNode('span'));
    flow.appendChild(item);
  }
  const document = {
    body,
    documentElement,
    createElement: (name) => new FakeNode(name),
    getElementById: () => null,
  };
  const window = { innerWidth: 1200, innerHeight: 800, matchMedia: () => ({ matches: false }) };
  const frames = [];
  const { createVisualTransitions } = loadTransitions(document, window, {
    getComputedStyle: () => ({ backgroundColor: '#101010' }),
    requestAnimationFrame: (callback) => { frames.push(callback); return frames.length; },
    cancelAnimationFrame() {},
  });
  const transitions = createVisualTransitions({
    rootSlot: () => ({ firstElementChild: frame }),
    modeAttr: 'data-mode',
  });
  const treeSize = (node) => 1 + node.children.reduce((total, child) => total + treeSize(child), 0);
  const originalSize = treeSize(frame);

  FakeNode.cloneCount = 0;
  FakeNode.queryCount = 0;
  const transition = transitions.createModeTransition();
  transition.trigger();

  assert.equal(FakeNode.cloneCount, originalSize, 'only one full frame is cloned before the first animation frame');
  assert.equal(FakeNode.queryCount, 2, 'source and clone element lists are each collected once');
  const overlay = body.firstElementChild.firstElementChild;
  const captured = overlay.children.find((node) => node.getAttribute('data-dsh-transition-frame') === '');
  const capturedItems = captured.querySelectorAll('*').filter((node) => node.getAttribute('data-item') !== null);
  assert.equal(capturedItems.slice(0, 2).every((node) => node.children.length === 8), true);
  assert.equal(capturedItems.slice(2).every((node) => node.children.length === 0), true);
  assert.equal(capturedItems.slice(2).every((node) => node.getAttribute('data-dsh-transition-placeholder') === ''), true);

  frames.shift()();
  const optimizedCloneCount = FakeNode.cloneCount;
  const previousCloneCount = originalSize * 3;
  assert.ok(1 - optimizedCloneCount / previousCloneCount > 0.4, `expected >40% fewer cloned nodes, got ${optimizedCloneCount}/${previousCloneCount}`);
  assert.equal(overlay.children.filter((node) => node.getAttribute('data-dsh-transition-layer') === 'slice').length, 3);
  transition.dispose();
});
