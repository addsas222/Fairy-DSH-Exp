// 检查项 format：跨平台文本形态门禁（零依赖，Node 内建能力）。
//
// 仓库里没有 prettier/eslint 这类格式化器，也不打算为它引入根级工程（各包自带锁文件、
// CI 不装根依赖）。所以这里做的是**能真正判定对错**的形态规则——它们不是"风格偏好"，
// 而是会让门禁/部署在不同平台产生不同结果的结构性问题：
//
//   错误级（默认门禁）：
//     eol-lf          跟踪文本文件必须是 LF（.cmd/.bat/.ps1 例外，见下）
//     eol-crlf        跟踪的 .cmd/.bat/.ps1 必须 CRLF（cmd.exe 对 LF-only 的 .cmd 会错解析）
//     ps1-bom         .ps1 必须 UTF-8 BOM（PS 5.1 无 BOM 时按 ANSI 解码，中文注释会吞代码）
//     bom-forbidden   其它文本文件不得带 BOM
//     nul-byte        文本文件里出现 NUL（误当文本提交的二进制）
//     mixed-eol       同一文件里混用 CRLF 与 LF / 只有 CR
//   提示级（不进错误计数，用于存量债）：trailing-whitespace、final-newline
//
// 存量违规写在 .agent/checks/format.yaml 的 scope.legacy_violations（带原因），
// 命中基线只记 advisory；**新增**违规一律算错误，因此门禁不会因存量而失效。
import fs from 'node:fs';
import path from 'node:path';
import {
  ensureDir, finish, parseCli, pct, readCheckConfig, repoRelative, scannedFiles,
} from './lib/runtime.mjs';

const TEXT_EXTENSIONS = new Set([
  '', '.js', '.mjs', '.cjs', '.json', '.md', '.yaml', '.yml', '.sh', '.cmd', '.bat', '.ps1',
  '.ts', '.txt', '.patch', '.command', '.gitignore', '.gitattributes', '.toml', '.ini', '.cfg',
]);
const CRLF_REQUIRED = new Set(['.cmd', '.bat', '.ps1']);

function extOf(file) {
  const base = path.basename(file);
  if (base.startsWith('.') && !base.slice(1).includes('.')) return base;
  const idx = base.lastIndexOf('.');
  return idx <= 0 ? '' : base.slice(idx).toLowerCase();
}

function analyse(file) {
  const buffer = fs.readFileSync(file);
  const hasBom = buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf;
  const nul = buffer.includes(0);
  const text = buffer.toString('utf8');
  const crlf = (text.match(/\r\n/g) || []).length;
  const bareLf = (text.match(/[^\r]\n/g) || []).length + (text.startsWith('\n') ? 1 : 0);
  const crOnly = (text.match(/\r(?!\n)/g) || []).length;
  const lines = text.split(/\r\n|\n|\r/);
  const trailing = [];
  lines.forEach((line, i) => {
    if (/[ \t]+$/.test(line)) trailing.push(i + 1);
  });
  return {
    hasBom, nul, crlf, bareLf, crOnly, trailing, bytes: buffer.length, endsWithNewline: /(\r\n|\n|\r)$/.test(text),
  };
}

