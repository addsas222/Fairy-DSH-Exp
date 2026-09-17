// 夹具仓库构造器：为"扩展闭环"提供真实可跑的最小质量仓库。
//
// 谁用：
//   - features/steps/*.mjs（Gherkin 行为用例：在进程内驱动主入口的 lib API）
//   - scripts/checks/e2e.mjs（端到端：真的起一个 node scripts/verify.mjs 子进程跑夹具）
// 两边共用同一份夹具定义，避免"测试里的夹具"和"e2e 的夹具"各写一套而互相漂移。
//
// 夹具内容：.agent/quality.yaml（最小可用）+ .agent/quality.schema.json（从真实仓库复制，
// 保证夹具校验的就是真实 schema）+ .agent/checks/<id>.yaml + docs/quality/<id>.md +
// scripts/checks/<id>.mjs（真实可执行的检查脚本，按给定指标与退出码输出）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CONFIG = `schema_version: 1
project:
  name: fixture-repo
  repo_root: .
  description: 质量体系夹具仓库（测试用最小配置）
defaults:
  timeout: 120
  on_missing: skip
discovery:
  checks_dir: .agent/checks
  pattern: "*.yaml"
  exclude:
    - template.yaml
stages:
  - id: static
    title: 静态检查
    order: 10
    concurrency: 2
  - id: test
    title: 测试
    order: 20
    concurrency: 1
gate:
  fail_on:
    - failed
    - error
    - timeout
    - blocked
  warn_on:
    - skipped
    - disabled
  min_enabled_checks: 1
  max_disabled_checks: 1
  allow_failure_downgrades: true
report:
  dir: reports
  markdown: quality-report.md
  json: quality-report.json
  log: verify.log
  artifact_dir: reports/artifacts
  keep_artifacts: 5
install:
  log: reports/install.log
  strategy_order:
    - local
    - winget
    - scoop
    - choco
  winget_flags:
    - --accept-source-agreements
    - --accept-package-agreements
    - --scope user
  never_elevate: true
  choco_docs_only: true
`;

function checkYaml(spec) {
  const {
    id,
    stage = 'static',
    type = 'static',
    enabled = true,
    required = true,
    command,
    windowsCommand = null,
    unixCommand = null,
    timeout = 60,
    threshold = { metrics: [{ name: 'ok', min: 1 }] },
    allowFailure = false,
    onMissing = null,
    tags = ['demo'],
    platformSupport = null,
    withDocs = true,
    requiresRaw = null,
  } = spec;
  const lines = [];
  lines.push('schema_version: 1');
  lines.push(`id: ${id}`);
  lines.push(`title: 夹具检查项 ${id}`);
  lines.push(`stage: ${stage}`);
  lines.push(`type: ${type}`);
  lines.push(`enabled: ${enabled}`);
  lines.push(`required: ${required}`);
  lines.push('tags:');
  for (const tag of tags) lines.push(`  - ${tag}`);
  // 命令里可能有引号：用**双引号 YAML 标量 + 转义**写，避免单引号嵌套把 yaml 写坏
  const quoted = (value) => `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  lines.push(`command: ${quoted(command)}`);
  lines.push(`windows_command: ${quoted(windowsCommand || command)}`);
  lines.push(`unix_command: ${quoted(unixCommand || command)}`);
  if (platformSupport) {
    lines.push('platform_support:');
    if (platformSupport.windows !== undefined) {
      lines.push('  windows:');
      lines.push(`    supported: ${platformSupport.windows ? 'true' : 'false'}`);
      lines.push(`    reason: ${platformSupport.reason}`);
    }
    if (platformSupport.unix !== undefined) {
      lines.push('  unix:');
      lines.push(`    supported: ${platformSupport.unix ? 'true' : 'false'}`);
      lines.push(`    reason: ${platformSupport.reason}`);
    }
  }
  lines.push('cwd: ${repo}');
  lines.push('env: {}');
  lines.push(`timeout: ${timeout}`);
  lines.push('threshold:');
  lines.push('  metrics:');
  for (const metric of threshold.metrics) {
    lines.push(`    - name: ${metric.name}`);
    if (metric.min !== undefined) lines.push(`      min: ${metric.min}`);
    if (metric.max !== undefined) lines.push(`      max: ${metric.max}`);
    if (metric.optional) lines.push('      optional: true');
  }
  lines.push('artifacts:');
  lines.push(`  - reports/artifacts/${id}.json`);
  if (requiresRaw) lines.push(requiresRaw.trimEnd());
  else lines.push('requires: []');
  lines.push('install: []');
  if (withDocs) lines.push(`docs: docs/quality/${id}.md`);
  else lines.push('docs: docs/quality/missing.md');
  lines.push('owner: fixture');
  lines.push(`allow_failure: ${allowFailure ? 'true' : 'false'}`);
  if (onMissing) lines.push(`on_missing: ${onMissing}`);
  return `${lines.join('\n')}\n`;
}

