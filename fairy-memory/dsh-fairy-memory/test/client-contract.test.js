import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const clientPath = new URL('../lib/client.js', import.meta.url);
const source = await readFile(clientPath, 'utf8');
// Source patterns stay line-ending agnostic; the embedded diagnostics block is
// compared to the canonical file after the same normalisation, because this
// repository is developed on both CRLF and LF checkouts.
const code = source.replace(/\r\n/g, '\n');
const canonicalClientDiagnostics = (await readFile(new URL('../../../fairy-contracts/client-diagnostics.cjs', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');

function embeddedClientDiagnostics(value) {
  const beginMarker = '// DSH_FAIRY_CLIENT_DIAGNOSTICS_BEGIN';
  const endMarker = '// DSH_FAIRY_CLIENT_DIAGNOSTICS_END';
  const begin = value.indexOf(beginMarker);
  const end = value.indexOf(endMarker);
  assert.notEqual(begin, -1, 'client bundle must embed the canonical diagnostics block');
  assert.notEqual(end, -1, 'client bundle must close the canonical diagnostics block');
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

function sameDeps(previous, next) {
  if (!previous || !next || previous.length !== next.length) return false;
  return next.every((dep, index) => Object.is(dep, previous[index]));
}

/** A minimal reconciling hook harness. Hooks are called in a stable order, so an
 * index-addressed slot list plus a re-render loop reproduces the state updates
 * the card performs once the host answers its two routes. */
async function mount({ config = CONFIG, state = STATE, stateFails = false } = {}) {
  const vm = await import('node:vm');
  let moduleDefinition;
  const slots = new Map();
  const fetches = [];
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
    if (String(url) === '/fairy-memory/config') {
      return { ok: true, status: 200, async json() { return config; } };
    }
    if (stateFails) {
      return {
        ok: false,
        status: 503,
        async json() { return { error: { code: 'provider-unavailable', message: '长期记忆提供方不可用。' } }; },
      };
    }
    return { ok: true, status: 200, async json() { return state; } };
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
  return { registered, tree, fetches, disposers };
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
  // A secret field renders its draft only: the stored value arrives as the host
  // sentinel, and the placeholder tells the user what the sentinel means.
  const secretInputs = code.match(/type: field\.secret \? 'password'[\s\S]{0,400}?value: drafts\[provider\]\?\.\[field\.name\] \?\? ''/g) ?? [];
  assert.equal(secretInputs.length, 1);
  assert.match(code, /field\.secret && drafts\[provider\]\?\.\[field\.name\] === SECRET_SENTINEL \? '已保存，输入新值以替换' : field\.placeholder \|\| ''/);
  // Failures reach the host diagnostics and the status line, never an empty catch.
  assert.match(code, /catch \(saveError\) \{\n\s+diagnostics\.warn\('config\.save', \{ provider \}, saveError\);/);
  assert.doesNotMatch(code, /catch\s*(\([^)]*\))?\s*\{\s*\}/);
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
  // the sentinel so an untouched field keeps the stored value.
  const fields = findNodes(tree, (node) => typeof node.props?.['data-dsh-fairy-memory-field'] === 'string');
  assert.deepEqual(fields.map((field) => field.props['data-dsh-fairy-memory-field']), ['baseUrl', 'apiKey', 'userId']);
  const secret = findNode(tree, (node) => node.type === 'input' && node.props.type === 'password');
  assert.equal(secret.props.value, '***');
  assert.equal(secret.props.placeholder, '已保存，输入新值以替换');
  assert.equal(findNode(tree, (node) => node.type === 'input' && node.props['data-dsh-fairy-memory-field'] === 'baseUrl').props.value, 'https://api.mem0.ai');
  assert.equal(findNode(tree, (node) => node.type === 'input' && node.props.type === 'checkbox').props.checked, true);

  // Availability comes from the host route, reasons included.
  const rows = findNodes(tree, (node) => typeof node.props?.['data-dsh-fairy-memory-available'] === 'string');
  assert.deepEqual(rows.map((row) => row.props['data-dsh-fairy-memory-available']), ['gbrain', 'mem0', 'custom-http', 'local-markdown']);
  assert.match(rendered, /Mem0（在线托管）：不可用 · 未配置 API Key。/);
  assert.match(rendered, /GBrain（本机 MCP 服务，主用）：可用/);
  assert.match(rendered, /当前提供方：Mem0（在线托管） · 不可用 · 未配置 API Key。/);
  assert.equal(findNode(tree, (node) => node.props?.['data-dsh-fairy-memory-count'] === 'true').props.children, '已存记忆：未知');
});

test('reads config then state on mount and re-probes on demand', async () => {
  const { tree, fetches } = await mount();
  assert.deepEqual(fetches.map((call) => [call.method || 'GET', call.url]), [
    ['GET', '/fairy-memory/config'],
    ['GET', '/fairy-memory/state'],
  ]);
  const refresh = findNode(tree, (node) => node.type === 'button-atom' && node.props.children === '刷新可用性');
  await refresh.props.onClick();
  assert.equal(fetches.filter((call) => call.url === '/fairy-memory/state').length, 2);
});

test('saves the selected provider under its settings key, sentinel included', async () => {
  const { tree, fetches } = await mount();
  const save = findNode(tree, (node) => node.type === 'button-atom' && node.props.children === '保存');
  await save.props.onClick();
  const post = fetches.find((call) => call.method === 'POST');
  assert.equal(post.url, '/fairy-memory/config');
  assert.deepEqual(post.body, {
    provider: 'mem0',
    autoRecall: true,
    providers: { mem0: { baseUrl: 'https://api.mem0.ai', apiKey: '***', userId: 'fairy' } },
  });
  // The card re-reads the masked config instead of trusting the POST body.
  assert.equal(fetches.filter((call) => call.url === '/fairy-memory/config' && call.method !== 'POST').length, 2);
});

test('posts a dashed provider id under its camelCase settings key', async () => {
  const config = { ...CONFIG, provider: 'custom-http', autoRecall: false };
  const state = { ...STATE, provider: 'custom-http', available: true, reason: '' };
  const { tree, fetches } = await mount({ config, state });
  assert.equal(findNode(tree, (node) => node.type === 'select').props.value, 'custom-http');
  const save = findNode(tree, (node) => node.type === 'button-atom' && node.props.children === '保存');
  await save.props.onClick();
  assert.deepEqual(fetches.find((call) => call.method === 'POST').body, {
    provider: 'custom-http',
    autoRecall: false,
    providers: { customHttp: { url: 'http://127.0.0.1:9300/recall', headersJson: '{}', queryPath: 'results', textPath: 'text' } },
  });
});

test('surfaces the host failure message when the state route fails', async () => {
  const { tree } = await mount({ stateFails: true });
  const rendered = JSON.stringify(tree);
  assert.match(rendered, /长期记忆提供方不可用。/);
  assert.match(rendered, /已存记忆：未知/);
  assert.match(rendered, /"data-error":"true"/);
});
