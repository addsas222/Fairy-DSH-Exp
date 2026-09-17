// 检查项 repo-contracts：质量体系自洽 + 仓库级契约（零依赖）。
//
// 为什么需要它：配置驱动体系的典型失效模式是"配置与实现悄悄脱钩"——阈值里写的指标脚本从不输出、
// 检查项文档不存在、CI 只在一个平台跑、包加了却忘了 lockfile。这些都不会让别的检查变红，只会让
// 门禁慢慢变成装饰。所以这里把它们变成硬契约：
//
//   1. .agent/quality.yaml 与每个 .agent/checks/*.yaml 通过 .agent/quality.schema.json 校验；
//   2. 每个检查项：id 与文件名一致、stage 已定义、docs/quality/<id>.md 存在且不小于配置的字节下限、
//      windows_command 与 unix_command 都在（或声明平台不支持）、脚本文件存在、
//      **阈值里的每个指标名都能在脚本源码里找到**（防"假门禁"）、artifacts 是仓库相对路径；
//   3. 仓库级：.gitattributes 含必需规则、每个包有 lockfile、CI 工作流含 windows+ubuntu 矩阵
//      并分别调用 verify.ps1 / verify.sh、QUALITY.md 写明 core.longpaths 约定。
import fs from 'node:fs';
import path from 'node:path';
import { parseYaml } from './lib/yaml.mjs';
import { validateAgainstSchema } from './lib/schema.mjs';
import {
  ensureDir, finish, globToRegExp, parseCli, pct, readCheckConfig, scannedFiles, writeJson,
} from './lib/runtime.mjs';

