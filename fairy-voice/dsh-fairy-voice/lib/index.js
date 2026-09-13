import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { chmod, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { settingsNamespace } from '@deepseek-ai/dsh-settings';
import z from '@deepseek-ai/schemastery';
import { createPcmStreamHandler } from './server/pcm-forward.js';
import { createVoiceBriefFallback, createVoiceBrainServerBoundary } from './server/voice-brief-fallback.js';
import {
  PROVIDER_CONFIG_DEFAULTS,
  PROVIDER_CONFIG_FIELDS,
  PROVIDER_IDS,
  configKeyForProvider,
  createProviderRegistry,
} from './providers/index.js';
import { LOCAL_SOVITS_ID } from './providers/local-sovits.js';
import {
  STT_DEFAULTS,
  STT_PROVIDER_CONFIG_FIELDS,
  STT_PROVIDER_IDS,
  createSttRegistry,
} from './providers/stt-index.js';
import { createFairyDiagnostics } from 'dsh-fairy-contracts/diagnostics';

export const FAIRY_VOICE_SETTINGS_NAMESPACE = 'fairy-voice';
const FAIRY_VOICE_SETTINGS = settingsNamespace(FAIRY_VOICE_SETTINGS_NAMESPACE);
const diagnostics = createFairyDiagnostics('dsh-fairy-voice');

export const FAIRY_VOICE_SETTINGS_DEFAULTS = Object.freeze({
  version: 1,
  provider: LOCAL_SOVITS_ID,
  providers: Object.freeze({
    localSovits: Object.freeze({ ...PROVIDER_CONFIG_DEFAULTS.localSovits }),
    openai: Object.freeze({ ...PROVIDER_CONFIG_DEFAULTS.openai }),
    elevenlabsWs: Object.freeze({ ...PROVIDER_CONFIG_DEFAULTS.elevenlabsWs }),
    kokoroWeb: Object.freeze({ ...PROVIDER_CONFIG_DEFAULTS.kokoroWeb }),
    piperWeb: Object.freeze({ ...PROVIDER_CONFIG_DEFAULTS.piperWeb }),
    customHttp: Object.freeze({ ...PROVIDER_CONFIG_DEFAULTS.customHttp }),
  }),
  stt: Object.freeze({
    provider: STT_DEFAULTS.provider,
    providers: Object.freeze({
      browser: Object.freeze({ ...STT_DEFAULTS.providers.browser }),
      openai: Object.freeze({ ...STT_DEFAULTS.providers.openai }),
      customHttp: Object.freeze({ ...STT_DEFAULTS.providers.customHttp }),
    }),
  }),
});

export const FairyVoiceSettings = z.object({
  version: z.number().step(1).default(1),
  // Free-form ids on purpose: an unknown provider (typo, or a pack written for
  // a newer plugin) must degrade to the documented fallback, not fail the
  // registration of this namespace on host startup.
  provider: z.string().default(LOCAL_SOVITS_ID),
  providers: z.object({
    localSovits: z.object({
      baseURL: z.string().default(PROVIDER_CONFIG_DEFAULTS.localSovits.baseURL),
      referenceAudioPath: z.string().default(PROVIDER_CONFIG_DEFAULTS.localSovits.referenceAudioPath),
      referencePromptPath: z.string().default(PROVIDER_CONFIG_DEFAULTS.localSovits.referencePromptPath),
    }).default({ ...PROVIDER_CONFIG_DEFAULTS.localSovits }),
    openai: z.object({
      baseURL: z.string().default(PROVIDER_CONFIG_DEFAULTS.openai.baseURL),
      apiKey: z.string().default(''),
      model: z.string().default(PROVIDER_CONFIG_DEFAULTS.openai.model),
      voice: z.string().default(PROVIDER_CONFIG_DEFAULTS.openai.voice),
    }).default({ ...PROVIDER_CONFIG_DEFAULTS.openai }),
    elevenlabsWs: z.object({
      baseUrl: z.string().default(PROVIDER_CONFIG_DEFAULTS.elevenlabsWs.baseUrl),
      apiKey: z.string().default(''),
      voiceId: z.string().default(PROVIDER_CONFIG_DEFAULTS.elevenlabsWs.voiceId),
      modelId: z.string().default(PROVIDER_CONFIG_DEFAULTS.elevenlabsWs.modelId),
      // Constrained by the provider at request time; unknown values fall back
      // to a null sample rate instead of failing the namespace.
      outputFormat: z.string().default(PROVIDER_CONFIG_DEFAULTS.elevenlabsWs.outputFormat),
    }).default({ ...PROVIDER_CONFIG_DEFAULTS.elevenlabsWs }),
    kokoroWeb: z.object({
      moduleUrl: z.string().default(PROVIDER_CONFIG_DEFAULTS.kokoroWeb.moduleUrl),
      modelId: z.string().default(PROVIDER_CONFIG_DEFAULTS.kokoroWeb.modelId),
      dtype: z.string().default(PROVIDER_CONFIG_DEFAULTS.kokoroWeb.dtype),
      device: z.string().default(PROVIDER_CONFIG_DEFAULTS.kokoroWeb.device),
      voice: z.string().default(PROVIDER_CONFIG_DEFAULTS.kokoroWeb.voice),
      // Model-resource mirror (HuggingFace); empty keeps the engine default.
      resourceBase: z.string().default(''),
    }).default({ ...PROVIDER_CONFIG_DEFAULTS.kokoroWeb }),
    piperWeb: z.object({
      moduleUrl: z.string().default(PROVIDER_CONFIG_DEFAULTS.piperWeb.moduleUrl),
      voiceId: z.string().default(PROVIDER_CONFIG_DEFAULTS.piperWeb.voiceId),
      resourceBase: z.string().default(''),
    }).default({ ...PROVIDER_CONFIG_DEFAULTS.piperWeb }),
    customHttp: z.object({
      url: z.string().default(''),
      // Constrained by the provider at request time, for the same reason as provider.
      method: z.string().default('POST'),
      headersJson: z.string().default(PROVIDER_CONFIG_DEFAULTS.customHttp.headersJson),
      bodyTemplate: z.string().default(PROVIDER_CONFIG_DEFAULTS.customHttp.bodyTemplate),
    }).default({ ...PROVIDER_CONFIG_DEFAULTS.customHttp }),
  }).default({ ...FAIRY_VOICE_SETTINGS_DEFAULTS.providers }),
  stt: z.object({
    // Free-form for the same reason as the TTS provider id: an unknown value
    // must degrade in the registry, not fail namespace registration.
    provider: z.string().default(STT_DEFAULTS.provider),
    providers: z.object({
      browser: z.object({
        lang: z.string().default(STT_DEFAULTS.providers.browser.lang),
      }).default({ ...STT_DEFAULTS.providers.browser }),
      openai: z.object({
        baseURL: z.string().default(STT_DEFAULTS.providers.openai.baseURL),
        apiKey: z.string().default(''),
        model: z.string().default(STT_DEFAULTS.providers.openai.model),
        language: z.string().default(STT_DEFAULTS.providers.openai.language),
      }).default({ ...STT_DEFAULTS.providers.openai }),
      customHttp: z.object({
        url: z.string().default(''),
        headersJson: z.string().default(STT_DEFAULTS.providers.customHttp.headersJson),
        responsePath: z.string().default(STT_DEFAULTS.providers.customHttp.responsePath),
      }).default({ ...STT_DEFAULTS.providers.customHttp }),
    }).default({ ...FAIRY_VOICE_SETTINGS_DEFAULTS.stt.providers }),
  }).default({ ...FAIRY_VOICE_SETTINGS_DEFAULTS.stt }),
});

/** Every settings field whose value must never reach the browser verbatim. */
const SENSITIVE_FIELD = /authorization|credential|password|secret|token|api[_-]?key|cookie/i;
const REDACTED = '***';

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function mergePatch(under, patch) {
  if (patch === undefined) return under;
  if (!under || typeof under !== 'object' || Array.isArray(under)
    || !patch || typeof patch !== 'object' || Array.isArray(patch)) return patch;
  const merged = { ...under };
  for (const [key, value] of Object.entries(patch)) merged[key] = key in merged ? mergePatch(merged[key], value) : value;
  return merged;
}

/** Settings boundary used by handlers; `attach` swaps it onto the live scope. */
export function createVoiceSettingsBoundary(initial = FAIRY_VOICE_SETTINGS_DEFAULTS) {
  let current = cloneJson(initial);
  const boundary = {
    read: () => current,
    async write(patch) {
      current = mergePatch(current, patch);
      return current;
    },
    attach(scope) {
      current = scope.get();
      boundary.read = () => scope.get();
      boundary.write = async (patch) => {
        await scope.update(patch);
        return scope.get();
      };
    },
  };
  return boundary;
}

/** Mask one `providers` map; the field-name matcher is provider-agnostic. */
function maskProviderSections(sections) {
  const masked = {};
  for (const [key, fields] of Object.entries(sections || {})) {
    masked[key] = Object.fromEntries(Object.entries(fields || {}).map(([name, entry]) => [
      name,
      SENSITIVE_FIELD.test(name) && typeof entry === 'string' && entry ? REDACTED : entry,
    ]));
  }
  return masked;
}

/** Wire form: provider section with every sensitive field masked. */
function sanitizeVoiceSettings(value) {
  return {
    provider: PROVIDER_IDS.includes(value?.provider) ? value.provider : LOCAL_SOVITS_ID,
    providers: maskProviderSections(value?.providers),
  };
}

/** Wire form of the STT section, masked by the same field-name matcher. */
function sanitizeSttSettings(value) {
  return {
    provider: STT_PROVIDER_IDS.includes(value?.stt?.provider) ? value.stt.provider : STT_DEFAULTS.provider,
    providers: maskProviderSections(value?.stt?.providers),
  };
}

/** Keep only writable string fields; a masked secret means "unchanged". */
function pickKnownFields(fields, allowed) {
  const picked = {};
  for (const [name, value] of Object.entries(fields)) {
    if (!allowed.includes(name) || typeof value !== 'string') continue;
    if (SENSITIVE_FIELD.test(name) && value === REDACTED) continue;
    picked[name] = value;
  }
  return picked;
}

/** Inbound write form: known keys only, masked secrets left untouched. */
function buildVoiceSettingsPatch(body = {}) {
  const patch = {};
  if (body.provider !== undefined) {
    const provider = String(body.provider);
    if (!PROVIDER_IDS.includes(provider)) throw Object.assign(new Error('unknown provider'), { code: 'provider-unknown' });
    patch.provider = provider;
  }
  const providers = body.providers;
  if (providers !== undefined) {
    if (!providers || typeof providers !== 'object' || Array.isArray(providers)) throw Object.assign(new Error('invalid providers'), { code: 'invalid-json' });
    const next = {};
    for (const [key, fields] of Object.entries(providers)) {
      const allowed = PROVIDER_CONFIG_FIELDS[key];
      if (!allowed || !fields || typeof fields !== 'object' || Array.isArray(fields)) continue;
      const picked = pickKnownFields(fields, allowed);
      if (Object.keys(picked).length) next[key] = picked;
    }
    if (Object.keys(next).length) patch.providers = next;
  }
  return patch;
}

/**
 * Inbound STT write form. Unlike the TTS pair this one is deliberately
 * forgiving: an unknown provider id or section key is ignored rather than
 * rejected, so a settings card written against a newer provider list still
 * saves the fields this host understands. A masked key keeps the stored
 * secret; an empty string clears it.
 */
function buildSttSettingsPatch(body = {}) {
  const patch = {};
  if (typeof body.provider === 'string' && STT_PROVIDER_IDS.includes(body.provider)) patch.provider = body.provider;
  const providers = body.providers;
  if (providers && typeof providers === 'object' && !Array.isArray(providers)) {
    const next = {};
    for (const [key, fields] of Object.entries(providers)) {
      const allowed = STT_PROVIDER_CONFIG_FIELDS[key];
      if (!allowed || !fields || typeof fields !== 'object' || Array.isArray(fields)) continue;
      const picked = pickKnownFields(fields, allowed);
      if (Object.keys(picked).length) next[key] = picked;
    }
    if (Object.keys(next).length) patch.providers = next;
  }
  return Object.keys(patch).length ? { stt: patch } : {};
}

/** Persona voice binding: persona packets describe a provider plus its config. */
export function personaVoicePatch(voice) {
  const provider = typeof voice?.provider === 'string' ? voice.provider : '';
  if (!provider || !PROVIDER_IDS.includes(provider)) {
    if (voice) diagnostics.warn('persona.binding', { provider, skipped: true });
    return null;
  }
  const key = configKeyForProvider(provider);
  const config = voice.config;
  if (!key || !config || typeof config !== 'object' || Array.isArray(config)) return { provider };
  const allowed = PROVIDER_CONFIG_FIELDS[key];
  const picked = {};
  for (const [name, value] of Object.entries(config)) {
    if (!allowed.includes(name) || typeof value !== 'string' || !value) continue;
    if (SENSITIVE_FIELD.test(name) && value === REDACTED) continue;
    picked[name] = value;
  }
  return Object.keys(picked).length ? { provider, providers: { [key]: picked } } : { provider };
}

const MAX_TTS_TEXT_LENGTH = 500;
/* ponytail: 8 MiB covers a spoken utterance, and 60s covers a natural pause;
 * dictation far beyond either would need a chunked upload instead. */
const MAX_STT_BYTES = 8 * 1024 * 1024;
const STT_TIMEOUT_MS = 60_000;
const MAX_SENTENCE_LENGTH = 40;
const TTS_TIMEOUT_MS = 180_000;
const VOICE_BRIEF_TIMEOUT_MS = 6_500;
const MAX_VOICE_BRIEF_INPUT_LENGTH = 32_000;
const MAX_VOICE_BRIEF_OUTPUT_LENGTH = 260;
const DEEPSEEK_V4_FLASH_MODEL = 'deepseek-v4-flash';
const DEEPSEEK_CHAT_COMPLETIONS_URL = 'https://api.deepseek.com/chat/completions';
const VOICE_BRAIN_CONFIG_PATH = join(homedir(), '.dsh', 'fairy-voice', 'voice-brain.json');
function safeText(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function configuredApiKey(value) {
  const key = typeof value === 'string' ? value.trim() : '';
  return key.length >= 16 && key.length <= 512 && !/[\r\n\0]/.test(key) ? key : '';
}

async function readVoiceBrainConfig() {
  try {
    const source = await readFile(VOICE_BRAIN_CONFIG_PATH, 'utf8');
    await chmod(VOICE_BRAIN_CONFIG_PATH, 0o600);
    const value = JSON.parse(source);
    return { apiKey: configuredApiKey(value?.deepseekApiKey) };
  } catch (error) {
    if (error?.code === 'ENOENT') return { apiKey: '' };
    throw Object.assign(new Error('voice-brain-config-invalid'), { code: 'voice-brain-config-invalid' });
  }
}

/* Windows refuses a replace-rename while the destination is held by another
 * writer, so two concurrent writers of the same file would otherwise leave a
 * phantom EPERM failure. Retry the replace; the last writer still wins. */
async function replaceFile(temporaryPath, file) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(temporaryPath, file);
      return;
    } catch (error) {
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(error?.code) || attempt >= 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 5 * (attempt + 1)));
    }
  }
}

