const ROOT_ID = 'dsh-fairy-root';

const MASCOT_SCALE_MIN = 0.55;
const MASCOT_SCALE_MAX = 1;
const MASCOT_SCALE_STEP = 0.01;
const MASCOT_SCALE_DEFAULT = 1;
const MASCOT_GEOMETRY_EVENT = 'dsh-fairy-mascot-geometry';

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

module.exports = {
  MASCOT_SCALE_MIN,
  MASCOT_SCALE_MAX,
  MASCOT_SCALE_STEP,
  MASCOT_SCALE_DEFAULT,
  MASCOT_GEOMETRY_EVENT,
  applyMascotScale,
  scheduleMascotScale,
};
