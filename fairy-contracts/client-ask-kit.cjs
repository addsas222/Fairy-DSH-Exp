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

module.exports = { createAskKit, ASK_TEXT, ASK_STYLE, describeError };
