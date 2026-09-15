import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
/** 卡片的状态文案必须是真源那一份：测试不另抄一份字面量。 */
const { ASK_TEXT } = createRequire(import.meta.url)('../../../fairy-contracts/client-ask-kit.cjs');

const DEFAULT_KEY = 'dsh.fairyModes.default.v1';
const APPLIED = (sessionId) => `dsh.fairyModes.applied.${sessionId}`;

/** The bundle's own view of a rendered element tree. */
function texts(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return [];
  if (typeof node === 'string' || typeof node === 'number') return [String(node)];
  if (Array.isArray(node)) return node.flatMap(texts);
  return texts(node.props?.children);
}

/** React children are a node, an array, or nothing — never a bare iterable. */
function childrenOf(node) {
  const children = node.props?.children;
  if (children === null || children === undefined || typeof children === 'boolean') return [];
  return Array.isArray(children) ? children : [children];
}

function nodes(node, found = []) {
  if (Array.isArray(node)) {
    for (const child of node) nodes(child, found);
    return found;
  }
  if (node === null || typeof node !== 'object') return found;
  if (typeof node.type !== 'undefined') found.push(node);
  for (const child of childrenOf(node)) nodes(child, found);
  return found;
}

function nodeWith(tree, predicate, label) {
  const hit = nodes(tree).find(predicate);
  assert.ok(hit, `no node matching ${label}`);
  return hit;
}

/**
 * Render function components the way React would: the card returns ask-kit
 * elements (`AskSection`/`AskRow`/`AskSelect`/`AskActions`), and only invoking
 * them reaches the markup the kit renders. Every hook in the card belongs to the
 * root component, so expanding runs after its hooks are read.
 */
function expand(node) {
  if (Array.isArray(node)) return node.map(expand);
  if (node === null || typeof node !== 'object') return node;
  const props = node.props ?? {};
  const children = expand(props.children);
  if (typeof node.type === 'function') return expand(node.type({ ...props, children }));
  return { ...node, props: { ...props, children } };
}

/** Minimal hook runtime: state, refs, and once-per-dependency effects. */
function hookDriver() {
  let hooks = [];
  let index = 0;
  let current = null;
  let tree = null;
  const React = {
    useCallback: (callback) => callback,
    useState(initial) {
      const at = index++;
      if (!(at in hooks)) hooks[at] = typeof initial === 'function' ? initial() : initial;
      return [hooks[at], (value) => {
        hooks[at] = typeof value === 'function' ? value(hooks[at]) : value;
        render();
      }];
    },
    useRef(initial) {
      const at = index++;
      if (!(at in hooks)) hooks[at] = { current: initial };
      return hooks[at];
    },
    useEffect(callback, deps) {
      const at = index++;
      const previous = hooks[at];
      if (previous !== undefined && previous.deps.every((value, position) => value === deps?.[position])) return;
      previous?.cleanup?.();
      // Record the deps before running: a callback that sets state re-renders
      // synchronously here, and that nested render must see them.
      const entry = { deps: deps ?? [], cleanup: undefined };
      hooks[at] = entry;
      entry.cleanup = callback();
    },
  };
  const render = () => {
    index = 0;
    tree = expand(current.component(current.props));
    return tree;
  };
  return {
    React,
    render(component, props) { current = { component, props }; hooks = []; return render(); },
    tree: () => tree,
  };
}

/** A Web Storage double with the browser's null-for-missing contract. */
function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => { values.set(key, String(value)); },
    removeItem: (key) => { values.delete(key); },
    key: (index) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  };
}

