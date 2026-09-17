import { MODE_ATTR, PALETTE_ATTR, PALETTES, POWER_MODE_ATTR, THEME_ATTR } from './constants.js';

import { deriveSessionComfort } from './comfort-detector.js';

export function deriveSessionActivity(snapshot) {
  if (deriveSessionComfort(snapshot)) return 'comforting';
  return snapshot?.running === true ? 'thinking' : 'normal';
}

export function syncDocumentMode(snapshot) {
  // Settings snapshots carry the persisted value under `value`; keeping the
  // projection here makes the document state authoritative for every visual
  // surface and prevents controls from drifting from their CSS scope.
  const value = snapshot?.value || snapshot || {};
  if (snapshot?.status === 'loading') return;
  const enabled = Boolean(value.enabled);
  const theme = value.theme === 'light' ? 'light' : 'dark';
  const powerMode = value.powerMode === 'low-power' ? 'low-power' : 'normal';
  const root = document.documentElement;

  if (enabled) {
    root.setAttribute('data-dsh-fairy-visual', '');
    root.setAttribute(THEME_ATTR, theme);
    root.setAttribute(MODE_ATTR, 'hdd');
    root.setAttribute(POWER_MODE_ATTR, powerMode);
    // 调色盘：hdd 为属性缺省（默认 DOM 与既有状态逐字节一致），只有 ink/ember 才落属性。
    const palette = PALETTES.includes(value.palette) ? value.palette : 'hdd';
    if (palette === 'hdd') root.removeAttribute(PALETTE_ATTR);
    else root.setAttribute(PALETTE_ATTR, palette);
  } else {
    root.removeAttribute('data-dsh-fairy-visual');
    root.removeAttribute(THEME_ATTR);
    root.removeAttribute(MODE_ATTR);
    root.removeAttribute(POWER_MODE_ATTR);
    root.removeAttribute(PALETTE_ATTR);
  }
}
