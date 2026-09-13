/**
 * Persona packs: directory-scanned persona documents plus an atomic voice binding.
 *
 * A pack is a directory under `$DSH_HOME/personas/` or `<repo>/persona-packs/`
 * holding `persona.yml`, the prompt document it names, optional tone JSON, and
 * an optional TTS binding. Selecting a pack swaps the deployment persona prompt
 * sections, persists the choice in the `fairy-persona` settings namespace, and
 * announces `fairy-persona/change` so the voice plugin can apply the binding
 * without either plugin importing the other.
 *
 * @module dsh-fairy-persona
 */

import { access, readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import z from '@deepseek-ai/schemastery';
import { createFairyDiagnostics } from 'dsh-fairy-contracts/diagnostics';

/** The settings namespace this plugin owns. */
export const FAIRY_PERSONA_SETTINGS_NAMESPACE = 'fairy-persona';

/**
 * The section name the prompt registry owns for the deployment persona in this
 * harness cohort: ONE section, order 0. A same-name registration in a child
 * layer replaces it, which is what makes a pack the persona.
 * ponytail: single-section cohort; the split prefix/suffix pair arrives with
 * the newer systemPrompt section vocabulary.
 */
const PERSONA_PREFIX_SECTION = 'deployment:persona';
/** Persona slot order in this cohort (the first section a model reads). */
const PERSONA_ORDER = 0;

/** Plugin-owned names used when the registry's own names are not insertable. */
const FALLBACK_PREFIX_SECTION = 'fairy:persona-prefix';

/** Pack ids are directory-safe by construction. */
const PACK_ID = /^[a-z0-9-]+$/;

/** How much of a pack's prompt the preview endpoint returns. */
const PROMPT_HEAD_LENGTH = 500;

const diagnostics = createFairyDiagnostics('dsh-fairy-persona');

/** Resolved `fairy-persona` settings: the active pack id, `''` for no persona. */
export const FairyPersonaSettings = z.object({
  version: z.number().step(1).default(1),
  active: z.string().default(''),
});

/**
 * Parse the flat persona.yml subset: top-level `key: value` pairs, plus one
 * level of indented `key: value` under a bare `key:` (the `voice` block).
 * Surrounding quotes are stripped; a line whose first non-space character is
 * `#` is a comment. Values stay strings.
 * ponytail: flat subset only — no lists, anchors, multi-line scalars, or
 * inline comments; a real YAML reader is the upgrade path if a pack needs one.
 * @param text - the persona.yml contents.
 * @returns the parsed document.
 * @throws {Error} when a line is not a `key: value` pair or is indented under
 * no open block.
 */
export function parsePersonaYaml(text) {
  const document = {};
  let block = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const pair = /^(\s*)([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!pair) throw new Error(`unsupported persona.yml line: ${JSON.stringify(line.trim().slice(0, 60))}`);
    const [, indent, key, rawValue] = pair;
    const value = unquote(rawValue.trim());
    if (indent) {
      if (!block) throw new Error(`indented "${key}" under no block`);
      block[key] = value;
      continue;
    }
    if (value === '') {
      block = {};
      document[key] = block;
    } else {
      block = null;
      document[key] = value;
    }
  }
  return document;
}

function unquote(value) {
  if (value.length > 1 && (value.startsWith('"') || value.startsWith("'")) && value.endsWith(value[0])) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * The two roots packs are discovered under, nearest source first: the user's
 * `$DSH_HOME/personas/` overrides the repository's built-in packs by id.
 * @returns absolute root directories, in precedence order.
 */
export function defaultScanRoots() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  const repoRoot = process.env.DSH_FAIRY_REPO_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  return [join(home, 'personas'), join(repoRoot, 'persona-packs')];
}

/**
 * Scan roots for valid packs. A pack whose persona.yml is unreadable,
 * unparseable, missing an id/prompt, or naming a file outside its own
 * directory is skipped with a warning — one broken pack never hides the rest,
 * and a missing root is simply empty.
 * @param roots - root directories to scan, in precedence order.
 * @param logger - diagnostics sink for skipped packs.
 * @returns a Map of pack id to pack record, first definition winning.
 */
export async function scanPersonaPacks(roots = defaultScanRoots(), logger = diagnostics) {
  const packs = new Map();
  for (const root of roots) {
    const directory = resolve(root);
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code !== 'ENOENT') logger.warn('packs.root', { root: directory }, error);
      continue;
    }
    // Deterministic order keeps first-wins stable for case-insensitive filesystems.
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const pack = await readPersonaPack(join(directory, entry.name), logger);
      if (pack && !packs.has(pack.id)) packs.set(pack.id, pack);
    }
  }
  return packs;
}

