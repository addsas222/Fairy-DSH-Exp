import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import vm from 'node:vm';

const packageRoot = new URL('..', import.meta.url);
const sourceRoot = new URL('../src/client/', import.meta.url);
const adapterSource = readFileSync(new URL('../src/client/dom-adapter.js', import.meta.url), 'utf8');
const require = createRequire(import.meta.url);
const clientDomContracts = require('../../../fairy-contracts/client-dom.cjs');

function node(entries = {}) {
  // 与浏览器一致：支持逗号联合选择器。底座 0.1.5 起同一锚点需要并集
  // （例如 `[data-slot="conversation"], [data-slot="main.conversation"]`），
  // 若替身只做精确字符串匹配，适配层的联合选择器会被判成「找不到」。
  const lookup = (selector) => {
    if (Object.prototype.hasOwnProperty.call(entries, selector)) return entries[selector];
    for (const part of String(selector).split(',')) {
      const trimmed = part.trim();
      if (Object.prototype.hasOwnProperty.call(entries, trimmed) && entries[trimmed] !== null) return entries[trimmed];
    }
    return null;
  };
  return {
    querySelector(selector) { return lookup(selector); },
    querySelectorAll() { return []; },
  };
}

function loadAdapter(documentRef, warnings = []) {
  const module = { exports: {} };
  vm.runInNewContext(adapterSource, {
    module,
    exports: module.exports,
    document: documentRef,
    console: { warn: (message) => warnings.push(message) },
    require: (id) => {
      assert.equal(id, '../../../../fairy-contracts/client-dom.cjs');
      return clientDomContracts;
    },
  }, { filename: 'dom-adapter.js' });
  return module.exports;
}

function mountedDocument({ phase = 'active' } = {}) {
  const input = node();
  const card = node({ '[data-input-scroll]': input });
  const seat = node({ '[data-composer-card="true"]': card });
  const activePhase = phase === 'active' ? node() : null;
  const heroPhase = phase === 'hero' ? node() : null;
  const conversation = node({
    '[data-composer-seat]': seat,
    '[data-phase="active"]': activePhase,
    '[data-phase="hero"]': heroPhase,
    '[data-phase]': activePhase || heroPhase,
    '[data-conversation-scroll]': phase === 'active' ? node() : null,
  });
  return node({
    'body > #root > [data-slot="root"]': node(),
    '[data-slot="shell.overlay"]': node(),
    '[data-slot="conversation"]': conversation,
    '[data-slot="sidebar"]': node(),
    '[data-slot="conversation.session.header"]': phase === 'active' ? node() : null,
  });
}

test('declares one capability level for every diagnosed capability', () => {
  const adapter = loadAdapter(mountedDocument());
  const classified = new Set(Object.values(adapter.CAPABILITY_LEVEL).flat());
  assert.deepEqual([...classified].sort(), Object.keys(adapter.CAPABILITY_DEFINITIONS).sort());
  assert.deepEqual(Array.from(adapter.CAPABILITY_LEVEL.CRITICAL), ['rootSlot', 'shellOverlay', 'conversation']);
  assert.ok(adapter.CAPABILITY_LEVEL.CORE.includes('phaseSurface'));
});

test('reports no required capability missing in an active official surface', () => {
  const warnings = [];
  const adapter = loadAdapter(mountedDocument(), warnings);
  const missing = adapter.reportMissingCapabilities(undefined, { report: (message) => warnings.push(message) });
  const status = adapter.getCapabilityStatus();

  assert.equal(missing.some(({ required }) => required), false);
  assert.deepEqual(Array.from(status.missing), []);
  assert.ok(status.timestamp > 0);
  assert.ok(status.degraded.includes('sessionTree'));
  assert.match(warnings.join('\n'), /degraded official capability \[ENHANCEMENT\]: sessionTree/);
});

test('does not flag active-only capabilities during a valid Hero phase', () => {
  const adapter = loadAdapter(mountedDocument({ phase: 'hero' }));
  const snapshot = adapter.capabilitySnapshot();
  const missing = adapter.reportMissingCapabilities();

  assert.equal(snapshot.sessionHeader.applicable, false);
  assert.equal(snapshot.sessionHeader.available, true);
  assert.equal(snapshot.conversationScroll.applicable, false);
  assert.equal(snapshot.conversationScroll.available, true);
  assert.equal(snapshot.undoControl.applicable, false);
  assert.equal(snapshot.redoControl.applicable, false);
  assert.equal(snapshot.modelSelection.applicable, false);
  assert.equal(missing.some(({ name }) => ['sessionHeader', 'conversationScroll', 'undoControl', 'redoControl', 'modelSelection'].includes(name)), false);
});