async function main() {
  const args = parseCli();
  const repo = path.resolve(args.repo || process.cwd());
  const check = readCheckConfig(args.check);
  const reportDir = args['report-dir'] || path.join(repo, 'reports');
  const artifactPath = args.artifact || path.join(reportDir, 'artifacts', 'format.json');
  const scope = check.scope || {};
  const legacy = new Map();
  for (const entry of scope.legacy_violations || []) {
    legacy.set(entry.path.split('/').join('/'), entry);
  }

  const files = await scannedFiles(repo);
  if (files.length === 0) {
    process.stdout.write('format 内部错误：扫描面为空（该仓库没有任何跟踪/未跟踪文件）——门禁不接受"0 个文件 0 个违规"的假通过\n');
    process.exit(2);
  }
  const errors = [];
  const advisories = [];
  const exempted = [];
  let scanned = 0;

  for (const rel of files) {
    const ext = extOf(rel);
    if (!TEXT_EXTENSIONS.has(ext)) continue;
    const full = path.join(repo, rel);
    let info;
    try {
      info = analyse(full);
    } catch (error) {
      errors.push({ path: rel, rule: 'readable', detail: String(error.message) });
      continue;
    }
    scanned += 1;
    const found = [];
    if (info.nul) found.push({ rule: 'nul-byte', detail: '文件包含 NUL 字节' });
    if (info.crlf > 0 && (info.bareLf > 0 || info.crOnly > 0)) {
      found.push({ rule: 'mixed-eol', detail: `CRLF=${info.crlf} LF=${info.bareLf} CR=${info.crOnly}` });
    }
    if (CRLF_REQUIRED.has(ext)) {
      if (info.bareLf > 0 || info.crOnly > 0 || info.crlf === 0) {
        found.push({ rule: 'eol-crlf', detail: `${ext} 必须是 CRLF（实测 CRLF=${info.crlf} LF=${info.bareLf} CR=${info.crOnly}）` });
      }
      if (ext === '.ps1' && !info.hasBom) {
        found.push({ rule: 'ps1-bom', detail: '.ps1 必须 UTF-8 with BOM（否则 PS 5.1 按 ANSI 解码，中文注释会吞掉后续代码）' });
      }
    } else {
      if (info.crlf > 0 || info.crOnly > 0) {
        found.push({ rule: 'eol-lf', detail: `跟踪文本文件必须是 LF（实测 CRLF=${info.crlf} CR=${info.crOnly}）` });
      }
      if (info.hasBom) found.push({ rule: 'bom-forbidden', detail: '非 .ps1 文本文件不得带 BOM' });
    }
    if (info.trailing.length) {
      found.push({ rule: 'trailing-whitespace', detail: `行尾空白：${info.trailing.slice(0, 5).join(',')}${info.trailing.length > 5 ? '…' : ''}`, advisory: true });
    }
    if (!info.endsWithNewline) found.push({ rule: 'final-newline', detail: '缺少文件末尾换行', advisory: true });

    const legacyEntry = legacy.get(rel);
    const legacyRules = new Set(legacyEntry ? legacyEntry.rules : []);
    for (const item of found) {
      if (legacyRules.has(item.rule)) {
        exempted.push({ path: rel, rule: item.rule, reason: legacyEntry.reason || '存量违规（基线）' });
        continue;
      }
      if (item.advisory) advisories.push({ path: rel, rule: item.rule, detail: item.detail });
      else errors.push({ path: rel, rule: item.rule, detail: item.detail });
    }
  }

  const artifact = {
    generated_at: new Date().toISOString(),
    repo,
    files_scanned: scanned,
    errors,
    advisories,
    baseline_exemptions: exempted,
  };
  ensureDir(path.dirname(artifactPath));
  const ok = errors.length === 0;
  if (!ok) {
    process.stdout.write(`format：${errors.length} 个错误级违规\n`);
    for (const item of errors.slice(0, 40)) process.stdout.write(`  ✖ ${item.path} [${item.rule}] ${item.detail}\n`);
    if (errors.length > 40) process.stdout.write(`  … 其余 ${errors.length - 40} 条见产物 JSON\n`);
  } else {
    process.stdout.write(`format：扫描 ${scanned} 个跟踪文本文件，错误级违规 0；提示级 ${advisories.length} 条；基线豁免 ${exempted.length} 条\n`);
    for (const item of advisories.slice(0, 20)) process.stdout.write(`  · ${item.path} [${item.rule}] ${item.detail}\n`);
  }
  finish({
    ok,
    metrics: {
      files_scanned: scanned,
      errors: errors.length,
      error_rate: pct(errors.length, scanned),
      advisories: advisories.length,
      baseline_exemptions: exempted.length,
    },
    artifactPath,
    artifact,
    failureNote: 'format 错误级违规必须为 0；存量债请写入 .agent/checks/format.yaml 的 scope.legacy_violations 并附原因。',
  });
}

main().catch((error) => {
  process.stdout.write(`format 内部错误：${error && error.stack ? error.stack : error}\n`);
  process.exit(2);
});
