#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const os = require('node:os');
const path = require('node:path');

// Resolve the official DSH installation from the current account. Release
// candidates must never embed a maintainer's home directory; CI or a local
// installation can override either path explicitly with DSH_OFFICIAL_*.
const DEFAULT_OFFICIAL_DSH_PACKAGE = path.join(os.homedir(), '.local/lib/node_modules/@deepseek-ai/dsh/package.json');
const DEFAULT_OFFICIAL_RUNTIME = path.join(os.homedir(), '.local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-runtime/lib/client.js');

const APPROVED = Object.freeze({
  dshVersion: '0.1.1-rc.2',
  runtimeSha256: '13a5fe0ee8cddda2306d302eb0dbfdd601e96d14baeb512867b4b6d1d72f6679',
  locks: Object.freeze({
    'dsh-message-edit': Object.freeze({
      version: '0.2.3',
      specifier: '0.2.3',
      importerVersion: '0.2.3(patch_hash=6365b2e53f9a2f366898ef2d78648c34823df11e9bfc2a47162e6626803763cb)',
      patchHash: '6365b2e53f9a2f366898ef2d78648c34823df11e9bfc2a47162e6626803763cb',
      packageKey: 'dsh-message-edit@0.2.3',
      patchFile: 'dsh-message-edit@0.2.3.patch',
    }),
    'dsh-reasoning-effort': Object.freeze({
      version: '0.6.2',
      specifier: 'github:HanaAyane/dsh-reasoning-effort#83bc8c548749d7156a03d11d875d8117e9b5d994',
      commit: '83bc8c548749d7156a03d11d875d8117e9b5d994',
      importerVersion: 'https://codeload.github.com/HanaAyane/dsh-reasoning-effort/tar.gz/83bc8c548749d7156a03d11d875d8117e9b5d994(patch_hash=9cbcceae243982ca0241cd41471317da9112c3e61e345b3b32f205d90aec18b5)',
      patchHash: '9cbcceae243982ca0241cd41471317da9112c3e61e345b3b32f205d90aec18b5',
      packageKey: 'dsh-reasoning-effort@https://codeload.github.com/HanaAyane/dsh-reasoning-effort/tar.gz/83bc8c548749d7156a03d11d875d8117e9b5d994',
      patchFile: 'dsh-reasoning-effort@0.6.2.patch',
    }),
  }),
});

const EXCLUDED_DIRECTORY_NAMES = new Set([
  'node_modules',
  'venv',
  'sessions',
  'attachments',
  'storages',
  'logs',
  'playwright-profile',
  '.playwright-mcp',
]);

class PreflightError extends Error {
  constructor(fields) {
    super('DSH preflight failed');
    this.name = 'PreflightError';
    this.fields = fields;
  }
}

function fieldValue(value) {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function structuredLine(marker, fields) {
  return `${marker} ${Object.entries(fields)
    .map(([key, value]) => `${key}=${JSON.stringify(fieldValue(value))}`)
    .join(' ')}`;
}

function fail({ scope, packageName, file, expected, actual, action }) {
  throw new PreflightError({
    scope,
    ...(packageName ? { package: packageName } : {}),
    file,
    expected,
    actual,
    action,
  });
}

function requireRegularFile(file, context) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch (error) {
    fail({
      ...context,
      file,
      expected: 'non-empty regular file',
      actual: error.code || error.message,
      action: context.action || 'Inspect the path and restore the approved file manually before launching DSH.',
    });
  }
  if (!stat.isFile() || stat.size === 0) {
    fail({
      ...context,
      file,
      expected: 'non-empty regular file',
      actual: stat.isFile() ? `empty file (size=${stat.size})` : 'not a regular file',
      action: context.action || 'Inspect the path and restore the approved file manually before launching DSH.',
    });
  }
  return stat;
}

function requireDirectory(directory, context) {
  let stat;
  try {
    stat = fs.statSync(directory);
  } catch (error) {
    fail({
      ...context,
      file: directory,
      expected: 'existing directory',
      actual: error.code || error.message,
      action: context.action || 'Select or restore the intended directory manually before launching DSH.',
    });
  }
  if (!stat.isDirectory()) {
    fail({
      ...context,
      file: directory,
      expected: 'directory',
      actual: 'not a directory',
      action: context.action || 'Select or restore the intended directory manually before launching DSH.',
    });
  }
  return stat;
}

