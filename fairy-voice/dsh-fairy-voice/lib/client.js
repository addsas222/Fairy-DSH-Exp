window.__ModuleLoader__.load({
  id: 'dsh-fairy-voice',
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
    const jsx = require('react/jsx-runtime');
    const { Tooltip, IconPauseOutline16, IconPlayOutline16, IconStopFill16, Input, Button, StateDot } = require('@deepseek-ai/dsh-client-ui-primitives');

    /** 设置卡的提问行、动作与状态只有一份实现（块由 sync-ask-kit 内联，别手改）。 */
    const askKit = createAskKit({ React, jsx: jsx.jsx, jsxs: jsx.jsxs, primitives: { Input, Button, StateDot } });

    const EVENT_PLAY = 'fairy-voice-play';
    const EVENT_STATE = 'fairy-voice-state';
    const EVENT_AVAILABILITY = 'fairy-voice-availability';
    const EVENT_BRAIN_CONFIG = 'fairy-voice-brain-config';
    const SETTINGS_AUTO = 'dsh.fairyVoice.autoRead.v4';
    const SETTINGS_VOLUME = 'dsh.fairyVoice.volume';
    const SETTINGS_RATE = 'dsh.fairyVoice.rate.v1';
    const SETTINGS_BRIEF_THRESHOLD = 'dsh.fairyVoice.briefThreshold.v1';
    const SETTINGS_ALWAYS_CONTROLS = 'dsh.fairyVoice.alwaysShowControls.v1';
    const EVENT_ALWAYS_CONTROLS = 'fairy-voice-always-controls';
    const AUDITION_TEXT = '你好，我是 Fairy。这是一段朗读示例。';
    const STT_ENDPOINT = '/fairy-voice';
    /** The client ctx of the app that applied us; the composer slot carries no
     * write face, so recognized text is inserted through ctx.bail. */
    let voiceClientCtx = null;
    const PCM_SAMPLE_RATE = 32000;
    const PCM_BYTES_PER_SAMPLE = 2;
    const PLAYBACK_GROUP_SIZE = 4;
    /* The CPU service's smallest measured first PCM burst is about 740ms.
     * 450ms starts promptly while leaving scheduling headroom; subsequent
     * sources stay on Web Audio's absolute timeline rather than JS timers. */
    const PLAYBACK_PREBUFFER_SECONDS = 0.65;
    const PLAYBACK_SCHEDULE_LEAD_SECONDS = 0.075;
    const PLAYBACK_MAX_SCHEDULED_SECONDS = 4.8;
    const PLAYBACK_MIN_BUFFER_SECONDS = 0.08;
    const PLAYBACK_MIN_BUFFER_BYTES = PCM_SAMPLE_RATE * PCM_BYTES_PER_SAMPLE * PLAYBACK_MIN_BUFFER_SECONDS;
    const PCM_EDGE_RAMP_SAMPLES = Math.round(PCM_SAMPLE_RATE * 0.005);
    const STOP_FADE_SECONDS = 0.012;
    const SESSION_BASELINE_SETTLE_MS = 1250;
    const FINAL_PLAYBACK_SETTLE_MS = 900;
    const VOICE_REPORT_DELAY_MS = 4500;
    const VOICE_REPORT_COOLDOWN_MS = 15000;
    const VOICE_BRIEF_THRESHOLD = 260;
    /** Live brief threshold: the settings card owns it, playback reads it. */
    const briefThreshold = { value: VOICE_BRIEF_THRESHOLD };

    /** One reader for the settings card and the runtime gate alike. `Number(null)`
     * is 0, which used to make a fresh install brief every answer while the card
     * showed the default; an explicitly stored 0 still means "brief always". */
    function readStoredBriefThreshold() {
      const raw = localStorage.getItem(SETTINGS_BRIEF_THRESHOLD);
      const stored = Number(raw);
      return raw !== null && Number.isFinite(stored) && stored >= 0 ? stored : VOICE_BRIEF_THRESHOLD;
    }
    const AVAILABILITY_TTL_MS = 30_000;
    const VOICE_STYLE_ID = 'dsh-fairy-voice-controls-style';
    const BROWSER_SPEECH_RATE = 1.0;
    const SPEECH_RATE_MIN = 0.5;
    const SPEECH_RATE_MAX = 2;
    const SPEECH_RATE_STEP = 0.05;
    const BROWSER_SPEECH_BUMP_MS = 6_000;
    const LOCAL_TTS_ENDPOINT = '/fairy-voice';
    const MAX_TRACKED_SESSION_STATES = 32;
    const { FAIRY_VOICE_CONTROL_ATTRIBUTE } = (() => {
      const module = { exports: {} };
// DSH_FAIRY_CLIENT_DOM_BEGIN
const FAIRY_VOICE_CONTROL_ATTRIBUTE = 'data-dsh-fairy-voice-control';

module.exports = { FAIRY_VOICE_CONTROL_ATTRIBUTE };
// DSH_FAIRY_CLIENT_DOM_END
      return module.exports;
    })();
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
    const diagnostics = createFairyDiagnostics('dsh-fairy-voice');
    const voiceStateBySession = new Map();
    const emptyActiveSelection = { key: 'empty-chat', epoch: 0 };
    const emptyActiveSessionStore = { getSnapshot: () => emptyActiveSelection, subscribe: () => () => {} };
    const emptyVoiceTimeline = { found: [], currentTurnFinals: [], messagesById: new Map(), userSeq: 0, sessionKey: 'empty-chat', activity: { running: false, phase: null, turn: 0, toolNames: [] } };
    let activeSessionStore = null;

    function createVoiceRequestScope() {
      const controller = new AbortController();
      const timers = new Set();
      const cleanups = new Set();
      let cancelled = false;
      const cancel = (reason = 'client-aborted') => {
        if (cancelled) return;
        cancelled = true;
        controller.abort(reason);
        for (const timer of timers) clearTimeout(timer);
        timers.clear();
        for (const cleanup of cleanups) {
          try { cleanup(); } catch (error) { reportAudioLifecycleFailure('request cleanup', error); }
        }
        cleanups.clear();
      };
      return {
        controller,
        signal: controller.signal,
        get cancelled() { return cancelled; },
        timeout(callback, delay) {
          if (cancelled) return 0;
          const timer = setTimeout(() => {
            timers.delete(timer);
            if (!cancelled) callback();
          }, delay);
          timers.add(timer);
          return timer;
        },
        addCleanup(cleanup) {
          if (typeof cleanup !== 'function') return cleanup;
          if (cancelled) cleanup();
          else cleanups.add(cleanup);
          return cleanup;
        },
        cancel,
      };
    }

    function createSessionTimelineStore() {
      const listeners = new Set();
      let snapshot = emptyVoiceTimeline;
      return {
        getSnapshot: () => snapshot,
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
        set(next) {
          if (snapshot === next) return;
          snapshot = next;
          listeners.forEach((listener) => listener());
        },
        clear(expected) {
          if (expected && snapshot !== expected) return;
          if (snapshot === emptyVoiceTimeline) return;
          snapshot = emptyVoiceTimeline;
          listeners.forEach((listener) => listener());
        },
      };
    }

    // Compatibility name retained for the existing plugin contract; the
    // implementation is the session-scoped timeline store above.
    function createVoiceTimelineStore() {
      return createSessionTimelineStore();
    }

    const voiceTimelineStore = createVoiceTimelineStore();

    /* Browser-side neural engines: Kokoro (WebGPU/WASM), KittenTTS-Nano (WASM,
     * ~25MB, 8 voices), Piper (WASM).
     * The host only stores their configuration — it answers 409 `client-side` —
     * so the model download, capability check, and synthesis all live here.
     * Every failure path degrades to system speech rather than to silence. */
    const LOCAL_ENGINE_IDS = ['kokoro-web', 'kitten-web', 'piper-web'];
    const KOKORO_SAMPLE_RATE = 24_000;
    const localEngineModules = new Map();
    const localEngineHandles = new Map();

    function isLocalEngine(id) {
      return LOCAL_ENGINE_IDS.includes(id);
    }

    function localEngineConfig(settingsValue, id) {
      const key = id === 'kokoro-web' ? 'kokoroWeb' : id === 'kitten-web' ? 'kittenWeb' : 'piperWeb';
      return settingsValue?.providers?.[key] || {};
    }

    /* Harness pages are not cross-origin isolated (no COOP/COEP, so no
     * SharedArrayBuffer) and cross-origin Workers are blocked. onnxruntime-web
     * therefore has to run single-threaded, and piper-tts-web sizes its pool
     * from navigator.hardwareConcurrency inside its own init — the value is the
     * only lever, held for exactly the init window. */
    async function withSingleThreadHint(task) {
      let patched = false;
      try {
        Object.defineProperty(navigator, 'hardwareConcurrency', { configurable: true, get: () => 1 });
        patched = true;
      } catch (error) {
        diagnostics.warn('local-engine.threads', {}, error);
      }
      try {
        return await task();
      } finally {
        if (patched) {
          try { delete navigator.hardwareConcurrency; } catch (error) { diagnostics.warn('local-engine.threads.restore', {}, error); }
        }
      }
    }

    /* Model and voice files come from HuggingFace. A mirror base redirects
     * exactly those hosts for the duration of a load or a synthesis call, so a
     * blocked HF (or a self-hosted mirror) does not make the engine unusable. */
    const MIRROR_HOSTS = /(^|\.)huggingface\.co$|^cdn-lfs[^.]*\.huggingface\.co$|^cas-bridge\.xethub\.hf\.co$/;
    let mirrorDepth = 0;
    let unmaskedFetch = null;

    function rewrittenMirrorUrl(rawInput, base) {
      const raw = typeof rawInput === 'string' ? rawInput : rawInput?.url;
      if (!raw) return null;
      try {
        const url = new URL(raw, window.location.href);
        if (!MIRROR_HOSTS.test(url.hostname)) return null;
        return `${new URL(base).origin}${url.pathname}${url.search}`;
      } catch {
        return null;
      }
    }

    async function withResourceMirror(base, task) {
      const mirrorBase = String(base || '').trim();
      if (!mirrorBase) return task();
      const rewrite = (input) => {
        const next = rewrittenMirrorUrl(input, mirrorBase);
        if (!next) return input;
        if (typeof input === 'string') return next;
        try { return new Request(next, input); } catch { return next; }
      };
      if (mirrorDepth === 0) {
        unmaskedFetch = window.fetch;
        window.fetch = (input, init) => unmaskedFetch.call(window, rewrite(input), init);
      }
      mirrorDepth += 1;
      try {
        return await task();
      } finally {
        mirrorDepth -= 1;
        if (mirrorDepth === 0 && unmaskedFetch) {
          window.fetch = unmaskedFetch;
          unmaskedFetch = null;
        }
      }
    }

    function importLocalEngineModule(url) {
      const key = String(url || '').trim();
      if (!key) return Promise.reject(new Error('未配置引擎模块地址。'));
      if (!localEngineModules.has(key)) {
        // Cache the promise: a second read shares one download, and a failure
        // is evicted so the next attempt can retry.
        localEngineModules.set(key, import(/* webpackIgnore: true */ key).catch((error) => {
          localEngineModules.delete(key);
          throw new Error(`引擎模块加载失败：${error?.message || key}`);
        }));
      }
      return localEngineModules.get(key);
    }

    function openLocalEngine(id, config) {
      const key = `${id}|${JSON.stringify(config)}`;
      if (!localEngineHandles.has(key)) {
        localEngineHandles.set(key, (async () => {
          if (id === 'kokoro-web') {
            const module = await importLocalEngineModule(config.moduleUrl);
            const KokoroTTS = module?.KokoroTTS || module?.default?.KokoroTTS;
            if (typeof KokoroTTS?.from_pretrained !== 'function') throw new Error('kokoro-js 未导出 KokoroTTS。');
            const webgpu = config.device === 'webgpu' && typeof navigator !== 'undefined' && 'gpu' in navigator;
            // WebGPU wants fp32; WASM wants a quantized dtype. Oversized
            // choices fail at load and fall back to system speech.
            const dtype = webgpu
              ? (config.dtype === 'fp32' || config.dtype === 'fp16' ? config.dtype : 'fp32')
              : (config.dtype && config.dtype !== 'fp32' ? config.dtype : 'q8');
            const tts = await withResourceMirror(config.resourceBase, () => withSingleThreadHint(
              () => KokoroTTS.from_pretrained(config.modelId, { dtype, device: webgpu ? 'webgpu' : 'wasm' }),
            ));
            return { kind: 'kokoro', tts, sampleRate: KOKORO_SAMPLE_RATE };
          }
          if (id === 'kitten-web') {
            const module = await importLocalEngineModule(config.moduleUrl);
            const KittenTTS = module?.KittenTTS || module?.default?.KittenTTS;
            if (typeof KittenTTS?.from_pretrained !== 'function') throw new Error('kitten-tts-js 未导出 KittenTTS。');
            // 模型与音色都从 HuggingFace 取，走 resourceBase 镜像；引擎自己管
            // onnxruntime-web，故只需单线程守卫（页面没有 SAB）。
            const tts = await withResourceMirror(config.resourceBase, () => withSingleThreadHint(
              () => KittenTTS.from_pretrained(config.modelId),
            ));
            return { kind: 'kitten', tts, sampleRate: KOKORO_SAMPLE_RATE };
          }
          const module = await importLocalEngineModule(config.moduleUrl);
          const api = typeof module?.TtsSession === 'function' ? module : module?.default ?? null;
          if (typeof api?.TtsSession !== 'function') throw new Error('piper-tts-web 未导出 TtsSession。');
          // Two upstream forks pin onnxruntime-web at a cdnjs 1.18.0 directory
          // that lacks the 1.19+ threaded loader (measured 404). Fail with the
          // base named instead of degrading for a reason nobody can see.
          if (typeof api.ONNX_BASE === 'string' && api.ONNX_BASE) {
            const loaderUrl = `${api.ONNX_BASE}ort-wasm-simd-threaded.mjs`;
            const reachable = await fetch(loaderUrl, { method: 'HEAD' })
              .then((response) => response.ok)
              .catch((error) => {
                diagnostics.warn('local-engine.ort-probe', { engine: 'piper-web' }, error);
                return true; // A probe failure is not evidence of a dead base.
              });
            if (!reachable) {
              throw new Error(`引擎的 onnxruntime 基址不可用（${loaderUrl}）。请改用 @realtimex/piper-tts-web 或自托管模块。`);
            }
          }
          // One session for the whole read: the model and voice download once
          // inside init() and every group reuses the same inference session.
          const session = await withResourceMirror(config.resourceBase, () => withSingleThreadHint(async () => {
            const opened = new api.TtsSession({ voiceId: config.voiceId });
            await opened.init();
            return opened;
          }));
          return { kind: 'piper', session, sampleRate: null };
        })().catch((error) => {
          localEngineHandles.delete(key);
          throw error;
        }));
      }
      return localEngineHandles.get(key);
    }

    async function synthesizeLocalEngine(handle, text, config, context) {
      if (handle.kind === 'kokoro' || handle.kind === 'kitten') {
        // Both engines answer with { data: Float32Array, sampling_rate }
        // (KittenTTS returns RawAudio, Kokoro an audio object): one mapping.
        const audio = await withResourceMirror(config.resourceBase, () => handle.tts.generate(text, { voice: config.voice }));
        const samples = audio?.audio ?? audio?.data ?? null;
        if (!samples || typeof samples.length !== 'number') throw new Error(`${handle.kind} 未返回音频。`);
        return {
          samples: samples instanceof Float32Array ? samples : Float32Array.from(samples),
          sampleRate: Number(audio?.sampling_rate || audio?.samplingRate) || handle.sampleRate,
        };
      }
      if (!context?.decodeAudioData) throw new Error('浏览器无法解码音频。');
      const blob = await withResourceMirror(config.resourceBase, () => handle.session.predict(text));
      const decoded = await context.decodeAudioData(await blob.arrayBuffer());
      return { samples: decoded.getChannelData(0), sampleRate: decoded.sampleRate };
    }

    // The client-side transport boundary keeps local TTS and Voice Brain HTTP
    // details out of playback policy and the settings UI.
    let scratchAudioContext = null;

    function scratchContext() {
      if (!scratchAudioContext || scratchAudioContext.state === 'closed') {
        scratchAudioContext = new AudioContext({ sampleRate: PCM_SAMPLE_RATE });
      }
      return scratchAudioContext;
    }

    async function playSamplesOnce(samples, sampleRate) {
      const context = scratchContext();
      if (context.state === 'suspended') await context.resume();
      const buffer = context.createBuffer(1, samples.length, sampleRate);
      buffer.getChannelData(0).set(samples);
      applyPcmEdgeRamp(buffer.getChannelData(0));
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      source.start();
      await new Promise((resolve) => { source.onended = resolve; });
    }

    function pcmBytesToSamples(bytes) {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const count = Math.floor(bytes.byteLength / 2);
      const samples = new Float32Array(count);
      for (let index = 0; index < count; index += 1) samples[index] = view.getInt16(index * 2, true) / 32768;
      return samples;
    }

    async function speakSampleWithSystem(text = AUDITION_TEXT) {
      if (!window.speechSynthesis) throw new Error('当前浏览器不支持系统朗读。');
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = 'zh-CN';
      utterance.rate = BROWSER_SPEECH_RATE;
      await new Promise((resolve) => {
        utterance.onend = resolve;
        utterance.onerror = resolve;
        window.speechSynthesis.speak(utterance);
      });
    }

    /* ---- speech input (STT) -------------------------------------------- */

    function speechRecognitionCtor() {
      return typeof window === 'undefined'
        ? null
        : (window.SpeechRecognition || window.webkitSpeechRecognition || null);
    }

    function sttProviderId(config) {
      return typeof config?.provider === 'string' && config.provider ? config.provider : 'browser';
    }

    /** Every provider names its own language field; the header must match the
     * card, or the host would override the setting with a browser default. */
    function sttLanguage(config) {
      const provider = sttProviderId(config);
      const providers = config?.providers || {};
      const raw = provider === 'openai' ? providers.openai?.language
        : provider === 'deepgram' ? providers.deepgram?.language
          : provider === 'azure' ? providers.azure?.locale
            : providers.browser?.lang;
      return typeof raw === 'string' && raw.trim() ? raw.trim() : 'zh-CN';
    }

    /** Browser recognition: resolves with text when the engine delivers it. */
    async function startBrowserSpeech(lang) {
      const Recognition = speechRecognitionCtor();
      if (!Recognition) throw new Error('当前浏览器不支持语音识别；请改用 Whisper 本地（浏览器内，免密钥）、在线 Deepgram/Azure 或自定义 HTTP 提供方。');
      const recognition = new Recognition();
      recognition.lang = lang;
      recognition.continuous = false;
      recognition.interimResults = false;
      recognition.maxAlternatives = 1;
      let settle = () => {};
      const result = new Promise((resolve) => { settle = resolve; });
      recognition.onresult = (event) => settle(String(event?.results?.[0]?.[0]?.transcript ?? '').trim());
      recognition.onerror = (event) => settle('');
      recognition.onend = () => settle('');
      try {
        recognition.start();
      } catch (error) {
        throw error instanceof Error ? error : new Error('无法启动语音识别。');
      }
      return {
        stop: async () => {
          try { recognition.stop(); } catch (error) { reportAudioLifecycleFailure('speech stop', error); }
          return await result;
        },
        cancel: () => { try { recognition.abort(); } catch (error) { reportAudioLifecycleFailure('speech abort', error); } },
      };
    }

    /** Media capture only; the caller decides what happens to the clip. */
    async function openRecorder() {
      const media = navigator.mediaDevices;
      if (!media?.getUserMedia || typeof MediaRecorder !== 'function') throw new Error('当前浏览器不支持录音。');
      const stream = await media.getUserMedia({ audio: true });
      const preferred = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
      const mimeType = preferred.find((type) => typeof MediaRecorder.isTypeSupported === 'function' && MediaRecorder.isTypeSupported(type));
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      const chunks = [];
      recorder.ondataavailable = (event) => { if (event?.data?.size) chunks.push(event.data); };
      const ended = new Promise((resolve) => { recorder.onstop = () => resolve(); });
      const stopTracks = () => { for (const track of stream.getTracks()) track.stop(); };
      recorder.start();
      return {
        stop: async () => {
          if (recorder.state !== 'inactive') {
            try { recorder.stop(); } catch (error) { reportAudioLifecycleFailure('recorder stop', error); }
          }
          await ended;
          stopTracks();
          if (!chunks.length) return null;
          return new Blob(chunks, { type: recorder.mimeType || mimeType || 'audio/webm' });
        },
        cancel: () => {
          if (recorder.state !== 'inactive') {
            try { recorder.stop(); } catch (error) { reportAudioLifecycleFailure('recorder cancel', error); }
          }
          stopTracks();
        },
      };
    }

    /** Online/host route: the clip is uploaded; the host owns the key. */
    async function startRecordedSpeech(lang) {
      const clip = await openRecorder();
      return {
        stop: async () => {
          const blob = await clip.stop();
          if (!blob) return '';
          const response = await fetch(`${STT_ENDPOINT}/stt`, {
            method: 'POST',
            headers: { 'content-type': blob.type || 'audio/webm', ...(lang ? { 'x-fairy-language': lang } : {}) },
            body: blob,
          });
          const value = await response.json().catch(() => null);
          if (!response.ok) throw new Error(value?.error?.message || '语音识别失败。');
          return String(value?.text ?? '').trim();
        },
        cancel: () => clip.cancel(),
      };
    }

    /* ---- browser-local Whisper (transformers.js) ------------------------- */

    const whisperPipelines = new Map();
    const WHISPER_LANGUAGES = {
      zh: 'chinese', 'zh-cn': 'chinese', 'zh-tw': 'chinese', cmn: 'chinese',
      en: 'english', 'en-us': 'english', ja: 'japanese', ko: 'korean', es: 'spanish',
      fr: 'french', de: 'german', ru: 'russian', it: 'italian'
    };

    /** Whisper wants full language names; unknown values fall back to detect. */
    function whisperLanguage(raw) {
      const value = String(raw || '').trim().toLowerCase();
      if (!value || value === 'auto') return undefined;
      return WHISPER_LANGUAGES[value] || value;
    }

    async function openWhisperWeb(config) {
      const key = `${config.moduleUrl}|${config.modelId}|${config.device}|${config.dtype}|${config.resourceBase}`;
      if (!whisperPipelines.has(key)) {
        whisperPipelines.set(key, (async () => {
          const module = await importLocalEngineModule(config.moduleUrl);
          const pipeline = module?.pipeline || module?.default?.pipeline;
          if (typeof pipeline !== 'function') throw new Error('transformers.js 未导出 pipeline。');
          const webgpu = config.device === 'webgpu' && typeof navigator !== 'undefined' && 'gpu' in navigator;
          const dtype = webgpu ? 'fp32' : (config.dtype && config.dtype !== 'fp32' ? config.dtype : 'q8');
          return await withResourceMirror(config.resourceBase, () => withSingleThreadHint(
            () => pipeline('automatic-speech-recognition', config.modelId, { device: webgpu ? 'webgpu' : 'wasm', dtype }),
          ));
        })().catch((error) => {
          whisperPipelines.delete(key);
          throw error instanceof Error ? error : new Error('本地识别引擎加载失败。');
        }));
      }
      return whisperPipelines.get(key);
    }

    /** Decode a clip to the 16 kHz mono float array Whisper expects. */
    async function decodeForAsr(blob) {
      if (typeof OfflineAudioContext !== 'function') throw new Error('当前浏览器无法解码音频。');
      const context = new OfflineAudioContext(1, 16000, 16000);
      const decoded = await context.decodeAudioData(await blob.arrayBuffer());
      if (decoded.numberOfChannels === 1) return decoded.getChannelData(0);
      const mixed = new Float32Array(decoded.length);
      for (let channel = 0; channel < decoded.numberOfChannels; channel += 1) {
        const data = decoded.getChannelData(channel);
        for (let index = 0; index < data.length; index += 1) mixed[index] += data[index] / decoded.numberOfChannels;
      }
      return mixed;
    }

    /** Local route: nothing leaves the machine; the model runs in this tab. */
    async function startLocalWhisperSpeech(config) {
      const whisperConfig = config?.providers?.whisperWeb || {};
      const clip = await openRecorder();
      return {
        stop: async () => {
          const blob = await clip.stop();
          if (!blob) return '';
          const transcriber = await openWhisperWeb(whisperConfig);
          const audio = await decodeForAsr(blob);
          const language = whisperLanguage(whisperConfig.language);
          const result = await transcriber(audio, { task: 'transcribe', ...(language ? { language } : {}) });
          return String(result?.text ?? '').trim();
        },
        cancel: () => clip.cancel(),
      };
    }

    /**
     * Insert recognized text into the composer, in sanctioned order:
     *   1. `inputActions.setDraft` — the composer's public action face, which
     *      owns the draft machine (no CAS, no racing the render loop);
     *   2. `ctx.bail('slash/input-insert-text', ...)` — the slash channel the
     *      first-party input-trigger uses, kept as the fallback for harness
     *      versions that expose no action face;
     *   3. otherwise refuse: the draft belongs to the shell's draftRev state
     *      machine, and a direct DOM write would be clobbered by the next
     *      render — reporting is honest where writing would be a lie.
     */
    function insertTranscript({ inputActions, cordisCtx, snapshot }, text) {
      const draft = typeof snapshot?.draft === 'string' ? snapshot.draft : '';
      const separator = draft && !/\s$/.test(draft) ? ' ' : '';
      if (typeof inputActions?.setDraft === 'function') {
        try {
          inputActions.setDraft(`${draft}${separator}${text}`);
          return true;
        } catch (error) {
          diagnostics.warn('stt.set-draft', {}, error);
        }
      }
      if (typeof cordisCtx?.bail === 'function' && typeof snapshot?.draftRev === 'number') {
        const span = { start: draft.length, end: draft.length, draftRev: snapshot.draftRev };
        if (cordisCtx.bail('slash/input-insert-text', { text: `${separator}${text}`, span }) === true) return true;
      }
      return false;
    }

    function useAlwaysShowControls() {
      const read = () => localStorage.getItem(SETTINGS_ALWAYS_CONTROLS) === 'true';
      return React.useSyncExternalStore((notify) => {
        // Test doubles (and locked-down embeds) may not carry the event API.
        if (typeof window.addEventListener !== 'function') return () => {};
        window.addEventListener(EVENT_ALWAYS_CONTROLS, notify);
        window.addEventListener('storage', notify);
        return () => {
          window.removeEventListener(EVENT_ALWAYS_CONTROLS, notify);
          window.removeEventListener('storage', notify);
        };
      }, read, read);
    }

    function createLocalTtsTransport(fetchImpl = fetch) {
      const request = (operation, url, options) => {
        const startedAt = diagnostics.start();
        return Promise.resolve().then(() => fetchImpl(url, options)).then((response) => {
          diagnostics.metric(operation, startedAt, { status: response.status }, { thresholdMs: 100 });
          return response;
        }, (error) => {
          if (error?.name !== 'AbortError') diagnostics.warn(operation, {}, error);
          diagnostics.metric(operation, startedAt, { outcome: 'failure' }, { thresholdMs: 100 });
          throw error;
        });
      };
      return {
        prepare(markdown, signal) {
          return request('speech.prepare.request', LOCAL_TTS_ENDPOINT + '/prepare', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ markdown }), signal
          }).then(async (response) => {
            const value = await response.json();
            if (!response.ok) throw new Error(value?.error?.message || 'Unable to prepare speech.');
            return value.sentences || [];
          });
        },
        status(signal) {
          return request('status.request', LOCAL_TTS_ENDPOINT + '/status', { cache: 'no-store', signal }).then(async (response) => {
            const value = await response.json();
            return response.ok ? value : { available: false, reason: '本地 Fairy 服务未启动。' };
          });
        },
        stream(text, signal) {
          return request('tts.stream.request', LOCAL_TTS_ENDPOINT + '/tts', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }), signal
          });
        },
        providers(signal) {
          return request('providers.request', LOCAL_TTS_ENDPOINT + '/providers', { cache: 'no-store', signal }).then(async (response) => {
            const value = await response.json().catch(() => null);
            if (!response.ok || !Array.isArray(value)) throw new Error('无法读取提供方可用性。');
            return value;
          });
        },
        sttProviders(signal) {
          return request('stt.providers.request', STT_ENDPOINT + '/stt-providers', { cache: 'no-store', signal }).then(async (response) => {
            const value = await response.json().catch(() => null);
            if (!response.ok || !Array.isArray(value)) throw new Error('无法读取识别提供方可用性。');
            return value;
          });
        },
        sttConfig(signal) {
          return request('stt.config.request', STT_ENDPOINT + '/stt-config', { cache: 'no-store', signal }).then(async (response) => {
            const value = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(value?.error?.message || '无法读取语音输入配置。');
            return value;
          });
        },
        saveSttConfig(patch, signal) {
          return request('stt.config.save', STT_ENDPOINT + '/stt-config', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch), signal
          }).then(async (response) => {
            const value = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(value?.error?.message || '保存语音输入配置失败。');
            return value;
          });
        },
        providerConfig(signal) {
          return request('config.request', LOCAL_TTS_ENDPOINT + '/provider-config', { cache: 'no-store', signal }).then(async (response) => {
            const value = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(value?.error?.message || '无法读取语音引擎配置。');
            return value;
          });
        },
        saveProviderConfig(payload) {
          return request('config.save.request', LOCAL_TTS_ENDPOINT + '/provider-config', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), cache: 'no-store'
          }).then(async (response) => {
            const value = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(value?.error?.message || '保存语音引擎配置失败。');
            return value;
          });
        }
      };
    }

    function createVoiceBrainClient(fetchImpl = fetch) {
      const request = (operation, url, options) => {
        const startedAt = diagnostics.start();
        return Promise.resolve().then(() => fetchImpl(url, options)).then((response) => {
          diagnostics.metric(operation, startedAt, { status: response.status }, { thresholdMs: 100 });
          return response;
        }, (error) => {
          if (error?.name !== 'AbortError') diagnostics.warn(operation, {}, error);
          throw error;
        });
      };
      return {
        status() {
          return request('brain.status.request', LOCAL_TTS_ENDPOINT + '/brain/status', { cache: 'no-store' }).then(async (response) => {
            const value = await response.json();
            return response.ok ? value : { configured: false, model: 'deepseek-v4-flash' };
          });
        },
        brief(markdown, signal) {
          return request('brain.brief.request', LOCAL_TTS_ENDPOINT + '/brain/brief', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ markdown }), signal
          }).then(async (response) => {
            const value = await response.json();
            if (!response.ok) throw new Error(value?.error?.message || 'Voice brief unavailable.');
            return typeof value?.brief === 'string' ? value.brief.trim() : '';
          });
        },
        config(payload) {
          return request('brain.config.request', LOCAL_TTS_ENDPOINT + '/brain/config', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), cache: 'no-store'
          }).then(async (response) => {
            const value = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(value?.error?.message || '本地语音简报服务未响应。');
            return value;
          }).catch((error) => {
            if (error instanceof TypeError || error?.name === 'SyntaxError') throw new Error('无法连接本地语音简报服务。请重新加载 DSH 后重试。');
            throw error;
          });
        }
      };
    }

    const localTtsTransport = createLocalTtsTransport();
    const voiceBrainClient = createVoiceBrainClient();

    const VOICE_REPORTS = {
      searching: ['主人，正在检索相关资料。', '资料仍在核验中，我继续盯着。', '检索还在进行，正在筛选有效信息。'],
      tool: ['行动步骤已启动，请稍候。', '必要操作仍在执行中。', '执行进度正常，我继续处理。'],
      working: ['主人，正在整理信息。', '信息还在汇总，我继续梳理。', '正在计算可执行结论。']
    };

    function isSearchTool(name) {
      // A search announcement is permitted only when the tool identifier says
      // so. Assistant prose, reasoning, and UI labels are never treated as evidence.
      const value = String(name || '').trim().toLowerCase();
      return /(^|[._/-])(web_)?search([._/-]|$)|(^|[._/-])search_web([._/-]|$)|搜索|检索/.test(value);
    }

    function clampVolume(value) {
      const number = Number(value);
      return Number.isFinite(number) ? Math.min(1, Math.max(0, number)) : 1;
    }

    function reportAudioLifecycleFailure(operation, error) {
      if (error?.name === 'InvalidStateError' || error?.name === 'AbortError') return;
      diagnostics.warn('audio.lifecycle', { operation }, error);
    }

    function reportAudioResources(current, operation) {
      diagnostics.info('audio.resources', {
        operation,
        activeSources: current?.sources?.size || 0,
        activeObjectUrls: current?.urls?.size || 0,
        contextState: current?.context?.state || 'none',
      });
    }

    function createPcmStreamHandler() {
      return {
        decodeInto(bytes, samples) {
          for (let offset = 0, index = 0; offset < bytes.length && index < samples.length; offset += PCM_BYTES_PER_SAMPLE, index += 1) {
            const value16 = bytes[offset] | (bytes[offset + 1] << 8);
            samples[index] = (value16 & 0x8000 ? value16 - 0x10000 : value16) / 0x8000;
          }
        },
        playableLength(bytes) {
          return bytes.length - (bytes.length % PCM_BYTES_PER_SAMPLE);
        }
      };
    }

    const pcmStreamHandler = createPcmStreamHandler();

    // TTS fragments are independently synthesized and can begin/end away from
    // zero. A short edge ramp prevents a discontinuity becoming an audible click
    // when adjacent AudioBufferSourceNodes are scheduled back-to-back.
    function applyPcmEdgeRamp(samples) {
      const ramp = Math.min(PCM_EDGE_RAMP_SAMPLES, Math.floor(samples.length / 2));
      if (!ramp) return;
      for (let index = 0; index < ramp; index += 1) {
        const ratio = (index + 1) / ramp;
        samples[index] *= ratio;
        samples[samples.length - 1 - index] *= ratio;
      }
    }

    function clampSpeechRate(value) {
      const rate = Number(value);
      if (!Number.isFinite(rate)) return BROWSER_SPEECH_RATE;
      return Math.min(SPEECH_RATE_MAX, Math.max(SPEECH_RATE_MIN, rate));
    }

    function createWebAudioScheduler({ current, getNextStart }) {
      const waitForPlayback = async () => {
        while (!current.stopped && current.context?.state === 'running' && getNextStart() !== null) {
          const remaining = getNextStart() - current.context.currentTime;
          if (remaining <= 0) return;
          await new Promise((resolve) => setTimeout(resolve, Math.min(remaining * 1000, 50)));
        }
      };
      const waitForQueueCapacity = async () => {
        while (!current.stopped && current.context?.state === 'running' && getNextStart() !== null) {
          const queued = getNextStart() - current.context.currentTime;
          if (queued <= PLAYBACK_MAX_SCHEDULED_SECONDS) return;
          await new Promise((resolve) => setTimeout(resolve, Math.min((queued - PLAYBACK_MAX_SCHEDULED_SECONDS) * 1000, 50)));
        }
      };
      return { waitForPlayback, waitForQueueCapacity };
    }

    function idleVoiceState(sessionKey) {
      return { status: 'idle', messageId: null, error: null, sessionKey: String(sessionKey), lastAccess: Date.now() };
    }

    function disposeVoiceSessionState(key, state) {
      try {
        state?.dispose?.();
      } catch (error) {
        reportAudioLifecycleFailure(`session state ${key} disposal`, error);
      } finally {
        voiceStateBySession.delete(key);
      }
    }

    function pruneOldSessions() {
      if (voiceStateBySession.size <= MAX_TRACKED_SESSION_STATES) return;
      const activeKey = String(activeSessionStore?.getSnapshot?.().key ?? 'empty-chat');
      const entries = [...voiceStateBySession.entries()];
      entries.sort((a, b) => {
        const activeOrder = Number(a[0] === activeKey) - Number(b[0] === activeKey);
        return activeOrder || (a[1].lastAccess || 0) - (b[1].lastAccess || 0);
      });
      const toRemove = entries.slice(0, entries.length - MAX_TRACKED_SESSION_STATES);
      toRemove.forEach(([key, state]) => disposeVoiceSessionState(key, state));
    }

    function clearVoiceSessionStates() {
      [...voiceStateBySession.entries()].forEach(([key, state]) => disposeVoiceSessionState(key, state));
    }

    function readVoiceState(sessionKey) {
      const key = String(sessionKey);
      const state = voiceStateBySession.get(key);
      if (!state) return idleVoiceState(key);
      state.lastAccess = Date.now();
      return state;
    }

    function dispatchVoiceState(detail) {
      const scoped = { ...detail, sessionKey: String(detail.sessionKey), lastAccess: Date.now() };
      voiceStateBySession.set(scoped.sessionKey, scoped);
      pruneOldSessions();
      window.dispatchEvent(new CustomEvent(EVENT_STATE, { detail: scoped }));
      return scoped;
    }

    function createActiveSessionStore(sessions) {
      const listeners = new Set();
      const readKey = () => String(sessions?.list?.getSnapshot?.().current ?? 'empty-chat');
      let snapshot = { key: readKey(), epoch: 0 };
      const sync = () => {
        const key = readKey();
        if (key === snapshot.key) return;
        snapshot = { key, epoch: snapshot.epoch + 1 };
        listeners.forEach((listener) => listener());
      };
      const off = sessions?.list?.subscribe?.(sync) || null;
      return {
        getSnapshot: () => snapshot,
        subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
        dispose: () => { off?.(); listeners.clear(); },
      };
    }

    const iconButton = {
      width: '28px', height: '28px', border: 'none', borderRadius: '999px', padding: '6px',
      display: 'inline-grid', placeItems: 'center', background: 'transparent',
      color: 'var(--dsw-alias-label-tertiary)', cursor: 'pointer'
    };

    function ensureVoiceControlStyles() {
      if (typeof document === 'undefined' || document.getElementById(VOICE_STYLE_ID)) return;
      const style = document.createElement('style');
      style.id = VOICE_STYLE_ID;
      style.setAttribute('data-plugin', 'dsh-fairy-voice');
      style.textContent = `
.dsh-fairy-voice-controls{display:inline-flex;align-items:center;gap:4px;height:28px;padding:2px 5px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);box-sizing:border-box}
.dsh-fairy-voice-auto{width:22px;height:22px;display:grid;place-items:center;flex:none;padding:0;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;transition:background .15s,color .15s}
.dsh-fairy-voice-auto:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.dsh-fairy-voice-auto[data-on="true"]{background:color-mix(in srgb,var(--dsw-alias-label-secondary) 12%,transparent);color:var(--dsw-alias-label-secondary)}
.dsh-fairy-voice-auto:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dsh-fairy-voice-auto:disabled,.dsh-fairy-voice-volume:disabled{cursor:not-allowed;opacity:.42}
.dsh-fairy-voice-volume{--dsh-fairy-volume:100%;appearance:none;-webkit-appearance:none;width:66px;height:22px;margin:0;background:transparent;cursor:pointer}
.dsh-fairy-voice-volume::-webkit-slider-runnable-track{height:3px;border-radius:999px;background:linear-gradient(to right,var(--dsw-alias-label-secondary) 0 var(--dsh-fairy-volume),var(--dsw-alias-border-l2) var(--dsh-fairy-volume) 100%)}
.dsh-fairy-voice-volume::-webkit-slider-thumb{-webkit-appearance:none;width:11px;height:11px;margin-top:-4px;border:2px solid var(--dsw-alias-bg-layer-1);border-radius:50%;background:var(--dsw-alias-label-secondary);box-shadow:0 0 0 1px var(--dsw-alias-border-l2)}
.dsh-fairy-voice-volume:focus-visible{outline:none}
.dsh-fairy-voice-volume:focus-visible::-webkit-slider-thumb{box-shadow:0 0 0 2px var(--dsw-alias-brand-primary)}
.dsh-fairy-voice-volume::-moz-range-track{height:3px;border:0;border-radius:999px;background:var(--dsw-alias-border-l2)}
.dsh-fairy-voice-volume::-moz-range-progress{height:3px;border-radius:999px;background:var(--dsw-alias-label-secondary)}
.dsh-fairy-voice-volume::-moz-range-thumb{width:9px;height:9px;border:2px solid var(--dsw-alias-bg-layer-1);border-radius:50%;background:var(--dsw-alias-label-secondary);box-shadow:0 0 0 1px var(--dsw-alias-border-l2)}
.dsh-fairy-voice-waveform{display:none;align-items:center;justify-content:space-between;gap:3px;flex:1;height:100%;padding:0 4px;pointer-events:none}
.dsh-fairy-voice-wave-bar{display:block;width:3px;min-width:3px;height:var(--dsh-fairy-wave-height);border-radius:999px;background:currentColor;opacity:var(--dsh-fairy-wave-opacity)}
`;
      (document.head || document.documentElement).appendChild(style);
    }

    /** True when `text` holds at least `limit` code points. Materialising the
     * array for a long answer costs far more than the check is worth, and the
     * UTF-16 length already rejects anything short. */
    function reachesCodePointCount(text, limit) {
      if (text.length < limit) return false;
      let count = 0;
      for (const _character of text) {
        count += 1;
        if (count >= limit) return true;
      }
      return false;
    }

    function messageText(finalNode) {
      return (finalNode?.blocks || []).filter((block) => block.kind === 'text').map((block) => block.text).join('\n').trim();
    }

    function collectRunningTools(block, activeTools, seenCallIds = new Set()) {
      if (!block || seenCallIds.has(String(block.callId))) return;
      seenCallIds.add(String(block.callId));
      if (!('kind' in block)) {
        activeTools.push({ id: String(block.callId), name: String(block.name || ''), turn: block.turn, step: block.step });
      }
      for (const child of block.subCalls || []) collectRunningTools(child, activeTools, seenCallIds);
    }

    function readVoiceTimeline(snapshot) {
      const found = [];
      const currentTurnFinals = [];
      const activeAssistantSteps = [];
      const activeTools = [];
      const activeToolIds = new Set();
      const chat = snapshot?.chat;
      for (const key of chat?.order || []) {
        const node = chat.nodes?.get(key);
        const data = node?.kind === 'assistant-step' ? node.data : undefined;
        const finalNode = data?.finalNode;
        const text = messageText(finalNode);
        if (data?.status === 'settled' && finalNode?.messageId && text) found.push({ id: String(finalNode.messageId), markdown: text });
        if (data?.status === 'running') activeAssistantSteps.push({ turn: data.turn, step: data.step });
        // Tool rows remain in chat.order after completion. They are history,
        // not evidence of current activity, so do not infer "running" from
        // their retained root call. The authoritative live list is merged
        // below from legacy.runningCalls.
      }
      // Walking backwards beats filter().at(-1): this runs on every store
      // update, over every message of the session.
      const legacyNodes = snapshot?.chat?.legacy?.nodes || [];
      let userSeq = 0;
      for (let index = legacyNodes.length - 1; index >= 0; index -= 1) {
        const node = legacyNodes[index];
        if (node?.kind === 'user' || node?.kind === 'steering') { userSeq = node.seq || 0; break; }
      }
      // An assistant-step finalNode is the final message for that step, not
      // necessarily the final answer for the whole turn. The official
      // turn-tail projection is the authoritative whole-turn boundary: it is
      // published only for a closed turn and its closing value is the last
      // content-bearing assistant step in that turn. Process/reasoning steps
      // therefore never enter the automatic-final queue.
      //
      // Restrict the projection to the turn containing the latest user/steering
      // event. Without this boundary, a manually replayed historical answer
      // could look like a new automatic candidate on the next prompt.
      const timeline = chat?.timeline;
      for (const turnNumber of timeline?.turnOrder || []) {
        const turnLocation = timeline.turns?.get(turnNumber);
        if (turnLocation?.status !== 'closed') continue;
        const startSeq = turnLocation.start?.seq;
        const endSeq = turnLocation.end?.seq;
        if (typeof startSeq !== 'number' || startSeq > userSeq || (typeof endSeq === 'number' && userSeq > endSeq)) continue;
        const closing = turnLocation.data?.get?.('turn-tail')?.closing;
        const finalNode = closing?.finalNode;
        const text = messageText(finalNode);
        if (finalNode?.messageId && text) {
          currentTurnFinals.push({
            id: String(finalNode.messageId),
            markdown: text,
            turn: turnNumber,
            seq: finalNode.seq
          });
        }
      }
      const sessionKey = snapshot?.sessionId ?? snapshot?.chat?.sessionId ?? snapshot?.chat?.id ?? chat?.order?.[0] ?? 'empty-chat';
      // legacy.runningCalls covers a short interval before a tool row is
      // materialized in chat.order. Merge it by call id without relying on UI text.
      for (const call of snapshot?.chat?.legacy?.runningCalls || []) {
        collectRunningTools(call, activeTools, activeToolIds);
      }
      // snapshot.running can remain true during post-tool reconciliation even
      // after the final assistant node is settled. The concrete live lists
      // below are the reliable activity boundary for speech scheduling.
      const running = activeAssistantSteps.length > 0 || activeTools.length > 0;
      const phase = !running ? null : activeTools.some((tool) => isSearchTool(tool.name)) ? 'searching' : activeTools.length ? 'tool' : 'working';
      const turn = Math.max(0, ...activeAssistantSteps.map((step) => Number(step.turn) || 0), ...activeTools.map((tool) => Number(tool.turn) || 0));
      return {
        found,
        currentTurnFinals,
        messagesById: new Map(found.map((message) => [message.id, message])),
        userSeq,
        sessionKey: String(sessionKey),
        activity: { running, phase, turn, toolNames: activeTools.map((tool) => tool.name) }
      };
    }

    const prepare = (markdown, signal) => localTtsTransport.prepare(markdown, signal);
    const getAvailability = (signal) => localTtsTransport.status(signal);

    const INITIAL_AVAILABILITY = Object.freeze({ available: false, reason: 'Checking Fairy voice availability…' });
    const availabilityListeners = new Set();
    let availabilitySnapshot = INITIAL_AVAILABILITY;
    let availabilityCheckedAt = 0;
    let availabilityRequest = null;
    let availabilityController = null;

    function publishAvailability(value) {
      const provider = typeof value?.provider === 'string' ? value.provider : availabilitySnapshot.provider;
      const next = value?.available === true
        ? { available: true, reason: null, provider }
        : { available: false, reason: value?.reason || '本地 Fairy 服务未启动。', provider };
      const changed = next.available !== availabilitySnapshot.available || next.reason !== availabilitySnapshot.reason || next.provider !== availabilitySnapshot.provider;
      availabilitySnapshot = changed ? next : availabilitySnapshot;
      availabilityCheckedAt = Date.now();
      if (changed) availabilityListeners.forEach((listener) => listener());
      window.dispatchEvent(new CustomEvent(EVENT_AVAILABILITY, { detail: availabilitySnapshot }));
      return availabilitySnapshot;
    }

    /** The active provider decides who speaks: the browser provider has no
     * host-side engine, so it is served by speechSynthesis end to end. */
    function speechOwnerOf(availability) {
      return availability?.provider === 'browser' ? 'system' : 'fairy';
    }

    function requestAvailability(force = false) {
      if (availabilityRequest) return availabilityRequest;
      if (!force && availabilityCheckedAt && Date.now() - availabilityCheckedAt < AVAILABILITY_TTL_MS) {
        return Promise.resolve(availabilitySnapshot);
      }
      const controller = new AbortController();
      availabilityController = controller;
      const request = getAvailability(controller.signal)
        .catch((error) => {
          if (controller.signal.aborted) return availabilitySnapshot;
          return { available: false, reason: error?.message || '本地 Fairy 服务未启动。' };
        })
        .then((value) => controller.signal.aborted ? availabilitySnapshot : publishAvailability(value))
        .finally(() => {
          if (availabilityController === controller) availabilityController = null;
          if (availabilityRequest === request) availabilityRequest = null;
        });
      availabilityRequest = request;
      return request;
    }

    const availabilityStore = {
      getSnapshot: () => availabilitySnapshot,
      subscribe(listener) { availabilityListeners.add(listener); return () => availabilityListeners.delete(listener); },
    };

    function disposeAvailability() {
      availabilityController?.abort('disposed');
      availabilityController = null;
      availabilityRequest = null;
      availabilitySnapshot = INITIAL_AVAILABILITY;
      availabilityCheckedAt = 0;
      availabilityListeners.clear();
    }

    const getVoiceBrainStatus = () => voiceBrainClient.status();
    const createVoiceBrief = (markdown, signal) => voiceBrainClient.brief(markdown, signal);
    function requestVoiceBrainConfig(payload) {
      return voiceBrainClient.config(payload);
    }

    function reportText(phase, userSeq, turn, reportCount) {
      const options = VOICE_REPORTS[phase] || VOICE_REPORTS.working;
      const index = Math.abs((Number(userSeq) || 0) + (Number(turn) || 0) + (Number(reportCount) || 0) - 1) % options.length;
      return options[index];
    }

    function createAutoReadPolicy({ autoRead, audioReady, available, activity, silencedTurn, userSeq }) {
      return Boolean(autoRead && audioReady && available && activity?.running && activity?.phase && silencedTurn !== userSeq);
    }

    function useVoiceBrain({ sessionKey, timeline, baselineReady, autoRead, audioReady, available }) {
      const state = React.useRef({ key: null, userSeq: 0, timer: null, epoch: 0, phase: null, activeTurn: 0, phaseStartedAt: 0, reports: 0, lastReportAt: 0, silencedTurn: null });
      const latest = React.useRef({ sessionKey, timeline, baselineReady, autoRead, audioReady, available });
      latest.current = { sessionKey, timeline, baselineReady, autoRead, audioReady, available };
      const clearTimer = React.useCallback(() => {
        const current = state.current;
        if (current.timer) clearTimeout(current.timer);
        current.timer = null;
        current.epoch += 1;
      }, []);

      React.useEffect(() => {
        const current = state.current;
        if (current.key !== sessionKey) {
          clearTimer();
          state.current = { key: sessionKey, userSeq: timeline.userSeq, timer: null, epoch: current.epoch + 1, phase: null, activeTurn: 0, phaseStartedAt: 0, reports: 0, lastReportAt: 0, silencedTurn: null };
        }
        const policy = state.current;
        if (!baselineReady) {
          clearTimer();
          policy.userSeq = timeline.userSeq;
          return;
        }
        if (timeline.userSeq !== policy.userSeq) {
          clearTimer();
          policy.userSeq = timeline.userSeq;
          policy.phase = null;
          policy.activeTurn = 0;
          policy.phaseStartedAt = 0;
          policy.reports = 0;
          policy.lastReportAt = 0;
          policy.silencedTurn = null;
        }
        const phase = timeline.activity.phase;
        const activeTurn = timeline.activity.turn;
        const canReport = createAutoReadPolicy({
          autoRead,
          audioReady,
          available,
          activity: timeline.activity,
          silencedTurn: policy.silencedTurn,
          userSeq: timeline.userSeq,
        });
        if (!canReport) {
          clearTimer();
          policy.phase = null;
          return;
        }
        if (policy.phase !== phase || policy.activeTurn !== activeTurn) {
          clearTimer();
          policy.phase = phase;
          policy.activeTurn = activeTurn;
          policy.phaseStartedAt = Date.now();
        }
        // A long-running search/thinking turn has no fixed duration. Keep one
        // low-frequency heartbeat scheduled for as long as DSH reports live
        // activity; the activity boundary and lifecycle cancellation stop it.
        if (policy.timer) return;
        const now = Date.now();
        const eligibleAt = Math.max(policy.phaseStartedAt + VOICE_REPORT_DELAY_MS, policy.lastReportAt + VOICE_REPORT_COOLDOWN_MS);
        const epoch = policy.epoch;
        const reportUserSeq = timeline.userSeq;
        const schedule = (delay) => {
          policy.timer = setTimeout(() => {
          const fresh = latest.current;
          const live = state.current;
          live.timer = null;
          if (live.epoch !== epoch || fresh.sessionKey !== sessionKey || fresh.timeline.userSeq !== reportUserSeq) return;
          if (!fresh.baselineReady || !fresh.autoRead || !fresh.audioReady || !fresh.available) return;
          if (!fresh.timeline.activity.running || fresh.timeline.activity.phase !== phase || live.silencedTurn === reportUserSeq) return;
          live.reports += 1;
          live.lastReportAt = Date.now();
          window.dispatchEvent(new CustomEvent(EVENT_PLAY, {
            detail: {
              kind: 'status', priority: 10, sessionKey,
              messageId: `fairy-status:${reportUserSeq}:${phase}:${live.reports}`,
              markdown: reportText(phase, reportUserSeq, fresh.timeline.activity.turn, live.reports)
            }
          }));
          if (live.phase === phase && live.silencedTurn !== reportUserSeq) {
            schedule(VOICE_REPORT_COOLDOWN_MS);
          }
          }, Math.max(0, delay));
        };
        schedule(Math.max(0, eligibleAt - now));
      }, [sessionKey, timeline, baselineReady, autoRead, audioReady, available, clearTimer]);

      React.useEffect(() => {
        const onVoiceCommand = (event) => {
          const detail = event.detail || {};
          if (detail.sessionKey !== sessionKey || (!detail.stop && detail.kind === 'status')) return;
          clearTimer();
          state.current.silencedTurn = latest.current.timeline.userSeq;
        };
        window.addEventListener(EVENT_PLAY, onVoiceCommand);
        window.addEventListener('pagehide', clearTimer);
        return () => {
          window.removeEventListener(EVENT_PLAY, onVoiceCommand);
          window.removeEventListener('pagehide', clearTimer);
          clearTimer();
        };
      }, [sessionKey, clearTimer]);
    }

    /** 设置卡里的只读状态行：左标签、右取值；取值可以带一个 DOM 契约属性。 */
    function AskStatusRow({ label, value, attributes }) {
      return jsx.jsxs('div', {
        style: { ...ASK_STYLE.line, justifyContent: 'space-between' },
        children: [
          jsx.jsx('span', { style: ASK_STYLE.label, children: label }),
          jsx.jsx('span', { style: { ...ASK_STYLE.status, textAlign: 'right' }, ...attributes, children: value })
        ]
      });
    }

    /** 受控取值：草稿里改过的键用草稿的，没碰过就回落到已保存的值。 */
    function askFieldValue(draft, fields, name) {
      const edited = draft?.[name];
      if (typeof edited === 'string') return edited;
      return typeof fields?.[name] === 'string' ? fields[name] : '';
    }

    /** 已保存配置里某个提供方占的那一节（没有就是空对象）。 */
    function providerSectionOf(config, option) {
      return (option.key ? config?.providers?.[option.key] : null) || {};
    }

    /** `useAskForm` 的初始草稿：草稿只装"用户改过的键"，已保存值从 stored 读。 */
    const EMPTY_ASK_DRAFT = Object.freeze({});
    const BRAIN_ASK_DRAFT = Object.freeze({ apiKey: '' });

    /** 设置卡的失败原因已经在状态行里说清了，这里只留一条诊断，别让 rejection 无声落地。 */
    function reportAskActionFailure(operation, error) {
      diagnostics.warn('ask.action', { operation }, error);
    }

    function VoiceBrainSection() {
      const [threshold, setThreshold] = React.useState(readStoredBriefThreshold);
      const [removal, setRemoval] = React.useState(null);
      const changeThreshold = (raw) => {
        const next = Math.max(0, Math.min(5000, Math.round(Number(raw) || 0)));
        setThreshold(next);
        briefThreshold.value = next;
        localStorage.setItem(SETTINGS_BRIEF_THRESHOLD, String(next));
      };
      // 读/写/忙/状态都走同一份状态机：挂载读一次、保存成功后复读一次，不轮询。
      const form = askKit.useAskForm({
        load: getVoiceBrainStatus,
        save: async (draft) => {
          const apiKey = String(draft.apiKey ?? '').trim();
          if (!apiKey) return { changed: false };
          return { changed: true, value: await requestVoiceBrainConfig({ apiKey }) };
        },
        onSaved: (outcome) => { window.dispatchEvent(new CustomEvent(EVENT_BRAIN_CONFIG, { detail: outcome.value })); },
        initial: BRAIN_ASK_DRAFT
      });
      const configured = form.stored?.configured === true;
      /** 移除密钥是一次性动作，走同一条忙通道；写完复读一次让连接状态跟上。 */
      const removeKey = () => form.run('remove', async () => {
        setRemoval(null);
        try {
          const value = await requestVoiceBrainConfig({ clear: true });
          window.dispatchEvent(new CustomEvent(EVENT_BRAIN_CONFIG, { detail: value }));
          form.reload();
        } catch (removeError) {
          setRemoval({ ok: false, text: askKit.describeError(removeError) });
        }
      });
      return jsx.jsx(askKit.AskSection, {
        title: 'Fairy 语音简报',
        description: [
          '仅用于压缩较长的最终回答，帮助 Fairy 更自然地朗读。搜索、思考、工具执行和过程汇报不会发送给模型。',
          '固定模型：DeepSeek V4 Flash。未配置、超时或请求失败时，自动回退到本地原文朗读。'
        ],
        children: jsx.jsxs('div', { style: ASK_STYLE.panel, children: [
          jsx.jsx(AskStatusRow, { label: '连接状态', value: configured ? '已配置 · deepseek-v4-flash' : '未配置' }),
          jsx.jsx(askKit.AskRow, {
            id: 'fairy-voice-brief-threshold',
            label: '简报触发字数',
            hint: '超过该字数的最终回答会先压成口语简报再朗读；填 0 表示每次都先简报。',
            children: jsx.jsx(askKit.AskText, {
              id: 'fairy-voice-brief-threshold', type: 'number', value: String(threshold), onChange: changeThreshold
            })
          }),
          jsx.jsx(askKit.AskRow, {
            id: 'fairy-voice-brain-key',
            label: 'DeepSeek API Key',
            hint: '密钥仅存于本机，不会在页面回显。',
            children: jsx.jsx(askKit.AskText, {
              id: 'fairy-voice-brain-key', type: 'password', autoComplete: 'new-password',
              value: form.draft.apiKey ?? '',
              placeholder: configured ? '输入新 API Key 以替换当前密钥' : '输入 DeepSeek API Key',
              onChange: (value) => form.change('apiKey', value)
            })
          }),
          jsx.jsx(askKit.AskActions, {
            busy: form.busy,
            status: form.status,
            secondary: configured ? '移除密钥' : null,
            onPrimary: () => form.submit().catch((error) => { reportAskActionFailure('voice-brain save', error); }),
            onSecondary: removeKey
          }),
          jsx.jsx(askKit.AskResult, { ok: removal?.ok, text: removal?.text || '' })
        ] })
      });
    }

    const VOICE_ENGINE_PROVIDERS = [
      {
        id: 'local-sovits',
        label: '本地 GPT-SoVITS',
        key: 'localSovits',
        fields: [
          { name: 'baseURL', label: '服务地址', placeholder: 'http://127.0.0.1:9880' },
          { name: 'referenceAudioPath', label: '参考音频路径' },
          { name: 'referencePromptPath', label: '参考文本路径' }
        ]
      },
      {
        id: 'openai',
        label: 'OpenAI 兼容接口',
        key: 'openai',
        fields: [
          { name: 'baseURL', label: '服务地址', placeholder: 'https://api.openai.com/v1' },
          { name: 'apiKey', label: 'API Key', secret: true },
          { name: 'model', label: '模型', placeholder: 'tts-1' },
          { name: 'voice', label: '音色', placeholder: 'alloy' }
        ]
      },
      {
        id: 'custom-http',
        label: '自定义 HTTP 服务',
        key: 'customHttp',
        fields: [
          { name: 'url', label: '请求地址', placeholder: 'http://127.0.0.1:9100/speak' },
          { name: 'method', label: '请求方法', placeholder: 'POST' },
          { name: 'headersJson', label: '静态请求头 JSON', placeholder: '{"Authorization":"Bearer …"}' },
          { name: 'bodyTemplate', label: '请求体模板', placeholder: '{"text":"{{text}}"}' }
        ]
      },
      {
        id: 'elevenlabs-ws',
        label: 'ElevenLabs（WebSocket 流式）',
        key: 'elevenlabsWs',
        fields: [
          { name: 'apiKey', label: 'API Key', secret: true },
          { name: 'voiceId', label: '音色 ID', placeholder: '21m00Tcm4TlvDq8ikWAM' },
          { name: 'modelId', label: '模型', placeholder: 'eleven_multilingual_v2' },
          { name: 'outputFormat', label: '输出格式', placeholder: 'pcm_32000' },
          { name: 'baseUrl', label: '服务地址', placeholder: 'wss://api.elevenlabs.io' }
        ]
      },
      {
        id: 'kitten-web',
        label: 'KittenTTS-Nano（浏览器内 WASM，约 25MB）',
        key: 'kittenWeb',
        fields: [
          { name: 'moduleUrl', label: '模块地址（仅填可信来源，会在页面内执行）', placeholder: 'https://esm.sh/kitten-tts-js@0.1.2' },
          { name: 'modelId', label: '模型 ID', placeholder: 'KittenML/kitten-tts-nano-0.8（micro/mini 可换）' },
          { name: 'voice', label: '音色', placeholder: 'Bella / Luna / Rosie / Kiki / Leo / Jasper / Bruno / Hugo' },
          { name: 'resourceBase', label: '资源镜像（可选，HF 不可达时填）', placeholder: 'https://hf-mirror.com' }
        ]
      },
      {
        id: 'kokoro-web',
        label: 'Kokoro（浏览器内 WebGPU/WASM）',
        key: 'kokoroWeb',
        fields: [
          { name: 'moduleUrl', label: '模块地址（仅填可信来源，会在页面内执行）', placeholder: 'https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/+esm' },
          { name: 'modelId', label: '模型 ID', placeholder: 'onnx-community/Kokoro-82M-v1.0-ONNX' },
          { name: 'device', label: '设备', placeholder: 'wasm 或 webgpu' },
          { name: 'dtype', label: '精度', placeholder: 'q8（WASM）或 fp32（WebGPU）' },
          { name: 'voice', label: '音色', placeholder: 'af_heart' },
          { name: 'resourceBase', label: '资源镜像（可选，HF 不可达时填）', placeholder: 'https://hf-mirror.com' }
        ]
      },
      {
        id: 'piper-web',
        label: 'Piper（浏览器内 WASM）',
        key: 'piperWeb',
        fields: [
          { name: 'moduleUrl', label: '模块地址（仅填可信来源，会在页面内执行）', placeholder: 'https://cdn.jsdelivr.net/npm/@realtimex/piper-tts-web@1.1.1/+esm' },
          { name: 'voiceId', label: '音色 ID', placeholder: 'en_US-hfc_female-medium' },
          { name: 'resourceBase', label: '资源镜像（可选，HF 不可达时填）', placeholder: 'https://hf-mirror.com' }
        ]
      },
      { id: 'browser', label: '浏览器朗读', key: null, fields: [] },
      { id: 'pocket-tts', label: 'Pocket TTS（本地服务，Kyutai）', key: 'pocketTts', fields: [ { name: 'baseUrl', label: '服务地址', placeholder: 'http://127.0.0.1:8000（uvx pocket-tts serve）' }, { name: 'voice', label: '音色（可空=服务端默认）', placeholder: 'alba / marius / estelle / lola / giovanni …' } ] },
    ];

    function engineOption(id) {
      return VOICE_ENGINE_PROVIDERS.find((entry) => entry.id === id) || VOICE_ENGINE_PROVIDERS[0];
    }

    function VoiceEngineSection() {
      const [availability, setAvailability] = React.useState([]);
      const [probe, setProbe] = React.useState(null);
      const [audition, setAudition] = React.useState({ status: 'idle', error: null });
      const [model, setModel] = React.useState({ status: 'idle', error: null, note: '' });
      const [alwaysControls, setAlwaysControls] = React.useState(() => localStorage.getItem(SETTINGS_ALWAYS_CONTROLS) === 'true');
      const toggleAlwaysControls = (next) => {
        setAlwaysControls(next);
        localStorage.setItem(SETTINGS_ALWAYS_CONTROLS, String(next));
        window.dispatchEvent(new CustomEvent(EVENT_ALWAYS_CONTROLS, { detail: next }));
      };
      // ponytail: availability refreshes on mount, after a save, and on demand.
      // Polling would spend one probe per interval on a value that rarely moves.
      const refreshAvailability = React.useCallback((signal) => localTtsTransport.providers(signal)
        .then((value) => { setAvailability(value); setProbe(null); })
        .catch((probeError) => {
          setAvailability([]);
          setProbe({ ok: false, text: probeError?.message || '无法读取提供方可用性。' });
        }), []);
      /** 选中的提供方：草稿优先，其次是已保存的值。 */
      const optionFor = (draft, stored) => engineOption(
        typeof draft?.provider === 'string'
          ? draft.provider
          : (typeof stored?.provider === 'string' ? stored.provider : VOICE_ENGINE_PROVIDERS[0].id)
      );
      const form = askKit.useAskForm({
        load: () => { refreshAvailability(); return localTtsTransport.providerConfig(); },
        save: async (draft, stored) => {
          const target = optionFor(draft, stored);
          const storedFields = providerSectionOf(stored, target);
          const values = {};
          for (const field of target.fields) values[field.name] = askFieldValue(draft, storedFields, field.name);
          const untouched = optionFor({}, stored).id === target.id
            && target.fields.every((field) => values[field.name] === askFieldValue({}, storedFields, field.name));
          if (untouched) return { changed: false };
          const value = await localTtsTransport.saveProviderConfig(target.key
            ? { provider: target.id, providers: { [target.key]: values } }
            : { provider: target.id });
          return { changed: true, value };
        },
        // 保存后复读已由状态机做了，这里只补上"读的是哪个提供方"和常驻控件闸门。
        onSaved: () => { refreshAvailability(); requestAvailability(true); },
        initial: EMPTY_ASK_DRAFT
      });
      const option = optionFor(form.draft, form.stored);
      const provider = option.id;
      const storedFields = providerSectionOf(form.stored, option);
      const availabilityById = new Map(availability.map((entry) => [entry.id, entry]));
      const selectProvider = (id) => {
        form.change('provider', id);
        // 换提供方就丢掉上一个提供方留下的同名字段，回到已保存的值。
        for (const field of engineOption(id).fields) form.change(field.name, undefined);
      };
      const saveEngineConfig = () => form.submit().catch((error) => { reportAskActionFailure('voice engine save', error); });
      const auditionOnce = () => form.run('test', async () => {
        setAudition({ status: 'working', error: null });
        try {
          if (provider === 'browser') {
            await speakSampleWithSystem();
          } else if (isLocalEngine(provider)) {
            const engineSettings = localEngineConfig(form.stored, provider);
            const handle = await openLocalEngine(provider, engineSettings);
            const clip = await synthesizeLocalEngine(handle, AUDITION_TEXT, engineSettings, scratchContext());
            await playSamplesOnce(clip.samples, clip.sampleRate);
          } else {
            const response = await localTtsTransport.stream(AUDITION_TEXT);
            if (!response.ok) {
              const value = await response.json().catch(() => null);
              throw new Error(value?.error?.message || '试听失败。');
            }
            const sampleRate = Number(response.headers?.get?.('x-fairy-sample-rate')) || PCM_SAMPLE_RATE;
            await playSamplesOnce(pcmBytesToSamples(new Uint8Array(await response.arrayBuffer())), sampleRate);
          }
          setAudition({ status: 'idle', error: null });
        } catch (auditionError) {
          setAudition({ status: 'error', error: auditionError?.message || '试听失败。' });
        }
      });
      /** 模型自行下载的显式入口：走的是与朗读完全相同的加载路径
       *  （openLocalEngine 按配置缓存），所以它既预热缓存，也把"加载期失败"
       *  从静默降级变成看得见、可重试的一步。 */
      const downloadModel = () => form.run('model', async () => {
        setModel({ status: 'working', error: null, note: '' });
        const startedAt = Date.now();
        try {
          await openLocalEngine(provider, localEngineConfig(form.stored, provider));
          setModel({ status: 'ready', error: null, note: `已缓存（${((Date.now() - startedAt) / 1000).toFixed(1)}s）` });
        } catch (downloadError) {
          setModel({ status: 'error', error: downloadError?.message || '模型下载失败。', note: '' });
        }
      });
      const probeNow = () => form.run('probe', refreshAvailability);
      return jsx.jsx(askKit.AskSection, {
        title: '语音引擎',
        description: ['决定 Fairy 由谁合成朗读。浏览器朗读完全在当前浏览器内完成，不需要本机服务；其余提供方的配置只保存在本机。'],
        children: jsx.jsxs('div', { style: ASK_STYLE.panel, children: [
          jsx.jsx(askKit.AskRow, {
            id: 'fairy-voice-engine-provider',
            label: '提供方',
            children: jsx.jsx(askKit.AskSelect, {
              id: 'fairy-voice-engine-provider',
              value: provider,
              options: VOICE_ENGINE_PROVIDERS.map((entry) => ({ value: entry.id, label: entry.label })),
              onChange: selectProvider
            })
          }),
          ...option.fields.map((field) => {
            const id = `fairy-voice-engine-${field.name}`;
            const value = askFieldValue(form.draft, storedFields, field.name);
            return jsx.jsx(askKit.AskRow, {
              id,
              label: field.label,
              children: jsx.jsx(askKit.AskText, {
                id,
                type: field.secret ? 'password' : 'text',
                autoComplete: field.secret ? 'new-password' : 'off',
                value,
                placeholder: field.secret && value === '***' ? '输入新值以替换已存密钥' : field.placeholder || '',
                onChange: (next) => form.change(field.name, next)
              })
            }, field.name);
          }),
          jsx.jsxs('div', { style: ASK_STYLE.panel, children: VOICE_ENGINE_PROVIDERS.map((entry) => {
            const current = availabilityById.get(entry.id);
            return jsx.jsx(AskStatusRow, {
              label: entry.label,
              value: current?.available === true ? '可用' : `不可用 · ${current?.reason || '未检查'}`,
              attributes: { 'data-dsh-fairy-engine-available': entry.id }
            }, `availability-${entry.id}`);
          }) }),
          jsx.jsx(askKit.AskActions, {
            busy: form.busy,
            status: form.status,
            secondary: '试听一句',
            onPrimary: saveEngineConfig,
            onSecondary: auditionOnce
          }),
          jsx.jsx(askKit.AskResult, { ok: audition.status !== 'error', text: audition.status === 'error' ? `试听失败：${audition.error}` : '' }),
          jsx.jsx(askKit.AskActions, {
            busy: form.busy, status: probe?.text || '', primary: '刷新可用性', onPrimary: probeNow
          }),
          isLocalEngine(provider) ? jsx.jsx(askKit.AskActions, {
            busy: form.busy,
            status: model.status === 'ready' ? model.note : model.status === 'error' ? `失败：${model.error}` : '模型未下载（首次朗读时才会拉取）',
            primary: model.status === 'working' ? '下载中…' : '下载模型（缓存到本机）',
            onPrimary: downloadModel
          }) : null,
          jsx.jsx(askKit.AskToggle, {
            id: 'fairy-voice-always-controls',
            label: '始终显示朗读与语音控件（不依赖 H.D.D 视觉模式）',
            checked: alwaysControls,
            onChange: toggleAlwaysControls
          })
        ] })
      });
    }

    const VOICE_STT_PROVIDERS = [
      {
        id: 'browser',
        label: '浏览器识别（在线·免配置）',
        key: 'browser',
        fields: [{ name: 'lang', label: '识别语言', placeholder: 'zh-CN' }]
      },
      {
        id: 'whisper-web',
        label: 'Whisper 本地（浏览器内，离线可用）',
        key: 'whisperWeb',
        fields: [
          { name: 'moduleUrl', label: '模块地址（仅填可信来源，会在页面内执行）', placeholder: 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/+esm' },
          { name: 'modelId', label: '模型 ID', placeholder: 'onnx-community/whisper-base' },
          { name: 'device', label: '设备', placeholder: 'wasm 或 webgpu' },
          { name: 'dtype', label: '精度', placeholder: 'q8（WASM）或 fp32（WebGPU）' },
          { name: 'language', label: '识别语言', placeholder: 'chinese / english / auto' },
          { name: 'resourceBase', label: '资源镜像（可选，HF 不可达时填）', placeholder: 'https://hf-mirror.com' }
        ]
      },
      {
        id: 'deepgram',
        label: 'Deepgram（在线）',
        key: 'deepgram',
        fields: [
          { name: 'apiKey', label: 'API Key', secret: true },
          { name: 'model', label: '模型', placeholder: 'nova-3' },
          { name: 'language', label: '识别语言', placeholder: 'zh-CN' },
          { name: 'baseUrl', label: '服务地址', placeholder: 'https://api.deepgram.com' }
        ]
      },
      {
        id: 'azure',
        label: 'Azure 语音（在线）',
        key: 'azure',
        fields: [
          { name: 'endpoint', label: '终结点', placeholder: 'https://<region>.api.cognitive.microsoft.com' },
          { name: 'apiKey', label: 'API Key', secret: true },
          { name: 'locale', label: '识别区域', placeholder: 'zh-CN' }
        ]
      },
      {
        id: 'openai',
        label: 'OpenAI Whisper（/audio/transcriptions）',
        key: 'openai',
        fields: [
          { name: 'baseURL', label: '服务地址', placeholder: 'https://api.openai.com/v1' },
          { name: 'apiKey', label: 'API Key', secret: true },
          { name: 'model', label: '模型', placeholder: 'whisper-1' },
          { name: 'language', label: '识别语言', placeholder: 'zh' }
        ]
      },
      {
        id: 'custom-http',
        label: '自定义 HTTP 服务',
        key: 'customHttp',
        fields: [
          { name: 'url', label: '请求地址', placeholder: 'http://127.0.0.1:9200/transcribe' },
          { name: 'headersJson', label: '静态请求头 JSON', placeholder: '{}' },
          { name: 'responsePath', label: '响应文本路径', placeholder: 'text' }
        ]
      }
    ];

    function sttOption(id) {
      return VOICE_STT_PROVIDERS.find((entry) => entry.id === id) || VOICE_STT_PROVIDERS[0];
    }

    function VoiceSttSection() {
      const [availability, setAvailability] = React.useState([]);
      const [probe, setProbe] = React.useState(null);
      const refreshAvailability = React.useCallback((signal) => localTtsTransport.sttProviders(signal)
        .then((value) => { setAvailability(value); setProbe(null); })
        .catch((probeError) => {
          setAvailability([]);
          setProbe({ ok: false, text: probeError?.message || '无法读取识别提供方可用性。' });
        }), []);
      /** 选中的提供方：草稿优先，其次是已保存的值。 */
      const optionFor = (draft, stored) => sttOption(
        typeof draft?.provider === 'string' ? draft.provider : sttProviderId(stored)
      );
      const form = askKit.useAskForm({
        load: () => { refreshAvailability(); return localTtsTransport.sttConfig(); },
        save: async (draft, stored) => {
          const target = optionFor(draft, stored);
          const storedFields = providerSectionOf(stored, target);
          const values = {};
          for (const field of target.fields) values[field.name] = askFieldValue(draft, storedFields, field.name);
          const untouched = optionFor({}, stored).id === target.id
            && target.fields.every((field) => values[field.name] === askFieldValue({}, storedFields, field.name));
          if (untouched) return { changed: false };
          const value = await localTtsTransport.saveSttConfig({ provider: target.id, providers: { [target.key]: values } });
          return { changed: true, value };
        },
        onSaved: () => { refreshAvailability(); },
        initial: EMPTY_ASK_DRAFT
      });
      const option = optionFor(form.draft, form.stored);
      const provider = option.id;
      const storedFields = providerSectionOf(form.stored, option);
      const availabilityById = new Map(availability.map((entry) => [entry.id, entry]));
      const recognitionSupported = typeof window !== 'undefined' && speechRecognitionCtor() !== null;
      const selectProvider = (id) => {
        form.change('provider', id);
        // 换提供方就丢掉上一个提供方留下的同名字段，回到已保存的值。
        for (const field of sttOption(id).fields) form.change(field.name, undefined);
      };
      const saveSttConfig = () => form.submit().catch((error) => { reportAskActionFailure('voice stt save', error); });
      const probeNow = () => form.run('probe', refreshAvailability);
      return jsx.jsx(askKit.AskSection, {
        title: 'Fairy 语音输入',
        description: [
          '把说话转成文字并写入输入框（写入后由你确认再发送）。本地路径：Whisper 在浏览器内离线识别，或把 OpenAI 兼容地址指向本机服务（whisper.cpp server / faster-whisper / speaches）。在线路径：浏览器识别、Deepgram、Azure。密钥只保存在本机。',
          ...(recognitionSupported ? [] : ['当前浏览器不支持内置语音识别，请选择 Whisper 或自定义 HTTP 提供方。'])
        ],
        children: jsx.jsxs('div', { style: ASK_STYLE.panel, children: [
          jsx.jsx(askKit.AskRow, {
            id: 'fairy-voice-stt-provider',
            label: '提供方',
            children: jsx.jsx(askKit.AskSelect, {
              id: 'fairy-voice-stt-provider',
              value: provider,
              options: VOICE_STT_PROVIDERS.map((entry) => ({ value: entry.id, label: entry.label })),
              onChange: selectProvider
            })
          }),
          ...option.fields.map((field) => {
            const id = `fairy-voice-stt-${field.name}`;
            const value = askFieldValue(form.draft, storedFields, field.name);
            return jsx.jsx(askKit.AskRow, {
              id,
              label: field.label,
              children: jsx.jsx(askKit.AskText, {
                id,
                type: field.secret ? 'password' : 'text',
                autoComplete: field.secret ? 'new-password' : 'off',
                value,
                placeholder: field.secret && value === '***' ? '输入新值以替换已存密钥' : field.placeholder || '',
                onChange: (next) => form.change(field.name, next)
              })
            }, field.name);
          }),
          jsx.jsx(askKit.AskActions, {
            busy: form.busy,
            status: form.status,
            onPrimary: saveSttConfig
          }),
          jsx.jsx(askKit.AskActions, {
            busy: form.busy, status: probe?.text || '', primary: '刷新可用性', onPrimary: probeNow
          }),
          jsx.jsxs('div', { style: ASK_STYLE.panel, children: VOICE_STT_PROVIDERS.map((entry) => {
            const current = availabilityById.get(entry.id);
            return jsx.jsx(AskStatusRow, {
              label: entry.label,
              value: current?.available === true ? '可用' : `不可用 · ${current?.reason || '未检查'}`,
              attributes: { 'data-dsh-fairy-stt-available': entry.id }
            }, `stt-availability-${entry.id}`);
          }) })
        ] })
      });
    }

    function usePlayer(sessionKey) {
      const [state, setState] = React.useState({ status: 'idle', messageId: null, error: null });
      const work = React.useRef({ controller: null, audio: null, context: null, gain: null, sources: new Set(), urls: new Set(), stopped: false });
      const idleSuspendTimer = React.useRef(null);
      const publish = React.useCallback((next) => {
        const scoped = dispatchVoiceState({ ...next, sessionKey });
        setState(scoped);
      }, [sessionKey]);
      const clearIdleSuspend = React.useCallback(() => {
        if (idleSuspendTimer.current) clearTimeout(idleSuspendTimer.current);
        idleSuspendTimer.current = null;
      }, []);
      const suspendWhenIdle = React.useCallback((context) => {
        clearIdleSuspend();
        if (!context || context.state !== 'running') return;
        idleSuspendTimer.current = setTimeout(() => {
          idleSuspendTimer.current = null;
          const current = work.current;
          if (current.context !== context || current.sources.size || context.state !== 'running') return;
          context.suspend().catch((error) => reportAudioLifecycleFailure('suspend', error));
        }, 0);
      }, [clearIdleSuspend]);
      /* One playback rate for every engine: the Web Audio sources carry it
       * (buffer.duration is rate-independent, so the timeline divides by it)
       * and system speech reads it per utterance. */
      const rateRef = React.useRef(BROWSER_SPEECH_RATE);
      const setSpeechRate = React.useCallback((value) => { rateRef.current = clampSpeechRate(value); }, []);
      const unlockAudio = React.useCallback(async (initialVolume = 1) => {
        clearIdleSuspend();
        const current = work.current;
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextClass) throw new Error('Web Audio is unavailable in this browser.');
        if (!current.context || current.context.state === 'closed') {
          current.context = new AudioContextClass({ sampleRate: PCM_SAMPLE_RATE });
          current.gain = current.context.createGain();
          current.gain.gain.value = initialVolume;
          current.gain.connect(current.context.destination);
        } else if (current.gain) {
          const now = current.context.currentTime;
          current.gain.gain.cancelScheduledValues(now);
          current.gain.gain.setValueAtTime(initialVolume, now);
        }
        await current.context.resume();
        return current.context;
      }, [clearIdleSuspend]);
      const primeAudio = React.useCallback(async (initialVolume = 1) => {
        const context = await unlockAudio(initialVolume);
        suspendWhenIdle(context);
        return context;
      }, [suspendWhenIdle, unlockAudio]);
      const stop = React.useCallback(() => {
        const current = work.current;
        current.stopped = true;
        current.controller?.abort();
        if (current.audio) { current.audio.pause(); current.audio.src = ''; }
        const now = current.context?.state !== 'closed' ? current.context?.currentTime : null;
        if (current.gain && current.context && now !== null) {
          try {
            const currentGain = Number(current.gain.gain.value) || 0;
            current.gain.gain.cancelScheduledValues(now);
            current.gain.gain.setValueAtTime(currentGain, now);
            current.gain.gain.linearRampToValueAtTime(0, now + STOP_FADE_SECONDS);
          } catch (error) { reportAudioLifecycleFailure('fade out', error); }
        }
        for (const source of current.sources) {
          try { source.stop(now === null ? undefined : now + STOP_FADE_SECONDS); } catch (error) { reportAudioLifecycleFailure('source stop', error); }
          try { source.onended = null; source.disconnect(); } catch (error) { reportAudioLifecycleFailure('source disconnect', error); }
        }
        window.speechSynthesis?.cancel();
        for (const url of current.urls) URL.revokeObjectURL(url);
        suspendWhenIdle(current.context);
        work.current = { controller: null, audio: null, context: current.context, gain: current.gain, sources: new Set(), urls: new Set(), stopped: false };
        reportAudioResources(current, 'stop');
        publish({ status: 'stopped', messageId: null, error: null });
      }, [publish, suspendWhenIdle]);
      const setOutputVolume = React.useCallback((value) => {
        const current = work.current;
        const gain = current.gain;
        const context = current.context;
        if (gain && context && context.state !== 'closed') {
          gain.gain.setTargetAtTime(value, context.currentTime, 0.015);
        }
      }, []);
      const playSystem = React.useCallback((messageId, sentences, volume) => {
        if (!sentences.length || !window.speechSynthesis) {
          publish({ status: 'error', messageId, error: 'System speech is unavailable in this browser.' });
          return Promise.resolve(false);
        }
        const current = work.current;
        let index = 0;
        // Chrome stops long utterances at ~15s. A pause/resume nudge keeps the
        // engine awake; it is a no-op for short sentences and for engines that
        // never hit the bug, so it runs for Blink only.
        const blink = typeof navigator !== 'undefined' && /\b(Chrome|Chromium|Edg\/|Brave)\b/.test(navigator.userAgent || '');
        let bump = null;
        const stopBump = () => { if (bump !== null) { clearInterval(bump); bump = null; } };
        const startBump = () => {
          if (!blink || bump !== null) return;
          bump = setInterval(() => {
            const synth = window.speechSynthesis;
            if (!synth?.speaking) return;
            try { synth.pause(); synth.resume(); } catch (error) { reportAudioLifecycleFailure('speech bump', error); }
          }, BROWSER_SPEECH_BUMP_MS);
        };
        return new Promise((resolve) => {
          const speakNext = () => {
            if (current.stopped) { stopBump(); resolve(false); return; }
            if (index >= sentences.length) {
              stopBump();
              publish({ status: 'idle', messageId: null, error: null });
              resolve(true);
              return;
            }
            const utterance = new SpeechSynthesisUtterance(sentences[index]);
            const voices = window.speechSynthesis.getVoices();
            utterance.voice = voices.find((voice) => voice.lang.toLowerCase().startsWith('zh')) || null;
            utterance.lang = utterance.voice?.lang || 'zh-CN';
            utterance.rate = rateRef.current;
            utterance.volume = volume;
            utterance.onend = () => { index += 1; speakNext(); };
            utterance.onerror = () => {
              stopBump();
              publish({ status: 'error', messageId, error: 'System speech playback failed.' });
              resolve(false);
            };
            publish({ status: 'playing', messageId, error: null });
            startBump();
            window.speechSynthesis.speak(utterance);
          };
          speakNext();
        });
      }, [publish]);
      const play = React.useCallback(async (messageId, sentences, volume) => {
        if (!sentences.length) return false;
        // Keep the work object captured before the user-gesture unlock. Stop
        // or session replacement can reset work.current while resume() is
        // pending; the old request must not adopt that fresh object and start
        // playback after cancellation.
        const requestedWork = work.current;
        await unlockAudio(volume);
        if (work.current !== requestedWork || requestedWork.stopped) return false;
        const current = requestedWork;
        const controller = new AbortController();
        current.controller = controller;
        current.stopped = false;
        let nextStart = null;
        const scheduler = createWebAudioScheduler({ current, getNextStart: () => nextStart });
        const { waitForPlayback, waitForQueueCapacity } = scheduler;
        const streamRawAudio = async (text) => {
          const response = await localTtsTransport.stream(text, controller.signal);
          if (response.status === 409) {
            const value = await response.json().catch(() => ({}));
            const denied = new Error(value?.error?.message || '浏览器端朗读');
            denied.code = value?.error?.code || 'client-side';
            throw denied;
          }
          if (!response.ok) {
            const value = await response.json().catch(() => ({}));
            const error = new Error(value?.error?.message || 'Speech synthesis failed.');
            error.code = value?.error?.code;
            throw error;
          }
          if (!response.body) throw new Error('Speech synthesis returned no audio.');
          const context = current.context;
          const gain = current.gain;
          if (!context || context.state !== 'running' || !gain) throw new Error('Audio output is unavailable.');
          // A provider may synthesize at a rate other than the local CPU
          // service's. Web Audio resamples a buffer whose rate differs from
          // the context, so announcing the upstream rate is enough.
          const declaredRate = Number(response.headers?.get?.('x-fairy-sample-rate'));
          const sampleRate = Number.isFinite(declaredRate) && declaredRate > 0 ? declaredRate : PCM_SAMPLE_RATE;
          const reader = response.body.getReader();
          let pendingBytes = new Uint8Array(0);
          let receivedSamples = 0;
          if (nextStart === null) nextStart = context.currentTime + PLAYBACK_PREBUFFER_SECONDS;
          const schedulePcm = (bytes) => {
            const sampleCount = bytes.length / PCM_BYTES_PER_SAMPLE;
            const buffer = context.createBuffer(1, sampleCount, sampleRate);
            const samples = buffer.getChannelData(0);
            pcmStreamHandler.decodeInto(bytes, samples);
            applyPcmEdgeRamp(samples);
            receivedSamples += sampleCount;
            const source = context.createBufferSource();
            source.buffer = buffer;
            source.connect(gain);
            source.onended = () => {
              current.sources.delete(source);
              try { source.disconnect(); } catch (error) { reportAudioLifecycleFailure('source disconnect', error); }
              reportAudioResources(current, 'source-ended');
            };
            current.sources.add(source);
            const rate = rateRef.current;
            source.playbackRate.value = rate;
            const startAt = Math.max(nextStart, context.currentTime + PLAYBACK_SCHEDULE_LEAD_SECONDS);
            source.start(startAt);
            nextStart = startAt + buffer.duration / rate;
            publish({ status: 'playing', messageId, error: null });
          };
          const consumePcm = (incoming, final = false) => {
            let bytes = incoming;
            if (pendingBytes.length) {
              bytes = new Uint8Array(pendingBytes.length + incoming.length);
              bytes.set(pendingBytes);
              bytes.set(incoming, pendingBytes.length);
              pendingBytes = new Uint8Array(0);
            }
            const playableLength = pcmStreamHandler.playableLength(bytes);
            if (bytes.length % PCM_BYTES_PER_SAMPLE) {
              pendingBytes = bytes.slice(playableLength);
            }
            if (!playableLength) return;
            // HTTP chunking is arbitrary. Never schedule a few samples as a
            // separate source: it can click, jump, and create needless work.
            if (!final && playableLength < PLAYBACK_MIN_BUFFER_BYTES) {
              const held = new Uint8Array(pendingBytes.length + playableLength);
              held.set(bytes.subarray(0, playableLength));
              held.set(pendingBytes, playableLength);
              pendingBytes = held;
              return;
            }
            schedulePcm(bytes.subarray(0, playableLength));
          };
          try {
            while (true) {
              // Let fetch backpressure reach the server when inference gets
              // ahead of playback. This keeps AudioBufferSource allocation
              // bounded without sacrificing the startup safety buffer.
              await waitForQueueCapacity();
              if (current.stopped) break;
              const { done, value } = await reader.read();
              if (done) {
                if (pendingBytes.length % PCM_BYTES_PER_SAMPLE) throw new Error('Fairy returned an incomplete PCM frame.');
                if (!current.stopped && pendingBytes.length) consumePcm(new Uint8Array(0), true);
                break;
              }
              if (current.stopped) break;
              consumePcm(value);
            }
            if (receivedSamples === 0 && !current.stopped) throw new Error('Fairy returned empty audio.');
          } finally {
            reader.releaseLock();
          }
        };
        let playedGroups = 0;
        try {
          for (let index = 0; index < sentences.length; index += PLAYBACK_GROUP_SIZE) {
            publish({ status: 'loading', messageId, error: null });
            await streamRawAudio(sentences.slice(index, index + PLAYBACK_GROUP_SIZE).join('\n'));
            playedGroups += 1;
            if (current.stopped) return false;
          }
          await waitForPlayback();
          if (current.stopped) return false;
          // A running AudioContext retains a render thread even with no
          // sources. Resume the same context on the next request instead of
          // leaving that idle work alive between replies.
          if (work.current === current && current.context?.state === 'running') {
            clearIdleSuspend();
            await current.context.suspend().catch((error) => reportAudioLifecycleFailure('suspend', error));
          }
          reportAudioResources(current, 'playback-idle');
          publish({ status: 'idle', messageId: null, error: null });
          return true;
        } catch (error) {
          if (error?.code === 'client-side') return 'client-side';
          if (controller.signal.aborted || current.stopped) return;
          // The browser finishes what the host engine could not: a provider
          // that dies mid-read degrades to system speech for the remainder
          // instead of leaving the answer half-spoken.
          const remaining = sentences.slice(playedGroups * PLAYBACK_GROUP_SIZE);
          if (remaining.length && window.speechSynthesis) {
            const finished = await playSystem(messageId, remaining, volume);
            if (finished === true) return true;
          }
          publish({ status: 'error', messageId, error: error instanceof Error ? error.message : 'Speech synthesis failed.' });
          return false;
        }
      }, [clearIdleSuspend, playSystem, publish, unlockAudio]);

      /* Local engine playback: same scheduler and stop semantics as the host
       * path, but each group is synthesized here. A failure at group k hands
       * groups k..n to system speech, mirroring the host-path degradation. */
      const playLocalEngine = React.useCallback(async (engineId, messageId, sentences, volume) => {
        if (!sentences.length || !isLocalEngine(engineId)) return false;
        const requestedWork = work.current;
        await unlockAudio(volume);
        if (work.current !== requestedWork || requestedWork.stopped) return false;
        const current = requestedWork;
        const controller = new AbortController();
        current.controller = controller;
        current.stopped = false;
        let nextStart = null;
        const scheduler = createWebAudioScheduler({ current, getNextStart: () => nextStart });
        const { waitForPlayback, waitForQueueCapacity } = scheduler;
        let playedGroups = 0;
        const scheduleSamples = (samples, sampleRate) => {
          const context = current.context;
          const gain = current.gain;
          if (!context || context.state !== 'running' || !gain) throw new Error('Audio output is unavailable.');
          const buffer = context.createBuffer(1, samples.length, sampleRate);
          buffer.getChannelData(0).set(samples);
          applyPcmEdgeRamp(buffer.getChannelData(0));
          const source = context.createBufferSource();
          source.buffer = buffer;
          source.connect(gain);
          source.onended = () => {
            current.sources.delete(source);
            try { source.disconnect(); } catch (error) { reportAudioLifecycleFailure('source disconnect', error); }
            reportAudioResources(current, 'source-ended');
          };
          current.sources.add(source);
          const rate = rateRef.current;
          source.playbackRate.value = rate;
          const startAt = Math.max(nextStart, context.currentTime + PLAYBACK_SCHEDULE_LEAD_SECONDS);
          source.start(startAt);
          nextStart = startAt + buffer.duration / rate;
          publish({ status: 'playing', messageId, error: null });
        };
        try {
          publish({ status: 'loading', messageId, error: null });
          const settingsValue = await localTtsTransport.providerConfig().catch(() => null);
          const config = localEngineConfig(settingsValue, engineId);
          const handle = await openLocalEngine(engineId, config);
          if (current.stopped) return false;
          if (nextStart === null) nextStart = current.context.currentTime + PLAYBACK_PREBUFFER_SECONDS;
          for (let index = 0; index < sentences.length; index += PLAYBACK_GROUP_SIZE) {
            if (current.stopped) return false;
            await waitForQueueCapacity();
            const text = sentences.slice(index, index + PLAYBACK_GROUP_SIZE).join('\n');
            const { samples, sampleRate } = await synthesizeLocalEngine(handle, text, config, current.context);
            if (current.stopped) return false;
            scheduleSamples(samples, sampleRate);
            playedGroups += 1;
          }
          await waitForPlayback();
          if (current.stopped) return false;
          if (work.current === current && current.context?.state === 'running') {
            clearIdleSuspend();
            await current.context.suspend().catch((error) => reportAudioLifecycleFailure('suspend', error));
          }
          reportAudioResources(current, 'playback-idle');
          publish({ status: 'idle', messageId: null, error: null });
          return true;
        } catch (error) {
          if (controller.signal.aborted || current.stopped) return;
          // Capability gaps (no WebGPU, blocked module URL, OOM) are expected
          // on some machines; system speech is the floor, not an error state.
          const remaining = sentences.slice(playedGroups * PLAYBACK_GROUP_SIZE);
          if (remaining.length && window.speechSynthesis) {
            const finished = await playSystem(messageId, remaining, volume);
            if (finished === true) return true;
          }
          publish({ status: 'error', messageId, error: error instanceof Error ? error.message : 'Speech synthesis failed.' });
          return false;
        }
      }, [clearIdleSuspend, playSystem, publish, unlockAudio]);
      React.useEffect(() => () => {
        const context = work.current.context;
        stop();
        clearIdleSuspend();
        context?.close().catch((error) => reportAudioLifecycleFailure('close', error));
      }, [clearIdleSuspend, stop]);
      return { state, play, playLocalEngine, playSystem, stop, primeAudio, setOutputVolume, setSpeechRate };
    }

    function VoiceController({ useSession, sessionId, input, inputActions, useInput, cordisCtx }) {
      const snapshot = useSession(readVoiceTimeline);
      const sessionKey = String(sessionId ?? snapshot.sessionKey ?? 'empty-chat');
      const activeSessions = activeSessionStore || emptyActiveSessionStore;
      const activeSelection = React.useSyncExternalStore(activeSessions.subscribe, activeSessions.getSnapshot, activeSessions.getSnapshot);
      const sessionActive = activeSelection.key === sessionKey;
      const { state, play, playLocalEngine, playSystem, stop, primeAudio, setOutputVolume, setSpeechRate } = usePlayer(sessionKey);
      // Auto-read is the product default. An explicit false remains respected.
      const [autoRead, setAutoRead] = React.useState(() => localStorage.getItem(SETTINGS_AUTO) !== 'false');
      const [volume, setVolume] = React.useState(() => clampVolume(localStorage.getItem(SETTINGS_VOLUME) || '1'));
      const [rate, setRate] = React.useState(() => clampSpeechRate(localStorage.getItem(SETTINGS_RATE) || String(BROWSER_SPEECH_RATE)));
      // The slot props carry a render snapshot; the input store keeps the draft
      // and its revision live, so the insertion reads this ref, not the prop.
      const liveInput = typeof useInput === 'function' ? useInput((snapshot) => snapshot) : input;
      const inputRef = React.useRef(liveInput);
      inputRef.current = liveInput;
      const speechRef = React.useRef(null);
      const speechStarting = React.useRef(false);
      const speechCancelRequested = React.useRef(false);
      const [speech, setSpeech] = React.useState({ status: 'idle', error: null });
      const finishSpeech = React.useCallback(async () => {
        const active = speechRef.current;
        if (!active) return;
        speechRef.current = null;
        setSpeech({ status: 'working', error: null, provider: active.provider });
        try {
          const text = await active.stop();
          if (!text) { setSpeech({ status: 'idle', error: null }); return; }
          const inserted = insertTranscript({ inputActions, cordisCtx: cordisCtx || voiceClientCtx, snapshot: inputRef.current }, text);
          setSpeech({ status: 'idle', error: inserted ? null : '无法写入输入框，请聚焦输入框后重试。' });
        } catch (speechError) {
          setSpeech({ status: 'idle', error: speechError?.message || '语音识别失败。' });
        }
      }, [cordisCtx, inputActions]);
      const startSpeech = React.useCallback(async () => {
        // Starting happens over two awaits; without this gate a second press
        // created a second capture session and the first one leaked with the
        // microphone still open.
        if (speechStarting.current) { speechCancelRequested.current = true; return; }
        speechStarting.current = true;
        speechCancelRequested.current = false;
        setSpeech({ status: 'listening', error: null });
        try {
          const sttSettings = await localTtsTransport.sttConfig();
          const lang = sttLanguage(sttSettings);
          const provider = sttProviderId(sttSettings);
          const session = provider === 'browser'
            ? await startBrowserSpeech(lang)
            : provider === 'whisper-web'
              ? await startLocalWhisperSpeech(sttSettings)
              : await startRecordedSpeech(lang);
          if (speechCancelRequested.current) { session.cancel?.(); setSpeech({ status: 'idle', error: null }); return; }
          speechRef.current = { ...session, provider };
          setSpeech({ status: 'listening', error: null, provider });
        } catch (speechError) {
          speechRef.current = null;
          setSpeech({ status: 'idle', error: speechError?.message || '无法启动语音输入。' });
        } finally {
          speechStarting.current = false;
        }
      }, []);
      const toggleSpeech = React.useCallback(() => {
        if (speechRef.current) { void finishSpeech(); return; }
        void startSpeech();
      }, [finishSpeech, startSpeech]);
      React.useEffect(() => () => {
        // Also covers a start that is still awaiting: it sees the flag and
        // cancels the session it was about to publish.
        speechCancelRequested.current = true;
        speechRef.current?.cancel?.();
        speechRef.current = null;
      }, []);
      const [audioReady, setAudioReady] = React.useState(false);
      const [baselineReady, setBaselineReady] = React.useState(false);
      const availability = React.useSyncExternalStore(availabilityStore.subscribe, availabilityStore.getSnapshot, availabilityStore.getSnapshot);
      const engine = speechOwnerOf(availability);
      const seen = React.useRef(new Set());
      const autoReadRef = React.useRef(autoRead);
      autoReadRef.current = autoRead;
      // The play listener owns request lifetime; volume only affects gain. Keeping
      // it in that effect's dependencies tore the effect down mid-answer - the
      // cleanup aborts the shared controller, so dragging the slider cut speech off.
      const volumeRef = React.useRef(volume);
      volumeRef.current = volume;
      const audioUnlocked = React.useRef(false);
      const prepareController = React.useRef(null);
      const prepareScope = React.useRef(null);
      const lifecycleEpoch = React.useRef(0);
      const activeIntent = React.useRef(null);
      const voiceBrainConfigured = React.useRef(false);
      // The initial status request races with the first settled answer on a
      // cold start. Keep its promise so a long final answer can wait for the
      // authoritative configuration instead of silently skipping the brief.
      const voiceBrainReady = React.useRef(Promise.resolve({ configured: false }));
      const timelineRef = React.useRef(snapshot);
      timelineRef.current = snapshot;
      const baseline = React.useRef({ key: null, timer: null, finalTimer: null, pendingFinal: null, signature: null, ready: false, baselineUserSeq: 0, lastUserSeq: 0, armedUserSeq: null });
      const autoMessageIds = React.useRef(new Set());
      const activeAutoMessageId = React.useRef(null);
      // Keep the newest process report instead of dropping it while an earlier
      // report is still being synthesized or played. Final answers always clear
      // this slot and preempt the report path.
      const pendingStatus = React.useRef(null);
      const autoRetryTimers = React.useRef(new Map());
      const autoRetryCounts = React.useRef(new Map());
      React.useLayoutEffect(() => {
        voiceTimelineStore.set(snapshot);
        return () => voiceTimelineStore.clear(snapshot);
      }, [snapshot]);
      const cancelPlayback = React.useCallback(() => {
        lifecycleEpoch.current += 1;
        activeIntent.current = null;
        prepareController.current?.abort();
        prepareController.current = null;
        prepareScope.current?.cancel('client-aborted');
        prepareScope.current = null;
        for (const timer of autoRetryTimers.current.values()) clearTimeout(timer);
        autoRetryTimers.current.clear();
        const finalState = baseline.current;
        if (finalState.finalTimer) clearTimeout(finalState.finalTimer);
        finalState.finalTimer = null;
        finalState.pendingFinal = null;
        stop();
      }, [stop]);
      React.useEffect(() => {
        if (!sessionActive) cancelPlayback();
        return activeSessions.subscribe(() => {
          if (activeSessions.getSnapshot().key !== sessionKey) cancelPlayback();
        });
      }, [activeSessions, sessionActive, activeSelection.epoch, sessionKey, cancelPlayback]);
      React.useEffect(() => { localStorage.setItem(SETTINGS_AUTO, String(autoRead)); if (!autoRead) cancelPlayback(); }, [autoRead, cancelPlayback]);
      React.useEffect(() => {
        localStorage.setItem(SETTINGS_VOLUME, String(volume));
        setOutputVolume(volume);
      }, [volume, setOutputVolume]);
      React.useEffect(() => {
        localStorage.setItem(SETTINGS_RATE, String(rate));
        setSpeechRate(rate);
      }, [rate, setSpeechRate]);
      React.useEffect(() => {
        if (audioReady) return undefined;
        const unlockFromGesture = () => {
          if (audioUnlocked.current) return;
          audioUnlocked.current = true;
          primeAudio(volume).then(() => {
            setAudioReady(true);
          }).catch(() => { audioUnlocked.current = false; });
        };
        window.addEventListener('pointerdown', unlockFromGesture, { passive: true });
        window.addEventListener('keydown', unlockFromGesture, { passive: true });
        window.addEventListener('touchstart', unlockFromGesture, { passive: true });
        return () => {
          window.removeEventListener('pointerdown', unlockFromGesture);
          window.removeEventListener('keydown', unlockFromGesture);
          window.removeEventListener('touchstart', unlockFromGesture);
        };
      }, [audioReady, primeAudio, volume]);
      React.useEffect(() => {
        requestAvailability();
        const refresh = () => requestAvailability(true);
        const refreshWhenVisible = () => { if (document.visibilityState !== 'hidden') requestAvailability(); };
        window.addEventListener('pageshow', refresh);
        document.addEventListener('visibilitychange', refreshWhenVisible);
        return () => {
          window.removeEventListener('pageshow', refresh);
          document.removeEventListener('visibilitychange', refreshWhenVisible);
        };
      }, []);
      React.useEffect(() => {
        let alive = true;
        const update = (value) => {
          const next = { configured: value?.configured === true, model: value?.model || 'deepseek-v4-flash' };
          voiceBrainConfigured.current = next.configured;
          if (!alive) return;
        };
        const pending = getVoiceBrainStatus().then((value) => { update(value); return value; }).catch(() => {
          const value = { configured: false, model: 'deepseek-v4-flash' };
          update(value);
          return value;
        });
        voiceBrainReady.current = pending;
        const onConfig = (event) => update(event.detail);
        window.addEventListener(EVENT_BRAIN_CONFIG, onConfig);
        return () => { alive = false; window.removeEventListener(EVENT_BRAIN_CONFIG, onConfig); };
      }, []);
      const drainPendingStatus = React.useCallback(() => {
        const queued = pendingStatus.current;
        if (!queued) return;
        pendingStatus.current = null;
        setTimeout(() => {
          const selection = activeSessions.getSnapshot();
          if (selection.key !== sessionKey || activeIntent.current?.kind === 'final') return;
          if (activeIntent.current || prepareController.current) {
            pendingStatus.current = queued;
            return;
          }
          window.dispatchEvent(new CustomEvent(EVENT_PLAY, { detail: queued }));
        }, 0);
      }, [activeSessions, sessionKey]);
      React.useEffect(() => {
        const onPlay = async (event) => {
          const detail = event.detail || {};
          const selection = activeSessions.getSnapshot();
          if (detail.sessionKey !== sessionKey || selection.key !== sessionKey) return;
          const { messageId, markdown } = detail;
          const automatic = detail.auto === true;
          if (detail.stop) {
            pendingStatus.current = null;
            cancelPlayback();
            return;
          }
          const kind = detail.kind === 'status' ? 'status' : 'final';
          const priority = kind === 'status' ? 10 : 100;
          // A status report never interrupts an answer. If another status is
          // active, retain only the newest report and drain it after the active
          // intent reaches a terminal state instead of silently losing it.
          if (kind === 'status') {
            if (activeIntent.current?.kind === 'final') return;
            if (activeIntent.current?.priority >= priority || prepareController.current) {
              pendingStatus.current = { ...detail, sessionKey };
              return;
            }
          }
          if (kind === 'final') {
            pendingStatus.current = null;
            // stop() emits `stopped`. Reclaim automatic ownership only after
            // that event, then publish preparation for the current answer.
            cancelPlayback();
            const id = String(messageId || '');
            if (automatic && id) {
              // Claim the message only after the play event is received. This
              // keeps a dispatch/preparation failure retryable instead of
              // marking the final answer consumed before audio exists.
              seen.current.add(id);
              autoMessageIds.current.add(id);
              activeAutoMessageId.current = id;
            } else {
              activeAutoMessageId.current = null;
              if (id) autoMessageIds.current.delete(id);
            }
          }
          dispatchVoiceState({ status: kind === 'final' ? 'preparing' : 'loading', messageId, error: null, sessionKey });
          const requestScope = createVoiceRequestScope();
          const controller = requestScope.controller;
          prepareScope.current?.cancel('superseded');
          prepareScope.current = requestScope;
          prepareController.current = controller;
          const requestEpoch = ++lifecycleEpoch.current;
          const selectionEpoch = selection.epoch;
          const intent = { id: `${requestEpoch}:${String(messageId || kind)}`, kind, priority };
          activeIntent.current = intent;
          const isCurrentRequest = () => {
            const currentSelection = activeSessions.getSnapshot();
            return lifecycleEpoch.current === requestEpoch && !controller.signal.aborted
              && currentSelection.key === sessionKey && currentSelection.epoch === selectionEpoch;
          };
          const retryAutomatic = () => {
            if (!automatic || kind !== 'final' || !autoReadRef.current || !isCurrentRequest()) return;
            const id = String(messageId || '');
            const count = autoRetryCounts.current.get(id) || 0;
            if (!id || count >= 2 || autoRetryTimers.current.has(id)) return;
            autoRetryCounts.current.set(id, count + 1);
            seen.current.delete(id);
            const timer = setTimeout(() => {
              autoRetryTimers.current.delete(id);
              // EVENT_STATE is a UI notification, not the retry owner. In
              // particular, an error notification may arrive before this
              // timer is installed. Keep retry eligibility tied to the
              // session, generation, and intent map instead of a ref that UI
              // cleanup is allowed to clear.
              if (!isCurrentRequest() || !autoReadRef.current || !autoMessageIds.current.has(id)) return;
              activeAutoMessageId.current = id;
              window.dispatchEvent(new CustomEvent(EVENT_PLAY, { detail: { messageId: id, markdown, sessionKey, auto: true, retry: count + 1 } }));
            }, count === 0 ? 900 : 2400);
            autoRetryTimers.current.set(id, timer);
          };
          try {
            // Acquire browser playback permission, then suspend while text and
            // optional briefing are prepared. play() resumes immediately before
            // scheduling PCM, so preparation never holds an idle render thread.
            await primeAudio(volumeRef.current);
            if (!isCurrentRequest()) return;
            audioUnlocked.current = true;
            setAudioReady(true);
            let speechMarkdown = markdown;
            // Only final, visibly long answers are sent to the optional cloud
            // brief endpoint. Process reports, reasoning, tools, and short
            // replies always remain local.
            if (kind === 'final' && reachesCodePointCount(String(markdown || ''), briefThreshold.value)) {
              // Resolve the status race on cold start. The normal status
              // effect usually completes first; this bounded wait makes the
              // long-answer path deterministic without delaying short speech.
              await Promise.race([
                voiceBrainReady.current,
                new Promise((resolve) => requestScope.timeout(resolve, 1500))
              ]);
              if (!isCurrentRequest()) return;
              if (!voiceBrainConfigured.current) {
                const refreshed = await getVoiceBrainStatus().catch(() => ({ configured: false }));
                if (refreshed?.configured === true) {
                  voiceBrainConfigured.current = true;
                }
              }
            }
            if (kind === 'final' && voiceBrainConfigured.current && reachesCodePointCount(String(markdown || ''), briefThreshold.value)) {
              dispatchVoiceState({ status: 'briefing', messageId, error: null, sessionKey });
              try {
                const brief = await createVoiceBrief(markdown, controller.signal);
                if (isCurrentRequest() && brief) speechMarkdown = brief;
              } catch (error) {
                if (controller.signal.aborted) return;
                // Voice continuity matters more than a cloud enhancement.
                // The visible answer is already authoritative, so fallback is local.
                dispatchVoiceState({ status: 'brief-fallback', messageId, error: error?.message || 'Voice brief unavailable.', sessionKey });
              }
            }
            if (!isCurrentRequest()) return;
            const sentences = await prepare(speechMarkdown, controller.signal);
            if (!isCurrentRequest()) return;
            if (!sentences.length) {
              if (automatic) retryAutomatic();
              dispatchVoiceState({ status: 'error', messageId, error: '没有可朗读的文本。', sessionKey });
              return;
            }
            const played = engine === 'system'
              ? await playSystem(messageId, sentences, volumeRef.current)
              : isLocalEngine(engine)
                ? await playLocalEngine(engine, messageId, sentences, volumeRef.current)
                : await play(messageId, sentences, volumeRef.current);
            if (played === 'client-side') {
              // This provider has no host-side engine; the browser must speak.
              // Publish the switch so the next answer skips the round trip.
              publishAvailability({ available: true, provider: 'browser' });
              const fallback = await playSystem(messageId, sentences, volumeRef.current);
              if (fallback === true) return;
            }
            if (played !== true) retryAutomatic();
          } catch (error) {
            if (controller.signal.aborted) return;
            if (error?.code === 'local-service-unavailable') {
              const value = {
                available: false,
                reason: '本地 Fairy 服务未启动。',
              };
              publishAvailability(value);
            }
            dispatchVoiceState({ status: 'error', messageId, error: error?.message || 'Speech preparation failed.', sessionKey });
            retryAutomatic();
          } finally {
            if (prepareController.current === controller) prepareController.current = null;
            if (activeIntent.current === intent) activeIntent.current = null;
            if (prepareScope.current === requestScope) {
              requestScope.cancel('request-complete');
              prepareScope.current = null;
            }
            if (kind === 'status') drainPendingStatus();
          }
        };
        window.addEventListener(EVENT_PLAY, onPlay);
        return () => { pendingStatus.current = null; prepareScope.current?.cancel('effect-cleanup'); prepareScope.current = null; prepareController.current = null; for (const timer of autoRetryTimers.current.values()) clearTimeout(timer); autoRetryTimers.current.clear(); window.removeEventListener(EVENT_PLAY, onPlay); };
      }, [activeSessions, cancelPlayback, drainPendingStatus, engine, play, playLocalEngine, playSystem, primeAudio, sessionKey]);
      React.useEffect(() => {
        const onState = (event) => {
          const detail = event.detail || {};
          if (detail.sessionKey !== sessionKey) return;
          if (['idle', 'stopped'].includes(detail.status) && activeAutoMessageId.current) {
            const id = activeAutoMessageId.current;
            autoMessageIds.current.delete(activeAutoMessageId.current);
            activeAutoMessageId.current = null;
            if (detail.status === 'idle') autoRetryCounts.current.delete(id);
          }
          if (['idle', 'error'].includes(detail.status)) drainPendingStatus();
        };
        window.addEventListener(EVENT_STATE, onState);
        return () => window.removeEventListener(EVENT_STATE, onState);
      }, [sessionKey]);
      React.useEffect(() => {
        const state = baseline.current;
        const signature = `${snapshot.userSeq}:${snapshot.found.map((message) => message.id).join('|')}:${snapshot.currentTurnFinals.map((message) => message.id).join('|')}`;
        if (state.key !== sessionKey) {
          if (state.timer) clearTimeout(state.timer);
          cancelPlayback();
          seen.current = new Set();
          autoMessageIds.current.clear();
          activeAutoMessageId.current = null;
          pendingStatus.current = null;
          setBaselineReady(false);
          baseline.current = { key: sessionKey, timer: null, finalTimer: null, pendingFinal: null, signature: null, ready: false, baselineUserSeq: snapshot.userSeq, lastUserSeq: snapshot.userSeq, armedUserSeq: null };
        }
        const current = baseline.current;
        if (current.ready) return;
        // During cold start and a session switch, every lazily arriving message is
        // historical. Only a user message created after this baseline can arm auto-read.
        for (const message of snapshot.found) seen.current.add(message.id);
        current.baselineUserSeq = Math.max(current.baselineUserSeq, snapshot.userSeq);
        current.lastUserSeq = snapshot.userSeq;
        if (current.signature === signature) return;
        current.signature = signature;
        if (current.timer) clearTimeout(current.timer);
        current.timer = setTimeout(() => {
          if (baseline.current !== current || current.key !== sessionKey) return;
          current.timer = null;
          current.ready = true;
          setBaselineReady(true);
        }, SESSION_BASELINE_SETTLE_MS);
      }, [cancelPlayback, sessionKey, snapshot.found, snapshot.currentTurnFinals, snapshot.userSeq]);
      React.useEffect(() => {
        const current = baseline.current;
        if (current.key !== sessionKey || !current.ready) return;
        if (snapshot.userSeq > current.lastUserSeq) {
          current.lastUserSeq = snapshot.userSeq;
          current.armedUserSeq = snapshot.userSeq;
          cancelPlayback();
        }
      }, [cancelPlayback, sessionKey, snapshot.userSeq, baselineReady]);
      React.useEffect(() => {
        const current = baseline.current;
        if (!sessionActive || current.key !== sessionKey || !current.ready) return;
        // A render can contain both the new user sequence and a settled
        // assistant node. Do not consume anything until the user-turn effect
        // has armed this sequence; importantly, never mark it as seen here.
        if (current.armedUserSeq !== snapshot.userSeq) return;
        if (!autoRead || (engine !== 'system' && !availability.available)) return;

        // Only a closed turn's official closing final may trigger automatic
        // playback. Never infer a final answer from the last settled
        // assistant-step: search/thinking/tool turns can settle several such
        // nodes before the actual answer is emitted.
        const candidate = [...snapshot.currentTurnFinals].reverse().find((message) => !seen.current.has(message.id) && !autoMessageIds.current.has(message.id));
        if (!candidate) return;
        const pending = current.pendingFinal;
        if (!pending || pending.id !== candidate.id) {
          if (current.finalTimer) clearTimeout(current.finalTimer);
          current.pendingFinal = { ...candidate, userSeq: snapshot.userSeq };
          current.finalTimer = null;
        }

        // Defer dispatch briefly so the closed-turn projection and the
        // rendered answer settle together. Activity is intentionally not used
        // as a timeout-based final detector: a running flag cannot promote an
        // intermediate assistant-step into a final answer.
        if (!current.finalTimer) {
          const schedule = (delay) => {
            current.finalTimer = setTimeout(() => {
              current.finalTimer = null;
              const selection = activeSessions.getSnapshot();
              if (baseline.current !== current || current.key !== sessionKey
                || selection.key !== sessionKey || selection.epoch !== activeSelection.epoch) return;
              const latest = timelineRef.current;
              const final = current.pendingFinal;
              if (!final || latest.userSeq !== final.userSeq || current.armedUserSeq !== latest.userSeq) {
                current.pendingFinal = null;
                return;
              }
              const stillAuthoritative = latest.currentTurnFinals.some((message) => message.id === final.id);
              if (!stillAuthoritative) {
                current.pendingFinal = null;
                return;
              }
              current.pendingFinal = null;
              autoMessageIds.current.add(final.id);
              activeAutoMessageId.current = final.id;
              current.armedUserSeq = null;
              window.dispatchEvent(new CustomEvent(EVENT_PLAY, { detail: { messageId: final.id, markdown: final.markdown, sessionKey, auto: true } }));
            }, delay);
          };
          schedule(FINAL_PLAYBACK_SETTLE_MS);
        }
      }, [activeSelection.epoch, sessionActive, sessionKey, snapshot.currentTurnFinals, snapshot.userSeq, autoRead, engine, availability.available, audioReady, baselineReady]);
      React.useEffect(() => () => {
        const current = baseline.current;
        if (current.timer) clearTimeout(current.timer);
        cancelPlayback();
      }, [cancelPlayback]);
      React.useEffect(() => {
        window.addEventListener('pagehide', cancelPlayback);
        const cancelWhenHidden = () => { if (document.visibilityState === 'hidden') cancelPlayback(); };
        document.addEventListener('visibilitychange', cancelWhenHidden);
        return () => {
          window.removeEventListener('pagehide', cancelPlayback);
          document.removeEventListener('visibilitychange', cancelWhenHidden);
        };
      }, [cancelPlayback]);
      useVoiceBrain({
        sessionKey,
        timeline: snapshot,
        baselineReady,
        autoRead: autoRead && sessionActive,
        audioReady,
        available: engine === 'system' || availability.available
      });
      const autoLabel = autoRead ? '关闭自动朗读' : '开启自动朗读';
      const engineAvailable = engine === 'system' || availability.available;
      // Fixed irregular heights avoid a visible repeating cadence while keeping
      // React renders deterministic and free from animation jitter.
      const waveHeights = [6, 11, 8, 14, 10, 5, 13, 9, 14, 7, 12, 13, 6, 10, 14, 8, 13, 5, 11, 9, 13, 7, 10, 14, 6, 12, 8, 11, 5, 13];
      const waveform = waveHeights.map((height, index) => {
        const active = index / (waveHeights.length - 1) <= volume;
        return jsx.jsx('span', { className: 'dsh-fairy-voice-wave-bar', 'data-dsh-fairy-wave-bar': 'true', 'data-active': active ? 'true' : 'false', style: { '--dsh-fairy-wave-height': `${height}px`, '--dsh-fairy-wave-opacity': active ? '.86' : '.22' }, 'aria-hidden': 'true', key: index });
      });
      return jsx.jsxs('span', { className: 'dsh-fairy-voice-controls', role: 'group', 'aria-label': 'Fairy 朗读控制', [FAIRY_VOICE_CONTROL_ATTRIBUTE]: 'true', children: [
        jsx.jsx(Tooltip, { label: engineAvailable ? autoLabel : availability.reason, children: jsx.jsx('button', { type: 'button', className: 'dsh-fairy-voice-auto', 'data-dsh-fairy-auto-control': 'true', 'data-on': autoRead ? 'true' : 'false', disabled: !engineAvailable, onClick: () => setAutoRead((value) => !value), 'aria-label': autoLabel, 'aria-pressed': autoRead, children: jsx.jsx('span', { className: 'dsh-fairy-voice-auto-dot', 'data-dsh-fairy-auto-dot': 'true', 'aria-hidden': 'true' }) }) }),
        jsx.jsx('span', { className: 'dsh-fairy-voice-waveform', 'data-dsh-fairy-waveform': 'true', 'aria-hidden': 'true', children: waveform }),
        jsx.jsx(Tooltip, { label: `语音音量 ${Math.round(volume * 100)}%`, children: jsx.jsx('input', { className: 'dsh-fairy-voice-volume', 'data-dsh-fairy-volume-input': 'true', disabled: !engineAvailable, min: '0', max: '1', step: '0.05', type: 'range', value: volume, onChange: (event) => setVolume(Number(event.target.value)), 'aria-label': '语音音量', style: { '--dsh-fairy-volume': `${Math.round(volume * 100)}%` } }) }),
        jsx.jsx(Tooltip, { label: `朗读语速 ${rate.toFixed(2)}×`, children: jsx.jsx('input', { className: 'dsh-fairy-voice-volume', 'data-dsh-fairy-rate-input': 'true', disabled: !engineAvailable, min: String(SPEECH_RATE_MIN), max: String(SPEECH_RATE_MAX), step: String(SPEECH_RATE_STEP), type: 'range', value: rate, onChange: (event) => setRate(clampSpeechRate(event.target.value)), 'aria-label': '朗读语速', style: { '--dsh-fairy-volume': `${Math.round(((rate - SPEECH_RATE_MIN) / (SPEECH_RATE_MAX - SPEECH_RATE_MIN)) * 100)}%` } }) }),
        jsx.jsx(Tooltip, { label: speech.error ? `语音输入：${speech.error}` : speech.status === 'listening' ? '停止并转写' : speech.status === 'working' ? (speech.provider === 'whisper-web' ? '本地识别中（首次会下载模型）…' : '正在转写…') : '语音输入（转文字）', children: jsx.jsx('button', {
          type: 'button',
          className: 'dsh-fairy-voice-auto',
          'data-dsh-fairy-mic-control': 'true',
          'data-dsh-fairy-mic-state': speech.error ? 'error' : speech.status,
          disabled: speech.status === 'working',
          onClick: toggleSpeech,
          'aria-label': speech.error ? `语音输入：${speech.error}` : '语音输入',
          'aria-pressed': speech.status === 'listening',
          children: jsx.jsx('span', { className: 'dsh-fairy-voice-auto-dot', 'data-dsh-fairy-mic-dot': 'true', 'aria-hidden': 'true' })
        }) }),
        engine === 'fairy' && state.status === 'error' ? jsx.jsx('span', { title: state.error, style: { color: 'var(--dsw-alias-state-error-primary)', fontSize: '12px', maxWidth: '96px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, children: '朗读失败' }) : null
      ] });
    }

    function useHddVisualMode() {
      const readMode = () => document.documentElement?.hasAttribute('data-dsh-fairy-visual') === true;
      return React.useSyncExternalStore((notify) => {
        // The visual plugin owns this document attribute. Observing that one
        // source keeps the Voice slot in lockstep without coupling to its
        // settings store or duplicating its mode state.
        if (typeof MutationObserver !== 'function' || !document.documentElement) return () => {};
        const observer = new MutationObserver(notify);
        observer.observe(document.documentElement, {
          attributes: true,
          attributeFilter: ['data-dsh-fairy-visual'],
        });
        return () => observer.disconnect();
      }, readMode, readMode);
    }

    function SessionScopedVoiceController(props) {
      const hddVisualMode = useHddVisualMode();
      const alwaysControls = useAlwaysShowControls();
      // In normal DSH mode this slot has no Voice surface or controller
      // lifecycle at all. Switching back to HDD mounts a fresh, session-keyed
      // controller, so mode changes cannot retain audio or DOM ownership.
      // The settings card can lift the gate so the controls stay reachable
      // for people who keep the visual layer off.
      if (!hddVisualMode && !alwaysControls) return null;
      // Force a clean controller/ref lifecycle when DSH changes the active
      // session. This prevents playback and seen-message state leaking across
      // conversation providers during the transition frame.
      return jsx.jsx(VoiceController, { ...props, key: String(props.sessionId ?? 'empty-chat') });
    }

    function MessageAction({ messageId, sessionId }) {
      const conversation = React.useSyncExternalStore(voiceTimelineStore.subscribe, voiceTimelineStore.getSnapshot, voiceTimelineStore.getSnapshot);
      const sessionKey = String(sessionId ?? activeSessionStore?.getSnapshot().key ?? 'empty-chat');
      const message = conversation.sessionKey === sessionKey
        ? conversation.messagesById.get(String(messageId))
        : undefined;
      const [state, setState] = React.useState(() => readVoiceState(sessionKey));
      const availability = React.useSyncExternalStore(availabilityStore.subscribe, availabilityStore.getSnapshot, availabilityStore.getSnapshot);
      const engine = speechOwnerOf(availability);
      React.useLayoutEffect(() => {
        setState(readVoiceState(sessionKey));
        const listener = (event) => { if (event.detail?.sessionKey === sessionKey) setState(event.detail); };
        window.addEventListener(EVENT_STATE, listener);
        return () => window.removeEventListener(EVENT_STATE, listener);
      }, [sessionKey]);
      if (!message) return null;
      const active = state.messageId === String(messageId) && ['preparing', 'briefing', 'brief-fallback', 'loading', 'playing'].includes(state.status);
      const enabled = engine === 'system' || availability.available;
      const label = enabled ? (active ? '停止朗读' : '朗读回复') : availability.reason;
      return jsx.jsx(Tooltip, { label, children: jsx.jsx('button', {
        type: 'button', disabled: !enabled, onClick: () => active ? window.dispatchEvent(new CustomEvent(EVENT_PLAY, { detail: { sessionKey, stop: true } })) : window.dispatchEvent(new CustomEvent(EVENT_PLAY, { detail: { sessionKey, messageId: message.id, markdown: message.markdown } })),
        style: iconButton, 'aria-label': label, children: active ? jsx.jsx(IconStopFill16, { size: 16 }) : jsx.jsx(IconPlayOutline16, { size: 16 })
      }) });
    }

    function injectVoiceSlot(ctx, name, definition, component) {
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

    function apply(ctx) {
      return diagnostics.guard('apply', () => {
      ensureVoiceControlStyles();
      voiceClientCtx = ctx;
      briefThreshold.value = readStoredBriefThreshold();
      const activeSessions = createActiveSessionStore(ctx.sessions);
      activeSessionStore = activeSessions;
      ctx.effect(() => () => {
        activeSessions.dispose();
        if (activeSessionStore === activeSessions) activeSessionStore = null;
        clearVoiceSessionStates();
        voiceTimelineStore.clear();
        disposeAvailability();
        voiceClientCtx = null;
        document.getElementById(VOICE_STYLE_ID)?.remove();
      }, 'dsh-fairy-voice session lifecycle');
      const slotDisposers = [
        injectVoiceSlot(ctx, 'conversation.input.left', { name: 'conversation.input.left', id: 'fairy-voice-controller', order: 40 }, SessionScopedVoiceController),
        injectVoiceSlot(ctx, 'conversation.chat.assistant-actions', { id: 'fairy-voice-message-action', order: 20 }, MessageAction),
        injectVoiceSlot(ctx, 'settings.section', { id: 'fairy-voice-brain', order: 30, label: () => '语音简报' }, VoiceBrainSection),
        injectVoiceSlot(ctx, 'settings.section', { id: 'fairy-voice-engine', order: 31, label: () => '语音引擎' }, VoiceEngineSection),
        injectVoiceSlot(ctx, 'settings.section', { id: 'fairy-voice-stt', order: 32, label: () => '语音输入' }, VoiceSttSection),
      ].filter((dispose) => typeof dispose === 'function');
      ctx.effect(() => () => slotDisposers.forEach((dispose) => dispose()), 'dsh-fairy-voice slot registrations');
      }, { surface: 'client' });
    }

    return { apply, inject: ['slots', 'sessions'] };
  }
});
