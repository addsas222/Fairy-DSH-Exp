import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
// Source patterns stay line-ending agnostic; nothing here compares bytes.
const code = source.replace(/\r\n/g, '\n');

/** The bundle's own view of a rendered element tree. */
function texts(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return [];
  if (typeof node === 'string' || typeof node === 'number') return [String(node)];
  if (Array.isArray(node)) return node.flatMap(texts);
  return texts(node.props?.children);
}

function flatten(children) {
  if (children === undefined) return [];
  return (Array.isArray(children) ? children : [children]).flat(Infinity);
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

function buttons(node) {
  return findNodes(node, candidate => candidate.type === 'button');
}

function buttonWith(tree, needle) {
  const hit = buttons(tree).find(candidate => texts(candidate).some(text => text.includes(needle)));
  assert.ok(hit, `no button labelled ${needle}`);
  return hit;
}

/** The pack rows of the chip's popover, in menu order. */
const optionRows = tree => findNodes(tree, node => 'data-dsh-fairy-persona-option' in (node.props ?? {}));

const optionFor = (tree, id) => findNode(
  tree,
  node => node.props?.['data-dsh-fairy-persona-option'] === id,
);

/**
 * Minimal hook runtime: enough React for these components (state, refs,
 * effects that run once per dependency identity, and a store read) so a click
 * can be exercised without a DOM renderer.
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
      // Published before the callback runs: a state update inside the effect
      // re-renders, and that render must already see this effect as applied.
      const entry = { deps: deps ?? [], cleanup: undefined };
      hooks[i] = entry;
      entry.cleanup = callback();
    },
    useSyncExternalStore(subscribe, getSnapshot) {
      const i = index++;
      if (!(i in hooks)) hooks[i] = { cleanup: subscribe(() => render()) };
      return getSnapshot();
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

/** Load the bundle once per test into a sandbox with a controllable fetch. */
function loadBundle() {
  const requests = [];
  const events = [];
  const noop = () => {};
  let fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) });
  const sandbox = {
    console,
    document: {
      getElementById: () => null,
      createElement: () => ({ setAttribute: noop, id: '', textContent: '' }),
      head: { appendChild: noop },
      addEventListener: noop,
      removeEventListener: noop,
    },
    CustomEvent: class CustomEvent {
      constructor(type, init) { this.type = type; this.detail = init?.detail; }
    },
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
    if (id === 'react/jsx-runtime') return { jsx: (type, props) => ({ type, props: props ?? {} }), jsxs: (type, props) => ({ type, props: props ?? {} }) };
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return { Tooltip: ({ children }) => children };
    throw new Error(`unexpected require(${id})`);
  });
  return {
    id: entries[0].id,
    exported,
    driver,
    requests,
    events,
    onFetch(impl) { fetchImpl = impl; },
    /** Let the components' async bridge and fetch work settle. */
    async settle() { await new Promise(resolve => setImmediate(resolve)); },
  };
}

/** Install the bundle through the client context and return both registrations. */
function register() {
  const bundle = loadBundle();
  const registrations = [];
  const cleanups = [];
  const ctx = {
    effect: (factory) => { const dispose = factory(); cleanups.push(dispose); return dispose; },
    slots: {
      inject: (name, provider) => {
        const entry = { name };
        registrations.push(entry);
        entry.dispose = provider();
        return entry.dispose;
      },
      register: (definition, component) => {
        Object.assign(registrations.at(-1), { definition, component });
        return () => {};
      },
    },
  };
  bundle.exported.apply(ctx);
  return { ...bundle, registrations, cleanups };
}

const json = value => ({ ok: true, status: 200, json: async () => value });
const settle = bundle => bundle.settle();

test('registers the settings card and the switchable header chip in their authorized slots', () => {
  const bundle = register();

  assert.equal(bundle.id, 'dsh-fairy-persona');
  assert.deepEqual(Array.from(bundle.exported.inject), ['slots']);
  const [section, chip] = bundle.registrations;
  assert.equal(section.name, 'settings.section');
  assert.equal(section.definition.name, 'settings.section');
  assert.equal(section.definition.id, 'fairy-persona');
  assert.equal(section.definition.order, 25);
  assert.equal(section.definition.label(), '人格');
  assert.equal(typeof section.dispose, 'function');
  assert.equal(chip.name, 'conversation.session.header.utilities');
  assert.equal(chip.definition.id, 'fairy-persona-chip');
  assert.equal(chip.definition.order, 30);
  // The plugin-owned style tag and both registrations are released together.
  assert.equal(bundle.cleanups.length, 1);
  assert.equal(typeof bundle.cleanups[0], 'function');
});

