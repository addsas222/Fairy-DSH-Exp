#!/usr/bin/env node
'use strict';

// Read-only candidate upgrade gate. It deliberately accepts an explicit
// profile/runtime pair and never installs, rewrites, or launches either one.
const crypto = require('node:crypto');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

// 包名与来源区域只有一份声明：verify-build.js 的 packages 表（其 dir 的末两级即
// <home>/<area>/<name>）。候选闸只拿这两个标签在 profile 的 node_modules 里核对符号链接，
// 落位根由 --profile 决定，所以这里不需要契约表里的 home。
const { packages: BUILD_PACKAGES } = require('./verify-build.js');
const LOCAL_PACKAGES = BUILD_PACKAGES.map(({ name, dir }) => [name, path.basename(path.dirname(dir))]);

// Same knobs as preflight-build.js: the validation chain runs against an
// isolated home and a candidate runtime, never the developer's live install.
const DEFAULT_PROFILE = path.resolve(process.env.DSH_PROFILE_ROOT || path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'profiles', 'web'));
const DEFAULT_RUNTIME = path.resolve(process.env.DSH_OFFICIAL_RUNTIME
  || path.join(os.homedir(), '.local', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-client-runtime', 'lib', 'client.js'));
const VISUAL_SETTINGS_VERSION = '0.1.1-rc.2';
const REASONING_VERSION = '0.6.2';
const REASONING_SOURCE = 'github:HanaAyane/dsh-reasoning-effort#83bc8c548749d7156a03d11d875d8117e9b5d994';
const REASONING_LOCK_SOURCE = 'https://codeload.github.com/HanaAyane/dsh-reasoning-effort/tar.gz/83bc8c548749d7156a03d11d875d8117e9b5d994';
const REASONING_PATCH_HASH = '9cbcceae243982ca0241cd41471317da9112c3e61e345b3b32f205d90aec18b5';
const MESSAGE_EDIT_VERSION = '0.2.3';
const MESSAGE_EDIT_PATCH_HASH = '2ff69549d829fc326b1f34b2d2d869e5680e784bcbc45304ff431776bfc29c6c';
const CAPABILITY_MATRIX_PATH = process.env.DSH_CAPABILITY_MATRIX
  || path.join(os.homedir(), '.dsh', 'fairy-system', 'capability-matrix.json');

function fail(message) {
  throw new Error(`DSH upgrade preflight failed: ${message}`);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function read(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    fail(`cannot read ${file}: ${error.code || error.message}`);
  }
}

function readJson(file) {
  try {
    return JSON.parse(read(file));
  } catch (error) {
    fail(`invalid JSON ${file}: ${error.message}`);
  }
}

function realpath(file, label) {
  try {
    return fs.realpathSync(file);
  } catch (error) {
    fail(`${label} cannot be resolved: ${file} (${error.code || error.message})`);
  }
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--allow-current' || arg === '--report') {
      values.allowCurrent = true;
      if (arg === '--report') values.report = true;
      continue;
    }
    if (!arg.startsWith('--')) fail(`unknown argument ${arg}`);
    const key = arg.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) fail(`${arg} requires a value`);
    values[key.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase())] = value;
    index += 1;
  }
  return values;
}

function count(source, token) {
  return source.split(token).length - 1;
}

function loadOfficialSelectors(adapterSource, adapterFile) {
  const module = { exports: {} };
  const adapterRequire = createRequire(adapterFile);
  try {
    vm.runInNewContext(adapterSource, { module, exports: module.exports, require: adapterRequire }, { filename: 'dom-adapter.js' });
  } catch (error) {
    fail(`cannot evaluate Visual DOM adapter: ${error.message}`);
  }
  const selectors = module.exports?.OFFICIAL_SELECTORS;
  assert(selectors && typeof selectors === 'object', 'Visual DOM adapter does not export OFFICIAL_SELECTORS');
  return selectors;
}

