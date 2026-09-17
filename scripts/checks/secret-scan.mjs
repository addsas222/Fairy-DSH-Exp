// 检查项 secret-scan：跟踪文件的密钥/凭据扫描（零依赖，Node 内建正则 + 香农熵）。
//
// 真实机制、真实门禁：
//   - 只扫 `git ls-files` 的跟踪文件（未跟踪的临时文件不进仓库，不是泄密面），
//     跳过二进制（扩展名 + NUL 字节判定）。
//   - 两类判定：① 具名模式（私钥块、AWS/GitHub/Slack/OpenAI/Google/JWT 等令牌形态）；
//     ② 通用赋值（password/secret/token/api_key = "…"）再叠加香农熵阈值，压掉占位符噪声。
//   - 报告里**只打印掩码**（前 4 字符 + 长度），不把疑似密钥原文写进日志或报告。
//   - 误报用 .agent/checks/secret-scan.yaml 的 scope.allow 逐条登记（要求写 reason），
//     而不是把规则改松：新增命中一律算错误。
import fs from 'node:fs';
import path from 'node:path';
import {
  ensureDir, finish, parseCli, pct, readCheckConfig, scannedFiles,
} from './lib/runtime.mjs';

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.webp', '.ico', '.gif', '.woff', '.woff2', '.ttf', '.otf', '.onnx',
  '.zip', '.gz', '.tar', '.pdf', '.mp4', '.mp3', '.wav', '.dll', '.exe', '.so', '.dylib', '.node',
]);

const GENERIC_KEY_NAMES = 'password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|auth[_-]?token|bearer';