/** Load the bundle into a sandbox with controllable fetch and browser storage. */
function loadBundle() {
  const requests = [];
  const events = [];
  const localStorage = memoryStorage();
  const sessionStorage = memoryStorage();
  const noop = () => {};
  let fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, mode: 'off', plan: null }) });
  const sandbox = {
    console,
    document: { addEventListener: noop, removeEventListener: noop },
    CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
    fetch: (...args) => {
      requests.push(args.length > 1 ? { url: args[0], options: args[1] } : { url: args[0] });
      return fetchImpl(...args);
    },
    localStorage,
    sessionStorage,
    setImmediate,
  };
  sandbox.window = sandbox;
  sandbox.window.addEventListener = noop;
  sandbox.window.removeEventListener = noop;
  sandbox.window.dispatchEvent = (event) => { events.push(event); return true; };
  const entries = [];
  sandbox.__ModuleLoader__ = { load: (entry) => entries.push(entry) };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  assert.equal(entries.length, 1);
  const driver = hookDriver();
  const element = (type, props) => ({ type, props: props ?? {} });
  /** 官方原语替身：只保留实证存在的名字，并记下卡片实际传了什么。 */
  const primitiveCalls = [];
  const named = (name, tag) => (props) => {
    primitiveCalls.push({ name, props });
    return element(tag, props);
  };
  const primitives = { Input: named('Input', 'input'), Button: named('Button', 'button'), StateDot: named('StateDot', 'span') };
  const exported = entries[0].factory((id) => {
    if (id === 'react') return driver.React;
    if (id === 'react/jsx-runtime') return { jsx: element, jsxs: element };
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return primitives;
    throw new Error(`unexpected require(${id})`);
  });
  return {
    id: entries[0].id,
    exported,
    driver,
    requests,
    events,
    primitiveCalls,
    localStorage,
    sessionStorage,
    onFetch(impl) { fetchImpl = impl; },
    /** Let the component's async bridge/default work settle. */
    async settle(rounds = 4) {
      for (let round = 0; round < rounds; round += 1) await new Promise(resolve => setImmediate(resolve));
    },
  };
}

/** Install the bundle through a fake client context; returns the slot registry. */
function register(bundle) {
  const slots = new Map();
  const ctx = {
    effect: (factory) => factory(),
    slots: {
      inject: (name, provider) => provider(),
      register: (definition, component) => {
        slots.set(definition.id, { definition, component });
        return () => {};
      },
    },
  };
  bundle.exported.apply(ctx);
  assert.deepEqual(Array.from(bundle.exported.inject), ['slots']);
  return slots;
}

const setRequests = (bundle) => bundle.requests.filter(request => request.url === '/fairy-modes/set');

test('registers the 模式 settings section and keeps the header chip', () => {
  const bundle = loadBundle();
  const slots = register(bundle);
  const section = slots.get('fairy-modes');
  assert.ok(section, 'the 模式 settings section should be registered');
  assert.equal(section.definition.name, 'settings.section');
  assert.equal(section.definition.order, 29);
  assert.equal(section.definition.label(), '模式');
  const chip = slots.get('fairy-modes-chip');
  assert.equal(chip.definition.name, 'conversation.session.header.utilities');
  assert.equal(chip.definition.order, 20);
});