function resolvePackage(fromDir, name, label) {
  let manifestPath;
  try {
    manifestPath = createRequire(path.join(fromDir, 'package.json')).resolve(`${name}/package.json`);
  } catch (error) {
    fail(`${label} cannot be resolved from ${fromDir}: ${error.code || error.message}`);
  }
  return { path: realpath(manifestPath, label), manifest: readJson(manifestPath) };
}

function verifyPackage(profileRoot, name, area) {
  const link = path.join(profileRoot, 'node_modules', name);
  assert(fs.existsSync(link) && fs.lstatSync(link).isSymbolicLink(), `${name} profile dependency is not a symlink`);
  const sourceRoot = realpath(link, `${name} profile dependency`);
  assert(path.basename(path.dirname(sourceRoot)) === area && path.basename(sourceRoot) === name,
    `${name} profile dependency points outside its expected source package`);
  const manifest = readJson(path.join(sourceRoot, 'package.json'));
  assert(manifest.name === name, `${name} package identity drifted`);
  const expectsClient = Boolean(manifest.exports?.['./client']);
  const targets = [manifest.main, manifest.exports?.['.'], ...(expectsClient ? [manifest.exports['./client']] : [])];
  assert(targets.every((target) => typeof target === 'string' && fs.statSync(path.resolve(sourceRoot, target)).isFile()), `${name} main/exports bundle is incomplete`);
  if (expectsClient) assert(manifest.dsh?.client && Array.isArray(manifest.dsh.client.inject), `${name} dsh.client injection contract is missing`);
  const clientFile = expectsClient ? path.resolve(sourceRoot, manifest.exports['./client']) : null;
  return { name, sourceRoot, manifest, server: read(path.resolve(sourceRoot, manifest.main)), client: clientFile ? read(clientFile) : null };
}

function verifyRuntime(runtimeFile, expectedVersion, expectedHash) {
  assert(fs.existsSync(runtimeFile) && fs.statSync(runtimeFile).isFile(), `runtime file is missing: ${runtimeFile}`);
  const runtime = read(runtimeFile);
  const hash = crypto.createHash('sha256').update(runtime).digest('hex');
  assert(hash === expectedHash, `runtime SHA-256 mismatch (${hash}); candidate was not approved`);
  const runtimePackage = readJson(path.join(path.dirname(path.dirname(runtimeFile)), 'package.json'));
  assert(runtimePackage.version === expectedVersion, `runtime version ${runtimePackage.version} does not match expected ${expectedVersion}`);
  // These are the stable browser loader behaviors consumed by every client
  // module. Their implementation stays official and is never patched here.
  assert(runtime.includes('window.__ModuleLoader__.load({'), 'Browser ModuleLoader entrypoint is missing');
  assert(runtime.includes('factory: (require) =>'), 'Browser ModuleLoader factory contract is missing');
  assert(runtime.includes('ctx.effect') && runtime.includes('slots.inject'), 'ClientModuleRegistry lifecycle behavior is missing');
  return { runtime, hash, version: runtimePackage.version };
}