export async function writePrivateJson(file, value) {
  const directory = dirname(file);
  const temporaryPath = `${file}.${process.pid}.${randomUUID()}.tmp`;
  let committed = false;
  let fileHandle = null;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  try {
    // Use fs.open with mode 0o600 to atomically create the file with correct permissions.
    // This eliminates the race condition between writeFile and chmod.
    fileHandle = await open(temporaryPath, 'w', 0o600);
    await fileHandle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await fileHandle.close();
    fileHandle = null;
    await replaceFile(temporaryPath, file);
    committed = true;
    await chmod(file, 0o600);
  } finally {
    if (fileHandle) {
      try {
        await fileHandle.close();
      } catch (error) {
        diagnostics.error('config.close-temporary', error, { file: 'voice-brain.json' });
      }
    }
    if (!committed) {
      try { await unlink(temporaryPath); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    }
  }
}

async function writeVoiceBrainConfig(apiKey) {
  await writePrivateJson(VOICE_BRAIN_CONFIG_PATH, { version: 1, deepseekApiKey: apiKey });
}

async function clearVoiceBrainConfig() {
  try { await unlink(VOICE_BRAIN_CONFIG_PATH); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
}

const ROMAN_VALUES = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
const ROMAN_CHARS = new Map([
  ['Ⅰ', '一'], ['Ⅱ', '二'], ['Ⅲ', '三'], ['Ⅳ', '四'], ['Ⅴ', '五'], ['Ⅵ', '六'],
  ['Ⅶ', '七'], ['Ⅷ', '八'], ['Ⅸ', '九'], ['Ⅹ', '十'], ['Ⅺ', '十一'], ['Ⅻ', '十二'],
  ['ⅰ', '一'], ['ⅱ', '二'], ['ⅲ', '三'], ['ⅳ', '四'], ['ⅴ', '五'], ['ⅵ', '六'],
  ['ⅶ', '七'], ['ⅷ', '八'], ['ⅸ', '九'], ['ⅹ', '十'],
]);

function romanToNumber(value) {
  let total = 0;
  for (let index = 0; index < value.length; index += 1) {
    const current = ROMAN_VALUES[value[index]];
    const next = ROMAN_VALUES[value[index + 1]] || 0;
    total += current < next ? -current : current;
  }
  return total;
}

function numberToChinese(value) {
  if (!Number.isInteger(value) || value < 0 || value > 3999) return String(value);
  const digits = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
  const units = ['', '十', '百', '千'];
  const chars = String(value).split('').map(Number);
  let output = '';
  for (let index = 0; index < chars.length; index += 1) {
    const digit = chars[index];
    const unitIndex = chars.length - index - 1;
    if (digit === 0) {
      if (output && !output.endsWith('零') && chars.slice(index + 1).some(Boolean)) output += '零';
      continue;
    }
    if (!(digit === 1 && unitIndex === 1 && output === '')) output += digits[digit];
    output += units[unitIndex];
  }
  return output || '零';
}

function numberForSpeech(value) {
  const text = String(value).replace(/,/g, '');
  if (!/^\d+(?:\.\d+)?$/.test(text)) return text;
  const [integer, fraction] = text.split('.');
  const integerText = numberToChinese(Number(integer));
  return fraction ? `${integerText}点${[...fraction].map((digit) => ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'][Number(digit)]).join('')}` : integerText;
}

function decimalForSpeech(sign, integer, fraction) {
  return `${sign ? '负' : ''}${numberForSpeech(`${integer || '0'}.${fraction}`)}`;
}

function timeForSpeech(hour, minute, second) {
  const parts = [`${numberForSpeech(hour)}点`];
  if (minute !== undefined) parts.push(`${numberForSpeech(minute)}分`);
  if (second !== undefined) parts.push(`${numberForSpeech(second)}秒`);
  return parts.join('');
}

const ACRONYM_WORDS = {
  AI: '人工智能', API: '接口', CPU: '中央处理器', GPU: '图形处理器', RAM: '运行内存', ROM: '只读存储器',
  USB: '优仕比', URL: '链接', URI: '链接地址', HTTP: '超文本传输协议', HTTPS: '安全超文本传输协议',
  JSON: '杰森', XML: '扩展标记语言', SQL: '数据库查询语言', UI: '用户界面', UX: '用户体验',
  SDK: '开发工具包', IDE: '开发环境', FAQ: '常见问题', CPU占用: '处理器占用',
};

const UNIT_WORDS = {
  'km/h': '千米每小时', 'm/s': '米每秒', 'm²': '平方米', 'm³': '立方米', m2: '平方米', m3: '立方米',
  Hz: '赫兹', kHz: '千赫兹', MHz: '兆赫兹', GHz: '吉赫兹',
  B: '字节', KB: '千字节', MB: '兆字节', GB: '吉字节', TB: '太字节',
  kg: '千克', g: '克', mg: '毫克', t: '吨', km: '千米', m: '米', cm: '厘米', mm: '毫米',
  L: '升', mL: '毫升', h: '小时', min: '分钟', s: '秒', ms: '毫秒', us: '微秒',
};

function replaceRomanNumerals(text) {
  let output = [...text].map((char) => ROMAN_CHARS.get(char) || char).join('');
  // Only convert standalone multi-character Roman numerals. This avoids
  // turning ordinary Latin words such as "C" or "IVF" into numbers.
  return output.replace(/(?<![A-Za-z])([IVXLCDM]{2,})(?![A-Za-z])/gi, (match) => {
    const upper = match.toUpperCase();
    const value = romanToNumber(upper);
    return value >= 1 && value <= 3999 ? numberToChinese(value) : match;
  });
}

/**
 * Convert display text into conservative, pronunciation-friendly Chinese.
 * The rules intentionally target symbols and units that commonly confuse
 * local Chinese TTS; ordinary words and normal punctuation are preserved.
 */
export function normalizeSpeechText(value) {
  let text = String(value || '')
    .replace(/m²/g, 'm2').replace(/m³/g, 'm3')
    .replace(/²/g, '平方').replace(/³/g, '立方').replace(/¹/g, '一')
    .normalize('NFKC')
    // NFKC folds the compatibility semicolon to ASCII. Restore it here so
    // repeated normalization (markdown extraction plus sentence splitting)
    // remains idempotent and keeps the intended long pause.
    .replace(/;/g, '\uFF1B')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[\p{Extended_Pictographic}\uFE0F]/gu, '')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'");
  text = replaceRomanNumerals(text)
    // Protect content whose punctuation is not meaningful to speech.
    .replace(/(?:https?|ftp):\/\/[^\s)》】]+/gi, '链接')
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '邮箱地址')
    // Dates, times, ranges, ratios and fractions.
    .replace(/(\d{4})\s*[-/]\s*(\d{1,2})\s*[-/]\s*(\d{1,2})/g, '$1年$2月$3日')
    .replace(/\b(\d{1,2}):(\d{2})(?::(\d{2}))?\b/g, (_match, hour, minute, second) => timeForSpeech(hour, minute, second))
    .replace(/(\d+(?:\.\d+)?)\s*(?:-|~|～|至)\s*(\d+(?:\.\d+)?)/g, (_match, from, to) => `${numberForSpeech(from)}到${numberForSpeech(to)}`)
    .replace(/(\d+)\s*\/\s*(\d+)/g, (_match, numerator, denominator) => `${numberForSpeech(denominator)}分之${numberForSpeech(numerator)}`)
    .replace(/(\d+)\s*:\s*(\d+)/g, (_match, left, right) => `${numberForSpeech(left)}比${numberForSpeech(right)}`)
    // Currency and percentages.
    .replace(/([$¥￥€£])\s*(\d[\d,]*(?:\.\d+)?)/g, (_match, sign, number) => `${numberForSpeech(number)}${({ '$': '美元', '¥': '元', '￥': '元', '€': '欧元', '£': '英镑' })[sign]}`)
    .replace(/(\d[\d,]*(?:\.\d+)?)\s*(美元|元|人民币|欧元|英镑|日元)/g, (_match, number, unit) => `${numberForSpeech(number)}${unit}`)
    .replace(/°\s*C/gi, '摄氏度')
    .replace(/°\s*F/gi, '华氏度')
    .replace(/℃/g, '摄氏度')
    .replace(/℉/g, '华氏度')
    .replace(/(\d+(?:\.\d+)?)\s*%/g, (_match, number) => `百分之${numberForSpeech(number)}`)
    .replace(/%/g, '百分之')
    .replace(/(\d+(?:\.\d+)?)\s*(摄氏度|华氏度)/g, (_match, number, unit) => `${numberForSpeech(number)}${unit}`)
    .replace(/(\d+(?:\.\d+)?)\s*(m²|m³|m2|m3|km\/h|m\/s|kHz|MHz|GHz|KB|MB|GB|TB|Hz|kg|mg|cm|mm|ms|us|mL|L|km|m|g|t|h|min|s|B)\b/gi, (_match, number, unit) => `${numberForSpeech(number)}${UNIT_WORDS[unit] || UNIT_WORDS[unit.toLowerCase()] || unit}`)
    // Do not rewrite isolated one-letter tokens such as the B in "A/B";
    // those are usually identifiers, not units.
    .replace(/\b(km\/h|m\/s|m²|m³|kHz|MHz|GHz|KB|MB|GB|TB|Hz|kg|mg|cm|mm|ms|us|mL|min)\b/gi, (match) => UNIT_WORDS[match] || UNIT_WORDS[match.toLowerCase()] || match)
    // GPT-SoVITS first recognizes decimals, then mistakes a long fractional
    // part for an identifier and rewrites it again (3.1415926 -> 三.幺四…).
    // Make standalone decimal notation explicit before it reaches that layer.
    // Letter-adjacent values are left intact for version and identifier syntax.
    .replace(/(?<![A-Za-z0-9_.])(-?)(?:(\d[\d,]*)\.(\d+)|\.(\d+))(?![A-Za-z0-9_.])/g, (_match, sign, integer, fraction, pureFraction) => decimalForSpeech(sign, integer, fraction || pureFraction))
    // Unit normalization may have already converted a negative numeric value
    // to Chinese, leaving only its ASCII sign. Resolve that sign before the
    // model's generic punctuation cleanup can turn it into a subtraction.
    .replace(/(?<![\w])-+(?=[零一二三四五六七八九十百千万亿])/g, '负')
    // Common technical abbreviations are more reliable when spoken as words.
    .replace(/\b(AI|API|CPU|GPU|RAM|ROM|USB|URL|URI|HTTP|HTTPS|JSON|XML|SQL|UI|UX|SDK|IDE|FAQ)\b/g, (match) => ACRONYM_WORDS[match] || match)
    .replace(/\+\s*\/\s*-/g, '正负')
    .replace(/(\d+(?:\.\d+)?)\s*\+\s*(\d+(?:\.\d+)?)/g, (_match, left, right) => `${numberForSpeech(left)}加${numberForSpeech(right)}`)
    .replace(/(?<![\w])-(\d+(?:\.\d+)?)/g, (_match, number) => `负${numberForSpeech(number)}`)
    .replace(/±/g, '正负')
    .replace(/×/g, '乘')
    .replace(/÷/g, '除以')
    .replace(/≤/g, '小于等于')
    .replace(/≥/g, '大于等于')
    .replace(/≠/g, '不等于')
    .replace(/≈/g, '约等于')
    .replace(/≡/g, '恒等于')
    .replace(/∝/g, '正比于')
    .replace(/∂/g, '偏导')
    .replace(/</g, '小于')
    .replace(/>/g, '大于')
    .replace(/=/g, '等于')
    .replace(/∑/g, '求和')
    .replace(/√/g, '平方根')
    .replace(/∞/g, '无穷大')
    .replace(/∈/g, '属于')
    .replace(/∉/g, '不属于')
    .replace(/∴/g, '所以')
    .replace(/∵/g, '因为')
    .replace(/©/g, '版权')
    .replace(/®/g, '注册商标')
    .replace(/™/g, '商标')
    .replace(/°/g, '度')
    .replace(/→/g, '指向')
    .replace(/←/g, '返回')
    .replace(/&&/g, '并且')
    .replace(/\|\|/g, '或者')
    .replace(/&/g, '和')
    .replace(/@/g, '艾特')
    .replace(/#/g, '井号')
    .replace(/[αΑ]/g, '阿尔法').replace(/[βΒ]/g, '贝塔').replace(/[γΓ]/g, '伽马').replace(/[δΔ]/g, '德尔塔')
    .replace(/[λΛ]/g, '兰姆达').replace(/[μΜ]/g, '缪').replace(/[πΠ]/g, '派').replace(/[σΣ]/g, '西格玛')
    .replace(/\s*\+\s*/g, '加')
    .replace(/\.{2,}|…+/g, '……')
    // Adjacent terminal marks describe one prosodic boundary. Keeping them as
    // separate sentences creates one-syllable audio fragments ("?!" -> "?" +
    // "!") and sounds like a cut rather than a natural reaction.
    .replace(/[!?]{2,}/g, (marks) => marks.includes('?') ? '?' : '!')
    // A colon is too short for Fairy's prosody. Structural colons were
    // consumed above (times, ratios, URLs and email addresses), so prose
    // colons can safely use the stronger semicolon pause. Collapse variants
    // and repeated colons to avoid accidental double pauses.
    .replace(/[：﹕︰꞉˸]+/g, '\uFF1B')
    .replace(/:{1,}/g, '\uFF1B')
    .replace(/\uFF1B{2,}/g, '\uFF1B')
    .replace(/[—–−]+/g, '，')
    .replace(/-{2,}/g, '，')
    .replace(/,{2,}/g, '，')
    .replace(/,{1}/g, '，')
    .replace(/\s*([，。！？；：、）》】』」,.!?;:])\s*/g, '$1')
    .replace(/\s*([（《【『「])\s*/g, '$1');
  return safeText(text);
}

