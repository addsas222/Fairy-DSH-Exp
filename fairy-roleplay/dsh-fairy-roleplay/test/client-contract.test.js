import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';

/** 归一化提问件的真源：卡里该出现的文案与期望标记都从这里取，测试不另造一份。 */
const { ASK_TEXT } = createRequire(import.meta.url)('dsh-fairy-contracts/client-ask-kit');

/** 宿主 `/fairy-roleplay/state` 的回复形状（见 lib/index.js）。 */
const STATE = {
  ok: true,
  config: {
    version: 1,
    humanizerLevel: 'l3',
    timingGate: false,
    styleEnabled: true,
    autoCheck: true,
    memoryImpression: true,
    stylePath: '',
  },
  style: { path: 'C:/home/.dsh/fairy-roleplay/style.json', count: 2, preview: '· 条目一' },
  levels: ['off', 'l1', 'l2', 'l3', 'l4'],
};

const json = (body) => ({ ok: true, status: 200, json: async () => body });

const flatten = (children) => {
  if (children === undefined) return [];
  return (Array.isArray(children) ? children : [children]).flat(Infinity);
};

/**
 * 把函数组件展开成宿主元素：卡自己用 hook，套件里的提问件都是无状态纯函数件，
 * 这里逐层调用它们，才看得到真正落到 DOM 上的 `input`/`select`。
 */
