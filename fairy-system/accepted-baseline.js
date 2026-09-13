#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const sourceRoot = path.resolve(process.env.DSH_ACCEPTED_SOURCE_ROOT || path.join(os.homedir(), '.dsh'));
const baselineRoot = path.resolve(process.env.DSH_ACCEPTED_BASELINE_ROOT || path.join(os.homedir(), '.dsh-accepted-baselines'));
const currentPointer = path.join(baselineRoot, 'CURRENT');
const scopeRoots = [
  '.agent-presets/fairy',
  'balance-meter/dsh-balance-meter',
  'browser-dock/dsh-browser-dock',
  'fairy-contracts',
  'fairy-memory/dsh-fairy-memory',
  'fairy-startup/dsh-fairy-startup',
  'fairy-system',
  'fairy-persona/dsh-fairy-persona',
  'fairy-modes/dsh-fairy-modes',
  'fairy-search/dsh-fairy-search',
  'fairy-visual/dsh-fairy-visual',
  'fairy-voice/dsh-fairy-voice',
  'fairy-voice/runtime/cpufast',
  'persona-packs',
  'launchers',
  'patches',
  'profiles/web',
];
const rootFiles = [
  'AI_PROJECT_RULES.md',
  'ARCHITECTURE.md',
  'DSH-HANDOFF.md',
  'dsh-web-launcher.applescript',
  'dsh-web-launcher.m',
];
const excludedDirectories = new Set([
  '.git',
  '.playwright-mcp',
  '__pycache__',
  'benchmarks',
  'browser-evidence',
  'logs',
  'models',
  'node_modules',
  'pretrained_models',
  'TEMP',
  'venv',
]);
const trackedExtensions = new Set([
  '.applescript', '.cjs', '.css', '.html', '.js', '.json', '.jsonl', '.m', '.md',
  '.mjs', '.patch', '.plist', '.py', '.sh', '.sql', '.toml', '.ts', '.txt', '.yaml', '.yml',
]);
const trackedNames = new Set(['.gitignore', 'LICENSE', 'Makefile']);

function fail(message) {
  process.stderr.write(`Accepted baseline verification failed: ${message}\n`);
  process.exitCode = 1;
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function normalize(relativePath) {
  return relativePath.split(path.sep).join('/');
}

function isTrackedFile(relativePath) {
  const name = path.basename(relativePath);
  return trackedNames.has(name) || trackedExtensions.has(path.extname(name).toLowerCase());
}

function scanTree() {
  const files = new Map();
  const addFile = (absolute, relative) => {
    const stat = fs.lstatSync(absolute);
    const normalized = normalize(relative);
    if (stat.isSymbolicLink()) {
      const target = fs.readlinkSync(absolute);
      files.set(normalized, { type: 'symlink', target, sha256: sha256(Buffer.from(target)) });
      return;
    }
    if (!stat.isFile() || !isTrackedFile(relative)) return;
    const content = fs.readFileSync(absolute);
    files.set(normalized, { type: 'file', bytes: stat.size, mode: stat.mode & 0o777, sha256: sha256(content) });
  };
  const visit = (absolute, relative) => {
    if (!fs.existsSync(absolute)) return;
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory() && excludedDirectories.has(entry.name)) continue;
      const childAbsolute = path.join(absolute, entry.name);
      const childRelative = path.join(relative, entry.name);
      if (entry.isDirectory()) visit(childAbsolute, childRelative);
      else addFile(childAbsolute, childRelative);
    }
  };
  for (const relative of rootFiles) {
    const absolute = path.join(sourceRoot, relative);
    if (fs.existsSync(absolute)) addFile(absolute, relative);
  }
  for (const relative of scopeRoots) visit(path.join(sourceRoot, relative), relative);
  return files;
}

