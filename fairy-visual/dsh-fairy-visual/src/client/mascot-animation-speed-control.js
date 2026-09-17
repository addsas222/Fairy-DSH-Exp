const BASE_ATTR = 'data-dsh-fairy-mascot-animation-speed-base';
const CONTROL_ATTR = 'data-dsh-fairy-mascot-animation-speed-control';
const TICK_ATTR = 'data-dsh-fairy-mascot-animation-speed-tick';
const THUMB_ATTR = 'data-dsh-fairy-mascot-animation-speed-thumb';
const POSITION_ATTR = 'data-dsh-fairy-mascot-animation-speed-position';
const SPEED_EVENT = 'dsh-fairy-mascot-animation-speed';
const SPEED_STOPS = Object.freeze([
  Object.freeze({ position: 0, rate: 0.7, label: '0.7' }),
  Object.freeze({ position: 0.5, rate: 1, label: '1' }),
  Object.freeze({ position: 1, rate: 1.5, label: '1.5' }),
]);

function positionForRate(rate) {
  const match = SPEED_STOPS.find((stop) => stop.rate === rate);
  return match?.position ?? 0.5;
}

/* 稳态动画速率通道：mascot-runtime 监听 SPEED_EVENT 做即时变速；设置页的写入
 * 走 StageHost 的 mount(stage, owner, speed) 路径（挂载时应用持久值）。
 *
 * 读数条：拇指停在设置选中的档位上，不监听指针；设置卡是唯一控制面，
 * 指针事件由样式层（pointer-events:none）整体关闭。 */
function createMascotAnimationSpeedBase(host, controller, documentRef = document) {
  if (!host) return null;

  const build = () => {
    const base = documentRef.createElement('span');
    base.setAttribute(BASE_ATTR, 'true');
    base.setAttribute('aria-hidden', 'true');
    const control = documentRef.createElement('span');
    control.setAttribute(CONTROL_ATTR, 'true');
    ['0.7', '1', '1.5'].forEach((speed) => {
      const tick = documentRef.createElement('span');
      tick.setAttribute(TICK_ATTR, speed);
      tick.setAttribute('aria-hidden', 'true');
      control.appendChild(tick);
    });
    const thumb = documentRef.createElement('span');
    thumb.setAttribute(THUMB_ATTR, '1');
    thumb.setAttribute('aria-hidden', 'true');
    control.appendChild(thumb);
    base.appendChild(control);
    return { base, control };
  };

  const existing = host.querySelector?.(`[${BASE_ATTR}="true"]`);
  const pair = existing ? { base: existing, control: existing.querySelector(`[${CONTROL_ATTR}="true"]`) } : build();
  if (!pair.control) {
    const made = build();
    pair.control = made.control;
    pair.base.appendChild(pair.control);
  }
  if (pair.base.parentElement !== host) host.appendChild(pair.base);

  const paint = () => pair.control.setAttribute(
    POSITION_ATTR,
    String(positionForRate(controller?.getSnapshot?.().settings?.mascotAnimationSpeed)),
  );
  const off = controller?.subscribe?.(paint);
  paint();

  return {
    host,
    node: pair.base,
    dispose() { off?.(); if (pair.base.parentElement === host) pair.base.remove(); },
  };
}

module.exports = { BASE_ATTR, CONTROL_ATTR, TICK_ATTR, THUMB_ATTR, POSITION_ATTR, SPEED_EVENT, SPEED_STOPS, createMascotAnimationSpeedBase };
