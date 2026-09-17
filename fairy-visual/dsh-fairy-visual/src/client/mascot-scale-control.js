const CONTROL_ATTR = 'data-dsh-fairy-mascot-scale-control';
const BASE_ATTR = 'data-dsh-fairy-mascot-scale-base';
const INPUT_ATTR = 'data-dsh-fairy-mascot-scale-input';
const ROOT_ID = 'dsh-fairy-root';

const MASCOT_SCALE_MIN = 0.55;
const MASCOT_SCALE_MAX = 1;
const MASCOT_SCALE_STEP = 0.01;
const MASCOT_SCALE_DEFAULT = 1;
const MASCOT_GEOMETRY_EVENT = 'dsh-fairy-mascot-geometry';

function scaleProgress(value) {
  return ((clampScale(value) - MASCOT_SCALE_MIN) / (MASCOT_SCALE_MAX - MASCOT_SCALE_MIN)) * 100;
}

function clampScale(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return MASCOT_SCALE_DEFAULT;
  const stepped = Math.round(numeric / MASCOT_SCALE_STEP) * MASCOT_SCALE_STEP;
  return Math.min(MASCOT_SCALE_MAX, Math.max(MASCOT_SCALE_MIN, Number(stepped.toFixed(2))));
}

function mascotRoot(documentRef = document) {
  return documentRef?.getElementById(ROOT_ID) || null;
}

function notifyMascotGeometry(documentRef = document, scale = MASCOT_SCALE_DEFAULT) {
  const target = documentRef?.defaultView || (typeof window !== 'undefined' ? window : null);
  if (!target?.dispatchEvent || typeof CustomEvent !== 'function') return;
  target.dispatchEvent(new CustomEvent(MASCOT_GEOMETRY_EVENT, {
    detail: { scale },
  }));
}

// The stage itself owns an entrance transform. Scaling the inner float keeps
// that transition and the root's layout box untouched. The origin is measured
// from the actual outer disc, so the current top vertex remains stationary.
function applyMascotScale(value, documentRef = document) {
  const root = mascotRoot(documentRef);
  const float = root?.querySelector('.dsh-fairy-float');
  const eye = root?.querySelector('.dsh-fairy-outer-disc');
  if (!root || !float || !eye) return false;

  const scale = clampScale(value);
  float.style.transform = 'none';
  const floatRect = float.getBoundingClientRect();
  const eyeRect = eye.getBoundingClientRect();
  const layoutWidth = float.offsetWidth || floatRect.width || 1;
  const layoutHeight = float.offsetHeight || floatRect.height || 1;
  const viewportScaleX = floatRect.width / layoutWidth || 1;
  const viewportScaleY = floatRect.height / layoutHeight || 1;
  const originX = (eyeRect.left + eyeRect.width * 0.5 - floatRect.left) / viewportScaleX;
  const originY = (eyeRect.top - floatRect.top) / viewportScaleY;

  float.style.transformOrigin = `${originX.toFixed(2)}px ${originY.toFixed(2)}px`;
  float.style.transform = `scale(${scale})`;
  root.style.setProperty('--dsh-fairy-mascot-scale', String(scale));
  root.setAttribute('data-dsh-fairy-mascot-scale', String(scale));
  // CSS transforms do not change layout size, so ResizeObserver cannot tell
  // the content fade that the eye's rendered perimeter moved. Notify the
  // geometry owner after the transform write.
  notifyMascotGeometry(documentRef, scale);
  return true;
}

function scheduleMascotScale(value, documentRef = document) {
  let frame = 0;
  let attempts = 0;
  const run = () => {
    frame = 0;
    if (applyMascotScale(value, documentRef) || attempts++ >= 24) return;
    frame = requestAnimationFrame(run);
  };
  run();
  return () => { if (frame) cancelAnimationFrame(frame); };
}

// 读数条：滑杆只显示当前大小（设置卡是唯一控制面），不监听任何输入事件；
// 指针事件由样式层（pointer-events:none）整体关闭。
function createMascotScaleControl(host, controller, documentRef = document) {
  if (!host || !controller) return null;
  const existing = host.querySelector(`[${CONTROL_ATTR}="true"]`);
  if (existing) return { host, node: existing, dispose() {} };

  const shell = documentRef.createElement('span');
  shell.setAttribute(CONTROL_ATTR, 'true');
  shell.setAttribute('role', 'group');
  shell.setAttribute('aria-label', 'Fairy 眼睛大小（只读；在设置中修改）');

  const input = documentRef.createElement('input');
  input.type = 'range';
  input.tabIndex = -1;
  input.setAttribute(INPUT_ATTR, 'true');
  input.min = String(MASCOT_SCALE_MIN);
  input.max = String(MASCOT_SCALE_MAX);
  input.step = String(MASCOT_SCALE_STEP);
  input.setAttribute('aria-label', 'Fairy 眼睛大小');
  shell.appendChild(input);
  host.appendChild(shell);

  const updateInput = (value) => {
    const scale = clampScale(value);
    input.value = String(scale);
    const progress = `${scaleProgress(scale).toFixed(2)}%`;
    input.style.setProperty('--dsh-fairy-scale', progress);
    shell.style.setProperty('--dsh-fairy-scale', progress);
    input.setAttribute('aria-valuetext', `${Math.round(scale * 100)}%`);
    input.title = `Fairy 眼睛大小 ${Math.round(scale * 100)}%`;
  };
  const off = controller.subscribe?.(() => updateInput(controller.getSnapshot?.().settings?.mascotScale));
  updateInput(controller.getSnapshot?.().settings?.mascotScale);

  return {
    host,
    node: shell,
    dispose() {
      off?.();
      shell.remove();
    },
  };
}

// The outer shell owns the existing Fairy hardware material. The read-only
// gauge is mounted inside it so its inset is measured from one stable box.
function createMascotScaleBase(host, controller, documentRef = document) {
  if (!host) return null;
  const existing = host.querySelector?.(`[${BASE_ATTR}="true"]`);
  if (existing) {
    existing.removeAttribute('aria-hidden');
    const control = controller && !existing.querySelector(`[${CONTROL_ATTR}="true"]`)
      ? createMascotScaleControl(existing, controller, documentRef)
      : null;
    return {
      host,
      node: existing,
      dispose() { control?.dispose?.(); },
    };
  }

  const shell = documentRef.createElement('span');
  shell.setAttribute(BASE_ATTR, 'true');
  host.appendChild(shell);
  const control = controller ? createMascotScaleControl(shell, controller, documentRef) : null;
  return {
    host,
    node: shell,
    dispose() {
      control?.dispose?.();
      if (shell.parentElement === host) shell.remove();
    },
  };
}

module.exports = {
  MASCOT_SCALE_MIN,
  MASCOT_SCALE_MAX,
  MASCOT_SCALE_STEP,
  MASCOT_SCALE_DEFAULT,
  MASCOT_GEOMETRY_EVENT,
  applyMascotScale,
  scheduleMascotScale,
  createMascotScaleBase,
  createMascotScaleControl,
};