/** Read one pack directory; `null` means "skipped", never fatal. */
async function readPersonaPack(directory, logger) {
  const file = join(directory, 'persona.yml');
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    // A directory without persona.yml is not a pack, not an error.
    if (error?.code !== 'ENOENT') logger.warn('pack.read', { file }, error);
    return null;
  }
  let document;
  try {
    document = parsePersonaYaml(text);
  } catch (error) {
    logger.warn('pack.parse', { file }, error);
    return null;
  }
  const id = typeof document.id === 'string' ? document.id.trim() : '';
  if (!PACK_ID.test(id)) {
    logger.warn('pack.id', { file, id });
    return null;
  }
  const promptPath = await containedFile(directory, document.prompt, logger, 'pack.prompt', file);
  if (!promptPath) return null;
  const name = typeof document.name === 'string' && document.name.trim() ? document.name.trim() : id;
  const description = typeof document.description === 'string' && document.description.trim() ? document.description.trim() : undefined;
  const tonePath = document.tone === undefined || document.tone === ''
    ? undefined
    : await containedFile(directory, document.tone, logger, 'pack.tone', file);
  return {
    id,
    name,
    ...(description ? { description } : {}),
    directory,
    promptPath,
    ...(tonePath ? { tonePath } : {}),
    voice: normalizeVoice(document.voice),
  };
}

/**
 * Resolve a pack-relative file that exists and stays inside its own pack
 * directory — a pack may name its own files, not the rest of the machine.
 * @returns the absolute path, or `undefined` after warning.
 */
async function containedFile(directory, name, logger, operation, file) {
  const relative = typeof name === 'string' ? name.trim() : '';
  const base = resolve(directory);
  const path = resolve(base, relative);
  if (!relative || !(path === base || path.startsWith(base + sep))) {
    logger.warn(operation, { file, ref: relative });
    return undefined;
  }
  try {
    await access(path);
  } catch (error) {
    logger.warn(operation, { file, ref: relative }, error);
    return undefined;
  }
  return path;
}

/** `{provider, config}` for a pack's voice block; `null` when it declares none. */
function normalizeVoice(block) {
  if (!block || typeof block !== 'object') return null;
  const provider = typeof block.provider === 'string' ? block.provider.trim() : '';
  if (!provider) return null;
  const { provider: _provider, ...config } = block;
  return { provider, config };
}

/** Read a pack's prompt document and tone attributes. */
async function loadPackDocument(pack, logger) {
  const prompt = await readFile(pack.promptPath, 'utf8');
  let tone = null;
  if (pack.tonePath) {
    try {
      tone = JSON.parse(await readFile(pack.tonePath, 'utf8'));
    } catch (error) {
      // Tone is decoration: a broken one degrades the preview, never the pack.
      logger.warn('pack.tone.parse', { file: pack.tonePath }, error);
    }
  }
  return { prompt, tone };
}

function sendJson(res, status, value) {
  if (res.destroyed || res.writableEnded) return false;
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(value));
  return true;
}

async function readJson(req, maxBytes = 64_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new Error('payload-too-large');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('invalid-json');
  }
}

function publicError(code) {
  const messages = {
    'invalid-json': '请求体不是合法 JSON。',
    'persona-invalid-id': '人格包 id 只能包含小写字母、数字和连字符。',
    'persona-not-found': '未找到该人格包。',
    'persona-not-ready': '人格服务尚未就绪，请稍后重试。',
  };
  return { code, message: messages[code] || '人格操作失败。' };
}

