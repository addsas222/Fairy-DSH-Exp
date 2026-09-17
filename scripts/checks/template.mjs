// 检查脚本模板（复制到 scripts/checks/<id>.mjs 后实现真实检查）。
//
// 与主入口的契约（只有三条，见 docs/EXTENDING.md）：
//   1. 入参：--check <check.yaml> --repo <仓库根> --report-dir <报告目录> --artifact <产物 json>
//      阈值/作用域从 check.yaml 自己读（所以新增检查项不需要动主入口）。
//   2. 指标：向 stdout 打一行 `<<<QUALITY-METRICS>>> {json}`（放在最后一行最省事）。
//   3. 退出码：0=通过 1=失败 2=内部错误 3=跳过（前提缺失，附 skip_reason 指标）。
//
// 要点：
//   - 用 Node 内建能力，不要引新依赖（本仓没有根级依赖树，各包各自上锁文件）。
//   - 跨平台：路径用 path.join / path.resolve；不要用 shell 专属语法；
//     外部命令一律用 runtime.run()（它负责超时与环境变量）。
//   - 不要把"没实现的检查"写成恒过：要么真做，要么把 enabled 设为 false 并在文档里写清原因。
import path from 'node:path';
import {
  EXIT, ensureDir, finish, parseCli, readCheckConfig, writeJson,
} from './lib/runtime.mjs';

async function main() {
  const args = parseCli();
  const repo = path.resolve(args.repo || process.cwd());
  const check = readCheckConfig(args.check);
  const reportDir = args['report-dir'] || path.join(repo, 'reports');
  const artifactPath = args.artifact || path.join(reportDir, 'artifacts', `${check.id}.json`);

  // TODO(替换成真实检查)：这里示范"扫仓库里某些文件并统计违规"的最小骨架。
  const errors = [];
  const scanned = 0;

  const artifact = {
    generated_at: new Date().toISOString(),
    repo,
    check_id: check.id,
    scanned,
    errors,
  };
  ensureDir(path.dirname(artifactPath));
  writeJson(artifactPath, artifact);

  const ok = errors.length === 0;
  process.stdout.write(`${check.id}：扫描 ${scanned} 个目标，违规 ${errors.length}\n`);
  finish({
    ok,
    metrics: { scanned, errors: errors.length },
    artifactPath,
    artifact,
    failureNote: '把这里换成真实的失败说明与修复指引。',
  });
}

main().catch((error) => {
  process.stdout.write(`检查脚本内部错误：${error && error.stack ? error.stack : error}\n`);
  process.exit(EXIT.ERROR);
});
