/* 稳态动画速率通道：mascot-runtime 监听 SPEED_EVENT 做即时变速；设置页的写入
 * 走 StageHost 的 mount(stage, owner, speed) 路径（挂载时应用持久值）。这里保留
 * 事件名作为运行时的扩展点，控件本体已统一收进设置卡。 */
const SPEED_EVENT = 'dsh-fairy-mascot-animation-speed';

module.exports = { SPEED_EVENT };
