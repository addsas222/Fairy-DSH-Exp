import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

const DEFAULT_KEY = 'dsh.fairyModes.default.v1';
const APPLIED = (sessionId) => `dsh.fairyModes.applied.${sessionId}`;

/** The bundle's own view of a rendered element tree. */
function texts(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return [];
  if (typeof node === 'string' || typeof node === 'number') return [String(node)];
  if (Array.isArray(node)) return node.flatMap(texts);
  return texts(node.props?.children);
}

function nodes(node, found = []) {
  if (Array.isArray(node)) {
    for (const child of node) nodes(child, found);
    return found;
  }
  if (node === null || typeof node !== 'object') return found;
  if (typeof node.type !== 'undefined') found.push(node);
  for (const child of node.props?.children ?? []) nodes(child, found);
  return found;
}

function nodeWith(tree, predicate, label) {
  const hit = nodes(tree).find(predicate);
  assert.ok(hit, `no node matching ${label}`);
  return hit;
}

/** Minimal hook runtime: state, refs, and once-per-dependency effects. */
function hookDriver() {
  let hooks = [];
  let index = 0;
  let current = null;
  let tree = null;
  const React = {
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
      hooks[at] = { deps: deps ?? [], cleanup: callback() };
    },
  };
  const render = () => {
    index = 0;
    tree = current.component(current.props);
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

test('the settings card explains the modes and persists the new-session default', () => {
  const bundle = loadBundle();
  const slots = register(bundle);
  const render = () => bundle.driver.render(slots.get('fairy-modes').component, {});

  const tree = render();
  const rendered = JSON.stringify(tree);
  for (const term of ['极简', '官方 plan-mode', '/plan', '建造·PTC', 'run_code', '创造·回忆', 'session_recall', 'SKILL.md', 'scaffold-plugin.js']) {
    assert.ok(rendered.includes(term), `the card should explain ${term}`);
  }

  const select = nodeWith(tree, (node) => node.type === 'select', 'the default-mode select');
  assert.equal(select.props['data-dsh-fairy-modes-default'], 'true');
  assert.deepEqual(
    Array.from(select.props.children, option => option.props.value),
    ['', 'ptc', 'roleplay', 'create', 'off'],
    'the dropdown offers 不设置/建造/创造/关闭',
  );
  assert.deepEqual(Array.from(texts(select.props.children[0])), ['不设置（新会话保持 off）']);
  assert.equal(select.props.value, '', 'with no preference stored the dropdown shows 不设置');
  assert.equal(bundle.localStorage.getItem(DEFAULT_KEY), null, '不设置 writes nothing');

  select.props.onChange({ target: { value: 'create' } });
  assert.equal(bundle.localStorage.getItem(DEFAULT_KEY), 'create');
  const mirrored = nodeWith(render(), (node) => node.type === 'select', 'the default-mode select');
  assert.equal(mirrored.props.value, 'create', 'the dropdown mirrors the stored preference');

  const stored = nodeWith(bundle.driver.tree(), (node) => node.type === 'select', 'the default-mode select');
  stored.props.onChange({ target: { value: '' } });
  assert.equal(bundle.localStorage.getItem(DEFAULT_KEY), null, '回到不设置 removes the key');
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
