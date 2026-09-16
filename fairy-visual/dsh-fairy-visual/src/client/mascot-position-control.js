// 大眼睛的位置设置项：九宫格锚点 + 一行紧凑控件（与缩放/速度控件同款外观与写入路径）。
//
// 位置语义：宿主（官方品牌槽位）负责把舞台固定在页面某处，我们只在其内部移动眼睛本身，
// 所以实现是给吉祥物根打 `data-dsh-fairy-mascot-position="<anchor>"`，由 CSS 把锚点翻译成
// 内层 `.dsh-fairy-float` 的 `translate` 位移——不动布局盒、不碰宿主的固定定位，
// 也就不需要像缩放那样广播几何事件。
const CONTROL_ATTR = 'data-dsh-fairy-mascot-position-control';
const BUTTON_ATTR = 'data-dsh-fairy-mascot-position-button';
const ROOT_ID = 'dsh-fairy-root';

const MASCOT_POSITION_ATTR = 'data-dsh-fairy-mascot-position';
const MASCOT_POSITIONS = [
  'top-left', 'top-center', 'top-right',
  'middle-left', 'center', 'middle-right',
  'bottom-left', 'bottom-center', 'bottom-right',
];
const MASCOT_POSITION_DEFAULT = 'center';
const MASCOT_POSITION_LABELS = {
  'top-left': '左上', 'top-center': '中上', 'top-right': '右上',
  'middle-left': '左中', 'center': '居中', 'middle-right': '右中',
  'bottom-left': '左下', 'bottom-center': '中下', 'bottom-right': '右下',
};
const { setControllerSetting, settingError } = require('./settings-write.js');

function normalizeMascotPosition(value) {
  return MASCOT_POSITIONS.includes(value) ? value : MASCOT_POSITION_DEFAULT;
}

function mascotRoot(documentRef = document) {
  return documentRef?.getElementById(ROOT_ID) || null;
}

function applyMascotPosition(value, documentRef = document) {
  const root = mascotRoot(documentRef);
  if (!root?.setAttribute) return;
  root.setAttribute(MASCOT_POSITION_ATTR, normalizeMascotPosition(value));
}

/** 一行九格：紧凑控件条，与缩放/速度控件同宽同高，塞得进 composer 卡片。 */
function createMascotPositionBase(host, controller, documentRef = document) {
  const shell = documentRef.createElement('div');
  shell.setAttribute(CONTROL_ATTR, 'true');
  shell.setAttribute('role', 'group');
  shell.setAttribute('aria-label', 'Fairy 眼睛位置');
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
    button.setAttribute(BUTTON_ATTR, anchor);
    button.setAttribute('aria-label', `Fairy 眼睛位置：${MASCOT_POSITION_LABELS[anchor]}`);
    button.textContent = MASCOT_POSITION_LABELS[anchor].slice(-1);
    button.addEventListener('click', () => {
      applyMascotPosition(anchor, documentRef);
      paint(anchor);
      setControllerSetting(controller, 'mascotPosition', anchor).catch((error) => {
        const current = normalizeMascotPosition(controller.getSnapshot?.().settings?.mascotPosition);
        applyMascotPosition(current, documentRef);
        paint(current);
        console.warn('[fairy] 眼睛位置写入失败：', settingError('mascotPosition', error));
      });
    });
    buttons.set(anchor, button);
    shell.appendChild(button);
  }
  const off = controller.subscribe?.(() => {
    const next = normalizeMascotPosition(controller.getSnapshot?.().settings?.mascotPosition);
    applyMascotPosition(next, documentRef);
    paint(next);
  });
  const initial = normalizeMascotPosition(controller.getSnapshot?.().settings?.mascotPosition);
  applyMascotPosition(initial, documentRef);
  paint(initial);
  host?.appendChild?.(shell);
  return { node: shell, host, dispose: () => { off?.(); shell.remove?.(); } };
}

module.exports = {
  CONTROL_ATTR,
  BUTTON_ATTR,
  MASCOT_POSITION_ATTR,
  MASCOT_POSITIONS,
  MASCOT_POSITION_DEFAULT,
  MASCOT_POSITION_LABELS,
  normalizeMascotPosition,
  applyMascotPosition,
  createMascotPositionBase,
};