const SPEECH_BLOCKS = new Set(['paragraph', 'heading', 'listItem', 'blockquote']);
const SPEECH_TERMINATORS = /[。！？；.!?;…]$/;

function collectSpeechText(node, output) {
  if (!node || typeof node !== 'object') return;
  if (node.type === 'text') {
    output.push(node.value);
    return;
  }
  if (['inlineCode', 'code', 'html', 'image', 'table'].includes(node.type)) return;
  const start = output.length;
  for (const child of node.children || []) collectSpeechText(child, output);
  /* Markdown removes blank lines structurally. Preserve that boundary for TTS:
   * prose blocks without punctuation would otherwise be flattened into one
   * breath, especially in generated lists and short status reports. */
  if (SPEECH_BLOCKS.has(node.type) && output.length > start) {
    const last = output[output.length - 1].trim();
    if (last && !SPEECH_TERMINATORS.test(last)) output.push('；');
  }
}

export function markdownToSpeechText(markdown) {
  const root = fromMarkdown(String(markdown || ''), {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });
  const output = [];
  collectSpeechText(root, output);
  return normalizeSpeechText(output.join(' '));
}

export function splitSpeechSentences(text) {
  const normalized = normalizeSpeechText(text);
  if (!normalized) return [];
  const raw = [];
  let current = '';
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    const previous = normalized[index - 1] || '';
    const next = normalized[index + 1] || '';
    current += char;
    // A decimal point is part of the number, not a speech boundary.
    if (char === '.' && /\d/.test(previous) && /\d/.test(next)) continue;
    if ('。！？；!?;'.includes(char) && next !== '…') {
      raw.push(current);
      current = '';
      continue;
    }
    if (char === '…' && next !== '…' && previous !== '…') {
      raw.push(current);
      current = '';
    }
  }
  if (current.trim()) raw.push(current);
  const result = [];
  for (const sentence of raw) {
    let remaining = sentence.trim();
    while (remaining.length > MAX_SENTENCE_LENGTH) {
      const boundary = Math.max(remaining.lastIndexOf('，', MAX_SENTENCE_LENGTH), remaining.lastIndexOf(',', MAX_SENTENCE_LENGTH), remaining.lastIndexOf('：', MAX_SENTENCE_LENGTH), remaining.lastIndexOf(':', MAX_SENTENCE_LENGTH));
      const cut = boundary > 7 ? boundary + 1 : MAX_SENTENCE_LENGTH;
      result.push(remaining.slice(0, cut).trim());
      remaining = remaining.slice(cut).trim();
    }
    if (remaining) result.push(remaining);
  }
  return result;
}