test('a render tick that mounts both surfaces reads the catalog once', async () => {
  const bundle = register();
  // The read never settles, so the only thing under test is how many requests
  // one render tick fans out to. Both slots commit in the same tick — the
  // settings card and the header chip share the single in-flight catalog read
  // instead of paying for a scan each.
  bundle.onFetch(() => new Promise(() => {}));

  bundle.driver.render(bundle.registrations[0].component, {});
  bundle.driver.render(bundle.registrations[1].component, {});
  await settle(bundle);

  assert.equal(bundle.requests.filter(request => request.url === '/fairy-persona/list').length, 1);
});

test('the persona card lists the scan roots and creates a pack from the id input', async () => {
  const bundle = register();
  bundle.onFetch(async (url) => {
    if (url === '/fairy-persona/list') return json({ packs: [{ id: 'fairy', name: 'Fairy' }], active: 'fairy' });
    if (url === '/fairy-persona/roots') return json({ roots: ['C:/home/.dsh/personas', 'C:/repo/persona-packs'] });
    if (url === '/fairy-persona/preview') return json({ promptHead: '人格文档开头', tone: { formality: 'formal' } });
    if (url === '/fairy-persona/scaffold') return json({ ok: true, id: 'new-pack', path: 'C:/home/.dsh/personas/new-pack' });
    throw new Error(`unexpected fetch ${url}`);
  });

  bundle.driver.render(bundle.registrations[0].component, {});
  await settle(bundle);

  let tree = bundle.driver.tree();
  // The scan roots are shown as the host reports them, read-only.
  const roots = findNode(tree, node => 'data-dsh-fairy-persona-roots' in (node.props ?? {}));
  assert.equal(roots.props['data-dsh-fairy-persona-roots'], 'C:/home/.dsh/personas | C:/repo/persona-packs');
  // Children arrays cross the vm realm, so copy before comparing structures.
  assert.deepEqual(Array.from(texts(roots).filter(text => text.startsWith('C:/'))), ['C:/home/.dsh/personas', 'C:/repo/persona-packs']);

  // The creation controls exist and start idle.
  const input = findNode(tree, node => 'data-dsh-fairy-persona-scaffold-input' in (node.props ?? {}));
  assert.equal(input.type, 'input');
  assert.equal(input.props.value, '');
  const resultLine = () => findNode(bundle.driver.tree(), node => 'data-dsh-fairy-persona-scaffold-result' in (node.props ?? {}));
  assert.equal(resultLine().props['data-ok'], '');
  assert.equal(buttonWith(tree, '创建').props.disabled, true);

  input.props.onChange({ target: { value: 'new-pack' } });
  tree = bundle.driver.tree();
  assert.equal(buttonWith(tree, '创建').props.disabled, false);

  buttonWith(tree, '创建').props.onClick();
  await settle(bundle);

  const posted = bundle.requests.find(request => request.url === '/fairy-persona/scaffold');
  assert.equal(JSON.stringify(posted), JSON.stringify({
    url: '/fairy-persona/scaffold',
    options: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'new-pack' }),
    },
  }));
  tree = bundle.driver.tree();
  assert.equal(resultLine().props['data-ok'], 'true');
  assert.equal(resultLine().props['data-dsh-fairy-persona-scaffold-result'], '已创建：C:/home/.dsh/personas/new-pack');
  // The input is cleared and the catalog re-read, so the new pack shows up.
  assert.equal(findNode(tree, node => 'data-dsh-fairy-persona-scaffold-input' in (node.props ?? {})).props.value, '');
  assert.equal(bundle.requests.filter(request => request.url === '/fairy-persona/list').length, 2);
});

test('a rejected creation reports the host message instead of silently failing', async () => {
  const bundle = register();
  bundle.onFetch(async (url) => {
    if (url === '/fairy-persona/list') return json({ packs: [], active: '' });
    if (url === '/fairy-persona/roots') return json({ roots: ['C:/home/.dsh/personas'] });
    if (url === '/fairy-persona/scaffold') {
      return { ok: false, status: 422, json: async () => ({ ok: false, error: { code: 'persona-invalid-id', message: '人格包 id 只能包含小写字母、数字和连字符。' } }) };
    }
    throw new Error(`unexpected fetch ${url}`);
  });

  bundle.driver.render(bundle.registrations[0].component, {});
  await settle(bundle);
  const input = findNode(bundle.driver.tree(), node => 'data-dsh-fairy-persona-scaffold-input' in (node.props ?? {}));
  input.props.onChange({ target: { value: 'Bad_ID' } });
  buttonWith(bundle.driver.tree(), '创建').props.onClick();
  await settle(bundle);

  const result = findNode(bundle.driver.tree(), node => 'data-dsh-fairy-persona-scaffold-result' in (node.props ?? {}));
  assert.equal(result.props['data-ok'], 'false');
  assert.equal(result.props['data-dsh-fairy-persona-scaffold-result'], '人格包 id 只能包含小写字母、数字和连字符。');
  // A failure never pretends to have created anything.
  assert.equal(bundle.requests.filter(request => request.url === '/fairy-persona/list').length, 1);
});

