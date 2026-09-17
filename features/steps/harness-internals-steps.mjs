// features/quality/harness-internals.feature 的 step 定义。
//
// 直接驱动真实实现（进程内）：YAML 解析器、schema 校验器、命令模板解析、阈值判定、门禁汇总、
// TAP 解析、glob 工具，以及主入口在"前提缺失 / 超时 / 依赖未满足 / 门禁下限"等错误路径上的真实行为。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFixtureRepo } from '../../scripts/checks/lib/fixture-repo.mjs';
import { parseYaml } from '../../scripts/checks/lib/yaml.mjs';
import { validateAgainstSchema } from '../../scripts/checks/lib/schema.mjs';
import { globToRegExp, parseTap } from '../../scripts/checks/lib/runtime.mjs';
import {
  buildGate, buildVars, evaluateThreshold, executeSelection, loadProject, resolveCommand,
  selectChecks, skippedStub, writeRunReport,
} from '../../scripts/verify.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCHEMA = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, '.agent', 'quality.schema.json'), 'utf8'));

function captureError(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return null;
}

function fixtureOf(world) {
  if (!world.fixture) world.fixture = createFixtureRepo({ schemaFrom: REPO_ROOT, name: 'internals' });
  return world.fixture;
}

async function runFixture(world, options = {}) {
  const fixture = fixtureOf(world);
  const project = loadProject({ repo: fixture.dir, configPath: fixture.configPath, checksDir: fixture.checksDir });
  world.project = project;
  if (project.configErrors.length) {
    world.configErrors = project.configErrors;
    return;
  }
  const selected = selectChecks(project.checks, options);
  const startedAt = new Date().toISOString();
  const results = [];
  const reportDir = options.reportDir || fixture.reportDir;
  const { results: executed } = await executeSelection({
    repo: fixture.dir,
    config: project.config,
    configPath: project.configPath,
    reportDir,
    selected,
    quiet: true,
  });
  results.push(...executed);
  const executedIds = new Set(results.map((r) => r.id));
  const notRun = project.checks.filter((c) => !executedIds.has(c.id)).map((c) => skippedStub(c));
  const gate = buildGate(project.config, results, {
    unexecutedRequired: notRun.filter((c) => c.required && c.status !== 'disabled' && !c.allow_failure).length,
    allowPartial: true,
  });
  for (const stub of notRun.filter((c) => c.required && c.status !== 'disabled')) {
    gate.warnings.push({ id: stub.id, status: stub.status, reason: `${stub.note}：required 检查项本轮未执行` });
  }
  writeRunReport({
    repo: fixture.dir,
    config: project.config,
    configPath: project.configPath,
    reportDir,
    selectedResults: results,
    notRun,
    selection: { stages: [], only: [], tags: [] },
    gate,
    startedAt,
  });
  world.results = [...results, ...notRun];
  world.gate = gate;
  world.reportPath = path.join(reportDir, 'quality-report.json');
}

function resultOf(world, id) {
  assert.ok(world.results, '尚未运行主入口');
  const found = world.results.find((r) => r.id === id);
  assert.ok(found, `没有检查项 ${id}（本轮：${world.results.map((r) => r.id).join(', ')}）`);
  return found;
}

function reportOf(world) {
  assert.ok(world.reportPath && fs.existsSync(world.reportPath), '报告 JSON 不存在');
  return JSON.parse(fs.readFileSync(world.reportPath, 'utf8'));
}

/** 组装一个夹具检查项定义（默认通过）；requiresRaw 用于注入前提。 */
function checkSpec(world, id, extra = {}) {
  const fixture = fixtureOf(world);
  return {
    id,
    command: fixture.command(id),
    metrics: { ok: 1 },
    exitCode: 0,
    ...extra,
  };
}

