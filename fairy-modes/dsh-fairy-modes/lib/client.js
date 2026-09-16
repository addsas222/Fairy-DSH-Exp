window.__ModuleLoader__.load({
  id: 'dsh-fairy-modes',
  factory: (require) => {
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
    const jsxRuntime = require('react/jsx-runtime');
    const { jsx, jsxs } = jsxRuntime;
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives');
    /**
     * 归一化提问件：卡的下拉/动作/状态都走这一份（套件由 sync-ask-kit 内联进上面的
     * 标记区；块尾只给 ASK_TEXT/ASK_STYLE，组件要自己造一份，别再声明那两个名字）。
     */
    const askKit = createAskKit({ React, jsx, jsxs, primitives });

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
    const diagnostics = createFairyDiagnostics('dsh-fairy-modes');

    const CHIP_SLOT = 'conversation.session.header.utilities';
    const SETTINGS_SLOT = 'settings.section';
    const STATE_URL = '/fairy-modes/state';
    const SET_URL = '/fairy-modes/set';
    /* Our own change notification: the projection frame covers the normal path,
     * and this keeps a second chip instance (or a fallback-mode chip) correct
     * without polling. */
    const EVENT_CHANGED = 'fairy-modes-changed';
    const CHIP_LABELS = { explore: '探查', ptc: 'PTC', create: '创造', roleplay: '角色', off: '空闲' };
    /* 预设未挂模式引擎时芯片的文案：宁可禁用并说清楚，也不要给一个点了必失败的活件。 */
    const UNAVAILABLE_LABEL = '模式不可用';
    const MENU = [
      { value: 'plan', label: '探查·极简（官方）' },
      { value: 'explore', label: '探查·只读（流水线）' },
      { value: 'ptc', label: '建造·PTC' },
      { value: 'roleplay', label: '角色扮演' },
      { value: 'create', label: '创造·回忆' },
      { value: 'off', label: '关闭' },
    ];
    /* New-session default: a browser preference, not host state. The chip reads
     * it here and applies it once per session through the same bridge the menu
     * uses, so the host stays the single owner of a session's mode. */
    const DEFAULT_KEY = 'dsh.fairyModes.default.v1';
    const APPLIED_PREFIX = 'dsh.fairyModes.applied.';
    /** The modes the bridge accepts; local because the browser half loads alone. */
    const MODE_VALUES = ['off', 'explore', 'ptc', 'create', 'roleplay'];
    const DEFAULT_MODE_ID = 'dsh-fairy-modes-default';
    const DEFAULT_MODE_OPTIONS = [
      { value: '', label: '不设置（新会话保持 off）' },
      { value: 'explore', label: '探查·只读（流水线）' },
      { value: 'ptc', label: '建造·PTC' },
      { value: 'roleplay', label: '角色扮演' },
      { value: 'create', label: '创造·回忆' },
      { value: 'off', label: '关闭·off' },
    ];
    const MODE_SEMANTICS = [
      { term: '极简', text: '官方 plan-mode，与下面的会话模式正交：在输入框输入 /plan（或点会话头 chip 的「探查·极简」）切换。' },
      { term: '流水线', text: '扮演 → 探查 → 建造 → 创造 → 回到扮演：模型用 mode_pipeline 推进，也可以点上面的模式手动切换任意一步。' },
      { term: '建造·PTC', text: '用 run_code 编排脚本系列，一次调用完成多步执行；先规划命令序列再执行。' },
      { term: '创造·回忆', text: '先调用 session_recall 回忆本项目全部历史，再回答；技能制作写 SKILL.md，插件制作运行 fairy-system/scaffold-plugin.js。' },
    ];

    const chipButton = {
      display: 'inline-flex', alignItems: 'center', height: '24px', padding: '0 9px',
      border: '1px solid var(--dsw-alias-border-l2, rgba(130,130,130,0.28))', borderRadius: '999px',
      background: 'var(--dsw-alias-bg-layer-1, rgba(130,130,130,0.09))',
      color: 'var(--dsw-alias-label-secondary, rgba(200,200,200,0.9))',
      font: 'var(--dsw-font-xs-strong-13, 12px system-ui)', cursor: 'pointer', whiteSpace: 'nowrap',
    };
    const menu = {
      position: 'absolute', top: 'calc(100% + 6px)', right: 0, zIndex: 60, display: 'grid',
      minWidth: '132px', padding: '4px', border: '1px solid var(--dsw-alias-border-l2, rgba(130,130,130,0.28))',
      borderRadius: '8px', background: 'var(--dsw-alias-bg-layer-1, #1f1f1f)',
      boxShadow: '0 10px 28px rgba(0,0,0,0.28)',
    };
    const menuRow = {
      display: 'block', width: '100%', padding: '6px 8px', border: 0, borderRadius: '6px',
      background: 'transparent', color: 'var(--dsw-alias-label-primary, rgba(225,225,225,0.95))',
      font: 'var(--dsw-font-xs-strong-13, 12px system-ui)', textAlign: 'left', cursor: 'pointer',
    };

    /** Browser storage is absent in some embeds (and under tests): treat it as empty. */
    function storageOf(kind) {
      try {
        return typeof window === 'object' && window !== null ? window[kind] ?? null : null;
      } catch (error) {
        diagnostics.warn('storage', { kind }, error);
        return null;
      }
    }

    function readStored(storage, key) {
      if (storage === null) return null;
      try {
        return storage.getItem(key);
      } catch (error) {
        diagnostics.warn('storage-read', { key }, error);
        return null;
      }
    }

    /** `null` clears the key; returns whether the write landed. */
    function writeStored(storage, key, value) {
      if (storage === null) return false;
      try {
        if (value === null) storage.removeItem(key);
        else storage.setItem(key, value);
        return true;
      } catch (error) {
        diagnostics.warn('storage-write', { key }, error);
        return false;
      }
    }

    function normalizeStoredMode(value) {
      const mode = typeof value === 'string' ? value.trim().toLowerCase() : '';
      return MODE_VALUES.includes(mode) ? mode : undefined;
    }

    /** The configured new-session mode, or undefined when unset/unreadable. */
    function defaultMode() {
      return normalizeStoredMode(readStored(storageOf('localStorage'), DEFAULT_KEY));
    }

    function isApplied(sessionId) {
      return readStored(storageOf('sessionStorage'), `${APPLIED_PREFIX}${sessionId}`) !== null;
    }

    function markApplied(sessionId) {
      return writeStored(storageOf('sessionStorage'), `${APPLIED_PREFIX}${sessionId}`, '1');
    }

    /** A failed application must stay retryable, so its mark is dropped again. */
    function clearApplied(sessionId) {
      return writeStored(storageOf('sessionStorage'), `${APPLIED_PREFIX}${sessionId}`, null);
    }

    /**
     * Apply the configured new-session default, once per session.
     *
     * The bridge state carries the folded fairyMode projection, where `off` is
     * both "never chosen" and "chosen off": the fold keeps no event count, so
     * that value is the only observable the browser has. A session already
     * handled in this tab is left alone by its own mark, which a manual chip
     * selection sets too.
     *
     * @param sessionId - the session the chip is showing.
     * @param state - the `/fairy-modes/state` payload the chip just read.
     */
    // ponytail: `off` 无法区分「从未设置」与「显式关闭」，当次会话的手动选择由本地已应用标记兜住；升级路径：让 /fairy-modes/state 返回事件计数（需改 bridge）。
    async function applyDefaultMode(sessionId, state) {
      if (typeof sessionId !== 'string' || sessionId === '') return;
      if ((state?.mode ?? 'off') !== 'off') return;
      const mode = defaultMode();
      if (mode === undefined || isApplied(sessionId)) return;
      markApplied(sessionId);
      try {
        const response = await fetch(SET_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId, mode }),
        });
        const result = await response.json().catch(() => null);
        if (!response.ok || result?.ok === false) {
          clearApplied(sessionId);
          diagnostics.warn('apply-default', { sessionId, mode, status: response.status, error: result?.error });
        }
      } catch (error) {
        clearApplied(sessionId);
        diagnostics.warn('apply-default', { sessionId, mode }, error);
      }
    }

    /**
     * The bridge snapshot, refreshed on session change and on the change event.
     * The fairyMode projection is the live source; this covers a client that
     * receives no projection frame for the key.
     */
    function useBridgeState(sessionId) {
      const [state, setState] = React.useState(null);
      React.useEffect(() => {
        if (!sessionId) return undefined;
        let live = true;
        const load = async () => {
          try {
            const response = await fetch(`${STATE_URL}?sessionId=${encodeURIComponent(sessionId)}`);
            if (!response.ok) {
              /* 503 = 该会话的 preset 没挂模式引擎（bridge 的 UNMOUNTED）。此前这里静默回落成
               * `off`，于是下拉能点开、点完必然失败——把死件当活件。记下来让芯片禁用并说明原因。 */
              if (live && response.status === 503) {
                const body = await response.json().catch(() => null);
                setState({ unavailable: true, reason: typeof body?.error === 'string' && body.error ? body.error : '本会话的预设未挂载模式引擎' });
              }
              return;
            }
            const value = await response.json();
            if (!live) return;
            setState(value);
            await applyDefaultMode(sessionId, value);
          } catch (error) {
            diagnostics.warn('state', { sessionId }, error);
          }
        };
        const onChanged = (event) => {
          if (event.detail?.sessionId === undefined || event.detail.sessionId === sessionId) void load();
        };
        void load();
        window.addEventListener(EVENT_CHANGED, onChanged);
        return () => {
          live = false;
          window.removeEventListener(EVENT_CHANGED, onChanged);
        };
      }, [sessionId]);
      return state;
    }

    function FairyModesChip({ sessionId, useProjection, inputActions }) {
      const projectedMode = typeof useProjection === 'function' ? useProjection('fairyMode') : undefined;
      const projectedPlan = typeof useProjection === 'function' ? useProjection('plan') : undefined;
      const bridged = useBridgeState(sessionId);
      const [open, setOpen] = React.useState(false);
      const rootRef = React.useRef(null);
      React.useEffect(() => {
        if (!open) return undefined;
        const onPointerDown = (event) => {
          if (!rootRef.current || !rootRef.current.contains(event.target)) setOpen(false);
        };
        const onKeyDown = (event) => { if (event.key === 'Escape') setOpen(false); };
        document.addEventListener('mousedown', onPointerDown);
        document.addEventListener('keydown', onKeyDown);
        return () => {
          document.removeEventListener('mousedown', onPointerDown);
          document.removeEventListener('keydown', onKeyDown);
        };
      }, [open]);

      const unavailable = bridged?.unavailable === true;
      const mode = projectedMode?.mode ?? bridged?.mode ?? 'off';
      const plan = projectedPlan ?? bridged?.plan ?? null;
      // Plan mode's own wire view: a pending selection is what the NEXT step
      // will use, so it wins while it differs from the committed state.
      const planActive = plan === null ? false : plan.pending === true ? plan.active !== true : plan.active === true;
      const label = planActive ? '极简' : CHIP_LABELS[mode] ?? 'off';

      const select = async (value) => {
        setOpen(false);
        if (value === 'plan') {
          /* 极简 is official plan mode: the chip drives it through the slash
           * command, exactly as typing it would. Without composer actions the
           * tooltip is the instruction. */
          if (inputActions === undefined) return;
          inputActions.setDraft(planActive ? '/plan off' : '/plan');
          inputActions.submit();
          return;
        }
        try {
          const response = await fetch(SET_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId, mode: value }),
          });
          const result = await response.json().catch(() => null);
          if (!response.ok || result?.ok === false) {
            diagnostics.warn('set', { sessionId, mode: value, status: response.status, error: result?.error });
            return;
          }
        } catch (error) {
          diagnostics.warn('set', { sessionId, mode: value }, error);
          return;
        }
        // A manual choice owns this session: the new-session default must not
        // re-apply behind it.
        markApplied(sessionId);
        window.dispatchEvent(new CustomEvent(EVENT_CHANGED, { detail: { sessionId, mode: value } }));
      };

      const checked = (value) => (value === 'plan' ? planActive : mode === value);
      if (unavailable) {
        /* 引擎不在这个会话的 preset 里：任何切换都会 503。禁用 + 写明原因，
         * 而不是给一个「能点开、点完失败」的下拉。 */
        const reason = typeof bridged.reason === 'string' && bridged.reason ? bridged.reason : '本会话的预设未挂载模式引擎';
        return jsx('span', {
          'data-dsh-fairy-modes-chip': 'true',
          'data-dsh-fairy-modes-unavailable': 'true',
          title: reason,
          style: { position: 'relative', display: 'inline-flex' },
          children: jsx('button', {
            type: 'button',
            'aria-disabled': 'true',
            'aria-label': `会话模式不可用：${reason}`,
            disabled: true,
            style: { ...chipButton, opacity: '.55', cursor: 'not-allowed' },
            children: UNAVAILABLE_LABEL,
          }),
        });
      }
      return jsx('span', {
        ref: rootRef,
        'data-dsh-fairy-modes-chip': 'true',
        title: inputActions === undefined ? '会话模式（极简请在输入框输入 /plan）' : '会话模式',
        style: { position: 'relative', display: 'inline-flex' },
        children: [
          jsx('button', {
            type: 'button',
            'aria-haspopup': 'menu',
            'aria-expanded': open ? 'true' : 'false',
            'aria-label': `会话模式：${label}`,
            onClick: () => setOpen(!open),
            style: { ...chipButton, ...(label === 'off' ? {} : { borderColor: 'var(--dsw-alias-brand-primary, #3b82f6)', color: 'var(--dsw-alias-label-primary, rgba(225,225,225,0.95))' }) },
            children: label,
          }),
          open ? jsx('div', {
            role: 'menu',
            style: menu,
            children: MENU.map((item) => jsx('button', {
              key: item.value,
              type: 'button',
              role: 'menuitem',
              'aria-checked': checked(item.value) ? 'true' : 'false',
              onClick: () => void select(item.value),
              style: menuRow,
              children: `${checked(item.value) ? '✓ ' : ''}${item.label}`,
            })),
          }) : null,
        ],
      });
    }

    function injectModesSlot(ctx, name, definition, component) {
      let disposeRegistration = null;
      const releaseRegistration = () => {
        const dispose = disposeRegistration;
        disposeRegistration = null;
        dispose?.();
      };
      return ctx.slots.inject(name, () => {
        // Slot providers may be invoked again when the official node is
        // replaced or the client bundle is reloaded. Release the prior
        // registration before publishing the replacement.
        releaseRegistration();
        const registration = ctx.slots.register({ name, ...definition }, component);
        disposeRegistration = typeof registration === 'function' ? registration : null;
        return releaseRegistration;
      });
    }

    /** The stored default as the dropdown's own value: `''` means 不设置. */
    function modeOf(value) {
      return normalizeStoredMode(value) ?? '';
    }

    /**
     * The settings card: mode semantics, plus the browser-side default the chip
     * applies to sessions that carry no mode yet. Nothing here is host state, so
     * the card needs no endpoint and no settings scope — only the preference,
     * and the preference goes through the normalized ask kit: one draft, one
     * 保存 button, the shared status wording.
     */
    function ModesSettingsSection() {
      const form = askKit.useAskForm({
        initial: {},
        load: () => ({ mode: modeOf(defaultMode()) }),
        save: (draft, stored) => {
          // 草稿优先：`''`（不设置）是合法选择，不能用 `??` 跳过去。
          const next = modeOf(draft.mode === undefined ? stored?.mode : draft.mode);
          if (next === modeOf(stored?.mode)) return { changed: false };
          if (!writeStored(storageOf('localStorage'), DEFAULT_KEY, next === '' ? null : next)) {
            throw new Error('浏览器存储不可用，默认模式没写进去');
          }
          return { changed: true, mode: next };
        },
      });
      // 动过的草稿优先，没动过就显示读到的偏好。
      const value = form.draft.mode === undefined ? modeOf(form.stored?.mode) : form.draft.mode;
      const locked = form.busy !== null;
      const submit = () => {
        const task = form.submit();
        task?.catch(() => {}); // 失败原因已经进了状态行，按钮的 onClick 不接 promise
        return task;
      };
      return jsxs(askKit.AskSection, {
        title: '模式',
        description: ['会话模式是记录在会话日志里的协作状态，不是进程开关；建造与创造互斥，极简（官方 plan-mode）与它们正交。'],
        children: [
          jsx('dl', {
            style: { display: 'grid', gap: '6px', margin: 0 },
            children: MODE_SEMANTICS.map(item => jsxs('div', {
              style: { display: 'grid', gap: '2px' },
              children: [
                jsx('dt', { style: { fontWeight: 600 }, children: item.term }),
                jsx('dd', { style: ASK_STYLE.copy, children: item.text }),
              ],
            }, item.term)),
          }),
          jsx(askKit.AskRow, {
            id: DEFAULT_MODE_ID,
            label: '新会话默认模式',
            hint: '默认值只作用于还没有模式记录的新会话；本会话里手动切换过（或已应用过默认值）后不再重复应用。',
            children: jsx(askKit.AskSelect, {
              id: DEFAULT_MODE_ID,
              value,
              options: DEFAULT_MODE_OPTIONS,
              disabled: locked,
              onChange: (next) => form.change('mode', next),
            }),
          }),
          jsx(askKit.AskActions, { busy: form.busy, status: form.status, onPrimary: submit }),
        ],
      });
    }

    function apply(ctx) {
      return diagnostics.guard('apply', () => {
        const disposers = [
          injectModesSlot(ctx, SETTINGS_SLOT, { id: 'fairy-modes', order: 29, label: () => '模式' }, ModesSettingsSection),
          injectModesSlot(ctx, CHIP_SLOT, { id: 'fairy-modes-chip', order: 20 }, FairyModesChip),
        ].filter((dispose) => typeof dispose === 'function');
        ctx.effect(() => () => { for (const dispose of disposers) dispose(); }, 'dsh-fairy-modes slot registrations');
      }, { surface: 'client' });
    }

    return { apply, inject: ['slots'] };
  },
});
