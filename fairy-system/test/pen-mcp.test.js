import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { appIdFor, ensureProfileRow } from '../../scripts/pen-mcp.mjs';

/* mcp-pen 行缺字段会让整棵插件树加载失败、实例起不来（2026-09-17 实测），
 * 而 -app 配错会得到「装了但连不上」的 MCP —— 这两条都在这里钉住。 */

const PATCH_STUB = [
  '# stub profile patch',
  '- id: something',
  '  config:',
  '    a: 1',
  '',
  '- insert:',
  '    - id: context7',
  "      name: '@upstash/context7-mcp'",
  '',
].join('\n');

test('writes a loadable mcp-pen row and uses the derived -app id', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pen-mcp-'));
  try {
    const patch = join(dir, 'cordis.patch.yml');
    await writeFile(patch, PATCH_STUB);
    const mcpPath = 'C:\\fake\\Pen\\resources\\app.asar.unpacked\\out\\mcp-server-windows-x64.exe';

    assert.equal(ensureProfileRow(patch, mcpPath, 'visual_studio_code', 'dsh', false), true);
    const text = await readFile(patch, 'utf8');
    assert.match(text, /^\s*- id: mcp-pen\s*$/m, '缺 mcp-pen 行');
    assert.match(text, /serverName: pen/, '缺 serverName（dsh-mcp-client 必填）');
    assert.match(text, /transport: stdio/, '缺 transport（dsh-mcp-client 必填）');
    assert.match(text, /failOnStartupError: false/, '缺 failOnStartupError（Pen 没开时只降级不炸启动）');
    assert.match(text, /- '-app'\n\s+- 'visual_studio_code'/, '-app 必须用推导出的变体 id，不能写死 desktop');
    assert.match(text, /- '-agent'\n\s+- 'dsh'/);

    // 幂等：已有 mcp-pen 行时不再改写文件。
    assert.equal(ensureProfileRow(patch, mcpPath, 'visual_studio_code', 'dsh', false), true);
    assert.equal(await readFile(patch, 'utf8'), text);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('appIdFor pairs ~/.pencil editor variants with their own -app id', () => {
  assert.equal(appIdFor(''), 'desktop');
  assert.equal(appIdFor('C:\\Pen\\resources\\app.asar.unpacked\\out\\mcp-server-windows-x64.exe'), 'desktop');
  assert.equal(appIdFor('/home/u/.pencil/mcp/visual_studio_code/mcp-server-linux-x64'), 'visual_studio_code');
});
