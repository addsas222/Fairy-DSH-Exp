'use strict';

const SETTINGS_VERSION = 2;
const SPEED_STOPS = Object.freeze([0.7, 1, 1.5]);
// 大眼睛位置：九宫格锚点（与 host schema、客户端常量表同一份清单）。
const MASCOT_POSITIONS = Object.freeze([
  'top-left', 'top-center', 'top-right',
  'middle-left', 'center', 'middle-right',
  'bottom-left', 'bottom-center', 'bottom-right',
]);
// 调色盘（palette）：与 host schema、客户端常量表同一份清单。
const PALETTES = Object.freeze(['hdd', 'ink', 'ember']);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const nearest = (value, values) => values.reduce((best, item) => Math.abs(item - value) < Math.abs(best - value) ? item : best, values[0]);
const toFiniteNumber = (value) => {
  if (value === '' || value == null || (typeof value === 'string' && value.trim() === '')) return NaN;
  const number = Number(value);
  return Number.isFinite(number) ? number : NaN;
};

function migrateVisualSettings(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const legacyScale = source.mascotScale ?? source.eyeSize ?? source.mascotSize;
  const rawSpeed = source.mascotAnimationSpeed ?? source.animationSpeed;
  const numericSpeed = toFiniteNumber(rawSpeed);
  const numericScale = toFiniteNumber(legacyScale);
  const numericComposerHeight = toFiniteNumber(source.composerDockHeight);
  return {
    version: SETTINGS_VERSION,
    enabled: typeof source.enabled === 'boolean' ? source.enabled : false,
    theme: source.theme === 'light' ? 'light' : 'dark',
    mascotVisible: typeof source.mascotVisible === 'boolean' ? source.mascotVisible : true,
    // 内容遮罩（主视觉遮挡其下正文）：默认关；仅接受显式布尔。
    contentFade: typeof source.contentFade === 'boolean' ? source.contentFade : false,
    mascotScale: Number.isFinite(numericScale) ? clamp(numericScale, 0.55, 1) : 1,
    mascotAnimationSpeed: Number.isFinite(numericSpeed) ? nearest(numericSpeed, SPEED_STOPS) : 1,
    // 这个对象是**逐字段重建**的：漏一个字段就等于把它丢掉（mascotPosition 曾因此写入无效）。
    mascotPosition: MASCOT_POSITIONS.includes(source.mascotPosition) ? source.mascotPosition : 'center',
    mascotPositionMode: source.mascotPositionMode === 'dynamic' ? 'dynamic' : 'static',
    palette: PALETTES.includes(source.palette) ? source.palette : 'hdd',
    powerMode: source.powerMode === 'low-power' ? 'low-power' : 'normal',
    composerDockHeight: Number.isFinite(numericComposerHeight) ? Math.round(clamp(numericComposerHeight, 132, 420)) : 132,
  };
}

function normalizeSetting(field, value, current = {}) {
  return migrateVisualSettings({ ...current, [field]: value })[field];
}

module.exports = { SETTINGS_VERSION, SPEED_STOPS, MASCOT_POSITIONS, PALETTES, migrateVisualSettings, normalizeSetting };
