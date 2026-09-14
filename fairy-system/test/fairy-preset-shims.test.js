/**
 * fairy preset 的两个 shim 的真实 apply 单测。
 *
 * 为什么要有这组：发现层（agentPreset.list）只看**行名是否合法**，看不到 apply 里
 * 的 API 形状错误——第一版 shim 用 `ctx.systemPrompt.section(name, text)`（字符串两参、
 * 无 order），发现层照样报 `fairy user ok`，而真实会话里那段落根本挂不上。
 * 这里按本仓既有约定（fairy-modes/test/modes.test.js 的 fakeHost）做真调用。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

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