function readJson(file, context) {
  requireRegularFile(file, context);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    fail({
      ...context,
      file,
      expected: 'valid JSON',
      actual: error.message,
      action: context.action || 'Inspect and correct this manifest manually before launching DSH.',
    });
  }
}

function readYaml(file, config, context) {
  requireRegularFile(file, context);
  let YAML = config.yamlModule;
  if (!YAML) {
    try {
      YAML = createRequire(config.yamlAnchor)('yaml');
    } catch (error) {
      fail({
        ...context,
        file: config.yamlAnchor,
        expected: 'installed yaml parser resolvable from the approved DSH installation',
        actual: error.code || error.message,
        action: 'Inspect the approved DSH installation manually; do not install or update dependencies from preflight.',
      });
    }
  }
  try {
    return YAML.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    fail({
      ...context,
      file,
      expected: 'valid YAML',
      actual: error.message,
      action: context.action || 'Inspect and correct the lockfile manually before launching DSH.',
    });
  }
}

function hashFile(file, algorithm) {
  return crypto.createHash(algorithm).update(fs.readFileSync(file)).digest('hex');
}

function computeClientRevision(file) {
  return hashFile(file, 'sha1').slice(0, 12);
}

function exportTarget(value) {
  if (typeof value === 'string' && value.length > 0) return value;
  if (value && typeof value === 'object') {
    for (const condition of ['default', 'import', 'require']) {
      if (typeof value[condition] === 'string' && value[condition].length > 0) return value[condition];
    }
  }
  return null;
}

function newestSource(root, packageName) {
  requireDirectory(root, {
    scope: 'package_source',
    packageName,
    action: 'Inspect the package source tree manually and restore the intended source directory before launching DSH.',
  });
  let newest = null;
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && EXCLUDED_DIRECTORY_NAMES.has(entry.name)) continue;
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath);
      } else if (entry.isFile()) {
        const mtimeMs = fs.statSync(entryPath).mtimeMs;
        if (!newest || mtimeMs > newest.mtimeMs) newest = { file: entryPath, mtimeMs };
      }
    }
  };
  visit(root);
  if (!newest) {
    fail({
      scope: 'package_source',
      packageName,
      file: root,
      expected: 'at least one source file',
      actual: 'no source files found',
      action: 'Inspect and restore the package source tree manually before launching DSH.',
    });
  }
  return newest;
}

