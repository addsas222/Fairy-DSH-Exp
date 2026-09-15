/**
 * 提问 UI 归一化的渲染级验证（不需要浏览器）。
 *
 * 做法：把每个手写 bundle 放进一个 stub 运行时里执行 —— `window.__ModuleLoader__`
 * 收下 `load({id, factory})`，`require` 只满足冻结模块表（react、react/jsx-runtime、
 * 官方原语）—— 然后调 `apply(ctx)`，把注册进 `settings.section` 的组件**真的渲染一遍**，
 * 再走一遍 JSX 树：
 *
 *   - 树里不得出现裸 `input`/`select`/`textarea`（提问件必须来自归一化套件，
 *     套件自己有官方 `Input` 或同令牌原生件，并且带 `data-ask` 标记）；
 *   - 出现的中文状态文案必须来自 `ASK_TEXT`；
 *   - 卡片必须至少有一个提问件（否则它根本不是提问卡）。
 *
 * 这是"归一化"这件事唯一能在无浏览器环境里证明的东西：结构而不是源码文本。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const require = createRequire(import.meta.url);
const { ASK_TEXT } = require(join(REPO, 'fairy-contracts', 'client-ask-kit.cjs'));

/** 手写 bundle 的包：有 `src/` 的包各有各的构建，另测。 */
const BUNDLES = [
  'fairy-modes/dsh-fairy-modes',
  'fairy-persona/dsh-fairy-persona',
  'fairy-roleplay/dsh-fairy-roleplay',
  'fairy-search/dsh-fairy-search',
  'fairy-voice/dsh-fairy-voice',
  // 有 src/ 的包：验的是各自构建产出的 lib/client.js。
  'fairy-memory/dsh-fairy-memory',
  'fairy-visual/dsh-fairy-visual',
];

/** 极简 React：够渲染函数组件，不需要调度与 DOM。 */
function createReact() {
  let slots = [];
  let at = 0;
  const React = {
    useState: (init) => {
      const index = at++;
      if (!(index in slots)) slots[index] = typeof init === 'function' ? init() : init;
      return [slots[index], (next) => { slots[index] = typeof next === 'function' ? next(slots[index]) : next; }];
    },
    useRef: (init) => {
      const index = at++;
      if (!(index in slots)) slots[index] = { current: init };
      return slots[index];
    },
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
    useEffect: () => {},
    useLayoutEffect: () => {},
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
    Fragment: Symbol('Fragment'),
    createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children: children.length <= 1 ? children[0] : children } }),
  };
  React.useState.__reset = () => { slots = []; at = 0; };
  return React;
}

/** 一个 JSX 调用在 stub 里就是一个普通对象。 */
function createJsxRuntime(React) {
  const make = (kind) => (type, props) => ({
    type,
    props: props ?? {},
    [kind]: true,
    __isElement: true,
  });
  return { jsx: make('__jsx'), jsxs: make('__jsxs'), Fragment: React.Fragment };
}

/** 官方原语的替身：只保留实证存在的名字。 */
function createPrimitives() {
  const make = (name) => function Primitive(props) { return { type: `#${name}`, props: props ?? {}, __isElement: true }; };
  return { Input: make('Input'), Button: make('Button'), StateDot: make('StateDot'), MarkdownText: make('MarkdownText'), Tooltip: make('Tooltip'), DisclosureRow: make('DisclosureRow'), HoverCard: make('HoverCard') };
}

/**
 * 在 stub 运行时里跑一个 bundle，回传它注册进 `settings.section` 的组件。
 * @param file - `lib/client.js` 路径。
 * @returns 注册到的组件数组（可能为空）。
 */
