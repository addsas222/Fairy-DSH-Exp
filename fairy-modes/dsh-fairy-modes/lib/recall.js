/**
 * `session_recall`: the tool create mode is built on.
 *
 * The harness ships `@deepseek-ai/dsh-session-query` (the engine, `ctx.sessionQuery`)
 * but, in this distribution, no tool row over it — so recall is this package's
 * job, and this tool is the whole of it. It is registered in every mode (the
 * request tool catalog must not move when the mode does); the `fairy:mode-create`
 * prompt section is what tells the model to reach for it first.
 *
 * The definition is a raw `ToolDefinition` — plain JSON Schema plus `execute` and
 * `render` — because `ctx.tools.register()` takes exactly that, and importing the
 * harness's `defineTool` would bind this package to a private peer-dependency
 * tree (see README). The two things that helper adds are inline here: the
 * argument check the registry does not perform, and JSON Schemas written in the
 * subset the registry asserts.
 *
 * Three read paths, in order:
 * 1. `searchSessions` — the backend's cross-session full-text index, ranked, with
 *    an excerpt per hit. Absent unless a session-query backend is composed.
 * 2. The same call, when the backend refuses it with
 *    `SESSION_QUERY_SEARCH_DISABLED` (`openAt: 'never'`): the deployment is
 *    recall-degraded, so the result says exactly how to fix it.
 * 3. Title scan — `listSessions` + `readTitleSnapshots` need no index at all, so
 *    recall still answers when the index is off, bounded and title-only.
 *
 * @module dsh-fairy-modes/recall
 */

/** Model-facing tool name. */
export const RECALL_TOOL_NAME = 'session_recall';

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 10;
/* Title folding reads one log per session; the corpus we fold is bounded so a
 * degraded deployment cannot turn one recall into hundreds of reads. */
const SCAN_SESSION_LIMIT = 200;
/** Recall is a read; a slow backend must not hold the turn open longer. */
const RECALL_TIMEOUT_MS = 30_000;

const INDEX_DISABLED_NOTE = '会话全文索引未打开（session-query-sqlite 的 openAt 为 "never"），本次只按标题匹配。'
  + '把 profiles/web/cordis.patch.yml 里 session-query-sqlite.openAt 设为 first-search 即可恢复全文回忆。';
const INDEX_ABSENT_NOTE = '本部署未组合会话检索后端，本次只按标题匹配。';
const NO_MATCH_NOTE = '没有匹配的历史记录；换更具体的词，或确认那些会话的日志仍在本机。';

const QUERY_DESCRIPTION = '要查找的字面文本（大小写不敏感；按数据处理，不作为检索语法）。';
const LIMIT_DESCRIPTION = `最多返回多少个会话（1-${MAX_LIMIT}，默认 ${DEFAULT_LIMIT}）。`;

function clampLimit(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.trunc(value)));
}

/**
 * Reject malformed model arguments. The registry dispatches whatever the model
 * sent straight to `execute`, so a typed tool's argument check is its own. The
 * messages are the registry's own schema-walk wording (`validateArgs` over the
 * same parameters schema), so a call rejected here reads exactly like a call
 * rejected by any built-in typed tool.
 *
 * @param args - arguments as received.
 * @returns One message per violation, empty when the call is well-formed.
 */
function violationsOf(args) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return ['"arguments" must be an object'];
  }
  const violations = [];
  if (!Object.hasOwn(args, 'query')) violations.push('missing required property "query"');
  else if (typeof args.query !== 'string') violations.push('"query" must be a string');
  if (args.limit !== undefined) {
    if (typeof args.limit !== 'number') violations.push('"limit" must be a number');
    else if (!Number.isFinite(args.limit)) violations.push('"limit" must be a finite JSON number');
  }
  return violations;
}

/**
 * Fold the latest title for each id, tolerating an engine without the batch
 * reader and per-session failures (a title is decoration on a recall hit).
 *
 * @param sessionQuery - the session-query engine.
 * @param ids - session ids to fold.
 * @param signal - caller cancellation.
 * @returns sessionId → `{ title, updatedAt }` for the sessions that have a title.
 */
async function readTitles(sessionQuery, ids, signal) {
  const folded = new Map();
  const read = typeof sessionQuery?.readTitleSnapshots === 'function' ? sessionQuery.readTitleSnapshots : undefined;
  if (ids.length === 0 || read === undefined) return folded;
  let observations;
  try {
    observations = await read.call(sessionQuery, ids, signal);
  } catch {
    // Titles are presentation; an engine refusal must not fail the recall.
    return folded;
  }
  for (const entry of Array.isArray(observations) ? observations : []) {
    if (entry?.status !== 'fulfilled') continue;
    const snapshot = entry.value?.title;
    if (snapshot === undefined || typeof snapshot.title !== 'string' || snapshot.title === '') continue;
    folded.set(entry.sessionId, {
      title: snapshot.title,
      ...(Number.isFinite(snapshot.updatedAt) ? { updatedAt: snapshot.updatedAt } : {}),
    });
  }
  return folded;
}

/** The session id of one search hit: the record's header owns it, the match mirrors it. */
function hitSessionId(hit) {
  const id = hit?.header?.id ?? hit?.bestMatch?.sessionId;
  return typeof id === 'string' && id !== '' ? id : undefined;
}

