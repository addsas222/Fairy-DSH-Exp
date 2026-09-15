import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const clientPath = new URL('../lib/client.js', import.meta.url);
const source = await readFile(clientPath, 'utf8');
// Source patterns stay line-ending agnostic; the embedded diagnostics block is
// compared to the canonical file after the same normalisation, because this
// repository is developed on both CRLF and LF checkouts.
const code = source.replace(/\r\n/g, '\n');
const card = (await readFile(new URL('../src/client/index.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const canonicalClientDiagnostics = (await readFile(new URL('../../../fairy-contracts/client-diagnostics.cjs', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const canonicalAskKit = (await readFile(new URL('../../../fairy-contracts/client-ask-kit.cjs', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
/** 归一化提问件的文案与行为都在这一份真源里，包内测试只认它。 */
const { ASK_TEXT } = createRequire(import.meta.url)('../../../fairy-contracts/client-ask-kit.cjs');

function embeddedClientDiagnostics(value) {
  const beginMarker = '// DSH_FAIRY_CLIENT_DIAGNOSTICS_BEGIN';
  const endMarker = '// DSH_FAIRY_CLIENT_DIAGNOSTICS_END';
  const begin = value.indexOf(beginMarker);
  const end = value.indexOf(endMarker);
  assert.notEqual(begin, -1, 'client bundle must embed the canonical diagnostics block');
  assert.notEqual(end, -1, 'client bundle must close the canonical diagnostics block');
  return value.slice(value.indexOf('\n', begin) + 1, end).replace(/\r\n/g, '\n');
}

/** 内联进 bundle 的提问件真源：`scripts/bundle.mjs` 用这对标记包住它。 */
function embeddedAskKit(value) {
  const beginMarker = '// >>> fairy-contracts/client-ask-kit.cjs';
  const endMarker = '// <<< fairy-contracts/client-ask-kit.cjs';
  const begin = value.indexOf(beginMarker);
  const end = value.indexOf(endMarker);
  assert.notEqual(begin, -1, 'client bundle must inline the canonical ask kit');
  assert.notEqual(end, -1, 'client bundle must close the inlined ask kit');
  return value.slice(value.indexOf('\n', begin) + 1, end).replace(/\r\n/g, '\n');
}

/** Flatten nested children arrays the way React does before rendering. */
function flatten(children) {
  return (Array.isArray(children) ? children : [children]).flat(Infinity);
}

/** Render function components into a plain element tree (styles/children only). */
function renderTree(node) {
  if (node === null || node === undefined || typeof node !== 'object') return node;
  if (typeof node.type === 'function') return renderTree(node.type(node.props || {}));
  const children = flatten(node.props?.children);
  const next = children.map(renderTree).filter((child) => child !== undefined);
  return { ...node, props: { ...node.props, children: Array.isArray(node.props?.children) ? next : next[0] } };
}

function findNodes(node, predicate) {
  const found = [];
  const visit = (current) => {
    if (current === null || current === undefined || typeof current !== 'object') return;
    if (typeof current.type !== 'undefined' && predicate(current)) found.push(current);
    for (const child of flatten(current.props?.children)) visit(child);
  };
  visit(node);
  return found;
}

function findNode(node, predicate) {
  const [first] = findNodes(node, predicate);
  assert.notEqual(first, undefined, 'expected a matching node in the rendered tree');
  return first;
}

/** 套件结果行的子节点：一个状态点 + 一段文字（`AskResult`）。 */
function resultChildren(node) {
  const children = node?.props?.children;
  if (!Array.isArray(children)) return null;
  const dot = children.find((child) => child?.type === 'state-dot');
  const text = children.find((child) => typeof child?.props?.children === 'string');
  return dot && text ? { dot, text: text.props.children } : null;
}

/** 树里每个结果行的文字，按渲染顺序。 */
function resultTexts(tree) {
  return findNodes(tree, (node) => resultChildren(node) !== null).map((node) => resultChildren(node).text);
}

/** 文字对得上那一行的状态点 —— 成功/失败用同一个形状画。 */
function resultDot(tree, text) {
  const line = findNode(tree, (node) => resultChildren(node)?.text === text);
  return resultChildren(line).dot;
}

const CONFIG = {
  provider: 'mem0',
  autoRecall: true,
  providers: {
    gbrain: { baseUrl: 'http://127.0.0.1:8787/mcp', token: '***', surface: 'verbs', visibility: '' },
    mem0: { baseUrl: 'https://api.mem0.ai', apiKey: '***', userId: 'fairy' },
    customHttp: { url: 'http://127.0.0.1:9300/recall', headersJson: '{}', queryPath: 'results', textPath: 'text' },
    localMarkdown: { directory: '/tmp/fairy-memory' },
  },
};
const STATE = {
  provider: 'mem0',
  fallback: null,
  available: false,
  reason: '未配置 API Key。',
  count: null,
  providers: [
    { id: 'gbrain', available: true, reason: '' },
    { id: 'mem0', available: false, reason: '未配置 API Key。' },
    { id: 'custom-http', available: false, reason: '缺少请求地址。' },
    { id: 'local-markdown', available: true, reason: '' },
  ],
};
const CANDIDATES = {
  candidates: [
    {
      id: 'mneme', name: 'dsh-mneme', kind: 'dsh-plugin', summary: '会做梦的记忆。',
      repo: 'https://github.com/modusensus/dsh-mneme', listing: 'https://dshget.com/plugins/modusensus/dsh-mneme',
      stars: '30', license: 'MIT', language: 'JavaScript', lastPush: '2026-08-20',
      install: 'dsh plugin --profile web add @modusensus/dsh-mneme', requires: 'Node ≥20',
      verify: 'dsh plugin --profile web list', wire: '自带外部 API/CLI。', caveats: '',
    },
    {
      id: 'hindsight', name: 'Hindsight', kind: 'dsh-plugin', summary: '会学习的项目记忆。',
      repo: 'https://github.com/vectorize-io/hindsight', listing: 'https://dshget.com/plugins/vectorize-io/hindsight~h~coding-agents',
      stars: '20.8K', license: 'MIT', language: 'Python', lastPush: '2026-08-21',
      install: 'dsh plugin --profile web add @vectorize-io/hindsight-coding-agents', requires: 'Python 3.10+',
      verify: 'dsh plugin --profile web list', wire: '自带 agent 面。', caveats: '与 fairy-memory 并行时注意双写。',
    },
  ],
  installRequest: '',
};

function sameDeps(previous, next) {
  if (!previous || !next || previous.length !== next.length) return false;
  return next.every((dep, index) => Object.is(dep, previous[index]));
}

/** A minimal reconciling hook harness. Hooks are called in a stable order, so an
 * index-addressed slot list plus a re-render loop reproduces the state updates
 * the card performs once the host answers its two routes. */
async function mount({ config = CONFIG, state = STATE, stateFails = false, candidates = CANDIDATES } = {}) {
  const vm = await import('node:vm');
  let moduleDefinition;
  const slots = new Map();
  const fetches = [];
  let candidateState = structuredClone(candidates);
  const disposers = [];
  const hooks = [];
  let cursor = 0;
  let dirty = false;
  let pendingEffects = [];
  const slotAt = (create) => {
    const at = cursor;
    cursor += 1;
    if (hooks[at] === undefined) hooks[at] = create();
    return hooks[at];
  };
  const React = {
    useState(initial) {
      const slot = slotAt(() => ({ value: typeof initial === 'function' ? initial() : initial }));
      return [slot.value, (next) => {
        const value = typeof next === 'function' ? next(slot.value) : next;
        if (!Object.is(value, slot.value)) {
          slot.value = value;
          dirty = true;
        }
      }];
    },
    useRef(initial) { return slotAt(() => ({ current: initial })); },
    useCallback(callback, deps) {
      const slot = slotAt(() => ({ value: callback, deps }));
      if (!sameDeps(slot.deps, deps)) {
        slot.value = callback;
        slot.deps = deps;
      }
      return slot.value;
    },
    useEffect(callback, deps) {
      const slot = slotAt(() => ({ deps: undefined }));
      if (!sameDeps(slot.deps, deps)) {
        slot.deps = deps;
        pendingEffects.push(callback);
      }
    },
    useLayoutEffect(callback, deps) { React.useEffect(callback, deps); },
    useSyncExternalStore(_subscribe, getSnapshot) { return getSnapshot(); },
  };
  const jsxRuntime = {
    jsx(type, props) { return { type, props: props || {} }; },
    jsxs(type, props) { return { type, props: props || {} }; },
  };
  function ButtonAtom(props) { return { type: 'button-atom', props: props || {} }; }
  function StateDotAtom(props) { return { type: 'state-dot', props: props || {} }; }
  const fetchStub = async (url, init = {}) => {
    fetches.push({ url: String(url), method: init.method, body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined });
    // 每条路由都按真实 HTTP 的样子回一份新解出来的 JSON：复读落下的是新身份，
    // 依赖它的重探才看得见。
    if (String(url) === '/fairy-memory/config') {
      return { ok: true, status: 200, async json() { return structuredClone(config); } };
    }
    if (String(url) === '/fairy-memory/candidates') {
      return { ok: true, status: 200, async json() { return structuredClone(candidateState); } };
    }
    if (String(url) === '/fairy-memory/install') {
      const body = typeof init.body === 'string' ? JSON.parse(init.body) : {};
      candidateState = { ...candidateState, installRequest: typeof body.id === 'string' ? body.id : '' };
      return { ok: true, status: 200, async json() { return { installRequest: candidateState.installRequest }; } };
    }
    if (stateFails) {
      return {
        ok: false,
        status: 503,
        async json() { return { error: { code: 'provider-unavailable', message: '长期记忆提供方不可用。' } }; },
      };
    }
    return { ok: true, status: 200, async json() { return structuredClone(state); } };
  };
  const context = vm.createContext({
    AbortController,
    Map,
    Promise,
    Set,
    URL,
    clearTimeout,
    console,
    fetch: fetchStub,
    setTimeout,
    window: {
      __ModuleLoader__: { load(definition) { moduleDefinition = definition; } },
      setTimeout,
      clearTimeout,
      addEventListener() {},
      removeEventListener() {},
    },
  });
  vm.runInContext(source, context, { filename: 'dsh-fairy-memory/client.js' });
  const plugin = moduleDefinition.factory((id) => {
    if (id === 'react') return React;
    if (id === 'react/jsx-runtime') return jsxRuntime;
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return { Button: ButtonAtom, StateDot: StateDotAtom };
    throw new Error(`unexpected module: ${id}`);
  });

  plugin.apply({
    effect(callback) { disposers.push(callback); },
    slots: {
      inject(name, register) { assert.equal(name, 'settings.section'); register(); },
      register(definition, component) { slots.set(definition.id, { definition, component }); },
    },
  });
  const registered = slots.get('fairy-memory');
  let tree = null;
  /** 渲染 → 冲刷 effect → 等宿主路由落地 → 有状态变化就再走一轮。 */
  const settle = async () => {
    for (let pass = 0; pass < 10; pass += 1) {
      cursor = 0;
      dirty = false;
      pendingEffects = [];
      tree = renderTree(registered.component({}));
      for (const effect of pendingEffects) effect();
      // Let the host routes settle before deciding whether another pass is needed.
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (!dirty) break;
    }
    return tree;
  };
  await settle();
  return {
    registered,
    fetches,
    disposers,
    settle,
    get tree() { return tree; },
  };
}

test('embeds the canonical client diagnostics block', () => {
  assert.equal(embeddedClientDiagnostics(source), canonicalClientDiagnostics);
});

test('registers only the settings section, with a replace-safe registration', () => {
  assert.match(code, /injectMemorySlot\(ctx, \{ id: 'fairy-memory', order: 33, label: \(\) => '长期记忆' \}, MemorySection\)/);
  assert.match(code, /return \{ apply, inject: \['slots'\], name: 'dsh-fairy-memory' \};/);
  // The card talks to exact host routes only: no settings scope, no other slot.
  assert.doesNotMatch(code, /settingsScope/);
  assert.doesNotMatch(code, /conversation\./);
  // A re-invoked slot provider releases its prior registration before publishing.
  assert.match(code, /const releaseRegistration = \(\) => \{\n\s+const dispose = disposeRegistration;\n\s+disposeRegistration = null;\n\s+dispose\?\.\(\);\n\s+\};/);
  assert.match(code, /releaseRegistration\(\);\n\s+const registration = ctx\.slots\.register\(\{ name: 'settings\.section'/);
  assert.match(code, /const STATE_PATH = '\/fairy-memory\/state';/);
  assert.match(code, /const CONFIG_PATH = '\/fairy-memory\/config';/);
  assert.doesNotMatch(code, /\/fairy-memory\/(recall|remember)/);
});

test('maps provider ids to their settings keys and never binds a stored secret', () => {
  assert.match(code, /id: 'gbrain',\n\s+key: 'gbrain',/);
  assert.match(code, /id: 'mem0',\n\s+key: 'mem0',/);
  assert.match(code, /id: 'custom-http',\n\s+key: 'customHttp',/);
  assert.match(code, /id: 'local-markdown',\n\s+key: 'localMarkdown',/);
  assert.match(code, /const stored = config\?\.providers\?\.\[option\.key\] \|\| \{\};/);
  // A secret field renders its effective value only: the stored value arrives as
  // the host sentinel, and the placeholder tells the user what the sentinel means.
  const secretInputs = code.match(/type: field\.secret \? 'password'[\s\S]{0,400}?value: values\[field\.name\]/g) ?? [];
  assert.equal(secretInputs.length, 1);
  assert.match(code, /field\.secret && values\[field\.name\] === SECRET_SENTINEL \? '已保存，输入新值以替换' : field\.placeholder \|\| ''/);
  // Failures reach the host diagnostics, never an empty catch.
  assert.match(code, /catch \(saveError\) \{\n\s+diagnostics\.warn\('config\.save', \{ provider: next\.provider \}, saveError\);/);
  assert.doesNotMatch(code, /catch\s*(\([^)]*\))?\s*\{\s*\}/);
});

test('提问件与读写逻辑全部来自归一化套件', () => {
  // 真源只有一份：src 只 require 它，绝不复制一份文案；bundle 里是构建内联的副本。
  assert.match(card, /const \{ createAskKit \} = require\('\.\.\/\.\.\/\.\.\/\.\.\/fairy-contracts\/client-ask-kit\.cjs'\);/);
  assert.doesNotMatch(card, /const ASK_TEXT = \{/);
  assert.match(code, /const \{ createAskKit \} = \(\(\) => \{/);
  assert.match(code, /const \{ ASK_TEXT, ASK_STYLE[\s\S]{0,160}?useAskForm, describeError \} = createAskKit\(\{/);
  for (const name of ['AskSection', 'AskRow', 'AskText', 'AskSelect', 'AskToggle', 'AskActions', 'AskResult']) {
    assert.match(code, new RegExp(`jsx\\.jsxs?\\(${name}\\b`), `设置卡应当用 ${name}`);
  }
  assert.match(code, /useAskForm\(\{/);
  // 卡里没有自己的提问件、没有自己的样式表、没有自己的加载/保存状态机。
  assert.doesNotMatch(card, /jsx\.jsxs?\('(input|select|textarea)'/);
  assert.doesNotMatch(card, /styles\./);
  assert.doesNotMatch(card, /const \[status, setStatus\]/);
});

test('inlines the canonical ask kit byte for byte', () => {
  assert.equal(embeddedAskKit(source), canonicalAskKit);
});

test('renders providers, key fields, availability reasons, and the stored count', async () => {
  const { registered, tree } = await mount();
  assert.equal(registered.definition.order, 33);
  assert.equal(registered.definition.label(), '长期记忆');
  const rendered = JSON.stringify(tree);

  for (const id of ['gbrain', 'mem0', 'custom-http', 'local-markdown']) {
    assert.match(rendered, new RegExp(`"value":"${id}"`));
  }
  assert.equal(findNode(tree, (node) => node.type === 'select').props.value, 'mem0', 'the dropdown mirrors the stored provider');

  // Only the selected provider's fields are mounted, and the mem0 key arrives as
  // the sentinel so an untouched field keeps the stored value. 归一化后它们是套件
  // 自带的原生件（带 `data-ask`），不是这张卡手搓的 input。
  const fields = findNodes(tree, (node) => node.type === 'input' && node.props?.['data-ask'] === 'text');
  assert.deepEqual(fields.map((field) => field.props.id), [
    'fairy-memory-mem0-baseUrl', 'fairy-memory-mem0-apiKey', 'fairy-memory-mem0-userId',
  ]);
  const secret = findNode(tree, (node) => node.type === 'input' && node.props.type === 'password');
  assert.equal(secret.props.value, '***');
  assert.equal(secret.props.placeholder, '已保存，输入新值以替换');
  assert.equal(fields[0].props.value, 'https://api.mem0.ai');
  assert.equal(findNode(tree, (node) => node.type === 'input' && node.props.type === 'checkbox').props.checked, true);

  // Availability comes from the host route, reasons included; 每行是一条结果行。
  assert.deepEqual(resultTexts(tree).slice(0, 4), [
    'GBrain（本机 MCP 服务，主用）：可用',
    'Mem0（在线托管）：不可用 · 未配置 API Key。',
    '自定义 HTTP 服务：不可用 · 缺少请求地址。',
    '本地 Markdown 目录：可用',
  ]);
  assert.equal(resultDot(tree, 'GBrain（本机 MCP 服务，主用）：可用').props.state, 'done');
  assert.equal(resultDot(tree, 'Mem0（在线托管）：不可用 · 未配置 API Key。').props.state, 'error');
  assert.match(rendered, /当前提供方：Mem0（在线托管） · 不可用 · 未配置 API Key。/);
  assert.equal(findNode(tree, (node) => node.props?.['data-dsh-fairy-memory-count'] === 'true').props.children, '已存记忆：未知');
});

test('reads config then state on mount and re-probes on demand', async () => {
  const { tree, fetches } = await mount();
  const urls = fetches.map((call) => call.url);
  assert.deepEqual([...urls].sort(), ['/fairy-memory/candidates', '/fairy-memory/config', '/fairy-memory/state']);
  assert.ok(urls.indexOf('/fairy-memory/config') < urls.indexOf('/fairy-memory/state'), '状态在配置之后读');
  const refresh = findNode(tree, (node) => node.type === 'button-atom' && node.props.children === '刷新可用性');
  await refresh.props.onClick();
  assert.equal(fetches.filter((call) => call.url === '/fairy-memory/state').length, 2);
});

test('saves the selected provider under its settings key, sentinel included', async () => {
  const session = await mount();
  const userId = findNode(session.tree, (node) => node.props?.id === 'fairy-memory-mem0-userId');
  userId.props.onChange({ target: { value: 'fairy-2' } });
  await session.settle();
  const save = findNode(session.tree, (node) => node.type === 'button-atom' && node.props.children === '保存');
  await save.props.onClick();
  await session.settle();
  const post = session.fetches.find((call) => call.method === 'POST');
  assert.equal(post.url, '/fairy-memory/config');
  // The untouched key still travels as the sentinel: the host reads `***` as
  // "keep what is stored", and the edited field is written with the rest.
  assert.deepEqual(post.body, {
    provider: 'mem0',
    autoRecall: true,
    providers: { mem0: { baseUrl: 'https://api.mem0.ai', apiKey: '***', userId: 'fairy-2' } },
  });
  // The card re-reads the masked config instead of trusting the POST body.
  assert.equal(session.fetches.filter((call) => call.url === '/fairy-memory/config' && call.method !== 'POST').length, 2);
  // 复读之后可用性跟着重探一次 —— 旧卡保存后也是这个时机。
  assert.equal(session.fetches.filter((call) => call.url === '/fairy-memory/state').length, 2);
});

test('没有改动时不写盘，只说一句没有需要保存的改动', async () => {
  const session = await mount();
  const save = findNode(session.tree, (node) => node.type === 'button-atom' && node.props.children === '保存');
  await save.props.onClick();
  await session.settle();
  assert.equal(session.fetches.filter((call) => call.method === 'POST').length, 0, '没有改动就不写盘');
  assert.equal(session.fetches.filter((call) => call.url === '/fairy-memory/config').length, 1, '没有改动也不复读');
  assert.equal(session.fetches.filter((call) => call.url === '/fairy-memory/state').length, 1, '没有写盘就不重探可用性');
  assert.match(JSON.stringify(session.tree), new RegExp(ASK_TEXT.unchanged));
});

test('posts a dashed provider id under its camelCase settings key', async () => {
  const config = { ...CONFIG, provider: 'custom-http', autoRecall: false };
  const state = { ...STATE, provider: 'custom-http', available: true, reason: '' };
  const session = await mount({ config, state });
  assert.equal(findNode(session.tree, (node) => node.type === 'select').props.value, 'custom-http');
  const url = findNode(session.tree, (node) => node.props?.id === 'fairy-memory-custom-http-url');
  url.props.onChange({ target: { value: 'http://127.0.0.1:9400/recall' } });
  await session.settle();
  const save = findNode(session.tree, (node) => node.type === 'button-atom' && node.props.children === '保存');
  await save.props.onClick();
  await session.settle();
  assert.deepEqual(session.fetches.find((call) => call.method === 'POST').body, {
    provider: 'custom-http',
    autoRecall: false,
    providers: { customHttp: { url: 'http://127.0.0.1:9400/recall', headersJson: '{}', queryPath: 'results', textPath: 'text' } },
  });
});

test('lists the vetted candidate catalog and writes/clears the install request', async () => {
  const session = await mount();
  const select = findNode(session.tree, (node) => node.type === 'select' && node.props.id === 'fairy-memory-candidate');
  assert.deepEqual([...select.props.children.map((option) => option.props.value)], ['', 'mneme', 'hindsight']);
  assert.equal(select.props.value, '', '无请求时停在「不选择」');

  // 选中候选 → 详情行给出摘要、安装命令与注意事项。
  select.props.onChange({ target: { value: 'hindsight' } });
  await session.settle();
  const detail = JSON.stringify(session.tree);
  assert.match(detail, /@vectorize-io\/hindsight-coding-agents/);
  assert.match(detail, /注意：与 fairy-memory 并行时注意双写。/);

  // 「让 Agent 安装」→ POST 候选 id，随后清单复读并出现待办行。
  const install = findNode(session.tree, (node) => node.type === 'button-atom' && node.props.children === '让 Agent 安装');
  await install.props.onClick();
  await session.settle();
  assert.deepEqual(session.fetches.find((call) => call.url === '/fairy-memory/install').body, { id: 'hindsight' });
  assert.match(JSON.stringify(session.tree), /已请求安装：Hindsight（等待 Agent 执行）/);
  assert.equal(session.fetches.filter((call) => call.url === '/fairy-memory/candidates').length, 2, '写请求后复读一次清单');

  // 待办时同一按钮变成「取消安装请求」→ POST 空 id 清空。
  const cancel = findNode(session.tree, (node) => node.type === 'button-atom' && node.props.children === '取消安装请求');
  await cancel.props.onClick();
  await session.settle();
  assert.deepEqual(session.fetches.filter((call) => call.url === '/fairy-memory/install').at(-1).body, { id: '' });
  assert.match(JSON.stringify(session.tree), /已清除安装请求。/);
});

test('surfaces the host failure message when the state route fails', async () => {
  const { tree } = await mount({ stateFails: true });
  const rendered = JSON.stringify(tree);
  assert.match(rendered, /长期记忆提供方不可用。/);
  assert.match(rendered, /已存记忆：未知/);
  // 失败也走套件的结果行：错误状态点 + 主机的原因，不塞回自家状态文案。
  assert.equal(resultDot(tree, '长期记忆提供方不可用。').props.state, 'error');
});
