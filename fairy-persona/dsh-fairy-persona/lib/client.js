window.__ModuleLoader__.load({
  id: 'dsh-fairy-persona',
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
    const { Tooltip, Input, Button, StateDot } = require('@deepseek-ai/dsh-client-ui-primitives');

    /* 提问行、动作与状态只走归一化提问件：外观、读写逻辑、状态文案全仓只那一份。
     * `ASK_TEXT`/`ASK_STYLE`/`describeError` 由标记区给出，直接用；组件与状态机
     * 自己拿一份绑好官方原语的实例 —— 本包不再自造输入控件与加载/保存/忙状态。 */
    const askKit = createAskKit({
      React,
      jsx: jsx.jsx,
      jsxs: jsx.jsxs,
      primitives: { Input, Button, StateDot },
    });

    const STYLE_ID = 'dsh-fairy-persona-style';
    const EVENT_CHANGED = 'fairy-persona-changed';
    const SETTINGS_SECTION = 'settings.section';
    const CHIP_SLOT = 'conversation.session.header.utilities';
    const NONE_LABEL = '不使用人格包（部署默认）';
    const CHIP_TOOLTIP = '点击切换人格包';
    /* The input only carries the id; the host is the one that judges it, so a
     * rejected id comes back on the result line instead of a disabled button. */
    const SCAFFOLD_PLACEHOLDER = '新人格包 id（小写字母、数字、连字符）';
    // 提问件的 id 同时是标签的 htmlFor 与 e2e 的稳定选择器（套件给原生件打 data-ask）。
    const PACK_FIELD_ID = 'dsh-fairy-persona-pack';
    const SCAFFOLD_FIELD_ID = 'dsh-fairy-persona-scaffold';
    const PACK_EMPTY_HINT = '未发现人格包。把包目录放入 $DSH_HOME/personas/ 或仓库 persona-packs/ 后重新打开本面板。';
    const ROOTS_HINT = '用文件管理器打开上述目录即可直接新增或编辑人格包；改动后重新打开本面板即可看到。';
    const SCAFFOLD_HINT = '在扫描根的首个（用户根）生成模板包：persona.yml / prompt.md / tone.json。';

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
      const [preview, setPreview] = React.useState(null);
      const [roots, setRoots] = React.useState([]);
      const [rootsError, setRootsError] = React.useState(null);
      const [newId, setNewId] = React.useState('');
      const [created, setCreated] = React.useState(null);

      /* 人格选择存在主机侧（对全部署生效），客户端不存副本：读一次就是当前值，
       * 保存即 POST select。忙、状态文案、保存后复读、失败原因全交给提问件。
       * 草稿没动过（下拉没碰）时，它就是主机当前值 —— 别把 undefined 当成改动。 */
      const form = askKit.useAskForm({
        load: () => refresh().then((snapshot) => ({ packId: snapshot.activeId })),
        save: (draft, stored) => {
          const wanted = draft.packId === undefined ? stored?.packId : draft.packId;
          return wanted === stored?.packId ? { changed: false } : selectPersona(wanted);
        },
      });
      // 下拉没动过就跟着主机当前值；动过之后显示草稿，保存成功由套件复位草稿。
      const selectedId = form.draft.packId === undefined ? state.activeId : form.draft.packId;

      React.useEffect(() => {
        let alive = true;
        request('/fairy-persona/roots').then((value) => {
          if (!alive) return;
          setRoots(Array.isArray(value?.roots) ? value.roots : []);
          setRootsError(null);
        }, (failure) => {
          if (alive) setRootsError(failure.message);
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

      /* 建包是一次性动作，不是草稿保存：走 run() 同一条忙通道，结果进 AskResult。
       * 主机自己判 id，所以非法 id 由它的报错回到结果行，而不是靠按钮禁用。 */
      const create = () => form.run('create', () => request('/fairy-persona/scaffold', {
        method: 'POST',
        body: { id: newId.trim() },
      }).then((value) => {
        setCreated({ ok: true, text: `已创建：${value.path}` });
        setNewId('');
        // 包已经落盘；复读失败只让列表晚一次扫描看到它，读失败有自己的状态行。
        form.reload();
      }, (failure) => {
        setCreated({ ok: false, text: failure.message });
      }));

      const tone = toneLine(preview?.tone);
      const status = form.status || (state.activeId
        ? `已启用：${state.activeName || state.activeId}`
        : '未启用人格包，使用部署默认人格。');
      return jsx.jsxs(askKit.AskSection, {
        title: '人格',
        ariaLabel: '人格',
        description: ['人格包提供 Fairy 的系统提示词、语域调色与语音绑定。切换后对部署内的所有会话生效，并持久保存。'],
        children: [
          jsx.jsxs('div', { className: 'dsh-fairy-persona-panel', 'data-dsh-fairy-persona-panel': 'true', children: [
            jsx.jsxs('div', { className: 'dsh-fairy-persona-row', 'data-dsh-fairy-persona-active': state.activeId, children: [
              jsx.jsx('span', { className: 'dsh-fairy-persona-label', children: '当前人格' }),
              jsx.jsx('span', { className: 'dsh-fairy-persona-value', children: state.activeId ? (state.activeName || state.activeId) : '未启用' })
            ] }),
            jsx.jsx(askKit.AskRow, {
              id: PACK_FIELD_ID,
              label: '人格包',
              hint: state.packs.length ? undefined : PACK_EMPTY_HINT,
              children: jsx.jsx(askKit.AskSelect, {
                id: PACK_FIELD_ID,
                value: selectedId,
                disabled: form.busy !== null || !state.ready,
                options: [
                  { value: '', label: NONE_LABEL },
                  ...state.packs.map(pack => ({ value: pack.id, label: pack.name }))
                ],
                onChange: (value) => { form.change('packId', value); }
              })
            }),
            jsx.jsxs('div', { className: 'dsh-fairy-persona-preview', 'data-dsh-fairy-persona-preview': selectedId, children: [
              jsx.jsx('span', { className: 'dsh-fairy-persona-label', children: '调色' }),
              jsx.jsx('p', { className: 'dsh-fairy-persona-tone', children: tone || '该人格包未提供 tone.json。' }),
              jsx.jsx('p', { className: 'dsh-fairy-persona-head', children: preview?.promptHead ? `${preview.promptHead}…` : '选中后显示人格文档开头。' })
            ] }),
            jsx.jsx(askKit.AskActions, {
              busy: form.busy,
              status,
              primary: '切换人格',
              onPrimary: form.submit,
              writable: state.ready
            }),
            jsx.jsxs('div', { className: 'dsh-fairy-persona-roots', 'data-dsh-fairy-persona-roots': roots.join(' | '), children: [
              jsx.jsx('span', { className: 'dsh-fairy-persona-label', children: '扫描根' }),
              roots.length
                ? roots.map(root => jsx.jsx('code', { key: root, className: 'dsh-fairy-persona-root', children: root }))
                : (rootsError ? null : jsx.jsx('p', { className: 'dsh-fairy-persona-hint', children: '扫描根尚未就绪。' })),
              jsx.jsx(askKit.AskResult, { ok: false, text: rootsError }),
              jsx.jsx('p', { className: 'dsh-fairy-persona-hint', children: ROOTS_HINT })
            ] }),
            jsx.jsxs('div', { className: 'dsh-fairy-persona-scaffold', children: [
              jsx.jsx(askKit.AskRow, {
                id: SCAFFOLD_FIELD_ID,
                label: '新建人格包',
                children: jsx.jsx(askKit.AskText, {
                  id: SCAFFOLD_FIELD_ID,
                  value: newId,
                  placeholder: SCAFFOLD_PLACEHOLDER,
                  disabled: form.busy !== null || !state.ready,
                  onChange: setNewId
                })
              }),
              jsx.jsx(askKit.AskActions, {
                busy: form.busy,
                primary: '创建',
                onPrimary: create,
                // 套件只用忙与 writable 两把锁：这里 writable 还兼着"id 非空且目录已就绪"。
                writable: state.ready && newId.trim() !== ''
              }),
              jsx.jsx('div', {
                'data-ok': created ? String(created.ok) : '',
                'data-dsh-fairy-persona-scaffold-result': created ? created.text : '',
                children: created
                  ? jsx.jsx(askKit.AskResult, { ok: created.ok, text: created.text })
                  : jsx.jsx('p', { className: 'dsh-fairy-persona-hint', children: SCAFFOLD_HINT })
              })
            ] })
          ] })
        ]
      });
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
      // 渲染级验证用的 document 替身只有 createElement/head：少一个方法不该
      // 让整张卡挂掉（apply 抛错会连着槽注册一起丢）。
      if (typeof document === 'undefined' || document.getElementById?.(STYLE_ID)) return;
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.setAttribute('data-plugin', 'dsh-fairy-persona');
      style.textContent = `
.dsh-fairy-persona-panel{display:grid;gap:12px;padding:14px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1)}
.dsh-fairy-persona-row{display:flex;align-items:center;justify-content:space-between;gap:16px}
.dsh-fairy-persona-label{font-size:14px;font-weight:600}
.dsh-fairy-persona-value{font-size:13px;color:var(--dsw-alias-label-secondary);text-align:right}
.dsh-fairy-persona-preview{display:grid;gap:6px;padding-top:4px;border-top:1px solid var(--dsw-alias-border-l2)}
.dsh-fairy-persona-tone{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.6;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:1;-webkit-box-orient:vertical}
.dsh-fairy-persona-head{margin:0;max-height:132px;overflow:auto;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.6;white-space:pre-wrap}
.dsh-fairy-persona-hint{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.6}
.dsh-fairy-persona-roots{display:grid;gap:6px;padding-top:12px;border-top:1px solid var(--dsw-alias-border-l2)}
.dsh-fairy-persona-root{display:block;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.6;word-break:break-all}
.dsh-fairy-persona-scaffold{display:grid;gap:8px;padding-top:12px;border-top:1px solid var(--dsw-alias-border-l2)}
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
