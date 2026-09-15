window.__ModuleLoader__.load({
  id: 'dsh-fairy-search',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
    // >>> fairy-ask-kit (generated from fairy-contracts/client-ask-kit.cjs — 不要手改，跑 node fairy-system/sync-ask-kit.js)
const fairyAskKit = (() => {
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

  return { createAskKit, ASK_TEXT, ASK_STYLE, describeError };
})();

const { createAskKit, ASK_TEXT, ASK_STYLE, describeError } = fairyAskKit;
// <<< fairy-ask-kit


    const React = require('react');
    const jsx = require('react/jsx-runtime');
    const { Button, Input, StateDot } = require('@deepseek-ai/dsh-client-ui-primitives');
    // 提问件取自标记区里的唯一真源：外观、读写逻辑、文案都只那一份。
    // 标记区已把 ASK_TEXT/ASK_STYLE 声明在本作用域；组件名不能再声明（会撞名），
    // 所以造一个套件实例、按成员取用。
    const askKit = fairyAskKit.createAskKit({
      React,
      jsx: jsx.jsx,
      jsxs: jsx.jsxs,
      primitives: { Input, Button, StateDot },
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
    const diagnostics = createFairyDiagnostics('dsh-fairy-search');

    const SETTINGS_NAMESPACE = 'fairy-search';
    const STATE_PATH = '/fairy-search/state';
    const TEST_PATH = '/fairy-search/test';
    // The host gives one probe 15s; the browser waits slightly longer so the
    // host's own timeout (and its message) wins the race.
    const TEST_TIMEOUT_MS = 20_000;
    const DEFAULT_PROVIDER = 'deepseek-official';
    const PROVIDERS = [
      { id: 'deepseek-official', label: '官方 DeepSeek' },
      { id: 'exa', label: 'Exa' },
      { id: 'perplexity', label: 'Perplexity' },
      { id: 'custom', label: '自定义（OpenAI 兼容）' },
    ];
    const PROVIDER_OPTIONS = PROVIDERS.map((entry) => ({ value: entry.id, label: entry.label }));
    const CONFIGURED_KEYS = ['deepseek', 'exa', 'perplexity', 'custom'];
    const EMPTY_DRAFTS = { deepseekKey: '', exaKey: '', perplexityKey: '', customKey: '', customBaseURL: null };
    const MCP_SNIPPET = [
      "# 追加到 profiles/web/cordis.patch.yml 的顶层数组（loader 级配置，需重启 dsh 生效）：",
      '- insert:',
      '    - id: mcp-context7',
      "      name: '@deepseek-ai/dsh-mcp-client'",
      '      config:',
      '        serverName: context7',
      '        transport: stdio',
      '        command: npx',
      "        args: ['-y', '@upstash/context7-mcp']",
      '',
      '    - id: mcp-tavily',
      "      name: '@deepseek-ai/dsh-mcp-client'",
      '      config:',
      '        serverName: tavily',
      '        transport: stdio',
      '        command: npx',
      "        args: ['-y', 'tavily-mcp']",
      '        env:',
      "          TAVILY_API_KEY: 'tvly-...'",
    ].join('\n');

    function providerLabel(id) {
      return PROVIDERS.find((entry) => entry.id === id)?.label || id;
    }

    function useSettingsSnapshot(scope) {
      // 官方 scope 是类实例，subscribe/getSnapshot 读 `this`：必须按接收者调用。
      return React.useSyncExternalStore(
        (listener) => scope.subscribe(listener),
        () => scope.getSnapshot(),
        () => scope.getSnapshot(),
      );
    }

    // 提问行本身的观感在 ASK_STYLE 里；这里只留本卡自己的两处。
    const styles = {
      engine: { display: 'flex', gap: 8, alignItems: 'center', fontSize: 12 },
      pre: { margin: 0, padding: 10, borderRadius: 6, overflowX: 'auto', background: 'var(--dsw-alias-bg-layer-2, rgba(0,0,0,0.24))', color: 'var(--dsw-alias-label-primary, rgba(225,225,225,0.95))', fontSize: 12, lineHeight: '18px' },
    };

    function EngineState({ id, configured, selected }) {
      const state = configured ? 'done' : selected ? 'warning' : 'idle';
      return jsx.jsxs('div', {
        style: styles.engine,
        children: [
          jsx.jsx(StateDot, { state, size: 10 }),
          jsx.jsx('span', { children: `${providerLabel(id)}：${configured ? '已配置' : '未配置'}` }),
        ],
      });
    }

    function SettingsSection({ scope }) {
      const snapshot = useSettingsSnapshot(scope);
      const settings = snapshot?.value || {};
      const provider = PROVIDERS.some((entry) => entry.id === settings.provider) ? settings.provider : DEFAULT_PROVIDER;
      const customBaseURL = typeof settings.custom?.baseURL === 'string' ? settings.custom.baseURL : '';
      const writable = snapshot?.writable === true;
      const [switchError, setSwitchError] = React.useState('');
      const [probe, setProbe] = React.useState(null);

      // 读取/保存/忙/状态只在 useAskForm 里：挂载读一次、保存成功后复读一次、不轮询。
      const form = askKit.useAskForm({
        initial: EMPTY_DRAFTS,
        load: async () => {
          const startedAt = diagnostics.start();
          try {
            const response = await fetch(STATE_PATH, { headers: { accept: 'application/json' } });
            if (!response.ok) throw new Error(`状态接口返回 HTTP ${response.status}`);
            return await response.json();
          } catch (error) {
            diagnostics.warn('settings.state', {}, error);
            throw error;
          } finally {
            diagnostics.metric('settings.state', startedAt, {}, { thresholdMs: 300 });
          }
        },
        // Only fields the user actually typed are written: an empty input never
        // clears a stored secret, and keys are never read back into the form.
        save: async (drafts) => {
          const ops = [];
          if (drafts.deepseekKey.trim()) ops.push({ op: 'set', path: ['deepseek', 'apiKey'], value: drafts.deepseekKey.trim() });
          if (drafts.exaKey.trim()) ops.push({ op: 'set', path: ['exa', 'apiKey'], value: drafts.exaKey.trim() });
          if (drafts.perplexityKey.trim()) ops.push({ op: 'set', path: ['perplexity', 'apiKey'], value: drafts.perplexityKey.trim() });
          if (drafts.customKey.trim()) ops.push({ op: 'set', path: ['custom', 'apiKey'], value: drafts.customKey.trim() });
          if (drafts.customBaseURL !== null && drafts.customBaseURL.trim() !== customBaseURL) ops.push({ op: 'set', path: ['custom', 'baseURL'], value: drafts.customBaseURL.trim() });
          if (ops.length === 0) return { changed: false };
          try {
            await scope.mutate(ops);
          } catch (error) {
            diagnostics.warn('settings.save', { fields: ops.length }, error);
            throw error;
          }
          return { changed: true };
        },
      });

      const configured = form.stored?.configured || {};
      // `null` = untouched: the field mirrors the stored value until edited.
      const customBaseURLDraft = form.draft.customBaseURL === null ? customBaseURL : form.draft.customBaseURL;
      // 只读会话不能用 `form.readOnly()`：读取完成后的 `setStatus('')` 会盖掉那句话。
      const status = writable ? switchError || form.status : ASK_TEXT.readOnly;

      /** 换引擎是即时写入、不进草稿；失败借同一条 `ASK_TEXT.saveFailed` 文案。 */
      const selectProvider = (next) => {
        setSwitchError('');
        Promise.resolve(scope.set('provider', next)).catch((error) => {
          diagnostics.warn('settings.provider', { provider: next }, error);
          setSwitchError(ASK_TEXT.saveFailed(describeError(error)));
        });
      };

      const submit = () => {
        setSwitchError('');
        // useAskForm 已经把失败原因写进 status，这里只吞掉它有意抛出的 rejection。
        form.submit().catch(() => {});
      };

      const runTest = () => form.run('test', async () => {
        setProbe(null);
        const controller = new AbortController();
        const timer = window.setTimeout(() => controller.abort('timeout'), TEST_TIMEOUT_MS);
        const startedAt = diagnostics.start();
        try {
          const response = await fetch(TEST_PATH, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ provider }),
            signal: controller.signal,
          });
          const value = await response.json().catch(() => null);
          if (value?.ok === true) {
            const count = Array.isArray(value.sources) ? value.sources.length : 0;
            setProbe({ ok: true, text: `✓ ${providerLabel(provider)} 可用 · ${value.latencyMs} ms · ${count} 条来源` });
          } else {
            setProbe({ ok: false, text: `✗ ${value?.error || `测试失败（HTTP ${response.status}）`}` });
          }
        } catch (error) {
          setProbe({ ok: false, text: controller.signal.aborted ? '✗ 测试请求超时。' : `✗ ${describeError(error)}` });
        } finally {
          window.clearTimeout(timer);
          diagnostics.metric('settings.test', startedAt, { provider }, { thresholdMs: 1_000 });
        }
      });

      return jsx.jsxs(askKit.AskSection, {
        title: '搜索引擎',
        ariaLabel: '搜索引擎设置',
        description: [
          'Fairy 的联网搜索由这里的引擎提供，模型看到的仍是官方 web_search 工具卡片。切换后对下一次搜索生效，无需重启。',
          '密钥只写在本机设置文件里，页面不会回显。',
        ],
        children: [
          jsx.jsxs('div', { style: ASK_STYLE.panel, children: [
            jsx.jsx(askKit.AskRow, {
              id: 'fairy-search-provider',
              label: '搜索引擎',
              children: jsx.jsx(askKit.AskSelect, {
                id: 'fairy-search-provider',
                value: provider,
                options: PROVIDER_OPTIONS,
                disabled: !writable || form.busy !== null,
                onChange: selectProvider,
              }),
            }),
            CONFIGURED_KEYS.map((id) => jsx.jsx(EngineState, {
              id,
              configured: configured[id] === true,
              selected: provider === id || (id === 'deepseek' && provider === 'deepseek-official'),
            }, id)),
            // 宿主实际生效的引擎：信息行，不是状态文案（宿主值读到之前不声明）。
            form.stored ? jsx.jsx('p', { style: ASK_STYLE.copy, children: `当前生效：${providerLabel(form.stored.provider || provider)}。` }) : null,
            jsx.jsx(askKit.AskRow, {
              id: 'fairy-search-deepseek-key',
              label: '官方 DeepSeek：环境变量 DEEPSEEK_API_KEY，或在此覆盖',
              children: jsx.jsx(askKit.AskText, {
                id: 'fairy-search-deepseek-key',
                type: 'password',
                autoComplete: 'new-password',
                placeholder: configured.deepseek === true ? '已配置，输入新值以替换' : 'sk-...',
                value: form.draft.deepseekKey,
                disabled: !writable,
                onChange: (value) => form.change('deepseekKey', value),
              }),
            }),
            jsx.jsx(askKit.AskRow, {
              id: 'fairy-search-exa-key',
              label: 'Exa API Key',
              children: jsx.jsx(askKit.AskText, {
                id: 'fairy-search-exa-key',
                type: 'password',
                autoComplete: 'new-password',
                placeholder: configured.exa === true ? '已配置，输入新值以替换' : 'exa-...',
                value: form.draft.exaKey,
                disabled: !writable,
                onChange: (value) => form.change('exaKey', value),
              }),
            }),
            jsx.jsx(askKit.AskRow, {
              id: 'fairy-search-perplexity-key',
              label: 'Perplexity API Key',
              children: jsx.jsx(askKit.AskText, {
                id: 'fairy-search-perplexity-key',
                type: 'password',
                autoComplete: 'new-password',
                placeholder: configured.perplexity === true ? '已配置，输入新值以替换' : 'pplx-...',
                value: form.draft.perplexityKey,
                disabled: !writable,
                onChange: (value) => form.change('perplexityKey', value),
              }),
            }),
            jsx.jsx(askKit.AskRow, {
              id: 'fairy-search-custom-base',
              label: '自定义服务地址（OpenAI 兼容的 /chat/completions）',
              children: jsx.jsx(askKit.AskText, {
                id: 'fairy-search-custom-base',
                type: 'url',
                placeholder: 'https://your-gateway.example.com/v1',
                value: customBaseURLDraft,
                disabled: !writable,
                onChange: (value) => form.change('customBaseURL', value),
              }),
            }),
            jsx.jsx(askKit.AskRow, {
              id: 'fairy-search-custom-key',
              label: '自定义服务 API Key（可选）',
              children: jsx.jsx(askKit.AskText, {
                id: 'fairy-search-custom-key',
                type: 'password',
                autoComplete: 'new-password',
                placeholder: configured.custom === true ? '已配置，输入新值以替换' : '可留空（本地服务）',
                value: form.draft.customKey,
                disabled: !writable,
                onChange: (value) => form.change('customKey', value),
              }),
            }),
            jsx.jsx(askKit.AskActions, {
              busy: form.busy,
              status,
              primary: ASK_TEXT.save,
              secondary: ASK_TEXT.test,
              onPrimary: submit,
              onSecondary: runTest,
              writable,
            }),
            jsx.jsx(askKit.AskResult, { ok: probe?.ok === true, text: probe?.text }),
          ] }),
          jsx.jsxs('details', { style: ASK_STYLE.panel, children: [
            jsx.jsx('summary', { style: { cursor: 'pointer', fontSize: 12 }, children: 'MCP 服务器接入（loader 级配置）' }),
            jsx.jsx('p', { style: ASK_STYLE.copy, children: 'MCP 服务器不在这里添加：它们是 dsh loader 的插件条目，需要写进 profile 的 cordis.patch.yml 后重启。搜索引擎负责 web_search 工具，MCP 服务器提供额外的检索工具（如 context7 / tavily-mcp），两者互不影响。' }),
            jsx.jsx('pre', { style: styles.pre, children: MCP_SNIPPET }),
          ] }),
        ],
      });
    }

    function injectSearchSlot(ctx, definition, component) {
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
        const scope = ctx.settingsScope.bind({ namespace: SETTINGS_NAMESPACE });
        const disposeSlot = injectSearchSlot(ctx, { id: 'fairy-search', order: 28, label: () => '搜索引擎' }, () => jsx.jsx(SettingsSection, { scope }));
        if (typeof disposeSlot === 'function') ctx.effect(() => disposeSlot, 'dsh-fairy-search settings section');
      }, { surface: 'client' });
    }

    return { apply, inject: ['slots', 'settingsScope'], name: 'dsh-fairy-search' };
  },
});