async function main() {
  const args = parseCli();
  const repo = path.resolve(args.repo || process.cwd());
  const check = readCheckConfig(args.check);
  const reportDir = args['report-dir'] || path.join(repo, 'reports');
  const artifactPath = args.artifact || path.join(reportDir, 'artifacts', 'repo-contracts.json');
  const scope = check.scope || {};
  const errors = [];
  const notes = [];
  const err = (message) => errors.push(message);

  // ---- 1) 配置与 schema ------------------------------------------------------
  const schemaPath = path.join(repo, '.agent', 'quality.schema.json');
  let schema = null;
  if (!fs.existsSync(schemaPath)) {
    err('缺少 .agent/quality.schema.json');
  } else {
    try {
      schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
    } catch (error) {
      err(`.agent/quality.schema.json 不是合法 JSON：${error.message}`);
    }
  }
  const configPath = path.join(repo, '.agent', 'quality.yaml');
  let config = null;
  if (!fs.existsSync(configPath)) {
    err('缺少 .agent/quality.yaml');
  } else {
    try {
      config = parseYaml(fs.readFileSync(configPath, 'utf8'), { filename: configPath });
    } catch (error) {
      err(`.agent/quality.yaml 解析失败：${error.message}`);
    }
  }
  if (config && schema) {
    for (const message of validateAgainstSchema(config, schema.$defs.qualityConfig, 'quality.yaml', schema)) {
      err(`quality.yaml 不符合 schema：${message}`);
    }
  }

  // ---- 2) 检查项 -------------------------------------------------------------
  const checksDir = path.join(repo, '.agent', 'checks');
  const checkFiles = fs.existsSync(checksDir)
    ? fs.readdirSync(checksDir).filter((f) => f.endsWith('.yaml')).sort()
    : [];
  const stageIds = new Set((config && config.stages ? config.stages : []).map((s) => s.id));
  const docsMinBytes = scope.docs_min_bytes || 200;
  let docsScanned = 0;
  const ids = new Set();

  for (const file of checkFiles) {
    const rel = `.agent/checks/${file}`;
    let item;
    try {
      item = parseYaml(fs.readFileSync(path.join(checksDir, file), 'utf8'), { filename: rel });
    } catch (error) {
      err(`${rel} 解析失败：${error.message}`);
      continue;
    }
    if (item === null) continue; // 空文件（例如被排除的模板）
    if (schema) {
      for (const message of validateAgainstSchema(item, schema.$defs.checkItem, rel, schema)) {
        err(`${rel} 不符合 schema：${message}`);
      }
    }
    if (!item.id) continue;
    if (`${item.id}.yaml` !== file) err(`${rel}：id 是 ${item.id}，与文件名不一致`);
    if (ids.has(item.id)) err(`${rel}：id ${item.id} 重复`);
    ids.add(item.id);
    if (item.stage && !stageIds.has(item.stage)) err(`${rel}：stage ${item.stage} 未在 quality.yaml 的 stages 中定义`);

    const windowsDeclared = item.platform_support && item.platform_support.windows;
    const unixDeclared = item.platform_support && item.platform_support.unix;
    if (!item.windows_command && !windowsDeclared) err(`${rel}：缺 windows_command 且未声明 platform_support.windows`);
    if (!item.unix_command && !unixDeclared) err(`${rel}：缺 unix_command 且未声明 platform_support.unix`);
    for (const [key, value] of Object.entries({ command: item.command, windows_command: item.windows_command, unix_command: item.unix_command })) {
      if (!value) continue;
      for (const use of ['${repo}', '${check}']) {
        if (!value.includes(use)) notes.push(`${rel}：${key} 未使用 ${use}（多数检查项应当用，便于从任意 cwd 调用）`);
      }
    }

    // 脚本存在性
    const scriptRel = `scripts/checks/${item.id}.mjs`;
    const scriptPath = path.join(repo, scriptRel);
    if (!fs.existsSync(scriptPath)) {
      err(`${rel}：缺少实现脚本 ${scriptRel}`);
      continue;
    }
    const source = fs.readFileSync(scriptPath, 'utf8');
    // 阈值指标名必须在脚本源码里出现（防"阈值写了脚本从不输出"）
    for (const metric of (item.threshold && item.threshold.metrics) || []) {
      if (!metric.name) continue;
      if (!source.includes(metric.name)) {
        err(`${rel}：阈值指标 ${metric.name} 在 ${scriptRel} 里找不到（脚本不会输出这个指标，阈值永远不会生效）`);
      }
    }
    // docs 存在且非空
    const docsPath = path.join(repo, item.docs || '');
    if (!item.docs || !fs.existsSync(docsPath)) {
      err(`${rel}：文档不存在 ${item.docs || '(未配置)'}`);
    } else {
      const size = fs.statSync(docsPath).size;
      if (size < docsMinBytes) err(`${rel}：文档 ${item.docs} 只有 ${size} 字节（下限 ${docsMinBytes}）`);
      else docsScanned += 1;
      const text = fs.readFileSync(docsPath, 'utf8');
      if (!text.includes(item.id)) err(`${rel}：文档 ${item.docs} 里没出现检查项 id`);
      if (!/阈值|threshold/.test(text)) err(`${rel}：文档 ${item.docs} 没有写阈值说明`);
    }
    // artifacts 相对路径
    for (const artifact of item.artifacts || []) {
      if (path.isAbsolute(artifact)) err(`${rel}：artifacts 必须是仓库相对路径：${artifact}`);
    }
    if (item.enabled === false && !item.enabled_reason) {
      err(`${rel}：enabled=false 时必须写 enabled_reason（说明为什么没启用）`);
    }
  }
  notes.push(`校验了 ${checkFiles.length} 个检查项文件`);

  // ---- 3) 仓库级契约 ---------------------------------------------------------
  const gitattributesPath = path.join(repo, '.gitattributes');
  if (!fs.existsSync(gitattributesPath)) {
    err('缺少 .gitattributes');
  } else {
    const text = fs.readFileSync(gitattributesPath, 'utf8');
    for (const rule of scope.required_gitattributes || []) {
      if (!text.includes(rule)) err(`.gitattributes 缺少规则：${rule}`);
    }
  }

  const tracked = await scannedFiles(repo);
  const packageGlobs = (scope.package_globs || ['*/dsh-*/package.json']).map((g) => globToRegExp(g));
  const manifests = tracked.filter((rel) => rel.endsWith('/package.json') && packageGlobs.some((re) => re.test(rel)));
  let packagesChecked = 0;
  for (const manifest of manifests) {
    const dir = path.dirname(manifest);
    const hasLock = tracked.some((rel) => rel === `${dir}/pnpm-lock.yaml` || rel === `${dir}/package-lock.json`);
    if (!hasLock) err(`${dir}：没有 lockfile（pnpm-lock.yaml / package-lock.json）——CI 用 --frozen-lockfile`);
    else packagesChecked += 1;
  }

  for (const workflow of scope.required_ci_workflows || []) {
    const workflowPath = path.join(repo, workflow.path);
    if (!fs.existsSync(workflowPath)) {
      err(`缺少 CI 工作流 ${workflow.path}`);
      continue;
    }
    const text = fs.readFileSync(workflowPath, 'utf8');
    for (const needle of workflow.must_contain || []) {
      if (!text.includes(needle)) err(`${workflow.path} 里缺少 ${needle}`);
    }
  }

  const qualityDoc = path.join(repo, 'docs', 'QUALITY.md');
  if (!fs.existsSync(qualityDoc)) err('缺少 docs/QUALITY.md');
  else if (!fs.readFileSync(qualityDoc, 'utf8').includes('core.longpaths')) {
    err('docs/QUALITY.md 没有写明 core.longpaths 约定（Windows 长路径）');
  }
  const extendingDoc = path.join(repo, 'docs', 'EXTENDING.md');
  if (!fs.existsSync(extendingDoc)) err('缺少 docs/EXTENDING.md');

  // ---- 结果 ------------------------------------------------------------------
  const artifact = {
    generated_at: new Date().toISOString(),
    repo,
    checks_scanned: checkFiles.length,
    docs_scanned: docsScanned,
    packages_checked: packagesChecked,
    errors,
    notes,
  };
  ensureDir(path.dirname(artifactPath));
  writeJson(artifactPath, artifact);

  const ok = errors.length === 0;
  process.stdout.write(`repo-contracts：检查项 ${checkFiles.length} 个、文档 ${docsScanned} 份、包 ${packagesChecked} 个；违规 ${errors.length}\n`);
  for (const note of notes.slice(0, 8)) process.stdout.write(`  · ${note}\n`);
  for (const message of errors.slice(0, 40)) process.stdout.write(`  ✖ ${message}\n`);
  if (errors.length > 40) process.stdout.write(`  … 其余 ${errors.length - 40} 条见产物 JSON\n`);
  finish({
    ok,
    metrics: {
      errors: errors.length,
      checks_scanned: checkFiles.length,
      docs_scanned: docsScanned,
      packages_checked: packagesChecked,
      error_rate: pct(errors.length, checkFiles.length),
    },
    artifactPath,
    artifact,
    failureNote: '体系自洽契约必须全绿：修配置/文档/CI，而不是把规则删掉。',
  });
}

main().catch((error) => {
  process.stdout.write(`repo-contracts 内部错误：${error && error.stack ? error.stack : error}\n`);
  process.exit(2);
});
