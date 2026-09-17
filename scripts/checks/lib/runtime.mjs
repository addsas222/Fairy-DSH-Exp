// 检查项脚本共享运行时（零依赖）。
//
// 契约（scripts/verify.mjs 与所有检查脚本之间的唯一接口）：
//   1. 出参：脚本把机器可读指标以一行 `<<<QUALITY-METRICS>>> {json}` 打到 stdout，
//      人类可读的细节照常打印（runner 会整段落到 reports/artifacts/<id>.log）。
//   2. 退出码：0=通过 / 1=失败 / 2=内部错误 / 3=跳过（前提缺失，附 skip_reason 指标）。
//   3. 入参：runner 传 `--check <check.yaml>`、`--repo <仓库根>`、`--report-dir <目录>`、
//      `--artifact <本次产物 JSON 路径>`。阈值与作用域从 check.yaml 自己读（因此
//      新增检查项只需要加配置 + 加脚本，runner 不需要认识任何一项）。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseYaml } from './yaml.mjs';

export const METRICS_MARKER = '<<<QUALITY-METRICS>>>';
export const EXIT = { PASS: 0, FAIL: 1, ERROR: 2, SKIP: 3 };

export function parseCli(argv = process.argv.slice(2)) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq !== -1) {
        out[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) {
        out[arg.slice(2)] = argv[i + 1];
        i += 1;
      } else {
        out[arg.slice(2)] = true;
      }
    } else {
      out._.push(arg);
    }
  }
  return out;
}

export function repoRelative(repo, target) {
  return path.relative(repo, target).split(path.sep).join('/');
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

export function readCheckConfig(checkPath) {
  return parseYaml(fs.readFileSync(checkPath, 'utf8'), { filename: checkPath });
}

export function emitMetrics(metrics) {
  process.stdout.write(`${METRICS_MARKER} ${JSON.stringify(metrics)}\n`);
}

export function readJsonIfExists(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function writeJson(file, value) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/** 跳过：前提缺失（不算失败，但会在报告里显式列出原因与下一步命令）。 */
export function skipRun(reason, metrics = {}, artifactPath = null, artifact = null) {
  if (artifactPath && artifact) writeJson(artifactPath, artifact);
  emitMetrics({ skipped: true, skip_reason: reason, ...metrics });
  process.exit(EXIT.SKIP);
}

/**
 * 跑一个外部命令并捕获输出。
 * @returns {Promise<{code:number, stdout:string, stderr:string, durationMs:number, timedOut:boolean, error:string|null}>}
 */
export function run(command, args, options = {}) {
  const {
    cwd = process.cwd(), env = {}, timeoutMs = 0, shell = false, maxBuffer = 64 * 1024 * 1024,
  } = options;
  return new Promise((resolve) => {
    const started = Date.now();
    let child;
    try {
      child = spawn(command, args, {
        cwd,
        env: { ...process.env, ...env },
        shell,
        windowsHide: true,
        windowsVerbatimArguments: false,
      });
    } catch (error) {
      resolve({
        code: -1, stdout: '', stderr: String(error && error.message), durationMs: 0, timedOut: false, error: String(error && error.message),
      });
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let timer = null;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);
    }
    const cap = (chunk, which) => {
      const text = chunk.toString('utf8');
      if (which === 'out') {
        if (stdout.length < maxBuffer) stdout += text;
      } else if (stderr.length < maxBuffer) stderr += text;
    };
    child.stdout.on('data', (c) => cap(c, 'out'));
    child.stderr.on('data', (c) => cap(c, 'err'));
    child.on('error', (error) => {
      stderr += `\n[spawn error] ${error.message}`;
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({
        code: timedOut ? -2 : (code === null ? -1 : code),
        stdout,
        stderr,
        durationMs: Date.now() - started,
        timedOut,
        error: null,
      });
    });
  });
}

/** 跑一条命令行字符串（配置里的 command 字段形态）；Windows 交给 cmd.exe。 */
export function runCommandString(command, options = {}) {
  return run(command, [], { ...options, shell: true });
}

/** 探测命令是否存在：用 command 的探测串，返回 {ok, output, code}。 */
export async function probeCommand(probe, options = {}) {
  const result = await runCommandString(probe, { timeoutMs: 60_000, ...options });
  return { ok: result.code === 0, output: `${result.stdout}${result.stderr}`.trim(), code: result.code };
}

/** 按平台拆出可执行文件名（Windows 下 npm/pnpm/npx/yarn 是 .cmd 垫片）。 */
export function shimName(name, platform = process.platform) {
  if (platform !== 'win32') return name;
  return /^(npm|pnpm|npx|yarn|corepack)$/.test(name) ? `${name}.cmd` : name;
}

/**
 * 把 glob 转成正则（支持双星跨目录、`*` 段内任意字符、`?` 单字符）。
 * 双星 + 斜杠要能匹配到根下的文件（零层目录）——这点很容易写错，所以统一放在这里。
 */
export function globToRegExp(glob) {
  const pattern = `^${glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '\u0000')
    .replace(/\*\*/g, '\u0001')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\u0000/g, '(?:.*/)?')
    .replace(/\u0001/g, '.*')}$`;
  return new RegExp(pattern);
}

export function listFiles(root, options = {}) {
  const {
    exclude = [], extensions = null, followSymlinks = false,
  } = options;
  const out = [];
  const excluded = exclude.map((e) => e.split(path.sep).join('/'));
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const rel = repoRelative(root, full);
      if (excluded.some((e) => rel === e || rel.startsWith(`${e}/`) || rel.includes(`/${e}/`))) continue;
      if (entry.isSymbolicLink() && !followSymlinks) continue;
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (extensions && !extensions.some((ext) => entry.name.endsWith(ext))) continue;
      out.push(full);
    }
  };
  walk(root);
  out.sort();
  return out;
}

