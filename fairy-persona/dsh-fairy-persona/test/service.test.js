import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { composePersonaText, createFairyPersonaHandlers, createFairyPersonaService, parsePersonaYaml } from '../lib/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(here, 'fixtures');
const ROOTS = [join(FIXTURES, 'home', 'personas'), join(FIXTURES, 'repo', 'persona-packs')];
const PREFIX = 'deployment:persona';
const FALLBACK_PREFIX = 'fairy:persona-prefix';
// This harness cohort owns ONE persona section at order 0; getSectionOrder does
// not exist, and the pack document replaces the deployment text by name.
const PERSONA_ORDER = 0;

const packFile = (...segments) => readFile(join(FIXTURES, ...segments), 'utf8');
/** The text one pack actually mounts: its document plus the generated tone block. */
async function composed(personaId) {
  const prompt = await packFile('home', 'personas', personaId, 'prompt.md');
  const tone = JSON.parse(await packFile('home', 'personas', personaId, 'tone.json'));
  return composePersonaText(prompt, tone);
}

/** The fixture roots hold deliberately broken packs; only persona operations matter here. */
const personaWarnings = logger => logger.warnings
  .filter(warning => warning.operation.startsWith('persona.'))
  .map(warning => warning.operation);

function recorder() {
  const warnings = [];
  return { warnings, warn: (operation, context, error) => warnings.push({ operation, context, error }) };
}

/** The prompt registry, with `reserved` names already owned by the deployment. */
function createRegistry(reserved = []) {
  const sections = new Map(reserved.map(name => [name, { order: -1, text: '部署人格' }]));
  const released = [];
  return {
    sections,
    released,
    section({ name, order, text }) {
      if (sections.has(name)) throw new Error(`duplicate prompt section "${name}"`);
      sections.set(name, { order, text });
      return () => { sections.delete(name); released.push(name); };
    },
  };
}

function createSettings(active = '') {
  const writes = [];
  let value = { version: 1, active };
  return {
    writes,
    get: () => value,
    update: async (patch) => { writes.push(patch); value = { ...value, ...patch }; },
  };
}

function createService({ active = '', reserved = [], logger = recorder(), roots = ROOTS } = {}) {
  const events = [];
  const registry = createRegistry(reserved);
  const settings = createSettings(active);
  const service = createFairyPersonaService(
    { emit: (name, payload) => events.push({ name, payload }) },
    { roots, logger },
  );
  service.bind({ settings, systemPrompt: registry });
  return { events, registry, service, settings, logger };
}

function createResponse() {
  return {
    destroyed: false,
    writableEnded: false,
    statusCode: 0,
    body: undefined,
    setHeader() {},
    end(text) { this.writableEnded = true; this.body = JSON.parse(text); },
  };
}

const createRequest = body => Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);

test('select mounts the pack document as the deployment persona and announces its voice binding', async () => {
  const { events, registry, service, settings } = createService();

  assert.deepEqual(await service.select('fairy'), { ok: true, active: 'fairy' });

  assert.deepEqual(registry.sections.get(PREFIX), {
    order: PERSONA_ORDER,
    text: await composed('fairy'),
  });
  assert.deepEqual(settings.writes, [{ active: 'fairy' }]);
  assert.equal(service.active(), 'fairy');
  assert.deepEqual(events, [{
    name: 'fairy-persona/change',
    payload: {
      packId: 'fairy',
      voice: { provider: 'openai', config: { baseURL: 'http://127.0.0.1:9880', model: 'fairy-v4', voice: 'fairy' } },
    },
  }]);
});

test('switching packs releases the previous sections before mounting the new document', async () => {
  const { events, registry, service } = createService();
  await service.select('fairy');

  await service.select('no-voice');

  assert.deepEqual(registry.released, [PREFIX]);
  assert.equal(registry.sections.size, 1);
  assert.equal(registry.sections.get(PREFIX).text, await packFile('home', 'personas', 'no-voice', 'prompt.md'));
  // A pack that declares no voice block binds nothing.
  assert.deepEqual(events.at(-1).payload, { packId: 'no-voice', voice: null });
});

test('an empty id clears the persona and the voice binding', async () => {
  const { events, registry, service, settings } = createService();
  await service.select('fairy');

  assert.deepEqual(await service.select(''), { ok: true, active: '' });

  assert.equal(registry.sections.size, 0);
  assert.deepEqual(settings.writes.at(-1), { active: '' });
  assert.deepEqual(events.at(-1).payload, { packId: '', voice: null });
});