function loadBundle(file) {
  const React = createReact();
  const jsxRuntime = createJsxRuntime(React);
  const primitives = createPrimitives();
  const modules = {
    react: React,
    'react/jsx-runtime': jsxRuntime,
    '@deepseek-ai/dsh-client-ui-primitives': primitives,
  };
  const registered = [];
  const loaded = [];
  const storage = () => {
    const map = new Map();
    return { getItem: (key) => (map.has(key) ? map.get(key) : null), setItem: (key, value) => map.set(key, String(value)), removeItem: (key) => map.delete(key), clear: () => map.clear(), key: (at) => [...map.keys()][at] ?? null, get length() { return map.size; } };
  };
  const window = { __ModuleLoader__: { load: (definition) => loaded.push(definition) }, localStorage: storage(), sessionStorage: storage(), addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }), requestAnimationFrame: () => 0, cancelAnimationFrame() {}, setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {}, getComputedStyle: () => ({ getPropertyValue: () => '' }), navigator: { userAgent: 'probe', hardwareConcurrency: 1, languages: ['zh-CN'] }, location: { href: 'http://127.0.0.1/' } };
  const element = () => ({
    style: { setProperty() {}, removeProperty() {}, getPropertyValue: () => '' },
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false, replace() {} },
    setAttribute() {}, removeAttribute() {}, getAttribute: () => null, hasAttribute: () => false, toggleAttribute: () => false,
    appendChild() {}, removeChild() {}, replaceChildren() {}, insertBefore() {}, append() {}, prepend() {},
    after() {}, before() {}, remove() {}, replaceWith() {}, insertAdjacentHTML() {}, insertAdjacentElement() { return null; },
    addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true,
    querySelector: () => null, querySelectorAll: () => [], getElementsByClassName: () => [],
    getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 }),
    getClientRects: () => [], contains: () => false, closest: () => null, matches: () => false,
    focus() {}, blur() {}, click() {}, setPointerCapture() {}, releasePointerCapture() {},
    scrollTo() {}, scrollBy() {}, scrollIntoView() {}, animate: () => ({ finished: Promise.resolve(), cancel() {} }),
    attachShadow: () => element(), cloneNode() { return element(); },
    getAnimations: () => [],
    firstElementChild: null, lastElementChild: null, parentElement: null, nextElementSibling: null, previousElementSibling: null,
    children: [], childNodes: [], textContent: '', innerHTML: '', outerHTML: '', value: '', checked: false,
  });
  const documentStub = {
    documentElement: element(),
    body: element(),
    head: element(),
    createElement: () => element(),
    createElementNS: () => element(),
    createTextNode: () => ({}),
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {}, removeEventListener() {},
    createRange: () => ({ setStart() {}, setEnd() {}, collapse() {}, getBoundingClientRect: () => ({}) }),
  };
  const source = readFileSync(file, 'utf8');
  const params = ['window', 'document', 'process', 'setTimeout', 'setInterval', 'requestAnimationFrame', 'MutationObserver', 'queueMicrotask', 'localStorage', 'sessionStorage', 'navigator', 'matchMedia', 'getComputedStyle', 'location', 'fetch', 'EventSource', 'ResizeObserver', 'IntersectionObserver'];
  const factory = new Function(...params, `${source}\nreturn undefined;`);
  const inert = class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } };
  factory(
    window, documentStub, { env: {} }, () => 0, () => 0, () => 0, inert, (fn) => fn(),
    window.localStorage, window.sessionStorage, window.navigator, window.matchMedia, window.getComputedStyle, window.location,
    () => Promise.reject(new Error('probe: network disabled')), class { addEventListener() {} close() {} }, inert, inert,
  );
  const context = {
    effect: () => {},
    slots: {
      inject: (_name, provider) => provider(),
      register: (definition, component) => { registered.push({ definition, component }); return () => {}; },
    },
    settingsScope: { bind: () => ({ getSnapshot: () => ({ value: {}, writable: true }), subscribe: () => () => {}, set: async () => {}, mutate: async () => {} }) },
    sessions: { list: { subscribe: () => () => {}, getSnapshot: () => ({ ids: [] }) }, binding: () => null },
    get: () => undefined,
    locale: { register: () => {} },
    web: { registerSearchProvider: () => {} },
  };
  for (const definition of loaded) {
    // 不许静默跳过：bundle 的工厂/apply 抛错就是归一化没接好（例如内联块用了
    // 工厂里不存在的 module.exports），必须当场红。
    definition.factory((name) => {
      if (!(name in modules)) throw new Error(`bundle 依赖了冻结模块表以外的模块：${name}`);
      return modules[name];
    }).apply?.(context);
  }
  return registered
    .filter((entry) => ASK_CARDS.has(entry.definition?.name ?? ''))
    .map((entry) => ({ slot: entry.definition?.name, component: entry.component }));
}