function checkScript(spec) {
  const metrics = JSON.stringify(spec.metrics || { ok: 1 });
  const exitCode = spec.exitCode === undefined ? 0 : spec.exitCode;
  return `// 夹具检查脚本（真实可执行）：输出指标行并按配置退出。
process.stdout.write('夹具检查项 ${spec.id} 执行中\\n');
process.stdout.write('<<<QUALITY-METRICS>>> ' + ${JSON.stringify(metrics)} + '\\n');
process.exit(${exitCode});
`;
}

/**
 * 建一个夹具仓库。
 * @param {object} options
 * @param {string} options.schemaFrom 真实仓库根（复制 quality.schema.json 用）
 * @param {object[]} [options.checks] 检查项定义数组（见 checkYaml 的 spec）
 * @param {Record<string,string>} [options.files] 额外的文本文件（仓库相对路径 → 内容）
 * @param {string} [options.config] 覆盖 quality.yaml 内容
 * @param {string} [options.name] 目录名后缀
 */
export function createFixtureRepo(options = {}) {
  const {
    schemaFrom, checks = [], files = {}, config = CONFIG, name = 'fixture',
  } = options;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `fairy-quality-${name}-`));
  fs.mkdirSync(path.join(dir, '.agent', 'checks'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'docs', 'quality'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'scripts', 'checks'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.agent', 'quality.yaml'), config, 'utf8');
  if (schemaFrom) {
    fs.copyFileSync(
      path.join(schemaFrom, '.agent', 'quality.schema.json'),
      path.join(dir, '.agent', 'quality.schema.json'),
    );
  }
  for (const spec of checks) {
    fs.writeFileSync(path.join(dir, '.agent', 'checks', `${spec.id}.yaml`), checkYaml(spec), 'utf8');
    fs.writeFileSync(path.join(dir, 'docs', 'quality', `${spec.id}.md`), `# 夹具检查项 ${spec.id}\n\n（夹具文档）\n`, 'utf8');
    fs.writeFileSync(path.join(dir, 'scripts', 'checks', `${spec.id}.mjs`), checkScript(spec), 'utf8');
  }
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(dir, rel.split('/').join(path.sep));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf8');
  }
  return {
    dir,
    configPath: path.join(dir, '.agent', 'quality.yaml'),
    checksDir: path.join(dir, '.agent', 'checks'),
    reportDir: path.join(dir, 'reports'),
    command: (id) => `node "${dir.split(path.sep).join('/')}/scripts/checks/${id}.mjs" --check "\${check}" --repo "\${repo}" --report-dir "\${reportDir}" --artifact "\${artifact}"`,
    /** 原样写入一份检查项 yaml（用于构造"配置有错"的用例）。 */
    addRawCheck(id, yamlText) {
      fs.writeFileSync(path.join(dir, '.agent', 'checks', `${id}.yaml`), yamlText, 'utf8');
    },
    addCheck(spec) {
      fs.writeFileSync(path.join(dir, '.agent', 'checks', `${spec.id}.yaml`), checkYaml(spec), 'utf8');
      fs.writeFileSync(path.join(dir, 'docs', 'quality', `${spec.id}.md`), `# 夹具检查项 ${spec.id}\n\n（夹具文档）\n`, 'utf8');
      fs.writeFileSync(path.join(dir, 'scripts', 'checks', `${spec.id}.mjs`), checkScript(spec), 'utf8');
    },
    writeFile(rel, content) {
      const target = path.join(dir, rel.split('/').join(path.sep));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content, 'utf8');
    },
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

export { CONFIG as FIXTURE_CONFIG };
