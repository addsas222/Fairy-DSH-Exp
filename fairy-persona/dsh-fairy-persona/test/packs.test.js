import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { defaultScanRoots, parsePersonaYaml, scanPersonaPacks } from '../lib/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(here, 'fixtures');
const ROOTS = [join(FIXTURES, 'home', 'personas'), join(FIXTURES, 'repo', 'persona-packs')];

function recorder() {
  const warnings = [];
  return { warnings, warn: (operation, context, error) => warnings.push({ operation, context, error }) };
}

function setEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

test('parsePersonaYaml reads flat pairs, one nested block, quotes, and comments', () => {
  const parsed = parsePersonaYaml([
    '# 人格包清单',
    'id: fairy',
    'name: "Fairy"',
    "description: '带引号的名字'",
    'voice:',
    '  provider: openai',
    '  baseURL: http://127.0.0.1:9880',
    '',
  ].join('\n'));
  assert.deepEqual(parsed, {
    id: 'fairy',
    name: 'Fairy',
    description: '带引号的名字',
    voice: { provider: 'openai', baseURL: 'http://127.0.0.1:9880' },
  });
});

test('parsePersonaYaml refuses anything outside the flat subset', () => {
  assert.throws(() => parsePersonaYaml('id: x\n- name: y'), /unsupported persona\.yml line/);
  assert.throws(() => parsePersonaYaml('  provider: openai\n'), /indented "provider" under no block/);
});

test('scanPersonaPacks keeps valid packs and skips broken ones with warnings', async () => {
  const logger = recorder();
  const packs = await scanPersonaPacks(ROOTS, logger);

  // A user pack overrides the repository pack that shares its id.
  assert.deepEqual([...packs.keys()], ['fairy', 'no-voice', 'greet']);
  assert.equal(packs.get('fairy').directory, join(FIXTURES, 'home', 'personas', 'fairy'));
  assert.equal(packs.get('fairy').name, 'Fairy');
  assert.equal(packs.get('fairy').description, 'Ⅲ型总序式集成泛用人工智能');
  assert.deepEqual(packs.get('fairy').voice, {
    provider: 'openai',
    config: { baseURL: 'http://127.0.0.1:9880', model: 'fairy-v4', voice: 'fairy' },
  });
  assert.equal(packs.get('no-voice').voice, null);
  assert.equal(packs.get('no-voice').tonePath, undefined);
  assert.equal(packs.get('greet').description, '只负责打招呼');

  // broken-yaml, bad-id, no-prompt, and the pack escaping its own directory.
  assert.deepEqual(logger.warnings.map(warning => warning.operation).sort(), ['pack.id', 'pack.parse', 'pack.prompt', 'pack.prompt']);
});

test('a root that does not exist is empty rather than an error', async () => {
  const logger = recorder();
  const packs = await scanPersonaPacks([join(FIXTURES, 'missing-root')], logger);
  assert.equal(packs.size, 0);
  assert.deepEqual(logger.warnings, []);
});

test('defaultScanRoots prefers the environment and falls back to this repository', () => {
  const previous = { home: process.env.DSH_HOME, repo: process.env.DSH_FAIRY_REPO_ROOT };
  try {
    setEnv('DSH_HOME', join(FIXTURES, 'home'));
    setEnv('DSH_FAIRY_REPO_ROOT', join(FIXTURES, 'repo'));
    assert.deepEqual(defaultScanRoots(), [
      join(FIXTURES, 'home', 'personas'),
      join(FIXTURES, 'repo', 'persona-packs'),
    ]);
  } finally {
    setEnv('DSH_HOME', previous.home);
    setEnv('DSH_FAIRY_REPO_ROOT', previous.repo);
  }

  const roots = defaultScanRoots();
  assert.equal(roots[0], join(homedir(), '.dsh', 'personas'));
  // Without the environment the fallback must land on the repository root,
  // which is the directory holding the sibling plugin packages.
  assert.equal(basename(roots[1]), 'persona-packs');
  assert.ok(existsSync(join(dirname(roots[1]), 'fairy-voice')));
});