function sendJson(res, status, value) {
  if (res.destroyed || res.writableEnded) return false;
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(value));
  return true;
}

async function readJson(req, maxBytes = 300_000) {
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

/** Exact media type of a request, lower-cased, with parameters stripped. */
function requestContentType(req) {
  const raw = req?.headers?.['content-type'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return String(value || '').split(';')[0].trim().toLowerCase();
}

/** Optional language override for one utterance; anything else is ignored. */
function requestLanguage(req) {
  const raw = req?.headers?.['x-fairy-language'];
  const value = String(Array.isArray(raw) ? raw[0] : raw ?? '').trim();
  return /^[\w-]{1,35}$/.test(value) ? value : '';
}

/** Raw request body reader; the size guard fires before the payload is kept. */
async function readBuffer(req, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw Object.assign(new Error('audio-too-large'), { code: 'audio-too-large' });
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function publicError(code) {
  const messages = {
    'empty-text': 'Text is required.',
    'text-too-large': `Text must not exceed ${MAX_TTS_TEXT_LENGTH} characters.`,
    'invalid-json': 'Invalid request.',
    'local-service-unavailable': '本地 Fairy 服务未启动。',
    'local-service-failed': '本地 Fairy 服务未能生成音频。',
    timeout: '本地 Fairy 生成超时。',
    'client-aborted': 'Request cancelled.',
    'client-side': '浏览器端朗读',
    'provider-unavailable': '语音服务连接失败。',
    'provider-failed': '语音服务未能生成音频。',
    'provider-timeout': '语音服务生成超时。',
    'provider-config-invalid': '语音服务配置无效。',
    'provider-unknown': '未知的语音提供方。',
    'audio-too-large': '音频数据不能超过 8 MiB。',
    'unsupported-audio-type': '请求体必须是音频数据（audio/*）。',
    'voice-brief-unconfigured': '请先在 Fairy Voice Brain 设置中配置 DeepSeek API Key。',
    'voice-brief-input-too-large': '最终回答过长，已使用原文朗读。',
    'voice-brief-config-invalid': 'Voice Brain 配置文件无效。',
    'voice-brief-request-failed': 'Voice Brain 请求失败，已使用原文朗读。',
    'voice-brief-empty': 'Voice Brain 未返回可朗读内容，已使用原文朗读。',
    'voice-brief-timeout': 'Voice Brain 请求超时，已使用原文朗读。',
  };
  return { code, message: messages[code] || messages['local-service-failed'] };
}

function statusFor(code) {
  if (['empty-text', 'text-too-large', 'invalid-json', 'voice-brief-input-too-large', 'provider-config-invalid', 'provider-unknown'].includes(code)) return 400;
  if (['voice-brief-unconfigured', 'voice-brief-config-invalid'].includes(code)) return 422;
  if (code === 'audio-too-large') return 413;
  if (code === 'unsupported-audio-type') return 415;
  if (code === 'client-aborted') return 499;
  if (code === 'client-side') return 409;
  if (['local-service-unavailable', 'provider-unavailable'].includes(code)) return 503;
  if (['timeout', 'provider-timeout'].includes(code)) return 504;
  return 502;
}

/** 409 keeps the shared `client-side` code; the wording is input-specific. */
function publicSttError(code) {
  const messages = {
    'client-side': '浏览器端语音输入',
    timeout: '语音识别超时。',
    'provider-failed': '语音识别服务未能完成识别。',
    'provider-unavailable': '语音识别服务不可用或未配置。',
  };
  return messages[code] ? { code, message: messages[code] } : publicError(code);
}

function createVoiceRequestScope() {
  const controller = new AbortController();
  const timers = new Set();
  let cancelled = false;
  const cancel = (reason = 'client-aborted') => {
    if (cancelled) return;
    cancelled = true;
    controller.abort(reason);
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
  };
  return {
    controller,
    signal: controller.signal,
    timeout(callback, delay) {
      if (cancelled) return 0;
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (!cancelled) callback();
      }, delay);
      timers.add(timer);
      return timer;
    },
    cancel,
  };
}

function createSentencePreparation() {
  return {
    text(markdown) {
      return markdownToSpeechText(markdown);
    },
    sentences(markdown) {
      return splitSpeechSentences(markdownToSpeechText(markdown));
    },
  };
}

const createVoiceBrief = createVoiceBriefFallback({
  markdownToSpeechText,
  maxInputLength: MAX_VOICE_BRIEF_INPUT_LENGTH,
  maxOutputLength: MAX_VOICE_BRIEF_OUTPUT_LENGTH,
  timeoutMs: VOICE_BRIEF_TIMEOUT_MS,
  model: DEEPSEEK_V4_FLASH_MODEL,
  endpoint: DEEPSEEK_CHAT_COMPLETIONS_URL,
});

export function createFairyVoiceHandlers({
  fetchImpl = fetch,
  readConfig = readVoiceBrainConfig,
  writeConfig = writeVoiceBrainConfig,
  clearConfig = clearVoiceBrainConfig,
  settings = createVoiceSettingsBoundary(),
  providers = createProviderRegistry({ fetchImpl }),
} = {}) {
  const sentencePreparation = createSentencePreparation();
  const pcmStreamHandler = createPcmStreamHandler();
  const voiceBrainBoundary = createVoiceBrainServerBoundary({
    createBrief: createVoiceBrief,
    fetchImpl,
    readConfig,
    writeConfig,
    clearConfig,
    configuredApiKey,
    model: DEEPSEEK_V4_FLASH_MODEL,
  });
  /* GPT-SoVITS owns one mutable inference pipeline. Serialize it by making
   * the newest user intent cancel the prior stream before it can overlap,
   * consume CPU, or corrupt the pipeline's shared state. */
  let activeTtsController = null;
  const activeControllers = new Set();
  return {
    dispose: () => {
      for (const controller of activeControllers) controller.abort('disposed');
      activeControllers.clear();
      activeTtsController = null;
    },
    status: async (_req, res) => {
      const startedAt = diagnostics.start();
      let providerId = LOCAL_SOVITS_ID;
      try {
        providerId = providers.resolve(settings.read()).id;
        const value = await providers.check(providerId, settings.read());
        sendJson(res, 200, { available: value.available === true, reason: value.reason ?? null, provider: providerId });
      } catch (error) {
        diagnostics.warn('status.request', { provider: providerId }, error);
        sendJson(res, 200, { available: false, reason: '语音服务未就绪。', provider: providerId });
      } finally {
        diagnostics.metric('status.request', startedAt, {}, { thresholdMs: 100 });
      }
    },
    providers: async (_req, res) => {
      const startedAt = diagnostics.start();
      try {
        sendJson(res, 200, await providers.list(settings.read()));
      } catch (error) {
        diagnostics.warn('providers.request', {}, error);
        sendJson(res, 200, PROVIDER_IDS.map((id) => ({ id, available: false, reason: '检查失败。' })));
      } finally {
        diagnostics.metric('providers.request', startedAt, {}, { thresholdMs: 100 });
      }
    },
    providerConfig: async (req, res) => {
      try {
        if (req.method === 'GET') {
          sendJson(res, 200, sanitizeVoiceSettings(settings.read()));
          return;
        }
        const body = await readJson(req, 20_000);
        await settings.write(buildVoiceSettingsPatch(body));
        sendJson(res, 200, sanitizeVoiceSettings(settings.read()));
      } catch (error) {
        const code = error?.code || (error?.message === 'invalid-json' ? 'invalid-json' : 'provider-config-invalid');
        diagnostics.warn('provider.config', { code }, error);
        sendJson(res, statusFor(code), { error: publicError(code) });
      }
    },
    prepare: async (req, res) => {
      const startedAt = diagnostics.start();
      try {
        const body = await readJson(req);
        sendJson(res, 200, { sentences: sentencePreparation.sentences(body.markdown) });
      } catch (error) {
        const code = error.message === 'payload-too-large' ? 'text-too-large' : 'invalid-json';
        diagnostics.warn('speech.prepare', { code }, error);
        sendJson(res, 400, { error: publicError(code) });
      } finally {
        diagnostics.metric('speech.prepare', startedAt, {}, { thresholdMs: 20 });
      }
    },
    voiceBrainStatus: async (_req, res) => {
      try {
        sendJson(res, 200, await voiceBrainBoundary.status());
      } catch (error) {
        sendJson(res, 200, { configured: false, model: DEEPSEEK_V4_FLASH_MODEL, error: publicError(error?.code || 'voice-brief-config-invalid') });
      }
    },
    voiceBrainConfig: async (req, res) => {
      try {
        const body = await readJson(req, 10_000);
        sendJson(res, 200, await voiceBrainBoundary.configure(body));
      } catch (error) {
        const code = error?.code || (error?.message === 'invalid-json' ? 'invalid-json' : 'voice-brief-config-invalid');
        sendJson(res, statusFor(code), { error: publicError(code) });
      }
    },
    voiceBrief: async (req, res) => {
      const startedAt = diagnostics.start();
      const scope = createVoiceRequestScope();
      const controller = scope.controller;
      activeControllers.add(controller);
      const disconnect = () => controller.abort('client-aborted');
      const close = () => { if (!res.writableEnded) disconnect(); };
      req.once('aborted', disconnect);
      res.once('close', close);
      try {
        const body = await readJson(req, 100_000);
        const markdown = typeof body?.markdown === 'string' ? body.markdown : '';
        if (!markdown.trim()) throw Object.assign(new Error('empty-text'), { code: 'empty-text' });
        sendJson(res, 200, await voiceBrainBoundary.brief(markdown, controller.signal));
      } catch (error) {
        const code = error?.code || (error?.message === 'invalid-json' ? 'invalid-json' : 'voice-brief-request-failed');
        if (code !== 'client-aborted') diagnostics.warn('brain.brief', { code }, error);
        if (!res.writableEnded) sendJson(res, statusFor(code), { error: publicError(code) });
      } finally {
        diagnostics.metric('brain.brief', startedAt, { aborted: controller.signal.aborted });
        activeControllers.delete(controller);
        req.removeListener('aborted', disconnect);
        res.removeListener('close', close);
        scope.cancel('request-complete');
      }
    },
    tts: async (req, res) => {
      const startedAt = diagnostics.start();
      const scope = createVoiceRequestScope();
      const controller = scope.controller;
      activeControllers.add(controller);
      const totalTimer = scope.timeout(() => scope.cancel('timeout'), TTS_TIMEOUT_MS);
      const disconnect = () => controller.abort('client-aborted');
      const close = () => { if (!res.writableEnded) disconnect(); };
      req.once('aborted', disconnect);
      res.once('close', close);
      let releaseUpstream = null;
      try {
        const body = await readJson(req, 20_000);
        const text = normalizeSpeechText(body.text);
        if (!text) throw Object.assign(new Error('empty'), { code: 'empty-text' });
        if (Array.from(text).length > MAX_TTS_TEXT_LENGTH) throw Object.assign(new Error('large'), { code: 'text-too-large' });
        activeTtsController?.abort('superseded');
        activeTtsController = controller;
        const { id: providerId, provider, config } = providers.resolve(settings.read());
        const upstream = await provider.stream(text, config, { signal: controller.signal });
        const response = upstream.response || upstream;
        releaseUpstream = upstream.release || null;
        if (!response?.ok) throw Object.assign(new Error('synthesis failed'), { code: providerId === LOCAL_SOVITS_ID ? 'local-service-failed' : 'provider-failed' });
        res.statusCode = 200;
        res.setHeader('Content-Type', response.headers.get('content-type') || 'audio/raw');
        res.setHeader('Cache-Control', 'no-store');
        // Providers that synthesize at a rate other than the client's default
        // must announce it, or Web Audio would play the PCM at the wrong speed.
        if (Number.isFinite(upstream.sampleRate)) res.setHeader('X-Fairy-Sample-Rate', String(upstream.sampleRate));
        await pcmStreamHandler.pipe(response, res, controller.signal);
        if (!res.destroyed && !res.writableEnded) res.end();
      } catch (error) {
        const code = error.code || (error.message === 'invalid-json' ? 'invalid-json' : 'local-service-failed');
        if (!['client-aborted', 'superseded'].includes(code)) diagnostics.warn('tts.stream', { code, headers_sent: res.headersSent }, error);
        // Once audio headers/bytes are sent, a JSON body would corrupt the PCM
        // stream. Close the stream instead and let the browser retry/report it.
        if (res.headersSent) {
          if (!res.destroyed) res.destroy(error);
        } else if (!res.writableEnded) {
          sendJson(res, statusFor(code), { error: publicError(code) });
        }
      } finally {
        diagnostics.metric('tts.stream', startedAt, { aborted: controller.signal.aborted, headers_sent: res.headersSent });
        activeControllers.delete(controller);
        releaseUpstream?.();
        if (activeTtsController === controller) activeTtsController = null;
        if (totalTimer) clearTimeout(totalTimer);
        req.removeListener('aborted', disconnect);
        res.removeListener('close', close);
        scope.cancel('request-complete');
      }
    },
  };
}

/**
 * STT transport boundary: raw audio in, transcript out. Kept as its own
 * bundle because it shares no request state with the TTS handlers beyond the
 * settings boundary (no shared inference pipeline exists to serialize).
 */
export function createFairyVoiceSttHandlers({
  settings = createVoiceSettingsBoundary(),
  fetchImpl = fetch,
  stt = createSttRegistry({ fetchImpl }),
  timeoutMs = STT_TIMEOUT_MS,
} = {}) {
  const activeControllers = new Set();
  return {
    dispose: () => {
      for (const controller of activeControllers) controller.abort('disposed');
      activeControllers.clear();
    },
    sttProviders: async (_req, res) => {
      const startedAt = diagnostics.start();
      try {
        sendJson(res, 200, await stt.list(settings.read()));
      } catch (error) {
        diagnostics.warn('stt.providers.request', {}, error);
        sendJson(res, 200, STT_PROVIDER_IDS.map((id) => ({ id, available: false, reason: '检查失败。' })));
      } finally {
        diagnostics.metric('stt.providers.request', startedAt, {}, { thresholdMs: 100 });
      }
    },
    sttConfig: async (req, res) => {
      try {
        if (req.method === 'GET') {
          sendJson(res, 200, sanitizeSttSettings(settings.read()));
          return;
        }
        const body = await readJson(req, 20_000);
        await settings.write(buildSttSettingsPatch(body));
        sendJson(res, 200, sanitizeSttSettings(settings.read()));
      } catch (error) {
        const code = error?.code || (error?.message === 'invalid-json' ? 'invalid-json' : 'provider-config-invalid');
        diagnostics.warn('stt.config', { code }, error);
        sendJson(res, statusFor(code), { error: publicError(code) });
      }
    },
    stt: async (req, res) => {
      const startedAt = diagnostics.start();
      const scope = createVoiceRequestScope();
      const controller = scope.controller;
      activeControllers.add(controller);
      const totalTimer = scope.timeout(() => scope.cancel('timeout'), timeoutMs);
      const disconnect = () => controller.abort('client-aborted');
      const close = () => { if (!res.writableEnded) disconnect(); };
      req.once('aborted', disconnect);
      res.once('close', close);
      try {
        // The media type is part of the contract, not a hint: a JSON body or a
        // missing header must fail before any bytes are buffered or forwarded.
        const contentType = requestContentType(req);
        if (!contentType.startsWith('audio/')) throw Object.assign(new Error('unsupported media type'), { code: 'unsupported-audio-type' });
        const audio = await readBuffer(req, MAX_STT_BYTES);
        const { provider, config } = stt.resolve(settings.read());
        const result = await provider.transcribe({
          audio,
          contentType,
          language: requestLanguage(req),
          config,
          signal: controller.signal,
        });
        const text = typeof result?.text === 'string' ? result.text : '';
        sendJson(res, 200, { text });
      } catch (error) {
        const code = error?.code || 'provider-failed';
        if (!['client-aborted', 'client-side', 'timeout'].includes(code)) diagnostics.warn('stt.request', { code }, error);
        if (!res.writableEnded) sendJson(res, statusFor(code), { error: publicSttError(code) });
      } finally {
        diagnostics.metric('stt.request', startedAt, { aborted: controller.signal.aborted });
        activeControllers.delete(controller);
        clearTimeout(totalTimer);
        req.removeListener('aborted', disconnect);
        res.removeListener('close', close);
        scope.cancel('request-complete');
      }
    },
  };
}

export function apply(ctx) {
  return diagnostics.guard('apply', () => {
  const settings = createVoiceSettingsBoundary();
  const handlers = createFairyVoiceHandlers({ settings });
  ctx.inject(['settings'], (settingsCtx) => {
    settings.attach(settingsCtx.settings.register(FAIRY_VOICE_SETTINGS, FairyVoiceSettings));
  }, { surface: 'host' });
  /* Persona packets own no voice schema themselves: they announce a provider
   * and the config for it, and this plugin is the only writer of its own
   * namespace. A pack without a voice block keeps the current binding. */
  ctx.effect(() => ctx.on('fairy-persona/change', (payload) => {
    const patch = personaVoicePatch(payload?.voice);
    if (!patch) return undefined;
    return Promise.resolve(settings.write(patch)).catch((error) => {
      diagnostics.warn('persona.binding', { provider: patch.provider }, error);
    });
  }), 'dsh-fairy-voice persona voice binding');
  ctx.inject(['webServer'], (ws) => ws.effect(() => {
    const sttHandlers = createFairyVoiceSttHandlers({ settings });
    const unregisterStatus = ws.webServer.register({ kind: 'exact', path: '/fairy-voice/status', handler: handlers.status });
    const unregisterPrepare = ws.webServer.register({ kind: 'exact', path: '/fairy-voice/prepare', handler: handlers.prepare });
    const unregisterTts = ws.webServer.register({ kind: 'exact', path: '/fairy-voice/tts', handler: handlers.tts });
    const unregisterProviders = ws.webServer.register({ kind: 'exact', path: '/fairy-voice/providers', handler: handlers.providers });
    const unregisterProviderConfig = ws.webServer.register({ kind: 'exact', path: '/fairy-voice/provider-config', handler: handlers.providerConfig });
    const unregisterBrainStatus = ws.webServer.register({ kind: 'exact', path: '/fairy-voice/brain/status', handler: handlers.voiceBrainStatus });
    const unregisterBrainConfig = ws.webServer.register({ kind: 'exact', path: '/fairy-voice/brain/config', handler: handlers.voiceBrainConfig });
    const unregisterBrainBrief = ws.webServer.register({ kind: 'exact', path: '/fairy-voice/brain/brief', handler: handlers.voiceBrief });
    const unregisterSttProviderList = ws.webServer.register({ kind: 'exact', path: '/fairy-voice/stt-providers', handler: sttHandlers.sttProviders });
    const unregisterSttConfig = ws.webServer.register({ kind: 'exact', path: '/fairy-voice/stt-config', handler: sttHandlers.sttConfig });
    const unregisterStt = ws.webServer.register({ kind: 'exact', path: '/fairy-voice/stt', handler: sttHandlers.stt });
    return () => {
      handlers.dispose();
      sttHandlers.dispose();
      unregisterStatus?.();
      unregisterPrepare?.();
      unregisterTts?.();
      unregisterProviders?.();
      unregisterProviderConfig?.();
      unregisterBrainStatus?.();
      unregisterBrainConfig?.();
      unregisterBrainBrief?.();
      unregisterSttProviderList?.();
      unregisterSttConfig?.();
      unregisterStt?.();
    };
  }));
  }, { surface: 'host' });
}
