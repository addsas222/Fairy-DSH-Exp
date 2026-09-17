// Lifecycle: pointer drag
// Owner: active pointer session
// Contract: lifecycle-ownership.json#owners[subsystem=pointer drag]
// Shared pointer-drag lifecycle. Business modules only provide the payload and
// geometry callbacks; this module owns capture, fallback listeners and cleanup.
const { createFairyDiagnostics } = require('../../../../fairy-contracts/client-diagnostics.cjs');

const diagnostics = createFairyDiagnostics('dsh-fairy-visual');

function createPointerDrag({ getTarget, getLockNodes = () => [], onStart, onMove, onEnd, onCancel }) {
  let active = null;
  let releaseFrame = 0;
  let pendingLockNodes = [];
  const documentRef = typeof document !== 'undefined' ? document : null;
  const scheduleFrame = (callback) => {
    if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(callback);
    return setTimeout(callback, 0);
  };
  const cancelFrame = (id) => {
    if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(id);
    else clearTimeout(id);
  };

  const cancelRelease = () => {
    if (!releaseFrame) return;
    cancelFrame(releaseFrame);
    releaseFrame = 0;
  };

  const releaseLocks = (nodes) => {
    cancelRelease();
    pendingLockNodes = nodes;
    const release = () => {
      releaseFrame = 0;
      nodes.forEach((node) => node?.removeAttribute('data-dragging'));
      if (pendingLockNodes === nodes) pendingLockNodes = [];
    };
    releaseFrame = scheduleFrame(release);
  };

  const releaseLocksImmediately = (nodes) => {
    nodes.forEach((node) => node?.removeAttribute('data-dragging'));
    if (pendingLockNodes === nodes) pendingLockNodes = [];
  };

  const removeWindowListeners = () => {
    window.removeEventListener('pointermove', onPointerMove, true);
    window.removeEventListener('pointerup', onPointerUp, true);
    window.removeEventListener('pointercancel', onPointerCancel, true);
    window.removeEventListener('blur', onWindowBlur, true);
    documentRef?.removeEventListener('visibilitychange', onDocumentVisibilityChange, true);
    window.removeEventListener('pagehide', onPageHide, true);
  };

  const finish = (event, commit, reason) => {
    if (!active) return false;
    const session = active;
    active = null;
    removeWindowListeners();
    try {
      if (commit) onEnd?.(event, session, reason);
      else onCancel?.(event, session, reason);
    } catch (error) {
      diagnostics.error('pointer-drag.finish', error, {});
    } finally {
      try {
        session.target?.releasePointerCapture?.(event?.pointerId ?? session.pointerId);
      } catch {
        // The owner may have been replaced during an official phase update.
      }
      releaseLocks(session.lockNodes);
    }
    return true;
  };

  const onPointerMove = (event) => {
    if (!active || event.pointerId !== active.pointerId) return;
    event.preventDefault();
    try {
      onMove?.(event, active);
    } catch (error) {
      diagnostics.error('pointer-drag.move', error, {});
      finish(event, false, 'error');
    }
  };

  const onPointerUp = (event) => {
    if (!active || event.pointerId !== active.pointerId) return;
    finish(event, true, 'pointerup');
  };

  const onPointerCancel = (event) => {
    if (!active || event.pointerId !== active.pointerId) return;
    finish(event, false, 'pointercancel');
  };

  const onWindowBlur = () => {
    finish(null, false, 'blur');
  };

  // A hidden page does not guarantee blur before an official slot is replaced.
  // End the shared capture session so global listeners and lock attributes do
  // not survive outside their visible owner.
  const onDocumentVisibilityChange = () => {
    if (documentRef?.visibilityState === 'hidden') finish(null, false, 'visibilitychange');
  };

  const onPageHide = () => {
    finish(null, false, 'pagehide');
  };

  const start = (event, payload) => {
    const target = getTarget();
    if (!target || (event.button != null && event.button !== 0)) return false;
    if (active) finish(null, false, 'replaced');
    cancelRelease();
    event.preventDefault();
    const lockNodes = [...new Set([target, ...getLockNodes()])].filter(Boolean);
    active = { pointerId: event.pointerId, target, payload, lockNodes };
    lockNodes.forEach((node) => node.setAttribute('data-dragging', 'true'));
    try {
      target.setPointerCapture?.(event.pointerId);
    } catch {
      // Window listeners remain the fallback when native capture is unavailable.
    }
    window.addEventListener('pointermove', onPointerMove, true);
    window.addEventListener('pointerup', onPointerUp, true);
    window.addEventListener('pointercancel', onPointerCancel, true);
    window.addEventListener('blur', onWindowBlur, true);
    documentRef?.addEventListener('visibilitychange', onDocumentVisibilityChange, true);
    window.addEventListener('pagehide', onPageHide, true);
    try {
      onStart?.(event, active);
    } catch (error) {
      diagnostics.error('pointer-drag.start', error, {});
      finish(event, false, 'error');
      return false;
    }
    return true;
  };

  const dispose = () => {
    const session = active;
    if (session) finish(null, false, 'dispose');
    cancelRelease();
    releaseLocksImmediately(session?.lockNodes || pendingLockNodes);
    removeWindowListeners();
  };

  return {
    start,
    finish,
    dispose,
    get active() { return active; },
  };
}

module.exports = { createPointerDrag };