test('records and reports missing required capabilities after an explicit diagnostic pass', () => {
  const warnings = [];
  const emptyDocument = node();
  const adapter = loadAdapter(emptyDocument, warnings);
  adapter.resetCapabilityStatus();

  const missing = adapter.reportMissingCapabilities(undefined, {
    allowBeforeMount: true,
    includeOptional: true,
    report: (message) => warnings.push(message),
  });
  const status = adapter.getCapabilityStatus();

  assert.equal(adapter.rootSlot(), null);
  assert.ok(missing.some(({ name }) => name === 'rootSlot'));
  assert.ok(status.missing.includes('rootSlot'));
  assert.ok(status.degraded.includes('toBottom'));
  assert.match(warnings.join('\n'), /missing required official capability \[CRITICAL\]: rootSlot/);
});

test('keeps official data-slot and data-phase queries inside dom-adapter', () => {
  const directOfficialQuery = /querySelector(?:All)?\([^\n]*(?:data-slot|data-phase|data-composer|data-conversation-scroll|data-input-scroll|data-chat-flow)/;
  const files = readdirSync(sourceRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.js') && entry.name !== 'dom-adapter.js')
    // `URL.pathname` keeps a leading slash (`/C:/...`), which resolves to
    // `C:\C:\...` when read on Windows; resolve through the URL instead.
    .map((entry) => fileURLToPath(new URL(entry.name, sourceRoot)));

  const offenders = files.filter((file) => directOfficialQuery.test(readFileSync(file, 'utf8')));
  assert.deepEqual(offenders, []);
});

test('exports the official slot selectors the marker pass consumes', () => {
  const adapter = loadAdapter(mountedDocument());
  assert.equal(adapter.composerInputDock, '[data-slot="conversation.input.dock"]');
  assert.equal(adapter.OFFICIAL_SELECTORS.composerInputDock, '[data-slot="conversation.input.dock"]');
  assert.equal(typeof adapter.composerAttachmentsSlot, 'function');
  assert.equal(typeof adapter.composerInputDockSlot, 'function');
  const direct = { matches: (selector) => selector === adapter.composerInputDock };
  assert.equal(adapter.composerInputDockSlot({ children: [direct] }), direct, '直接子节点优先');
  const nested = { tag: 'nested' };
  assert.equal(adapter.composerInputDockSlot({ children: [], querySelector: (selector) => (selector === adapter.composerInputDock ? nested : null) }), nested, '非直接子节点回落查询');
});

test('resolves the composer pipeline on the 0.1.5 slot vocabulary', () => {
  // 0.1.5 的槽位表里没有 `data-slot="conversation"`（改为 main.conversation / conversation.composer），
  // 输入框也从 textarea 变成 contenteditable。这里用 0.1.5 形状的假 DOM 断言整条链路仍可解析：
  // conversation → composerSeat → composerCard → inputScroll，以及输入元素双形态。
  const input = node();
  const card = node({ '[data-input-scroll]': input });
  const seat = node({ '[data-composer-card="true"]': card });
  const conversation = node({
    '[data-composer-seat]': seat,
    '[data-phase="active"]': node(),
    '[data-phase]': node(),
    '[data-conversation-scroll]': node(),
  });
  const documentRef = node({
    'body > #root > [data-slot="root"]': node(),
    '[data-slot="shell.overlay"]': node(),
    '[data-slot="main.conversation"]': conversation,
    '[data-slot="sidebar"]': node(),
    '[data-slot="conversation.session.header"]': node(),
  });
  const adapter = loadAdapter(documentRef);
  const missing = adapter.reportMissingCapabilities(undefined, { report: () => {} });
  assert.equal(missing.some(({ required }) => required), false, '0.1.5 形状下不应有必需能力缺失（含会话面）');
  assert.equal(adapter.conversation(documentRef), conversation, 'main.conversation 必须被认作会话面');
  assert.equal(adapter.composerSeat(conversation), seat);
  assert.equal(adapter.composerCard(seat), card);
  assert.equal(adapter.inputScroll(card), input);
  // 输入元素双形态：0.1.1 的 textarea 与 0.1.5 的 contenteditable 都能被选中。
  assert.equal(adapter.OFFICIAL_SELECTORS.composerTextarea, 'textarea, [data-composer-input="true"]');
});