function statusFor(code) {
  if (code === 'invalid-json') return 400;
  if (code === 'persona-invalid-id') return 422;
  if (code === 'persona-not-found') return 404;
  if (code === 'persona-not-ready') return 503;
  return 500;
}

function personaError(code, cause) {
  return Object.assign(new Error(code), { code, cause });
}

/**
 * Mount one persona section under the registry's own deployment name, so a
 * scoped mount shadows the deployment's contribution. A host-plane mount
 * cannot: the registry already owns that name in the global layer and a
 * duplicate insert throws. There the section falls back to a plugin-owned name
 * at the same order — the same rendered position.
 * ponytail: host-plane global persona scope. Replacing a deployment-configured
 * persona outright, and per-session personas, need an agent-scope mount where
 * the canonical name is legal; the swap below is the whole upgrade, only its
 * mounting context changes.
 * @param systemPrompt - the prompt registry.
 * @param promptText - the pack's persona document.
 * @param logger - diagnostics sink for the shadow fallback.
 * @returns the disposer releasing every section it mounted.
 */
function registerPersonaSections(systemPrompt, promptText, logger) {
  const required = [
    { name: PERSONA_PREFIX_SECTION, fallback: FALLBACK_PREFIX_SECTION, order: PERSONA_ORDER, text: promptText },
  ];
  const disposers = [];
  try {
    for (const section of required) {
      try {
        disposers.push(systemPrompt.section({ name: section.name, order: section.order, text: section.text }));
      } catch (error) {
        // An empty section has nothing worth mounting under a second name.
        if (!section.fallback) continue;
        logger.warn('persona.section.shadow', { section: section.name }, error);
        disposers.push(systemPrompt.section({ name: section.fallback, order: section.order, text: section.text }));
      }
    }
  } catch (error) {
    for (const dispose of disposers) dispose();
    throw error;
  }
  let mounted = true;
  return () => {
    if (!mounted) return;
    mounted = false;
    for (const dispose of disposers) dispose();
  };
}

/**
 * Build the `fairyPersona` service. Its host dependencies arrive through
 * {@link bind} once the settings and prompt registries are available.
 * @param ctx - the plugin context the service emits on.
 * @param options - scan roots and diagnostics sink.
 * @returns the persona service.
 */
