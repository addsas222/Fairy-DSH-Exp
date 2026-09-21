// 大眼睛调色盘「读数条」：三枚色块只显示当前皮肤（只读）。
//
// 属性管线不变：hdd=属性缺省（DOM 与既有状态一致）、ink/ember 落 data-dsh-fairy-palette，
// 由 CSS 令牌层消费；应用在 utils.syncDocumentMode（设置快照驱动）。控件本体（可改值）
// 在设置卡「HDD 视觉」的「皮肤（调色盘）」行；这里只摆出硬件条并标记当前项，
// 指针事件由样式层整体关闭。
const { PALETTES } = require('./constants.js');

const CONTROL_ATTR = 'data-dsh-fairy-palette-control';
const BUTTON_ATTR = 'data-dsh-fairy-palette-button';
const SWATCH_ATTR = 'data-dsh-fairy-palette-swatch';
const PALETTE_LABELS = { hdd: '岩', ink: '墨', ember: '炭' };

function normalizePalette(value) {
  return PALETTES.includes(value) ? value : 'hdd';
}

/** 一行三色块：显示当前调色盘，不响应点击。 */
function createMascotPaletteBase(host, controller, documentRef = document) {
  const shell = documentRef.createElement('div');
  shell.setAttribute(CONTROL_ATTR, 'true');
  shell.setAttribute('role', 'group');
  shell.setAttribute('aria-label', 'Fairy 调色盘（只读；在设置中修改）');
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
    button.tabIndex = -1;
    button.setAttribute(BUTTON_ATTR, name);
    button.setAttribute(SWATCH_ATTR, name);
    button.setAttribute('aria-label', `Fairy 调色盘：${PALETTE_LABELS[name]}`);
    buttons.set(name, button);
    shell.appendChild(button);
  }
  const off = controller.subscribe?.(() => paint(controller.getSnapshot?.().settings?.palette));
  paint(controller.getSnapshot?.().settings?.palette);
  host?.appendChild?.(shell);
  return { node: shell, host, dispose: () => { off?.(); shell.remove?.(); } };
}

module.exports = {
  CONTROL_ATTR,
  BUTTON_ATTR,
  SWATCH_ATTR,
  normalizePalette,
  createMascotPaletteBase,
};