/** 会承载"向用户提问"的槽位。 */
export const ASK_CARDS = new Set([
  'settings.section',
  'conversation.input.left',
  'conversation.session.header.utilities',
]);

/** 先把函数组件展开成元素树（卡的根常常是个函数组件）。 */
function renderTree(node) {
  if (node === null || node === undefined || typeof node !== 'object') return node;
  if (typeof node.type === 'function') return renderTree(node.type(node.props ?? {}));
  const raw = node.props?.children;
  const kids = (Array.isArray(raw) ? raw : [raw]).flat(Infinity).map(renderTree).filter((child) => child !== undefined && child !== null);
  return { ...node, props: { ...node.props, children: kids } };
}

/** 走一遍元素树。 */
function walk(node, visit) {
  if (node === null || node === undefined || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const item of node) walk(item, visit); return; }
  if (node.__isElement) { visit(node); walk(node.props?.children, visit); }
}

test('设置卡里不再出现裸提问件，状态文案只来自 ASK_TEXT', () => {
  const report = [];
  for (const pkg of BUNDLES) {
    const file = join(REPO, pkg, 'lib', 'client.js');
    if (!existsSync(file)) continue;
    const source = readFileSync(file, 'utf8');
    const cards = loadBundle(file);
    const usesKit = /fairyAskKit|createAskKit/.test(source.replace(/\/\/ >>> fairy-ask-kit[\s\S]*?\/\/ <<< fairy-ask-kit/, ''));
    let rawForms = 0;
    let askControls = 0;
    const texts = new Set();
    for (const { slot, component } of cards) {
      const tree = renderTree(component({ scope: undefined, t: (key) => key }));
      walk(tree, (node) => {
        if (typeof node.type === 'string' && ['input', 'select', 'textarea'].includes(node.type)) {
          // 归一化套件自带的原生件会带 data-ask，裸件不会。
          if (node.props?.['data-ask'] === undefined) rawForms += 1;
          else askControls += 1;
        }
        if (node.type === '#Input' || node.type === '#Button') askControls += 1;
        if (typeof node.props?.children === 'string') texts.add(node.props.children);
      });
      if (rawForms > 0) report.push(`${pkg}:${slot} 仍有裸件`);
    }
    const normalized = new Set(Object.values(ASK_TEXT).filter((value) => typeof value === 'string'));
    // 只看**像状态行**的短句：描述性长句（
    // “密钥只保存在本机设置文件中……”）不算自造状态文案。
    const STATUS_SHAPE = /^(正在读取|已保存|没有需要保存|保存中|测试中|保存失败|暂时读不到|当前会话不可写入)/;
    const strayStatus = [...texts].filter((text) => text.length <= 40 && STATUS_SHAPE.test(text) && !normalized.has(text));
    report.push(`${pkg}: 卡 ${cards.length} · 归一化控件 ${askControls} · 裸件 ${rawForms} · 自造状态文案 ${strayStatus.length}${strayStatus.length ? `（${strayStatus.slice(0, 3).join(' / ')}）` : ''}`);
    if (usesKit) {
      assert.ok(cards.length > 0, `${pkg} 用了提问件套件，但没有任何提问卡注册到已知槽位`);
      assert.ok(askControls > 0, `${pkg} 的卡片里没有渲染出归一化控件`);
    }
    assert.equal(rawForms, 0, `${pkg} 的设置卡里还有裸 input/select/textarea`);
    assert.deepEqual(strayStatus, [], `${pkg} 还在自造状态文案`);
  }
  console.log(report.join('\n'));
});
