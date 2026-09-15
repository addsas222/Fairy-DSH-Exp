window.__ModuleLoader__.load({
  id: 'dsh-fairy-memory',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
    const React = require('react');
    const jsx = require('react/jsx-runtime');
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives');
    // 提问件取自 `fairy-contracts/client-ask-kit.cjs`（唯一真源）：外观、读写逻辑、
    // 状态文案都只那一份。构建时 `scripts/bundle.mjs` 把这份 require 内联进
    // `lib/client.js` —— 客户端 bundle 不能跨 bundle require 别的文件。
    const { createAskKit } = (() => {
  const module = { exports: {} };
// >>> fairy-contracts/client-ask-kit.cjs (inlined by scripts/bundle.mjs — 不要手改)
/**
 * 归一化"提问件"套件 —— 设置卡里向用户要输入的那些行。
 *
 * 为什么要它：六个包的设置卡原本各写一套 input/select/checkbox、
 * 各写一套加载/保存/状态/禁用逻辑，文案与行为都不一致（"已保存。"
 * vs "已保存，下一次…"、只有部分包处理只读会话）。这里收成一份：
 *
 *  - 外观：优先用官方冻结原语（`Input`/`Button`/`StateDot`），其余用官方
 *    设计令牌（`var(--dsw-alias-*)`），与官方设置面同色同尺。
 *  - 操作逻辑：一份 useAskForm 管住 draft → 保存 → 复读 → 状态文案，
 *    忙时禁用、只读会话停用、Enter 提交、不轮询。
 *
 * 契约：本文件是**唯一真源**。手写 bundle 的包由
 * `fairy-system/sync-ask-kit.js` 把 `createAskKit` 内联进 `lib/client.js`
 * 的标记区，`verify-build` 校验不漂移；有 `src/` 的包直接 require。
 *
 * @module dsh-fairy-contracts/client-ask-kit
 */

/** 归一化状态文案：全仓只此一份，改文案就改这里。 */
const ASK_TEXT = {
  loading: '正在读取…',
  saved: '已保存。',
  unchanged: '没有需要保存的改动。',
  saving: '保存中…',
  testing: '测试中…',
  save: '保存',
  test: '测试',
  readOnly: '当前会话不可写入主机设置，保存已停用。',
  saveFailed: (why) => `保存失败：${why}`,
};

/** 官方设计令牌（与设置面同一套变量，缺变量时回落到中性色）。 */
const ASK_STYLE = {
  root: { display: 'grid', gap: 12, padding: 16 },
  copy: { margin: 0, color: 'var(--dsw-alias-label-secondary, rgba(180,180,180,0.85))', fontSize: 12, lineHeight: '18px' },
  panel: {
    display: 'grid',
    gap: 10,
    padding: 12,
    borderRadius: 8,
    border: '1px solid var(--dsw-alias-border-l2, rgba(130,130,130,0.28))',
    background: 'var(--dsw-alias-bg-layer-2, rgba(130,130,130,0.09))',
  },
  row: { display: 'grid', gap: 4 },
  label: { fontSize: 12, color: 'var(--dsw-alias-label-secondary, rgba(180,180,180,0.85))' },
  input: {
    width: '100%',
    boxSizing: 'border-box',
    padding: '6px 8px',
    borderRadius: 6,
    border: '1px solid var(--dsw-alias-border-l2, rgba(130,130,130,0.28))',
    background: 'var(--dsw-alias-bg-layer-1, transparent)',
    color: 'var(--dsw-alias-label-primary, rgba(225,225,225,0.95))',
    fontSize: 13,
  },
  actions: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
  status: { margin: 0, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary, rgba(180,180,180,0.85))' },
  line: { display: 'flex', gap: 8, alignItems: 'center', fontSize: 12 },
  pre: {
    margin: 0,
    padding: 10,
    borderRadius: 6,
    overflowX: 'auto',
    background: 'var(--dsw-alias-bg-layer-2, rgba(0,0,0,0.24))',
    color: 'var(--dsw-alias-label-primary, rgba(225,225,225,0.95))',
    fontSize: 12,
    lineHeight: '18px',
  },
};

/** 错误文案：长栈与 HTML 不进界面。 */
function describeError(error) {
  const message = typeof error?.message === 'string' ? error.message : String(error);
  return message.length > 320 ? `${message.slice(0, 320)}…` : message;
}

/**
 * 造一套归一化提问件。
 *
 * @param spec - `{ React, jsx, jsxs, primitives }`：`primitives` 即
 *   `require('@deepseek-ai/dsh-client-ui-primitives')`，只认官方确实导出的
 *   那些名字（`Input`/`Button`/`StateDot`），其余留空则退化为同色令牌的原生件。
 * @returns 归一化组件与一份统一的读写逻辑。
 */
function createAskKit({ React, jsx, jsxs, primitives = {} }) {
  const { Input, Button, StateDot } = primitives;
  const { useState, useCallback, useEffect, useRef } = React;

  function AskSection({ title, description, ariaLabel, children }) {
    return jsxs('section', {
      style: ASK_STYLE.root,
      'aria-label': ariaLabel ?? title,
      children: [
        jsxs('div', { style: ASK_STYLE.row, children: [
          jsx('h2', { style: { margin: 0, fontSize: 14 }, children: title }),
          ...(description ?? []).map((line, index) => jsx('p', { style: ASK_STYLE.copy, children: line }, `${index}:${line}`)),
        ] }),
        children,
      ],
    });
  }

  /** 一行提问：标签 + 控件 + 可选补充说明。 */
  function AskRow({ id, label, hint, children }) {
    return jsxs('div', { style: ASK_STYLE.row, children: [
      jsx('label', { style: ASK_STYLE.label, htmlFor: id, children: label }),
      children,
      hint ? jsx('p', { style: ASK_STYLE.copy, children: hint }) : null,
    ] });
  }

  /**
   * 文本类提问（text/password/url/搜索框…）。官方 `Input` 有就用官方的，
   * 没有就退回同令牌的原生 input —— 两者的 class 与尺寸一致。
   */
  function AskText({ id, type = 'text', value, placeholder, disabled, onChange, autoComplete }) {
    const props = { id, type, value, placeholder, disabled, autoComplete };
    if (typeof Input === 'function') {
      return jsx(Input, { ...props, onChange: (event) => onChange(event.target.value) });
    }
    // data-ask 是归一化件的自证标记：渲染级测试据此区分套件自带的原生件与手搓件。
    return jsx('input', { 'data-ask': 'text', ...props, style: ASK_STYLE.input, onChange: (event) => onChange(event.target.value) });
  }

  /** 选择类提问：官方没有 Select 原语，用同令牌原生件保证一致。 */
  function AskSelect({ id, value, options, disabled, onChange }) {
    return jsx('select', {
      'data-ask': 'select',
      id,
      style: ASK_STYLE.input,
      value,
      disabled,
      onChange: (event) => onChange(event.target.value),
      children: (options ?? []).map((option) => jsx('option', { value: option.value, children: option.label }, option.value)),
    });
  }

  /** 开关类提问：一整行可点，标签在左，方块在右。 */
  function AskToggle({ id, label, checked, disabled, onChange, hint }) {
    return jsxs('div', { style: { ...ASK_STYLE.row, gap: 2 }, children: [
      jsxs('label', {
        style: { display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 },
        htmlFor: id,
        children: [
          jsx('input', { 'data-ask': 'toggle', id, type: 'checkbox', checked: checked === true, disabled, onChange: (event) => onChange(event.target.checked) }),
          jsx('span', { children: label }),
        ],
      }),
      hint ? jsx('p', { style: { ...ASK_STYLE.copy, marginLeft: 24 }, children: hint }) : null,
    ] });
  }

  /** 动作行：主按钮 + 次按钮 + 一行状态；忙时整体禁用。 */
  function AskActions({ busy, status, primary, secondary, onPrimary, onSecondary, writable = true }) {
    const locked = busy !== null || !writable;
    return jsxs('div', { style: ASK_STYLE.actions, children: [
      jsx(Button, {
        variant: 'primary',
        size: 'sm',
        disabled: locked,
        onClick: onPrimary,
        children: busy === 'save' ? ASK_TEXT.saving : primary ?? ASK_TEXT.save,
      }),
      secondary
        ? jsx(Button, { variant: 'outline', size: 'sm', disabled: locked, onClick: onSecondary, children: busy === 'test' ? ASK_TEXT.testing : secondary })
        : null,
      jsx('p', { style: ASK_STYLE.status, children: status }),
    ] });
  }

  /** 结果行：一处画点与文字，成功/失败同一套观感。 */
  function AskResult({ ok, text }) {
    if (!text) return null;
    return jsxs('div', { style: ASK_STYLE.line, children: [
      typeof StateDot === 'function' ? jsx(StateDot, { state: ok ? 'done' : 'error', size: 10 }) : null,
      jsx('span', { style: ok ? undefined : { color: 'var(--dsw-alias-label-error, #e06c6c)' }, children: text }),
    ] });
  }

  /**
   * 一份统一的读取/保存/测试逻辑。
   *
   * - `load()` 读当前值（通常是 GET 一个 state 端点）；`save(draft)` 落盘。
   * - 只有真改过的字段才写：草稿与已存值相等即视为"没有需要保存的改动"。
   * - `writable=false`（只读会话）时保存按钮停用并给出同一句说明。
   * - 不轮询：挂载读一次、保存后复读一次。
   *
   * @param options - `{ load, save, onSaved, initial }`。
   * @returns 归一化的表单状态机。
   */
  function useAskForm({ load, save, onSaved, initial = {} }) {
    const [stored, setStored] = useState(null);
    const [draft, setDraft] = useState(initial);
    const [error, setError] = useState(false);
    const [busy, setBusy] = useState(null);
    const [status, setStatus] = useState(ASK_TEXT.loading);
    const [reloadToken, setReloadToken] = useState(0);
    const alive = useRef(true);
    // load 走 ref：调用方常传内联函数，若进依赖会让每次渲染都重读一次。
    const loadRef = useRef(load);
    loadRef.current = load;

    useEffect(() => {
      alive.current = true;
      let cancelled = false;
      setStatus(ASK_TEXT.loading);
      Promise.resolve()
        .then(() => loadRef.current())
        .then((value) => { if (!cancelled) { setStored(value); setError(false); setStatus(''); } })
        .catch((cause) => { if (!cancelled) { setError(true); setStatus(readFailedText(cause)); } });
      return () => { cancelled = true; alive.current = false; };
    }, [reloadToken]);

    const change = useCallback((key, value) => {
      setDraft((current) => ({ ...current, [key]: value }));
      setStatus('');
    }, []);

    const submit = useCallback(async () => {
      setBusy('save');
      setStatus('');
      try {
        const outcome = await save(draft, stored);
        if (outcome?.changed === false) { setStatus(ASK_TEXT.unchanged); return outcome; }
        setDraft(initial);
        setStatus(ASK_TEXT.saved);
        setReloadToken((token) => token + 1);
        onSaved?.(outcome);
        return outcome;
      } catch (cause) {
        setStatus(ASK_TEXT.saveFailed(describeError(cause)));
        throw cause;
      } finally {
        setBusy(null);
      }
    }, [draft, stored, save, onSaved, initial]);

    /** 由调用方注入的额外动作（如"测试"）走同一条忙/错通道。 */
    const run = useCallback(async (kind, task) => {
      setBusy(kind);
      try { return await task(); } finally { setBusy(null); }
    }, []);

    return {
      stored, draft, change, submit, run, busy, status, error,
      readOnly: () => setStatus(ASK_TEXT.readOnly),
      reload: () => setReloadToken((token) => token + 1),
    };
  }

  return { ASK_TEXT, ASK_STYLE, AskSection, AskRow, AskText, AskSelect, AskToggle, AskActions, AskResult, useAskForm, describeError };
}

/** 读取失败的文案：不吐栈，只说明读不到。 */
function readFailedText(error) {
  return `暂时读不到设置（按已保存的值继续）：${describeError(error)}`;
}

module.exports = { createAskKit, ASK_TEXT, ASK_STYLE, describeError };
// <<< fairy-contracts/client-ask-kit.cjs
  return module.exports;
})();
    const { ASK_TEXT, ASK_STYLE, AskSection, AskRow, AskText, AskSelect, AskToggle, AskActions, AskResult, useAskForm, describeError } = createAskKit({
      React,
      jsx: jsx.jsx,
      jsxs: jsx.jsxs,
      primitives,
    });

    const createFairyDiagnostics = (() => {
      const module = { exports: {} };
// DSH_FAIRY_CLIENT_DIAGNOSTICS_BEGIN
const FAIRY_LOG_PREFIX = 'DSH_FAIRY_LOG';
const SENSITIVE_KEY = /authorization|credential|password|secret|token|api[_-]?key|cookie/i;

function sanitize(value, key = '', depth = 0) {
  if (SENSITIVE_KEY.test(key)) return '[redacted]';
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return value.length > 320 ? `${value.slice(0, 320)}…` : value;
  if (depth >= 2) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 12).map((item) => sanitize(item, '', depth + 1));
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 24).map(([name, item]) => [name, sanitize(item, name, depth + 1)]));
  return String(value);
}

function createFairyDiagnostics(moduleName, sink = console) {
  const recentErrors = new Map();
  const clock = () => typeof performance === 'object' && performance?.now ? performance.now() : Date.now();
  const emit = (level, operation, event, context = {}, error, durationMs) => {
    const normalizedError = error ? { name: String(error.name || 'Error'), code: error.code == null ? undefined : String(error.code), message: String(error.message || error).slice(0, 320) } : undefined;
    if (normalizedError) {
      const signature = `${operation}:${normalizedError.code || normalizedError.message}`;
      const now = Date.now();
      if (now - (recentErrors.get(signature) || 0) < 60_000) return null;
      recentErrors.set(signature, now);
    }
    const record = { schema: 1, timestamp: new Date().toISOString(), level, module: moduleName, operation, event, context: sanitize(context), ...(normalizedError ? { error: normalizedError } : {}), ...(Number.isFinite(durationMs) ? { duration_ms: Number(durationMs.toFixed(3)) } : {}) };
    const writer = level === 'error' ? sink.error : level === 'warn' ? sink.warn : sink.info || sink.log;
    writer.call(sink, `${FAIRY_LOG_PREFIX} ${JSON.stringify(record)}`);
    return record;
  };
  const start = () => clock();
  const metric = (operation, startedAt, context = {}, options = {}) => {
    const duration = clock() - startedAt;
    return duration < (options.thresholdMs || 0) ? null : emit('info', operation, 'metric', context, undefined, duration);
  };
  const guard = (operation, callback, context = {}) => {
    const startedAt = start();
    try {
      const result = callback();
      metric(operation, startedAt, { ...context, outcome: 'success' });
      return result;
    } catch (error) {
      emit('error', operation, 'failure', context, error);
      metric(operation, startedAt, { ...context, outcome: 'failure' });
      throw error;
    }
  };
  return { start, metric, guard, info: (operation, context) => emit('info', operation, 'event', context), warn: (operation, context, error) => emit('warn', operation, 'failure', context, error), error: (operation, error, context) => emit('error', operation, 'failure', context, error) };
}

module.exports = { FAIRY_LOG_PREFIX, createFairyDiagnostics };
// DSH_FAIRY_CLIENT_DIAGNOSTICS_END
      return module.exports.createFairyDiagnostics;
    })();
    const diagnostics = createFairyDiagnostics('dsh-fairy-memory');

    const STATE_PATH = '/fairy-memory/state';
    const CONFIG_PATH = '/fairy-memory/config';
    /** 候选记忆目录与安装请求：宿主只读清单，Agent 面负责执行安装。 */
    const CANDIDATES_PATH = '/fairy-memory/candidates';
    const INSTALL_PATH = '/fairy-memory/install';
    /** The host never echoes a stored secret: it sends this sentinel instead, and
     * writing the sentinel back means "keep the stored value", so saving with an
     * untouched key field never clears it. */
    const SECRET_SENTINEL = '***';
    /** The host publishes provider ids (`custom-http`) that differ from the
     * settings keys it stores them under (`customHttp`): the id is the dropdown
     * value and the state-route id, the key is the `providers` key on the wire. */
    const MEMORY_PROVIDERS = [
      {
        id: 'gbrain',
        key: 'gbrain',
        label: 'GBrain（本机 MCP 服务，主用）',
        fields: [
          { name: 'baseUrl', label: '服务地址（MCP 端点）', placeholder: 'http://127.0.0.1:8787/mcp' },
          { name: 'token', label: '访问令牌（可选）', secret: true },
          { name: 'surface', label: '接口面', placeholder: 'verbs' },
          { name: 'visibility', label: '可见性（可选）', placeholder: '留空用服务默认值' },
        ],
      },
      {
        id: 'mem0',
        key: 'mem0',
        label: 'Mem0（在线托管）',
        fields: [
          { name: 'baseUrl', label: '服务地址', placeholder: 'https://api.mem0.ai' },
          { name: 'apiKey', label: 'API Key', secret: true },
          { name: 'userId', label: '用户标识', placeholder: 'fairy' },
        ],
      },
      {
        id: 'custom-http',
        key: 'customHttp',
        label: '自定义 HTTP 服务',
        fields: [
          { name: 'url', label: '请求地址', placeholder: 'http://127.0.0.1:9300/recall' },
          { name: 'headersJson', label: '静态请求头 JSON', placeholder: '{}' },
          { name: 'queryPath', label: '结果数组路径', placeholder: 'results' },
          { name: 'textPath', label: '文本字段路径', placeholder: 'text' },
        ],
      },
      {
        id: 'local-markdown',
        key: 'localMarkdown',
        label: '本地 Markdown 目录',
        fields: [
          { name: 'directory', label: '目录', placeholder: '/Users/<you>/fairy-memory' },
        ],
      },
    ];
    // 提问行的外观一律用套件里的 `ASK_STYLE`，这里不再留一份同名副本。

    function providerOption(id) {
      return MEMORY_PROVIDERS.find((entry) => entry.id === id) || MEMORY_PROVIDERS[0];
    }

    function providerLabel(id) {
      return MEMORY_PROVIDERS.find((entry) => entry.id === id)?.label || String(id);
    }

    /** Seed one provider's inputs from the masked config, keyed by the provider's
     * settings key; a stored secret arrives as the sentinel, so it round-trips
     * unchanged unless the user retypes it. */
    function providerDraft(config, id) {
      const option = providerOption(id);
      const stored = config?.providers?.[option.key] || {};
      return Object.fromEntries(option.fields.map((field) => [field.name, typeof stored[field.name] === 'string' ? stored[field.name] : '']));
    }

    /** 草稿只装用户真改过的东西：没改的字段显示已存值（密钥是掩码哨兵）。 */
    const EMPTY_DRAFT = { provider: null, autoRecall: null, fields: {} };

    /**
     * 生效值：草稿优先，未改的字段回落到已存的掩码配置；提供方与自动回忆同理。
     * 渲染与保存共用这一份，免得"看到的"和"写下去的"各算一套。
     */
    function effective(config, draft) {
      const provider = MEMORY_PROVIDERS.some((entry) => entry.id === draft?.provider)
        ? draft.provider
        : (MEMORY_PROVIDERS.some((entry) => entry.id === config?.provider) ? config.provider : MEMORY_PROVIDERS[0].id);
      const option = providerOption(provider);
      const edited = draft?.fields?.[provider] || {};
      const values = providerDraft(config, provider);
      for (const field of option.fields) {
        if (typeof edited[field.name] === 'string') values[field.name] = edited[field.name];
      }
      return {
        provider,
        option,
        values,
        autoRecall: typeof draft?.autoRecall === 'boolean' ? draft.autoRecall : config?.autoRecall === true,
      };
    }

    function createMemoryClient(fetchImpl = fetch) {
      const request = (operation, url, options) => {
        const startedAt = diagnostics.start();
        return Promise.resolve().then(() => fetchImpl(url, options)).then((response) => {
          diagnostics.metric(operation, startedAt, { status: response.status }, { thresholdMs: 300 });
          return response;
        }, (error) => {
          if (error?.name !== 'AbortError') diagnostics.warn(operation, {}, error);
          diagnostics.metric(operation, startedAt, { outcome: 'failure' }, { thresholdMs: 300 });
          throw error;
        });
      };
      /** The host owns every failure message; its `{ error: { message } }` body is
       * the only thing the card shows, so no status is ever invented here. */
      const read = (operation, url, options, fallback) => request(operation, url, options).then(async (response) => {
        const value = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(value?.error?.message || `${fallback}（HTTP ${response.status}）`);
        return value;
      });
      return {
        config(signal) {
          return read('config.request', CONFIG_PATH, { cache: 'no-store', signal }, '无法读取长期记忆配置。');
        },
        state(signal) {
          return read('state.request', STATE_PATH, { cache: 'no-store', signal }, '无法读取长期记忆状态。');
        },
        save(payload) {
          return read('config.save.request', CONFIG_PATH, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), cache: 'no-store',
          }, '保存长期记忆配置失败。');
        },
        candidates(signal) {
          return read('candidates.request', CANDIDATES_PATH, { cache: 'no-store', signal }, '无法读取候选记忆清单。');
        },
        install(id) {
          return read('install.request', INSTALL_PATH, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }), cache: 'no-store',
          }, '写入安装请求失败。');
        },
      };
    }

    const memoryClient = createMemoryClient();

    function MemorySection() {
      const [availability, setAvailability] = React.useState(null);
      const [probeError, setProbeError] = React.useState('');
      const [catalog, setCatalog] = React.useState(null);
      const [catalogError, setCatalogError] = React.useState('');
      const [candidateId, setCandidateId] = React.useState('');
      const [installBusy, setInstallBusy] = React.useState(false);
      const [installNote, setInstallNote] = React.useState(null);

      // 读取/保存/忙/状态只在 useAskForm 里：挂载读一次、保存成功后复读一次、不轮询。
      const form = useAskForm({
        initial: EMPTY_DRAFT,
        load: () => memoryClient.config(),
        save: async (draft, stored) => {
          const next = effective(stored, draft);
          // 只有真改过的字段才写盘：草稿与已存的掩码值逐项相等就是没有改动。
          const kept = effective(stored, EMPTY_DRAFT);
          const changed = next.provider !== kept.provider
            || next.autoRecall !== kept.autoRecall
            || Object.entries(next.values).some(([name, value]) => value !== kept.values[name]);
          if (!changed) return { changed: false };
          try {
            // 复读交给 useAskForm：保存成功后它重跑 load，主机在那里重新掩码密钥。
            // POST 的响应不参与界面，界面只认复读回来的值。
            await memoryClient.save({
              provider: next.provider,
              autoRecall: next.autoRecall,
              providers: { [next.option.key]: next.values },
            });
          } catch (saveError) {
            diagnostics.warn('config.save', { provider: next.provider }, saveError);
            throw saveError;
          }
          return { changed: true };
        },
      });

      /** 可用性探测是另一条路由：失败只影响这一块，不动已经读到的配置。 */
      const probeAvailability = async () => {
        try {
          setAvailability(await memoryClient.state());
          setProbeError('');
        } catch (probeFailure) {
          setAvailability(null);
          setProbeError(describeError(probeFailure));
        }
      };

      // ponytail: availability follows the settings read — once when it lands and
      // once after every re-read (a save), never on a timer. 读取失败也探一次，
      // 否则这一块会一直停在"正在读取"。
      React.useEffect(() => {
        if (form.stored === null && !form.error) return;
        probeAvailability();
      }, [form.stored, form.error]);

      /** 候选清单是只读目录：挂载读一次，写/清安装请求后再读一次。 */
      const loadCatalog = async () => {
        try {
          setCatalog(await memoryClient.candidates());
          setCatalogError('');
        } catch (catalogFailure) {
          setCatalog(null);
          setCatalogError(describeError(catalogFailure));
        }
      };

      React.useEffect(() => {
        loadCatalog();
      }, []);

      const submit = () => {
        // useAskForm 已经把失败原因写进 status，这里只吞掉它有意抛出的 rejection。
        form.submit().catch(() => {});
      };

      // A provider switch keeps the other providers' edits: the drafts are keyed
      // by provider id, not by the current selection.
      const updateField = (owner, name, value) => form.change('fields', {
        ...(form.draft.fields || {}),
        [owner]: { ...((form.draft.fields || {})[owner] || {}), [name]: value },
      });

      /** 候选目录的三个派生值：渲染用，pending 决定按钮是"安装"还是"取消"。 */
      const candidates = Array.isArray(catalog?.candidates) ? catalog.candidates : [];
      const pendingId = typeof catalog?.installRequest === 'string' ? catalog.installRequest : '';
      const selected = candidates.find((entry) => entry.id === (candidateId || pendingId)) || null;
      const candidateName = (id) => candidates.find((entry) => entry.id === id)?.name || String(id);

      /** 写/清安装请求；写完后复读清单，pending 状态立刻可见。
       *  成功/失败分开标记：失败也走套件结果行的错误样式，不冒充成功。 */
      const requestInstall = async (id) => {
        setInstallBusy(true);
        try {
          await memoryClient.install(id);
          setCandidateId('');
          // 安装成功不需要再报一遍：复读后的待办行就是回执；清除后没有别的回执，才留一句。
          setInstallNote(id ? null : { ok: true, text: '已清除安装请求。' });
          await loadCatalog();
        } catch (installFailure) {
          setInstallNote({ ok: false, text: describeError(installFailure) });
        } finally {
          setInstallBusy(false);
        }
      };

      const { provider, option, values, autoRecall } = effective(form.stored, form.draft);
      const availabilityRows = Array.isArray(availability?.providers) ? availability.providers : [];
      const activeId = MEMORY_PROVIDERS.some((entry) => entry.id === availability?.provider) ? availability.provider : provider;
      // Only the local markdown provider reports a count, and it arrives as
      // `null` elsewhere. `Number(null)` is 0, so the type check comes first.
      const count = typeof availability?.count === 'number' && Number.isFinite(availability.count) ? availability.count : null;
      const countLine = count === null ? '已存记忆：未知' : `已存记忆：${count} 条`;
      return jsx.jsxs(AskSection, {
        title: '长期记忆',
        ariaLabel: '长期记忆设置',
        description: [
          'Fairy 的长期记忆默认由本机 GBrain 服务承担，也可以改指向 Mem0、任意 HTTP 服务或本地 Markdown 目录。切换后对下一次回忆或记录生效，无需重启。',
          '密钥只保存在本机设置文件中，页面不会回显已保存的值。',
        ],
        children: [
          jsx.jsxs('div', { style: ASK_STYLE.panel, children: [
            jsx.jsx(AskRow, {
              id: 'fairy-memory-provider',
              label: '提供方',
              children: jsx.jsx(AskSelect, {
                id: 'fairy-memory-provider',
                value: provider,
                options: MEMORY_PROVIDERS.map((entry) => ({ value: entry.id, label: entry.label })),
                disabled: form.busy !== null,
                onChange: (id) => form.change('provider', id),
              }),
            }),
            ...option.fields.map((field) => jsx.jsx(AskRow, {
              id: `fairy-memory-${option.id}-${field.name}`,
              label: field.label,
              children: jsx.jsx(AskText, {
                id: `fairy-memory-${option.id}-${field.name}`,
                type: field.secret ? 'password' : 'text',
                autoComplete: field.secret ? 'new-password' : 'off',
                value: values[field.name],
                placeholder: field.secret && values[field.name] === SECRET_SENTINEL ? '已保存，输入新值以替换' : field.placeholder || '',
                disabled: form.busy !== null,
                onChange: (value) => updateField(provider, field.name, value),
              }),
            }, field.name)),
            jsx.jsx(AskToggle, {
              id: 'fairy-memory-auto-recall',
              label: '每次回答前自动回忆',
              hint: '关闭时只在明确要求时回忆；开启后模型每轮先检索长期记忆。',
              checked: autoRecall,
              disabled: form.busy !== null,
              onChange: (checked) => form.change('autoRecall', checked),
            }),
            probeError
              ? jsx.jsx(AskResult, { ok: false, text: probeError }, 'availability-error')
              : availabilityRows.length === 0
                ? jsx.jsx('p', { style: ASK_STYLE.status, children: availability === null ? ASK_TEXT.loading : '宿主未报告任何提供方。' }, 'availability-empty')
                : availabilityRows.map((entry) => jsx.jsx(AskResult, {
                  ok: entry?.available === true,
                  text: `${providerLabel(entry?.id)}：${entry?.available === true ? '可用' : `不可用 · ${entry?.reason || '未说明原因'}`}`,
                }, `availability-${entry?.id ?? 'unknown'}`)),
            jsx.jsx(AskResult, {
              ok: availability?.available === true,
              text: `当前提供方：${providerLabel(activeId)} · ${availability?.available === true ? '可用' : `不可用 · ${availability?.reason || '未检查'}`}`,
            }, 'active-provider'),
            jsx.jsx('p', { style: ASK_STYLE.status, 'data-dsh-fairy-memory-count': 'true', children: countLine }),
            jsx.jsx('p', { style: ASK_STYLE.status, children: '候选记忆（外部生态，已审核；由 Agent 按请求安装）' }, 'candidates-title'),
            catalogError
              ? jsx.jsx(AskResult, { ok: false, text: catalogError }, 'catalog-error')
              : candidates.length === 0
                ? jsx.jsx('p', { style: ASK_STYLE.status, children: catalog === null ? ASK_TEXT.loading : '候选清单为空。' }, 'candidates-empty')
                : jsx.jsx(AskRow, {
                  id: 'fairy-memory-candidate',
                  label: '选择候选',
                  children: jsx.jsx(AskSelect, {
                    id: 'fairy-memory-candidate',
                    value: selected?.id || '',
                    options: [{ value: '', label: '（不选择）' }, ...candidates.map((entry) => ({ value: entry.id, label: `${entry.name} · ${entry.kind} · ${entry.stars}★ · ${entry.license}` }))],
                    disabled: form.busy !== null || installBusy,
                    onChange: (id) => { setCandidateId(id); setInstallNote(null); },
                  }),
                }),
            selected ? jsx.jsxs(AskRow, {
              id: 'fairy-memory-candidate-detail',
              label: '候选详情',
              children: [
                jsx.jsx('p', { style: ASK_STYLE.status, children: `${selected.summary}（${selected.language} · 最近推送 ${selected.lastPush}）` }),
                jsx.jsx('p', { style: ASK_STYLE.status, children: `安装：${selected.install}` }),
                selected.caveats ? jsx.jsx('p', { style: ASK_STYLE.status, children: `注意：${selected.caveats}` }) : null,
              ],
            }) : null,
            pendingId ? jsx.jsx(AskResult, { ok: true, text: `已请求安装：${candidateName(pendingId)}（等待 Agent 执行）` }, 'install-pending') : null,
            installNote ? jsx.jsx(AskResult, { ok: installNote.ok, text: installNote.text }, 'install-note') : null,
            (candidates.length > 0 || pendingId) ? jsx.jsx(AskActions, {
              busy: installBusy ? 'install' : null,
              status: '',
              primary: pendingId && selected?.id === pendingId ? '取消安装请求' : '让 Agent 安装',
              onPrimary: () => requestInstall(pendingId && selected?.id === pendingId ? '' : (selected?.id || '')),
              writable: Boolean(selected) || Boolean(pendingId),
            }) : null,
            jsx.jsx(AskActions, {
              busy: form.busy,
              status: form.status,
              primary: ASK_TEXT.save,
              secondary: '刷新可用性',
              onPrimary: submit,
              onSecondary: () => form.run('probe', probeAvailability),
            }),
          ] }),
        ],
      });
    }

    function injectMemorySlot(ctx, definition, component) {
      let disposeRegistration = null;
      const releaseRegistration = () => {
        const dispose = disposeRegistration;
        disposeRegistration = null;
        dispose?.();
      };
      return ctx.slots.inject('settings.section', () => {
        // The provider may be re-invoked when the official node is replaced or
        // the bundle reloads; release the prior registration before replacing it.
        releaseRegistration();
        const registration = ctx.slots.register({ name: 'settings.section', ...definition }, component);
        disposeRegistration = typeof registration === 'function' ? registration : null;
        return releaseRegistration;
      });
    }

    function apply(ctx) {
      return diagnostics.guard('apply', () => {
        const disposeSlot = injectMemorySlot(ctx, { id: 'fairy-memory', order: 33, label: () => '长期记忆' }, MemorySection);
        if (typeof disposeSlot === 'function') ctx.effect(() => disposeSlot, 'dsh-fairy-memory settings section');
      }, { surface: 'client' });
    }

    return { apply, inject: ['slots'], name: 'dsh-fairy-memory' };
  },
});