function sortedObject(files) {
  return Object.fromEntries([...files.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

function treeHash(files) {
  const canonical = [...files.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([file, metadata]) => `${file}\0${metadata.type}\0${metadata.sha256}\0${metadata.mode || ''}\0${metadata.target || ''}\n`)
    .join('');
  return sha256(Buffer.from(canonical));
}

function loadBaseline() {
  if (!fs.existsSync(currentPointer)) throw new Error(`missing ${currentPointer}; create an explicitly accepted baseline first`);
  const id = fs.readFileSync(currentPointer, 'utf8').trim();
  if (!/^[0-9TZ-]+-[0-9a-f]{12}$/.test(id)) throw new Error(`invalid CURRENT baseline id: ${JSON.stringify(id)}`);
  const directory = path.join(baselineRoot, id);
  const manifestPath = path.join(directory, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.schemaVersion !== 1 || manifest.id !== id || typeof manifest.files !== 'object') throw new Error('invalid accepted baseline manifest');
  const files = new Map(Object.entries(manifest.files));
  if (treeHash(files) !== manifest.treeSha256) throw new Error('accepted baseline manifest tree hash is internally inconsistent');
  if (!id.endsWith(manifest.treeSha256.slice(0, 12))) throw new Error('accepted baseline id does not match its tree hash');
  for (const [relative, metadata] of files) {
    const snapshotFile = path.join(directory, 'snapshot', relative);
    if (!fs.existsSync(snapshotFile)) throw new Error(`accepted snapshot is missing ${relative}`);
    const actualHash = metadata.type === 'symlink'
      ? sha256(Buffer.from(fs.readlinkSync(snapshotFile)))
      : sha256(fs.readFileSync(snapshotFile));
    if (actualHash !== metadata.sha256) throw new Error(`accepted snapshot content drifted: ${relative}`);
  }
  return { id, directory, manifest, files };
}

function compare(expected, actual) {
  const changes = [];
  for (const [file, metadata] of expected) {
    const current = actual.get(file);
    if (!current) changes.push({ kind: 'deleted', file, expected: metadata });
    else if (JSON.stringify(current) !== JSON.stringify(metadata)) changes.push({ kind: 'modified', file, expected: metadata, actual: current });
  }
  for (const [file, metadata] of actual) {
    if (!expected.has(file)) changes.push({ kind: 'added', file, actual: metadata });
  }
  return changes.sort((left, right) => left.file.localeCompare(right.file) || left.kind.localeCompare(right.kind));
}

/**
 * Unified diff without platform assumptions: `/usr/bin/diff` and `/dev/null` do
 * not exist on Windows, where this report silently printed nothing. `git
 * diff --no-index` is the same tool the repository is already a checkout of,
 * and exit code 1 simply means "differences found".
 */
function diffFiles(left, right) {
  const result = spawnSync('git', ['--no-pager', 'diff', '--no-index', '--', left, right], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (!result.error && typeof result.stdout === 'string' && result.stdout !== '') return result.stdout;
  // No git, or nothing captured: report the drift as one whole-file hunk
  // instead of printing nothing at all.
  const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n') : []);
  return `--- ${left}\n+++ ${right}\n${[...read(left).map((line) => `-${line}`), ...read(right).map((line) => `+${line}`)].join('\n')}\n`;
}

function showUnifiedDiff(baseline, changes) {
  const empty = path.join(os.tmpdir(), `dsh-baseline-empty-${process.pid}`);
  let placeholder = null;
  const side = (file) => {
    if (fs.existsSync(file)) return file;
    if (placeholder === null) {
      fs.writeFileSync(empty, '');
      placeholder = empty;
    }
    return placeholder;
  };
  try {
    for (const change of changes) {
    if (change.expected?.type === 'symlink' || change.actual?.type === 'symlink') continue;
    const acceptedFile = path.join(baseline.directory, 'snapshot', change.file);
    const currentFile = path.join(sourceRoot, change.file);
    const left = side(acceptedFile);
    const right = side(currentFile);
    process.stdout.write(diffFiles(left, right));
    }
  } finally {
    if (placeholder !== null) {
      try { fs.unlinkSync(placeholder); } catch { /* best effort */ }
    }
  }
}

function verify({ diff = false } = {}) {
  const baseline = loadBaseline();
  const actual = scanTree();
  const changes = compare(baseline.files, actual);
  if (!changes.length) {
    process.stdout.write(`DSH accepted baseline clean (id ${baseline.id}; files ${actual.size}; tree sha256 ${treeHash(actual)})\n`);
    return true;
  }
  process.stderr.write(`DSH accepted baseline drift (id ${baseline.id}; changes ${changes.length})\n`);
  for (const change of changes) {
    process.stderr.write(`${change.kind.toUpperCase()} ${change.file} expected=${change.expected?.sha256 || '-'} actual=${change.actual?.sha256 || '-'}\n`);
  }
  if (diff) showUnifiedDiff(baseline, changes);
  process.exitCode = 1;
  return false;
}

function accept(reason) {
  if (!reason || reason.trim().length < 8) throw new Error('--accept requires --reason with at least 8 characters');
  const files = scanTree();
  if (!files.size) throw new Error('refusing to accept an empty source scope');
  const hash = treeHash(files);
  const timestamp = new Date().toISOString().replace(/[-:.]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const id = `${timestamp}-${hash.slice(0, 12)}`;
  const directory = path.join(baselineRoot, id);
  if (fs.existsSync(directory)) throw new Error(`baseline already exists: ${directory}`);
  fs.mkdirSync(path.join(directory, 'snapshot'), { recursive: true, mode: 0o700 });
  for (const [relative, metadata] of files) {
    const destination = path.join(directory, 'snapshot', relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    if (metadata.type === 'symlink') fs.symlinkSync(metadata.target, destination);
    else fs.copyFileSync(path.join(sourceRoot, relative), destination);
  }
  const manifest = {
    schemaVersion: 1,
    id,
    acceptedAt: new Date().toISOString(),
    reason: reason.trim(),
    sourceRoot,
    treeSha256: hash,
    fileCount: files.size,
    files: sortedObject(files),
  };
  fs.writeFileSync(path.join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  for (const [relative, metadata] of files) {
    if (metadata.type === 'file') fs.chmodSync(path.join(directory, 'snapshot', relative), 0o400);
  }
  fs.chmodSync(path.join(directory, 'manifest.json'), 0o400);
  const snapshotDirectories = [];
  const collectDirectories = (target) => {
    snapshotDirectories.push(target);
    for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
      if (entry.isDirectory()) collectDirectories(path.join(target, entry.name));
    }
  };
  collectDirectories(path.join(directory, 'snapshot'));
  snapshotDirectories.sort((left, right) => right.length - left.length).forEach((target) => fs.chmodSync(target, 0o500));
  fs.chmodSync(directory, 0o500);
  fs.mkdirSync(baselineRoot, { recursive: true, mode: 0o700 });
  const pointerTemp = path.join(baselineRoot, `.CURRENT.${process.pid}`);
  fs.writeFileSync(pointerTemp, `${id}\n`, { mode: 0o600, flag: 'wx' });
  fs.renameSync(pointerTemp, currentPointer);
  process.stdout.write(`DSH accepted baseline created (id ${id}; files ${files.size}; tree sha256 ${hash})\n`);
}

function parseArguments(argv) {
  const args = { accept: false, diff: false, reason: '' };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--accept') args.accept = true;
    else if (argv[index] === '--diff') args.diff = true;
    else if (argv[index] === '--reason' && argv[index + 1]) args.reason = argv[++index];
    else throw new Error(`unknown or incomplete argument: ${argv[index]}`);
  }
  if (args.accept && args.diff) throw new Error('--accept and --diff are mutually exclusive');
  return args;
}

function main() {
  try {
    const args = parseArguments(process.argv.slice(2));
    if (args.accept) accept(args.reason);
    else verify({ diff: args.diff });
  } catch (error) {
    fail(error.message);
  }
}

if (require.main === module) main();

module.exports = { compare, scanTree, treeHash, verify };
