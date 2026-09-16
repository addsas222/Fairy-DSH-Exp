import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../src/client/surface-utils.js', import.meta.url), 'utf8');
const officialSelectors = {
  conversation: '[conversation]',
  phaseHero: '[hero]',
  phaseActive: '[active]',
  composerSeat: '[seat]',
  // 底座 0.1.5 起输入框是 contenteditable，不再是 textarea ⇒ 双形态。
  composerTextarea: 'textarea, [data-composer-input="true"]',
};
const officialAttributes = { phase: 'data-phase' };

function element(selectors = []) {
  const owned = new Set(selectors);
  return {
    nodeType: 1,
    parentElement: null,
    matches(selector) { return selector.split(',').some((part) => owned.has(part.trim())); },
    closest(selector) { return this.matches(selector) ? this : null; },
    querySelector(selector) { return this.matches(selector) ? this : null; },
  };
}

function loadSurfaceUtils() {
  const module = { exports: {} };
  vm.runInNewContext(source, {
    module,
    exports: module.exports,
    require(path) {
      if (path === './dom-adapter.js') return { OFFICIAL_SELECTORS: officialSelectors, OFFICIAL_ATTRIBUTES: officialAttributes };
      throw new Error(`Unexpected dependency: ${path}`);
    },
  }, { filename: 'surface-utils.js' });
  return module.exports;
}

test('active phase removal wakes Hero controls after an overlapping session transition', () => {
  const { mutationTouchesHeroSurface } = loadSurfaceUtils();
  const record = {
    type: 'childList',
    target: element(),
    addedNodes: [],
    removedNodes: [element(['[active]'])],
  };

  assert.equal(mutationTouchesHeroSurface([record], officialSelectors, officialAttributes), true);
});

test('unrelated conversation mutations do not wake Hero controls', () => {
  const { mutationTouchesHeroSurface } = loadSurfaceUtils();
  const record = {
    type: 'childList',
    target: element(),
    addedNodes: [element(['[unrelated]'])],
    removedNodes: [],
  };

  assert.equal(mutationTouchesHeroSurface([record], officialSelectors, officialAttributes), false);
});
