import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const attachmentsSource = readFileSync(new URL('../src/client/composer-attachments.js', import.meta.url), 'utf8');
const markerSource = readFileSync(new URL('../src/client/composer-marker-projection.js', import.meta.url), 'utf8');
const materialSource = readFileSync(new URL('../src/client/composer-material-layer.js', import.meta.url), 'utf8');

function loadCommonJs(source, require = () => ({})) {
  const module = { exports: {} };
  vm.runInNewContext(source, { module, exports: module.exports, require }, { filename: 'fixture.js' });
  return module.exports;
}

class FakeNode {
  constructor(attributes = {}) {
    this.attributes = new Map(Object.entries(attributes));
    this.children = [];
    this.parentElement = null;
    this.isConnected = true;
  }

  get firstElementChild() { return this.children[0] || null; }
  getAttribute(name) { return this.attributes.get(name) || null; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
  append(child) { child.parentElement = this; this.children.push(child); }
  contains(node) { return this === node || this.children.some((child) => child.contains(node)); }
  closest() { return null; }
}

test('attachment layout identifies only the official direct slot and preserves the persisted dock base', () => {
  const { ATTACHMENTS_SLOT, attachmentSlot, attachmentRail, attachmentRailHeight, attachmentDockHeight } = loadCommonJs(attachmentsSource, (id) => {
    if (id === './dom-adapter.js') return {
      OFFICIAL_SELECTORS: { composerAttachmentsSlot: 'conversation.input.attachments' },
      composerAttachmentsSlot: (card) => card.children.find((child) => child.getAttribute('data-slot') === 'conversation.input.attachments') || null,
    };
    throw new Error(`unexpected dependency: ${id}`);
  });
  const card = new FakeNode();
  const nestedHost = new FakeNode();
  const nestedSlot = new FakeNode({ 'data-slot': ATTACHMENTS_SLOT });
  const slot = new FakeNode({ 'data-slot': ATTACHMENTS_SLOT });
  const rail = new FakeNode();
  rail.getBoundingClientRect = () => ({ height: 67.25 });
  nestedHost.append(nestedSlot);
  slot.append(rail);
  card.append(nestedHost);
  card.append(slot);

  assert.equal(attachmentSlot(card), slot);
  assert.equal(attachmentRail(slot), rail);
  assert.equal(attachmentRailHeight(slot), 68);
  assert.equal(attachmentDockHeight(132, 68, 132, 420), 200);
  assert.equal(attachmentDockHeight(400, 68, 132, 420), 420);
});

test('measures the input dock height from the union of its strip entries', () => {
  const { inputDockRailHeight } = loadCommonJs(attachmentsSource, (id) => {
    if (id === './dom-adapter.js') return {
      OFFICIAL_SELECTORS: { composerAttachmentsSlot: 'conversation.input.attachments' },
      composerAttachmentsSlot: () => null,
    };
    throw new Error(`unexpected dependency: ${id}`);
  });
  const strip = (top, height) => { const node = new FakeNode(); node.getBoundingClientRect = () => ({ top, bottom: top + height, height }); return node; };
  const slot = new FakeNode();
  assert.equal(inputDockRailHeight(slot), 0);
  assert.equal(inputDockRailHeight(null), 0);
  slot.append(strip(0, 0));
  assert.equal(inputDockRailHeight(slot), 0, '空条不占高度');
  slot.append(strip(100, 30));
  assert.equal(inputDockRailHeight(slot), 30);
  slot.append(strip(136, 24));
  assert.equal(inputDockRailHeight(slot), 60, '多条（todo+queue）取并集而非求和');
  // 槽自身有盒（Fairy 给它是 block + 内边距）时，以槽的 border-box 为准：
  // 漏掉自身内边距会让 seat 少算几像素，卡片正好被抬起来那几像素。
  const boxed = new FakeNode();
  boxed.getBoundingClientRect = () => ({ top: 700, bottom: 735, height: 35 });
  boxed.append(strip(706, 26));
  assert.equal(inputDockRailHeight(boxed), 35, '槽有盒时按自身高度（含内边距/边框）');
});

test('attachment slots receive their own marker and never become generic accessories', () => {
  const attachments = loadCommonJs(attachmentsSource, (id) => {
    if (id === './dom-adapter.js') return {
      OFFICIAL_SELECTORS: { composerAttachmentsSlot: 'conversation.input.attachments' },
      composerAttachmentsSlot: (card) => card.children.find((child) => child.getAttribute('data-slot') === 'conversation.input.attachments') || null,
    };
    throw new Error(`unexpected dependency: ${id}`);
  });
  const inputScroll = new FakeNode({ 'data-input-scroll': '' });
  const slot = new FakeNode({ 'data-slot': attachments.ATTACHMENTS_SLOT });
  slot.append(new FakeNode());
  const card = new FakeNode();
  card.append(slot);
  card.append(inputScroll);
  const marker = loadCommonJs(markerSource, (id) => {
    if (id === './composer-attachments.js') return attachments;
    if (id === './dom-adapter.js') {
      return {
        OFFICIAL_ATTRIBUTES: { composerSeat: 'data-composer-seat' },
        inputScroll: (node) => node.children.find((child) => child.getAttribute('data-input-scroll') !== null) || null,
        sendButton: () => null,
        contextControl: () => null,
        voiceControl: () => null,
        commandControl: () => null,
        accessControl: () => null,
        modelControl: () => null,
        reasoningControl: () => null,
        modelAndReasoningShareNode: () => false,
        workspaceControl: () => null,
      };
    }
    throw new Error(`unexpected dependency: ${id}`);
  });

  const dispose = marker.markControls(card);
  assert.equal(slot.getAttribute('data-dsh-fairy-composer-attachments'), 'true');
  assert.equal(slot.getAttribute('data-dsh-fairy-composer-accessory'), null);
  assert.equal(card.getAttribute('data-dsh-fairy-composer-attachments-active'), 'true');
  dispose();
  assert.equal(slot.getAttribute('data-dsh-fairy-composer-attachments'), null);
  assert.equal(card.getAttribute('data-dsh-fairy-composer-attachments-active'), null);
});

test('material geometry unions the official rail and text regions without changing the one-region case', () => {
  const { unionRect } = loadCommonJs(materialSource);
  const input = { getBoundingClientRect: () => ({ left: 100, top: 80, right: 500, bottom: 140 }) };
  const rail = { getBoundingClientRect: () => ({ left: 100, top: 12, right: 500, bottom: 80 }) };
  assert.deepEqual({ ...unionRect([input]) }, { left: 100, top: 80, right: 500, bottom: 140 });
  assert.deepEqual({ ...unionRect([input, rail]) }, { left: 100, top: 12, right: 500, bottom: 140 });
});

test('attachment contact geometry follows the same combined opening and cleans up', () => {
  const { syncHoleContactGeometry, clearHoleContactGeometry } = loadCommonJs(materialSource);
  const properties = new Map();
  const card = {
    clientLeft: 1,
    clientTop: 1,
    clientWidth: 398,
    clientHeight: 198,
    getBoundingClientRect: () => ({ left: 100, top: 20, width: 400, height: 200 }),
    style: {
      setProperty: (name, value) => properties.set(name, value),
      removeProperty: (name) => properties.delete(name),
    },
  };
  const geometry = syncHoleContactGeometry(card, { left: 121, top: 42, right: 479, bottom: 180 });
  assert.deepEqual({ ...geometry }, { left: 20, top: 21, width: 358, height: 138 });
  assert.equal(properties.get('--dsh-fairy-composer-hole-contact-top'), '21px');
  assert.equal(properties.get('--dsh-fairy-composer-hole-contact-height'), '138px');
  clearHoleContactGeometry(card);
  assert.equal(properties.size, 0);
});