function expand(node) {
  if (node === null || node === undefined || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(expand);
  if (typeof node.type === 'function') return expand(node.type(node.props ?? {}));
  return { ...node, props: { ...node.props, children: expand(node.props?.children) } };
}

/** The bundle's own view of a rendered element tree. */
function texts(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return [];
  if (typeof node === 'string' || typeof node === 'number') return [String(node)];
  if (Array.isArray(node)) return node.flatMap(texts);
  return texts(node.props?.children);
}

function findNodes(node, predicate, found = []) {
  if (node === null || node === undefined || typeof node !== 'object') return found;
  if (typeof node.type !== 'undefined' && predicate(node)) found.push(node);
  for (const child of flatten(node.props?.children)) findNodes(child, predicate, found);
  return found;
}

function findNode(node, predicate) {
  const [first] = findNodes(node, predicate);
  assert.notEqual(first, undefined, 'expected a matching node in the rendered tree');
  return first;
}

/** 官方原语替身：调用后留下可断言的名字与 props，和 fairy-system 的门禁同一套约定。 */
const primitive = (name) => function Primitive(props) { return { type: `#${name}`, props: props ?? {} }; };

const INPUT = '#Input';
const BUTTON = '#Button';

/** 让挂起的 fetch 与 promise 链落地。 */
async function flush(ticks = 3) {
  for (let tick = 0; tick < ticks; tick += 1) await new Promise((resolve) => setImmediate(resolve));
}

/**
 * Minimal hook runtime: enough React for `useAskForm` and the card (state,
 * refs, callbacks and effects keyed by dependency identity) so a change plus a
 * click can be exercised without a DOM renderer.
 */
function createRuntime() {
  let hooks = [];
  let index = 0;
  let current = null;
  let pending = [];
  const render = () => {
    index = 0;
    pending = [];
    const tree = expand(current.component(current.props));
    const effects = pending;
    pending = [];
    return { tree, effects };
  };
  const React = {
    useState(initial) {
      const slot = index++;
      if (!(slot in hooks)) hooks[slot] = typeof initial === 'function' ? initial() : initial;
      return [hooks[slot], (value) => { hooks[slot] = typeof value === 'function' ? value(hooks[slot]) : value; }];
    },
    useRef(initial) {
      const slot = index++;
      if (!(slot in hooks)) hooks[slot] = { current: initial };
      return hooks[slot];
    },
    useCallback(callback) { return callback; },
    useEffect(callback, deps) {
      const slot = index++;
      const previous = hooks[slot];
      const list = deps ?? [];
      if (previous !== undefined && previous.list.length === list.length && list.every((value, at) => Object.is(value, previous.list[at]))) return;
      hooks[slot] = { list: Array.from(list) };
      pending.push(callback);
    },
  };
  return {
    React,
    /** Mount the card: render → run the mount effect → let promises settle → render again. */
    async mount(component) {
      current = { component, props: {} };
      hooks = [];
      const first = render();
      for (const effect of first.effects) effect();
      await flush();
      return render().tree;
    },
    /** Re-render after an event changed state; returns that render (effects run after it). */
    repaint() {
      const pass = render();
      for (const effect of pass.effects) effect();
      return pass.tree;
    },
  };
}

/** Load the hand-written browser bundle the way the client runtime does. */
async function loadBundle(primitiveOverrides = {}) {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
  let captured = null;
  const requests = [];
  let reply = async (url) => { throw new Error(`unexpected fetch ${url}`); };
  const fetch = (url, options) => {
    requests.push(options === undefined ? { url } : { url, options });
    return reply(url, options);
  };
  const window = { __ModuleLoader__: { load: (config) => { captured = config; } } };
  // eslint-disable-next-line no-new-func -- the bundle is a plain script, exactly as shipped.
  new Function('window', 'fetch', source)(window, fetch);
  assert.ok(captured !== null, 'the bundle must call window.__ModuleLoader__.load');
  const runtime = createRuntime();
  const stubs = {
    react: runtime.React,
    'react/jsx-runtime': { jsx: (type, props) => ({ type, props: props ?? {} }), jsxs: (type, props) => ({ type, props: props ?? {} }) },
    '@deepseek-ai/dsh-client-ui-primitives': { Button: primitive('Button'), StateDot: primitive('StateDot'), ...primitiveOverrides },
  };
  return {
    source,
    id: captured.id,
    api: captured.factory((name) => {
      if (!(name in stubs)) throw new Error(`unexpected require(${name})`);
      return stubs[name];
    }),
    runtime,
    requests,
    onFetch(impl) { reply = impl; },
  };
}

/** Load the bundle and pull the settings card out of its slot registration. */
async function mountBundle(primitiveOverrides = {}) {
  const bundle = await loadBundle(primitiveOverrides);
  let component = null;
  const ctx = {
    slots: {
      inject: (_name, provider) => { provider(); return () => {}; },
      register: (_definition, registered) => { component = registered; return () => {}; },
    },
    effect: (callback) => callback(),
  };
  bundle.api.apply(ctx);
  assert.equal(typeof component, 'function', 'the slot must receive a component');
  return { ...bundle, mount: () => bundle.runtime.mount(component), repaint: () => bundle.runtime.repaint() };
}

test('the bundle registers exactly one settings section, keyed for the runtime', async () => {
  const { id, api } = await loadBundle();
  assert.equal(id, 'dsh-fairy-roleplay');
  assert.deepEqual(api.inject, ['slots']);
  const registered = [];
  const injections = [];
  const ctx = {
    slots: {
      inject: (name, provider) => {
        injections.push({ name, provider });
        return () => {};
      },
      register: (definition, component) => {
        registered.push({ definition, component });
        return () => {};
      },
    },
    effect: (callback) => callback(),
  };
  api.apply(ctx);
  assert.equal(injections.length, 1);
  assert.equal(injections[0].name, 'settings.section');
  injections[0].provider();
  assert.equal(registered.length, 1);
  assert.equal(registered[0].definition.id, 'fairy-roleplay');
  assert.equal(registered[0].definition.order, 34);
  assert.equal(typeof registered[0].component, 'function', 'the slot must receive a component');
});

test('a repeated slot injection releases the previous registration', async () => {
  const { api } = await loadBundle();
  let live = 0;
  let released = 0;
  const provider = { register: () => { live += 1; return () => { live -= 1; released += 1; }; } };
  const ctx = {
    slots: {
      inject: (_name, run) => run(),
      get register() { return provider.register; },
    },
    effect: (callback) => callback(),
  };
  api.apply(ctx);
  assert.equal(live, 1);
  assert.equal(released, 0);
});

test('the card asks through the kit controls, with the host values and the schema keys intact', async () => {
  const bundle = await mountBundle();
  bundle.onFetch(async (url) => {
    assert.equal(url, '/fairy-roleplay/state', 'the card reads the route this package serves');
    return json(STATE);
  });

  const tree = await bundle.mount();
  assert.deepEqual(bundle.requests.map((request) => request.url), ['/fairy-roleplay/state']);

  // `data-ask` 只出现在套件自带的原生件上：这张卡里没有手搓的 input/select/checkbox。
  const controls = findNodes(tree, (node) => typeof node.props?.['data-ask'] === 'string');
  assert.deepEqual(controls.map((node) => node.props['data-ask']), ['select', 'toggle', 'toggle', 'toggle', 'toggle', 'text']);

  const [level, ...fields] = controls;
  const toggles = fields.slice(0, 4);
  const stylePath = fields[4];
  assert.deepEqual(toggles.map((node) => node.props.id), [
    'dsh-fairy-roleplay-toggle-timingGate',
    'dsh-fairy-roleplay-toggle-styleEnabled',
    'dsh-fairy-roleplay-toggle-autoCheck',
    'dsh-fairy-roleplay-toggle-memoryImpression',
  ]);
  // 开关语义没动：只有显式的 false 才算关。
  assert.deepEqual(toggles.map((node) => node.props.checked), [false, true, true, true]);
  assert.equal(level.props.value, 'l3');
  assert.deepEqual(level.props.children.map((option) => option.props.value), ['off', 'l1', 'l2', 'l3', 'l4']);
  assert.equal(stylePath.props.id, 'dsh-fairy-roleplay-style-path');
  assert.equal(stylePath.props.value, '');
  assert.equal(stylePath.props.placeholder, STATE.style.path);
  // 风格库的条数与路径来自宿主回复，不是卡自己数的。
  assert.ok(texts(tree).some((text) => text.includes('风格库 2 条')), 'the style library line comes from the host read');
});

test('a toggle edit is written back with only the keys the user touched', async () => {
  const bundle = await mountBundle();
  let written = null;
  bundle.onFetch(async (url, options) => {
    if (url === '/fairy-roleplay/state') return json(STATE);
    if (url === '/fairy-roleplay/config') {
      written = JSON.parse(options.body);
      assert.equal(options.method, 'POST');
      return json({ ok: true, config: { ...STATE.config, timingGate: true }, changed: ['timingGate'] });
    }
    throw new Error(`unexpected fetch ${url}`);
  });

  const tree = await bundle.mount();
  findNode(tree, (node) => node.props?.id === 'dsh-fairy-roleplay-toggle-timingGate').props.onChange({ target: { checked: true } });

  const painted = bundle.repaint();
  const [save] = findNodes(painted, (node) => node.type === BUTTON);
  assert.equal(save.props.disabled, false, 'an idle card offers the save button');
  await save.props.onClick();

  assert.deepEqual(written, { timingGate: true });
  // 状态行用的是归一化文案，不是这张卡自己造的那句。
  assert.ok(texts(bundle.repaint()).includes(ASK_TEXT.saved), 'the save status is the kit copy');
});

test('saving with nothing edited writes nothing and uses the kit "unchanged" copy', async () => {
  const bundle = await mountBundle();
  bundle.onFetch(async (url) => {
    assert.equal(url, '/fairy-roleplay/state');
    return json(STATE);
  });

  const tree = await bundle.mount();
  const [save] = findNodes(tree, (node) => node.type === BUTTON);
  await save.props.onClick();

  assert.deepEqual(bundle.requests.map((request) => request.url), ['/fairy-roleplay/state'], 'no write for an untouched card');
  assert.ok(texts(bundle.repaint()).includes(ASK_TEXT.unchanged), 'the unchanged status is the kit copy');
});

test('while a save is in flight the fields and the save button are locked', async () => {
  const bundle = await mountBundle();
  let release = null;
  bundle.onFetch(async (url) => {
    if (url === '/fairy-roleplay/state') return json(STATE);
    return new Promise((resolve) => {
      release = () => resolve(json({ ok: true, config: { ...STATE.config, timingGate: true }, changed: ['timingGate'] }));
    });
  });

  const tree = await bundle.mount();
  findNode(tree, (node) => node.props?.id === 'dsh-fairy-roleplay-toggle-timingGate').props.onChange({ target: { checked: true } });
  const inFlight = findNode(bundle.repaint(), (node) => node.type === BUTTON).props.onClick();

  const busy = bundle.repaint();
  const [save] = findNodes(busy, (node) => node.type === BUTTON);
  assert.equal(save.props.disabled, true);
  assert.ok(texts(save).includes(ASK_TEXT.saving), 'the busy button says 保存中…');
  const controls = findNodes(busy, (node) => typeof node.props?.['data-ask'] === 'string');
  assert.deepEqual(controls.map((node) => node.props.disabled), [true, true, true, true, true, true]);

  release();
  await inFlight;
  await flush();
});

test('the card hands the official primitives to the kit, so fields use the official input', async () => {
  const bundle = await mountBundle({ Input: primitive('Input') });
  bundle.onFetch(async () => json(STATE));

  const tree = await bundle.mount();
  const field = findNode(tree, (node) => node.type === INPUT);
  assert.equal(field.props.id, 'dsh-fairy-roleplay-style-path');
  assert.equal(field.props.placeholder, STATE.style.path);
  assert.equal(findNodes(tree, (node) => node.props?.['data-ask'] === 'text').length, 0, 'no native fallback once the official input exists');
});

test('before the host answers the card still renders kit controls, not bare ones', async () => {
  const bundle = await mountBundle();
  bundle.onFetch(() => new Promise(() => {}));

  const tree = await bundle.mount();
  assert.ok(texts(tree).includes(ASK_TEXT.loading), 'the loading status is the kit copy');
  const raw = findNodes(tree, (node) => typeof node.type === 'string' && ['input', 'select', 'textarea'].includes(node.type) && node.props?.['data-ask'] === undefined);
  assert.deepEqual(raw, [], 'no bare ask control, even before the read lands');
  const controls = findNodes(tree, (node) => typeof node.props?.['data-ask'] === 'string');
  assert.equal(controls.length, 6, 'the card still offers its fields while loading');
});