/** Project one indexed page into the tool's result rows. */
async function projectPage(page, limit, sessionQuery, signal) {
  const rows = Array.isArray(page?.items) ? page.items : [];
  // A hit with no resolvable id is not a session the model can act on.
  const items = rows.slice(0, limit)
    .map(hit => ({ hit, sessionId: hitSessionId(hit) }))
    .filter(entry => entry.sessionId !== undefined);
  const folded = await readTitles(sessionQuery, items.map(entry => entry.sessionId), signal);
  const results = items.map(({ hit, sessionId }) => {
    const title = folded.get(sessionId);
    const snippet = typeof hit.bestMatch?.snippet === 'string' ? hit.bestMatch.snippet.trim() : '';
    return {
      sessionId,
      ...(title === undefined ? {} : { title: title.title }),
      ...(Number.isFinite(hit.bestMatch?.seq) ? { seq: hit.bestMatch.seq } : {}),
      snippet: snippet === '' ? '(该事件没有可提取文本)' : snippet,
      ...(title?.updatedAt === undefined ? {} : { updatedAt: title.updatedAt }),
    };
  });
  return {
    results,
    truncated: page?.nextCursor !== undefined || rows.length > items.length,
    ...(results.length === 0 ? { note: NO_MATCH_NOTE } : {}),
  };
}

/** Index-free recall: newest-first titles matched by the query's tokens. */
async function scanTitles(sessionQuery, query, limit, note, signal) {
  const list = typeof sessionQuery?.listSessions === 'function' ? sessionQuery.listSessions : undefined;
  if (list === undefined) {
    return { results: [], truncated: false, note: `${note}（本部署也没有可用的会话列表接口。）` };
  }
  const records = await list.call(sessionQuery, signal);
  const rows = (Array.isArray(records) ? records : []).slice(0, SCAN_SESSION_LIMIT);
  const folded = await readTitles(sessionQuery, rows.map(row => row.header.id), signal);
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  const matched = [];
  for (const row of rows) {
    const sessionId = String(row.header.id);
    const title = folded.get(sessionId);
    if (title === undefined) continue;
    const haystack = title.title.toLowerCase();
    if (!tokens.every(token => haystack.includes(token))) continue;
    matched.push({
      sessionId,
      title: title.title,
      snippet: title.title,
      ...(title.updatedAt === undefined ? {} : { updatedAt: title.updatedAt }),
    });
  }
  const results = matched.slice(0, limit);
  return {
    results,
    truncated: matched.length > results.length,
    note: results.length === 0 ? `${note}（标题里也没有匹配的词。）` : note,
  };
}

async function recall(sessionQuery, args, signal) {
  const query = typeof args?.query === 'string' ? args.query.trim() : '';
  if (query === '') throw new Error(`${RECALL_TOOL_NAME} 需要一个非空的 query。`);
  const limit = clampLimit(args?.limit);
  const search = typeof sessionQuery?.searchSessions === 'function' ? sessionQuery.searchSessions : undefined;
  if (search === undefined) return scanTitles(sessionQuery, query, limit, INDEX_ABSENT_NOTE, signal);
  try {
    const page = await search.call(sessionQuery, { query, limit }, { signal });
    return await projectPage(page, limit, sessionQuery, signal);
  } catch (error) {
    if (error?.code !== 'SESSION_QUERY_SEARCH_DISABLED') throw error;
    return scanTitles(sessionQuery, query, limit, INDEX_DISABLED_NOTE, signal);
  }
}

/** What the model reads: one bullet per hit, then the caveats. */
function renderRecall(value) {
  const lines = value.results.map((hit) => {
    const title = hit.title === undefined ? '' : `[${hit.title}] `;
    const seq = hit.seq === undefined ? '' : `seq ${hit.seq}: `;
    return `• ${title}(${hit.sessionId}) ${seq}${hit.snippet}`;
  });
  if (lines.length === 0) lines.push('（没有匹配的历史记录）');
  if (value.truncated) lines.push('（已截断：只显示最相关的前若干条；收窄 query 或调大 limit。）');
  if (typeof value.note === 'string' && value.note !== '') lines.push(`注：${value.note}`);
  return lines.join('\n');
}

/**
 * Build the `session_recall` definition bound to one session-query engine.
 *
 * @param sessionQuery - `ctx.sessionQuery` of the composed deployment.
 * @returns A registry-ready tool definition (raw `ToolDefinition`, plain JSON Schema).
 */
export function createSessionRecallTool(sessionQuery) {
  return {
    name: RECALL_TOOL_NAME,
    description: 'Recall what this project already did: full-text search across this deployment\'s '
      + 'past sessions (every conversation held in this project). Returns the strongest matching event '
      + 'per session, with an excerpt. Use it before answering what was decided, built, tried, or left '
      + 'unfinished earlier — and first thing in create mode.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: QUERY_DESCRIPTION },
        limit: { type: 'number', description: LIMIT_DESCRIPTION },
      },
      required: ['query'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          results: {
            type: 'array',
            description: '每个会话一条：最强匹配事件及其摘录。',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                sessionId: { type: 'string' },
                title: { type: 'string' },
                seq: { type: 'integer' },
                snippet: { type: 'string' },
                updatedAt: { type: 'integer' },
              },
              required: ['sessionId', 'snippet'],
            },
          },
          truncated: { type: 'boolean' },
          note: { type: 'string' },
        },
        required: ['results', 'truncated'],
      },
      render: (_args, value) => [{ type: 'text', text: renderRecall(value) }],
    },
    timeoutMs: RECALL_TIMEOUT_MS,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const violations = violationsOf(args);
      if (violations.length > 0) {
        const error = new Error(`invalid arguments: ${violations.join('; ')}`);
        error.code = 'INVALID_ARGS';
        throw error;
      }
      return recall(sessionQuery, args, exec?.signal);
    },
  };
}
