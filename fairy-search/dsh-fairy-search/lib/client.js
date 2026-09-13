window.__ModuleLoader__.load({
  id: 'dsh-fairy-search',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
    const React = require('react');
    const jsx = require('react/jsx-runtime');
    const { Button, StateDot } = require('@deepseek-ai/dsh-client-ui-primitives');

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

    function describeError(error) {
      const message = typeof error?.message === 'string' ? error.message : String(error);
      return message.length > 320 ? `${message.slice(0, 320)}…` : message;
    }

    function providerLabel(id) {
      return PROVIDERS.find((entry) => entry.id === id)?.label || id;
    }

    function useSettingsSnapshot(scope) {
      return React.useSyncExternalStore(scope.subscribe, scope.getSnapshot, scope.getSnapshot);
    }

    const styles = {
      root: { display: 'grid', gap: 12, padding: 16 },
      copy: { margin: 0, color: 'var(--dsw-alias-label-secondary, rgba(180,180,180,0.85))', fontSize: 12, lineHeight: '18px' },
      panel: { display: 'grid', gap: 10, padding: 12, borderRadius: 8, border: '1px solid var(--dsw-alias-border-l2, rgba(130,130,130,0.28))', background: 'var(--dsw-alias-bg-layer-2, rgba(130,130,130,0.09))' },
      row: { display: 'grid', gap: 4 },
      label: { fontSize: 12, color: 'var(--dsw-alias-label-secondary, rgba(180,180,180,0.85))' },
      input: { width: '100%', boxSizing: 'border-box', padding: '6px 8px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-l2, rgba(130,130,130,0.28))', background: 'var(--dsw-alias-bg-layer-1, transparent)', color: 'var(--dsw-alias-label-primary, rgba(225,225,225,0.95))', fontSize: 13 },
      actions: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
      status: { margin: 0, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary, rgba(180,180,180,0.85))' },
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
      const [remote, setRemote] = React.useState(null);
      const [remoteFailed, setRemoteFailed] = React.useState(false);
      const [drafts, setDrafts] = React.useState(EMPTY_DRAFTS);
      const [busy, setBusy] = React.useState(null);
      const [saveStatus, setSaveStatus] = React.useState('');
      const [probe, setProbe] = React.useState(null);
      const [reloadToken, setReloadToken] = React.useState(0);
      // `null` = untouched: the field mirrors the stored value until edited.
      const customBaseURLDraft = drafts.customBaseURL === null ? customBaseURL : drafts.customBaseURL;

      React.useEffect(() => {
        const controller = new AbortController();
        const startedAt = diagnostics.start();
        fetch(STATE_PATH, { signal: controller.signal, headers: { accept: 'application/json' } })
          .then((response) => {
            if (!response.ok) throw new Error(`状态接口返回 HTTP ${response.status}`);
            return response.json();
          })
          .then((value) => {
            setRemote(value);
            setRemoteFailed(false);
          })
          .catch((error) => {
            if (error?.name === 'AbortError') return;
            diagnostics.warn('settings.state', {}, error);
            setRemoteFailed(true);
          })
          .finally(() => diagnostics.metric('settings.state', startedAt, {}, { thresholdMs: 300 }));
        return () => controller.abort('disposed');
      }, [reloadToken]);

      const draft = (field, value) => setDrafts((current) => ({ ...current, [field]: value }));

      const selectProvider = (next) => {
        setSaveStatus('');
        Promise.resolve(scope.set('provider', next)).catch((error) => {
          diagnostics.warn('settings.provider', { provider: next }, error);
          setSaveStatus(`切换失败：${describeError(error)}`);
        });
      };

      const save = async () => {
        setBusy('save');
        setSaveStatus('');
        let fieldCount = 0;
        try {
          // Only fields the user actually typed are written: an empty input never
          // clears a stored secret, and keys are never read back into the form.
          const ops = [];
          if (drafts.deepseekKey.trim()) ops.push({ op: 'set', path: ['deepseek', 'apiKey'], value: drafts.deepseekKey.trim() });
          if (drafts.exaKey.trim()) ops.push({ op: 'set', path: ['exa', 'apiKey'], value: drafts.exaKey.trim() });
          if (drafts.perplexityKey.trim()) ops.push({ op: 'set', path: ['perplexity', 'apiKey'], value: drafts.perplexityKey.trim() });
          if (drafts.customKey.trim()) ops.push({ op: 'set', path: ['custom', 'apiKey'], value: drafts.customKey.trim() });
          if (drafts.customBaseURL !== null && drafts.customBaseURL.trim() !== customBaseURL) ops.push({ op: 'set', path: ['custom', 'baseURL'], value: drafts.customBaseURL.trim() });
          fieldCount = ops.length;
          if (fieldCount === 0) {
            setSaveStatus('没有需要保存的改动。');
            return;
          }
          await scope.mutate(ops);
          setDrafts(EMPTY_DRAFTS);
          setSaveStatus('已保存。新配置对下一次搜索生效。');
          setReloadToken((token) => token + 1);
        } catch (error) {
          diagnostics.warn('settings.save', { fields: fieldCount }, error);
          setSaveStatus(`保存失败：${describeError(error)}`);
        } finally {
          setBusy(null);
        }
      };

      const runTest = async () => {
        setBusy('test');
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
          setBusy(null);
        }
      };

      const configured = remote?.configured || {};
      const statusLine = remoteFailed
        ? '暂时读不到引擎状态（搜索仍按已保存的设置执行）。'
        : remote
          ? `当前生效：${providerLabel(remote.provider || provider)}。`
          : '正在读取引擎状态…';
      return jsx.jsxs('section', {
        style: styles.root,
        'aria-label': '搜索引擎设置',
        children: [
          jsx.jsxs('div', { style: styles.row, children: [
            jsx.jsx('h2', { style: { margin: 0, fontSize: 14 }, children: '搜索引擎' }),
            jsx.jsx('p', { style: styles.copy, children: 'Fairy 的联网搜索由这里的引擎提供，模型看到的仍是官方 web_search 工具卡片。切换后对下一次搜索生效，无需重启。' }),
            jsx.jsx('p', { style: styles.copy, children: '密钥只保存在本机设置文件中，页面不会回显已保存的值。' }),
          ] }),
          jsx.jsxs('div', { style: styles.panel, children: [
            jsx.jsxs('div', { style: styles.row, children: [
              jsx.jsx('label', { style: styles.label, htmlFor: 'fairy-search-provider', children: '搜索引擎' }),
              jsx.jsx('select', {
                id: 'fairy-search-provider',
                style: styles.input,
                value: provider,
                disabled: !writable || busy !== null,
                onChange: (event) => selectProvider(event.target.value),
                children: PROVIDERS.map((entry) => jsx.jsx('option', { value: entry.id, children: entry.label }, entry.id)),
              }),
            ] }),
            CONFIGURED_KEYS.map((id) => jsx.jsx(EngineState, {
              id,
              configured: configured[id] === true,
              selected: provider === id || (id === 'deepseek' && provider === 'deepseek-official'),
            }, id)),
            jsx.jsxs('div', { style: styles.row, children: [
              jsx.jsx('label', { style: styles.label, htmlFor: 'fairy-search-deepseek-key', children: '官方 DeepSeek：环境变量 DEEPSEEK_API_KEY，或在此覆盖' }),
              jsx.jsx('input', {
                id: 'fairy-search-deepseek-key',
                style: styles.input,
                type: 'password',
                autoComplete: 'new-password',
                placeholder: configured.deepseek === true ? '已配置，输入新值以替换' : 'sk-...',
                value: drafts.deepseekKey,
                disabled: !writable,
                onChange: (event) => draft('deepseekKey', event.target.value),
              }),
            ] }),
            jsx.jsxs('div', { style: styles.row, children: [
              jsx.jsx('label', { style: styles.label, htmlFor: 'fairy-search-exa-key', children: 'Exa API Key' }),
              jsx.jsx('input', {
                id: 'fairy-search-exa-key',
                style: styles.input,
                type: 'password',
                autoComplete: 'new-password',
                placeholder: configured.exa === true ? '已配置，输入新值以替换' : 'exa-...',
                value: drafts.exaKey,
                disabled: !writable,
                onChange: (event) => draft('exaKey', event.target.value),
              }),
            ] }),
            jsx.jsxs('div', { style: styles.row, children: [
              jsx.jsx('label', { style: styles.label, htmlFor: 'fairy-search-perplexity-key', children: 'Perplexity API Key' }),
              jsx.jsx('input', {
                id: 'fairy-search-perplexity-key',
                style: styles.input,
                type: 'password',
                autoComplete: 'new-password',
                placeholder: configured.perplexity === true ? '已配置，输入新值以替换' : 'pplx-...',
                value: drafts.perplexityKey,
                disabled: !writable,
                onChange: (event) => draft('perplexityKey', event.target.value),
              }),
            ] }),
            jsx.jsxs('div', { style: styles.row, children: [
              jsx.jsx('label', { style: styles.label, htmlFor: 'fairy-search-custom-base', children: '自定义服务地址（OpenAI 兼容的 /chat/completions）' }),
              jsx.jsx('input', {
                id: 'fairy-search-custom-base',
                style: styles.input,
                type: 'url',
                placeholder: 'https://your-gateway.example.com/v1',
                value: customBaseURLDraft,
                disabled: !writable,
                onChange: (event) => draft('customBaseURL', event.target.value),
              }),
            ] }),
            jsx.jsxs('div', { style: styles.row, children: [
              jsx.jsx('label', { style: styles.label, htmlFor: 'fairy-search-custom-key', children: '自定义服务 API Key（可选）' }),
              jsx.jsx('input', {
                id: 'fairy-search-custom-key',
                style: styles.input,
                type: 'password',
                autoComplete: 'new-password',
                placeholder: configured.custom === true ? '已配置，输入新值以替换' : '可留空（本地服务）',
                value: drafts.customKey,
                disabled: !writable,
                onChange: (event) => draft('customKey', event.target.value),
              }),
            ] }),
            jsx.jsxs('div', { style: styles.actions, children: [
              jsx.jsx(Button, { variant: 'primary', size: 'sm', disabled: !writable || busy !== null, onClick: save, children: busy === 'save' ? '保存中…' : '保存' }),
              jsx.jsx(Button, { variant: 'outline', size: 'sm', disabled: !writable || busy !== null, onClick: runTest, children: busy === 'test' ? '测试中…' : '测试' }),
              jsx.jsx('p', { style: styles.status, children: statusLine }),
            ] }),
            saveStatus ? jsx.jsx('p', { style: styles.status, children: saveStatus }) : null,
            probe ? jsx.jsxs('div', { style: styles.engine, children: [
              jsx.jsx(StateDot, { state: probe.ok ? 'done' : 'error', size: 10 }),
              jsx.jsx('span', { style: { color: probe.ok ? 'var(--dsw-alias-label-secondary, rgba(180,180,180,0.85))' : 'var(--dsw-alias-label-error, #e06c6c)' }, children: probe.text }),
            ] }) : null,
            !writable ? jsx.jsx('p', { style: styles.status, children: '当前浏览器会话不写入主机设置，保存已停用。' }) : null,
          ] }),
          jsx.jsxs('details', { style: styles.panel, children: [
            jsx.jsx('summary', { style: { cursor: 'pointer', fontSize: 12 }, children: 'MCP 服务器接入（loader 级配置）' }),
            jsx.jsx('p', { style: styles.copy, children: 'MCP 服务器不在这里添加：它们是 dsh loader 的插件条目，需要写进 profile 的 cordis.patch.yml 后重启。搜索引擎负责 web_search 工具，MCP 服务器提供额外的检索工具（如 context7 / tavily-mcp），两者互不影响。' }),
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
