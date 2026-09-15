import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';

// The ask-kit text constants are the single source of truth for card wording;
// the render assertions below compare against them instead of the literals.
const { ASK_TEXT } = createRequire(import.meta.url)('../../../fairy-contracts/client-ask-kit.cjs');
const clientPath = new URL('../lib/client.js', import.meta.url);
const source = await readFile(clientPath, 'utf8');
// Source patterns stay line-ending agnostic; only the embedded diagnostics block
// is compared byte for byte against the canonical file.
const code = source.replace(/\r\n/g, '\n');
const canonicalClientDiagnostics = await readFile(new URL('../../../fairy-contracts/client-diagnostics.cjs', import.meta.url), 'utf8');

function embeddedClientDiagnostics(value) {
  const beginMarker = '// DSH_FAIRY_CLIENT_DIAGNOSTICS_BEGIN';
  const endMarker = '// DSH_FAIRY_CLIENT_DIAGNOSTICS_END';
  const begin = value.indexOf(beginMarker);
  const end = value.indexOf(endMarker);
  assert.notEqual(begin, -1, 'client bundle must embed the canonical diagnostics block');
  assert.notEqual(end, -1, 'client bundle must close the canonical diagnostics block');
  return value.slice(value.indexOf('\n', begin) + 1, end);
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

test('embeds the canonical client diagnostics byte for byte', () => {
  assert.equal(embeddedClientDiagnostics(source), canonicalClientDiagnostics);
});

test('registers only the settings section, with a replace-safe registration', () => {
  assert.match(code, /injectSearchSlot\(ctx, \{ id: 'fairy-search', order: 28, label: \(\) => '搜索引擎' \}/);
  assert.match(code, /return \{ apply, inject: \['slots', 'settingsScope'\], name: 'dsh-fairy-search' \};/);
  // No header chip: the search result card is owned by the official web tool.
  assert.doesNotMatch(code, /conversation\.session\.header\.utilities/);
  assert.doesNotMatch(code, /conversation\.input\./);
  // A re-invoked slot provider releases its prior registration before publishing.
  assert.match(code, /const releaseRegistration = \(\) => \{\n\s+const dispose = disposeRegistration;\n\s+disposeRegistration = null;\n\s+dispose\?\.\(\);\n\s+\};/);
  assert.match(code, /releaseRegistration\(\);\n\s+const registration = ctx\.slots\.register\(\{ name: 'settings\.section'/);
  // The settings scope is bound on this plugin's own namespace before the slot mounts.
  assert.match(code, /const scope = ctx\.settingsScope\.bind\(\{ namespace: SETTINGS_NAMESPACE \}\);/);
});

test('writes keys as path-addressed secrets and never binds a stored key into the form', () => {
  // Keys are `role('secret')`: the client can only write them, never render them.
  for (const engine of ['deepseek', 'exa', 'perplexity', 'custom']) {
    assert.match(code, new RegExp(`\\{ op: 'set', path: \\['${engine}', 'apiKey'\\]`));
  }
  assert.match(code, /\{ op: 'set', path: \['custom', 'baseURL'\]/);
  assert.match(code, /await scope\.mutate\(ops\);/);
  // An untouched (empty) draft writes nothing, so saving never clears a stored secret.
  assert.match(code, /if \(drafts\.deepseekKey\.trim\(\)\) ops\.push/);
  // 「没有需要保存的改动。」由套件出：没有 op 就报 `changed: false`，文案只在 ASK_TEXT 里。
  assert.match(code, /if \(ops\.length === 0\) return \{ changed: false \};/);
  // Password rows are ask-kit AskText controlled by the draft only — never by the snapshot.
  const passwordRows = code.match(/type: 'password'[\s\S]{0,600}?value: form\.draft\.\w+/g) ?? [];
  assert.equal(passwordRows.length, 4);
  assert.doesNotMatch(code, /value: settings\.\w+\?\.apiKey/);
  // Availability comes from the host route; a configured engine reports 'done'.
  assert.match(code, /const state = configured \? 'done' : selected \? 'warning' : 'idle';/);
});

test('the settings card asks through the ask kit rather than hand-rolled controls', () => {
  // 标记区保证 ASK_TEXT/ASK_STYLE 绑定在工厂作用域（解构名单由同步器决定，不锁死）；
  // 组件用套件实例取，名字不重复声明，块形态再变也不会撞名。
  assert.match(code, /^const \{[^}]*\bASK_TEXT\b[^}]*\bASK_STYLE\b[^}]*\} = fairyAskKit;$/m);
  assert.match(code, /const askKit = fairyAskKit\.createAskKit\(\{\n\s+React,\n\s+jsx: jsx\.jsx,\n\s+jsxs: jsx\.jsxs,\n\s+primitives: \{ Input, Button, StateDot \},\n\s+\}\);/);
  // 加载/保存/测试都走 useAskForm：state 端点读、测试包在 run('test', …) 里。
  assert.match(code, /const form = askKit\.useAskForm\(\{\n\s+initial: EMPTY_DRAFTS,/);
  assert.match(code, /fetch\(STATE_PATH, \{ headers: \{ accept: 'application\/json' \} \}\)/);
  assert.match(code, /const runTest = \(\) => form\.run\('test', async \(\) => \{/);
  // 五个文本提问 + 一个下拉 + 一行动作 + 一行结果，全部来自套件。
  assert.equal((code.match(/jsx\.jsx\(askKit\.AskText, \{/g) ?? []).length, 5);
  assert.equal((code.match(/jsx\.jsx\(askKit\.AskRow, \{/g) ?? []).length, 6);
  assert.equal((code.match(/jsx\.jsx\(askKit\.AskSelect, \{/g) ?? []).length, 1);
  assert.equal((code.match(/jsx\.jsx\(askKit\.AskActions, \{/g) ?? []).length, 1);
  assert.equal((code.match(/jsx\.jsx\(askKit\.AskResult, \{/g) ?? []).length, 1);
  assert.equal((code.match(/jsx\.jsxs\(askKit\.AskSection, \{/g) ?? []).length, 1);
  // 卡里没有手搓的提问件：原生 input/select/textarea 只出现在标记区（套件自带）。
  assert.doesNotMatch(code, /jsx\.jsx\('(input|select|textarea)'/);
  // 状态文案只从 ASK_TEXT 取，只读会话用同一句。
  assert.match(code, /const status = writable \? switchError \|\| form\.status : ASK_TEXT\.readOnly;/);
  // 宿主生效引擎是**信息行**（ASK_STYLE.copy），不是状态文案、不进 ASK_TEXT。
  assert.match(code, /jsx\.jsx\('p', \{ style: ASK_STYLE\.copy, children: `当前生效：\$\{providerLabel\(form\.stored\.provider \|\| provider\)\}。` \}\)/);
  assert.match(code, /primary: ASK_TEXT\.save,/);
  assert.match(code, /secondary: ASK_TEXT\.test,/);
  assert.match(code, /setSwitchError\(ASK_TEXT\.saveFailed\(describeError\(error\)\)\);/);
  // 与提问行重复的观感件已删，styles 只剩本卡自己的两处。
  assert.match(code, /const styles = \{\n\s+engine: \{[\s\S]{0,240}?\n\s+pre: \{/);
  assert.doesNotMatch(code, /styles\.(root|copy|panel|row|label|input|actions|status)\b/);
});

test('the settings card renders engines, secret inputs, probe actions, and the MCP note', async () => {
  const vm = await import('node:vm');
  let moduleDefinition;
  const effects = [];
  const slots = new Map();
  const fetches = [];
  // A minimal hook harness: render once, then inspect the tree (state updates are
  // not reconciled, matching the repo's existing client-bundle tests).
  const React = {
    useState(initial) { return [typeof initial === 'function' ? initial() : initial, () => {}]; },
    useRef(initial) { return { current: initial }; },
    useCallback(callback) { return callback; },
    useEffect(callback) { effects.push(callback); },
    useLayoutEffect(callback) { effects.push(callback); },
    useSyncExternalStore(_subscribe, getSnapshot) { return getSnapshot(); },
  };
  const jsxRuntime = {
    jsx(type, props) { return { type, props: props || {} }; },
    jsxs(type, props) { return { type, props: props || {} }; },
  };
  // Primitives render to marker hosts so the walker can find them.
  function ButtonAtom(props) { return { type: 'button-atom', props: props || {} }; }
  function StateDotAtom(props) { return { type: 'state-dot', props: props || {} }; }
  const fetchStub = async (url, init = {}) => {
    fetches.push({ url: String(url), method: init.method, body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined });
    if (String(url) === '/fairy-search/state') {
      return { ok: true, status: 200, async json() { return { provider: 'deepseek-official', configured: { deepseek: true, exa: false, perplexity: false, custom: false } }; } };
    }
    return { ok: true, status: 200, async json() { return { ok: true, latencyMs: 42, sources: [{ title: 'A', url: 'https://a.example' }] }; } };
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
  vm.runInContext(source, context, { filename: 'dsh-fairy-search/client.js' });
  const plugin = moduleDefinition.factory((id) => {
    if (id === 'react') return React;
    if (id === 'react/jsx-runtime') return jsxRuntime;
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return { Button: ButtonAtom, StateDot: StateDotAtom };
    throw new Error(`unexpected module: ${id}`);
  });

  const writes = [];
  // 官方 settingsScope 是类实例：方法读 `this`，把方法解引用传出去会崩。
  // 假 scope 保持同一形状（而不是箭头函数），否则这类绑定回归测不出来。
  class FakeSettingsScope {
    constructor() {
      this.status = 'ready';
      this.writable = true;
      // A stored secret must never reach the rendered form, which is why this
      // snapshot deliberately carries one.
      this.value = { version: 1, provider: 'exa', deepseek: {}, exa: { apiKey: 'sk-stored-secret' }, perplexity: {}, custom: { baseURL: 'https://gw.example/v1' } };
    }
    getSnapshot() { return { status: this.status, writable: this.writable, value: this.value }; }
    subscribe() { return () => {}; }
    async set(field, value) { writes.push({ op: 'set', path: [field], value }); }
    async mutate(ops) { writes.push(...ops); }
  }
  const scope = new FakeSettingsScope();
  plugin.apply({
    effect() {},
    settingsScope: { bind: (spec) => { assert.equal(spec.namespace, 'fairy-search'); return scope; } },
    slots: {
      inject(name, register) { assert.equal(name, 'settings.section'); register(); },
      register(definition, component) { slots.set(definition.id, { definition, component }); },
    },
  });

  const registered = slots.get('fairy-search');
  assert.equal(registered.definition.order, 28);
  assert.equal(registered.definition.label(), '搜索引擎');
  const element = registered.component();
  const tree = renderTree(element.type(element.props));
  const rendered = JSON.stringify(tree);

  for (const provider of ['deepseek-official', 'exa', 'perplexity', 'custom']) {
    assert.match(rendered, new RegExp(`"value":"${provider}"`));
  }
  assert.equal(findNode(tree, (node) => node.type === 'select').props.value, 'exa', 'the dropdown mirrors the stored engine');
  // 提问件都出自套件：原生回退路径自带 `data-ask` 自证标记，手搓件没有。
  const textInputs = findNodes(tree, (node) => node.type === 'input');
  assert.equal(textInputs.length, 5, '五条文本提问');
  assert.equal(textInputs.every((input) => input.props['data-ask'] === 'text'), true, '文本提问都出自 AskText');
  assert.equal(findNode(tree, (node) => node.type === 'select').props['data-ask'], 'select', '下拉出自 AskSelect');
  const passwordInputs = findNodes(tree, (node) => node.type === 'input' && node.props.type === 'password');
  assert.equal(passwordInputs.length, 4);
  assert.equal(passwordInputs.every((input) => input.props.value === ''), true, 'secret inputs start empty');
  assert.equal(rendered.includes('sk-stored-secret'), false, 'a stored key must never be rendered');
  assert.equal(rendered.includes('https://gw.example/v1'), true, 'the custom base URL is not a secret');
  // The selected engine is unconfigured here, so its dot warns; the others idle.
  assert.deepEqual(
    findNodes(tree, (node) => node.type === 'state-dot').map((node) => node.props.state),
    ['idle', 'warning', 'idle', 'idle'],
  );
  assert.equal(findNodes(tree, (node) => node.type === 'button-atom').length, 2);
  assert.match(rendered, /tavily-mcp/);
  assert.match(rendered, /@deepseek-ai\/dsh-mcp-client/);
  assert.match(rendered, /profiles\/web\/cordis\.patch\.yml/);

  // The mounted effect reads engine availability from the host.
  for (const effect of effects) effect();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(fetches[0].url, '/fairy-search/state');

  // The probe asks the host for exactly the selected engine; the labels are the
  // kit's own ASK_TEXT words, not card-local copies.
  const probeButton = findNode(tree, (node) => node.type === 'button-atom' && node.props.children === ASK_TEXT.test);
  await probeButton.props.onClick();
  const probeCall = fetches.find((call) => call.url === '/fairy-search/test');
  assert.equal(probeCall.method, 'POST');
  assert.deepEqual(probeCall.body, { provider: 'exa' });

  // Saving with untouched fields issues no write at all.
  const saveButton = findNode(tree, (node) => node.type === 'button-atom' && node.props.children === ASK_TEXT.save);
  await saveButton.props.onClick();
  assert.deepEqual(writes, []);

  // 只读会话：按钮停用，状态用套件那句 ASK_TEXT.readOnly。
  const readOnlyScope = new FakeSettingsScope();
  readOnlyScope.writable = false;
  plugin.apply({
    effect() {},
    settingsScope: { bind: () => readOnlyScope },
    slots: {
      inject(name, register) { register(); },
      register(definition, component) { slots.set(definition.id, { definition, component }); },
    },
  });
  const readOnlyElement = slots.get('fairy-search').component();
  const readOnlyTree = renderTree(readOnlyElement.type(readOnlyElement.props));
  assert.equal(JSON.stringify(readOnlyTree).includes(ASK_TEXT.readOnly), true, '只读会话给出套件那句说明');
  const readOnlyButtons = findNodes(readOnlyTree, (node) => node.type === 'button-atom');
  assert.equal(readOnlyButtons.length, 2);
  assert.equal(readOnlyButtons.every((node) => node.props.disabled === true), true, '只读会话停用保存与测试');
  const readOnlyInputs = findNodes(readOnlyTree, (node) => node.type === 'input');
  assert.equal(readOnlyInputs.every((input) => input.props.disabled === true), true, '只读会话停用输入');
});
