import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

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
  assert.match(code, /if \(fieldCount === 0\) \{\n\s+setSaveStatus\('没有需要保存的改动。'\);/);
  // Password inputs are controlled by drafts only — never by the settings snapshot.
  const passwordInputs = code.match(/type: 'password'[\s\S]{0,400}?value: drafts\.\w+/g) ?? [];
  assert.equal(passwordInputs.length, 4);
  assert.doesNotMatch(code, /value: settings\.\w+\?\.apiKey/);
  // Availability comes from the host route; a configured engine reports 'done'.
  assert.match(code, /const state = configured \? 'done' : selected \? 'warning' : 'idle';/);
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
  const scope = {
    getSnapshot: () => ({
      status: 'ready',
      writable: true,
      // A stored secret must never reach the rendered form, which is why this
      // snapshot deliberately carries one.
      value: { version: 1, provider: 'exa', deepseek: {}, exa: { apiKey: 'sk-stored-secret' }, perplexity: {}, custom: { baseURL: 'https://gw.example/v1' } },
    }),
    subscribe: () => () => {},
    set: async (field, value) => { writes.push({ op: 'set', path: [field], value }); },
    mutate: async (ops) => { writes.push(...ops); },
  };
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

  // The probe asks the host for exactly the selected engine.
  const probeButton = findNode(tree, (node) => node.type === 'button-atom' && node.props.children === '测试');
  await probeButton.props.onClick();
  const probeCall = fetches.find((call) => call.url === '/fairy-search/test');
  assert.equal(probeCall.method, 'POST');
  assert.deepEqual(probeCall.body, { provider: 'exa' });

  // Saving with untouched fields issues no write at all.
  const saveButton = findNode(tree, (node) => node.type === 'button-atom' && node.props.children === '保存');
  await saveButton.props.onClick();
  assert.deepEqual(writes, []);
});
