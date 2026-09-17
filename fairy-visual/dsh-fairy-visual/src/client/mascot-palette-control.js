// 大眼睛的调色盘设置项：三枚色块按钮（岩/墨/炭），与位置控件同款外观与写入路径。
//
// 调色盘语义：hdd=现值（属性缺省，DOM 不落属性）、ink=冷灰蓝、ember=暖炭。
// 属性落在 documentElement（html）上，由 CSS 令牌层（style.js 根块 + 覆写块）消费；
// 与主题轴（dark/light）正交——调色盘不碰 --dsw-alias-* 官方别名。
const CONTROL_ATTR = 'data-dsh-fairy-palette-control';
const BUTTON_ATTR = 'data-dsh-fairy-palette-button';
const SWATCH_ATTR = 'data-dsh-fairy-palette-swatch';
const PALETTE_ATTR = 'data-dsh-fairy-palette';
const PALETTES = ['hdd', 'ink', 'ember'];
const PALETTE_LABELS = { hdd: '岩', ink: '墨', ember: '炭' };
const { setControllerSetting, settingError } = require('./settings-write.js');

function normalizePalette(value) {
  return PALETTES.includes(value) ? value : 'hdd';
}

function applyPalette(value, documentRef = document) {
  const root = documentRef?.documentElement;
  if (!root?.setAttribute) return;
  const palette = normalizePalette(value);
  if (palette === 'hdd') root.removeAttribute(PALETTE_ATTR);
  else root.setAttribute(PALETTE_ATTR, palette);
}

/** 一行三色块：紧凑控件条，与位置控件同宽同高，锚在位置条下方。 */
function createMascotPaletteBase(host, controller, documentRef = document) {
  const shell = documentRef.createElement('div');
  shell.setAttribute(CONTROL_ATTR, 'true');
  shell.setAttribute('role', 'group');
  shell.setAttribute('aria-label', 'Fairy 调色盘');
  const buttons = new Map();
  const paint = (value) => {
    const current = normalizePalette(value);
    for (const [name, button] of buttons) {
      button.setAttribute('aria-pressed', String(name === current));
    }
  };
  for (const name of PALETTES) {
    const button = documentRef.createElement('button');
    button.type = 'button';
    button.setAttribute(BUTTON_ATTR, name);
    button.setAttribute(SWATCH_ATTR, name);
    button.setAttribute('aria-label', `Fairy 调色盘：${PALETTE_LABELS[name]}`);
    button.addEventListener('click', () => {
      applyPalette(name, documentRef);
      paint(name);
      setControllerSetting(controller, 'palette', name).catch((error) => {
        const current = normalizePalette(controller.getSnapshot?.().settings?.palette);
        applyPalette(current, documentRef);
        paint(current);
        console.warn('[fairy] 调色盘写入失败：', settingError('palette', error));
      });
    });
    buttons.set(name, button);
    shell.appendChild(button);
  }
  const off = controller.subscribe?.(() => {
    const next = normalizePalette(controller.getSnapshot?.().settings?.palette);
    applyPalette(next, documentRef);
    paint(next);
  });
  const initial = normalizePalette(controller.getSnapshot?.().settings?.palette);
  applyPalette(initial, documentRef);
  paint(initial);
  host?.appendChild?.(shell);
  return { node: shell, host, dispose: () => { off?.(); shell.remove?.(); } };
}

module.exports = {
  CONTROL_ATTR,
  BUTTON_ATTR,
  SWATCH_ATTR,
  PALETTE_ATTR,
  PALETTES,
  PALETTE_LABELS,
  normalizePalette,
  applyPalette,
  createMascotPaletteBase,
};