test('select rejects an unknown pack without disturbing the mounted persona', async () => {
  const { events, registry, service, settings } = createService();
  await service.select('fairy');

  await assert.rejects(service.select('nope'), error => error.code === 'persona-not-found');

  assert.deepEqual([...registry.sections.keys()], [PREFIX]);
  assert.deepEqual(settings.writes, [{ active: 'fairy' }]);
  assert.equal(events.length, 1);
});

test('select rejects an id outside the pack-id alphabet', async () => {
  const { service, settings } = createService();
  await assert.rejects(service.select('Fairy'), error => error.code === 'persona-invalid-id');
  assert.deepEqual(settings.writes, []);
});

test('a host-plane mount falls back to a plugin-owned section name it cannot shadow', async () => {
  const { logger, registry, service } = createService({ reserved: [PREFIX] });

  await service.select('fairy');

  assert.deepEqual([...registry.sections.keys()], [PREFIX, FALLBACK_PREFIX]);
  assert.deepEqual(registry.sections.get(FALLBACK_PREFIX), {
    order: PERSONA_ORDER,
    text: await composed('fairy'),
  });
  assert.deepEqual(personaWarnings(logger), ['persona.section.shadow']);
});

test('select before the host services arrive reports not-ready', async () => {
  const service = createFairyPersonaService({ emit() {} }, { roots: ROOTS, logger: recorder() });
  await assert.rejects(service.select('fairy'), error => error.code === 'persona-not-ready');
});

test('preview serves the prompt head and the tone attributes', async () => {
  const { service } = createService();
  const prompt = await packFile('home', 'personas', 'fairy', 'prompt.md');

  const preview = await service.preview('fairy');

  assert.equal(preview.promptHead.length, 500);
  assert.equal(preview.promptHead, prompt.slice(0, 500));
  assert.deepEqual(preview.tone, {
    schema_version: '1.0',
    registers: { operational: 0.7, narrative: 0.3 },
    formality: 'formal',
    humor: { density: 'low', style: 'dry', max_per_turn: 1 },
    address: { signal: '主人', policy: 'selective', never_in: ['技术成品', '工具参数'] },
    speech_habits: { openers: ['分析：', '提示：'], banned: ['作为一个 AI'] },
  });
});

test('preview reports a pack without tone attributes as tone-less', async () => {
  const { service } = createService();
  const prompt = await packFile('home', 'personas', 'no-voice', 'prompt.md');
  assert.deepEqual(await service.preview('no-voice'), { promptHead: prompt, tone: null });
  await assert.rejects(service.preview('missing'), error => error.code === 'persona-not-found');
});

test('list serves pack descriptors in scan order', async () => {
  const { service } = createService();
  assert.deepEqual(await service.list(), [
    { id: 'fairy', name: 'Fairy', description: 'Ⅲ型总序式集成泛用人工智能' },
    { id: 'no-voice', name: 'Silent' },
    { id: 'greet', name: 'Greeting', description: '只负责打招呼' },
  ]);
});

test('restore re-applies the persisted pack and announces its binding', async () => {
  const { events, registry, service } = createService({ active: 'greet' });

  assert.deepEqual(await service.restore(), { restored: true, packId: 'greet' });

  assert.equal(registry.sections.get(PREFIX).text, await packFile('repo', 'persona-packs', 'greet', 'prompt.md'));
  assert.deepEqual(events.at(-1).payload, { packId: 'greet', voice: null });
});

test('restore of a pack that vanished from disk warns and leaves the deployment persona', async () => {
  const { events, logger, registry, service } = createService({ active: 'gone' });

  assert.deepEqual(await service.restore(), { restored: false });

  assert.equal(registry.sections.size, 0);
  assert.equal(events.length, 0);
  assert.deepEqual(personaWarnings(logger), ['persona.restore.missing']);
});

test('restore with no persisted persona applies nothing', async () => {
  const { events, registry, service } = createService();
  assert.deepEqual(await service.restore(), { restored: false });
  assert.equal(registry.sections.size, 0);
  assert.deepEqual(events, []);
});

test('the list route serves every pack with the active id', async () => {
  const { service } = createService({ active: 'greet' });
  const res = createResponse();

  await createFairyPersonaHandlers(service).list(createRequest(), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.active, 'greet');
  assert.deepEqual(res.body.packs.map(pack => pack.id), ['fairy', 'no-voice', 'greet']);
});

