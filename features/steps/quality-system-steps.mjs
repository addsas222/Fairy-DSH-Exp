// features/quality/quality-system.feature 的 step 定义。
//
// 这些步骤**在进程内**调用主入口的 lib API（loadProject / selectChecks / executeSelection /
// writeRunReport / buildGate），跑的是真实的配置解析、真实的检查项子进程执行、真实的报告落盘——
// 不是打桩。夹具仓库建在系统临时目录里，跑完即删。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFixtureRepo } from '../../scripts/checks/lib/fixture-repo.mjs';
import {
  buildGate, executeSelection, loadProject, selectChecks, skippedStub, writeRunReport,
} from '../../scripts/verify.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function fixtureOf(world) {
  assert.ok(world.fixture, '夹具仓库尚未创建');
  return world.fixture;
}

function checkResult(world, id) {
  assert.ok(world.results, '尚未运行夹具仓库的主入口');
  const found = world.results.find((r) => r.id === id);
  assert.ok(found, `没有找到检查项 ${id}（本轮结果：${world.results.map((r) => r.id).join(', ')}）`);
  return found;
}

/** 断言状态时把"实际是什么"写进消息，失败信息才有用。 */
export function assertStatus(world, id, expected) {
  const item = checkResult(world, id);
  assert.equal(item.status, expected, `${id} 实际状态是 ${item.status}（退出码 ${item.exit_code}，说明：${item.note || ''}）`);
}

/** 运行夹具仓库：完全走主入口的 lib API（发现 → 过滤 → 执行 → 报告 → 门禁）。 */
async function runFixture(world, options = {}) {
  const fixture = fixtureOf(world);
  const project = loadProject({ repo: fixture.dir, configPath: fixture.configPath, checksDir: fixture.checksDir });
  world.project = project;
  if (project.configErrors.length) {
    world.configErrors = project.configErrors;
    return;
  }
  world.configErrors = [];
  const selected = selectChecks(project.checks, options);
  const startedAt = new Date().toISOString();
  const { results } = await executeSelection({
    repo: fixture.dir,
    config: project.config,
    configPath: project.configPath,
    reportDir: fixture.reportDir,
    selected,
    quiet: true,
  });
  const executed = new Set(results.map((r) => r.id));
  const notRun = project.checks.filter((c) => !executed.has(c.id)).map((c) => skippedStub(c));
  const gate = buildGate(project.config, results, { unexecutedRequired: 0, allowPartial: true });
  writeRunReport({
    repo: fixture.dir,
    config: project.config,
    configPath: project.configPath,
    reportDir: fixture.reportDir,
    selectedResults: results,
    notRun,
    selection: { stages: [], only: [], tags: [] },
    gate,
    startedAt,
  });
  world.results = [...results, ...notRun];
  world.gate = gate;
  world.reportPath = path.join(fixture.reportDir, 'quality-report.json');
}