function verifyCapabilityMatrix(matrix, expectedVersion, expectedHash, profileRoot, packages, patch) {
  assert(matrix.schemaVersion === 1, 'capability matrix schema version is unsupported');
  assert(matrix.dshVersion === expectedVersion, `capability matrix targets ${matrix.dshVersion}; expected ${expectedVersion}`);
  assert(matrix.officialRuntimeSha256 === expectedHash, 'capability matrix official runtime hash does not match the approved candidate');
  const visual = packages.find((item) => item.name === 'dsh-fairy-visual');
  const visualAdapterFile = path.join(visual.sourceRoot, 'src', 'client', 'dom-adapter.js');
  const visualAdapter = read(visualAdapterFile);
  const visualClient = `${visual.server}\n${visual.client}`;
  const reasoningPackage = resolvePackage(profileRoot, 'dsh-reasoning-effort', 'reasoning-effort capability package');
  const messageEditPackage = resolvePackage(profileRoot, 'dsh-message-edit', 'message-edit capability package');
  const conversationPackage = resolvePackage(profileRoot, '@deepseek-ai/dsh-client-ui-conversation', 'conversation capability package');
  const reasoningClient = read(path.join(reasoningPackage.path, '..', 'lib', 'client', 'index.js'));
  const messageEditClient = read(path.join(messageEditPackage.path, '..', 'client.js'));
  const conversationClient = read(path.join(conversationPackage.path, '..', 'lib', 'client.js'));
  const allPackageText = `${packages.map((item) => `${item.server}\n${item.client ?? ''}`).join('\n')}\n${reasoningClient}\n${messageEditClient}\n${patch}`;

  const officialSelectors = loadOfficialSelectors(visualAdapter, visualAdapterFile);
  for (const [name, selector] of Object.entries(matrix.dom || {})) {
    assert(officialSelectors[name] === selector, `capability matrix DOM selector drifted: ${name}`);
  }
  for (const [name, attribute] of Object.entries(matrix.attributes || {})) {
    assert(visualAdapter.includes(`'${attribute}'`) || visualAdapter.includes(`"${attribute}"`), `capability matrix attribute drifted: ${name}`);
  }
  for (const [owner, slots] of Object.entries(matrix.slots || {})) {
    for (const slot of slots) assert(allPackageText.includes(slot), `capability matrix slot drifted: ${owner}/${slot}`);
  }
  for (const [name, label] of Object.entries(matrix.aria || {})) {
    for (const value of (Array.isArray(label) ? label : [label])) {
      assert(visualAdapter.includes(value) || allPackageText.includes(value), `capability matrix ARIA anchor drifted: ${name}/${value}`);
    }
  }
  for (const [name, contract] of Object.entries(matrix.session || {})) {
    assert(allPackageText.includes(contract), `capability matrix Session contract drifted: ${name}`);
  }
  const projection = matrix.conversationProjection;
  assert(projection?.sessionStore?.interface === 'ChatNodeStore', 'capability matrix Session Store interface drifted');
  assert(projection.sessionStore.implementation === 'MutableChatNodeStore', 'capability matrix Session Store implementation drifted');
  assert(projection.sessionStore.lookup === 'get(key)' && projection.sessionStore.iteration === 'values()',
    'capability matrix Session Store access contract drifted');
  assert(conversationClient.includes('var MutableChatNodeStore = class')
    && conversationClient.includes('get(key)')
    && conversationClient.includes('values()')
    && conversationClient.includes('store = new MutableChatNodeStore()'),
  'official conversation Session Store implementation drifted');
  assert(projection.nodeKinds?.user === 'user' && projection.nodeKinds?.assistant === 'assistant-step',
    'capability matrix conversation node kinds drifted');
  const visualUtils = read(path.join(visual.sourceRoot, 'src', 'client', 'utils.js'));
  assert(projection.visualActivity?.projection === 'deriveSessionActivity'
    && projection.visualActivity.authority === 'session.running+committed-user-message'
    && JSON.stringify(projection.visualActivity.states) === JSON.stringify(['normal', 'thinking', 'comforting'])
    && JSON.stringify(projection.visualActivity.precedence) === JSON.stringify(['comforting', 'thinking', 'normal']),
  'capability matrix Visual activity projection drifted');
  for (const state of projection.visualActivity.states) {
    assert(visualUtils.includes(`'${state}'`), `Visual activity state is missing: ${state}`);
  }
  assert(visualUtils.includes("if (deriveSessionComfort(snapshot)) return 'comforting'")
    && visualUtils.includes("snapshot?.running === true ? 'thinking' : 'normal'"),
  'Visual activity precedence or Session running authority drifted');
  for (const [name, contract] of Object.entries(matrix.workspace || {})) {
    assert(allPackageText.includes(contract), `capability matrix Workspace contract drifted: ${name}`);
  }
  const svgSource = [
    'visual-transitions.js',
    'surface-utils.js',
    'composer-material-layer.js',
  ].map((file) => read(path.join(visual.sourceRoot, 'src', 'client', file))).join('\n');
  for (const token of matrix.svg?.requiredTokens || []) {
    assert(svgSource.includes(token), `capability matrix SVG contract drifted: ${token}`);
  }
  const visualSettings = matrix.officialDependencies?.['@deepseek-ai/dsh-settings'];
  assert(visualSettings === VISUAL_SETTINGS_VERSION, 'capability matrix settings dependency is not the reviewed version');
  assert(visual.manifest.dependencies?.['@deepseek-ai/dsh-settings'] === visualSettings, 'Visual settings dependency is not aligned with capability matrix');
  assert(profileRoot && fs.existsSync(profileRoot), 'candidate profile root is missing while checking capability matrix');
  return {
    matrixId: matrix.matrixId,
    version: matrix.dshVersion,
    domCount: Object.keys(matrix.dom || {}).length,
    slotCount: Object.values(matrix.slots || {}).flat().length,
    evidenceCases: matrix.browserEvidence?.requiredCases?.length || 0,
    svgTokens: matrix.svg?.requiredTokens?.length || 0,
    sessionStore: projection.sessionStore.implementation,
    nodeKinds: Object.values(projection.nodeKinds),
    activityStates: projection.visualActivity.states,
  };
}

