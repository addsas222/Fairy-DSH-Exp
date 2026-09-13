import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
const canonicalDiagnostics = readFileSync(new URL('../../../fairy-contracts/client-diagnostics.cjs', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

/** The bundle's own view of a rendered element tree. */
function texts(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return [];
  if (typeof node === 'string' || typeof node === 'number') return [String(node)];
  if (Array.isArray(node)) return node.flatMap(texts);
  return texts(node.props?.children);
}

function buttons(node, found = []) {
  if (Array.isArray(node)) {
    for (const child of node) buttons(child, found);
    return found;
  }
  if (node === null || typeof node !== 'object') return found;
  if (node.type === 'button') found.push(node);
  for (const child of node.props?.children ?? []) buttons(child, found);
  return found;
}

function buttonWith(tree, needle) {
  const hit = buttons(tree).find(candidate => texts(candidate).some(text => text.includes(needle)));
  assert.ok(hit, `no button labelled ${needle}`);
  return hit;
}

/**
 * Minimal hook runtime: enough React for this component (state, refs, effects
 * that run once per dependency identity) so a click can be exercised without a
 * DOM renderer.
 */
function hookDriver() {
  let hooks = [];
  let index = 0;
  let current = null;
  let tree = null;
  const React = {
    useState(initial) {
      const i = index++;
      if (!(i in hooks)) hooks[i] = typeof initial === 'function' ? initial() : initial;
      return [hooks[i], (value) => {
        hooks[i] = typeof value === 'function' ? value(hooks[i]) : value;
        render();
      }];
    },
    useRef(initial) {
      const i = index++;
      if (!(i in hooks)) hooks[i] = { current: initial };
      return hooks[i];
    },
    useEffect(callback, deps) {
      const i = index++;
      const previous = hooks[i];
      if (previous !== undefined && previous.deps.every((value, at) => value === deps?.[at])) return;
      previous?.cleanup?.();
      hooks[i] = { deps: deps ?? [], cleanup: callback() };
    },
  };
  const render = () => {
    index = 0;
    tree = current.component(current.props);
    return tree;
  };
  return {
    React,
    render(component, props) {
      current = { component, props };
      hooks = [];
      return render();
    },
    tree: () => tree,
  };
}

/** Load the bundle once per test into a sandbox with controllable fetch. */
function loadBundle() {
  const requests = [];
  const events = [];
  let fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) });
  const noop = () => {};
  const sandbox = {
    console,
    document: { addEventListener: noop, removeEventListener: noop },
    CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
    fetch: (...args) => {
      requests.push(args.length > 1 ? { url: args[0], options: args[1] } : { url: args[0] });
      return fetchImpl(...args);
    },
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
  const exported = entries[0].factory((id) => {
    if (id === 'react') return driver.React;
    if (id === 'react/jsx-runtime') return { jsx: (type, props) => ({ type, props: props ?? {} }) };
    throw new Error(`unexpected require(${id})`);
  });
  return {
    id: entries[0].id,
    exported,
    driver,
    requests,
    events,
    onFetch(impl) { fetchImpl = impl; },
    /** Let the component's async bridge/fetch work settle. */
    async settle() { await new Promise(resolve => setImmediate(resolve)); },
  };
}

/** Install the chip through the client context and return its registration. */
function register() {
  const bundle = loadBundle();
  const captured = {};
  const ctx = {
    effect: (factory) => factory(),
    slots: {
      inject: (name, provider) => {
        const dispose = provider();
        captured.name = name;
        captured.dispose = dispose;
        return dispose;
      },
      register: (definition, component) => {
        captured.definition = definition;
        captured.component = component;
        return () => {};
      },
    },
  };
  bundle.exported.apply(ctx);
  assert.deepEqual(Array.from(bundle.exported.inject), ['slots']);
  return { ...bundle, ...captured };
}

test('embeds the canonical client diagnostics byte for byte', () => {
  const begin = '// DSH_FAIRY_CLIENT_DIAGNOSTICS_BEGIN\n';
  const end = '// DSH_FAIRY_CLIENT_DIAGNOSTICS_END';
  const start = source.indexOf(begin);
  const finish = source.indexOf(end, start + begin.length);
  assert.ok(start >= 0 && finish > start, 'embedded diagnostics boundaries should exist');
  /* The canonical file is a tracked CRLF artifact on a Windows checkout while
   * this bundle is generated LF-first, so the copy is compared with line
   * endings normalized; every byte of content still has to match. */
  const normalize = (value) => value.replace(/\r\n/g, '\n');
  assert.equal(normalize(source.slice(start + begin.length, finish)), normalize(canonicalDiagnostics));
});

