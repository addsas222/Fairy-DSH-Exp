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

import { access, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
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

/**
 * How long one catalog scan is reused. Long enough to absorb the catalog
 * reads of a single settings-card render, short enough that a pack copied
 * into a scan root by hand — the documented way to add one, no plugin call
 * involved — still shows up the next time the panel is opened. The directory
 * stays the source of truth; the memo only absorbs re-reads.
 */
const PACK_SCAN_TTL_MS = 1000;

/**
 * The tone schema skeleton a scaffolded pack opens with: every key the
 * renderer reads, holding neutral values, so a fresh pack is already valid.
 */
const SCAFFOLD_TONE = {
  schema_version: '1.0',
  registers: { operational: 0.5, narrative: 0.5 },
  formality: 'neutral',
  humor: { density: 'none', style: '', max_per_turn: 0 },
  address: { signal: '', policy: 'none', never_in: [] },
  speech_habits: { openers: [], banned: [] },
};

/** The neutral opening document a scaffolded pack starts from. */
const SCAFFOLD_PROMPT = `# 人格文档

在这里描述这个人格包的身份、职责与说话方式。这段文本作为系统提示词的人格段挂载。

## 工作方式

- 先确认目标，再给出步骤；不确定的事实先说明不确定。
- 只把真实执行过的动作说成已完成，不写客套话。
- 回答直接、简洁，一次说清一件事。
`;

/**
 * A persona.yml scalar the flat reader round-trips: quotes are stripped by the
 * reader, so they are folded out of the value, and a raw newline would become
 * a second document line and is folded away too.
 */
function yamlScalar(value) {
  return `"${String(value).replace(/["\r\n]+/g, ' ').trim()}"`;
}

/**
 * The three files a scaffolded pack starts from. There is no `voice` block: a
 * new pack speaks with the deployment default until its author binds one.
 * @param id - the validated pack id.
 * @param rawName - the requested display name; the id when absent or blank.
 * @returns file name to contents, in write order.
 */
function scaffoldFiles(id, rawName) {
  const name = String(rawName ?? '').replace(/[\r\n]+/g, ' ').trim() || id;
  return new Map([
    ['persona.yml', [
      `# ${name} 人格包`,
      `id: ${id}`,
      `name: ${yamlScalar(name)}`,
      'prompt: prompt.md',
      'tone: tone.json',
      '',
    ].join('\n')],
    ['prompt.md', SCAFFOLD_PROMPT],
    ['tone.json', `${JSON.stringify(SCAFFOLD_TONE, null, 2)}\n`],
  ]);
}

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

/**
 * Render one tone attribute group as constraint lines, or [] when the pack
 * declares nothing for it. Values are whatever the pack author wrote; only
 * shapes that render as readable text are emitted.
 */
function toneLines(tone) {
  const lines = [];
  const registers = tone.registers;
  if (registers !== null && typeof registers === 'object') {
    const parts = Object.entries(registers)
      .filter(([, value]) => typeof value === 'number' && Number.isFinite(value))
      .map(([name, value]) => `${name} ${Math.round(value * 100)}%`);
    if (parts.length) lines.push(`- 语域配比：${parts.join(' / ')}`);
  }
  if (typeof tone.formality === 'string' && tone.formality) lines.push(`- 正式度：${tone.formality}`);
  const humor = tone.humor;
  if (humor !== null && typeof humor === 'object') {
    const density = typeof humor.density === 'string' ? humor.density : '';
    const maxPerTurn = Number.isInteger(humor.max_per_turn) ? humor.max_per_turn : undefined;
    if (density === 'none' || maxPerTurn === 0) {
      lines.push('- 幽默：不使用');
    } else {
      const parts = [];
      if (density) parts.push(`${density}密度`);
      if (humor.style) parts.push(humor.style);
      if (maxPerTurn !== undefined) parts.push(`单轮最多 ${maxPerTurn} 处`);
      if (parts.length) lines.push(`- 幽默：${parts.join(' · ')}`);
    }
  }
  const address = tone.address;
  if (address !== null && typeof address === 'object') {
    if (address.signal && address.policy) lines.push(`- 称呼「${address.signal}」：${address.policy}`);
    else if (address.policy === 'none') lines.push('- 称呼：不使用');
    else if (address.policy) lines.push(`- 称呼策略：${address.policy}`);
    if (Array.isArray(address.never_in) && address.never_in.length) {
      lines.push(`- 称呼禁用场景：${address.never_in.join('、')}`);
    }
  }
  const habits = tone.speech_habits;
  if (habits !== null && typeof habits === 'object') {
    if (Array.isArray(habits.openers) && habits.openers.length) lines.push(`- 可用开场：${habits.openers.join('、')}`);
    if (Array.isArray(habits.banned) && habits.banned.length) lines.push(`- 禁用表达：${habits.banned.join('、')}`);
  }
  return lines;
}

/**
 * Compose the text one persona pack mounts: the pack document, followed by
 * the tone attributes rendered as executable constraints. The tone block is
 * what makes `tone.json` a live part of the persona rather than decoration.
 *
 * @param prompt - the pack's prompt document.
 * @param tone - parsed tone.json, or null when the pack declares none.
 * @returns the prompt, with a tone block appended when attributes exist.
 */
export function composePersonaText(prompt, tone) {
  if (tone === null || typeof tone !== 'object' || Array.isArray(tone)) return prompt;
  const lines = toneLines(tone);
  if (lines.length === 0) return prompt;
  return `${prompt.replace(/\s*$/, '')}\n\n【调色属性（由 tone.json 生成，运行时约束）】\n${lines.join('\n')}\n`;
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
    // Both refusals carry a code like every other persona error, so the
    // handler maps them through `statusFor` instead of falling through to 500.
    if (size > maxBytes) throw personaError('payload-too-large');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw personaError('invalid-json');
  }
}

