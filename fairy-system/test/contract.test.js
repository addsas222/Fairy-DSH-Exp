import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import test from 'node:test';

const verify = await readFile(new URL('../verify.js', import.meta.url), 'utf8');
const verifyBuild = await readFile(new URL('../verify-build.js', import.meta.url), 'utf8');
const preflightBuild = await readFile(new URL('../preflight-build.js', import.meta.url), 'utf8');
const acceptedBaseline = await readFile(new URL('../accepted-baseline.js', import.meta.url), 'utf8');
const logTriage = await readFile(new URL('../log-triage.js', import.meta.url), 'utf8');
const check = await readFile(new URL('../check.sh', import.meta.url), 'utf8');
async function optionalFile(relativeUrl) {
  const url = new URL(relativeUrl, import.meta.url);
  try { await access(url); return readFile(url, 'utf8'); } catch { return null; }
}
const launcher = await optionalFile('../../launchers/dsh-web-launcher.sh');
const launcherCompatibilityEntry = await optionalFile('../../../.local/bin/dsh-web-launcher.sh');
const desktopLauncherSource = await optionalFile('../../dsh-web-launcher.m');
const desktopLauncherAppleScript = await optionalFile('../../dsh-web-launcher.applescript');

test('keeps cross-module verification static, deterministic, and runtime-pinned', () => {
  assert.match(verify, /EXPECTED_RUNTIME_SHA256 = '13a5fe0ee8cddda2306d302eb0dbfdd601e96d14baeb512867b4b6d1d72f6679'/);
  assert.match(verify, /assert\(hash === EXPECTED_RUNTIME_SHA256/);
  assert.doesNotMatch(verify, /execFileSync|function runNode/);
  assert.doesNotMatch(verify, /#3b4148|#d9dde1|#343a42|#e1e4e8/);
  assert.match(verify, /dependencies\?\.\['dsh-message-edit'\] === '0\.2\.3'/);
  assert.match(verify, /dependencies\?\.\['mdast-util-from-markdown'\] === '2\.0\.3'/);
});

test('runs every source gate and package suite exactly once', () => {
  assert.match(check, /node --check "\$DSH_ROOT\/fairy-visual\/dsh-fairy-visual\/lib\/client\.js"/);
  assert.match(check, /node --check "\$DSH_ROOT\/browser-dock\/dsh-browser-dock\/proxy\.cjs"/);
  assert.match(check, /node --check "\$DSH_ROOT\/fairy-visual\/dsh-fairy-visual\/src\/client\/index\.js"/);
  assert.match(check, /node "\$ROOT\/verify\.js" --live/);
  assert.match(check, /node "\$ROOT\/preflight-build\.js"/);
  assert.match(check, /node --check "\$ROOT\/upgrade-preflight\.js"/);
  assert.match(check, /node --check "\$ROOT\/accepted-baseline\.js"/);
  assert.match(check, /node "\$ROOT\/accepted-baseline\.js"/);
  assert.match(check, /node --check "\$ROOT\/log-triage\.js"/);
  assert.match(check, /node "\$ROOT\/log-triage\.js" --require-healthy/);
  assert.match(check, /zsh -n "\$DSH_ROOT\/launchers\/dsh-web-launcher\.sh"/);
  assert.match(check, /DSH_UPGRADE_PROFILE/);
  assert.match(check, /DSH_UPGRADE_RUNTIME/);
  assert.match(check, /--expected-version/);
  assert.match(check, /--expected-sha256/);
  assert.match(check, /node --test "\$DSH_ROOT\/fairy-visual\/dsh-fairy-visual\/test"\/\*\.test\.js/);
  assert.match(check, /node --test "\$DSH_ROOT\/browser-dock\/dsh-browser-dock\/test"\/\*\.test\.js/);
  assert.match(check, /node --test "\$ROOT\/test"\/\*\.test\.js/);
  assert.equal((check.match(/fairy-visual\/dsh-fairy-visual\/test/g) || []).length, 1);
  assert.equal((check.match(/balance-meter\/dsh-balance-meter\/test/g) || []).length, 1);
  assert.equal((check.match(/fairy-startup\/dsh-fairy-startup\/test/g) || []).length, 1);
  assert.equal((check.match(/browser-dock\/dsh-browser-dock\/test/g) || []).length, 1);
});

test('triages only an explicit run and treats client cancellation as expected', () => {
  assert.match(logTriage, /DSH_WEB_RUN_BEGIN/);
  assert.match(logTriage, /options\.runId/);
  assert.match(logTriage, /options\.sinceMs/);
  assert.match(logTriage, /\['client-aborted', 'superseded'\]/);
  assert.match(logTriage, /historicalBeforeBoundary/);
  assert.match(logTriage, /--require-healthy/);
});

test('compares code content to an external accepted snapshot without trusting mtime', () => {
  assert.match(acceptedBaseline, /\.dsh-accepted-baselines/);
  assert.match(acceptedBaseline, /crypto\.createHash\('sha256'\)/);
  assert.match(acceptedBaseline, /kind: 'modified'/);
  assert.match(acceptedBaseline, /kind: 'added'/);
  assert.match(acceptedBaseline, /kind: 'deleted'/);
  assert.match(acceptedBaseline, /git', \['--no-pager', 'diff', '--no-index'/);
  assert.match(acceptedBaseline, /--accept requires --reason/);
  assert.match(acceptedBaseline, /accepted snapshot content drifted/);
  assert.doesNotMatch(acceptedBaseline, /mtimeMs/);
});

test('pins bundle/profile, normal-mode, and duplicate-mount contracts', () => {
  assert.match(verify, /function verifyProfileConsistency\(profilePackage\)/);
  assert.match(verify, /assert\(linkedPath === expectedPath/);
  assert.match(verify, /BALANCE_UNAVAILABLE_TEXT/);
  assert.match(verify, /removeAttribute\(MODE_ATTR\)/);
  assert.match(verify, /STARTUP_RESET_ATTR/);
  assert.match(verify, /claimSingleton\(document, 'stage-host'/);
  assert.match(verify, /claimSingleton\(document, 'composer-dock'/);
  assert.match(verify, /content fade must be owned by the stationary conversation viewport/);
  assert.match(verify, /content fade must never chase scrolling content/);
  assert.match(verify, /content fade must never use a blur or painted veil/);
  assert.match(verify, /content fade must remain a pure radial alpha mask/);
});

test('records every package artifact mapping and rejects stale or legacy bundles', () => {
  assert.match(verifyBuild, /sourceRoot: null/);
  assert.match(verifyBuild, /sourceRoot: 'src'/);
  assert.match(verifyBuild, /manifest is newer than its generated outputs/);
  assert.match(verifyBuild, /source is newer than its generated outputs/);
  assert.match(verifyBuild, /forbidden legacy path or injection/);
  assert.match(verify, /function verifyGeneratedArtifactFreshness\(\)/);
  assert.match(verify, /source is newer than its generated outputs/);
  assert.match(verify, /forbidden legacy path or runtime injection/);
  assert.match(preflightBuild, /Review the source change and rebuild this package manually before launching DSH/);
  assert.match(preflightBuild, /Review the manifest change and rebuild this package manually if that change belongs in the generated output/);
  assert.match(preflightBuild, /DSH_VERIFY_ACCEPTED_BASELINE === '1'/);
  assert.match(preflightBuild, /scope: 'accepted_baseline'/);
  if (!launcher) return;
  assert.match(launcher, /DSH_WORKSPACE_ROOT="\$WORKSPACE_ROOT" node "\$PREFLIGHT"/);
  assert.doesNotMatch(launcher, /DSH_VERIFY_ACCEPTED_BASELINE=1/);
});

test('launcher waits for the complete custom plugin boot', () => {
  if (!launcher) return;
  assert.match(launcher, /dsh-browser-dock/);
  assert.match(launcher, /dsh-fairy-visual/);
  assert.match(launcher, /dsh-fairy-startup/);
  assert.match(launcher, /dsh-fairy-voice/);
  assert.match(launcher, /dsh-balance-meter/);
  assert.match(launcher, /--no-open --port "\$PORT"/);
  assert.match(launcher, /kill -0 "\$pid"/);
});

test('keeps launcher logic canonical under .dsh and external entries deploy-only', () => {
  if (!launcherCompatibilityEntry || !desktopLauncherSource || !desktopLauncherAppleScript) return;
  const canonicalPath = process.env.DSH_CANONICAL_LAUNCHER || '<canonical-launcher>';
  assert.match(launcherCompatibilityEntry, new RegExp(canonicalPath.replaceAll('/', '\\/')));
  assert.match(launcherCompatibilityEntry, /exec "\$CANONICAL_LAUNCHER" "\$@"/);
  assert.doesNotMatch(launcherCompatibilityEntry, /is_healthy\(\)|run_preflight\(\)|dsh-fairy-visual/);
  assert.match(desktopLauncherSource, new RegExp(canonicalPath.replaceAll('/', '\\/')));
  assert.match(desktopLauncherAppleScript, new RegExp(canonicalPath.replaceAll('/', '\\/')));
});

test('keeps the DSH upgrade gate isolated and read-only', async () => {
  const upgrade = await readFile(new URL('../upgrade-preflight.js', import.meta.url), 'utf8');
  assert.match(upgrade, /--expected-version/);
  assert.match(upgrade, /--expected-sha256/);
  assert.match(upgrade, /refusing to validate the active profile/);
  assert.equal(upgrade.includes('window.__ModuleLoader__.load'), true);
  assert.match(upgrade, /ClientModuleRegistry lifecycle behavior/);
  assert.doesNotMatch(upgrade, /writeFileSync|copyFileSync|renameSync|execFileSync/);
});
