import { settingsNamespace } from '@deepseek-ai/dsh-settings';
import z from '@deepseek-ai/schemastery';
import {
  FAIRY_IDENTITY_SETTINGS_NAMESPACE,
  FAIRY_VISUAL_SETTINGS_NAMESPACE,
  FAIRY_VISUAL_SETTINGS_VERSION,
} from 'dsh-fairy-contracts';
import { createFairyDiagnostics } from 'dsh-fairy-contracts/diagnostics';

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
  // 大眼睛位置：九宫格锚点。默认 center 与既有观感一致；位移由客户端 translate 实现，
  // 只动眼睛本身，不动宿主的固定定位与布局盒。
  mascotPosition: z.union([
    z.const('top-left'), z.const('top-center'), z.const('top-right'),
    z.const('middle-left'), z.const('center'), z.const('middle-right'),
    z.const('bottom-left'), z.const('bottom-center'), z.const('bottom-right'),
  ]).default('center'),
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

export function apply(ctx) {
  return diagnostics.guard('apply', () => {
    ctx.inject(['settings'], (settingsCtx) => {
      settingsCtx.settings.register(FAIRY_VISUAL_SETTINGS, FairyVisualSettings);
      settingsCtx.settings.register(FAIRY_IDENTITY_SETTINGS, FairyIdentitySettings);
    });
  }, { surface: 'host' });
}