function publicError(code) {
  const messages = {
    'invalid-json': '请求体不是合法 JSON。',
    'payload-too-large': '请求体超过大小上限。',
    'persona-invalid-id': '人格包 id 只能包含小写字母、数字和连字符。',
    'persona-not-found': '未找到该人格包。',
    'persona-exists': '该人格包已存在，未覆盖。',
    'persona-not-ready': '人格服务尚未就绪，请稍后重试。',
  };
  return { code, message: messages[code] || '人格操作失败。' };
}

function statusFor(code) {
  if (code === 'invalid-json') return 400;
  if (code === 'payload-too-large') return 413;
  if (code === 'persona-invalid-id') return 422;
  if (code === 'persona-not-found') return 404;
  if (code === 'persona-exists') return 409;
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
 * @param options - scan roots, diagnostics sink, and the two catalog-memo
 * seams (the scan itself and its window), which tests replace so the memo can
 * be observed without timing.
 * @returns the persona service.
 */
export function createFairyPersonaService(ctx, { roots = defaultScanRoots(), logger = diagnostics, scan = scanPersonaPacks, scanTtlMs = PACK_SCAN_TTL_MS } = {}) {
  let settings = null;
  let systemPrompt = null;
  let disposeSections = null;

  /**
   * The memo the catalog reads are served from. A scan costs one readdir per
   * root plus one read per pack, and the settings card reads the catalog more
   * than once per render, so a re-read that lands inside the same window is
   * served from the last result instead of repeating the scan. One entry is
   * the whole bound: it is replaced, never appended to, and the entry's
   * promise is what readers share while a scan is in flight.
   */
  let packsScan = null;

  /**
   * Drop the memo. Every write path calls this before it returns, so a read
   * that follows a write can never replay the catalog the write replaced.
   */
  function invalidatePacks() {
    packsScan = null;
  }

  /** The scanned packs: one scan per write, or per TTL window. */
  function scanPacks() {
    if (packsScan !== null && Date.now() - packsScan.at < scanTtlMs) return packsScan.packs;
    const entry = { at: Date.now(), packs: Promise.resolve().then(() => scan(roots, logger)) };
    entry.packs.catch(() => {
      // A rejection is not a result: clearing the memo lets the next reader
      // retry instead of replaying the same failure for the rest of the TTL.
      if (packsScan === entry) packsScan = null;
    });
    packsScan = entry;
    return entry.packs;
  }

  /**
   * The mutation queue. `select` and `restore` each read the persisted id and
   * then swap what is mounted, so letting them interleave would let a restore
   * that read the old id mount its pack after a select had already mounted the
   * new one — memory and the settings document would disagree until a restart.
   * One promise chain runs them in order; a rejected task never breaks it.
   */
  let queue = Promise.resolve();

  function serialize(task) {
    const run = queue.then(task, task);
    queue = run.then(() => {}, () => {});
    return run;
  }

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

  /** Compose and mount one already-loaded pack document. */
  function mountDocument(document) {
    mount(composePersonaText(document.prompt, document.tone));
  }

  async function findPack(id) {
    const pack = (await scanPacks()).get(id);
    if (!pack) throw personaError('persona-not-found');
    return pack;
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

    /**
     * Every discovered pack, in scan order, as public descriptors. Served from
     * the memo: the scan is repeated only after a write invalidated it or the
     * memo window lapsed.
     */
    async list() {
      const packs = await scanPacks();
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
     * Select a pack deployment-wide: persist the choice, then swap the persona
     * sections, then announce the voice binding. An empty id clears the persona.
     * The settings document is written first so it stays the source of truth: a
     * reader that sees the persisted id never disagrees with what is mounted,
     * and a failed write leaves the mounted persona untouched.
     * @param id - pack id, or `''` to clear.
     * @returns `{ok: true, active}`.
     */
    async select(id) {
      requireReady();
      const packId = typeof id === 'string' ? id.trim() : '';
      if (packId !== '' && !PACK_ID.test(packId)) throw personaError('persona-invalid-id');
      return serialize(async () => {
        if (packId === '') {
          await settings.update({ active: '' });
          invalidatePacks();
          mount(null);
          announce('', null);
          return { ok: true, active: '' };
        }
        const pack = await findPack(packId);
        // Read the documents before persisting: a pack whose prompt vanished
        // must fail here, with nothing written and nothing mounted.
        const document = await loadPackDocument(pack, logger);
        await settings.update({ active: packId });
        invalidatePacks();
        mountDocument(document);
        announce(packId, pack.voice);
        return { ok: true, active: packId };
      });
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

    /** The scan roots, in precedence order, for a surface that only displays them. */
    roots() {
      return roots.map(root => resolve(root));
    },

    /**
     * Create a new pack skeleton under the user root (the first scan root), so
     * the very next `list()` serves it: the write invalidates the catalog memo
     * before it returns. The id is validated first and the target directory is
     * created non-recursively, so an existing pack is never overwritten.
     * @param request - `{id, name?}`; `name` defaults to the id.
     * @returns `{ok: true, id, path}` with the created pack directory.
     */
    async scaffold(request) {
      const packId = typeof request?.id === 'string' ? request.id.trim() : '';
      if (!PACK_ID.test(packId)) throw personaError('persona-invalid-id');
      const userRoot = resolve(roots[0]);
      const target = resolve(userRoot, packId);
      // The id alphabet already rules out traversal; resolving again keeps the
      // containment guarantee true for a root that reaches the target through
      // a symlink or a `..` of its own.
      if (target !== userRoot && !target.startsWith(userRoot + sep)) throw personaError('persona-invalid-id');
      await mkdir(userRoot, { recursive: true });
      try {
        await mkdir(target);
      } catch (error) {
        if (error?.code === 'EEXIST') throw personaError('persona-exists', error);
        throw error;
      }
      try {
        for (const [file, content] of scaffoldFiles(packId, request?.name)) {
          await writeFile(join(target, file), content, 'utf8');
        }
      } catch (error) {
        // A half-written pack would both scan as broken and block the retry
        // with "exists"; remove it before reporting the write failure.
        try {
          await rm(target, { recursive: true, force: true });
        } catch (cleanupError) {
          logger.warn('persona.scaffold.cleanup', { path: target }, cleanupError);
        }
        throw error;
      }
      // The directory now exists: drop the memo so the next catalog read sees it.
      invalidatePacks();
      return { ok: true, id: packId, path: target };
    },

    /**
     * Re-apply the persisted pack, so a restart keeps the persona. The
     * persisted id is read inside the mutation queue, so a restore queued
     * behind a select applies that select's pack rather than the one it
     * replaced. A pack that disappeared from disk only warns: the deployment
     * falls back to no persona.
     * @returns `{restored, packId?}`.
     */
    async restore() {
      requireReady();
      return serialize(async () => {
        const packId = settings.get().active;
        if (!packId || !PACK_ID.test(packId)) return { restored: false };
        const pack = (await scanPacks()).get(packId);
        if (!pack) {
          logger.warn('persona.restore.missing', { packId });
          return { restored: false };
        }
        mountDocument(await loadPackDocument(pack, logger));
        invalidatePacks();
        announce(packId, pack.voice);
        return { restored: true, packId };
      });
    },
  };
}

/** HTTP handlers for the `/fairy-persona/*` routes. */
export function createFairyPersonaHandlers(service) {
  const fail = (res, error) => {
    // Every expected refusal carries `code` (readJson included); anything else
    // is an unexpected 500 and gets diagnosed as such.
    const code = error?.code;
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
    roots: async (req, res) => {
      try {
        sendJson(res, 200, { roots: service.roots() });
      } catch (error) {
        fail(res, error);
      }
    },
    scaffold: async (req, res) => {
      try {
        const body = await readJson(req);
        sendJson(res, 200, await service.scaffold(body));
      } catch (error) {
        fail(res, error);
      }
    },
  };
}

const ROUTES = ['list', 'select', 'preview', 'roots', 'scaffold'];

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
