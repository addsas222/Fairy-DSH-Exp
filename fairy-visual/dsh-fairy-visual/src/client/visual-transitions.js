const diagnostics = {
  start: () => typeof performance === 'object' && performance?.now ? performance.now() : Date.now(),
  metric(operation, startedAt, context = {}) {
    const clock = typeof performance === 'object' && performance?.now ? performance.now() : Date.now();
    console.info(`DSH_FAIRY_LOG ${JSON.stringify({ schema: 1, timestamp: new Date().toISOString(), level: 'info', module: 'dsh-fairy-visual', operation, event: 'metric', context, duration_ms: Number((clock - startedAt).toFixed(3)) })}`);
  },
  warn(operation, context = {}, error) {
    console.warn(`DSH_FAIRY_LOG ${JSON.stringify({ schema: 1, timestamp: new Date().toISOString(), level: 'warn', module: 'dsh-fairy-visual', operation, event: 'failure', context, error: { name: String(error?.name || 'Error'), message: String(error?.message || error).slice(0, 320) } })}`);
  },
};

function createVisualTransitions({ rootSlot, modeAttr, conversation, anyPhase, composerSeat, composerCard }) {
  const FAIRY_CONTAINER_ID = 'dsh-fairy-plugin-container';
  const FAIRY_CONTAINER_STYLE = 'position:fixed;inset:0;pointer-events:none;z-index:2147483000;';
  const THEME_TRANSITION_DURATION_MS = 480;
  let fairyContainer = null;
  let cloneIdSeed = 0;
  const clonedElementLists = new WeakMap();

  function collectElements(root) {
    return clonedElementLists.get(root) || [root, ...root.querySelectorAll('*')];
  }

  function isDescendantOf(node, ancestor) {
    for (let parent = node?.parentElement || node?.parentNode; parent; parent = parent.parentElement || parent.parentNode) {
      if (parent === ancestor) return true;
    }
    return false;
  }

  function hasClass(node, name) {
    return String(node?.getAttribute?.('class') || '').split(/\s+/).includes(name);
  }

  function ensureFairyContainer() {
    if (!fairyContainer || !fairyContainer.isConnected) {
      fairyContainer = document.getElementById(FAIRY_CONTAINER_ID);
      if (!fairyContainer || !fairyContainer.isConnected) {
        fairyContainer = document.createElement('div');
        fairyContainer.id = FAIRY_CONTAINER_ID;
        fairyContainer.setAttribute('data-fairy-owned', 'true');
        document.body.appendChild(fairyContainer);
      }
    }
    fairyContainer.style.cssText = FAIRY_CONTAINER_STYLE;
    return fairyContainer;
  }

  function removeFairyContainer() {
    fairyContainer?.remove();
    fairyContainer = null;
  }

  function settleVisualTransition(promise, label) {
    return promise.catch((error) => {
      if (error?.name !== 'AbortError') diagnostics.warn('transition.settle', { label }, error);
    });
  }

  function namespaceCloneReferences(elements) {
    const idMap = new Map();
    const prefix = `dsh-fairy-transition-${++cloneIdSeed}`;
    const isSvgElement = (node) => node?.namespaceURI === 'http://www.w3.org/2000/svg'
      || Boolean(node?.ownerSVGElement)
      || String(node?.tagName || '').toLowerCase() === 'svg';
    // Only SVG fragment IDs participate in this namespace. Keeping ordinary
    // official DOM IDs unchanged avoids altering host CSS that may target an
    // unrelated HTML id, while the mascot root id is removed separately below.
    elements.filter(isSvgElement).forEach((node) => {
      const id = node.getAttribute?.('id');
      if (!id) return;
      // Deferred session layers are cloned from the already namespaced base.
      // Replace the old transition prefix instead of stacking prefixes, while
      // retaining a unique namespace for every layer.
      const sourceId = id.replace(/^dsh-fairy-transition-\d+-/, '');
      const next = `${prefix}-${sourceId}`;
      idMap.set(id, next);
      idMap.set(sourceId, next);
      node.setAttribute('id', next);
    });
    const rewrite = (value) => {
      if (!value) return value;
      let next = value.replace(/url\(#([^)]+)\)/g, (_match, id) => `url(#${idMap.get(id) || id})`);
      if (next.startsWith('#')) next = `#${idMap.get(next.slice(1)) || next.slice(1)}`;
      return next;
    };
    const attributes = [
      'href', 'xlink:href', 'fill', 'stroke', 'filter', 'clip-path', 'mask',
      'marker-start', 'marker-mid', 'marker-end', 'style',
    ];
    elements.forEach((node) => {
      attributes.forEach((attribute) => {
        const value = node.getAttribute?.(attribute);
        if (value) node.setAttribute(attribute, rewrite(value));
      });
    });
    // The live mascot state is expressed by global CSS selectors. Once the
    // referenced clipPath has been renamed, preserve the current eye shape by
    // pinning that one state-dependent property inline on the inert clone.
    const mascotRoot = elements.find((node) => node.getAttribute?.('data-dsh-fairy-mascot-root') === 'true');
    const stateClipId = mascotRoot?.getAttribute?.('data-state') === 'thinking'
      ? 'dsh-fairy-thinking-eye-clip'
      : mascotRoot?.getAttribute?.('data-state') === 'comforting'
        ? 'dsh-fairy-comforting-eye-clip'
        : null;
    const namespacedClipId = stateClipId ? idMap.get(stateClipId) : null;
    if (namespacedClipId) {
      elements.filter((node) => hasClass(node, 'dsh-fairy-eye') && isDescendantOf(node, mascotRoot)).forEach((eye) => {
        eye.style?.setProperty?.('clip-path', `url(#${namespacedClipId})`);
        eye.style?.setProperty?.('-webkit-clip-path', `url(#${namespacedClipId})`);
      });
    }
    // ID selectors are not a safe scope for a transient duplicate. Keep the
    // mascot's visual scope as a data attribute, but never duplicate its live
    // document ID. This also prevents getElementById/querySelector from
    // accidentally returning an inert transition clone in Safari.
    elements.forEach((node) => {
      if (node.getAttribute?.('data-dsh-fairy-mascot-root') === 'true') {
        node.removeAttribute('id');
      }
    });
  }

  function clearClonedFairyFaultState(elements) {
    const mascotRoots = elements.filter((node) => node.getAttribute?.('data-dsh-fairy-mascot-root') === 'true');
    mascotRoots.forEach((root) => {
      root.removeAttribute('data-transition-glitch');
      root.removeAttribute('data-transition-target');
      root.removeAttribute('data-visual-suspended');
    });
    elements.filter((node) => hasClass(node, 'dsh-fairy-signal') && mascotRoots.some((root) => isDescendantOf(node, root))).forEach((signal) => {
      signal.removeAttribute('data-glitch');
      ['--dsh-g-x', '--dsh-g-skew', '--dsh-g-bright', '--dsh-g-contrast', '--dsh-g-s1-x', '--dsh-g-s2-x', '--dsh-g-s3-x', '--dsh-g-s4-x', '--dsh-g-s5-x'].forEach((name) => signal.style.removeProperty(name));
    });
  }

  function isScrollableSnapshotRoot(node) {
    return node?.getAttribute?.('data-conversation-scroll') !== null
      || node?.getAttribute?.('data-chat-flow') !== null
      || node?.getAttribute?.('role') === 'tree';
  }

  function pruneOffscreenSubtrees(sourceElements, cloneElements) {
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
    if (viewportWidth < 1 || viewportHeight < 1) return cloneElements;
    const removedRoots = [];
    const count = Math.min(sourceElements.length, cloneElements.length);
    for (let index = 1; index < count; index += 1) {
      const source = sourceElements[index];
      const target = cloneElements[index];
      if (!isScrollableSnapshotRoot(source?.parentElement || source?.parentNode)) continue;
      if (!target?.firstElementChild || typeof source.getBoundingClientRect !== 'function') continue;
      const rect = source.getBoundingClientRect();
      if (!rect || rect.width <= 0 || rect.height <= 0) continue;
      // Keep a small guard band so antialiasing and transformed edges at the
      // viewport boundary remain pixel-identical during the transition.
      if (rect.bottom > -2 && rect.top < viewportHeight + 2 && rect.right > -2 && rect.left < viewportWidth + 2) continue;
      target.replaceChildren();
      target.setAttribute('data-dsh-transition-placeholder', '');
      target.style?.setProperty?.('visibility', 'hidden', 'important');
      target.style?.setProperty?.('content-visibility', 'hidden', 'important');
      target.style?.setProperty?.('contain', 'strict', 'important');
      target.style?.setProperty?.('box-sizing', 'border-box', 'important');
      target.style?.setProperty?.('width', `${rect.width}px`, 'important');
      target.style?.setProperty?.('height', `${rect.height}px`, 'important');
      target.style?.setProperty?.('min-width', `${rect.width}px`, 'important');
      target.style?.setProperty?.('min-height', `${rect.height}px`, 'important');
      target.style?.setProperty?.('flex', 'none', 'important');
      removedRoots.push(target);
    }
    if (!removedRoots.length) return cloneElements;
    return cloneElements.filter((node) => !removedRoots.some((root) => node !== root && isDescendantOf(node, root)));
  }

  function cloneTransitionFrame(frame) {
    const clone = frame.cloneNode(true);
    clone.setAttribute('data-dsh-transition-frame', '');
    // Reuse the one element walk for SVG namespacing, fault cleanup, identity
    // cleanup, and transient form-state copying. The old implementation walked
    // every cloned frame repeatedly, which made a session switch block the first
    // paint before the glitch animation could start.
    const sourceElements = collectElements(frame);
    const cloneElements = [clone, ...clone.querySelectorAll('*')];
    namespaceCloneReferences(cloneElements);
    clearClonedFairyFaultState(cloneElements);
    clone.setAttribute('inert', '');
    cloneElements.forEach((node) => {
      if (node.getAttribute?.('data-dsh-fairy-brand-anchor') !== 'true') return;
      node.removeAttribute('data-dsh-fairy-brand-anchor');
      node.removeAttribute('data-dsh-fairy-native-new-session');
    });
    for (let index = 0; index < Math.min(sourceElements.length, cloneElements.length); index += 1) {
      const source = sourceElements[index];
      const target = cloneElements[index];
      if (source.getAttribute?.('data-dsh-fairy-brand-anchor') === 'true') {
        target.removeAttribute('data-dsh-fairy-brand-anchor');
        target.removeAttribute('data-dsh-fairy-native-new-session');
      }
      if (source.scrollTop) target.scrollTop = source.scrollTop;
      if (source.scrollLeft) target.scrollLeft = source.scrollLeft;
      if ('value' in source && 'value' in target) target.value = source.value;
      if ('checked' in source && 'checked' in target) target.checked = source.checked;
    }
    // Prune only after state/reference copying. The retained list can then be
    // reused when this immutable snapshot becomes the source for deferred layers.
    clonedElementLists.set(clone, pruneOffscreenSubtrees(sourceElements, cloneElements));
    return clone;
  }

  class ModeTransition {
    constructor() {
      this.overlay = null;
      this.cleanupTimer = null;
      this.frameAnimation = null;
      this.sliceFrame = null;
    }

    cleanup = () => {
      if (this.cleanupTimer !== null) clearTimeout(this.cleanupTimer);
      this.cleanupTimer = null;
      this.frameAnimation?.cancel?.();
      this.frameAnimation = null;
      if (this.sliceFrame !== null) cancelAnimationFrame(this.sliceFrame);
      this.sliceFrame = null;
      this.overlay?.remove();
      this.overlay = null;
    };

    resolveFrame() {
      const frame = rootSlot(document)?.firstElementChild || null;
      if (!frame) return null;
      const rect = frame.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 ? frame : null;
    }

    cloneFrame(frame) {
      return cloneTransitionFrame(frame);
    }

    trigger() {
      const startedAt = diagnostics.start();
      if (!document.body || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
      const frame = this.resolveFrame();
      if (!frame || typeof frame.animate !== 'function') return;
      this.cleanup();

      const duration = 420;
      const overlay = document.createElement('div');
      overlay.className = 'dsh-hdd-mode-transition';
      overlay.setAttribute('data-from-mode', document.documentElement.getAttribute(modeAttr) || 'normal');
      overlay.setAttribute('aria-hidden', 'true');
      const container = ensureFairyContainer();
      container.appendChild(overlay);
      this.overlay = overlay;
      const oldBackground = getComputedStyle(document.body).backgroundColor;
      const random = (min, max) => min + Math.random() * (max - min);
      const band = () => {
        const top = random(0, 82);
        const height = random(2, 13);
        return `polygon(0% ${top.toFixed(1)}%,100% ${top.toFixed(1)}%,100% ${(top + height).toFixed(1)}%,0% ${(top + height).toFixed(1)}%)`;
      };

      // 整帧轻推（≤0.1% ≈ 1.3px）：原 ±0.35% 在大屏上是 4-5px 的跳，观感像卡顿。
      const shakeFrames = Array.from({ length: 9 }, () => ({
        transform: `translate3d(${random(-.1, .1).toFixed(3)}%,${random(-.08, .08).toFixed(3)}%,0)`,
      }));
      this.frameAnimation = frame.animate(shakeFrames, { duration, easing: 'steps(9, jump-start)', fill: 'none' });

      const capturedFrame = this.cloneFrame(frame);
      const addSlice = (slice, layer) => {
        layer.setAttribute('data-dsh-transition-layer', 'slice');
        if (firstBar) overlay.insertBefore(layer, firstBar);
        else overlay.appendChild(layer);
        const keyframes = Array.from({ length: 8 }, (_, index) => {
          if (index === 7 || Math.random() > .5) return { opacity: 0 };
          return {
            opacity: 1,
            clipPath: band(),
            // 不位移切片：横带一旦水平位移，落在带里的文字就被切开、错位（实机症状）。
            // 保留「信号带」观感的做法是给带子加色罩闪烁，而不是移动像素。
            backgroundColor: `rgba(96,196,255,${random(.05, .15).toFixed(2)})`,
          };
        });
        layer.animate(keyframes, { duration, easing: 'steps(8, jump-start)', fill: 'forwards' });
      };
      let firstBar = null;
      addSlice(0, capturedFrame);
      const addDeferredSlices = () => {
        this.sliceFrame = null;
        if (this.overlay !== overlay) return;
        for (let slice = 1; slice < 3; slice += 1) addSlice(slice, this.cloneFrame(capturedFrame));
      };
      if (typeof requestAnimationFrame === 'function') this.sliceFrame = requestAnimationFrame(addDeferredSlices);
      else addDeferredSlices();

      const colors = ['#38bdf8', '#ff2bd6', '#ff3b30', '#2bd97c', '#4d7cff', '#f5f7fa', '#ffe94a'];
      for (let index = 0; index < 4; index += 1) {
        const bar = document.createElement('div');
        if (!firstBar) firstBar = bar;
        bar.setAttribute('data-dsh-transition-layer', 'bar');
        bar.style.top = `${random(0, 88).toFixed(1)}%`;
        bar.style.left = '-5%';
        bar.style.width = '110%';
        bar.style.height = `${random(2, 6).toFixed(1)}%`;
        bar.style.background = colors[Math.floor(Math.random() * colors.length)];
        overlay.appendChild(bar);
        const keyframes = Array.from({ length: 7 }, (_, step) => step === 6 || Math.random() < .25
          ? { opacity: 0 }
          : { opacity: random(.3, .75).toFixed(2), transform: `translate3d(${random(-11, 11).toFixed(1)}%,0,0)` });
        bar.animate(keyframes, { duration, easing: 'steps(7, jump-start)', fill: 'forwards' });
      }

      const background = document.createElement('div');
      background.setAttribute('data-dsh-transition-layer', 'background');
      background.style.background = oldBackground;
      overlay.appendChild(background);
      const backgroundFrames = Array.from({ length: 9 }, (_, index) => index === 8
        ? { opacity: 0 }
        : { opacity: random(.12, .32).toFixed(2), clipPath: Math.random() < .5 ? band() : 'none' });
      background.animate(backgroundFrames, { duration, easing: 'steps(9, jump-start)', fill: 'forwards' });
      this.cleanupTimer = setTimeout(this.cleanup, duration + 50);
      diagnostics.metric('transition.mode.capture', startedAt, { source_mode: overlay.getAttribute('data-from-mode') });
    }

    dispose() {
      this.cleanup();
    }
  }

  class SessionTransition {
    constructor() {
      this.overlay = null;
      this.cleanupTimer = null;
      this.animations = [];
      this.sliceFrame = null;
    }

    cleanup = () => {
      if (this.cleanupTimer !== null) clearTimeout(this.cleanupTimer);
      this.cleanupTimer = null;
      this.animations.forEach((animation) => animation?.cancel?.());
      this.animations = [];
      if (this.sliceFrame !== null) cancelAnimationFrame(this.sliceFrame);
      this.sliceFrame = null;
      this.overlay?.remove();
      this.overlay = null;
    };

    cloneFrame(frame) {
      return cloneTransitionFrame(frame);
    }

    resolveRegion() {
      const frame = rootSlot(document)?.firstElementChild || null;
      const surface = conversation?.(document);
      const regionSurface = anyPhase?.(surface) || surface;
      const composer = composerCard?.(composerSeat?.(surface));
      if (!frame || !surface || !regionSurface || !composer || typeof frame.animate !== 'function') return null;
      const frameRect = frame.getBoundingClientRect();
      const surfaceRect = regionSurface.getBoundingClientRect();
      const composerRect = composer.getBoundingClientRect();
      const width = window.innerWidth || document.documentElement.clientWidth;
      const height = window.innerHeight || document.documentElement.clientHeight;
      const bottomEdge = Math.min(surfaceRect.bottom, Math.max(surfaceRect.top, composerRect.top));
      const top = Math.max(0, surfaceRect.top);
      const right = Math.max(0, width - surfaceRect.right);
      const bottom = Math.max(0, height - bottomEdge);
      const left = Math.max(0, surfaceRect.left);
      if (frameRect.width < 1 || frameRect.height < 1 || width < 1 || height < 1 || width - left - right < 1 || height - top - bottom < 1) return null;
      return {
        frame,
        clipPath: `inset(${top}px ${right}px ${bottom}px ${left}px)`,
      };
    }

    animate(node, keyframes, options) {
      const animation = node.animate(keyframes, options);
      this.animations.push(animation);
      return animation;
    }

    trigger() {
      const startedAt = diagnostics.start();
      if (!document.body || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
      const region = this.resolveRegion();
      if (!region) return;
      this.cleanup();

      const duration = 420;
      const overlay = document.createElement('div');
      overlay.className = 'dsh-hdd-session-transition';
      overlay.setAttribute('aria-hidden', 'true');
      const clippedRegion = document.createElement('div');
      clippedRegion.setAttribute('data-dsh-session-transition-region', '');
      clippedRegion.style.cssText = `position:absolute;inset:0;overflow:hidden;pointer-events:none;clip-path:${region.clipPath};-webkit-clip-path:${region.clipPath};`;
      overlay.appendChild(clippedRegion);
      ensureFairyContainer().appendChild(overlay);
      this.overlay = overlay;

      const random = (min, max) => min + Math.random() * (max - min);
      const band = () => {
        const top = random(0, 82);
        const height = random(2, 13);
        return `polygon(0% ${top.toFixed(1)}%,100% ${top.toFixed(1)}%,100% ${(top + height).toFixed(1)}%,0% ${(top + height).toFixed(1)}%)`;
      };
      const base = this.cloneFrame(region.frame);
      clippedRegion.appendChild(base);
      const baseFrames = Array.from({ length: 9 }, (_, index) => index === 8
        ? { opacity: 0 }
        : {
          opacity: 1,
          transform: `translate3d(${random(-.1, .1).toFixed(3)}%,${random(-.08, .08).toFixed(3)}%,0)`,
        });
      this.animate(base, baseFrames, { duration, easing: 'steps(9, jump-start)', fill: 'forwards' });

      const addSlices = () => {
        this.sliceFrame = null;
        if (this.overlay !== overlay) return;
        for (let slice = 0; slice < 3; slice += 1) {
          // Clone the already captured base so session replacement cannot make
          // the deferred layers read the new DOM. Each clone is still
          // re-namespaced by cloneFrame for SVG safety.
          const layer = this.cloneFrame(base);
          layer.setAttribute('data-dsh-transition-layer', 'slice');
          clippedRegion.appendChild(layer);
          const keyframes = Array.from({ length: 8 }, (_, index) => {
            if (index === 7 || Math.random() > .5) return { opacity: 0 };
            return {
              opacity: 1,
              clipPath: band(),
              // 不位移切片：横带一旦水平位移，落在带里的文字就被切开、错位（实机症状）。
              // 保留「信号带」观感的做法是给带子加色罩闪烁，而不是移动像素。
              backgroundColor: `rgba(96,196,255,${random(.05, .15).toFixed(2)})`,
            };
          });
          this.animate(layer, keyframes, { duration, easing: 'steps(8, jump-start)', fill: 'forwards' });
        }
      };
      if (typeof requestAnimationFrame === 'function') this.sliceFrame = requestAnimationFrame(addSlices);
      else addSlices();

      this.cleanupTimer = setTimeout(this.cleanup, duration + 50);
      diagnostics.metric('transition.session.capture', startedAt, {});
    }

    dispose() {
      this.cleanup();
    }
  }

  class ThemeTransition {
    constructor(frameTransition) {
      this.frameTransition = frameTransition;
      this.current = null;
      this.overlay = null;
      this.animation = null;
    }

    run(update) {
      const startedAt = diagnostics.start();
      const root = document.documentElement;
      if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return update();
      this.cleanup();
      if (typeof document.startViewTransition !== 'function') return this.runFallback(update);
      root.setAttribute('data-dsh-fairy-theme-transition', '');
      let transition;
      try {
        transition = document.startViewTransition(() => Promise.resolve(update()));
      } catch {
        root.removeAttribute('data-dsh-fairy-theme-transition');
        return update();
      }
      this.current = transition;
      settleVisualTransition(transition.finished, 'view transition').finally(() => {
        diagnostics.metric('transition.theme', startedAt, { implementation: 'view-transition' });
        if (this.current !== transition) return;
        this.current = null;
        root.removeAttribute('data-dsh-fairy-theme-transition');
      });
      return transition.updateCallbackDone;
    }

    runFallback(update) {
      const frame = this.frameTransition.resolveFrame();
      if (!document.body || !frame || typeof frame.animate !== 'function') return update();
      const overlay = document.createElement('div');
      overlay.className = 'dsh-fairy-theme-fade-transition';
      overlay.setAttribute('aria-hidden', 'true');
      overlay.style.background = getComputedStyle(document.body).backgroundColor;
      overlay.appendChild(this.frameTransition.cloneFrame(frame));
      const container = ensureFairyContainer();
      container.appendChild(overlay);
      this.overlay = overlay;
      let result;
      try {
        result = Promise.resolve(update());
      } catch (error) {
        this.cleanup();
        throw error;
      }
      return result.then((value) => {
        if (this.overlay !== overlay) return value;
        const animation = overlay.animate([{ opacity: 1 }, { opacity: 0 }], {
          duration: THEME_TRANSITION_DURATION_MS,
          easing: 'cubic-bezier(.22,1,.36,1)',
          fill: 'forwards',
        });
        this.animation = animation;
        settleVisualTransition(animation.finished, 'theme fade').finally(() => {
          if (this.overlay === overlay) this.cleanup();
        });
        return value;
      }, (error) => {
        if (this.overlay === overlay) this.cleanup();
        throw error;
      });
    }

    cleanup() {
      this.current?.skipTransition?.();
      this.current = null;
      this.animation?.cancel?.();
      this.animation = null;
      this.overlay?.remove();
      this.overlay = null;
      document.documentElement.removeAttribute('data-dsh-fairy-theme-transition');
    }

    dispose() {
      this.cleanup();
    }
  }

  return {
    createModeTransition: () => new ModeTransition(),
    createSessionTransition: () => new SessionTransition(),
    createThemeTransition: (frameTransition) => new ThemeTransition(frameTransition),
    removeFairyContainer,
  };
}

module.exports = { createVisualTransitions };