export function createFairyPersonaService(ctx, { roots = defaultScanRoots(), logger = diagnostics } = {}) {
  let settings = null;
  let systemPrompt = null;
  let disposeSections = null;

  function requireReady() {
    if (!settings || !systemPrompt) throw personaError('persona-not-ready');
  }

  function mount(promptText) {
    // Release the previous pack first: a throw must not leave two personas mounted.
    disposeSections?.();
    disposeSections = null;
    if (promptText === null) return;
    disposeSections = registerPersonaSections(systemPrompt, promptText, logger);
  }

  async function findPack(id) {
    const packs = await scanPersonaPacks(roots, logger);
    const pack = packs.get(id);
    if (!pack) throw personaError('persona-not-found');
    return pack;
  }

  async function activate(pack) {
    const document = await loadPackDocument(pack, logger);
    mount(document.prompt);
    return document;
  }

  function announce(packId, voice) {
    ctx.emit('fairy-persona/change', { packId, voice: voice ?? null });
  }

  return {
    /**
     * Adopt the host services this service writes through. Called once the
     * settings namespace is registered and the prompt registry is available.
     */
    bind({ settings: scope, systemPrompt: registry }) {
      settings = scope;
      systemPrompt = registry;
    },

    /** Every discovered pack, in scan order, as public descriptors. */
    async list() {
      const packs = await scanPersonaPacks(roots, logger);
      return [...packs.values()].map(pack => ({
        id: pack.id,
        name: pack.name,
        ...(pack.description ? { description: pack.description } : {}),
      }));
    },

    /** The active pack id, `''` when no persona is selected. */
    active() {
      return settings ? settings.get().active : '';
    },

    /**
     * Select a pack deployment-wide: swap the persona sections, persist the
     * choice, then announce the voice binding. An empty id clears the persona.
     * @param id - pack id, or `''` to clear.
     * @returns `{ok: true, active}`.
     */
    async select(id) {
      requireReady();
      const packId = typeof id === 'string' ? id.trim() : '';
      if (packId === '') {
        mount(null);
        await settings.update({ active: '' });
        announce('', null);
        return { ok: true, active: '' };
      }
      if (!PACK_ID.test(packId)) throw personaError('persona-invalid-id');
      const pack = await findPack(packId);
      await activate(pack);
      await settings.update({ active: packId });
      announce(packId, pack.voice);
      return { ok: true, active: packId };
    },

    /**
     * Preview a pack's prompt head and tone attributes.
     * @param id - pack id.
     * @returns `{promptHead, tone}`; tone is `null` when absent or unreadable.
     */
    async preview(id) {
      const packId = typeof id === 'string' ? id.trim() : '';
      if (!PACK_ID.test(packId)) throw personaError('persona-invalid-id');
      const document = await loadPackDocument(await findPack(packId), logger);
      return { promptHead: document.prompt.slice(0, PROMPT_HEAD_LENGTH), tone: document.tone };
    },

    /**
     * Re-apply the persisted pack, so a restart keeps the persona. A pack that
     * disappeared from disk only warns: the deployment falls back to no persona.
     * @returns `{restored, packId?}`.
     */
    async restore() {
      requireReady();
      const packId = settings.get().active;
      if (!packId || !PACK_ID.test(packId)) return { restored: false };
      const pack = (await scanPersonaPacks(roots, logger)).get(packId);
      if (!pack) {
        logger.warn('persona.restore.missing', { packId });
        return { restored: false };
      }
      await activate(pack);
      announce(packId, pack.voice);
      return { restored: true, packId };
    },
  };
}

/** HTTP handlers for the `/fairy-persona/*` routes. */
export function createFairyPersonaHandlers(service) {
  const fail = (res, error) => {
    const code = error?.code || (error?.message === 'invalid-json' ? 'invalid-json' : undefined);
    if (!code) diagnostics.warn('persona.http', {}, error);
    sendJson(res, statusFor(code), { ok: false, error: publicError(code) });
  };
  return {
    list: async (req, res) => {
      try {
        sendJson(res, 200, { packs: await service.list(), active: service.active() });
      } catch (error) {
        fail(res, error);
      }
    },
    select: async (req, res) => {
      try {
        const body = await readJson(req);
        sendJson(res, 200, await service.select(body?.id));
      } catch (error) {
        fail(res, error);
      }
    },
    preview: async (req, res) => {
      try {
        const body = await readJson(req);
        sendJson(res, 200, await service.preview(body?.id));
      } catch (error) {
        fail(res, error);
      }
    },
  };
}

const ROUTES = ['list', 'select', 'preview'];

export function apply(ctx) {
  return diagnostics.guard('apply', () => {
    const service = createFairyPersonaService(ctx);
    const handlers = createFairyPersonaHandlers(service);
    ctx.provide('fairyPersona', service);
    ctx.inject(['webServer'], (ws) => ws.effect(() => {
      const unregister = ROUTES.map(route => ws.webServer.register({
        kind: 'exact',
        path: `/fairy-persona/${route}`,
        handler: handlers[route],
      }));
      return () => { for (const release of unregister) release?.(); };
    }));
    ctx.inject(['settings', 'systemPrompt'], (host) => {
      service.bind({
        settings: host.settings.register(FAIRY_PERSONA_SETTINGS_NAMESPACE, FairyPersonaSettings),
        systemPrompt: host.systemPrompt,
      });
      // The persona is restored in the background: a missing pack must not
      // block the plugin graph.
      void service.restore().catch((error) => diagnostics.warn('persona.restore', {}, error));
    });
  }, { surface: 'host' });
}
