// 检查项 coverage：真实行/块覆盖率（V8 原始覆盖率数据 + git 变更行口径）。
//
// 为什么不用现成工具：仓库没有 c8/nyc，也不想为此引根级依赖；而 Node 内建的
// `--experimental-test-coverage` 只给"整文件"百分比，给不出**按行**的数据——没有按行数据就
// 无法实现 B.md 要求的"新增行覆盖 >=90% / 新增分支 >=85%"。所以这里自己收原始数据：
//
//   1. 用 NODE_V8_COVERAGE=<临时目录> 跑真实工作负载（各包 node --test；harness 跑一轮
//      verify.mjs，子进程会继承该环境变量，因此被 verify 拉起的检查脚本同样被计量）。
//   2. 按 V8 语义合并区间：同 (startOffset,endOffset) 的区间取 count 最大值（同一文件可能
//      被多次加载，例如带 ?query 的 ESM 重新加载）。
//   3. 行覆盖：某行的"最内层区间"（覆盖该行起始偏移的最小 span 区间）count>0 即视为覆盖；
//      行被任何区间覆盖才算"可计量行"。这与 Node 内建口径一致——校准见 docs/quality/coverage.md
//      （同包同文件实测差值 ≤2.4 个百分点，未覆盖行集合一致）。
//   4. 块覆盖（近似分支）：functions[].isBlockCoverage 为真时，其 ranges 每个区间记一个块。
//   5. 变更口径：git diff --unified=0 <base> 的新增行 ∪ 未跟踪文件（--others --exclude-standard）
//      的全部行 = "本次变更行"；只统计**同时被计量**的文件的变更行（未被执行的文件另计
//      changed_files_not_executed，显式暴露而不是悄悄算作 0%）。
//
// 门禁指标 `gate_lines_pct` / `gate_blocks_pct` 的口径随 scope 切换：有变更行时用变更行口径，
// 否则退回全量计量口径（scope 字段会写明用的是哪个）。全量与变更口径都会打印，避免"口径黑箱"。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ensureDir, finish, git, globToRegExp, listFiles, parseCli, pct, readCheckConfig, run, trackedFiles, writeJson,
} from './lib/runtime.mjs';

function matchGlob(glob, rel) {
  return globToRegExp(glob).test(rel);
}

function substitute(text, vars) {
  return text.replace(/\$\{([a-zA-Z][a-zA-Z0-9_]*)\}/g, (match, name) => (name in vars ? String(vars[name]) : match));
}