function isInside(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

function createDefaultConfig(overrides = {}) {
  const dshHome = path.resolve(overrides.dshHome || process.env.DSH_HOME || path.join(os.homedir(), '.dsh'));
  const profileRoot = path.resolve(overrides.profileRoot || process.env.DSH_PROFILE_ROOT || path.join(dshHome, 'profiles', 'web'));
  const packageDefinitions = overrides.packageDefinitions || [
    { name: 'dsh-browser-dock', directory: path.join(dshHome, 'browser-dock', 'dsh-browser-dock'), sourceRoot: 'src' },
    { name: 'dsh-balance-meter', directory: path.join(dshHome, 'balance-meter', 'dsh-balance-meter'), sourceRoot: null },
    { name: 'dsh-fairy-startup', directory: path.join(dshHome, 'fairy-startup', 'dsh-fairy-startup'), sourceRoot: null },
    { name: 'dsh-fairy-voice', directory: path.join(dshHome, 'fairy-voice', 'dsh-fairy-voice'), sourceRoot: null },
    { name: 'dsh-fairy-visual', directory: path.join(dshHome, 'fairy-visual', 'dsh-fairy-visual'), sourceRoot: 'src' },
    { name: 'dsh-fairy-persona', directory: path.join(dshHome, 'fairy-persona', 'dsh-fairy-persona'), sourceRoot: null },
    { name: 'dsh-fairy-modes', directory: path.join(dshHome, 'fairy-modes', 'dsh-fairy-modes'), sourceRoot: null },
    { name: 'dsh-fairy-search', directory: path.join(dshHome, 'fairy-search', 'dsh-fairy-search'), sourceRoot: null },
    { name: 'dsh-fairy-memory', directory: path.join(dshHome, 'fairy-memory', 'dsh-fairy-memory'), sourceRoot: null },
  ];
  return {
    dshHome,
    profileRoot,
    workspaceRoot: path.resolve(overrides.workspaceRoot || process.env.DSH_WORKSPACE_ROOT || path.join(dshHome, 'fairy-voice')),
    dshPackagePath: path.resolve(overrides.dshPackagePath || process.env.DSH_OFFICIAL_PACKAGE || DEFAULT_OFFICIAL_DSH_PACKAGE),
    runtimePath: path.resolve(overrides.runtimePath || process.env.DSH_OFFICIAL_RUNTIME || DEFAULT_OFFICIAL_RUNTIME),
    yamlAnchor: path.resolve(overrides.yamlAnchor || process.env.DSH_YAML_ANCHOR || DEFAULT_OFFICIAL_DSH_PACKAGE),
    yamlModule: overrides.yamlModule,
    packageDefinitions: packageDefinitions.map((definition) => ({ ...definition, directory: path.resolve(definition.directory) })),
    approved: overrides.approved || APPROVED,
  };
}

function verifyCore(config) {
  const dshManifest = readJson(config.dshPackagePath, {
    scope: 'dsh_version',
    action: 'Inspect the installed DSH package manually and restore the approved version before launching.',
  });
  if (dshManifest.version !== config.approved.dshVersion) {
    fail({
      scope: 'dsh_version',
      file: config.dshPackagePath,
      expected: config.approved.dshVersion,
      actual: dshManifest.version,
      action: 'Select the approved DSH installation manually; preflight will not upgrade or downgrade it.',
    });
  }

  requireRegularFile(config.runtimePath, {
    scope: 'official_runtime',
    action: 'Restore the approved official browser runtime manually before launching DSH.',
  });
  const runtimeSha256 = hashFile(config.runtimePath, 'sha256');
  if (runtimeSha256 !== config.approved.runtimeSha256) {
    fail({
      scope: 'official_runtime',
      file: config.runtimePath,
      expected: config.approved.runtimeSha256,
      actual: runtimeSha256,
      action: 'Inspect the installed official runtime manually and restore the approved artifact; preflight will not modify it.',
    });
  }

  requireDirectory(config.workspaceRoot, {
    scope: 'workspace',
    action: 'Set the launcher workspace to the intended existing project directory before launching DSH.',
  });
  const workspaceReal = fs.realpathSync(config.workspaceRoot);
  if (workspaceReal === path.parse(workspaceReal).root) {
    fail({
      scope: 'workspace',
      file: config.workspaceRoot,
      expected: 'existing non-root workspace directory',
      actual: workspaceReal,
      action: 'Set DSH_WORKSPACE_ROOT to the intended workspace directory; never launch DSH from /.',
    });
  }

  return { dshVersion: dshManifest.version, runtimeSha256, workspaceReal };
}

function verifyProfile(config) {
  requireDirectory(config.profileRoot, {
    scope: 'profile',
    action: 'Restore or select the intended Web profile manually before launching DSH.',
  });
  const profilePackagePath = path.join(config.profileRoot, 'package.json');
  const lockfilePath = path.join(config.profileRoot, 'pnpm-lock.yaml');
  const patchPath = path.join(config.profileRoot, 'cordis.patch.yml');
  const profilePackage = readJson(profilePackagePath, {
    scope: 'profile_package',
    action: 'Inspect and restore the intended Web profile package manifest manually before launching DSH.',
  });
  const lock = readYaml(lockfilePath, config, {
    scope: 'profile_lockfile',
    action: 'Inspect and restore the approved Web profile lockfile manually before launching DSH.',
  });
  requireRegularFile(patchPath, {
    scope: 'profile_patch',
    action: 'Inspect and restore the Web profile patch manually before launching DSH.',
  });
  return {
    profilePackage,
    lock,
    paths: { profilePackagePath, lockfilePath, patchPath },
    hashes: {
      packageSha256: hashFile(profilePackagePath, 'sha256'),
      lockSha256: hashFile(lockfilePath, 'sha256'),
      patchSha256: hashFile(patchPath, 'sha256'),
    },
  };
}

function verifyPackage(config, profile, definition) {
  const { name, directory, sourceRoot } = definition;
  requireDirectory(directory, {
    scope: 'package_root',
    packageName: name,
    action: 'Inspect and restore the intended live package directory manually before launching DSH.',
  });
  const packageReal = fs.realpathSync(directory);
  const manifestPath = path.join(directory, 'package.json');
  const manifest = readJson(manifestPath, {
    scope: 'package_manifest',
    packageName: name,
    action: 'Inspect and restore the package manifest manually before launching DSH.',
  });
  if (manifest.name !== name) {
    fail({
      scope: 'package_manifest',
      packageName: name,
      file: manifestPath,
      expected: name,
      actual: manifest.name,
      action: 'Inspect the selected live package directory and manifest manually before launching DSH.',
    });
  }

  const targets = {
    main: typeof manifest.main === 'string' && manifest.main.length > 0 ? manifest.main : null,
    root: exportTarget(manifest.exports?.['.']),
    client: exportTarget(manifest.exports?.['./client']),
  };
  for (const [entryName, target] of Object.entries(targets)) {
    if (!target) {
      fail({
        scope: 'package_entry',
        packageName: name,
        file: manifestPath,
        expected: entryName === 'main' ? 'non-empty package main' : `resolvable exports[${JSON.stringify(entryName === 'root' ? '.' : './client')}]`,
        actual: entryName === 'main' ? manifest.main : manifest.exports?.[entryName === 'root' ? '.' : './client'],
        action: 'Inspect and correct the package manifest manually, then rebuild the package manually if appropriate.',
      });
    }
  }

  const files = Object.fromEntries(Object.entries(targets).map(([entryName, target]) => [entryName, path.resolve(directory, target)]));
  for (const [entryName, file] of Object.entries(files)) {
    requireRegularFile(file, {
      scope: 'package_entry',
      packageName: name,
      action: `Inspect the ${entryName} artifact and rebuild this package manually if the source is authoritative.`,
    });
  }

  const link = path.join(config.profileRoot, 'node_modules', name);
  let linkStat;
  try {
    linkStat = fs.lstatSync(link);
  } catch (error) {
    fail({
      scope: 'profile_symlink',
      packageName: name,
      file: link,
      expected: `symlink resolving to ${packageReal}`,
      actual: error.code || error.message,
      action: 'Inspect the profile dependency link and repair it manually; preflight will not change symlinks.',
    });
  }
  if (!linkStat.isSymbolicLink()) {
    fail({
      scope: 'profile_symlink',
      packageName: name,
      file: link,
      expected: `symlink resolving to ${packageReal}`,
      actual: 'not a symlink',
      action: 'Inspect the profile dependency and recreate the intended symlink manually.',
    });
  }
  let linkedReal;
  try {
    linkedReal = fs.realpathSync(link);
  } catch (error) {
    fail({
      scope: 'profile_symlink',
      packageName: name,
      file: link,
      expected: packageReal,
      actual: error.code || error.message,
      action: 'Inspect the broken profile dependency link and repair it manually.',
    });
  }
  if (linkedReal !== packageReal) {
    fail({
      scope: 'profile_symlink',
      packageName: name,
      file: link,
      expected: packageReal,
      actual: linkedReal,
      action: 'Point this profile symlink at the intended live package manually; preflight will not repair it.',
    });
  }

  const expectedDependency = `link:${path.relative(config.profileRoot, directory).split(path.sep).join('/')}`;
  const actualDependency = profile.profilePackage.dependencies?.[name];
  if (actualDependency !== expectedDependency) {
    fail({
      scope: 'profile_dependency',
      packageName: name,
      file: profile.paths.profilePackagePath,
      expected: expectedDependency,
      actual: actualDependency,
      action: 'Inspect the Web profile dependency declaration and correct the intended link path manually.',
    });
  }

  const lockDependency = profile.lock.importers?.['.']?.dependencies?.[name];
  for (const field of ['specifier', 'version']) {
    if (lockDependency?.[field] !== expectedDependency) {
      fail({
        scope: 'profile_lock_link',
        packageName: name,
        file: profile.paths.lockfilePath,
        expected: `${field}=${expectedDependency}`,
        actual: `${field}=${fieldValue(lockDependency?.[field])}`,
        action: 'Inspect the approved lockfile and profile link declaration manually; preflight will not update the lockfile.',
      });
    }
  }

  const profileRequire = createRequire(profile.paths.profilePackagePath);
  const resolutions = [
    { specifier: name, expected: files.root, label: 'host entry' },
    { specifier: `${name}/client`, expected: files.client, label: 'client entry' },
    { specifier: `${name}/package.json`, expected: manifestPath, label: 'package manifest' },
  ];
  const resolved = {};
  for (const resolution of resolutions) {
    let actual;
    try {
      actual = profileRequire.resolve(resolution.specifier);
    } catch (error) {
      fail({
        scope: 'package_resolution',
        packageName: name,
        file: profile.paths.profilePackagePath,
        expected: `${resolution.label} -> ${resolution.expected}`,
        actual: error.code || error.message,
        action: 'Inspect the package exports and profile symlink manually; do not install dependencies from preflight.',
      });
    }
    const actualReal = fs.realpathSync(actual);
    const expectedReal = fs.realpathSync(resolution.expected);
    if (actualReal !== expectedReal) {
      fail({
        scope: 'package_resolution',
        packageName: name,
        file: actual,
        expected: expectedReal,
        actual: actualReal,
        action: 'Inspect the profile resolution and remove or relink any stale package copy manually.',
      });
    }
    resolved[resolution.label] = actualReal;
  }

  const profileNodeModulesReal = fs.realpathSync(path.join(config.profileRoot, 'node_modules'));
  if (isInside(resolved['client entry'], profileNodeModulesReal)) {
    fail({
      scope: 'client_copy',
      packageName: name,
      file: resolved['client entry'],
      expected: `client artifact under live package ${packageReal}`,
      actual: 'resolved inside profile node_modules instead of the external live package',
      action: 'Inspect and remove or relink the stale node_modules package copy manually.',
    });
  }

  const outputStats = Object.values(files).map((file) => ({ file, stat: fs.statSync(file) }));
  const oldestOutput = outputStats.reduce((oldest, current) => current.stat.mtimeMs < oldest.stat.mtimeMs ? current : oldest);
  const manifestMtime = fs.statSync(manifestPath).mtimeMs;
  if (manifestMtime > oldestOutput.stat.mtimeMs + 1) {
    fail({
      scope: 'build_freshness',
      packageName: name,
      file: manifestPath,
      expected: `mtime <= oldest output ${oldestOutput.file} (${oldestOutput.stat.mtime.toISOString()})`,
      actual: fs.statSync(manifestPath).mtime.toISOString(),
      action: 'Review the manifest change and rebuild this package manually if that change belongs in the generated output.',
    });
  }

  let sourceNewest = null;
  if (sourceRoot) {
    sourceNewest = newestSource(path.join(directory, sourceRoot), name);
    if (sourceNewest.mtimeMs > oldestOutput.stat.mtimeMs + 1) {
      fail({
        scope: 'build_freshness',
        packageName: name,
        file: sourceNewest.file,
        expected: `mtime <= oldest output ${oldestOutput.file} (${oldestOutput.stat.mtime.toISOString()})`,
        actual: new Date(sourceNewest.mtimeMs).toISOString(),
        action: 'Review the source change and rebuild this package manually before launching DSH.',
      });
    }
  }

  const revision = computeClientRevision(files.client);
  return {
    name,
    hostEntry: resolved['host entry'],
    clientEntry: resolved['client entry'],
    revision,
    freshness: sourceRoot ? 'manifest+source<=output' : 'manifest<=output(no-separate-source-root)',
    resolvedTarget: packageReal,
  };
}

function verifyPinnedDependencies(config, profile) {
  const results = [];
  const importerDependencies = profile.lock.importers?.['.']?.dependencies || {};
  const patchedDependencies = profile.lock.patchedDependencies || {};
  const lockPackages = profile.lock.packages || {};
  for (const [name, pin] of Object.entries(config.approved.locks)) {
    const manifestSpecifier = profile.profilePackage.dependencies?.[name];
    if (manifestSpecifier !== pin.specifier) {
      fail({
        scope: 'pinned_dependency',
        packageName: name,
        file: profile.paths.profilePackagePath,
        expected: pin.specifier,
        actual: manifestSpecifier,
        action: 'Inspect the approved profile dependency pin manually; preflight will not change package.json.',
      });
    }
    const importer = importerDependencies[name];
    if (importer?.specifier !== pin.specifier || importer?.version !== pin.importerVersion) {
      fail({
        scope: 'lock_pin',
        packageName: name,
        file: profile.paths.lockfilePath,
        expected: `specifier=${pin.specifier}; version=${pin.importerVersion}`,
        actual: `specifier=${fieldValue(importer?.specifier)}; version=${fieldValue(importer?.version)}`,
        action: 'Inspect and restore the approved lock entry manually; preflight will not update the lockfile.',
      });
    }
    const patchKey = `${name}@${pin.version}`;
    if (patchedDependencies[patchKey] !== pin.patchHash) {
      fail({
        scope: 'lock_patch_hash',
        packageName: name,
        file: profile.paths.lockfilePath,
        expected: `${patchKey}=${pin.patchHash}`,
        actual: `${patchKey}=${fieldValue(patchedDependencies[patchKey])}`,
        action: 'Inspect the approved patch and lockfile manually; preflight will not regenerate either file.',
      });
    }
    if (!Object.prototype.hasOwnProperty.call(lockPackages, pin.packageKey)) {
      fail({
        scope: 'lock_commit',
        packageName: name,
        file: profile.paths.lockfilePath,
        expected: `packages entry ${pin.packageKey}`,
        actual: 'missing',
        action: 'Inspect and restore the approved locked package entry manually; preflight will not update the lockfile.',
      });
    }
    if (pin.commit && !pin.packageKey.includes(pin.commit)) {
      fail({
        scope: 'lock_commit',
        packageName: name,
        file: profile.paths.lockfilePath,
        expected: pin.commit,
        actual: pin.packageKey,
        action: 'Correct the approved preflight pin manually only after reviewing the intended locked commit.',
      });
    }
    const patchFile = path.join(config.profileRoot, 'patches', pin.patchFile);
    requireRegularFile(patchFile, {
      scope: 'patch_file',
      packageName: name,
      action: 'Inspect and restore the approved patch file manually before launching DSH.',
    });
    const actualPatchHash = hashFile(patchFile, 'sha256');
    if (actualPatchHash !== pin.patchHash) {
      fail({
        scope: 'patch_file_hash',
        packageName: name,
        file: patchFile,
        expected: pin.patchHash,
        actual: actualPatchHash,
        action: 'Review the patch drift and restore the approved patch manually; preflight will not overwrite it.',
      });
    }
    results.push({ name, specifier: pin.specifier, version: pin.importerVersion, patchHash: pin.patchHash, ...(pin.commit ? { commit: pin.commit } : {}) });
  }
  return results;
}

function runPreflight(overrides = {}) {
  const started = process.hrtime.bigint();
  const config = createDefaultConfig(overrides);
  const core = verifyCore(config);
  const profile = verifyProfile(config);
  const packages = config.packageDefinitions.map((definition) => verifyPackage(config, profile, definition));
  const pins = verifyPinnedDependencies(config, profile);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  return { config, core, profile, packages, pins, elapsedMs };
}

function printResult(result, output = process.stdout) {
  output.write(`${structuredLine('DSH_PREFLIGHT_CORE', {
    dsh_version: result.core.dshVersion,
    runtime_sha256: result.core.runtimeSha256,
    profile: result.config.profileRoot,
    profile_package_sha256: result.profile.hashes.packageSha256,
    lockfile_sha256: result.profile.hashes.lockSha256,
    patch_sha256: result.profile.hashes.patchSha256,
    workspace: result.core.workspaceReal,
  })}\n`);
  for (const packageResult of result.packages) {
    output.write(`${structuredLine('DSH_PREFLIGHT_PACKAGE', {
      package: packageResult.name,
      host_entry: packageResult.hostEntry,
      client_entry: packageResult.clientEntry,
      revision: packageResult.revision,
      freshness: packageResult.freshness,
      resolved_target: packageResult.resolvedTarget,
    })}\n`);
  }
  for (const pin of result.pins) {
    output.write(`${structuredLine('DSH_PREFLIGHT_LOCK', pin)}\n`);
  }
  output.write(`${structuredLine('DSH_PREFLIGHT', {
    status: 'passed',
    packages: result.packages.length,
    elapsed_ms: result.elapsedMs.toFixed(3),
    readonly: true,
  })}\n`);
}

function printError(error, output = process.stderr) {
  if (error instanceof PreflightError) {
    output.write(`${structuredLine('DSH_PREFLIGHT_ERROR', error.fields)}\n`);
  } else {
    output.write(`${structuredLine('DSH_PREFLIGHT_ERROR', {
      scope: 'unexpected',
      file: __filename,
      expected: 'successful read-only validation',
      actual: error?.stack || error?.message || String(error),
      action: 'Inspect the unexpected preflight error manually; no repair was attempted.',
    })}\n`);
  }
}

if (require.main === module) {
  try {
    if (process.env.DSH_VERIFY_ACCEPTED_BASELINE === '1') {
      const { verify } = require('./accepted-baseline.js');
      if (!verify()) {
        throw new PreflightError({
          scope: 'accepted_baseline',
          file: path.join(__dirname, 'accepted-baseline.js'),
          expected: 'current code matches the explicitly accepted content snapshot',
          actual: 'added, modified, or deleted tracked files',
          action: 'Review `node fairy-system/accepted-baseline.js --diff`; do not update the baseline merely to launch DSH.',
        });
      }
    }
    printResult(runPreflight());
  } catch (error) {
    printError(error);
    process.exitCode = 1;
  }
}

module.exports = {
  APPROVED,
  PreflightError,
  computeClientRevision,
  createDefaultConfig,
  printError,
  printResult,
  runPreflight,
};