test('the settings card explains the modes and persists the new-session default through the ask kit', async () => {
  const bundle = loadBundle();
  const slots = register(bundle);
  const render = () => bundle.driver.render(slots.get('fairy-modes').component, {});
  const tree = () => bundle.driver.tree();
  const select = () => nodeWith(tree(), (node) => node.type === 'select', 'the default-mode select');
  const saveButton = () => nodeWith(
    tree(),
    (node) => node.type === 'button' && node.props.variant === 'primary',
    'the save button',
  );

  render();
  await bundle.settle(8);
  const rendered = JSON.stringify(tree());
  for (const term of ['极简', '官方 plan-mode', '/plan', '探查·只读', '建造·PTC', 'run_code', '创造·回忆', 'session_recall', 'SKILL.md', 'scaffold-plugin.js']) {
    assert.ok(rendered.includes(term), `the card should explain ${term}`);
  }

  // 归一化：卡里没有裸提问件，下拉是套件自带的那个（data-ask 是它的自证标记）。
  const control = (node) => typeof node.type === 'string' && ['input', 'select', 'textarea'].includes(node.type);
  assert.deepEqual(
    nodes(tree()).filter(node => control(node) && node.props['data-ask'] === undefined).map(node => node.type),
    [],
    '卡里不该再出现裸 input/select/textarea',
  );
  assert.ok(
    nodes(tree()).some(node => control(node) && node.props['data-ask'] === 'select'),
    '下拉来自归一化套件（带 data-ask 标记）',
  );

  // 归一化：下拉由 AskSelect 渲染，选项与 id 由卡片给定。
  const dropdown = select();
  assert.equal(dropdown.props.id, 'dsh-fairy-modes-default');
  assert.deepEqual(
    Array.from(dropdown.props.children, option => option.props.value),
    ['', 'explore', 'ptc', 'roleplay', 'create', 'off'],
    'the dropdown offers 不设置/建造/创造/关闭',
  );
  assert.deepEqual(Array.from(texts(dropdown.props.children[0])), ['不设置（新会话保持 off）']);
  assert.equal(dropdown.props.value, '', 'with no preference stored the dropdown shows 不设置');
  assert.equal(bundle.localStorage.getItem(DEFAULT_KEY), null, '不设置 writes nothing');

  // 选择只改草稿：落盘要经过归一化的保存按钮，不再在 onChange 里直接写。
  dropdown.props.onChange({ target: { value: 'create' } });
  assert.equal(bundle.localStorage.getItem(DEFAULT_KEY), null, 'a selection is a draft, not a write');
  assert.equal(select().props.value, 'create', 'the dropdown mirrors the draft');

  // 动作行是官方 Button 原语，主按钮就是归一化那句「保存」。
  assert.ok(
    bundle.primitiveCalls.some(call => call.name === 'Button' && call.props.variant === 'primary' && call.props.size === 'sm'),
    'the actions row goes through the official Button',
  );
  assert.deepEqual(Array.from(texts(saveButton())), [ASK_TEXT.save]);
  assert.equal(saveButton().props.disabled, false);

  saveButton().props.onClick();
  // 忙态：同一个按钮换成「保存中…」并禁用，下拉也锁住。
  assert.deepEqual(Array.from(texts(saveButton())), [ASK_TEXT.saving]);
  assert.equal(saveButton().props.disabled, true, '保存期间按钮禁用');
  assert.equal(select().props.disabled, true, '保存期间下拉锁定');
  await bundle.settle(8);
  assert.equal(bundle.localStorage.getItem(DEFAULT_KEY), 'create', '保存落盘');
  assert.equal(select().props.value, 'create', 'the dropdown reads the saved preference back');

  // 没有改动就不写盘，状态行用的是归一化那句「没有需要保存的改动。」
  select().props.onChange({ target: { value: 'create' } });
  saveButton().props.onClick();
  await bundle.settle(8);
  assert.ok(texts(tree()).includes(ASK_TEXT.unchanged), ASK_TEXT.unchanged);

  // 回到不设置会删掉这个键。
  select().props.onChange({ target: { value: '' } });
  saveButton().props.onClick();
  await bundle.settle(8);
  assert.equal(bundle.localStorage.getItem(DEFAULT_KEY), null, '不设置 removes the key');

  // 浏览器拒绝写入时说 saveFailed，而不是假装已保存。
  select().props.onChange({ target: { value: 'ptc' } });
  bundle.localStorage.setItem = () => { throw new Error('QuotaExceededError'); };
  saveButton().props.onClick();
  await bundle.settle(8);
  const spoken = texts(tree());
  assert.ok(spoken.some(text => text.startsWith('保存失败：')), 'a rejected write is reported');
  assert.equal(spoken.includes(ASK_TEXT.saved), false, 'a rejected write is not reported as saved');
});

