// Small, dependency-free ownership primitive for Fairy Visual effects.
// Every registration is paired with one reverse-order disposer. The registries
// are module-local and never leak state onto window or the official runtime.

const { createFairyDiagnostics } = require('../../../../fairy-contracts/client-diagnostics.cjs');

const diagnostics = createFairyDiagnostics('dsh-fairy-visual');

const singletonOwners = new WeakMap();

function createLifecycleScope(name = 'fairy-visual') {
  let disposed = false;
  const cleanups = [];
  const cleanupLabels = new WeakMap();
  const rafs = new Set();
  const timers = new Set();
  const intervals = new Set();
  const abortControllers = new Set();
  const keyedRafs = new Map();
  const bindings = new Map();

  const removeCleanup = (cleanup) => {
    const index = cleanups.indexOf(cleanup);
    if (index >= 0) cleanups.splice(index, 1);
  };

  const add = (cleanup, label = null) => {
    if (typeof cleanup !== 'function') return cleanup;
    if (disposed) {
      cleanup();
      return cleanup;
    }
    if (typeof label === 'string' && label.trim()) cleanupLabels.set(cleanup, label.trim());
    cleanups.push(cleanup);
    return cleanup;
  };

  const registrationOptions = (options, explicitLabel = null) => {
    if (!options || typeof options !== 'object' || !Object.prototype.hasOwnProperty.call(options, 'label')) {
      return { nativeOptions: options, label: explicitLabel };
    }
    const { label, ...nativeOptions } = options;
    return {
      nativeOptions: Object.keys(nativeOptions).length ? nativeOptions : undefined,
      label: explicitLabel ?? label,
    };
  };

  const on = (target, type, listener, options, label = null) => {
    if (!target?.addEventListener) return () => {};
    const { nativeOptions, label: registrationLabel } = registrationOptions(options, label);
    target.addEventListener(type, listener, nativeOptions);
    return add(() => target.removeEventListener(type, listener, nativeOptions), registrationLabel || `event:${type}`);
  };

  const observe = (observer, target, options, label = null) => {
    if (!observer || !target) return () => {};
    const { nativeOptions, label: registrationLabel } = registrationOptions(options, label);
    observer.observe(target, nativeOptions);
    return add(() => observer.disconnect(), registrationLabel || 'observer');
  };

  const frame = (callback, label = null) => {
    if (disposed) return 0;
    const request = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : setTimeout;
    const cancel = typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame : clearTimeout;
    let cleanup = null;
    const id = request(() => {
      rafs.delete(id);
      removeCleanup(cleanup);
      if (!disposed) callback();
    });
    rafs.add(id);
    cleanup = () => {
      if (!rafs.delete(id)) return;
      cancel(id);
      removeCleanup(cleanup);
    };
    add(cleanup, label || 'frame');
    return id;
  };

  const scheduleFrame = (key, callback, label = null) => {
    if (disposed) return 0;
    const pending = keyedRafs.get(key);
    if (pending) {
      // Multiple observers may publish different closures before the same
      // frame. Keep one frame, but always run the newest closure.
      pending.callback = callback;
      return pending.id;
    }
    const record = { id: 0, callback };
    const id = frame(() => {
      keyedRafs.delete(key);
      record.callback();
    }, label || `frame:${key}`);
    record.id = id;
    keyedRafs.set(key, record);
    return id;
  };

  const timeout = (callback, delay, label = null) => {
    if (disposed) return 0;
    let cleanup = null;
    const id = setTimeout(() => {
      timers.delete(id);
      removeCleanup(cleanup);
      if (!disposed) callback();
    }, delay);
    timers.add(id);
    cleanup = () => {
      if (!timers.delete(id)) return;
      clearTimeout(id);
      removeCleanup(cleanup);
    };
    add(cleanup, label || 'timeout');
    return id;
  };

  const interval = (callback, delay, label = null) => {
    if (disposed) return 0;
    const id = setInterval(() => {
      if (!disposed) callback();
    }, delay);
    intervals.add(id);
    add(() => {
      if (!intervals.delete(id)) return;
      clearInterval(id);
    }, label || 'interval');
    return id;
  };

  // Browser APIs that accept AbortSignal stay within the same ownership
  // boundary as listeners, observers, frames and timers.
  const abortController = (label = null) => {
    const controller = new AbortController();
    abortControllers.add(controller);
    add(() => {
      if (!abortControllers.delete(controller)) return;
      controller.abort();
    }, label || 'abort-controller');
    return controller;
  };

  // A binding represents resources attached to a replaceable official node.
  // Replacing it tears down the previous node before the new one is observed.
  const replaceBinding = (key, cleanup, label = null) => {
    const previous = bindings.get(key);
    previous?.();
    bindings.delete(key);
    if (typeof cleanup !== 'function') return cleanup;
    // A disposed scope cannot retain a new binding. Run its disposer now so
    // callers that race with teardown do not leak listeners or observers.
    if (disposed) {
      let active = true;
      const disposeImmediately = () => {
        if (!active) return;
        active = false;
        cleanup();
      };
      disposeImmediately();
      return disposeImmediately;
    }
    let active = true;
    const binding = () => {
      if (!active) return;
      active = false;
      if (bindings.get(key) === binding) bindings.delete(key);
      removeCleanup(binding);
      cleanup();
    };
    bindings.set(key, binding);
    add(binding, label || `binding:${key}`);
    return binding;
  };

  const inspect = () => cleanups.map((cleanup, index) => ({
    index,
    label: cleanupLabels.get(cleanup) || '(unlabeled)',
    hasCustomName: cleanup.name !== '' && cleanup.name !== 'cleanup',
  }));

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    [...rafs].forEach((id) => {
      if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(id);
      else clearTimeout(id);
    });
    [...timers].forEach((id) => clearTimeout(id));
    [...intervals].forEach((id) => clearInterval(id));
    [...abortControllers].forEach((controller) => controller.abort());
    rafs.clear();
    keyedRafs.clear();
    bindings.clear();
    timers.clear();
    intervals.clear();
    abortControllers.clear();
    while (cleanups.length) {
      const cleanup = cleanups.pop();
      try { cleanup?.(); } catch (error) { diagnostics.error('lifecycle.cleanup', error, { owner: name }); }
    }
  };

  return {
    get disposed() { return disposed; },
    add,
    on,
    observe,
    frame,
    scheduleFrame,
    timeout,
    interval,
    abortController,
    replaceBinding,
    inspect,
    dispose,
  };
}

function claimSingleton(owner, key, scope) {
  if (!owner || !key || !scope) return scope;
  const existing = singletonOwners.get(owner)?.get(key);
  existing?.dispose?.();
  let entries = singletonOwners.get(owner);
  if (!entries) {
    entries = new Map();
    singletonOwners.set(owner, entries);
  }
  entries.set(key, scope);
  scope.add(() => {
    if (entries.get(key) === scope) entries.delete(key);
    if (!entries.size) singletonOwners.delete(owner);
  }, `singleton:${key}`);
  return scope;
}

module.exports = { createLifecycleScope, claimSingleton };