/** git ls-files（-z 分隔，避免文件名里的空格/引号被转义）。 */
export async function trackedFiles(repo, args = []) {
  const result = await run('git', ['ls-files', '-z', ...args], { cwd: repo });
  if (result.code !== 0) {
    throw new Error(`git ls-files 失败：${result.stderr || result.stdout}`);
  }
  return result.stdout.split('\0').filter(Boolean);
}

/**
 * 待检查文件清单 = 跟踪文件 ∪ 未跟踪但未被 .gitignore 忽略的文件。
 * 为什么包含未跟踪文件：门禁要在**提交之前**就能发现新增文件的问题（行尾、语法、密钥）；
 * 只看 git ls-files 会让"刚写好的新文件"完全不受检查——本仓正是这样漏掉过 13 个 CRLF 新文件。
 * 被 .gitignore 忽略的路径（node_modules、reports/artifacts 之类）依然不进扫描面。
 */
export async function scannedFiles(repo) {
  let tracked;
  try {
    tracked = await trackedFiles(repo);
  } catch (error) {
    throw new Error('扫描面为空/无法枚举：' + error.message + '（请确认 --repo 指向一个 git 仓库）');
  }
  const others = await run('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd: repo });
  const untracked = others.code === 0 ? others.stdout.split('\0').filter(Boolean) : [];
  return [...new Set([...tracked, ...untracked])].sort();
}

export async function git(repo, args, options = {}) {
  return run('git', args, { cwd: repo, ...options });
}

/** TAP 输出解析：取 `# tests/pass/fail/skipped/todo` 汇总与失败用例名。 */
export function parseTap(text) {
  const totals = {};
  const failures = [];
  for (const line of text.split(/\r?\n/)) {
    const summary = /^#\s+(tests|pass|fail|cancelled|skipped|todo|duration_ms)\s+(\d+(?:\.\d+)?)$/.exec(line.trim());
    if (summary) {
      totals[summary[1]] = Number(summary[2]);
      continue;
    }
    const notOk = /^\s*not ok \d+ - (.*)$/.exec(line);
    if (notOk) failures.push(notOk[1].trim());
  }
  return { totals, failures };
}

/** 计算每行起始偏移，用于把 V8 的 offset 区间映射到行。 */
export function lineStarts(source) {
  const lines = source.split('\n');
  const starts = new Array(lines.length);
  let offset = 0;
  for (let i = 0; i < lines.length; i += 1) {
    starts[i] = offset;
    offset += lines[i].length + 1;
  }
  return { lines, starts };
}

export function pct(part, total) {
  if (!total) return 100;
  return Number(((part / total) * 100).toFixed(2));
}

export function isBlankOrComment(line) {
  const trimmed = line.trim();
  return trimmed === '' || trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*');
}

export function nowIso() {
  return new Date().toISOString();
}

/** 统一收尾：写产物、打印指标、按阈值结果退出。 */
export function finish({ ok, metrics, artifactPath = null, artifact = null, failureNote = '' }) {
  if (artifactPath && artifact) writeJson(artifactPath, artifact);
  emitMetrics(metrics);
  if (!ok && failureNote) process.stdout.write(`${failureNote}\n`);
  process.exit(ok ? EXIT.PASS : EXIT.FAIL);
}