const PATTERNS = [
  { id: 'private-key-block', severity: 'error', pattern: /-----BEGIN[ A-Z]*PRIVATE KEY-----/ },
  { id: 'aws-access-key-id', severity: 'error', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { id: 'github-token', severity: 'error', pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{22,}\b/ },
  { id: 'slack-token', severity: 'error', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { id: 'openai-key', severity: 'error', pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/ },
  { id: 'anthropic-key', severity: 'error', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { id: 'google-api-key', severity: 'error', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { id: 'jwt', severity: 'error', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { id: 'generic-credential-assignment', severity: 'error', pattern: new RegExp(`(?:${GENERIC_KEY_NAMES})\\s*[:=]\\s*['"\`]([^'"\`\\n]{12,})['"\`]`, 'i'), capture: 1, entropy: 3.5 },
];

/** 测试路径判定：夹具里本来就该有"假密钥"，通用赋值规则在这里只作提示级。 */
function isTestPath(rel) {
  return /(^|\/)test\//.test(rel) || /(^|\/)tests\//.test(rel)
    || /\.(test|spec)\.(m|c)?js$/.test(rel) || /(^|\/)fixtures?\//.test(rel);
}

function shannonEntropy(text) {
  const counts = new Map();
  for (const ch of text) counts.set(ch, (counts.get(ch) || 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / text.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

function mask(value) {
  if (value.length <= 6) return `${value.slice(0, 2)}***(${value.length})`;
  return `${value.slice(0, 4)}***(${value.length})`;
}

async function main() {
  const args = parseCli();
  const repo = path.resolve(args.repo || process.cwd());
  const check = readCheckConfig(args.check);
  const reportDir = args['report-dir'] || path.join(repo, 'reports');
  const artifactPath = args.artifact || path.join(reportDir, 'artifacts', 'secret-scan.json');
  const scope = check.scope || {};
  const excluded = (scope.exclude || []).map((p) => p.split('/').join('/'));
  const allow = (scope.allow || []).map((entry) => ({ ...entry, regex: new RegExp(entry.pattern) }));

  const files = await scannedFiles(repo);
  if (files.length === 0) {
    process.stdout.write('secret-scan 内部错误：扫描面为空（没有任何跟踪/未跟踪文件）——不接受假通过\n');
    process.exit(2);
  }
  const findings = [];
  const advisories = [];
  const allowed = [];
  let scanned = 0;
  let skipped = 0;

  for (const rel of files) {
    const ext = path.extname(rel).toLowerCase();
    if (BINARY_EXTENSIONS.has(ext)) { skipped += 1; continue; }
    if (excluded.some((e) => rel === e || rel.startsWith(`${e}/`) || rel.includes(`/${e}/`))) { skipped += 1; continue; }
    let buffer;
    try {
      buffer = fs.readFileSync(path.join(repo, rel));
    } catch {
      continue;
    }
    if (buffer.includes(0)) { skipped += 1; continue; }
    const text = buffer.toString('utf8');
    scanned += 1;
    const lines = text.split(/\r?\n/);
    lines.forEach((line, index) => {
      for (const rule of PATTERNS) {
        const match = rule.pattern.exec(line);
        if (!match) continue;
        const value = rule.capture ? (match[rule.capture] || match[0]) : match[0];
        const entropy = shannonEntropy(value);
        if (rule.entropy !== undefined && entropy < rule.entropy) continue;
        const hit = {
          path: rel,
          line: index + 1,
          rule: rule.id,
          masked: mask(value),
          entropy: Number(entropy.toFixed(2)),
        };
        const exemption = allow.find((entry) => (entry.path || '') === rel && entry.regex.test(line));
        if (exemption) {
          allowed.push({ ...hit, reason: exemption.reason || '已登记豁免' });
          continue;
        }
        // 通用赋值（模糊规则）在测试/夹具路径下沉为提示级：那里本来就该有占位密钥。
        // 具名令牌模式（sk-/ghp_/AKIA/私钥/JWT 等）在测试目录里仍是错误级。
        if (rule.id === 'generic-credential-assignment' && isTestPath(rel)) {
          advisories.push({ ...hit, reason: '测试/夹具路径下的通用赋值命中（提示级）' });
          continue;
        }
        findings.push(hit);
      }
    });
  }

  const artifact = {
    generated_at: new Date().toISOString(),
    repo,
    files_scanned: scanned,
    files_skipped: skipped,
    patterns: PATTERNS.map((p) => p.id),
    findings,
    advisories,
    allowed,
  };
  ensureDir(path.dirname(artifactPath));
  const ok = findings.length === 0;
  if (ok) {
    process.stdout.write(`secret-scan：扫描 ${scanned} 个跟踪文本文件（跳过 ${skipped} 个二进制/排除项），命中 0；提示级 ${advisories.length} 条；已登记豁免 ${allowed.length} 条\n`);
    for (const item of advisories.slice(0, 10)) process.stdout.write(`  · 提示 ${item.path}:${item.line} [${item.rule}] ${item.masked}（${item.reason}）\n`);
    for (const item of allowed.slice(0, 10)) process.stdout.write(`  · 豁免 ${item.path}:${item.line} [${item.rule}] ${item.reason}\n`);
  } else {
    process.stdout.write(`secret-scan：${findings.length} 处疑似密钥\n`);
    for (const item of findings.slice(0, 30)) process.stdout.write(`  ✖ ${item.path}:${item.line} [${item.rule}] ${item.masked}（熵 ${item.entropy}）\n`);
    process.stdout.write('  报告只显示掩码；原文请在本机自行查看，不要贴进 issue/PR。\n');
  }
  finish({
    ok,
    metrics: {
      files_scanned: scanned,
      findings: findings.length,
      advisories: advisories.length,
      allowed: allowed.length,
      finding_rate: pct(findings.length, scanned),
    },
    artifactPath,
    artifact,
    failureNote: '疑似密钥必须为 0：真实密钥请轮换后从历史中清除；测试夹具请在 .agent/checks/secret-scan.yaml 的 scope.allow 里逐条登记并写明 reason。',
  });
}

main().catch((error) => {
  process.stdout.write(`secret-scan 内部错误：${error && error.stack ? error.stack : error}\n`);
  process.exit(2);
});
