import { settingsNamespace } from '@deepseek-ai/dsh-settings';
import z from '@deepseek-ai/schemastery';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  FAIRY_IDENTITY_SETTINGS_NAMESPACE,
  FAIRY_VISUAL_SETTINGS_NAMESPACE,
  FAIRY_VISUAL_SETTINGS_VERSION,
} from 'dsh-fairy-contracts';
import { createFairyDiagnostics } from 'dsh-fairy-contracts/diagnostics';
import { findPenMcp, recordedPenPath } from './workshop-pen.cjs';

const settingsNamespaceName = FAIRY_VISUAL_SETTINGS_NAMESPACE;
const FAIRY_VISUAL_SETTINGS = settingsNamespace(settingsNamespaceName);
const FAIRY_IDENTITY_SETTINGS = settingsNamespace(FAIRY_IDENTITY_SETTINGS_NAMESPACE);
const diagnostics = createFairyDiagnostics('dsh-fairy-visual');

export const FairyVisualSettings = z.object({
  version: z.number().step(1).default(FAIRY_VISUAL_SETTINGS_VERSION),
  enabled: z.boolean().default(false),
  theme: z.union(['dark', 'light']).default('dark'),
  mascotVisible: z.boolean().default(true),
  // 内容遮罩（主视觉遮挡其下正文）：默认关，开启后生成期间新文字会变淡。
  contentFade: z.boolean().default(false),
  mascotScale: z.number().step(0.01).min(0.55).max(1).default(1),
  mascotAnimationSpeed: z.union([z.const(0.7), z.const(1), z.const(1.5)]).default(1),
  // 调色盘（palette）：HDD 自有 chrome（卡片/键帽/边框/光效）的语义色板。
  // 默认 hdd 与既有观感一致（DOM 不落属性）；ink=冷灰蓝、ember=暖炭。
  palette: z.union([z.const('hdd'), z.const('ink'), z.const('ember')]).default('hdd'),
  // 大眼睛位置：九宫格锚点。默认 center 与既有观感一致；位移由客户端 translate 实现，
  // 只动眼睛本身，不动宿主的固定定位与布局盒。
  mascotPosition: z.union([
    z.const('top-left'), z.const('top-center'), z.const('top-right'),
    z.const('middle-left'), z.const('center'), z.const('middle-right'),
    z.const('bottom-left'), z.const('bottom-center'), z.const('bottom-right'),
  ]).default('center'),
  // 大眼站位模式：static=始终用 mascotPosition（既有行为）；dynamic=空载居中、
  // 思考（会话运行中）移到右中一侧。客户端 Stage 按活动态解析，锚点→translate 管线不变。
  mascotPositionMode: z.union([z.const('static'), z.const('dynamic')]).default('static'),
  powerMode: z.union(['normal', 'low-power']).default('normal'),
  composerDockHeight: z.number().step(1).min(132).max(420).default(132),
});

export const FairyIdentitySettings = z.object({
  mode: z.union(['ling', 'zhe', 'custom']).default('ling'),
  customName: z.string().default(''),
  secondAssistant: z.string().default(''),
  household: z.array(z.string()).default([]),
});

export const name = 'dsh-fairy-visual';

/**
 * 创作工坊：只读状态端点 `/fairy-visual/workshop`。
 * 检测三件事（与 scripts/pen-mcp.mjs 同一套判据）：pen 应用是否装上、mcp-pen 行
 * 是否已写进 home 的 profiles/web/cordis.patch.yml、preset 技能槽位里有哪些设计技能。
 */
const WORKSHOP_PATH = '/fairy-visual/workshop';
// pen 定位与 patch 路径解码在 ./workshop-pen.cjs（纯函数，仓库树里也能直接测）。

function workshopStatus() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  const penPath = findPenMcp();
  const patch = join(home, 'profiles', 'web', 'cordis.patch.yml');
  let patchText = '';
  try { patchText = readFileSync(patch, 'utf8'); } catch { /* 未部署 profile 时按未接入报 */ }
  // 取 patch 里写下的那条路径（解引号的事交给 recordedPenPath），是否真存在由返回值说明。
  const recorded = recordedPenPath(patchText);
  const mcpWired = /^\s*-\s*id:\s*mcp-pen\s*$/m.test(patchText);
  const skills = [];
  const presetsRoot = join(home, '.agent-presets');
  try {
    for (const preset of readdirSync(presetsRoot, { withFileTypes: true })) {
      if (!preset.isDirectory()) continue;
      const skillsDir = join(presetsRoot, preset.name, 'skills');
      // 没有 skills 槽位的 preset 很常见；单个目录缺槽位不能让整表扫描中断。
      let entries;
      try {
        entries = readdirSync(skillsDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (existsSync(join(skillsDir, entry.name, 'SKILL.md'))) skills.push(entry.name);
      }
    }
  } catch { /* presets 根不存在时返回空表 */ }
  return {
    home,
    pen: { installed: Boolean(penPath), path: penPath },
    // recorded 是 profile patch 里写着的那条路径，不一定还存在（换盘/重装后会留旧值）；
    // installed 只看文件是否真在——两者不一致就是「配了但失效」，面板照实说，不猜。
    mcp: { wired: mcpWired, patch, recorded, installed: Boolean(recorded) && existsSync(recorded) },
    skills: [...new Set(skills)].sort(),
  };
}

function sendJson(res, status, value) {
  if (res.destroyed || res.writableEnded) return false;
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(value));
  return true;
}

export function apply(ctx) {
  return diagnostics.guard('apply', () => {
    ctx.inject(['settings'], (settingsCtx) => {
      settingsCtx.settings.register(FAIRY_VISUAL_SETTINGS, FairyVisualSettings);
      settingsCtx.settings.register(FAIRY_IDENTITY_SETTINGS, FairyIdentitySettings);
    });
    ctx.inject(['webServer'], (ws) => ws.effect(() => {
      const release = ws.webServer.register({
        kind: 'exact',
        path: WORKSHOP_PATH,
        handler: (req, res) => {
          try {
            sendJson(res, 200, { ok: true, ...workshopStatus() });
          } catch (error) {
            sendJson(res, 500, { ok: false, error: String(error?.message || error) });
          }
        },
      });
      return () => release?.();
    }));
  }, { surface: 'host' });
}
