#!/usr/bin/env node
/*
 * Fairy DSH 插件脚手架：生成 fairy-voice 形状的双面孔插件包。零依赖，Node >= 20。
 * 用法：node scaffold-plugin.js <dsh-name> [--dir <parent>] [--client] [--self-test]
 * ponytail: 只生成骨架文件，不代跑 pnpm install；生成后按 README 的步骤安装与联调。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const NAME_PATTERN = /^dsh-[a-z0-9-]+$/;
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = process.env.DSH_FAIRY_REPO_ROOT || resolve(SCRIPT_DIR, '..');
const CLIENT_INJECT = ['@deepseek-ai/dsh-client-runtime', '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-ui-settings'];

function manifest(name, withClient) {
  return {
    name,
    version: '1.0.0',
    private: true,
    type: 'module',
    main: './lib/index.js',
    exports: {
      '.': './lib/index.js',
      ...(withClient ? { './client': './lib/client.js' } : {}),
      './package.json': './package.json',
    },
    ...(withClient ? { dsh: { client: { platform: 'web', inject: CLIENT_INJECT } } } : {}),
    dependencies: { 'dsh-fairy-contracts': 'link:../../fairy-contracts' },
    scripts: { test: 'node --test test/*.test.js' },
  };
}

function hostSource(name) {
  return `import { createFairyDiagnostics } from 'dsh-fairy-contracts/diagnostics';

/* 契约、端点、插槽、设置：见包内 README.md。 */
export const NAME = '${name}';

const diagnostics = createFairyDiagnostics(NAME);