test('a fresh session takes the configured default exactly once', async () => {
  const bundle = loadBundle();
  const slots = register(bundle);
  bundle.localStorage.setItem(DEFAULT_KEY, 'create');
  bundle.onFetch(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, mode: 'off', plan: null }) }));

  bundle.driver.render(slots.get('fairy-modes-chip').component, { sessionId: 's-new', inputActions: undefined });
  await bundle.settle();

  const posted = setRequests(bundle);
  assert.equal(posted.length, 1, 'the default is applied once');
  assert.deepEqual(JSON.parse(posted[0].options.body), { sessionId: 's-new', mode: 'create' });
  assert.equal(bundle.sessionStorage.getItem(APPLIED('s-new')), '1', 'the session is marked as handled');
});

test('the default yields to a logged mode, an applied mark, or no preference', async () => {
  // (a) A session whose fold already carries a mode is never overwritten.
  const logged = loadBundle();
  const loggedSlots = register(logged);
  logged.localStorage.setItem(DEFAULT_KEY, 'create');
  logged.onFetch(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, mode: 'ptc', plan: null }) }));
  logged.driver.render(loggedSlots.get('fairy-modes-chip').component, { sessionId: 's-logged', inputActions: undefined });
  await logged.settle();
  assert.equal(setRequests(logged).length, 0);

  // (b) A session already handled in this tab is not re-applied.
  const applied = loadBundle();
  const appliedSlots = register(applied);
  applied.localStorage.setItem(DEFAULT_KEY, 'create');
  applied.sessionStorage.setItem(APPLIED('s-applied'), '1');
  applied.onFetch(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, mode: 'off', plan: null }) }));
  applied.driver.render(appliedSlots.get('fairy-modes-chip').component, { sessionId: 's-applied', inputActions: undefined });
  await applied.settle();
  assert.equal(setRequests(applied).length, 0);

  // (c) No configured default means no request at all.
  const unset = loadBundle();
  const unsetSlots = register(unset);
  unset.onFetch(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, mode: 'off', plan: null }) }));
  unset.driver.render(unsetSlots.get('fairy-modes-chip').component, { sessionId: 's-unset', inputActions: undefined });
  await unset.settle();
  assert.equal(setRequests(unset).length, 0);
});

test('a manual chip selection owns its session, but 极简 does not', async () => {
  const bundle = loadBundle();
  const slots = register(bundle);
  const chip = slots.get('fairy-modes-chip').component;
  const drafts = [];
  bundle.onFetch(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, mode: 'off', plan: null }) }));
  bundle.driver.render(chip, {
    sessionId: 's-manual',
    inputActions: { setDraft: (text) => drafts.push(text), submit: () => drafts.push('submit') },
  });
  await bundle.settle();
  assert.equal(setRequests(bundle).length, 0, 'no preference is configured');

  const open = () => bundle.driver.tree().props.children[0].props.onClick();
  const row = (needle) => nodeWith(
    bundle.driver.tree(),
    (node) => node.type === 'button' && texts(node).some(text => text.includes(needle)),
    `the ${needle} menu row`,
  );

  open();
  row('探查·极简').props.onClick();
  assert.deepEqual(drafts, ['/plan', 'submit'], '极简 drives the official plan command');
  assert.equal(bundle.sessionStorage.getItem(APPLIED('s-manual')), null, '极简 is orthogonal and marks nothing');

  open();
  row('创造·回忆').props.onClick();
  await bundle.settle();
  const posted = setRequests(bundle);
  assert.equal(posted.length, 1);
  assert.deepEqual(JSON.parse(posted[0].options.body), { sessionId: 's-manual', mode: 'create' });
  assert.equal(bundle.sessionStorage.getItem(APPLIED('s-manual')), '1', 'the manual choice is marked as handled');
  assert.equal(bundle.events.at(-1).type, 'fairy-modes-changed');
  assert.equal(bundle.events.at(-1).detail.mode, 'create');
});