test('is a web dual-face package whose chip occupies the authorized header slot', () => {
  assert.equal(manifest.name, 'dsh-fairy-modes');
  assert.equal(manifest.exports['./client'], './lib/client.js');
  assert.equal(manifest.dsh.client.platform, 'web');
  const registration = register();
  assert.equal(registration.name, 'conversation.session.header.utilities');
  assert.equal(registration.definition.name, 'conversation.session.header.utilities');
  assert.equal(registration.definition.id, 'fairy-modes-chip');
  assert.equal(registration.definition.order, 20);
  assert.equal(typeof registration.dispose, 'function');
});

test('the chip label follows the fairyMode projection, then plan mode', () => {
  const { driver, component } = register();
  const render = (values) => driver.render(
    component,
    { sessionId: 's1', useProjection: (key) => values[key], inputActions: undefined },
  );
  render({});
  assert.equal(driver.tree().props.children[0].props.children, 'off');
  render({ fairyMode: { mode: 'ptc' } });
  assert.equal(driver.tree().props.children[0].props.children, 'PTC');
  render({ fairyMode: { mode: 'create' } });
  assert.equal(driver.tree().props.children[0].props.children, '创造');
  // Plan mode wins the label while it is in force, including a pending entry.
  render({ fairyMode: { mode: 'ptc' }, plan: { active: true, pending: false } });
  assert.equal(driver.tree().props.children[0].props.children, '极简');
  render({ fairyMode: { mode: 'ptc' }, plan: { active: false, pending: true } });
  assert.equal(driver.tree().props.children[0].props.children, '极简');
  // The menu marks plan mode and the fairy mode independently: they are
  // orthogonal axes, not one enum.
  buttonWith(driver.tree(), '极简').props.onClick();
  assert.equal(buttonWith(driver.tree(), '探查·极简').props['aria-checked'], 'true');
  assert.equal(buttonWith(driver.tree(), '建造·PTC').props['aria-checked'], 'true');
  assert.equal(buttonWith(driver.tree(), '创造·回忆').props['aria-checked'], 'false');
});

test('selecting a fairy mode posts to the bridge and announces the change', async () => {
  const bundle = register();
  bundle.onFetch(async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }));
  bundle.driver.render(bundle.component, {
    sessionId: 's7',
    useProjection: () => ({ mode: 'off' }),
    inputActions: undefined,
  });
  buttonWith(bundle.driver.tree(), 'off').props.onClick();
  const posted = buttonWith(bundle.driver.tree(), '创造·回忆');
  posted.props.onClick();
  await bundle.settle();
  // The payload crosses the bundle's realm, so compare its serialized form.
  assert.equal(JSON.stringify(bundle.requests.find(request => request.url === '/fairy-modes/set')), JSON.stringify({
    url: '/fairy-modes/set',
    options: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 's7', mode: 'create' }),
    },
  }));
  assert.equal(bundle.events.at(-1).type, 'fairy-modes-changed');
  assert.equal(bundle.events.at(-1).detail.sessionId, 's7');
  assert.equal(bundle.events.at(-1).detail.mode, 'create');
  // The menu closes on selection.
  assert.equal(buttons(bundle.driver.tree()).length, 1);
});

test('the 极简 row drives the official /plan command through the composer', async () => {
  const drafts = [];
  const bundle = register();
  const render = (plan) => bundle.driver.render(bundle.component, {
    sessionId: 's1',
    useProjection: (key) => (key === 'plan' ? plan : { mode: 'off' }),
    inputActions: { setDraft: (text) => drafts.push(text), submit: () => drafts.push('submit') },
  });
  render({ active: false, pending: false });
  buttonWith(bundle.driver.tree(), 'off').props.onClick();
  buttonWith(bundle.driver.tree(), '探查·极简').props.onClick();
  assert.deepEqual(drafts, ['/plan', 'submit']);
  assert.equal(bundle.requests.filter(request => request.url === '/fairy-modes/set').length, 0);

  drafts.length = 0;
  render({ active: true, pending: false });
  buttonWith(bundle.driver.tree(), '极简').props.onClick();
  buttonWith(bundle.driver.tree(), '探查·极简').props.onClick();
  assert.deepEqual(drafts, ['/plan off', 'submit']);
});

test('without projection frames the chip reads the bridge state', async () => {
  const bundle = register();
  bundle.onFetch(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, mode: 'create', plan: { active: false, pending: false } }) }));
  bundle.driver.render(bundle.component, { sessionId: 's9', inputActions: undefined });
  assert.equal(bundle.requests[0].url, '/fairy-modes/state?sessionId=s9');
  await bundle.settle();
  assert.equal(bundle.driver.tree().props.children[0].props.children, '创造');
});
