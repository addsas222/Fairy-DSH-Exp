import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

/* Creating a real symlink on Windows needs elevation (EPERM); a directory
 * junction is the platform's equivalent, is reported as a symbolic link by
 * lstat, and resolves through realpath exactly like the POSIX form. */
function linkDirectory(target, linkPath) {
  if (process.platform === 'win32') symlinkSync(resolve(dirname(linkPath), target), linkPath, 'junction');
  else symlinkSync(target, linkPath);
}

const script = fileURLToPath(new URL('../upgrade-preflight.js', import.meta.url));
// The documented isolated-home flow sets DSH_HOME; the live layout is the fallback.
const dshHome = process.env.DSH_HOME ? resolve(process.env.DSH_HOME) : join(homedir(), '.dsh');
const currentProfile = join(dshHome, 'profiles', 'web');
const currentRuntime = process.env.DSH_OFFICIAL_RUNTIME
  ? resolve(process.env.DSH_OFFICIAL_RUNTIME)
  : join(homedir(), '.local', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-client-runtime', 'lib', 'client.js');
const currentRuntimePackage = join(currentRuntime, '..', '..', 'package.json');
const expectedHash = '13a5fe0ee8cddda2306d302eb0dbfdd601e96d14baeb512867b4b6d1d72f6679';
const expectedVersion = '0.1.1-rc.2';

function run(args, env = {}) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
}

function createIsolatedFixture() {
  const rootDir = mkdtempSync(join(tmpdir(), 'dsh-upgrade-preflight-'));
  const profile = join(rootDir, 'profile');
  const nodeModules = join(profile, 'node_modules');
  const runtime = join(rootDir, 'runtime', 'lib', 'client.js');
  mkdirSync(nodeModules, { recursive: true });
  mkdirSync(join(rootDir, 'runtime', 'lib'), { recursive: true });
  for (const name of ['dsh-browser-dock', 'dsh-balance-meter', 'dsh-fairy-startup', 'dsh-fairy-visual', 'dsh-fairy-voice', 'dsh-fairy-persona', 'dsh-fairy-modes', 'dsh-fairy-search', 'dsh-fairy-memory', 'dsh-fairy-roleplay', 'dsh-fairy-eval']) {
    const source = realpathSync(join(currentProfile, 'node_modules', name));
    linkDirectory(source, join(nodeModules, name));
  }
  for (const name of ['dsh-reasoning-effort', 'dsh-message-edit']) {
    const source = realpathSync(join(currentProfile, 'node_modules', name));
    linkDirectory(source, join(nodeModules, name));
  }
  const officialConversationManifest = createRequire(join(currentProfile, 'package.json'))
    .resolve('@deepseek-ai/dsh-client-ui-conversation/package.json');
  const officialConversation = realpathSync(join(officialConversationManifest, '..'));
  mkdirSync(join(nodeModules, '@deepseek-ai'), { recursive: true });
  linkDirectory(officialConversation, join(nodeModules, '@deepseek-ai', 'dsh-client-ui-conversation'));
  const profilePackage = JSON.parse(readFileSync(join(currentProfile, 'package.json'), 'utf8'));
  for (const name of ['dsh-browser-dock', 'dsh-balance-meter', 'dsh-fairy-startup', 'dsh-fairy-visual', 'dsh-fairy-voice', 'dsh-fairy-persona', 'dsh-fairy-modes', 'dsh-fairy-search', 'dsh-fairy-memory', 'dsh-fairy-roleplay', 'dsh-fairy-eval']) {
    profilePackage.dependencies[name] = `link:${realpathSync(join(currentProfile, 'node_modules', name))}`;
  }
  writeFileSync(join(profile, 'package.json'), JSON.stringify(profilePackage, null, 2));
  copyFileSync(join(currentProfile, 'cordis.patch.yml'), join(profile, 'cordis.patch.yml'));
  copyFileSync(join(currentProfile, 'pnpm-lock.yaml'), join(profile, 'pnpm-lock.yaml'));
  copyFileSync(currentRuntime, runtime);
  copyFileSync(currentRuntimePackage, join(rootDir, 'runtime', 'package.json'));
  return { rootDir, profile, runtime };
}

