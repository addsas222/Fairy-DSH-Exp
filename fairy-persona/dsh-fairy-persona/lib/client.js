window.__ModuleLoader__.load({
  id: 'dsh-fairy-persona',
  factory: (require) => {
    const React = require('react');
    const jsx = require('react/jsx-runtime');
    const { Tooltip } = require('@deepseek-ai/dsh-client-ui-primitives');

    const STYLE_ID = 'dsh-fairy-persona-style';
    const EVENT_CHANGED = 'fairy-persona-changed';
    const SETTINGS_SECTION = 'settings.section';
    const CHIP_SLOT = 'conversation.session.header.utilities';
    const NONE_LABEL = '不使用人格包（部署默认）';
    const CHIP_TOOLTIP = '点击切换人格包';
    /* The input only carries the id; the host is the one that judges it, so a
     * rejected id comes back on the result line instead of a disabled button. */
    const SCAFFOLD_PLACEHOLDER = '新人格包 id（小写字母、数字、连字符）';

    /* The persona selection lives on the host (it applies deployment-wide), so
     * the client keeps no copy of it: every surface reads this one catalog,
     * refreshed from the plugin's own HTTP surface. The window event exists for
     * other bundles; this module reacts through the store. */
    let catalog = { packs: [], activeId: '', activeName: '', ready: false };
    const listeners = new Set();
    let inFlight = null;

    function publish(next) {
      catalog = next;
      for (const listener of listeners) listener();
    }

    function subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }

    function getSnapshot() {
      return catalog;
    }

    function publishChanged(packId, name) {
      window.dispatchEvent(new CustomEvent(EVENT_CHANGED, { detail: { packId, name } }));
    }

    async function request(path, { method = 'GET', body } = {}) {
      const response = await fetch(path, {
        method,
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const value = await response.json().catch(() => null);
      if (!response.ok || value?.ok === false) throw new Error(value?.error?.message || `请求失败（${response.status}）`);
      return value;
    }

    function refresh() {
      inFlight ??= request('/fairy-persona/list').then((value) => {
        inFlight = null;
        const packs = Array.isArray(value?.packs) ? value.packs : [];
        const activeId = typeof value?.active === 'string' ? value.active : '';
        const pack = packs.find(candidate => candidate.id === activeId);
        // The first read announces the active persona; later reads that found
        // the same one stay silent so listeners only hear real changes.
        const changed = !catalog.ready || activeId !== catalog.activeId;
        publish({ packs, activeId, activeName: pack?.name || '', ready: true });
        if (changed) publishChanged(activeId, pack?.name || '');
        return catalog;
      }, (error) => {
        inFlight = null;
        publish({ ...catalog, ready: true });
        throw error;
      });
      return inFlight;
    }

    async function selectPersona(id) {
      const value = await request('/fairy-persona/select', { method: 'POST', body: { id } });
      const activeId = typeof value?.active === 'string' ? value.active : '';
      const pack = catalog.packs.find(candidate => candidate.id === activeId);
      publish({ ...catalog, activeId, activeName: pack?.name || '', ready: true });
      publishChanged(activeId, pack?.name || '');
      return value;
    }

    function toneLine(tone) {
      if (!tone || typeof tone !== 'object' || Array.isArray(tone)) return '';
      return Object.entries(tone)
        .map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
        .join(' · ');
    }

    function PersonaSection() {
      const state = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
      const [draft, setDraft] = React.useState(null);
      const [preview, setPreview] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState(null);
      const [roots, setRoots] = React.useState([]);
      const [newId, setNewId] = React.useState('');
      const [creating, setCreating] = React.useState(false);
      const [result, setResult] = React.useState(null);
      const selectedId = draft === null ? state.activeId : draft;

      React.useEffect(() => {
        refresh().catch((failure) => { setError(failure.message); });
      }, []);

      React.useEffect(() => {
        let alive = true;
        request('/fairy-persona/roots').then((value) => {
          if (alive) setRoots(Array.isArray(value?.roots) ? value.roots : []);
        }, (failure) => {
          if (alive) setError(failure.message);
        });
        return () => { alive = false; };
      }, []);

      React.useEffect(() => {
        if (!selectedId) {
          setPreview(null);
          return undefined;
        }
        let alive = true;
        request('/fairy-persona/preview', { method: 'POST', body: { id: selectedId } }).then((value) => {
          if (alive) setPreview(value);
        }, () => {
          if (alive) setPreview(null);
        });
        return () => { alive = false; };
      }, [selectedId]);

      const apply = () => {
        setBusy(true);
        setError(null);
        return selectPersona(selectedId).then(() => {
          setDraft(null);
        }, (failure) => {
          setError(failure.message);
        }).finally(() => {
          setBusy(false);
        });
      };

      const create = () => {
        setCreating(true);
        setError(null);
        setResult(null);
        return request('/fairy-persona/scaffold', { method: 'POST', body: { id: newId.trim() } }).then((value) => {
          setResult({ ok: true, text: `已创建：${value.path}` });
          setNewId('');
          // The pack exists; a failed re-read only leaves the list one scan stale.
          return refresh().catch((failure) => { setError(failure.message); });
        }, (failure) => {
          setResult({ ok: false, text: failure.message });
        }).finally(() => {
          setCreating(false);
        });
      };

      const tone = toneLine(preview?.tone);
      return jsx.jsxs('section', { className: 'dsh-fairy-persona-section', 'data-dsh-fairy-persona-panel': 'true', children: [
        jsx.jsx('h2', { className: 'dsh-fairy-persona-title', children: '人格' }),
        jsx.jsx('p', { className: 'dsh-fairy-persona-copy', children: '人格包提供 Fairy 的系统提示词、语域调色与语音绑定。切换后对部署内的所有会话生效，并持久保存。' }),
        jsx.jsxs('div', { className: 'dsh-fairy-persona-panel', children: [
          jsx.jsxs('div', { className: 'dsh-fairy-persona-row', children: [
            jsx.jsx('span', { className: 'dsh-fairy-persona-label', children: '当前人格' }),
            jsx.jsx('span', { className: 'dsh-fairy-persona-value', 'data-dsh-fairy-persona-active': state.activeId, children: state.activeId ? (state.activeName || state.activeId) : '未启用' })
          ] }),
          jsx.jsxs('label', { className: 'dsh-fairy-persona-field', children: [
            jsx.jsx('span', { className: 'dsh-fairy-persona-label', children: '人格包' }),
            jsx.jsxs('select', {
              className: 'dsh-fairy-persona-select',
              'data-dsh-fairy-persona-select': 'true',
              value: selectedId,
              disabled: busy || !state.ready,
              onChange: (event) => { setDraft(event.target.value); },
              children: [
                jsx.jsx('option', { value: '', children: NONE_LABEL }),
                ...state.packs.map(pack => jsx.jsx('option', { value: pack.id, children: pack.name }))
              ]
            })
          ] }),
          state.packs.length ? null : jsx.jsx('p', { className: 'dsh-fairy-persona-hint', children: '未发现人格包。把包目录放入 $DSH_HOME/personas/ 或仓库 persona-packs/ 后重新打开本面板。' }),
          jsx.jsxs('div', { className: 'dsh-fairy-persona-preview', 'data-dsh-fairy-persona-preview': selectedId, children: [
            jsx.jsx('span', { className: 'dsh-fairy-persona-label', children: '调色' }),
            jsx.jsx('p', { className: 'dsh-fairy-persona-tone', children: tone || '该人格包未提供 tone.json。' }),
            jsx.jsx('p', { className: 'dsh-fairy-persona-head', children: preview?.promptHead ? `${preview.promptHead}…` : '选中后显示人格文档开头。' })
          ] }),
          jsx.jsxs('div', { className: 'dsh-fairy-persona-actions', children: [
            jsx.jsx('button', {
              className: 'dsh-fairy-persona-button dsh-fairy-persona-button--primary',
              type: 'button',
              disabled: busy || !state.ready || selectedId === state.activeId,
              onClick: apply,
              children: busy ? '切换中…' : '切换人格'
            })
          ] }),
          jsx.jsxs('div', { className: 'dsh-fairy-persona-roots', 'data-dsh-fairy-persona-roots': roots.join(' | '), children: [
            jsx.jsx('span', { className: 'dsh-fairy-persona-label', children: '扫描根' }),
            roots.length
              ? roots.map(root => jsx.jsx('code', { key: root, className: 'dsh-fairy-persona-root', children: root }))
              : jsx.jsx('p', { className: 'dsh-fairy-persona-hint', children: '扫描根尚未就绪。' }),
            jsx.jsx('p', { className: 'dsh-fairy-persona-hint', children: '用文件管理器打开上述目录即可直接新增或编辑人格包；改动后重新打开本面板即可看到。' })
          ] }),
          jsx.jsxs('div', { className: 'dsh-fairy-persona-scaffold', children: [
            jsx.jsx('span', { className: 'dsh-fairy-persona-label', children: '新建人格包' }),
            jsx.jsxs('div', { className: 'dsh-fairy-persona-inline', children: [
              jsx.jsx('input', {
                className: 'dsh-fairy-persona-input',
                type: 'text',
                value: newId,
                placeholder: SCAFFOLD_PLACEHOLDER,
                disabled: creating || !state.ready,
                'data-dsh-fairy-persona-scaffold-input': 'true',
                onChange: (event) => { setNewId(event.target.value); }
              }),
              jsx.jsx('button', {
                className: 'dsh-fairy-persona-button',
                type: 'button',
                disabled: creating || !state.ready || newId.trim() === '',
                'data-dsh-fairy-persona-scaffold-submit': 'true',
                onClick: create,
                children: creating ? '创建中…' : '创建'
              })
            ] }),
            jsx.jsx('p', {
              className: 'dsh-fairy-persona-result',
              'data-ok': result ? String(result.ok) : '',
              'data-dsh-fairy-persona-scaffold-result': result ? result.text : '',
              children: result ? result.text : '在扫描根的首个（用户根）生成模板包：persona.yml / prompt.md / tone.json。'
            })
          ] }),
          jsx.jsx('p', { className: 'dsh-fairy-persona-status', 'data-error': error ? 'true' : 'false', children: error || (state.activeId ? `已启用：${state.activeName || state.activeId}` : '未启用人格包，使用部署默认人格。') })
        ] })
      ] });
    }

    function PersonaChip() {
      const state = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
      const [open, setOpen] = React.useState(false);
      const [error, setError] = React.useState(null);
      const rootRef = React.useRef(null);
      React.useEffect(() => {
        refresh().catch((failure) => { setError(failure.message); });
      }, []);
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
      // No persona is the deployment-default state, and an empty chip would
      // only take header space; the settings card is where the first pack is
      // created, and the chip switches once one is active.
      if (!state.activeId) return null;
      const name = state.activeName || state.activeId;
      const choose = (id) => {
        setError(null);
        // A failure keeps the menu open, so its message is where the click was.
        selectPersona(id).then(() => { setOpen(false); }, (failure) => { setError(failure.message); });
      };
      return jsx.jsxs('span', {
        ref: rootRef,
        className: 'dsh-fairy-persona-chip-wrap',
        'data-dsh-fairy-persona-chip': state.activeId,
        children: [
          jsx.jsx(Tooltip, { label: CHIP_TOOLTIP, children: jsx.jsx('button', {
            className: 'dsh-fairy-persona-chip',
            type: 'button',
            'aria-haspopup': 'menu',
            'aria-expanded': open ? 'true' : 'false',
            'aria-label': `当前人格：${name}。${CHIP_TOOLTIP}`,
            onClick: () => setOpen(!open),
            children: name
          }) }),
          open ? jsx.jsxs('div', { className: 'dsh-fairy-persona-menu', role: 'menu', children: [
            jsx.jsx('button', {
              className: 'dsh-fairy-persona-menu-row',
              type: 'button',
              role: 'menuitemradio',
              'aria-checked': state.activeId === '' ? 'true' : 'false',
              'data-dsh-fairy-persona-option': '',
              onClick: () => choose(''),
              children: NONE_LABEL
            }),
            ...state.packs.map(pack => jsx.jsx('button', {
              key: pack.id,
              className: 'dsh-fairy-persona-menu-row',
              type: 'button',
              role: 'menuitemradio',
              'aria-checked': pack.id === state.activeId ? 'true' : 'false',
              'data-dsh-fairy-persona-option': pack.id,
              onClick: () => choose(pack.id),
              children: pack.name
            })),
            error ? jsx.jsx('p', { className: 'dsh-fairy-persona-menu-error', children: error }) : null
          ] }) : null
        ]
      });
    }

    function ensurePersonaStyles() {
      if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.setAttribute('data-plugin', 'dsh-fairy-persona');
      style.textContent = `
.dsh-fairy-persona-section{display:grid;gap:16px;width:min(640px,100%);padding:4px 0 12px;color:var(--dsw-alias-label-primary)}
.dsh-fairy-persona-title{margin:0;font-size:18px;font-weight:600;line-height:1.3}
.dsh-fairy-persona-copy{margin:0;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:1.65}
.dsh-fairy-persona-panel{display:grid;gap:12px;padding:14px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1)}
.dsh-fairy-persona-row{display:flex;align-items:center;justify-content:space-between;gap:16px}
.dsh-fairy-persona-field{display:grid;gap:6px}
.dsh-fairy-persona-label{font-size:14px;font-weight:600}
.dsh-fairy-persona-value{font-size:13px;color:var(--dsw-alias-label-secondary);text-align:right}
.dsh-fairy-persona-select{width:100%;height:34px;padding:0 8px;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-0);color:var(--dsw-alias-label-primary);font-size:13px}
.dsh-fairy-persona-select:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dsh-fairy-persona-preview{display:grid;gap:6px;padding-top:4px;border-top:1px solid var(--dsw-alias-border-l2)}
.dsh-fairy-persona-tone{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.6;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:1;-webkit-box-orient:vertical}
.dsh-fairy-persona-head{margin:0;max-height:132px;overflow:auto;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.6;white-space:pre-wrap}
.dsh-fairy-persona-hint{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.6}
.dsh-fairy-persona-actions{display:flex;justify-content:flex-end;gap:8px}
.dsh-fairy-persona-button{height:30px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:13px;cursor:pointer}
.dsh-fairy-persona-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dsh-fairy-persona-button--primary{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-brand-primary);color:#fff}
.dsh-fairy-persona-button:disabled{cursor:not-allowed;opacity:.5}
.dsh-fairy-persona-status{min-height:18px;margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.5}
.dsh-fairy-persona-status[data-error="true"]{color:var(--dsw-alias-state-error-primary)}
.dsh-fairy-persona-roots{display:grid;gap:6px;padding-top:12px;border-top:1px solid var(--dsw-alias-border-l2)}
.dsh-fairy-persona-root{display:block;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.6;word-break:break-all}
.dsh-fairy-persona-scaffold{display:grid;gap:8px;padding-top:12px;border-top:1px solid var(--dsw-alias-border-l2)}
.dsh-fairy-persona-inline{display:flex;gap:8px}
.dsh-fairy-persona-input{flex:1;min-width:0;height:30px;padding:0 8px;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-0);color:var(--dsw-alias-label-primary);font-size:13px}
.dsh-fairy-persona-input:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dsh-fairy-persona-result{min-height:18px;margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.5;word-break:break-all}
.dsh-fairy-persona-result[data-ok="true"]{color:var(--dsw-alias-state-success-primary, var(--dsw-alias-label-primary))}
.dsh-fairy-persona-result[data-ok="false"]{color:var(--dsw-alias-state-error-primary)}
.dsh-fairy-persona-chip-wrap{position:relative;display:inline-flex}
.dsh-fairy-persona-menu{position:absolute;top:calc(100% + 6px);right:0;z-index:60;display:grid;min-width:152px;max-height:280px;overflow:auto;padding:4px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);box-shadow:0 10px 28px rgba(0,0,0,.28)}
.dsh-fairy-persona-menu-row{display:block;width:100%;padding:6px 8px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);font-size:12px;line-height:1.4;text-align:left;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-fairy-persona-menu-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-fairy-persona-menu-row[aria-checked="true"]{background:var(--dsw-alias-interactive-bg-hover);font-weight:600;color:var(--dsw-alias-brand-primary)}
.dsh-fairy-persona-menu-error{margin:4px;color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:1.5}
.dsh-fairy-persona-chip{display:inline-flex;align-items:center;max-width:132px;height:24px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:12px;line-height:1;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-fairy-persona-chip:hover{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary)}
`;
      (document.head || document.documentElement).appendChild(style);
    }

    function injectPersonaSlot(ctx, name, definition, component) {
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
      ensurePersonaStyles();
      const slotDisposers = [
        injectPersonaSlot(ctx, SETTINGS_SECTION, { id: 'fairy-persona', order: 25, label: () => '人格' }, PersonaSection),
        injectPersonaSlot(ctx, CHIP_SLOT, { id: 'fairy-persona-chip', order: 30 }, PersonaChip)
      ].filter((dispose) => typeof dispose === 'function');
      ctx.effect(() => () => {
        for (const dispose of slotDisposers) dispose();
        document.getElementById(STYLE_ID)?.remove();
      }, 'dsh-fairy-persona slot registrations');
    }

    return { apply, inject: ['slots'] };
  }
});