/** 收集一次工作负载产生的 V8 覆盖率目录。 */
async function collectCoverage({ repo, outDir, target, packages }) {
  const coverageDir = path.join(outDir, `v8-${target.name}`);
  ensureDir(coverageDir);
  const workloads = [];
  if (target.kind === 'packages') {
    for (const pkg of packages) {
      const testDir = path.join(repo, pkg.dir, 'test');
      const files = fs.existsSync(testDir)
        ? listFiles(testDir, { extensions: ['.test.js', '.test.mjs', '.test.cjs'] })
          .map((f) => path.relative(path.join(repo, pkg.dir), f).split(path.sep).join('/'))
        : [];
      if (!files.length) {
        workloads.push({ target: pkg.name, command: '(无测试文件，跳过)', code: 0, duration_ms: 0, note: '包内没有 test/*.test.js' });
        continue;
      }
      const retries = Number(target.retries ?? 1);
      let result = await run(
        process.execPath,
        ['--test', `--test-timeout=${target.test_timeout_ms || 45000}`, ...files],
        { cwd: path.join(repo, pkg.dir), env: { NODE_V8_COVERAGE: coverageDir }, timeoutMs: (target.package_timeout_seconds || 600) * 1000 },
      );
      let attempts = 1;
      let flaky = false;
      while (result.code !== 0 && attempts <= retries) {
        attempts += 1;
        result = await run(
          process.execPath,
          ['--test', `--test-timeout=${target.test_timeout_ms || 45000}`, ...files],
          { cwd: path.join(repo, pkg.dir), env: { NODE_V8_COVERAGE: coverageDir }, timeoutMs: (target.package_timeout_seconds || 600) * 1000 },
        );
        if (result.code === 0) flaky = true;
      }
      workloads.push({
        target: pkg.name,
        command: `node --test ${files.join(' ')}`,
        code: result.code,
        duration_ms: result.durationMs,
        timed_out: result.timedOut,
        attempts,
        flaky,
      });
      process.stdout.write(`   coverage 负载 ${pkg.name}：退出码 ${result.code}（${(result.durationMs / 1000).toFixed(2)}s，尝试 ${attempts} 次${flaky ? '，判定为 flaky' : ''}）\n`);
    }
    return { coverageDir, workloads };
  }
  // kind: command —— 跑一条真实命令（子进程继承 NODE_V8_COVERAGE）
  const command = substitute(target.command, {
    repo, node: process.execPath.split('\\').join('/'), report_dir: path.join(outDir, 'reports'),
  });
  const result = await run(command, [], { cwd: repo, env: { NODE_V8_COVERAGE: coverageDir }, shell: true, timeoutMs: (target.command_timeout_seconds || 900) * 1000 });
  const coverageProduced = fs.existsSync(coverageDir) && fs.readdirSync(coverageDir).some((f) => f.endsWith('.json'));
  workloads.push({
    target: target.name,
    command,
    code: result.code,
    duration_ms: result.durationMs,
    timed_out: result.timedOut,
    coverage_produced: coverageProduced,
    // command 目标的退出码来自它内部跑的门禁（harness 目标就是一轮 verify）：只要产出了覆盖率数据，
    // 这次负载就算成功——内层门禁的结论由外层那些检查项各自负责，不在这里重复判决。
    note: result.code === 0 ? '' : (coverageProduced
      ? '被调命令退出码非零（其内部门禁结论），覆盖率数据已产出，不计为负载失败'
      : '被调命令退出码非零且没有产出任何覆盖率数据'),
  });
  process.stdout.write(`   coverage 负载 ${target.name}：退出码 ${result.code}（${(result.durationMs / 1000).toFixed(2)}s）${coverageProduced ? '' : '，未产出覆盖率数据'}\n`);
  if (result.code !== 0) process.stdout.write(`${result.stdout}\n${result.stderr}\n`);
  return { coverageDir, workloads };
}

/** 合并 V8 覆盖率文件：绝对路径 → span→count 的区间表。 */
function mergeCoverage(coverageDir) {
  const byFile = new Map();
  const files = fs.existsSync(coverageDir) ? fs.readdirSync(coverageDir).filter((f) => f.endsWith('.json')) : [];
  for (const name of files) {
    let data;
    try {
      data = JSON.parse(fs.readFileSync(path.join(coverageDir, name), 'utf8'));
    } catch {
      continue;
    }
    for (const entry of data.result || []) {
      if (!entry.url || !entry.url.startsWith('file://') || !entry.functions) continue;
      let filePath = decodeURIComponent(new URL(entry.url).pathname);
      if (/^\/[A-Za-z]:/.test(filePath)) filePath = filePath.slice(1);
      let real;
      try {
        real = fs.realpathSync(filePath);
      } catch {
        continue;
      }
      const record = byFile.get(real) || { ranges: new Map(), blocks: new Map() };
      for (const fn of entry.functions) {
        for (const range of fn.ranges || []) {
          const key = `${range.startOffset}:${range.endOffset}`;
          const previous = record.ranges.get(key);
          record.ranges.set(key, previous === undefined ? range.count : Math.max(previous, range.count));
          if (fn.isBlockCoverage !== false) {
            const blockKey = `${fn.functionName || ''}#${key}`;
            const blockPrevious = record.blocks.get(blockKey);
            record.blocks.set(blockKey, blockPrevious === undefined ? range.count : Math.max(blockPrevious, range.count));
          }
        }
      }
      byFile.set(real, record);
    }
  }
  return { byFile, coverageFiles: files.length };
}

function analyzeFile(absolutePath, record) {
  const source = fs.readFileSync(absolutePath, 'utf8');
  const lines = source.split('\n');
  const starts = new Array(lines.length);
  let offset = 0;
  for (let i = 0; i < lines.length; i += 1) {
    starts[i] = offset;
    offset += lines[i].length + 1;
  }
  const ranges = [...record.ranges.entries()]
    .map(([key, count]) => {
      const [start, end] = key.split(':').map(Number);
      return { start, end, count };
    })
    .sort((a, b) => (a.end - a.start) - (b.end - b.start));
  const lineCovered = new Array(lines.length).fill(false);
  const lineInstrumented = new Array(lines.length).fill(false);
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim() === '') continue;
    const start = starts[i];
    const end = start + lines[i].length;
    let inner = ranges.find((r) => r.start <= start && start < r.end);
    if (!inner) inner = ranges.find((r) => r.start < end && r.end > start);
    if (!inner) continue;
    lineInstrumented[i] = true;
    lineCovered[i] = inner.count > 0;
  }
  const blocks = [...record.blocks.values()];
  return {
    lines, starts, lineCovered, lineInstrumented,
    lines_total: lineInstrumented.filter(Boolean).length,
    lines_covered: lineCovered.filter(Boolean).length,
    blocks_total: blocks.length,
    blocks_covered: blocks.filter((count) => count > 0).length,
    ranges,
  };
}