export const steps = {
  // ---- YAML / schema / 工具层 -------------------------------------------------
  '一段包含流式集合与块标量的 YAML': (world) => {
    world.yaml = [
      'flow: [failed, error, timeout]',
      'note: |-',
      '  第一行',
      '  第二行',
      'escaped: "带 \\"引号\\" 的值"',
      'nested:',
      '  list:',
      '    - name: a',
      '      min: 1',
      '',
    ].join('\n');
    world.parsedYaml = parseYaml(world.yaml, { filename: 'fixture.yaml' });
  },
  'YAML 解析出的 flow 序列是 {string}': (world, expected) => {
    assert.deepEqual(world.parsedYaml.flow, expected.split(',').map((s) => s.trim()));
  },
  'YAML 解析出的块标量包含 {string}': (world, needle) => {
    assert.ok(String(world.parsedYaml.note).includes(needle), `块标量实际是 ${JSON.stringify(world.parsedYaml.note)}`);
  },
  '/^YAML 解析出的转义字符串等于 (.+)$/': (world, expected) => {
    assert.equal(world.parsedYaml.escaped, expected);
  },
  '一段使用了锚点别名的 YAML': (world) => {
    world.yamlError = captureError(() => parseYaml('base: &anchor\n  a: 1\n', { filename: 'anchor.yaml' }));
  },
  '一段缩进错误的 YAML': (world) => {
    world.yamlError = captureError(() => parseYaml('a: 1\n  b: 2\n', { filename: 'indent.yaml' }));
  },
  '解析 YAML 应该抛出包含 {string} 的错误': (world, needle) => {
    assert.ok(world.yamlError, '没有抛错');
    assert.ok(String(world.yamlError.message).includes(needle), `错误信息是 ${world.yamlError.message}`);
  },
  '一份含未知字段与错误类型的检查项配置': (world) => {
    world.schemaErrors = validateAgainstSchema(
      { schema_version: 1, id: 'demo', title: 'x', stage: 'static', type: 'static', enabled: 'yes', unknown_field: 1 },
      SCHEMA.$defs.checkItem,
      'demo.yaml',
      SCHEMA,
    );
  },
  'schema 校验应该报出 {string} 与 {string}': (world, first, second) => {
    const text = world.schemaErrors.join(' | ');
    assert.ok(text.includes(first), `缺少「${first}」：${text}`);
    assert.ok(text.includes(second), `缺少「${second}」：${text}`);
  },
  '一个夹具检查项，其命令里写了不存在的模板变量': (world) => {
    world.resolveError = captureError(() => resolveCommand(
      { id: 'demo-var', windows_command: 'node "${repo}/x.mjs" --mode "${no_such_var}"' },
      buildVars({ repo: REPO_ROOT, config: { schema_version: 1, defaults: {} }, configPath: 'x', reportDir: REPO_ROOT }, { id: 'demo-var', file: 'x.yaml' }),
    ));
  },
  '命令解析应该抛出包含 {string} 的错误': (world, needle) => {
    assert.ok(world.resolveError, '没有抛错');
    assert.ok(String(world.resolveError.message).includes(needle), `错误信息是 ${world.resolveError.message}`);
  },
  '一段包含通过、失败与跳过用例的 TAP 文本': (world) => {
    world.tap = parseTap([
      'TAP version 13',
      'ok 1 - should pass',
      'ok 2 - should also pass # SKIP 环境前提',
      'not ok 3 - should fail',
      '# tests 4',
      '# pass 2',
      '# fail 1',
      '# skipped 1',
    ].join('\n'));
  },
  'TAP 汇总的通过数是 {int}': (world, value) => {
    assert.equal(world.tap.totals.pass, value);
  },
  'TAP 汇总的失败数是 {int}': (world, value) => {
    assert.equal(world.tap.totals.fail, value);
  },
  'TAP 的失败用例名包含 {string}': (world, needle) => {
    assert.ok(world.tap.failures.some((f) => f.includes(needle)), `失败列表：${world.tap.failures.join(' | ')}`);
  },
  'glob {string} 匹配 {string}': (world, glob, target) => {
    assert.ok(globToRegExp(glob).test(target), `${glob} 应该匹配 ${target}`);
  },
  'glob {string} 不匹配 {string}': (world, glob, target) => {
    assert.ok(!globToRegExp(glob).test(target), `${glob} 不应该匹配 ${target}`);
  },

  // ---- 阈值 / 门禁 -----------------------------------------------------------
  '一份阈值要求 ok 至少 {int} 且 failed 至多 {int} 且可选项 optional_metric 缺失': (world, min, max) => {
    world.thresholdSpec = {
      threshold: { metrics: [{ name: 'ok', min }, { name: 'failed', max }, { name: 'optional_metric', min: 1, optional: true }] },
    };
  },
  '指标 ok={int} 的阈值判定失败': (world, value) => {
    const results = evaluateThreshold(world.thresholdSpec, { ok: value });
    const item = results.find((r) => r.name === 'ok');
    assert.equal(item.ok, false, 'ok 指标应当判失败');
  },
  '指标 failed={int} 的阈值判定通过': (world, value) => {
    const results = evaluateThreshold(world.thresholdSpec, { failed: value });
    assert.equal(results.find((r) => r.name === 'failed').ok, true);
  },
  '可选项缺失不算失败': (world) => {
    const results = evaluateThreshold(world.thresholdSpec, {});
    assert.equal(results.find((r) => r.name === 'optional_metric').ok, true);
  },

  // ---- 前提缺失 / 超时 / 依赖 -------------------------------------------------
  '一个夹具检查项，声明了不存在的工具前提': (world) => {
    const fixture = fixtureOf(world);
    fixture.addCheck(checkSpec(world, 'demo-prereq', {
      required: false,
      requiresRaw: [
        'requires:',
        '  - kind: tool',
        '    name: definitely-missing-tool',
        '    probe: definitely-missing-tool --version',
        '    reason: 夹具：构造前提缺失',
        '    manual: 手动安装 definitely-missing-tool',
      ].join('\n'),
    }));
  },
  '一个必填的夹具检查项，声明了不存在的工具前提': (world) => {
    const fixture = fixtureOf(world);
    fixture.addCheck(checkSpec(world, 'demo-blocked', {
      requiresRaw: [
        'requires:',
        '  - kind: tool',
        '    name: definitely-missing-tool',
        '    probe: definitely-missing-tool --version',
        '    reason: 夹具：构造前提缺失',
      ].join('\n'),
    }));
  },
  '一个必填的夹具检查项，声明了不存在的工具前提，并显式写 on_missing skip': (world) => {
    const fixture = fixtureOf(world);
    fixture.addCheck(checkSpec(world, 'demo-onskip', {
      onMissing: 'skip',
      requiresRaw: [
        'requires:',
        '  - kind: tool',
        '    name: definitely-missing-tool',
        '    probe: definitely-missing-tool --version',
        '    reason: 夹具：构造前提缺失 + 显式接受',
      ].join('\n'),
    }));
  },
  '检查项 {string} 附带了手动命令': (world, id) => {
    const item = resultOf(world, id);
    assert.ok((item.next_steps || []).length > 0, `没有附手动命令：${JSON.stringify(item)}`);
  },
  '一个夹具检查项 {string} 会失败': (world, id) => {
    const fixture = fixtureOf(world);
    fixture.addCheck(checkSpec(world, id, { metrics: { ok: 0 }, exitCode: 1 }));
  },
  '一个可选的夹具检查项 {string} 依赖 {string}': (world, id, dependency) => {
    const fixture = fixtureOf(world);
    fixture.addCheck(checkSpec(world, id, {
      required: false,
      requiresRaw: [
        'requires:',
        '  - kind: check',
        `    id: ${dependency}`,
        '    reason: 夹具：依赖另一检查项（可选项，缺失应记 skipped）',
      ].join('\n'),
    }));
  },
  '一个可选的夹具检查项 {string} 要求存在路径 {string}': (world, id, target) => {
    const fixture = fixtureOf(world);
    fixture.addCheck(checkSpec(world, id, {
      required: false,
      requiresRaw: [
        'requires:',
        '  - kind: path',
        `    path: ${target}`,
        '    reason: 夹具：路径前提（可选项）',
      ].join('\n'),
    }));
  },
  '一个夹具检查项 {string} 依赖 {string}': (world, id, dependency) => {
    const fixture = fixtureOf(world);
    fixture.addCheck(checkSpec(world, id, {
      requiresRaw: [
        'requires:',
        '  - kind: check',
        `    id: ${dependency}`,
        '    reason: 夹具：依赖另一检查项',
      ].join('\n'),
    }));
  },
  '一个超时的夹具检查项 {string}': (world, id) => {
    const fixture = fixtureOf(world);
    fixture.addCheck(checkSpec(world, id, { timeout: 2 }));
    // 注意：addCheck 会写一份标准夹具脚本，所以"慢脚本"必须在它**之后**覆盖
    const script = path.join(fixture.dir, 'scripts', 'checks', `${id}.mjs`);
    fs.writeFileSync(script, 'await new Promise((resolve) => setTimeout(resolve, 30000));\n', 'utf8');
  },
  '一个夹具检查项 {string} 要求环境变量 {string}': (world, id, envName) => {
    const fixture = fixtureOf(world);
    fixture.addCheck(checkSpec(world, id, {
      requiresRaw: [
        'requires:',
        '  - kind: env',
        `    env: ${envName}`,
        '    reason: 夹具：环境变量前提',
      ].join('\n'),
    }));
  },
  '一个夹具检查项 {string} 要求存在路径 {string}': (world, id, target) => {
    const fixture = fixtureOf(world);
    fixture.addCheck(checkSpec(world, id, {
      requiresRaw: [
        'requires:',
        '  - kind: path',
        `    path: ${target}`,
        '    reason: 夹具：路径前提',
      ].join('\n'),
    }));
  },

  // ---- 夹具配置变体 -----------------------------------------------------------
  '一份把 min_enabled_checks 设为 {int} 的夹具配置': (world, value) => {
    const fixture = fixtureOf(world);
    const config = fs.readFileSync(path.join(fixture.dir, '.agent', 'quality.yaml'), 'utf8')
      .replace('min_enabled_checks: 1', `min_enabled_checks: ${value}`);
    fs.writeFileSync(path.join(fixture.dir, '.agent', 'quality.yaml'), config, 'utf8');
  },
  '一份把 max_disabled_checks 设为 {int} 的夹具配置': (world, value) => {
    const fixture = fixtureOf(world);
    const config = fs.readFileSync(path.join(fixture.dir, '.agent', 'quality.yaml'), 'utf8')
      .replace('max_disabled_checks: 1', `max_disabled_checks: ${value}`);
    fs.writeFileSync(path.join(fixture.dir, '.agent', 'quality.yaml'), config, 'utf8');
  },
  '一个未启用的夹具检查项 {string}（带启用原因）': (world, id) => {
    const fixture = fixtureOf(world);
    fixture.addCheck(checkSpec(world, id, { enabled: false, enabledReason: '夹具：故意未启用，用于验证门禁上限' }));
  },
  '一个夹具检查项 {string} 会通过': (world, id) => {
    const fixture = fixtureOf(world);
    fixture.addCheck(checkSpec(world, id));
  },
  '一个夹具检查项 {string} 输出指标 ok={int} 并退出码 {int} 且阈值要求 ok 至少 {int}': (world, id, ok, exitCode, min) => {
    const fixture = fixtureOf(world);
    fixture.addCheck(checkSpec(world, id, { metrics: { ok }, exitCode, threshold: { metrics: [{ name: 'ok', min }] } }));
  },

  // ---- 运行与断言 -------------------------------------------------------------
  '我只运行夹具仓库的检查项 {string}': async (world, only) => {
    await runFixture(world, { only });
  },
  '门禁失败原因包含 {string}': (world, needle) => {
    const text = world.gate.failures.map((f) => `${f.id}:${f.reason || f.detail || f.note || ''}`).join(' | ');
    assert.ok(text.includes(needle), `失败原因是：${text}`);
  },
  '门禁警告里出现 {string}': (world, needle) => {
    const text = world.gate.warnings.map((w) => `${w.id}:${w.reason || ''}`).join(' | ');
    assert.ok(text.includes(needle), `警告是：${text}`);
  },
  '报告里 {string} 的状态是 {word}': (world, id, status) => {
    const report = reportOf(world);
    const item = report.checks.find((c) => c.id === id);
    assert.ok(item, `报告里没有 ${id}`);
    assert.equal(item.status, status);
  },
  '报告里 {string} 的命令包含 {string}': (world, id, needle) => {
    const report = reportOf(world);
    const item = report.checks.find((c) => c.id === id);
    assert.ok(item && item.command && item.command.includes(needle), `命令是：${item && item.command}`);
  },
  '报告里 {string} 的阈值明细非空': (world, id) => {
    const report = reportOf(world);
    const item = report.checks.find((c) => c.id === id);
    assert.ok(item && item.threshold_results.length > 0, '阈值明细为空');
  },
  // 注意：'检查项 … 的状态是 …' 与 '门禁状态是 …' 的定义在 quality-system-steps.mjs 里，
  // 这里**不重复定义**（同一文本匹配到多条定义会被判 ambiguous）。
};

export default steps;
