#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dshRoot = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const packages = [
  {
    dir: path.join(dshRoot, 'browser-dock', 'dsh-browser-dock'),
    name: 'dsh-browser-dock',
    sourceRoot: 'src',
    forbiddenClient: [/child_process/, /playwright-profile/, /Google Chrome\.app/],
  },
  {
    dir: path.join(dshRoot, 'balance-meter', 'dsh-balance-meter'),
    name: 'dsh-balance-meter',
    sourceRoot: null,
    forbiddenClient: [/DEEPSEEK_API_KEY/, /Authorization/],
  },
  {
    dir: path.join(dshRoot, 'fairy-startup', 'dsh-fairy-startup'),
    name: 'dsh-fairy-startup',
    sourceRoot: null,
    forbiddenClient: [/fairy-visual/, /fairy-voice/, /localStorage/, /sessionStorage/],
  },
  {
    dir: path.join(dshRoot, 'fairy-visual', 'dsh-fairy-visual'),
    name: 'dsh-fairy-visual',
    sourceRoot: 'src',
    // Match legacy Voice package paths only. The shared public DOM attribute
    // `data-dsh-fairy-voice-control` is intentionally part of Visual's contract.
    forbidden: [/fairy-voice\//, /agent\/pre-step/, /127\.0\.0\.1:9880/, /hHd-Xa_newSession/, /:has\(/],
  },
  {
    dir: path.join(dshRoot, 'fairy-voice', 'dsh-fairy-voice'),
    name: 'dsh-fairy-voice',
    sourceRoot: null,
    forbidden: [/dsh-hdd-mode/, /agent\/pre-step/, /\.agent-presets/],
  },
  {
    dir: path.join(dshRoot, 'fairy-persona', 'dsh-fairy-persona'),
    name: 'dsh-fairy-persona',
    sourceRoot: null,
    // Persona packs live under persona-packs/ and $DSH_HOME/personas; the
    // engine must not grow a hook into agent internals or preset discovery.
    forbidden: [/dsh-hdd-mode/, /agent\/pre-step/, /\.agent-presets/],
    forbiddenClient: [/Authorization/, /DEEPSEEK_API_KEY/],
  },
  {
    dir: path.join(dshRoot, 'fairy-modes', 'dsh-fairy-modes'),
    name: 'dsh-fairy-modes',
    sourceRoot: null,
    // Mode state is a session projection; the engine owns no agent hooks and
    // no preset/discovery machinery.
    forbidden: [/dsh-hdd-mode/, /agent\/pre-step/, /\.agent-presets/],
    forbiddenClient: [/Authorization/],
  },
  {
    dir: path.join(dshRoot, 'fairy-search', 'dsh-fairy-search'),
    name: 'dsh-fairy-search',
    sourceRoot: null,
    // Keys are host-side settings; neither face may build auth material.
    forbidden: [/dsh-hdd-mode/, /agent\/pre-step/],
    forbiddenClient: [/Authorization/],
  },
  {
    dir: path.join(dshRoot, 'fairy-memory', 'dsh-fairy-memory'),
    name: 'dsh-fairy-memory',
    sourceRoot: null,
    // Provider credentials are host-side settings; neither face may build auth
    // material or reach into agent internals.
    forbidden: [/dsh-hdd-mode/, /agent\/pre-step/],
    forbiddenClient: [/Authorization/, /DEEPSEEK_API_KEY/],
  },
];

function fail(message) {
  throw new Error(`Fairy build contract failed: ${message}`);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    fail(`cannot read ${file}: ${error.message}`);
  }
}

function verifyPackage(contract) {
  const { dir: packageDir, name: expectedName } = contract;
  const manifestPath = path.join(packageDir, 'package.json');
  const manifest = readJson(manifestPath);
  if (manifest.name !== expectedName) fail(`${expectedName} manifest identity drifted: ${JSON.stringify(manifest.name)}`);
  const targets = new Map([
    ['main', manifest.main],
    ['exports["."]', manifest.exports?.['.']],
    ['exports["./client"]', manifest.exports?.['./client']],
  ]);
  for (const [label, target] of targets) {
    if (typeof target !== 'string' || target.length === 0) fail(`${manifest.name} does not declare ${label}`);
    const output = path.resolve(packageDir, target);
    if (!fs.existsSync(output) || !fs.statSync(output).isFile()) {
      fail(`${manifest.name} ${label} points to missing build output ${output}`);
    }
  }

  const outputs = [...new Set([...targets.values()].map((target) => path.resolve(packageDir, target)))];
  const outputMtime = Math.min(...outputs.map((output) => fs.statSync(output).mtimeMs));
  const manifestMtime = fs.statSync(manifestPath).mtimeMs;
  // A package with no `sourceRoot` has no build step: its lib files are the
  // sources, so "output newer than manifest" could only ever hold by the order
  // files happened to be written. The check keeps its meaning for the packages
  // that really do generate lib/* from src/*.
  if (contract.sourceRoot !== null && manifestMtime > outputMtime + 1) {
    fail(`${manifest.name} manifest is newer than its generated outputs; rebuild and re-verify`);
  }

  if (contract.sourceRoot) {
    const sourceDir = path.join(packageDir, contract.sourceRoot);
    if (!fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory()) {
      fail(`${manifest.name} source root is missing: ${sourceDir}`);
    }
    const sourceFiles = [];
    const visit = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) visit(file);
        else if (entry.isFile()) sourceFiles.push(file);
      }
    };
    visit(sourceDir);
    const newestSource = Math.max(...sourceFiles.map((file) => fs.statSync(file).mtimeMs));
    if (newestSource > outputMtime + 1) {
      fail(`${manifest.name} source is newer than its generated outputs; rebuild and re-verify`);
    }
  }

  const bundleText = outputs.map((output) => fs.readFileSync(output, 'utf8')).join('\n');
  for (const pattern of contract.forbidden || []) {
    if (pattern.test(bundleText)) fail(`${manifest.name} bundle contains forbidden legacy path or injection: ${pattern}`);
  }
  const clientOutput = path.resolve(packageDir, manifest.exports['./client']);
  const clientText = fs.readFileSync(clientOutput, 'utf8');
  for (const pattern of contract.forbiddenClient || []) {
    if (pattern.test(clientText)) fail(`${manifest.name} client bundle contains forbidden legacy path or injection: ${pattern}`);
  }
}

for (const contract of packages) verifyPackage(contract);
process.stdout.write(`Fairy build contract verified (${packages.length} packages)\n`);