function inScope(rel, roots, exclude) {
  const included = roots.some((root) => (root.endsWith('/') ? rel.startsWith(root) : rel === root || rel.startsWith(`${root}/`)));
  if (!included) return false;
  return !exclude.some((e) => rel === e || rel.startsWith(`${e}/`) || rel.includes(`/${e}/`));
}

/** 变更行：git diff 的新增行 ∪ 未跟踪文件的全部行（未跟踪文件按整文件算新增）。 */
async function changeSet(repo, baseCandidates) {
  let base = null;
  // 默认基数是 HEAD：质量门禁的"新增行/新增分支"指**本次未提交改动**（工作树 vs HEAD）
  // 加上未跟踪文件。用远端分支当基数会把别人已提交的历史算成"新增"（实测 origin/main
  // 落后 3 万多行），那样门禁判的就不是这次改动。CI/PR 场景可用 QUALITY_DIFF_BASE 覆盖，
  // 代价是要自己确认基数足够新。
  const bases = [process.env.QUALITY_DIFF_BASE, 'HEAD', ...baseCandidates].filter(Boolean);
  for (const candidate of bases) {
    const probe = await git(repo, ['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`]);
    if (probe.code === 0) {
      base = candidate;
      break;
    }
  }
  const changed = new Map();
  const notes = [];
  if (base) {
    const diff = await git(repo, ['diff', '--unified=0', '--no-color', '--no-ext-diff', base, '--']);
    if (diff.code !== 0) {
      notes.push(`git diff 失败：${diff.stderr.trim()}`);
    } else {
      let current = null;
      for (const line of diff.stdout.split('\n')) {
        const fileMatch = /^\+\+\+ b\/(.*)$/.exec(line);
        if (fileMatch) {
          current = fileMatch[1];
          if (!changed.has(current)) changed.set(current, new Set());
          continue;
        }
        const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
        if (hunk && current) {
          const start = Number(hunk[1]);
          const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
          for (let i = 0; i < count; i += 1) changed.get(current).add(start + i);
        }
      }
      notes.push(`diff 基准 ${base}：跟踪文件新增/修改行 ${[...changed.values()].reduce((sum, s) => sum + s.size, 0)} 行`);
    }
  } else {
    notes.push('没有可用的 diff 基准（origin/main / main / HEAD^ 都不可解析）');
  }
  const untrackedResult = await git(repo, ['ls-files', '--others', '--exclude-standard', '-z']);
  const untracked = untrackedResult.code === 0 ? untrackedResult.stdout.split('\0').filter(Boolean) : [];
  notes.push(`未跟踪文件 ${untracked.length} 个（按整文件计为新增行）`);
  return {
    base, changed, untracked, notes,
  };
}

async function main() {
  const args = parseCli();
  const repo = path.resolve(args.repo || process.cwd());
  const check = readCheckConfig(args.check);
  const reportDir = args['report-dir'] || path.join(repo, 'reports');
  const artifactPath = args.artifact || path.join(reportDir, 'artifacts', 'coverage.json');
  const scope = check.scope || {};
  const targets = scope.targets || [];
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fairy-coverage-'));

  const tracked = await trackedFiles(repo);
  const packages = tracked
    .filter((rel) => rel.endsWith('/package.json') && (scope.package_globs || ['*/dsh-*/package.json']).some((g) => matchGlob(g, rel)))
    .map((manifest) => ({ manifest, dir: path.dirname(manifest), name: path.basename(path.dirname(manifest)) }));

  const changes = await changeSet(repo, scope.diff?.base_candidates || ['origin/main', 'main', 'HEAD^']);
  const targetReports = [];
  const totals = {
    lines_total: 0, lines_covered: 0, blocks_total: 0, blocks_covered: 0,
  };
  const changedTotals = {
    lines_total: 0, lines_covered: 0, blocks_total: 0, blocks_covered: 0,
  };
  const workloads = [];
  const unexecuted = [];

  for (const target of targets) {
    const roots = target.roots || ['lib/', 'src/'];
    const exclude = target.exclude || ['test/', 'node_modules/'];
    // packages 目标的 roots 是**包内相对路径**（lib/、src/），要展开成仓库相对前缀，
    // 否则过滤器永远匹配不到文件（实测过一次：计量文件 0 个）。
    const expandedRoots = target.kind === 'packages'
      ? packages.flatMap((pkg) => roots.map((root) => `${pkg.dir}/${root}`))
      : roots;
    const collected = await collectCoverage({ repo, outDir, target, packages });
    workloads.push(...collected.workloads);
    const merged = mergeCoverage(collected.coverageDir);
    const files = [];
    const seen = new Set();
    for (const [absolute, record] of merged.byFile) {
      const rel = path.relative(repo, absolute).split(path.sep).join('/');
      if (rel.startsWith('..')) continue;
      if (!inScope(rel, expandedRoots, exclude)) continue;
      seen.add(rel);
      const analysis = analyzeFile(absolute, record);
      const changedLines = new Set();
      let changedFile = false;
      if (changes.changed.has(rel)) {
        changedFile = true;
        for (const line of changes.changed.get(rel)) changedLines.add(line);
      }
      if (changes.untracked.includes(rel)) {
        changedFile = true;
        for (let i = 0; i < analysis.lines.length; i += 1) changedLines.add(i + 1);
      }
      let changedLineTotal = 0;
      let changedLineCovered = 0;
      let changedBlockTotal = 0;
      let changedBlockCovered = 0;
      if (changedFile) {
        for (const lineNumber of changedLines) {
          const index = lineNumber - 1;
          if (index < 0 || index >= analysis.lines.length) continue;
          if (!analysis.lineInstrumented[index]) continue;
          changedLineTotal += 1;
          if (analysis.lineCovered[index]) changedLineCovered += 1;
        }
        for (const range of analysis.ranges) {
          const startLine = analysis.starts.findIndex((s, i) => s <= range.start && range.start < s + analysis.lines[i].length + 1);
          if (startLine === -1) continue;
          if (!changedLines.has(startLine + 1)) continue;
          changedBlockTotal += 1;
          if (range.count > 0) changedBlockCovered += 1;
        }
      }
      files.push({
        file: rel,
        lines_total: analysis.lines_total,
        lines_covered: analysis.lines_covered,
        lines_pct: pct(analysis.lines_covered, analysis.lines_total),
        blocks_total: analysis.blocks_total,
        blocks_covered: analysis.blocks_covered,
        blocks_pct: pct(analysis.blocks_covered, analysis.blocks_total),
        changed_file: changedFile,
        changed_lines_total: changedLineTotal,
        changed_lines_covered: changedLineCovered,
        changed_lines_pct: changedLineTotal ? pct(changedLineCovered, changedLineTotal) : null,
        changed_blocks_total: changedBlockTotal,
        changed_blocks_covered: changedBlockCovered,
        changed_blocks_pct: changedBlockTotal ? pct(changedBlockCovered, changedBlockTotal) : null,
      });
      totals.lines_total += analysis.lines_total;
      totals.lines_covered += analysis.lines_covered;
      totals.blocks_total += analysis.blocks_total;
      totals.blocks_covered += analysis.blocks_covered;
      changedTotals.lines_total += changedLineTotal;
      changedTotals.lines_covered += changedLineCovered;
      changedTotals.blocks_total += changedBlockTotal;
      changedTotals.blocks_covered += changedBlockCovered;
    }
    // 未被执行的生产文件（在 scope 内、但本次负载从没加载过）：显式暴露，不悄悄算 0%
    const candidates = new Set([
      ...tracked.filter((rel) => inScope(rel, expandedRoots, exclude) && /\.(m|c)?js$/.test(rel)),
      ...changes.untracked.filter((rel) => inScope(rel, expandedRoots, exclude) && /\.(m|c)?js$/.test(rel)),
    ]);
    for (const candidate of candidates) {
      if (!seen.has(candidate)) unexecuted.push({ target: target.name, file: candidate });
    }
    targetReports.push({
      name: target.name,
      kind: target.kind,
      roots,
      expanded_roots: expandedRoots,
      exclude,
      coverage_files: merged.coverageFiles,
      files_measured: files.length,
      files,
      workloads: collected.workloads,
    });
  }

  // 每个目标单独出一组指标：产品代码（packages）与质量体系自身（harness）的口径与门槛不同，
  // 混成一个聚合数字会让"谁把覆盖率拉低了"看不清。
  const targetMetrics = {};
  for (const target of targetReports) {
    const linesTotal = target.files.reduce((s, f) => s + f.lines_total, 0);
    const linesCov = target.files.reduce((s, f) => s + f.lines_covered, 0);
    const blocksTotal = target.files.reduce((s, f) => s + f.blocks_total, 0);
    const blocksCov = target.files.reduce((s, f) => s + f.blocks_covered, 0);
    const changedFiles = target.files.filter((f) => f.changed_file);
    const changedLineTotal = changedFiles.reduce((s, f) => s + f.changed_lines_total, 0);
    const changedLineCov = changedFiles.reduce((s, f) => s + f.changed_lines_covered, 0);
    // 指标名写成**字面量**（不用模板拼）：repo-contracts 会核对"阈值里写的指标名必须在脚本源码里出现"，
    // 拼出来的名字会让那条守卫失效（本仓真实踩过：阈值全绿但脚本其实从不输出该指标）。
    const NAMES = {
      packages: {
        lines: 'packages_lines_pct',
        blocks: 'packages_blocks_pct',
        files: 'packages_files_measured',
        changedFiles: 'packages_changed_files',
        changedLines: 'packages_changed_lines_pct',
        changedBlocks: 'packages_changed_blocks_pct',
      },
      harness: {
        lines: 'harness_lines_pct',
        blocks: 'harness_blocks_pct',
        files: 'harness_files_measured',
        changedFiles: 'harness_changed_files',
        changedLines: 'harness_changed_lines_pct',
        changedBlocks: 'harness_changed_blocks_pct',
      },
    }[target.name];
    if (!NAMES) continue;
    const changedBlockTotal = changedFiles.reduce((s, f) => s + (f.changed_blocks_total || 0), 0);
    const changedBlockCov = changedFiles.reduce((s, f) => s + (f.changed_blocks_covered || 0), 0);
    targetMetrics[NAMES.lines] = pct(linesCov, linesTotal);
    targetMetrics[NAMES.blocks] = pct(blocksCov, blocksTotal);
    targetMetrics[NAMES.files] = target.files_measured;
    targetMetrics[NAMES.changedFiles] = changedFiles.length;
    if (changedLineTotal) targetMetrics[NAMES.changedLines] = pct(changedLineCov, changedLineTotal);
    if (changedBlockTotal) targetMetrics[NAMES.changedBlocks] = pct(changedBlockCov, changedBlockTotal);
  }

  if (totals.lines_total === 0) {
    process.stdout.write('coverage 内部错误：没有可计量的文件（负载没产出覆盖率数据，或 roots/exclude 配错了）——不接受 0/0 的假 100%\n');
    process.exit(2);
  }
  const totalLinesPct = pct(totals.lines_covered, totals.lines_total);
  const totalBlocksPct = pct(totals.blocks_covered, totals.blocks_total);
  const changedLinesPct = changedTotals.lines_total ? pct(changedTotals.lines_covered, changedTotals.lines_total) : null;
  const changedBlocksPct = changedTotals.blocks_total ? pct(changedTotals.blocks_covered, changedTotals.blocks_total) : null;
  const useChangedScope = changedLinesPct !== null;
  const workloadFailures = workloads.filter((w) => w.timed_out || (w.code !== 0 && w.coverage_produced !== true));

  process.stdout.write(`coverage：计量文件 ${[...targetReports].reduce((sum, t) => sum + t.files_measured, 0)} 个；\n`);
  for (const target of targetReports) {
    const linesTotal = target.files.reduce((s, f) => s + f.lines_total, 0);
    const linesCov = target.files.reduce((s, f) => s + f.lines_covered, 0);
    const blocksTotal = target.files.reduce((s, f) => s + f.blocks_total, 0);
    const blocksCov = target.files.reduce((s, f) => s + f.blocks_covered, 0);
    const changedFiles = target.files.filter((f) => f.changed_file);
    process.stdout.write(`   [${target.name}] 文件 ${target.files_measured}；行 ${pct(linesCov, linesTotal)}%（${linesCov}/${linesTotal}）；块 ${pct(blocksCov, blocksTotal)}%（${blocksCov}/${blocksTotal}）；变更文件 ${changedFiles.length}\n`);
    for (const file of changedFiles.slice(0, 15)) {
      process.stdout.write(`      · ${file.file} 变更行 ${file.changed_lines_covered}/${file.changed_lines_total}（${file.changed_lines_pct}%）；整文件行 ${file.lines_pct}%\n`);
    }
  }
  process.stdout.write(`  口径：全量计量（上面两个数字）；变更口径：${useChangedScope ? `diff 基准 ${changes.base} + 未跟踪文件` : '本次没有变更行'}；\n`);
  if (Object.keys(targetMetrics).length) {
    process.stdout.write(`  按目标：${Object.entries(targetMetrics).map(([k, v]) => `${k}=${v}`).join('  ')}\n`);
  }
  process.stdout.write(`  全量行 ${totalLinesPct}%（${totals.lines_covered}/${totals.lines_total}）；全量块 ${totalBlocksPct}%（${totals.blocks_covered}/${totals.blocks_total}）；\n`);
  if (useChangedScope) {
    process.stdout.write(`  变更行 ${changedLinesPct}%（${changedTotals.lines_covered}/${changedTotals.lines_total}）；变更块 ${changedBlocksPct}%（${changedTotals.blocks_covered}/${changedTotals.blocks_total}）；\n`);
  }
  for (const note of changes.notes) process.stdout.write(`  · ${note}\n`);
  if (unexecuted.length) {
    process.stdout.write(`  未被执行的生产文件 ${unexecuted.length} 个（不计入分母，但显式列出）：\n`);
    for (const item of unexecuted.slice(0, 15)) process.stdout.write(`      · [${item.target}] ${item.file}\n`);
    if (unexecuted.length > 15) process.stdout.write(`      … 其余 ${unexecuted.length - 15} 个见产物 JSON\n`);
  }
  for (const failure of workloadFailures) {
    process.stdout.write(`  ✖ 负载失败：${failure.target}（退出码 ${failure.code}）${failure.command ? `\n      ${failure.command}` : ''}\n`);
  }

  const artifact = {
    generated_at: new Date().toISOString(),
    repo,
    node: process.version,
    scope: useChangedScope ? 'changed-lines' : 'all-measured',
    diff_base: changes.base,
    diff_notes: changes.notes,
    totals: { ...totals, lines_pct: totalLinesPct, blocks_pct: totalBlocksPct },
    changed: changedTotals.lines_total ? { ...changedTotals, lines_pct: changedLinesPct, blocks_pct: changedBlocksPct } : null,
    workloads,
    unexecuted_production_files: unexecuted,
    targets: targetReports,
  };
  ensureDir(path.dirname(artifactPath));
  writeJson(artifactPath, artifact);
  fs.rmSync(outDir, { recursive: true, force: true });

  const flakyWorkloads = workloads.filter((w) => w.flaky);
  const ok = workloadFailures.length === 0;
  finish({
    ok,
    metrics: {
      scope_changed_lines: useChangedScope ? 1 : 0,
      lines_pct: totalLinesPct,
      blocks_pct: totalBlocksPct,
      changed_lines_pct: useChangedScope ? changedLinesPct : undefined,
      changed_blocks_pct: useChangedScope && changedBlocksPct !== null ? changedBlocksPct : undefined,
      files_measured: targetReports.reduce((sum, t) => sum + t.files_measured, 0),
      unexecuted_production_files: unexecuted.length,
      workload_failures: workloadFailures.length,
      ...targetMetrics,
      flaky_workloads: flakyWorkloads.length,
      flaky_rate: pct(flakyWorkloads.length, workloads.length),
      command_workload_exit_code: (workloads.find((w) => w.command) || {}).code,
      command_workload_exit_code: (workloads.find((w) => w.command) || {}).code,
    },
    artifactPath,
    artifact,
    failureNote: '覆盖率负载本身执行失败（测试没跑完时覆盖率没有意义）：先修负载，再看覆盖率数字。',
  });
}

main().catch((error) => {
  process.stdout.write(`coverage 内部错误：${error && error.stack ? error.stack : error}\n`);
  process.exit(2);
});
