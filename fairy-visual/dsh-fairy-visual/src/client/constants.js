export const SETTINGS_NAMESPACE = 'fairy-visual';
export const STYLE_ID = 'dsh-fairy-visual-style';
export const MODE_ATTR = 'data-dsh-fairy-mode';
export const POWER_MODE_ATTR = 'data-dsh-fairy-power-mode';
export const THEME_ATTR = 'data-dsh-fairy-theme';
export const PALETTE_ATTR = 'data-dsh-fairy-palette';
export const PALETTES = Object.freeze(['hdd', 'ink', 'ember']);
// 大眼睛位置：九宫格锚点（设置卡选项用同一份清单与标签）。属性落在吉祥物根
// （#dsh-fairy-root）上，由 CSS 把锚点翻译成内层 float 的 translate 位移。
export const MASCOT_POSITION_ATTR = 'data-dsh-fairy-mascot-position';
export const MASCOT_POSITIONS = Object.freeze([
  'top-left', 'top-center', 'top-right',
  'middle-left', 'center', 'middle-right',
  'bottom-left', 'bottom-center', 'bottom-right',
]);
export const MASCOT_POSITION_LABELS = Object.freeze({
  'top-left': '左上', 'top-center': '中上', 'top-right': '右上',
  'middle-left': '左中', 'center': '居中', 'middle-right': '右中',
  'bottom-left': '左下', 'bottom-center': '中下', 'bottom-right': '右下',
});
export const POWER_TOGGLE_WIDTH = 82;
export const POWER_TOGGLE_HEIGHT = 22;

export const DEFAULT = {
  version: 2,
  enabled: false,
  theme: 'dark',
  mascotVisible: true,
  contentFade: false,
  mascotScale: 1,
  mascotAnimationSpeed: 1,
  // 大眼睛位置：九宫格锚点，默认居中（= 既有无位移观感）。客户端默认表必须列全，
  // 否则写入会被判非法字段而被丢弃（实测：点击控件属性不生效）。
  mascotPosition: 'center',
  // 调色盘（palette）：hdd=现值（属性缺省，默认零变化），ink=冷灰蓝，ember=暖炭。
  palette: 'hdd',
  powerMode: 'normal',
  composerDockHeight: 132
};

export const HERO_PLACEHOLDERS = [
  '您拨打的用户正在空洞中。', '不要进入空洞。', '至少，不要"独自"进入空洞。',
  '世界全剧终，欢迎来到新艾利都。', '新艾利都永不落幕。', '遇到困难，请联系新艾利都治安局。',
  '我们能斩断罪恶，我们能劈开天空。', '我们能走出迷雾，我们能迈向真理……', '奇迹的起点',
  '新·艾利都日落时', '祝你好运。', '英雄不死于往昔', '拜托了，艾莲大人！',
  '目标确认，开始行动。', 'Random Play营业中', '切勿独行', '内有恶犬', '早安，罗斯凯利法',
  '认真「记仇」中！', '骑士登场！（典藏版）',
];