test('refuses to validate the active profile or official runtime by default', () => {
  const result = run([
    '--profile', currentProfile,
    '--runtime', currentRuntime,
    '--expected-version', expectedVersion,
    '--expected-sha256', expectedHash,
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /isolated profile|isolated runtime/);
});

test('reports the reviewed dependency matrix without writing the active profile', () => {
  const before = readFileSync(join(currentProfile, 'package.json'), 'utf8');
  const result = run(['--report']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /DSH upgrade compatibility matrix/);
  assert.match(result.stdout, /@deepseek-ai\/dsh-settings 0\.1\.1-rc\.2/);
  assert.match(result.stdout, /dsh-reasoning-effort: 0\.6\.2/);
  assert.match(result.stdout, /dsh-message-edit: 0\.2\.3/);
  assert.match(result.stdout, /MutableChatNodeStore; node kinds user\/assistant-step; Visual activity normal\/thinking\/comforting/);
  assert.match(result.stdout, /Known review risks/);
  assert.equal(readFileSync(join(currentProfile, 'package.json'), 'utf8'), before);
});

test('validates an isolated candidate profile without writing into it', (t) => {
  const fixture = createIsolatedFixture();
  t.after(() => rmSync(fixture.rootDir, { recursive: true, force: true }));
  const before = readFileSync(join(fixture.profile, 'package.json'), 'utf8');
  const result = run([
    '--profile', fixture.profile,
    '--runtime', fixture.runtime,
    '--expected-version', expectedVersion,
    '--expected-sha256', expectedHash,
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /DSH upgrade preflight verified/);
  assert.equal(readFileSync(join(fixture.profile, 'package.json'), 'utf8'), before);
});

test('fails closed on an unapproved runtime hash', (t) => {
  const fixture = createIsolatedFixture();
  t.after(() => rmSync(fixture.rootDir, { recursive: true, force: true }));
  const result = run([
    '--profile', fixture.profile,
    '--runtime', fixture.runtime,
    '--expected-version', expectedVersion,
    '--expected-sha256', '0000000000000000000000000000000000000000000000000000000000000000',
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /runtime SHA-256 mismatch/);
});

test('fails closed when the reasoning lock pin changes', (t) => {
  const fixture = createIsolatedFixture();
  t.after(() => rmSync(fixture.rootDir, { recursive: true, force: true }));
  const lockFile = join(fixture.profile, 'pnpm-lock.yaml');
  const reviewedCommit = '83bc8c548749d7156a03d11d875d8117e9b5d994';
  const driftedLock = readFileSync(lockFile, 'utf8').replaceAll(reviewedCommit, '0000000000000000000000000000000000000000');
  assert(!driftedLock.includes(reviewedCommit), 'fixture must replace every reviewed reasoning lock pin');
  writeFileSync(lockFile, driftedLock);
  const result = run([
    '--profile', fixture.profile,
    '--runtime', fixture.runtime,
    '--expected-version', expectedVersion,
    '--expected-sha256', expectedHash,
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /reasoning-effort lock source or local patch drifted/);
});

test('fails closed when the reviewed assistant node kind drifts', (t) => {
  const fixture = createIsolatedFixture();
  t.after(() => rmSync(fixture.rootDir, { recursive: true, force: true }));
  const matrixFile = join(fixture.rootDir, 'capability-matrix.json');
  const matrix = JSON.parse(readFileSync(join(dshHome, 'fairy-system', 'capability-matrix.json'), 'utf8'));
  matrix.conversationProjection.nodeKinds.assistant = 'assistant';
  writeFileSync(matrixFile, JSON.stringify(matrix, null, 2));
  const result = run([
    '--profile', fixture.profile,
    '--runtime', fixture.runtime,
    '--expected-version', expectedVersion,
    '--expected-sha256', expectedHash,
  ], { DSH_CAPABILITY_MATRIX: matrixFile });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /conversation node kinds drifted/);
});

test('fails closed when Visual activity stops using the session running authority', (t) => {
  const fixture = createIsolatedFixture();
  t.after(() => rmSync(fixture.rootDir, { recursive: true, force: true }));
  const matrixFile = join(fixture.rootDir, 'capability-matrix.json');
  const matrix = JSON.parse(readFileSync(join(dshHome, 'fairy-system', 'capability-matrix.json'), 'utf8'));
  matrix.conversationProjection.visualActivity.authority = 'chat.nodes';
  writeFileSync(matrixFile, JSON.stringify(matrix, null, 2));
  const result = run([
    '--profile', fixture.profile,
    '--runtime', fixture.runtime,
    '--expected-version', expectedVersion,
    '--expected-sha256', expectedHash,
  ], { DSH_CAPABILITY_MATRIX: matrixFile });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Visual activity projection drifted/);
});
