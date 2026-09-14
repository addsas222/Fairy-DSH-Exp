/**
 * fairy preset 的两个 shim 的真实 apply 单测。
 *
 * 为什么要有这组：发现层（agentPreset.list）只看**行名是否合法**，看不到 apply 里
 * 的 API 形状错误——第一版 shim 用 `ctx.systemPrompt.section(name, text)`（字符串两参、
 * 无 order），发现层照样报 `fairy user ok`，而真实会话里那段落根本挂不上。
 * 这里按本仓既有约定（fairy-modes/test/modes.test.js 的 fakeHost）做真调用。
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const HOME_DIR = process.env.USERPROFILE || process.env.HOME || '';
const PRESET_DIR = path.resolve(import.meta.dirname, '..', '..', '.agent-presets', 'fairy');
const CORE = path.join(PRESET_DIR, 'plugins', 'fairy-core-runtime.mjs');
const GATE = path.join(PRESET_DIR, 'plugins', 'fairy-safety-gate.mjs');

/** 造一个只含 systemPrompt.section 的 fake ctx（形状对齐 fairy-modes 的 fakeHost）。 */
function fakeHost() {
  const sections = new Map();
  const ctx = {
    systemPrompt: {
      section(definition) {
        assert.equal(typeof definition, 'object', 'section 必须收单个对象（既有约定）');
        assert.equal(typeof definition.name, 'string');
        assert.equal(typeof definition.order, 'number', 'order 必须是字面数字（0.1.1 契约）');
        assert.equal(typeof definition.text, 'string');
        if (sections.has(definition.name)) throw new Error(`duplicate prompt section ${definition.name}`);
        sections.set(definition.name, definition);
        return () => sections.delete(definition.name);
      },
    },
  };
  return { ctx, sections };
}

