window.__ModuleLoader__.load({
  id: 'dsh-fairy-roleplay',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
    const React = require('react');
    const jsx = require('react/jsx-runtime');
    const { Button, StateDot } = require('@deepseek-ai/dsh-client-ui-primitives');

    const LEVELS = [
      { value: 'off', label: '关闭（不检查）' },
      { value: 'l1', label: 'L1 词表与句式（推荐）' },
      { value: 'l2', label: 'L1-L2 加节奏' },
      { value: 'l3', label: 'L1-L3 加内容' },
      { value: 'l4', label: 'L1-L4 含通读终审' },
    ];

    function row(label, control) {
      return jsx.jsxs('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '4px 0' }, children: [
        jsx.jsx('span', { style: { flex: '0 0 260px', fontSize: '13px' }, children: label }),
        control,
      ] });
    }

    function RoleplaySection() {
      const [state, setState] = React.useState(null);
      const [draft, setDraft] = React.useState(null);
      const [status, setStatus] = React.useState('正在读取设置…');
      const [error, setError] = React.useState(false);
      const load = React.useCallback(async () => {
        try {
          const res = await fetch('/fairy-roleplay/state');
          const body = await res.json();
          if (!body?.ok) throw new Error(body?.error || '读取失败');
          setState(body);
          setDraft((current) => current ?? body.config);
          setStatus(body.style.count > 0 ? `风格库 ${body.style.count} 条` : '风格库为空：开启角色扮演后会自动学习');
          setError(false);
        } catch (loadError) {
          setStatus(loadError?.message || '读取失败。');
          setError(true);
        }
      }, []);
      // ponytail: 与 fairy-voice/fairy-memory 同策略——挂载时读一次、保存后刷新，不轮询。
      React.useEffect(() => { void load(); }, [load]);
      const change = (key, value) => setDraft((current) => ({ ...(current || {}), [key]: value }));
      const save = async () => {
        if (draft == null) return;
        setStatus('保存中…');
        try {
          const res = await fetch('/fairy-roleplay/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(draft) });
          const body = await res.json();
          if (!body?.ok) throw new Error(body?.error || '保存失败');
          setState((current) => ({ ...(current || {}), config: body.config }));
          setDraft(body.config);
          setStatus(body.changed?.length ? `已保存：${body.changed.join('、')}` : '没有变化');
          setError(false);
        } catch (saveError) {
          setStatus(saveError?.message || '保存失败。');
          setError(true);
        }
      };
      if (draft == null) {
        return jsx.jsx('section', { style: { padding: '12px' }, children: jsx.jsx('p', { style: { fontSize: '13px' }, children: status }) });
      }
      return jsx.jsxs('section', { style: { display: 'flex', flexDirection: 'column', gap: '6px', padding: '12px' }, children: [
        jsx.jsxs('p', { style: { fontSize: '13px', margin: '0' }, children: [
          '角色扮演模式用 ',
          jsx.jsx('code', { children: '/mode roleplay' }),
          ' 打开（会话头 chip 也能切）。角色身份来自人格包，语音绑定沿用语音引擎设置。',
        ] }),
        row('去AI味强度', jsx.jsx('select', {
          value: draft.humanizerLevel || 'l1', 'data-dsh-fairy-roleplay-level': 'true',
          onChange: (event) => change('humanizerLevel', event.target.value),
          style: { fontSize: '13px', minWidth: '240px' },
          children: LEVELS.map((level) => jsx.jsx('option', { value: level.value, children: level.label }, level.value)),
        })),
        row('风格库文件', jsx.jsx('input', {
          type: 'text', value: draft.stylePath || '', placeholder: state?.style?.path || '$DSH_HOME/fairy-roleplay/style.json',
          'data-dsh-fairy-roleplay-style-path': 'true',
          onChange: (event) => change('stylePath', event.target.value),
          style: { flex: '1 1 auto', fontSize: '13px' },
        })),
        jsx.jsxs('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', paddingTop: '4px' }, children: [
          jsx.jsx(Button, { onClick: () => { void save(); }, children: '保存' }),
          jsx.jsx(StateDot, { tone: error ? 'warning' : 'success' }),
          jsx.jsx('span', { style: { fontSize: '12px', opacity: 0.8 }, 'data-dsh-fairy-roleplay-status': 'true', children: status }),
        ] }),
        state?.style?.preview ? jsx.jsx('pre', { style: { fontSize: '12px', opacity: 0.85, whiteSpace: 'pre-wrap', margin: '4px 0 0' }, children: state.style.preview }) : null,
      ] });
    }

    /** Slot providers may run again on reload: release the previous registration first. */
    function injectRoleplaySlot(ctx, name, definition, component) {
      let disposeRegistration = null;
      return ctx.slots.inject(name, () => {
        const dispose = disposeRegistration;
        disposeRegistration = null;
        dispose?.();
        const registration = ctx.slots.register({ name, ...definition }, component);
        disposeRegistration = typeof registration === 'function' ? registration : null;
        return () => {
          disposeRegistration?.();
          disposeRegistration = null;
        };
      });
    }

    function apply(ctx) {
      const dispose = injectRoleplaySlot(ctx, 'settings.section', { id: 'fairy-roleplay', order: 33, label: () => '角色扮演' }, RoleplaySection);
      ctx.effect(() => () => dispose?.(), 'dsh-fairy-roleplay settings slot');
    }

    return { apply, inject: ['slots'] };
  },
});
