window.__ModuleLoader__.load({
  id: 'dsh-fairy-memory',
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
    const diagnostics = createFairyDiagnostics('dsh-fairy-memory');

    const STATE_PATH = '/fairy-memory/state';
    const CONFIG_PATH = '/fairy-memory/config';
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
    const styles = {
      root: { display: 'grid', gap: 12, padding: 16 },
      copy: { margin: 0, color: 'var(--dsw-alias-label-secondary, rgba(180,180,180,0.85))', fontSize: 12, lineHeight: '18px' },
      panel: { display: 'grid', gap: 10, padding: 12, borderRadius: 8, border: '1px solid var(--dsw-alias-border-l2, rgba(130,130,130,0.28))', background: 'var(--dsw-alias-bg-layer-2, rgba(130,130,130,0.09))' },
      row: { display: 'grid', gap: 4 },
      entry: { display: 'flex', gap: 8, alignItems: 'center', fontSize: 12 },
      label: { fontSize: 12, color: 'var(--dsw-alias-label-secondary, rgba(180,180,180,0.85))' },
      input: { width: '100%', boxSizing: 'border-box', padding: '6px 8px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-l2, rgba(130,130,130,0.28))', background: 'var(--dsw-alias-bg-layer-1, transparent)', color: 'var(--dsw-alias-label-primary, rgba(225,225,225,0.95))', fontSize: 13 },
      actions: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
      status: { margin: 0, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary, rgba(180,180,180,0.85))' },
      error: { margin: 0, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-error, #e06c6c)' },
    };

    function describeError(error) {
      const message = typeof error?.message === 'string' ? error.message : String(error);
      return message.length > 320 ? `${message.slice(0, 320)}…` : message;
    }

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

    function draftsFrom(config) {
      return Object.fromEntries(MEMORY_PROVIDERS.map((entry) => [entry.id, providerDraft(config, entry.id)]));
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
      };
    }

    const memoryClient = createMemoryClient();

    function MemorySection() {
      const [provider, setProvider] = React.useState(MEMORY_PROVIDERS[0].id);
      const [config, setConfig] = React.useState(null);
      const [drafts, setDrafts] = React.useState({});
      // The one non-provider setting: whether recall runs before every answer.
      const [autoRecall, setAutoRecall] = React.useState(false);
      const [state, setState] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [status, setStatus] = React.useState('正在读取长期记忆配置…');
      const [error, setError] = React.useState(false);
      // ponytail: availability is read on mount, after a save, and on demand.
      // Polling would spend one probe per interval on a value that rarely moves.
      const refreshState = React.useCallback(() => memoryClient.state()
        .then((value) => { setState(value); })
        .catch((probeError) => {
          setState(null);
          setStatus(probeError?.message || '无法读取长期记忆状态。');
          setError(true);
        }), []);
      const loadConfig = React.useCallback(() => memoryClient.config().then((value) => {
        setConfig(value);
        setDrafts(draftsFrom(value));
        // The host's stored selection wins; an unknown value keeps the current one.
        if (MEMORY_PROVIDERS.some((entry) => entry.id === value?.provider)) setProvider(value.provider);
        setAutoRecall(value?.autoRecall === true);
        setError(false);
        return value;
      }), []);
      const refresh = React.useCallback(() => {
        loadConfig().then(() => setStatus('')).catch((loadError) => {
          setStatus(loadError?.message || '无法读取长期记忆配置。');
          setError(true);
        });
        refreshState();
      }, [loadConfig, refreshState]);
      React.useEffect(() => { refresh(); }, [refresh]);
      const selectProvider = (id) => {
        setProvider(id);
        setStatus('');
        setError(false);
      };
      // A provider switch keeps the other providers' edits: the drafts are keyed
      // by settings key, not by the current selection.
      const updateField = (name, value) => setDrafts((current) => ({
        ...current,
        [provider]: { ...(current[provider] || {}), [name]: value },
      }));
      const save = async () => {
        setBusy(true);
        setError(false);
        try {
          await memoryClient.save({ provider, autoRecall, providers: { [providerOption(provider).key]: drafts[provider] || {} } });
          // Re-read instead of trusting the POST body: the host re-masks secrets,
          // which is what the form must show after a save.
          await loadConfig();
          setStatus('已保存，下一次回忆或记录立即生效。');
          refreshState();
        } catch (saveError) {
          diagnostics.warn('config.save', { provider }, saveError);
          setStatus(saveError?.message || '保存失败。');
          setError(true);
        } finally { setBusy(false); }
      };
      const option = providerOption(provider);
      const availability = Array.isArray(state?.providers) ? state.providers : [];
      const activeId = MEMORY_PROVIDERS.some((entry) => entry.id === state?.provider) ? state.provider : provider;
      // Only the local markdown provider reports a count, and it arrives as
      // `null` elsewhere. `Number(null)` is 0, so the type check comes first.
      const count = typeof state?.count === 'number' && Number.isFinite(state.count) ? state.count : null;
      const countLine = count === null ? '已存记忆：未知' : `已存记忆：${count} 条`;
      return jsx.jsxs('section', {
        style: styles.root,
        'data-dsh-fairy-memory': 'true',
        'aria-label': '长期记忆设置',
        children: [
          jsx.jsxs('div', { style: styles.row, children: [
            jsx.jsx('h2', { style: { margin: 0, fontSize: 14 }, children: '长期记忆' }),
            jsx.jsx('p', { style: styles.copy, children: 'Fairy 的长期记忆默认由本机 GBrain 服务承担，也可以改指向 Mem0、任意 HTTP 服务或本地 Markdown 目录。切换后对下一次回忆或记录生效，无需重启。' }),
            jsx.jsx('p', { style: styles.copy, children: '密钥只保存在本机设置文件中，页面不会回显已保存的值。' }),
          ] }),
          jsx.jsxs('div', { style: styles.panel, children: [
            jsx.jsxs('div', { style: styles.row, children: [
              jsx.jsx('label', { style: styles.label, htmlFor: 'fairy-memory-provider', children: '提供方' }),
              jsx.jsx('select', {
                id: 'fairy-memory-provider',
                style: styles.input,
                'data-dsh-fairy-memory-provider': 'true',
                value: provider,
                disabled: busy,
                onChange: (event) => selectProvider(event.target.value),
                children: MEMORY_PROVIDERS.map((entry) => jsx.jsx('option', { value: entry.id, children: entry.label }, entry.id)),
              }),
            ] }),
            ...option.fields.map((field) => jsx.jsxs('div', { style: styles.row, children: [
              jsx.jsx('label', { style: styles.label, htmlFor: `fairy-memory-${option.id}-${field.name}`, children: field.label }),
              jsx.jsx('input', {
                id: `fairy-memory-${option.id}-${field.name}`,
                style: styles.input,
                'data-dsh-fairy-memory-field': field.name,
                type: field.secret ? 'password' : 'text',
                autoComplete: field.secret ? 'new-password' : 'off',
                value: drafts[provider]?.[field.name] ?? '',
                placeholder: field.secret && drafts[provider]?.[field.name] === SECRET_SENTINEL ? '已保存，输入新值以替换' : field.placeholder || '',
                disabled: busy,
                onChange: (event) => updateField(field.name, event.target.value),
                'aria-label': field.label,
              }),
            ] }, field.name)),
            jsx.jsxs('label', { style: styles.entry, htmlFor: 'fairy-memory-auto-recall', children: [
              jsx.jsx('input', {
                id: 'fairy-memory-auto-recall',
                type: 'checkbox',
                'data-dsh-fairy-memory-auto-recall': 'true',
                checked: autoRecall,
                disabled: busy,
                onChange: (event) => { setAutoRecall(event.target.checked); setStatus(''); },
                'aria-label': '每次回答前自动回忆',
              }),
              jsx.jsx('span', { style: styles.label, children: '每次回答前自动回忆（关闭时只在明确要求时回忆）' }),
            ] }),
            jsx.jsxs('div', { style: styles.panel, children: [
              availability.length === 0
                ? jsx.jsx('p', { style: styles.status, children: state ? '宿主未报告任何提供方。' : '正在读取提供方可用性…' })
                : availability.map((entry) => jsx.jsxs('div', { style: styles.entry, children: [
                  jsx.jsx(StateDot, { state: entry?.available === true ? 'done' : 'error', size: 10 }),
                  jsx.jsx('span', {
                    'data-dsh-fairy-memory-available': String(entry?.id ?? 'unknown'),
                    children: `${providerLabel(entry?.id)}：${entry?.available === true ? '可用' : `不可用 · ${entry?.reason || '未说明原因'}`}`,
                  }),
                ] }, `availability-${entry?.id ?? 'unknown'}`)),
            ] }),
            jsx.jsxs('div', { style: styles.entry, children: [
              jsx.jsx(StateDot, { state: state?.available === true ? 'done' : 'error', size: 10 }),
              jsx.jsx('span', {
                'data-dsh-fairy-memory-state': 'true',
                children: `当前提供方：${providerLabel(activeId)} · ${state?.available === true ? '可用' : `不可用 · ${state?.reason || '未检查'}`}`,
              }),
            ] }),
            jsx.jsx('p', { style: styles.status, 'data-dsh-fairy-memory-count': 'true', children: countLine }),
            jsx.jsxs('div', { style: styles.actions, children: [
              jsx.jsx(Button, { variant: 'outline', size: 'sm', disabled: busy, 'data-dsh-fairy-memory-refresh': 'true', onClick: () => refreshState(), children: '刷新可用性' }),
              jsx.jsx(Button, { variant: 'primary', size: 'sm', disabled: busy || !provider, 'data-dsh-fairy-memory-save': 'true', onClick: save, children: busy ? '处理中…' : '保存' }),
            ] }),
            jsx.jsx('p', { style: error ? styles.error : styles.status, 'data-error': error ? 'true' : 'false', children: status }),
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