function verifyProfileContracts(profileRoot, packages, matrix) {
  const profilePackage = readJson(path.join(profileRoot, 'package.json'));
  const patchFile = path.join(profileRoot, 'cordis.patch.yml');
  const patch = read(patchFile);
  const capability = verifyCapabilityMatrix(matrix, matrix.dshVersion, matrix.officialRuntimeSha256, profileRoot, packages, patch);
  for (const { name, sourceRoot, manifest, client } of packages) {
    const declared = profilePackage.dependencies?.[name];
    assert(typeof declared === 'string' && declared.startsWith('link:'), `${name} profile dependency is not a local link`);
    const declaredTarget = declared.slice('link:'.length);
    const declaredPath = path.isAbsolute(declaredTarget) ? declaredTarget : path.resolve(profileRoot, declaredTarget);
    assert(realpath(declaredPath, `${name} declared profile dependency`) === sourceRoot, `${name} profile dependency does not match its linked source`);
    if (client) {
      assert(client.includes('window.__ModuleLoader__.load({') && client.includes('factory:'), `${name} client is not a Browser ModuleLoader module`);
      assert(Object.prototype.hasOwnProperty.call(manifest.exports, './client'), `${name} exports["./client"] is missing`);
    }
  }

  const positions = ['balance-meter', 'fairy-startup', 'fairy-voice', 'fairy-visual'].map((id) => patch.indexOf(`id: ${id}`));
  assert(positions.every((position) => position >= 0), 'profile inject declarations are incomplete');
  assert(positions.every((position, index) => index === 0 || position > positions[index - 1]), 'profile inject order drifted');

  // The Ponytail-era packages must stay wired into the web profile.
  for (const id of ['fairy-persona', 'fairy-modes-bridge', 'fairy-search', 'fairy-memory', 'fairy-roleplay']) {
    assert(patch.includes(`id: ${id}`), `profile inject declaration is missing: ${id}`);
  }

  const balance = packages.find((item) => item.name === 'dsh-balance-meter');
  const startup = packages.find((item) => item.name === 'dsh-fairy-startup');
  const visual = packages.find((item) => item.name === 'dsh-fairy-visual');
  const voice = packages.find((item) => item.name === 'dsh-fairy-voice');
  const visualAdapter = read(path.join(visual.sourceRoot, 'src', 'client', 'dom-adapter.js'));
  const visualStyle = read(path.join(visual.sourceRoot, 'src', 'client', 'style.js'));
  const visualUtils = read(path.join(visual.sourceRoot, 'src', 'client', 'utils.js'));
  const visualHost = read(path.join(visual.sourceRoot, 'src', 'index.js'));

  assert(balance.client.includes('sidebar.footer.action'), 'balance slot contract is missing');
  assert(startup.client.includes('sessions.clear()') && startup.client.includes('workspaces.startSession()'), 'session/workspace API contract is missing');
  assert(voice.client.includes('conversation.chat.assistant-actions') && voice.client.includes('conversation.input.left') && voice.client.includes('settings.section'), 'voice slot contract is missing');
  assert(visual.client.includes('settings.section') && visual.client.includes('conversation.composer.dock'), 'visual slot contract is missing');
  for (const marker of ['data-slot', 'data-composer-card', 'data-input-scroll', 'data-dsh-fairy-composer-dock', 'data-dsh-fairy-visual']) {
    assert(visualAdapter.includes(marker) || visual.client.includes(marker), `DOM marker contract is missing: ${marker}`);
  }
  for (const label of ['打开侧边栏', 'Open sidebar', '收起侧边栏', 'Collapse sidebar', '新建会话', 'New session', '发送消息', 'Send message', '选择模型', 'Select model', 'Fairy 朗读控制']) {
    assert(visualAdapter.includes(label), `ARIA label contract is missing: ${label}`);
  }
  assert(visualStyle.includes('data-plugin') && visualStyle.includes('data-dsh-fairy-theme'), 'theme/style ownership contract is missing');
  assert(visualUtils.includes('removeAttribute(MODE_ATTR)'), 'normal-mode cleanup contract is missing');
  assert(startup.client.includes('STARTUP_RESET_ATTR') && count(startup.client, 'sessions.clear()') === 1 && count(startup.client, 'workspaces.startSession()') === 1, 'startup duplicate guard contract is missing');

  assert(visual.manifest.dependencies?.['@deepseek-ai/dsh-settings'] === VISUAL_SETTINGS_VERSION,
    `visual settings declaration must remain exactly ${VISUAL_SETTINGS_VERSION}`);
  const settings = resolvePackage(visual.sourceRoot, '@deepseek-ai/dsh-settings', 'visual settings package');
  assert(settings.manifest.version === VISUAL_SETTINGS_VERSION,
    `visual settings resolves to ${settings.manifest.version}; expected ${VISUAL_SETTINGS_VERSION}`);
  assert(visualHost.includes("import { settingsNamespace } from '@deepseek-ai/dsh-settings'")
    && visualHost.includes('settingsCtx.settings.register'), 'visual host settings registration contract is missing');
  assert(!visual.client.includes('@deepseek-ai/dsh-settings') && visual.client.includes('ctx.settingsScope.bind'),
    'visual client crossed the server-only settings package boundary');
  for (const selector of ['[data-slot="sidebar"]', '[data-slot="conversation"]', '[data-composer-seat]', '[data-composer-card="true"]', '[data-conversation-scroll]', '[data-input-scroll]']) {
    assert(visualAdapter.includes(selector), `DOM adapter selector contract is missing: ${selector}`);
  }
  for (const slot of ['shell.overlay', 'conversation.session.header.utilities', 'settings.section']) {
    assert(visual.client.includes(slot), `visual slot contract is missing: ${slot}`);
  }

  const reasoning = profilePackage.dependencies?.['dsh-reasoning-effort'];
  assert(reasoning === REASONING_SOURCE, 'reasoning plugin declaration drifted from its reviewed source');
  assert(profilePackage.dsh?.profile?.bundles?.includes('dsh-reasoning-effort'), 'reasoning plugin is absent from profile bundles');
  assert(visualAdapter.includes('modelSelection') && visualAdapter.includes('reasoningControl'), 'model/reasoning adapter capabilities are missing');

  const lock = read(path.join(profileRoot, 'pnpm-lock.yaml'));
  assert(lock.includes(`${REASONING_LOCK_SOURCE}(patch_hash=${REASONING_PATCH_HASH})`),
    'reasoning-effort lock source or local patch drifted; review the branch resolution before upgrade');
  assert(lock.includes(`dsh-message-edit@${MESSAGE_EDIT_VERSION}(patch_hash=${MESSAGE_EDIT_PATCH_HASH})`),
    'message-edit lock patch drifted; review its bundled client API before upgrade');
  const reasoningPackage = resolvePackage(profileRoot, 'dsh-reasoning-effort', 'reasoning-effort package');
  const messageEditPackage = resolvePackage(profileRoot, 'dsh-message-edit', 'message-edit package');
  assert(reasoningPackage.manifest.version === REASONING_VERSION, `reasoning-effort version ${reasoningPackage.manifest.version} is not reviewed`);
  assert(messageEditPackage.manifest.version === MESSAGE_EDIT_VERSION, `message-edit version ${messageEditPackage.manifest.version} is not reviewed`);
  assert(JSON.stringify(reasoningPackage.manifest.peerDependencies) === JSON.stringify({
    react: '^18.2.0',
    '@deepseek-ai/cordis': '^4.0.1',
    '@deepseek-ai/dsh-client-runtime': '^0.1.0-rc.6',
    '@deepseek-ai/dsh-client-connection': '^0.1.0-rc.6',
    '@deepseek-ai/dsh-client-ui-conversation': '^0.1.0-rc.6',
    '@deepseek-ai/dsh-client-ui-model-selection': '^0.1.0-rc.6',
    '@deepseek-ai/dsh-client-ui-settings': '^0.1.0-rc.6',
    '@deepseek-ai/dsh-client-ui-slots': '^0.1.0-rc.6',
    '@deepseek-ai/dsh-api-remotes': '^0.1.0-rc.6',
  }), 'reasoning-effort peer API range drifted');
  assert(!messageEditPackage.manifest.peerDependencies, 'message-edit unexpectedly changed its implicit peer API boundary');
  const reasoningClient = read(path.join(reasoningPackage.path, '..', 'lib', 'client', 'index.js'));
  const messageEditClient = read(path.join(messageEditPackage.path, '..', 'client.js'));
  assert(reasoningClient.includes('window.__ModuleLoader__.load({') && reasoningClient.includes('conversation.input.model') && reasoningClient.includes('settings.general.item'),
    'reasoning-effort client boot or slot API drifted');
  assert(messageEditClient.includes('window.__ModuleLoader__.load({') && messageEditClient.includes('conversation.view') && messageEditClient.includes('conversation.session.header.actions'),
    'message-edit client boot or slot API drifted');

  return {
    messageEditVersion: messageEditPackage.manifest.version,
    reasoningVersion: reasoningPackage.manifest.version,
    settingsVersion: settings.manifest.version,
    capability,
  };
}

