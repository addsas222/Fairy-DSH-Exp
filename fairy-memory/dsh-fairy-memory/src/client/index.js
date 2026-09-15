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
    const { createAskKit } = require('../../../../fairy-contracts/client-ask-kit.cjs');
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
      };
    }

    const memoryClient = createMemoryClient();

    function MemorySection() {
      const [availability, setAvailability] = React.useState(null);
      const [probeError, setProbeError] = React.useState('');

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
              hint: '关闭时只在明确要求时回忆。',
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
