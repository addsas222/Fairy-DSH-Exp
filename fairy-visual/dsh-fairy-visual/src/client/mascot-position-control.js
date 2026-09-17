// 大眼睛位置「读数条」：九宫格锚点只显示当前设置（只读）。
//
// 定位语义不变：锚点作用于吉祥物根（#dsh-fairy-root）的 data-dsh-fairy-mascot-position，
// 由 CSS 翻译成内层 float 的 translate 位移——应用在 utils.applyMascotPosition（设置快照驱动）；
// 控件本体（可改值）在设置卡「HDD 视觉与 Fairy 身份」。这里只负责在作曲栏摆出硬件条、
// 点亮当前锚点；指针事件由样式层整体关闭。
const { MASCOT_POSITION_LABELS, MASCOT_POSITIONS } = require('./constants.js');

const CONTROL_ATTR = 'data-dsh-fairy-mascot-position-control';
const BUTTON_ATTR = 'data-dsh-fairy-mascot-position-button';
const MASCOT_POSITION_DEFAULT = 'center';

function normalizeMascotPosition(value) {
  return MASCOT_POSITIONS.includes(value) ? value : MASCOT_POSITION_DEFAULT;
}

/** 一行九格：显示当前锚点，不响应点击。 */
function createMascotPositionBase(host, controller, documentRef = document) {
  const shell = documentRef.createElement('div');
  shell.setAttribute(CONTROL_ATTR, 'true');
  shell.setAttribute('role', 'group');
  shell.setAttribute('aria-label', 'Fairy 眼睛位置（只读；在设置中修改）');
  const buttons = new Map();
  const paint = (value) => {
    const current = normalizeMascotPosition(value);
    for (const [anchor, button] of buttons) {
      button.setAttribute('aria-pressed', String(anchor === current));
    }
  };
  for (const anchor of MASCOT_POSITIONS) {
    const button = documentRef.createElement('button');
    button.type = 'button';
    button.tabIndex = -1;
    button.setAttribute(BUTTON_ATTR, anchor);
    button.setAttribute('aria-label', `Fairy 眼睛位置：${MASCOT_POSITION_LABELS[anchor]}`);
    button.textContent = MASCOT_POSITION_LABELS[anchor].slice(-1);
    buttons.set(anchor, button);
    shell.appendChild(button);
  }
  const off = controller.subscribe?.(() => paint(controller.getSnapshot?.().settings?.mascotPosition));
  paint(controller.getSnapshot?.().settings?.mascotPosition);
  host?.appendChild?.(shell);
  return { node: shell, host, dispose: () => { off?.(); shell.remove?.(); } };
}

module.exports = {
  CONTROL_ATTR,
  BUTTON_ATTR,
  normalizeMascotPosition,
  createMascotPositionBase,
};