export function apply(ctx) {
  return diagnostics.guard('apply', () => {
    // ponytail: 空宿主——首个真实能力（HTTP 路由 / 设置命名空间 / 宿主服务）挂在这里。
    ctx.effect(() => () => {}, \`\${NAME} placeholder effect\`);
  });
}
`;
}

function clientSource(name) {
  return `window.__ModuleLoader__.load({
  id: '${name}',
  factory: (require) => {
    const jsx = require('react/jsx-runtime');

    function SettingsPanel() {
      return jsx.jsx('section', { style: { display: 'grid', gap: 6 }, children: [
        jsx.jsx('strong', { key: 'title', children: '${name}' }),
        jsx.jsx('span', { key: 'hint', style: { opacity: 0.7 }, children: '设置卡占位：接入设置命名空间后替换为真实配置。' }),
      ] });
    }

    function injectSlot(ctx, name, definition, component) {
      let disposeRegistration = null;
      const release = () => {
        const dispose = disposeRegistration;
        disposeRegistration = null;
        dispose?.();
      };
      return ctx.slots.inject(name, () => {
        // 官方节点被替换或客户端重载时 provider 会再次调用：先释放上一次注册。
        release();
        const registration = ctx.slots.register({ name, ...definition }, component);
        disposeRegistration = typeof registration === 'function' ? registration : null;
        return release;
      });
    }

    function apply(ctx) {
      return injectSlot(ctx, 'settings.section', { id: '${name}-settings', order: 40, label: () => '${name}' }, SettingsPanel);
    }

    return { apply, inject: ['slots'] };
  }
});
`;
}

function testSource(name, withClient) {
  return `import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { apply, NAME } from '../lib/index.js';

test('${name} exports its apply entrypoint', async () => {
  assert.equal(NAME, '${name}');
  assert.equal(typeof apply, 'function');
${withClient ? `  const client = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
  assert.match(client, /__ModuleLoader__\\.load/);
` : ''}});
`;
}

function readmeSource(name, withClient) {
  return `# ${name}

<一句话说明这个插件做什么、为谁解决什么问题。>

## 契约

- 宿主入口 \`lib/index.js\`：导出 \`NAME\` 与 \`apply(ctx)\`，\`apply\` 由 \`createFairyDiagnostics\` 包裹。
${withClient ? '- 客户端入口 `lib/client.js`：`window.__ModuleLoader__.load({ id, factory })`，注册 `settings.section` 设置卡。\n' : ''}- 依赖 \`dsh-fairy-contracts\`（\`link:../../fairy-contracts\`）提供结构化诊断。

## 端点

<宿主 HTTP 路由（\`ctx.webServer.register\`）表；没有就写“无”。>

## 插槽

${withClient ? '- `settings.section`：设置卡（id `${name}-settings`）。\n' : '<无；如需 UI，用 `--client` 重新生成。>\n'}
## 设置

<设置命名空间与字段；没有就写“无”。>

## 开发

\`\`\`bash
pnpm install --ignore-scripts
pnpm test
\`\`\`
`;
}

function scaffold(target, name, withClient) {
  if (existsSync(target)) throw new Error(`refusing to overwrite existing path: ${target}`);
  mkdirSync(join(target, 'lib'), { recursive: true });
  mkdirSync(join(target, 'test'), { recursive: true });
  writeFileSync(join(target, 'package.json'), `${JSON.stringify(manifest(name, withClient), null, 2)}\n`, 'utf8');
  writeFileSync(join(target, 'lib', 'index.js'), hostSource(name), 'utf8');
  if (withClient) writeFileSync(join(target, 'lib', 'client.js'), clientSource(name), 'utf8');
  writeFileSync(join(target, 'test', 'contract.test.js'), testSource(name, withClient), 'utf8');
  writeFileSync(join(target, 'README.md'), readmeSource(name, withClient), 'utf8');
}

function verifyScaffold(target, name, withClient) {
  const expected = ['package.json', 'lib/index.js', 'test/contract.test.js', 'README.md', ...(withClient ? ['lib/client.js'] : [])];
  for (const file of expected) {
    assert.ok(existsSync(join(target, file)), `missing scaffolded file: ${file}`);
  }
  assert.equal(JSON.parse(readFileSync(join(target, 'package.json'), 'utf8')).name, name);
  const check = spawnSync(process.execPath, ['--check', join(target, 'lib', 'index.js')], { encoding: 'utf8' });
  assert.equal(check.status, 0, `lib/index.js is not parseable: ${check.stderr}`);
  if (withClient) {
    const source = readFileSync(join(target, 'lib', 'client.js'), 'utf8');
    assert.match(source, /__ModuleLoader__\.load/);
    new Function(source); // 语法校验：客户端 bundle 无需打包即可 parse。
  }
}

function selfTest() {
  const sandbox = mkdtempSync(join(tmpdir(), 'fairy-scaffold-'));
  try {
    for (const withClient of [false, true]) {
      const name = withClient ? 'dsh-self-test-client' : 'dsh-self-test-host';
      const target = join(sandbox, name);
      scaffold(target, name, withClient);
      verifyScaffold(target, name, withClient);
      assert.throws(() => scaffold(target, name, withClient), /refusing to overwrite/, 'existing directories must be refused');
    }
    assert.deepEqual(readdirSync(sandbox).sort(), ['dsh-self-test-client', 'dsh-self-test-host']);
    process.stdout.write('scaffold-plugin self-test passed (host + client variants)\n');
    return true;
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

function main(argv) {
  let name = '';
  let parent = REPO_ROOT;
  let withClient = false;
  let selfTestOnly = false;
  try {
    for (let index = 0; index < argv.length; index += 1) {
      const arg = argv[index];
      if (arg === '--dir') {
        parent = resolve(argv[++index] || '.');
        if (!argv[index]) throw new Error('--dir needs a value');
      } else if (arg === '--client') withClient = true;
      else if (arg === '--self-test') selfTestOnly = true;
      else if (arg.startsWith('--')) throw new Error(`unknown argument: ${arg}`);
      else if (name) throw new Error(`unexpected argument: ${arg}`);
      else name = arg;
    }
    if (!selfTestOnly && !NAME_PATTERN.test(name)) throw new Error(`plugin name must match ${NAME_PATTERN} (got "${name}")`);
  } catch (error) {
    process.stderr.write(`scaffold-plugin: ${error.message}\n`);
    process.exitCode = 2;
    return;
  }
  try {
    if (selfTestOnly) {
      if (!selfTest()) process.exitCode = 1;
      return;
    }
    const target = join(parent, name);
    scaffold(target, name, withClient);
    process.stdout.write(`scaffolded ${target}${withClient ? ' (with client)' : ''}\n`);
  } catch (error) {
    process.stderr.write(`scaffold-plugin: ${error.message}\n`);
    process.exitCode = 1;
  }
}

main(process.argv.slice(2));
