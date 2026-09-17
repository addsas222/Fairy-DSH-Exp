// Fairy Visual owns many replaceable official DOM surfaces, but they all live
// below one stable document.body. Virtual observers preserve each subsystem's
// callback and target semantics while sharing one native body observer.

const { createFairyDiagnostics } = require('../../../../fairy-contracts/client-diagnostics.cjs');

const managers = new WeakMap();
const diagnostics = createFairyDiagnostics('dsh-fairy-visual');

function containsTarget(root, target, subtree) {
  if (root === target) return true;
  return subtree === true && Boolean(root?.contains?.(target));
}

function acceptsRecord(subscription, record) {
  const options = subscription.options;
  if (!containsTarget(subscription.target, record.target, options.subtree)) return false;
  if (record.type === 'childList') return options.childList === true;
  if (record.type === 'characterData') return options.characterData === true;
  if (record.type !== 'attributes' || options.attributes !== true) return false;
  return !options.attributeFilter?.length || options.attributeFilter.includes(record.attributeName);
}

function createDomObserverManager(documentRef) {
  const subscriptions = new Set();
  const subscriptionsByTarget = new WeakMap();
  const frameCallbacks = new Map();
  let bodyObserver = null;
  let rootObserver = null;
  let frame = 0;
  let callbackCount = 0;
  let deliveredRecordCount = 0;
  let suspended = false;

  const dispatch = (records, rootOnly) => {
    callbackCount += 1;
    deliveredRecordCount += records.length;
    // Set iteration preserves registration order, matching independent native
    // observers created in the same order while avoiding repeated DOM passes.
    subscriptions.forEach((subscription) => {
      if (!subscription.active || subscription.rootOnly !== rootOnly) return;
      const accepted = records.filter((record) => acceptsRecord(subscription, record));
      if (!accepted.length) return;
      const startedAt = diagnostics.start();
      try {
        subscription.callback(accepted, subscription.virtualObserver);
      } catch (error) {
        diagnostics.error('observer.callback', error, { record_count: accepted.length, root_only: rootOnly });
        // Native MutationObservers report callback failures without preventing
        // other observers in the same microtask from receiving their records.
        if (typeof reportError === 'function') reportError(error);
        else setTimeout(() => { throw error; }, 0);
      } finally {
        diagnostics.metric('observer.callback', startedAt, { record_count: accepted.length, root_only: rootOnly }, { thresholdMs: 8 });
      }
    });
  };

  const mergedOptions = (entries) => {
    const attributeEntries = entries.filter((entry) => entry.options.attributes);
    const observesAllAttributes = attributeEntries.some((entry) => !entry.options.attributeFilter?.length);
    const filters = new Set(attributeEntries.flatMap((entry) => entry.options.attributeFilter || []));
    return {
      childList: entries.some((entry) => entry.options.childList),
      subtree: entries.some((entry) => entry.options.subtree),
      attributes: attributeEntries.length > 0,
      ...(!observesAllAttributes && filters.size ? { attributeFilter: [...filters] } : {}),
      characterData: entries.some((entry) => entry.options.characterData),
    };
  };

  const rebuildObserver = (rootOnly) => {
    if (!rootOnly && suspended) {
      bodyObserver?.disconnect();
      bodyObserver = null;
      return;
    }
    const entries = [...subscriptions].filter((entry) => entry.active && entry.rootOnly === rootOnly);
    let observer = rootOnly ? rootObserver : bodyObserver;
    observer?.disconnect();
    if (!entries.length || typeof MutationObserver !== 'function') {
      if (rootOnly) rootObserver = null;
      else bodyObserver = null;
      return;
    }
    if (!observer) observer = new MutationObserver((records) => dispatch(records, rootOnly));
    const entriesByTarget = new Map();
    entries.forEach((entry) => {
      const targetEntries = entriesByTarget.get(entry.target) || [];
      targetEntries.push(entry);
      entriesByTarget.set(entry.target, targetEntries);
    });
    entriesByTarget.forEach((targetEntries, target) => observer.observe(target, mergedOptions(targetEntries)));
    if (rootOnly) rootObserver = observer;
    else bodyObserver = observer;
  };

  const removeSubscription = (subscription) => {
    if (!subscription.active) return;
    subscription.active = false;
    subscriptions.delete(subscription);
    subscriptionsByTarget.get(subscription.target)?.delete(subscription);
    rebuildObserver(subscription.rootOnly);
  };

  const observe = (virtualObserver, target, options = {}) => {
    if (!target || typeof options !== 'object') throw new TypeError('MutationObserver target and options are required');
    const normalized = {
      childList: options.childList === true,
      subtree: options.subtree === true,
      attributes: options.attributes === true || Array.isArray(options.attributeFilter),
      attributeFilter: Array.isArray(options.attributeFilter) ? [...new Set(options.attributeFilter)] : null,
      characterData: options.characterData === true,
    };
    if (!normalized.childList && !normalized.attributes && !normalized.characterData) {
      throw new TypeError('MutationObserver requires childList, attributes, or characterData');
    }
    const previous = virtualObserver._subscriptions.get(target);
    if (previous) removeSubscription(previous);
    const rootOnly = target === documentRef.documentElement && normalized.subtree !== true;
    const subscription = { active: true, callback: virtualObserver._callback, options: normalized, rootOnly, target, virtualObserver };
    virtualObserver._subscriptions.set(target, subscription);
    subscriptions.add(subscription);
    let targetSubscriptions = subscriptionsByTarget.get(target);
    if (!targetSubscriptions) {
      targetSubscriptions = new Set();
      subscriptionsByTarget.set(target, targetSubscriptions);
    }
    targetSubscriptions.add(subscription);
    rebuildObserver(rootOnly);
  };

  const disconnect = (virtualObserver) => {
    [...virtualObserver._subscriptions.values()].forEach(removeSubscription);
    virtualObserver._subscriptions.clear();
  };

  const scheduleFrame = (key, callback) => {
    frameCallbacks.set(key, callback);
    if (!frame) {
      frame = requestAnimationFrame(() => {
        frame = 0;
        const callbacks = [...frameCallbacks.values()];
        frameCallbacks.clear();
        callbacks.forEach((run) => run());
      });
    }
    return frame;
  };

  const cancelFrame = (key) => {
    frameCallbacks.delete(key);
    if (!frameCallbacks.size && frame) {
      cancelAnimationFrame(frame);
      frame = 0;
    }
  };

  return {
    observe,
    disconnect,
    scheduleFrame,
    cancelFrame,
    suspend() {
      if (suspended) return;
      suspended = true;
      rebuildObserver(false);
    },
    resume() {
      if (!suspended) return;
      suspended = false;
      rebuildObserver(false);
    },
    inspect() {
      return {
        nativeObserverCount: Number(Boolean(bodyObserver)) + Number(Boolean(rootObserver)),
        bodyObserverCount: Number(Boolean(bodyObserver)),
        rootObserverCount: Number(Boolean(rootObserver)),
        subscriptionCount: subscriptions.size,
        callbackCount,
        deliveredRecordCount,
        pendingFrameCount: frameCallbacks.size,
        suspended,
      };
    },
  };
}

function getDomObserverManager(documentRef = document) {
  let manager = managers.get(documentRef);
  if (!manager) {
    manager = createDomObserverManager(documentRef);
    managers.set(documentRef, manager);
  }
  return manager;
}

function createManagedMutationObserver(callback, documentRef = document) {
  if (typeof callback !== 'function') throw new TypeError('MutationObserver callback must be a function');
  const manager = getDomObserverManager(documentRef);
  return {
    _callback: callback,
    _subscriptions: new Map(),
    observe(target, options) { manager.observe(this, target, options); },
    disconnect() { manager.disconnect(this); },
    takeRecords() { return []; },
  };
}

module.exports = { createDomObserverManager, getDomObserverManager, createManagedMutationObserver };