test('the select route answers 404, 422, and 400 for unusable requests', async () => {
  const handlers = createFairyPersonaHandlers(createService().service);

  const missing = createResponse();
  await handlers.select(createRequest({ id: 'nope' }), missing);
  assert.equal(missing.statusCode, 404);
  assert.deepEqual(missing.body, { ok: false, error: { code: 'persona-not-found', message: '未找到该人格包。' } });

  const malformed = createResponse();
  await handlers.select(createRequest({ id: 'Fairy' }), malformed);
  assert.equal(malformed.statusCode, 422);

  const unparseable = createResponse();
  await handlers.select(Readable.from([Buffer.from('not json')]), unparseable);
  assert.equal(unparseable.statusCode, 400);
  assert.equal(unparseable.body.error.code, 'invalid-json');
});

test('the select route switches the persona for a valid request', async () => {
  const { registry, service } = createService();
  const res = createResponse();

  await createFairyPersonaHandlers(service).select(createRequest({ id: 'greet' }), res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true, active: 'greet' });
  assert.equal(registry.sections.get(PREFIX).text, await packFile('repo', 'persona-packs', 'greet', 'prompt.md'));
});

test('the preview route serves the prompt head over HTTP', async () => {
  const handlers = createFairyPersonaHandlers(createService().service);
  const res = createResponse();

  await handlers.preview(createRequest({ id: 'greet' }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.promptHead, await packFile('repo', 'persona-packs', 'greet', 'prompt.md'));
});

test('the mounted persona text carries the tone attributes as constraints', async () => {
  const { registry, service } = createService();

  await service.select('fairy');

  const text = registry.sections.get(PREFIX).text;
  const prompt = await packFile('home', 'personas', 'fairy', 'prompt.md');
  assert.ok(text.startsWith(prompt.replace(/\s*$/, '')), 'the pack document leads the composed text');
  assert.match(text, /【调色属性（由 tone.json 生成，运行时约束）】/);
  assert.match(text, /- 语域配比：/);
  assert.match(text, /- 幽默：/);
  assert.match(text, /- 称呼/);
  assert.match(text, /- 禁用表达：/);
});

test('a pack without tone mounts its document unchanged', async () => {
  const { registry, service } = createService();

  await service.select('no-voice');

  const text = registry.sections.get(PREFIX).text;
  assert.doesNotMatch(text, /调色属性/);
});

test('composePersonaText degrades on absent, empty, or malformed tone', () => {
  assert.equal(composePersonaText('body', null), 'body');
  assert.equal(composePersonaText('body', {}), 'body');
  assert.equal(composePersonaText('body', []), 'body');
  assert.equal(composePersonaText('body', 'nope'), 'body');
  const composed = composePersonaText('body\n', { formality: 'formal' });
  assert.equal(composed, 'body\n\n【调色属性（由 tone.json 生成，运行时约束）】\n- 正式度：formal\n');
  const percent = composePersonaText('b', { registers: { operational: 0.7, narrative: 0.25 } });
  assert.match(percent, /- 语域配比：operational 70% \/ narrative 25%/);
  const muted = composePersonaText('b', { humor: { density: 'none', max_per_turn: 0 }, address: { policy: 'none' } });
  assert.match(muted, /- 幽默：不使用/);
  assert.match(muted, /- 称呼：不使用/);
  assert.doesNotMatch(muted, /none密度/);
});

/** A throwaway user root, so scaffold tests never write into the fixtures. */
const tempUserRoot = () => mkdtemp(join(tmpdir(), 'fairy-persona-user-'));

test('the roots route serves the scan roots, nearest first', async () => {
  const { service } = createService();
  const res = createResponse();

  await createFairyPersonaHandlers(service).roots(createRequest(), res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { roots: ROOTS.map(root => resolve(root)) });
  assert.deepEqual(service.roots(), ROOTS.map(root => resolve(root)));
});

test('scaffold writes a selectable pack under the user root that list serves at once', async () => {
  const sandbox = await tempUserRoot();
  try {
    const userRoot = join(sandbox, 'personas');
    const { registry, service } = createService({ roots: [userRoot, join(FIXTURES, 'repo', 'persona-packs')] });

    const created = await service.scaffold({ id: 'my-helper', name: '小助手' });

    assert.deepEqual(created, { ok: true, id: 'my-helper', path: join(userRoot, 'my-helper') });
    // No voice block: a new pack speaks with the deployment default until bound.
    assert.deepEqual(parsePersonaYaml(await readFile(join(created.path, 'persona.yml'), 'utf8')), {
      id: 'my-helper',
      name: '小助手',
      prompt: 'prompt.md',
      tone: 'tone.json',
    });
    const tone = JSON.parse(await readFile(join(created.path, 'tone.json'), 'utf8'));
    assert.deepEqual(Object.keys(tone), ['schema_version', 'registers', 'formality', 'humor', 'address', 'speech_habits']);
    assert.match(await readFile(join(created.path, 'prompt.md'), 'utf8'), /人格文档/);

    // The next scan already serves it, and the skeleton deploys as-is.
    assert.ok((await service.list()).some(pack => pack.id === 'my-helper' && pack.name === '小助手'));
    await service.select('my-helper');
    assert.match(registry.sections.get(PREFIX).text, /【调色属性（由 tone.json 生成，运行时约束）】/);
    assert.deepEqual(Object.keys((await service.preview('my-helper')).tone), Object.keys(tone));
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test('scaffold defaults the name to the id and folds a hostile name into one parseable document', async () => {
  const sandbox = await tempUserRoot();
  try {
    const userRoot = join(sandbox, 'personas');
    const { service } = createService({ roots: [userRoot, join(FIXTURES, 'repo', 'persona-packs')] });

    await service.scaffold({ id: 'plain' });
    assert.deepEqual(parsePersonaYaml(await readFile(join(userRoot, 'plain', 'persona.yml'), 'utf8')), {
      id: 'plain',
      name: 'plain',
      prompt: 'prompt.md',
      tone: 'tone.json',
    });

    // A name carrying a newline or a colon must not become a second YAML line.
    await service.scaffold({ id: 'quoted', name: 'A\nb: c' });
    assert.deepEqual(parsePersonaYaml(await readFile(join(userRoot, 'quoted', 'persona.yml'), 'utf8')), {
      id: 'quoted',
      name: 'A b: c',
      prompt: 'prompt.md',
      tone: 'tone.json',
    });
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test('scaffold refuses an existing pack and an id outside the pack-id alphabet', async () => {
  const sandbox = await tempUserRoot();
  try {
    const userRoot = join(sandbox, 'personas');
    const { service } = createService({ roots: [userRoot, join(FIXTURES, 'repo', 'persona-packs')] });
    await service.scaffold({ id: 'my-helper', name: '小助手' });
    const before = await readFile(join(userRoot, 'my-helper', 'prompt.md'), 'utf8');

    await assert.rejects(service.scaffold({ id: 'my-helper' }), error => error.code === 'persona-exists');
    assert.equal(await readFile(join(userRoot, 'my-helper', 'prompt.md'), 'utf8'), before);

    // Traversal, separators, case, spaces, and a missing id never reach the disk.
    for (const id of ['Fairy', 'my helper', '../escape', 'a/b', '', undefined, 7]) {
      await assert.rejects(service.scaffold({ id }), error => error.code === 'persona-invalid-id', `id ${String(id)}`);
    }
    assert.deepEqual(await readdir(userRoot), ['my-helper']);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test('the scaffold route answers 200, 409, 422, and 400 for its outcomes', async () => {
  const sandbox = await tempUserRoot();
  try {
    const userRoot = join(sandbox, 'personas');
    const service = createService({ roots: [userRoot, join(FIXTURES, 'repo', 'persona-packs')] }).service;
    const handlers = createFairyPersonaHandlers(service);

    const created = createResponse();
    await handlers.scaffold(createRequest({ id: 'http-pack' }), created);
    assert.equal(created.statusCode, 200);
    assert.deepEqual(created.body, { ok: true, id: 'http-pack', path: join(userRoot, 'http-pack') });

    const again = createResponse();
    await handlers.scaffold(createRequest({ id: 'http-pack' }), again);
    assert.equal(again.statusCode, 409);
    assert.deepEqual(again.body, { ok: false, error: { code: 'persona-exists', message: '该人格包已存在，未覆盖。' } });

    const malformed = createResponse();
    await handlers.scaffold(createRequest({ id: 'Bad_ID' }), malformed);
    assert.equal(malformed.statusCode, 422);

    const unparseable = createResponse();
    await handlers.scaffold(Readable.from([Buffer.from('not json')]), unparseable);
    assert.equal(unparseable.statusCode, 400);
    assert.equal(unparseable.body.error.code, 'invalid-json');
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});
