window.__ModuleLoader__.load({
  id: 'dsh-balance-meter',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
    
const React = require('react');
    const jsxRuntime = require('react/jsx-runtime');
    const inject = ['slots', 'connection', 'sessions'];
    const BALANCE_UNAVAILABLE_TEXT = 'unavailable';
    const POLL_ACTIVE_MS = 30_000;
    const POLL_IDLE_MS = 120_000;

    const createFairyDiagnostics = (() => {
      const diagnosticsModule = { exports: {} };
      const module = diagnosticsModule;
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
      return diagnosticsModule.exports.createFairyDiagnostics;
    })();
    const diagnostics = createFairyDiagnostics('dsh-balance-meter');

    function formatTokens(value) {
      if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
      if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
      return String(value);
    }

    function formatCny(value) {
      if (value === 0) return '¥0.00';
      if (value < 0.01) return `¥${value.toFixed(4)}`;
      return `¥${value.toFixed(2)}`;
    }

    const readHddMode = () => document.documentElement.getAttribute('data-dsh-fairy-mode') === 'hdd';

    function createBalancePoller(setData, sessions) {
      const meterDiagnostics = typeof diagnostics === 'undefined'
        ? { start: () => Date.now(), metric() {}, warn() {} }
        : diagnostics;
      let alive = true;
      let timer = 0;
      let controller = null;
      let session = null;
      let sessionOff = null;
      let listOff = null;
      let sessionActive = false;
      const clearTimer = () => {
        if (timer) clearTimeout(timer);
        timer = 0;
      };
      const abort = () => {
        controller?.abort('cancelled');
        controller = null;
      };
      const schedule = () => {
        clearTimer();
        if (alive && document.visibilityState !== 'hidden') {
          timer = window.setTimeout(load, sessionActive ? POLL_ACTIVE_MS : POLL_IDLE_MS);
        }
      };
      const suspend = () => {
        clearTimer();
        abort();
      };
      const load = async () => {
        clearTimer();
        if (!alive || document.visibilityState === 'hidden') return;
        abort();
        const request = new AbortController();
        const startedAt = meterDiagnostics.start();
        controller = request;
        try {
          const response = await fetch('/balance-meter', { signal: request.signal });
          if (!response.ok) throw new Error(`balance-meter-http-${response.status}`);
          const value = await response.json();
          if (alive && controller === request) setData(value);
        } catch (error) {
          if (alive && controller === request) {
            if (error?.name !== 'AbortError') meterDiagnostics.warn('balance.request', {}, error);
            // Preserve the locally served usage counters while making only
            // the remote balance failure explicit to the user.
            setData((current) => current?.balance?.is_available === false
              ? current
              : { ...(current || {}), balance: { is_available: false } });
          }
        } finally {
          meterDiagnostics.metric('balance.request', startedAt, { active_session: sessionActive }, { thresholdMs: 100 });
          if (controller === request) controller = null;
          schedule();
        }
      };
      const resume = () => {
        if (alive && document.visibilityState !== 'hidden' && !controller && !timer) load();
      };
      const onVisibility = () => {
        if (document.visibilityState === 'hidden') suspend();
        else resume();
      };
      const syncSessionActivity = () => {
        const next = session?.getSnapshot?.().running === true;
        if (next === sessionActive) return;
        sessionActive = next;
        if (timer) schedule();
      };
      const bindSession = () => {
        const sessionId = sessions?.list?.getSnapshot?.().current;
        const nextSession = sessionId == null ? null : sessions?.binding?.(sessionId)?.session || null;
        if (nextSession === session) return syncSessionActivity();
        sessionOff?.();
        session = nextSession;
        sessionOff = session?.subscribe?.(syncSessionActivity) || null;
        syncSessionActivity();
      };
      return {
        start() {
          bindSession();
          listOff = sessions?.list?.subscribe?.(bindSession) || null;
          document.addEventListener('visibilitychange', onVisibility);
          window.addEventListener('pagehide', suspend);
          window.addEventListener('pageshow', resume);
          load();
        },
        dispose() {
          alive = false;
          clearTimer();
          abort();
          sessionOff?.();
          listOff?.();
          sessionOff = null;
          listOff = null;
          session = null;
          document.removeEventListener('visibilitychange', onVisibility);
          window.removeEventListener('pagehide', suspend);
          window.removeEventListener('pageshow', resume);
        },
      };
    }

    function BalanceMeter({ sessions }) {
      const [data, setData] = React.useState(null);
      const [compact, setCompact] = React.useState(false);
      const [hddMode, setHddMode] = React.useState(readHddMode);
      const rootRef = React.useRef(null);

      React.useEffect(() => {
        const poller = createBalancePoller(setData, sessions);
        poller.start();
        return () => poller.dispose();
      }, [sessions]);

      React.useEffect(() => {
        if (typeof MutationObserver === 'undefined') return undefined;
        const syncMode = () => setHddMode(readHddMode());
        const observer = new MutationObserver(syncMode);
        observer.observe(document.documentElement, {
          attributes: true,
          attributeFilter: ['data-dsh-fairy-mode'],
        });
        syncMode();
        return () => observer.disconnect();
      }, []);

      React.useEffect(() => {
        const root = rootRef.current;
        if (!root || typeof ResizeObserver === 'undefined') return undefined;
        const sidebarSlot = root.closest('[data-slot="sidebar"]');
        const rail = sidebarSlot?.parentElement;
        if (!rail) return undefined;
        const update = () => setCompact(rail.getBoundingClientRect().width <= 80);
        update();
        const observer = new ResizeObserver(update);
        observer.observe(rail);
        return () => observer.disconnect();
      }, []);

      const balanceInfo = data?.balance?.is_available === false ? null : data?.balance?.balance_infos?.[0];
      const cny = balanceInfo ? balanceInfo.total_balance : null;
      const today = typeof data?.todayTokens === 'number' ? data.todayTokens : null;
      const cost = typeof data?.todayCost === 'number' ? data.todayCost : null;
      const pricing = data?.pricing;
      const balanceText = cny != null ? `¥${cny}` : BALANCE_UNAVAILABLE_TEXT;
      const todayText = today != null ? formatTokens(today) : '…';
      const costText = cost != null ? formatCny(cost) : '…';
      const pricingDate = typeof pricing?.verifiedDate === 'string' ? pricing.verifiedDate : '待核验';
      const bandText = pricing?.band === 'peak' ? '峰时' : pricing?.band === 'offPeak' ? '谷时' : '未知时段';
      const dailyLabel = hddMode ? '今日电量' : '今日token';
      const dailySummaryLabel = hddMode ? '今日电量' : '今日 token';
      const summary = `DeepSeek 余额 ${balanceText}，${dailySummaryLabel} ${todayText}，今日估算 ${costText}；计价源 DeepSeek V4 Flash 官方价 ${pricingDate}，当前${bandText}，汇率按 1 USD = ¥${pricing?.usdToCnyEstimate ?? '…'}`;
      const box = {
        margin: compact ? '0' : '8px', padding: compact ? '0' : '7px 10px',
        width: compact ? '36px' : undefined, height: compact ? '36px' : undefined,
        borderRadius: '8px', border: '1px solid var(--dsw-alias-border-l2, rgba(130,130,130,0.28))',
        background: 'var(--dsw-alias-bg-layer-2, rgba(130,130,130,0.09))',
        fontSize: compact ? '16px' : '11px', lineHeight: compact ? '34px' : '15px',
        color: 'var(--dsw-alias-label-primary, rgba(225,225,225,0.95))', display: 'flex',
        flexDirection: compact ? 'row' : 'column', alignItems: compact ? 'center' : undefined,
        justifyContent: compact ? 'center' : undefined, gap: '3px', fontVariantNumeric: 'tabular-nums',
        boxSizing: 'border-box',
      };
      const row = { display: 'flex', justifyContent: 'space-between', gap: '10px' };
      const label = { color: 'var(--dsw-alias-label-secondary, rgba(180,180,180,0.85))' };
      const value = { marginLeft: 'auto', textAlign: 'right', whiteSpace: 'nowrap', fontWeight: 600, color: 'var(--dsw-alias-label-primary, rgba(225,225,225,0.95))' };

      return jsxRuntime.jsx('div', {
        ref: rootRef, style: box, title: summary, 'aria-label': summary,
        children: compact
          ? jsxRuntime.jsx('span', { 'aria-hidden': 'true', children: '¥' })
          : [
            jsxRuntime.jsxs('div', { style: row, children: [jsxRuntime.jsx('span', { style: label, children: '余额' }), jsxRuntime.jsx('span', { style: value, children: balanceText })] }, 'balance'),
            jsxRuntime.jsxs('div', { style: row, children: [jsxRuntime.jsx('span', { style: label, children: dailyLabel }), jsxRuntime.jsx('span', { style: value, children: todayText })] }, 'daily'),
            jsxRuntime.jsxs('div', { style: row, children: [jsxRuntime.jsx('span', { style: label, children: '今日估算' }), jsxRuntime.jsx('span', { style: value, children: costText })] }, 'cost'),
          ],
      });
    }

    function apply(ctx) {
      return diagnostics.guard('apply', () => {
        ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
          name: 'sidebar.footer.action', id: 'balance-meter', order: 0,
        }, () => jsxRuntime.jsx(BalanceMeter, { sessions: ctx.sessions })));
      }, { surface: 'client' });
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
