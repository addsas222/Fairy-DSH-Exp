import assert from 'node:assert/strict';
import { chmodSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

// `URL.pathname` keeps a leading slash (`/C:/...`), which spawns as `C:\C:\...`.
const script = fileURLToPath(new URL('../accepted-baseline.js', import.meta.url));

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-accepted-baseline-test-'));
  const source = join(root, 'source');
  const baselines = join(root, 'baselines');
  mkdirSync(join(source, 'fairy-system'), { recursive: true });
  const file = join(source, 'fairy-system', 'probe.js');
  writeFileSync(file, 'export const value = 1;\n');
  const env = { ...process.env, DSH_ACCEPTED_SOURCE_ROOT: source, DSH_ACCEPTED_BASELINE_ROOT: baselines };
  const run = (...args) => spawnSync(process.execPath, [script, ...args], { env, encoding: 'utf8' });
  return { root, source, baselines, file, run };
}

function cleanup(root) {
  const unlock = (target) => {
    const stat = lstatSync(target);
    if (!stat.isDirectory()) return;
    chmodSync(target, 0o700);
    for (const name of readdirSync(target)) unlock(join(target, name));
  };
  unlock(root);
  rmSync(root, { recursive: true, force: true });
}

test('detects a content replacement even when mtime and byte length are preserved', () => {
  const context = fixture();
  try {
    const accepted = context.run('--accept', '--reason', 'test accepted state');
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.equal(context.run().status, 0);

    const originalStat = statSync(context.file);
    writeFileSync(context.file, 'export const value = 2;\n');
    utimesSync(context.file, originalStat.atime, originalStat.mtime);
    const result = context.run('--diff');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /MODIFIED fairy-system\/probe\.js/);
    assert.match(result.stdout, /-export const value = 1;/);
    assert.match(result.stdout, /\+export const value = 2;/);
  } finally {
    cleanup(context.root);
  }
});

test('reports added and deleted tracked files against the immutable snapshot', () => {
  const context = fixture();
  try {
    assert.equal(context.run('--accept', '--reason', 'test accepted state').status, 0);
    rmSync(context.file);
    writeFileSync(join(context.source, 'fairy-system', 'new.yml'), 'enabled: true\n');
    const result = context.run();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /DELETED fairy-system\/probe\.js/);
    assert.match(result.stderr, /ADDED fairy-system\/new\.yml/);

    const pointer = readFileSync(join(context.baselines, 'CURRENT'), 'utf8').trim();
    assert.match(pointer, /^[0-9TZ-]+-[0-9a-f]{12}$/);
  } finally {
    cleanup(context.root);
  }
});
