/* Local markdown memory: the always-available provider and the one that keeps
 * the GBrain promise without GBrain installed - plain files you own, with
 * frontmatter provenance, under $DSH_HOME/fairy-memory/pages. The directory
 * layout mirrors what `gbrain import` takes, so these pages can be adopted by a
 * real brain later without a migration step. */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { PROVIDER_FAILED, providerError } from './http.js';

export const LOCAL_MARKDOWN_ID = 'local-markdown';

export const LOCAL_MARKDOWN_DEFAULTS = Object.freeze({
  directory: '',
});

/** Bounded recall: a memory that costs a minute to read is worse than none. */
const MAX_SCAN_FILES = 500;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_TEXT_CHARS = 20_000;
const MAX_EXCERPT_CHARS = 400;
const MAX_LIMIT = 20;
const BM25_K1 = 1.2;

function resolveConfig(config = {}) {
  return { ...LOCAL_MARKDOWN_DEFAULTS, ...config };
}

/** `${DSH_HOME:-~/.dsh}/fairy-memory/pages` unless the card overrides it. */
export function localMemoryRoot(config = {}) {
  const configured = String(resolveConfig(config).directory || '').trim();
  if (configured) return configured;
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  return join(home, 'fairy-memory', 'pages');
}

function tokenize(value) {
  const text = String(value || '').toLowerCase();
  const tokens = [];
  for (const word of text.match(/[a-z0-9][a-z0-9_+-]{1,}/g) || []) tokens.push(word);
  // CJK has no word boundaries: bigrams are the cheapest useful unit, and they
  // still match sub-phrases the way a reader expects.
  const cjk = text.match(/[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff]+/g) || [];
  for (const run of cjk) {
    if (run.length === 1) tokens.push(run);
    for (let index = 0; index + 1 < run.length; index += 1) tokens.push(run.slice(index, index + 2));
  }
  return tokens;
}

function countTokens(tokens) {
  const counts = new Map();
  for (const token of tokens) counts.set(token, (counts.get(token) || 0) + 1);
  return counts;
}

/** Frontmatter is a small fixed shape; a missing block is not an error. */
function splitPage(source) {
  const text = String(source || '');
  if (!text.startsWith('---\n')) return { meta: {}, body: text };
  const end = text.indexOf('\n---', 3);
  if (end < 0) return { meta: {}, body: text };
  const meta = {};
  for (const line of text.slice(4, end).split('\n')) {
    const match = line.match(/^([a-z_]+):\s*(.*)$/i);
    if (match) meta[match[1]] = match[2].trim();
  }
  return { meta, body: text.slice(end + 4).replace(/^\n+/, '') };
}

function excerptOf(body, queryTokens) {
  const paragraphs = String(body).split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  let best = paragraphs[0] || '';
  let bestScore = -1;
  for (const paragraph of paragraphs) {
    const lowered = paragraph.toLowerCase();
    let score = 0;
    for (const token of queryTokens) if (lowered.includes(token)) score += 1;
    if (score > bestScore) {
      bestScore = score;
      best = paragraph;
    }
  }
  const flat = best.replace(/\s+/g, ' ').trim();
  return flat.length > MAX_EXCERPT_CHARS ? `${flat.slice(0, MAX_EXCERPT_CHARS)}…` : flat;
}

async function walkPages(root) {
  const files = [];
  const visit = async (directory) => {
    if (files.length >= MAX_SCAN_FILES) return;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      if (files.length >= MAX_SCAN_FILES) return;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name.endsWith('.md')) files.push(path);
    }
  };
  await visit(root);
  return files;
}

export function createLocalMarkdownProvider({ fetchImpl } = {}) {
  void fetchImpl; // The local store never leaves the machine.
  return {
    id: LOCAL_MARKDOWN_ID,
    /** Always available: it is a directory, not a service. */
    available() {
      return { available: true, reason: null };
    },
    async count(config) {
      const files = await walkPages(localMemoryRoot(config));
      return files.length;
    },
    async remember({ text, tags = [], source = 'manual', visibility = 'public' }, config) {
      const value = String(text || '').trim();
      if (!value) throw providerError(PROVIDER_FAILED, '没有可写入的记忆内容。');
      if (value.length > MAX_TEXT_CHARS) throw providerError(PROVIDER_FAILED, `单条记忆不能超过 ${MAX_TEXT_CHARS} 字符。`);
      const root = localMemoryRoot(config);
      const now = new Date();
      const stamp = now.toISOString().replace(/[-:.]/g, '');
      const digest = createHash('sha256').update(`${stamp}:${value}`).digest('hex').slice(0, 8);
      const relative = join(String(now.getUTCFullYear()), String(now.getUTCMonth() + 1).padStart(2, '0'), `${stamp}-${digest}.md`);
      const file = join(root, relative);
      const front = [
        '---',
        `created: ${now.toISOString()}`,
        `source: ${String(source || 'manual').trim()}`,
        `tags: [${(Array.isArray(tags) ? tags : []).map((tag) => String(tag).trim()).filter(Boolean).join(', ')}]`,
        `visibility: ${visibility === 'private' ? 'private' : 'public'}`,
        '---',
        '',
        value,
        '',
      ].join('\n');
      await mkdir(join(root, relative, '..'), { recursive: true });
      const temporary = `${file}.${process.pid}.tmp`;
      await writeFile(temporary, front, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, file);
      return { id: relative.split('\\').join('/'), path: file };
    },
    async recall({ query, limit = 6 }, config) {
      const queryTokens = tokenize(query);
      if (!queryTokens.length) return { results: [], note: '查询里没有可检索的词。' };
      const wanted = Math.max(1, Math.min(MAX_LIMIT, Number(limit) || 6));
      const files = await walkPages(localMemoryRoot(config));
      const candidates = [];
      const documentFrequency = new Map();
      for (const file of files) {
        let info;
        try {
          info = await stat(file);
        } catch {
          continue;
        }
        if (info.size > MAX_FILE_BYTES) continue;
        let source;
        try {
          source = await readFile(file, 'utf8');
        } catch {
          continue;
        }
        const { meta, body } = splitPage(source);
        const counts = countTokens(tokenize(body));
        let hits = 0;
        for (const token of new Set(queryTokens)) {
          if (counts.has(token)) {
            hits += 1;
            documentFrequency.set(token, (documentFrequency.get(token) || 0) + 1);
          }
        }
        if (hits > 0) candidates.push({ file, meta, body, counts, hits });
      }
      const total = Math.max(1, candidates.length);
      const scored = candidates.map((candidate) => {
        let score = 0;
        for (const token of new Set(queryTokens)) {
          const tf = candidate.counts.get(token) || 0;
          if (!tf) continue;
          const df = documentFrequency.get(token) || 1;
          const idf = Math.log(1 + (total - df + 0.5) / (df + 0.5));
          score += idf * ((tf * (BM25_K1 + 1)) / (tf + BM25_K1));
        }
        return { ...candidate, score };
      }).sort((left, right) => right.score - left.score || right.hits - left.hits);

      return {
        results: scored.slice(0, wanted).map((candidate) => ({
          text: excerptOf(candidate.body, queryTokens),
          source: candidate.meta.source || 'local',
          score: Number(candidate.score.toFixed(4)),
          id: candidate.file.split('\\').join('/'),
          updatedAt: candidate.meta.created || null,
        })),
        ...(scored.length === 0 ? { note: '本地记忆里没有匹配项。' } : {}),
      };
    },
  };
}