test('the header chip opens a pack menu, marks the active pack, and switches through select', async () => {
  const bundle = register();
  bundle.onFetch(async (url) => {
    if (url === '/fairy-persona/list') return json({ packs: [{ id: 'fairy', name: 'Fairy' }, { id: 'greet', name: 'Greeting' }], active: 'fairy' });
    if (url === '/fairy-persona/select') return json({ ok: true, active: 'greet' });
    throw new Error(`unexpected fetch ${url}`);
  });

  bundle.driver.render(bundle.registrations[1].component, {});
  await settle(bundle);

  // Closed: one chip button, no menu rows.
  assert.equal(buttonWith(bundle.driver.tree(), 'Fairy').props['aria-expanded'], 'false');
  assert.deepEqual(optionRows(bundle.driver.tree()), []);

  buttonWith(bundle.driver.tree(), 'Fairy').props.onClick();
  const tree = bundle.driver.tree();
  assert.equal(buttonWith(tree, 'Fairy').props['aria-expanded'], 'true');
  assert.deepEqual(
    optionRows(tree).map(row => row.props['data-dsh-fairy-persona-option']),
    ['', 'fairy', 'greet'],
  );
  assert.equal(optionFor(tree, 'fairy').props['aria-checked'], 'true');
  assert.equal(optionFor(tree, 'greet').props['aria-checked'], 'false');
  assert.deepEqual(texts(optionFor(tree, '')), ['不使用人格包（部署默认）']);

  optionFor(tree, 'greet').props.onClick();
  await settle(bundle);

  assert.equal(JSON.stringify(bundle.requests.find(request => request.url === '/fairy-persona/select')), JSON.stringify({
    url: '/fairy-persona/select',
    options: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'greet' }),
    },
  }));
  // The switch is announced and the chip follows the new active pack.
  assert.equal(bundle.events.at(-1).type, 'fairy-persona-changed');
  assert.equal(bundle.events.at(-1).detail.packId, 'greet');
  assert.equal(bundle.events.at(-1).detail.name, 'Greeting');
  assert.deepEqual(optionRows(bundle.driver.tree()), []);
  assert.equal(buttonWith(bundle.driver.tree(), 'Greeting').props['aria-expanded'], 'false');
});

test('the chip stays hidden while no persona is active', async () => {
  const bundle = register();
  bundle.onFetch(async () => json({ packs: [{ id: 'greet', name: 'Greeting' }], active: '' }));

  assert.equal(bundle.driver.render(bundle.registrations[1].component, {}), null);
  await settle(bundle);

  assert.equal(bundle.driver.tree(), null);
});

test('a switch failure surfaces on the menu and never leaves a silent catch behind', async () => {
  const bundle = register();
  bundle.onFetch(async (url) => {
    if (url === '/fairy-persona/list') return json({ packs: [{ id: 'fairy', name: 'Fairy' }, { id: 'gone', name: 'Gone' }], active: 'fairy' });
    if (url === '/fairy-persona/select') {
      return { ok: false, status: 404, json: async () => ({ ok: false, error: { code: 'persona-not-found', message: '未找到该人格包。' } }) };
    }
    throw new Error(`unexpected fetch ${url}`);
  });

  bundle.driver.render(bundle.registrations[1].component, {});
  await settle(bundle);
  buttonWith(bundle.driver.tree(), 'Fairy').props.onClick();
  optionFor(bundle.driver.tree(), 'gone').props.onClick();
  await settle(bundle);

  const menuError = findNode(bundle.driver.tree(), node => node.props?.className === 'dsh-fairy-persona-menu-error');
  assert.deepEqual(texts(menuError), ['未找到该人格包。']);
  // No failure is swallowed anywhere in the bundle.
  assert.doesNotMatch(code, /\.catch\(\(\)\s*=>\s*\{\s*\}\)/);
  assert.doesNotMatch(code, /catch\s*\([^)]*\)\s*\{\s*\}/);
});