function reportMatrix(scope, runtime, compatibility) {
  process.stdout.write([
    `DSH upgrade compatibility matrix (${scope})`,
    `- official browser runtime: ${runtime.version} sha256 ${runtime.hash}`,
    `- capability matrix: ${compatibility.capability.matrixId}; ${compatibility.capability.domCount} DOM anchors; ${compatibility.capability.slotCount} slots; ${compatibility.capability.evidenceCases} browser evidence cases`,
    `- capability diff: runtime=verified; slots=${compatibility.capability.slotCount}/${compatibility.capability.slotCount}; DOM=${compatibility.capability.domCount}/${compatibility.capability.domCount}; ARIA=verified; session/workspace=verified; SVG=${compatibility.capability.svgTokens}/${compatibility.capability.svgTokens}`,
    `- conversation projection: ${compatibility.capability.sessionStore}; node kinds ${compatibility.capability.nodeKinds.join('/')}; Visual activity ${compatibility.capability.activityStates.join('/')}`,
    `- Fairy Visual host settings: @deepseek-ai/dsh-settings ${compatibility.settingsVersion}; server registration only`,
    '- Fairy Visual client settings: official settingsScope.bind bridge; no dsh-settings bundle import',
    `- dsh-reasoning-effort: ${compatibility.reasoningVersion}; declaration ${REASONING_SOURCE}; lock ${REASONING_LOCK_SOURCE.slice(-40)}; patched`,
    `- dsh-message-edit: ${compatibility.messageEditVersion}; exact registry declaration; patched; no declared runtime peers`,
    'Upgrade blockers:',
    '- runtime version/SHA, Browser ModuleLoader boot protocol, or client module lifecycle contract changes',
    '- Session Store get/values implementation, user/assistant-step node kinds, session.running Visual activity authority, settings boundary, slots, DOM selectors, or reviewed zh/en ARIA labels change',
    '- reasoning peer ranges, slots, Git lock commit/patch; or message-edit bundled ModuleLoader/slot contract and lock patch change',
    'Known review risks:',
    '- dsh-reasoning-effort declares a moving Git branch; the lockfile commit and patch hash are the effective reproducibility pin.',
    '- dsh-message-edit declares no runtime peerDependencies; its bundled client API is an implicit compatibility boundary.',
    '',
  ].join('\n'));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  // AGENTS.md presents the profile at $DSH_HOME/profiles/web as a link while the
  // packages live beside it. Compare everything through the resolved root, or a
  // `link:../../<area>/<pkg>` declaration can never match the linked source
  // (preflight-build.js canonicalizes its roots for the same reason).
  const profileRoot = realpath(path.resolve(args.profile || DEFAULT_PROFILE), 'profile root');
  const runtimeFile = realpath(path.resolve(args.runtime || DEFAULT_RUNTIME), 'runtime file');
  const capabilityMatrix = readJson(CAPABILITY_MATRIX_PATH);
  if (args.report) {
    const packages = LOCAL_PACKAGES.map(([name, area]) => verifyPackage(profileRoot, name, area));
    const runtimePackage = readJson(path.join(path.dirname(path.dirname(runtimeFile)), 'package.json'));
    const runtimeSource = read(runtimeFile);
    const runtime = {
      version: runtimePackage.version,
      hash: crypto.createHash('sha256').update(runtimeSource).digest('hex'),
    };
    reportMatrix('current report', runtime, verifyProfileContracts(profileRoot, packages, capabilityMatrix));
    return;
  }
  const expectedVersion = args.expectedVersion;
  const expectedHash = args.expectedSha256;
  assert(expectedVersion && expectedHash, 'pass --expected-version and --expected-sha256 for the approved candidate');
  const currentProfile = realpath(DEFAULT_PROFILE, 'current profile');
  const currentRuntime = realpath(DEFAULT_RUNTIME, 'current runtime');
  if (!args.allowCurrent) {
    assert(realpath(profileRoot, 'candidate profile') !== currentProfile, 'refusing to validate the active profile; use an isolated profile');
    assert(realpath(runtimeFile, 'candidate runtime') !== currentRuntime, 'refusing to validate the active runtime; use an isolated runtime');
  }
  const packages = LOCAL_PACKAGES.map(([name, area]) => verifyPackage(profileRoot, name, area));
  const runtime = verifyRuntime(runtimeFile, expectedVersion, expectedHash);
  const compatibility = verifyProfileContracts(profileRoot, packages, capabilityMatrix);
  const scope = args.allowCurrent ? 'baseline' : 'isolated profile';
  reportMatrix(scope, runtime, compatibility);
  process.stdout.write(`DSH upgrade preflight verified (${scope}; runtime ${runtime.version}; sha256 ${runtime.hash})\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