/** 造一个"有语料、无私有 runtime"的临时 repo 根，用于降级路径。 */
function fakeRepoWithoutRuntime() {
  const root = mkdtempSync(path.join(tmpdir(), 'fairy-shim-'));
  const dir = path.join(root, '.agent-presets', 'fairy');
  for (const sub of ['behavior', 'personality', 'canon', 'style']) mkdirSync(path.join(dir, sub), { recursive: true });
  writeFileSync(path.join(dir, 'behavior/fairy_behavior_rules.json'), JSON.stringify({ rules: [{}, {}, {}] }));
  writeFileSync(path.join(dir, 'personality/fairy_personality.json'), JSON.stringify({ traits: { a: 1, b: 2 } }));
  writeFileSync(path.join(dir, 'canon/fairy_canon.json'), JSON.stringify({ entries: [{}, {}] }));
  writeFileSync(path.join(dir, 'style/fairy_speech_style.json'), JSON.stringify({ sample_count: 42 }));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

async function loadWith(repoRoot, file) {
  const prev = process.env.DSH_FAIRY_REPO_ROOT;
  process.env.DSH_FAIRY_REPO_ROOT = repoRoot;
  try {
    return await import(`${pathToFileURL(file).href}?v=${Math.random()}`);
  } finally {
    if (prev === undefined) delete process.env.DSH_FAIRY_REPO_ROOT; else process.env.DSH_FAIRY_REPO_ROOT = prev;
  }
}

test('voice-core shim mounts one ordered section and returns a dispose', async () => {
  const repo = fakeRepoWithoutRuntime();
  try {
    const mod = await loadWith(repo.root, CORE);
    const { ctx, sections } = fakeHost();
    const dispose = await mod.apply(ctx, {});

    assert.equal(sections.size, 1, '降级模式应挂且只挂一个段落');
    const [definition] = [...sections.values()];
    assert.equal(definition.name, 'fairy-voice-core');
    assert.equal(typeof definition.order, 'number');
    assert.match(definition.text, /Fairy 语音核心/);
    assert.match(definition.text, /Behavior|行为规则|样本量/, '速查内容应来自随 preset 的语料');
    assert.equal(typeof dispose, 'function', 'apply 应返回 dispose（宿主卸载时清理）');

    dispose();
    assert.equal(sections.size, 0, 'dispose 后段落应被移除');
  } finally {
    repo.cleanup();
  }
});

test('safety-gate shim mounts one ordered section distinct from voice-core', async () => {
  const repo = fakeRepoWithoutRuntime();
  try {
    const mod = await loadWith(repo.root, GATE);
    const { ctx, sections } = fakeHost();
    const dispose = await mod.apply(ctx, {});

    const [definition] = [...sections.values()];
    assert.equal(definition.name, 'fairy-safety-gate');
    assert.notEqual(definition.name, 'fairy-voice-core');
    assert.match(definition.text, /警告/);
    dispose();
    assert.equal(sections.size, 0);
  } finally {
    repo.cleanup();
  }
});

test('both shims forward to the private runtime when it exists', async () => {
  const repo = fakeRepoWithoutRuntime();
  try {
    const runtimeDir = path.join(repo.root, '.agent-presets', 'fairy', 'runtime');
    mkdirSync(runtimeDir, { recursive: true });
    // 私有真身：记录被调用的事实，并挂一个自己的段落
    const stub = 'export async function apply(ctx) { ctx.systemPrompt.section({ name: "private-runtime", order: 7, text: "real" }); return () => {}; }\n';
    writeFileSync(path.join(runtimeDir, 'index.js'), stub);
    writeFileSync(path.join(runtimeDir, 'safety-gate.js'), stub);

    const core = await loadWith(repo.root, CORE);
    const gate = await loadWith(repo.root, GATE);
    const host1 = fakeHost();
    const host2 = fakeHost();
    await core.apply(host1.ctx, {});
    await gate.apply(host2.ctx, {});

    assert.equal([...host1.sections.keys()][0], 'private-runtime', 'voice-core 应转发给私有真身');
    assert.equal([...host2.sections.keys()][0], 'private-runtime', 'safety-gate 应转发给私有真身');
  } finally {
    repo.cleanup();
  }
});

/**
 * world-core 检索：把"借来的游戏文本"从"文件存在"推进到"能被工具真的查到"。
 * 索引由 C:/tmp/zzz-extract2.mjs 从 ZZZ 官方 TextMap 提取（本机，不进仓库）。
 * 索引/语料缺失时整组跳过——它不是仓库资产，别的机器上本来就没有。
 */
const WORLD_CORE = path.join(PRESET_DIR, 'plugins', 'fairy-world-core.mjs');
const WORLD_DIR = path.join(PRESET_DIR, 'world-core');
const hasWorldCore = existsSync(path.join(WORLD_DIR, 'MANIFEST.json'));

function toolHost() {
  const tools = new Map();
  const sections = new Map();
  const ctx = {
    tools: {
      register(definition) {
        assert.equal(typeof definition, 'object');
        assert.equal(typeof definition.name, 'string');
        assert.equal(typeof definition.execute, 'function');
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
    systemPrompt: {
      section(definition) {
        sections.set(definition.name, definition);
        return () => sections.delete(definition.name);
      },
    },
  };
  return { ctx, tools, sections };
}

test('world-core shim registers a lookup tool and a prompt section', { skip: !hasWorldCore && 'world-core 索引不在本机（非仓库资产）' }, async () => {
  const repoRoot = path.resolve(PRESET_DIR, '..', '..');
  const prevRoot = process.env.DSH_FAIRY_REPO_ROOT;
  process.env.DSH_FAIRY_REPO_ROOT = repoRoot;   // apply() 是延迟调用，调用期也需要该变量
  try {
    const mod = await loadWith(repoRoot, WORLD_CORE);
    const host = toolHost();
    const dispose = await mod.apply(host.ctx, {});

    // 加载门控：service 不可用时本行不该加载（而不是加载后静默不挂段落）
    assert.deepEqual(mod.inject, ['systemPrompt'], 'inject 必须声明所需服务');

    assert.ok(host.tools.has('fairy_world_lookup'), '应注册 fairy_world_lookup');
    assert.ok(host.sections.has('fairy-world-core'), '应挂一个世界知识段落');
    assert.equal(typeof dispose, 'function');

    const tool = host.tools.get('fairy_world_lookup');
    // 形状对齐本仓既有工具：parameters/output.schema 是手写 JSON Schema，另有 timeoutMs 与并发声明
    assert.equal(tool.parameters.type, 'object');
    assert.deepEqual(tool.parameters.required, ['query']);
    assert.ok(tool.output?.schema, '必须声明 output.schema');
    assert.equal(typeof tool.output.render, 'function', '必须有 render（产出 content block）');
    assert.equal(typeof tool.timeoutMs, 'number');
    assert.equal(typeof tool.isConcurrencySafe, 'function');

    // execute 返回**裸值**（照 output.schema），文本由 render 产出
    const value = await tool.execute({ query: '空洞', limit: 3 });
    assert.ok(Array.isArray(value.hits) && value.hits.length > 0, '真实检索应返回命中');
    assert.equal(typeof value.report, 'string');
    for (const hit of value.hits) {
      assert.equal(typeof hit.entity, 'string');
      assert.equal(typeof hit.key, 'string', '每条结果应带原始文本键');
      assert.equal(typeof hit.text, 'string');
    }
    const blocks = tool.output.render({}, value);
    assert.ok(Array.isArray(blocks) && blocks[0].type === 'text', 'render 应产出 content block');
    assert.match(blocks[0].text, /证据键: /);
    assert.ok(blocks[0].text.length < 4000, '返回应受 limit 约束，不会把索引倒进上下文');

    // 空 query 是调用方错误：应与既有工具一致抛 INVALID_ARGS，而不是静默返回空
    await assert.rejects(() => tool.execute({ query: '   ' }), /non-empty query/);

    const empty = await tool.execute({ query: 'zzz-绝不存在的片段-zzz', limit: 3 });
    assert.equal(empty.hits.length, 0);
    assert.match(empty.report, /未找到匹配|不要据此编造/, '无命中时应明确说明而不是编造');

    dispose();
    assert.equal(host.tools.size, 0, 'dispose 后工具应注销');
    assert.equal(host.sections.size, 0);
  } finally {
    if (prevRoot === undefined) delete process.env.DSH_FAIRY_REPO_ROOT;
    else process.env.DSH_FAIRY_REPO_ROOT = prevRoot;
  }
});

/**
 * 用**宿主自己的 schema 引擎**验证工具定义（不是 fakeHost 的假设）。
 *
 * 为什么单独一条：`section` 形状错误与 `{content:[…]}` 返回都属"fakeHost 测不出"的假绿——
 * 前者靠既有实现的调用形状发现，后者靠这条：把注册的 definition 直接送进运行时的
 * `assertObjectJsonSchema` / `assertSupportedJsonSchema` / `validateJsonSchemaValue`。
 * 解析不到宿主包时跳过（其它机器上未必有官方安装）。
 */
test('world-core tool definition passes the host schema engine', { skip: !hasWorldCore && 'world-core 索引不在本机' }, async (t) => {
  const candidates = [
    process.env.DSH_OFFICIAL_PACKAGE && path.join(process.env.DSH_OFFICIAL_PACKAGE, '..', '..'),
    process.env.DSH_HOME && path.join(process.env.DSH_HOME, 'profiles', 'web', 'node_modules'),
    path.join(HOME_DIR, '.dsh-fairy', 'profiles', 'web', 'node_modules'),
    HOME_DIR.replace(/\\/g, '/') + '/../tmp/dsh-011/node_modules',
  ].filter(Boolean);

  let engine = null;
  for (const base of candidates) {
    try {
      const entry = createRequire(`${base}/`).resolve('@deepseek-ai/dsh-tools');
      engine = await import(pathToFileURL(entry).href);
      break;
    } catch { /* 换下一个候选 */ }
  }
  if (!engine) {
    // 显式跳过（而不是静默 return）——静默 return 会让"没验"看起来像"验过了"
    t.skip('本机解析不到 @deepseek-ai/dsh-tools（无官方安装）；这条只在该引擎在位时才有意义');
    return;
  }

  const repoRoot = path.resolve(PRESET_DIR, '..', '..');
  process.env.DSH_FAIRY_REPO_ROOT = repoRoot;
  const mod = await loadWith(repoRoot, WORLD_CORE);
  let definition = null;
  await mod.apply({ tools: { register: (d) => { definition = d; return () => {}; } }, systemPrompt: { section: () => () => {} } }, {});

  engine.assertObjectJsonSchema(definition.parameters);          // 参数 schema 合法（含 object-root 约束）
  engine.assertSupportedJsonSchema(definition.output.schema);    // 输出 schema 在宿主支持面内

  const value = await definition.execute({ query: '空洞', limit: 2 });
  const violations = engine.validateJsonSchemaValue(definition.output.schema, value, 'value');
  assert.deepEqual(violations, [], 'execute 的裸返回值必须符合 output.schema');

  const blocks = definition.output.render({}, value);
  assert.ok(Array.isArray(blocks) && blocks[0]?.type === 'text', 'render 必须产出 content block');
});
