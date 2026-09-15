/**
 * 归一化提问件的契约测试。
 *
 * 覆盖两件事：
 *  1. **漂移**：每个手写 bundle 里的内联块必须与 `fairy-contracts/client-ask-kit.cjs`
 *     逐字节一致 —— 改文案只改真源，bundle 由 sync 脚本重写。
 *  2. **行为**：状态机真的跑一遍（保存、无改动、保存失败、读取失败、只读会话），
 *     并确认有官方 `Input` 时用它、没有时退回同令牌原生件。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { INLINED_PACKAGES, blockOf } from '../sync-ask-kit.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const SOURCE = join(REPO, 'fairy-contracts', 'client-ask-kit.cjs');
const { createAskKit, ASK_TEXT } = createRequire(import.meta.url)(SOURCE);

/** 最小 React 运行时：够跑 useAskForm，不引任何真实依赖。 */
function createRuntime() {
  let hooks = [];
  let index = 0;
  let effects = [];
  const React = {
    useState: (init) => {
      const slot = index++;
      if (!(slot in hooks)) hooks[slot] = typeof init === 'function' ? init() : init;
      return [hooks[slot], (next) => { hooks[slot] = typeof next === 'function' ? next(hooks[slot]) : next; }];
    },
    useRef: (init) => {
      const slot = index++;
      if (!(slot in hooks)) hooks[slot] = { current: init };
      return hooks[slot];
    },
    useCallback: (fn) => fn,
    useEffect: (fn, deps) => {
      const slot = index++;
      const previous = hooks[slot];
      const sameDeps = previous !== undefined && deps !== undefined
        && Array.isArray(previous.deps) && previous.deps.length === deps.length
        && deps.every((value, at) => Object.is(value, previous.deps[at]));
      if (sameDeps) return;
      hooks[slot] = { deps: Array.isArray(deps) ? deps.slice() : undefined };
      effects.push(fn);
    },
  };
  return {
    React,
    /** 渲染 → 冲刷 effect → 等异步落地 → 再渲染，返回结算后的句柄。 */
    async render(component) {
      const run = () => {
        index = 0;
        effects = [];
        const handle = component();
        const pending = effects;
        effects = [];
        return { handle, pending };
      };
      let pass = run();
      for (const effect of pass.pending) effect();
      await new Promise((done) => setImmediate(done));
      await new Promise((done) => setImmediate(done));
      pass = run();
      for (const effect of pass.pending) effect();
      await new Promise((done) => setImmediate(done));
      return run().handle;
    },
  };
}

/** 造一套 kit 并带上**同一个**运行时 —— 两处不用同一个，effect 就永远不会被冲刷。 */
function kitWith(primitives = {}) {
  const runtime = createRuntime();
  const jsx = (type, props) => ({ type, props: props ?? {} });
  return { ...createAskKit({ React: runtime.React, jsx, jsxs: jsx, primitives }), runtime };
}

test('每个手写 bundle 的内联块与真源逐字节一致', () => {
  const block = blockOf(readFileSync(SOURCE, 'utf8'));
  for (const pkg of INLINED_PACKAGES) {
    const file = join(REPO, pkg, 'lib', 'client.js');
    if (!existsSync(file)) continue;
    const bundle = readFileSync(file, 'utf8');
    assert.ok(bundle.includes(block.trimEnd()), `${pkg} 的提问件漂移了：跑 node fairy-system/sync-ask-kit.js`);
  }
});

test('保存成功后复读并给出同一句已保存文案', async () => {
  const kit = kitWith();
  const calls = [];
  const runtime = kit.runtime;
  const useForm = () => kit.useAskForm({
    load: async () => ({ provider: 'deepseek' }),
    save: async (draft) => { calls.push(draft); return { changed: draft.provider !== 'deepseek' }; },
    initial: { provider: '' },
  });
  const first = await runtime.render(() => useForm());
  assert.equal(first.status, '', '读成功后不留在读取中');
  assert.deepEqual(first.stored, { provider: 'deepseek' });
  first.change('provider', 'exa');
  const second = await runtime.render(() => useForm());
  assert.equal(second.draft.provider, 'exa');
  const outcome = await second.submit();
  assert.deepEqual(calls, [{ provider: 'exa' }]);
  assert.equal(outcome.changed, true);
});

test('没有改动时不写盘，只说一句没有需要保存的改动', async () => {
  const kit = kitWith();
  const runtime = createRuntime();
  let writes = 0;
  const useForm = () => kit.useAskForm({
    load: async () => ({ provider: 'exa' }),
    save: async () => { writes += 1; return { changed: false }; },
  });
  const handle = await runtime.render(() => useForm());
  const outcome = await handle.submit();
  assert.equal(writes, 1, '保存被调用一次');
  assert.equal(outcome.changed, false);
  assert.equal(ASK_TEXT.unchanged, '没有需要保存的改动。');
});

test('保存失败时状态里带原因，不吞错', async () => {
  const kit = kitWith();
  const runtime = kit.runtime;
  const useForm = () => kit.useAskForm({
    load: async () => ({}),
    save: async () => { throw new Error('HTTP 403'); },
  });
  const handle = await runtime.render(() => useForm());
  await assert.rejects(() => handle.submit());
  const after = await runtime.render(() => useForm());
  assert.match(after.status, /保存失败：HTTP 403/);
});

test('读取失败不吐栈，说明按已保存的值继续', async () => {
  const kit = kitWith();
  const runtime = kit.runtime;
  const useForm = () => kit.useAskForm({
    load: async () => { throw new Error('ECONNREFUSED'); },
    save: async () => ({ changed: false }),
  });
  const handle = await runtime.render(() => useForm());
  assert.match(handle.status, /暂时读不到设置/);
  assert.match(handle.status, /ECONNREFUSED/);
  assert.doesNotMatch(handle.status, /\n\s+at /, '不把栈吐进界面');
});

test('只读会话给同一句说明', () => {
  assert.equal(ASK_TEXT.readOnly, '当前会话不可写入主机设置，保存已停用。');
});

test('有官方 Input 时用官方件，否则退回同令牌原生 input', () => {
  const official = kitWith({ Input: function OfficialInput() {} }).AskText({ id: 'a', value: '', onChange: () => {} });
  assert.equal(official.type.name, 'OfficialInput');
  const fallback = kitWith().AskText({ id: 'a', value: '', onChange: () => {} });
  assert.equal(fallback.type, 'input');
  assert.equal(fallback.props.type, 'text');
});

test('开关与选择控件是受控件，回调只给值', () => {
  const kit = kitWith();
  const seen = [];
  const toggle = kit.AskToggle({ id: 't', label: '开', checked: true, onChange: (value) => seen.push(value) });
  const box = toggle.props.children[0].props.children[0];
  assert.equal(box.props.type, 'checkbox');
  assert.equal(box.props.checked, true);
  box.props.onChange({ target: { checked: false } });
  assert.deepEqual(seen, [false]);
  const select = kit.AskSelect({ id: 's', value: 'b', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }], onChange: (value) => seen.push(value) });
  assert.equal(select.props.value, 'b');
  select.props.onChange({ target: { value: 'a' } });
  assert.deepEqual(seen, [false, 'a']);
});
