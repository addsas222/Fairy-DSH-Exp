window.__ModuleLoader__.load({
  id: 'dsh-fairy-modes',
  factory: (require) => {
    const React = require('react');
    const jsx = require('react/jsx-runtime');

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
    const CHIP_LABELS = { ptc: 'PTC', create: '创造', roleplay: '角色', off: 'off' };
    const MENU = [
      { value: 'plan', label: '探查·极简' },
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
    const MODE_VALUES = ['off', 'ptc', 'create'];
    const DEFAULT_MODE_OPTIONS = [
      { value: '', label: '不设置（新会话保持 off）' },
      { value: 'ptc', label: '建造·PTC' },
      { value: 'roleplay', label: '角色扮演' },
      { value: 'create', label: '创造·回忆' },
      { value: 'off', label: '关闭·off' },
    ];
    const MODE_SEMANTICS = [
      { term: '极简', text: '官方 plan-mode，与下面的会话模式正交：在输入框输入 /plan（或点会话头 chip 的「探查·极简」）切换。' },
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
    const card = {
      display: 'grid', gap: '8px', padding: '12px',
      border: '1px solid var(--dsw-alias-border-l2, rgba(130,130,130,0.28))', borderRadius: '10px',
      font: 'var(--dsw-font-xs-strong-13, 12px system-ui)',
      color: 'var(--dsw-alias-label-primary, rgba(225,225,225,0.95))',
    };
    const cardNote = {
      margin: 0, color: 'var(--dsw-alias-label-secondary, rgba(200,200,200,0.9))', lineHeight: '1.6',
    };
    const cardField = { display: 'grid', gap: '4px' };
    const cardSelect = {
      padding: '5px 8px', border: '1px solid var(--dsw-alias-border-l2, rgba(130,130,130,0.28))',
      borderRadius: '6px', background: 'var(--dsw-alias-bg-layer-1, #1f1f1f)',
      color: 'var(--dsw-alias-label-primary, rgba(225,225,225,0.95))',
      font: 'var(--dsw-font-xs-strong-13, 12px system-ui)',
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
            if (!response.ok) return;
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
      return jsx.jsx('span', {
        ref: rootRef,
        'data-dsh-fairy-modes-chip': 'true',
        title: inputActions === undefined ? '会话模式（极简请在输入框输入 /plan）' : '会话模式',
        style: { position: 'relative', display: 'inline-flex' },
        children: [
          jsx.jsx('button', {
            type: 'button',
            'aria-haspopup': 'menu',
            'aria-expanded': open ? 'true' : 'false',
            'aria-label': `会话模式：${label}`,
            onClick: () => setOpen(!open),
            style: { ...chipButton, ...(label === 'off' ? {} : { borderColor: 'var(--dsw-alias-brand-primary, #3b82f6)', color: 'var(--dsw-alias-label-primary, rgba(225,225,225,0.95))' }) },
            children: label,
          }),
          open ? jsx.jsx('div', {
            role: 'menu',
            style: menu,
            children: MENU.map((item) => jsx.jsx('button', {
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

    /**
     * The settings card: mode semantics, plus the browser-side default the chip
     * applies to sessions that carry no mode yet. Nothing here is host state, so
     * the card needs no endpoint and no settings scope — only the preference.
     */
    function ModesSettingsSection() {
      const [value, setValue] = React.useState(() => defaultMode() ?? '');
      const change = (event) => {
        const next = normalizeStoredMode(event.target.value) ?? '';
        setValue(next);
        writeStored(storageOf('localStorage'), DEFAULT_KEY, next === '' ? null : next);
      };
      return jsx.jsx('div', {
        'data-dsh-fairy-modes-settings': 'true',
        style: card,
        children: [
          jsx.jsx('p', {
            style: cardNote,
            children: '会话模式是记录在会话日志里的协作状态，不是进程开关；建造与创造互斥，极简（官方 plan-mode）与它们正交。',
          }),
          jsx.jsx('dl', {
            style: { display: 'grid', gap: '6px', margin: 0 },
            children: MODE_SEMANTICS.map(item => jsx.jsx('div', {
              key: item.term,
              style: { display: 'grid', gap: '2px' },
              children: [
                jsx.jsx('dt', { style: { fontWeight: 600 }, children: item.term }),
                jsx.jsx('dd', { style: { ...cardNote, margin: 0 }, children: item.text }),
              ],
            })),
          }),
          jsx.jsx('label', {
            htmlFor: 'dsh-fairy-modes-default',
            style: cardField,
            children: [
              jsx.jsx('span', { children: '新会话默认模式' }),
              jsx.jsx('select', {
                id: 'dsh-fairy-modes-default',
                'data-dsh-fairy-modes-default': 'true',
                value,
                onChange: change,
                style: cardSelect,
                children: DEFAULT_MODE_OPTIONS.map(option => jsx.jsx('option', {
                  key: option.value === '' ? 'none' : option.value,
                  value: option.value,
                  children: option.label,
                })),
              }),
            ],
          }),
          jsx.jsx('p', {
            style: cardNote,
            children: '默认值只作用于还没有模式记录的新会话；本会话里手动切换过（或已应用过默认值）后不再重复应用。',
          }),
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