export const steps = {
  // ---- Given ----------------------------------------------------------------
  '一个临时质量夹具仓库': (world) => {
    world.fixture = createFixtureRepo({ schemaFrom: REPO_ROOT, name: 'gherkin' });
  },

  // ---- When -----------------------------------------------------------------
  '我向夹具仓库新增检查项 {string} 输出指标 ok={int} 并退出码 {int}': (world, id, ok, exitCode) => {
    const fixture = fixtureOf(world);
    fixture.addCheck({ id, command: fixture.command(id), metrics: { ok }, exitCode });
  },
  '我向夹具仓库新增检查项 {string} 输出指标 ok={int} 并退出码 {int} 且阈值要求 ok 至少 {int}': (world, id, ok, exitCode, min) => {
    const fixture = fixtureOf(world);
    fixture.addCheck({
      id,
      command: fixture.command(id),
      metrics: { ok },
      exitCode,
      threshold: { metrics: [{ name: 'ok', min }] },
    });
  },
  '我向夹具仓库新增检查项 {string} 输出指标 ok={int} 并退出码 {int} 且标记 allow_failure': (world, id, ok, exitCode) => {
    const fixture = fixtureOf(world);
    fixture.addCheck({
      id, command: fixture.command(id), metrics: { ok }, exitCode, allowFailure: true,
    });
  },
  '我向夹具仓库新增一个缺 windows_command 的检查项 {string}': (world, id) => {
    const fixture = fixtureOf(world);
    fixture.addRawCheck(id, [
      'schema_version: 1',
      `id: ${id}`,
      'title: 缺 windows_command 的夹具检查项',
      'stage: static',
      'type: static',
      'enabled: true',
      'required: true',
      'tags: [demo]',
      `command: 'node -e "process.exit(0)"'`,
      `unix_command: 'node -e "process.exit(0)"'`,
      'cwd: ${repo}',
      'env: {}',
      'timeout: 60',
      'threshold:',
      '  metrics: []',
      'artifacts: []',
      'requires: []',
      'install: []',
      `docs: docs/quality/${id}.md`,
      'owner: fixture',
      'allow_failure: false',
      '',
    ].join('\n'));
    fixture.writeFile(`docs/quality/${id}.md`, '# 缺字段夹具\n');
  },
  '我向夹具仓库新增检查项 {string} 声明当前平台不支持': (world, id) => {
    const fixture = fixtureOf(world);
    fixture.addCheck({
      id,
      command: fixture.command(id),
      platformSupport: { windows: false, unix: false, reason: '夹具：两个平台都声明不支持' },
    });
  },
  '我用模板渲染一个检查项 {string} 并加入夹具仓库': (world, id) => {
    const fixture = fixtureOf(world);
    const template = fs.readFileSync(path.join(REPO_ROOT, '.agent', 'templates', 'check.yaml'), 'utf8');
    const rendered = template
      .replaceAll('<id>', id)
      .replaceAll('<title>', '模板渲染的夹具检查项')
      .replaceAll('<stage>', 'static')
      .replaceAll('<type>', 'static')
      .replaceAll('<tag>', 'template-demo')
      .replaceAll('<owner>', 'fixture')
      .replaceAll('<command>', fixture.command(id));
    fixture.addRawCheck(id, rendered);
    fixture.writeFile(`docs/quality/${id}.md`, `# ${id}（模板渲染）\n`);
    fixture.writeFile(`scripts/checks/${id}.mjs`, 'process.stdout.write(\'<<<QUALITY-METRICS>>> {"errors":0}\\n\');\nprocess.exit(0);\n');
  },
  '我运行夹具仓库的主入口': async (world) => {
    await runFixture(world);
  },

  // ---- Then -----------------------------------------------------------------
  '主入口发现的检查项数量是 {int}': (world, count) => {
    assert.ok(world.project, '尚未加载夹具仓库配置');
    assert.equal(world.project.checks.length, count, `发现 ${world.project.checks.length} 个检查项`);
  },
  '检查项 {string} 的状态是 {word}': (world, id, status) => {
    assertStatus(world, id, status);
  },
  '检查项 {string} 的退出码是 {int}': (world, id, code) => {
    assert.equal(checkResult(world, id).exit_code, code);
  },
  '门禁状态是 {word}': (world, status) => {
    assert.ok(world.gate, '尚未产生门禁结果');
    assert.equal(world.gate.status, status, `门禁失败项：${world.gate.failures.map((f) => `${f.id}:${f.reason || f.detail}`).join(' / ')}`);
  },
  '夹具仓库生成了报告文件': (world) => {
    const fixture = fixtureOf(world);
    for (const rel of ['reports/quality-report.json', 'reports/quality-report.md', 'reports/verify.log']) {
      assert.ok(fs.existsSync(path.join(fixture.dir, rel)), `缺少报告文件 ${rel}`);
    }
    const json = JSON.parse(fs.readFileSync(path.join(fixture.dir, 'reports/quality-report.json'), 'utf8'));
    assert.ok(Array.isArray(json.checks) && json.checks.length > 0, '报告里没有检查项明细');
    assert.equal(json.platform, process.platform === 'win32' ? 'windows' : 'unix');
  },
  '主入口报告配置错误 {int} 条': (world, count) => {
    assert.ok(Array.isArray(world.configErrors), '主入口没有做配置校验');
    assert.equal(world.configErrors.length, count, `实际配置错误：${world.configErrors.join(' | ')}`);
  },
  '主入口能解析模板检查项 {string}': (world, id) => {
    const fixture = fixtureOf(world);
    const project = loadProject({ repo: fixture.dir, configPath: fixture.configPath, checksDir: fixture.checksDir });
    assert.deepEqual(project.configErrors, [], `模板渲染出的检查项没能通过校验：${project.configErrors.join(' | ')}`);
    const found = project.checks.find((c) => c.id === id);
    assert.ok(found, `模板检查项 ${id} 没有被发现`);
    assert.equal(found.stage, 'static');
    assert.ok(found.docs.endsWith(`${id}.md`), '模板的 docs 字段没有指向本检查项的文档');
  },
};

export default steps;
