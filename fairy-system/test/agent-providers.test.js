import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { CHECKED_AT, EXIT, PUBLISHED, WATCH, collect, exitCodeFor, presetRows, sameLine } from '../agent-providers.mjs';

const TOOL = fileURLToPath(new URL('../agent-providers.mjs', import.meta.url));

/** 造一个隔离 home：可指定核心/候选版本、宿主行、两个 preset 的行块。 */
function fixtureHome({ coreVersion = '0.1.1-rc.2', codexVersion = '0.0.1-rc.1', hostRow = 'provider: codex', presets = {} } = {}) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'fairy-providers-'));
  const write = (rel, text) => {
    const file = path.join(home, ...rel.split('/'));
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
  };
  write('profiles/web/cordis.patch.yml', `${hostRow}\n`);
  write('profiles/web/node_modules/@deepseek-ai/dsh-subagent/package.json', JSON.stringify({ name: '@deepseek-ai/dsh-subagent', version: coreVersion }));
  if (codexVersion) {
    write('profiles/web/node_modules/@deepseek-ai/dsh-subagent-codex/package.json', JSON.stringify({
      name: '@deepseek-ai/dsh-subagent-codex',
      version: codexVersion,
      peerDependencies: { '@deepseek-ai/dsh-subagent': '^0.0.1-rc.1' },
    }));
  }
  for (const [preset, text] of Object.entries(presets)) write(`.agent-presets/${preset}/agent.cordis.yml`, text);
  return home;
}

const withTemp = (fixture, body) => {
  try { body(fixture); } finally { rmSync(fixture, { recursive: true, force: true }); }
};

/** 假 CLI 查找：`given` 里的名字判为在装（返回其路径），其余抛 ENOENT；版本查询返回一个版本行。 */
const fakeRun = (given) => (cmd, args) => {
  if (cmd === 'where' || cmd === 'which') {
    const found = given[args[0]];
    if (!found) throw new Error('ENOENT');
    return `${found}\n`;
  }
  return '1.2.3\n';
};

test('同线判定看主次版本段，而不是 semver range', () => {
  assert.equal(sameLine('0.1.1-rc.2', '0.1.1-rc.9'), true);
  assert.equal(sameLine('0.0.1-rc.1', '0.1.1-rc.2'), false, '上游 bundle 与本机核心是不同发布线');
  assert.equal(sameLine(null, '0.1.1-rc.2'), null);
});

test('preset 行扫按缩进块：disabled 判在块内，下一行使块结束', () => {
  const home = fixtureHome({
    presets: {
      'fairy-full': [
        '- id: tool-subagent-codex',
        "  name: '@deepseek-ai/dsh-tool-subagent'",
        '  disabled: true',
        '  config:',
        '    provider: codex',
        '- id: tool-subagent-claude-code',
        "  name: '@deepseek-ai/dsh-tool-subagent'",
        '  config:',
        '    provider: claude-code',
        '',
      ].join('\n'),
    },
  });
  withTemp(home, () => {
    const codex = presetRows(path.join(home, '.agent-presets'), 'codex');
    const claude = presetRows(path.join(home, '.agent-presets'), 'claude-code');
    assert.deepEqual(codex, [{ preset: 'fairy-full', line: 1, disabled: true }]);
    assert.deepEqual(claude, [{ preset: 'fairy-full', line: 6, disabled: false }], '前一行块的 disabled 不得污染下一行');
  });
});

test('四环按 bundle 同线 / 宿主行 / CLI / 未 disabled 的 preset 行闭合', () => {
  const home = fixtureHome({
    presets: {
      'fairy-full': [
        '- id: tool-subagent-codex',
        '  disabled: true',
        '- id: tool-subagent-claude-code',
        '  config:',
        '    provider: claude-code',
        '',
      ].join('\n'),
    },
  });
  withTemp(home, () => {
    // 异线 bundle（0.0.1-rc.1 vs 0.1.1-rc.2）＋ preset 行被 disabled：codex 不闭合。
    const stale = collect({ home, run: fakeRun({ codex: 'C:/bin/codex.exe', claude: 'C:/bin/claude.exe' }) });
    const codex = stale.rows.find((row) => row.id === 'codex');
    assert.equal(codex.bundle.installed, true);
    assert.equal(codex.rings.bundle, false, '异线 bundle 不算闭合');
    assert.equal(codex.rings.hostRow, true);
    assert.equal(codex.rings.cli, true);
    assert.equal(codex.rings.presetRow, false, 'disabled 行不算闭合');
    assert.equal(codex.closed, false);

    const claude = stale.rows.find((row) => row.id === 'claude-code');
    assert.equal(claude.rings.presetRow, true, 'claude-code 有未 disabled 的 preset 行');
    assert.equal(claude.rings.bundle, false);
    assert.equal(claude.closed, false);
    assert.deepEqual(stale.usable, []);
    assert.equal(exitCodeFor(stale), EXIT.NOT_CLOSED);

    // 同线 bundle ＋ 启用行 ＋ CLI ＋ 宿主行 → 四环闭合。
    const ready = fixtureHome({
      codexVersion: '0.1.1-rc.7',
      presets: { 'fairy-full': ['- id: tool-subagent-codex', '  config:', '    provider: codex', ''].join('\n') },
    });
    withTemp(ready, () => {
      const report = collect({ home: ready, run: fakeRun({ codex: 'C:/bin/codex.exe' }) });
      const row = report.rows.find((entry) => entry.id === 'codex');
      assert.deepEqual(row.rings, { bundle: true, hostRow: true, cli: true, presetRow: true });
      assert.deepEqual(report.usable, ['codex']);
      assert.equal(exitCodeFor(report), EXIT.READY);
    });
  });
});

test('找不到 profile 时退出码是「环境不对」而不是「没闭合」', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'fairy-providers-empty-'));
  withTemp(home, () => {
    assert.equal(exitCodeFor(collect({ home, run: fakeRun({}) })), EXIT.USAGE);
  });
});

test('候选表与核对日期是可维护常量（上游发新 bundle 时改这里）', () => {
  assert.equal(CHECKED_AT, '2026-09-15');
  assert.deepEqual(PUBLISHED.map((entry) => entry.id), ['codex', 'claude-code'], '整条发布线实测只有这两个');
  const watched = WATCH.map((entry) => entry.id);
  for (const id of ['gemini', 'qwen', 'opencode', 'aider', 'cursor', 'copilot', 'goose', 'crush', 'droid', 'kimi', 'pi', 'codebuddy']) {
    assert.ok(watched.includes(id), `观察名单缺 ${id}`);
  }
});

test('CLI 以 --home 指向部署 home 时按四环给退出码', () => {
  const home = fixtureHome({ presets: { 'fairy-full': ['- id: tool-subagent-codex', '  disabled: true', ''].join('\n') } });
  withTemp(home, () => {
    let code = 0;
    try {
      execFileSync(process.execPath, [TOOL, '--home', home, '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) { code = error.status; }
    assert.equal(code, EXIT.NOT_CLOSED, '有候选但没闭合 → 1');

    const empty = mkdtempSync(path.join(os.tmpdir(), 'fairy-providers-missing-'));
    withTemp(empty, () => {
      let missing = 0;
      try {
        execFileSync(process.execPath, [TOOL, '--home', empty], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (error) { missing = error.status; }
      assert.equal(missing, EXIT.USAGE, '没有 profile → 2');
    });
  });
});
