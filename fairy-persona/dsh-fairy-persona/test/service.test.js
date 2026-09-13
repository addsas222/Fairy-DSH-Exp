import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createFairyPersonaHandlers, createFairyPersonaService } from '../lib/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(here, 'fixtures');
const ROOTS = [join(FIXTURES, 'home', 'personas'), join(FIXTURES, 'repo', 'persona-packs')];
const PREFIX = 'deployment:persona';
const FALLBACK_PREFIX = 'fairy:persona-prefix';
// This harness cohort owns ONE persona section at order 0; getSectionOrder does
// not exist, and the pack document replaces the deployment text by name.
const PERSONA_ORDER = 0;

const packFile = (...segments) => readFile(join(FIXTURES, ...segments), 'utf8');

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

function createService({ active = '', reserved = [], logger = recorder() } = {}) {
  const events = [];
  const registry = createRegistry(reserved);
  const settings = createSettings(active);
  const service = createFairyPersonaService(
    { emit: (name, payload) => events.push({ name, payload }) },
    { roots: ROOTS, logger },
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
    text: await packFile('home', 'personas', 'fairy', 'prompt.md'),
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
    text: await packFile('home', 'personas', 'fairy', 'prompt.md'),
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
  assert.deepEqual(preview.tone, { register: '操作播报', humor: 0.2, address: '主人' });
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
