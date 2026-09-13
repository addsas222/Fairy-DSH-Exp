import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

/* Creating a real symlink on Windows needs elevation (EPERM); a directory
 * junction is the platform's equivalent and is what AGENTS.md prescribes. */
function linkDirectory(target, linkPath) {
  if (process.platform === 'win32') symlinkSync(resolve(dirname(linkPath), target), linkPath, 'junction');
  else symlinkSync(target, linkPath);
}

const verifier = fileURLToPath(new URL('../preflight-build.js', import.meta.url));
const approvedProfile = fileURLToPath(new URL('../../profiles/web/', import.meta.url));
const packages = [
  ['dsh-browser-dock', 'browser-dock'],
  ['dsh-balance-meter', 'balance-meter'],
  ['dsh-fairy-startup', 'fairy-startup'],
  ['dsh-fairy-visual', 'fairy-visual'],
  ['dsh-fairy-voice', 'fairy-voice'],
  ['dsh-fairy-persona', 'fairy-persona'],
  ['dsh-fairy-modes', 'fairy-modes'],
  ['dsh-fairy-search', 'fairy-search'],
  ['dsh-fairy-memory', 'fairy-memory'],
  ['dsh-fairy-roleplay', 'fairy-roleplay'],
];

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-preflight-test-'));
  const profile = join(root, 'profiles', 'web');
  mkdirSync(profile, { recursive: true });
  writeFileSync(join(profile, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web',
    dependencies: {
      ...Object.fromEntries(packages.map(([name, folder]) => [name, `link:../../${folder}/${name}`])),
      'dsh-message-edit': '0.2.3',
      'dsh-reasoning-effort': 'github:HanaAyane/dsh-reasoning-effort#83bc8c548749d7156a03d11d875d8117e9b5d994',
    },
  }));
  copyFileSync(join(approvedProfile, 'pnpm-lock.yaml'), join(profile, 'pnpm-lock.yaml'));
  copyFileSync(join(approvedProfile, 'cordis.patch.yml'), join(profile, 'cordis.patch.yml'));
  mkdirSync(join(profile, 'patches'), { recursive: true });
  for (const patch of ['dsh-message-edit@0.2.3.patch', 'dsh-reasoning-effort@0.6.2.patch']) {
    copyFileSync(join(approvedProfile, 'patches', patch), join(profile, 'patches', patch));
  }
  const nodeModules = join(profile, 'node_modules');
  mkdirSync(nodeModules, { recursive: true });
  for (const [name, folder] of packages) {
    const source = join(root, folder, name);
    mkdirSync(join(source, 'lib'), { recursive: true });
    writeFileSync(join(source, 'package.json'), JSON.stringify({
      name,
      main: './lib/index.js',
      exports: { '.': './lib/index.js', './client': './lib/client.js', './package.json': './package.json' },
    }));
    if (name === 'dsh-fairy-visual' || name === 'dsh-browser-dock') {
      mkdirSync(join(source, 'src', 'client'), { recursive: true });
      writeFileSync(join(source, 'src', 'client', 'index.js'), 'export function apply() {}\n');
    }
    // Every fixture package gets a source tree: packages that build declare
    // `sourceRoot: 'src'` and the verifier checks that it exists.
    mkdirSync(join(source, 'src'), { recursive: true });
    writeFileSync(join(source, 'src', 'index.js'), 'export function apply() {}\n');
    writeFileSync(join(source, 'lib', 'index.js'), 'export function apply() {}\n');
    writeFileSync(join(source, 'lib', 'client.js'), `window.__ModuleLoader__.load({ id: ${JSON.stringify(name)}, factory: () => ({}) });\n`);
    linkDirectory(relative(nodeModules, source), join(nodeModules, name));
  }
  return root;
}

function runVerifier(root) {
  return spawnSync(process.execPath, [verifier], {
    env: { ...process.env, DSH_HOME: root },
    encoding: 'utf8',
  });
}

test('accepts complete bundles and profile links', (t) => {
  const root = createFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const result = runVerifier(root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /DSH_PREFLIGHT status="passed" packages="10"/);
});

test('fails before launch when a client bundle is missing', (t) => {
  const root = createFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const client = join(root, 'fairy-visual', 'dsh-fairy-visual', 'lib', 'client.js');
  assert.equal(existsSync(client), true);
  unlinkSync(client);
  const result = runVerifier(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /scope="package_entry" package="dsh-fairy-visual".*client\.js.*actual="ENOENT"/);
});

test('fails when a profile link targets the wrong package', (t) => {
  const root = createFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const nodeModules = join(root, 'profiles', 'web', 'node_modules');
  const link = join(nodeModules, 'dsh-fairy-visual');
  unlinkSync(link);
  linkDirectory('../../../fairy-voice/dsh-fairy-voice', link);
  const result = runVerifier(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /scope="profile_symlink" package="dsh-fairy-visual"/);
});

test('fails before launch when Visual source is newer than its bundle', (t) => {
  const root = createFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'fairy-visual', 'dsh-fairy-visual', 'src', 'client', 'index.js');
  const future = new Date(Date.now() + 5_000);
  utimesSync(source, future, future);
  const result = runVerifier(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /scope="build_freshness" package="dsh-fairy-visual".*Review the source change and rebuild/);
});

test('fails when a package cannot be resolved through the profile exports', (t) => {
  const root = createFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const manifest = join(root, 'fairy-visual', 'dsh-fairy-visual', 'package.json');
  writeFileSync(manifest, JSON.stringify({
    name: 'dsh-fairy-visual',
    main: './lib/index.js',
    exports: { '.': './lib/index.js' },
  }));
  const result = runVerifier(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /scope="package_entry" package="dsh-fairy-visual".*resolvable exports/);
});

test('fails when the profile dependency declaration drifts', (t) => {
  const root = createFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const profilePackage = join(root, 'profiles', 'web', 'package.json');
  writeFileSync(profilePackage, JSON.stringify({
    name: 'dsh-profile-web',
    dependencies: {
      ...Object.fromEntries(packages.map(([name, folder]) => [name, `link:../../${folder}/${name}`])),
      'dsh-message-edit': '0.2.3',
      'dsh-reasoning-effort': 'github:HanaAyane/dsh-reasoning-effort#83bc8c548749d7156a03d11d875d8117e9b5d994',
      'dsh-fairy-visual': 'link:../../fairy-voice/dsh-fairy-voice',
    },
  }));
  const result = runVerifier(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /scope="profile_dependency" package="dsh-fairy-visual"/);
});
