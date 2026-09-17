const React = require('react');
const { jsx, jsxs } = require('react/jsx-runtime');
const { createFairyDiagnostics } = require('../../../../fairy-contracts/client-diagnostics.cjs');
const { createAskKit } = require('../../../../fairy-contracts/client-ask-kit.cjs');
const uiPrimitives = require('@deepseek-ai/dsh-client-ui-primitives');
const { SETTINGS_NAMESPACE, STYLE_ID, MODE_ATTR, POWER_MODE_ATTR, THEME_ATTR, PALETTE_ATTR, POWER_TOGGLE_WIDTH, POWER_TOGGLE_HEIGHT, DEFAULT } = require('./constants.js');
const IDENTITY_SETTINGS_NAMESPACE = 'fairy-identity';
const { deriveSessionActivity, syncDocumentMode } = require('./utils.js');
const { injectStyles } = require('./style.js');
const { mountComposerDock } = require('./composer-dock.js');
const { createLifecycleScope, claimSingleton } = require('./lifecycle.js');
const { createManagedMutationObserver, getDomObserverManager } = require('./dom-observer-manager.js');
const { createMascotRuntime } = require('./mascot-runtime.js');
const semanticMarkersManager = require('./semantic-markers-manager.js');
const sidebarGeometryManager = require('./sidebar-geometry-manager.js');
const scrollbarsManager = require('./scrollbars-manager.js');
const heroProjectionManager = require('./hero-projection-manager.js');
const { ownControllerLifecycle, disposeControllerLifecycle } = require('./controller-lifecycle.js');
const { claimStageGeometryLifecycle, claimContentFadeLifecycle } = require('./stage-lifecycle.js');
const { claimMascotLifecycle } = require('./mascot-lifecycle.js');
const { claimBrandSidebarGeometry } = require('./brand-sidebar-geometry.js');
const { claimPowerModeGeometry } = require('./power-mode.js');
const { createSelectionGuard } = require('./selection-guard.js');
const { scheduleMascotScale, MASCOT_GEOMETRY_EVENT } = require('./mascot-scale-control.js');
const { saveControllerSetting, setControllerSetting, settingError } = require('./settings-write.js');
const { mutationTouchesSurface } = require('./surface-utils.js');
const { migrateVisualSettings, normalizeSetting } = require('./settings-normalizer.cjs');
const { createVisualTransitions } = require('./visual-transitions.js');
const {
  OFFICIAL_SELECTORS,
  OFFICIAL_ATTRIBUTES,
  rootSlot,
  sidebar,
  conversation,
  conversationScroll,
  anyPhase,
  composerSeat,
  composerCard,
  conversationComposerDock,
  chatFlows,
  balanceAction,
  sidebarResizeHandle,
  reportMissingCapabilities,
} = require('./dom-adapter.js');

const visualTransitions = createVisualTransitions({ rootSlot, modeAttr: MODE_ATTR, conversation, anyPhase, composerSeat, composerCard });
const mascotRuntime = createMascotRuntime();
const diagnostics = createFairyDiagnostics('dsh-fairy-visual');

    /* The mascot runtime is isolated from React and owns only its visual lifecycle. */
    class Controller {
      constructor(settings, sessions) {
        this.settings = settings;
        this.sessions = sessions;
        this.modeTransition = visualTransitions.createModeTransition();
        this.sessionTransition = visualTransitions.createSessionTransition();
        this.themeTransition = visualTransitions.createThemeTransition(this.modeTransition);
        this.listeners = new Set();
        this.session = null;
        this.boundSessionId = undefined;
        this.hasBoundSession = false;
        this.state = {
          settings: migrateVisualSettings({ ...DEFAULT, ...(settings.getSnapshot().value || {}) }),
          activity: 'normal',
          lifecycle: 'idle',
          sessionId: undefined,
        };
        this.lastGoodSettings = this.state.settings;
        this.listOff = sessions.list.subscribe(() => this.bind());
        this.settingsOff = settings.subscribe(() => {
          const next = settings.getSnapshot();
          const normalized = migrateVisualSettings({ ...DEFAULT, ...(next.value || {}) });
          syncDocumentMode({ ...next, value: normalized });
          this.state = { ...this.state, settings: normalized };
          this.lastGoodSettings = normalized;
          this.emit();
        });
        this.lifecycle = ownControllerLifecycle(this);
        this.bind();
      }

      subscribe = (listener) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
      };

      getSnapshot = () => this.state;

      emit() {
        this.listeners.forEach((listener) => listener());
      }

      bind() {
        const id = this.sessions.list.getSnapshot().current;
        const next = id == null ? null : this.sessions.binding(id)?.session || null;
        if (this.hasBoundSession && id !== this.boundSessionId && this.state.settings.enabled) this.sessionTransition.trigger();
        this.boundSessionId = id;
        this.hasBoundSession = true;
        if (next === this.session) return this.update();
        this.sessionOff?.();
        this.session = next;
        this.sessionOff = next?.subscribe(() => this.update()) || null;
        this.update();
      }

      update() {
        const snap = this.session?.getSnapshot?.();
        let activity = 'normal';
        let lifecycle = 'idle';
        const sessionId = this.session?.sessionId;
        if (snap) {
          lifecycle = snap.running ? 'running' : snap.blank ? 'idle' : 'completed';
          activity = deriveSessionActivity(snap);
        }
        if (this.state.activity === activity && this.state.lifecycle === lifecycle && this.state.sessionId === sessionId) return;
        this.state = { ...this.state, activity, lifecycle, sessionId };
        this.emit();
      }

      set(field, value) {
        const normalized = normalizeSetting(field, value, this.state.settings);
        if (field === 'enabled' && normalized !== this.state.settings.enabled) this.modeTransition.trigger();
        const write = () => this.settings.set(field, normalized);
        return Promise.resolve().then(() => field === 'theme' && normalized !== this.state.settings.theme ? this.themeTransition.run(write) : write()).catch((error) => {
          this.state = { ...this.state, settings: this.lastGoodSettings || migrateVisualSettings(DEFAULT) };
          this.emit();
          throw error;
        });
      }

      dispose() {
        disposeControllerLifecycle(this.lifecycle);
        mascotRuntime?.dispose?.();
        document.documentElement.removeAttribute('data-dsh-fairy-visual');
        document.documentElement.removeAttribute(MODE_ATTR);
        document.documentElement.removeAttribute(POWER_MODE_ATTR);
        document.documentElement.removeAttribute(THEME_ATTR);
        document.documentElement.removeAttribute(PALETTE_ATTR);
        document.getElementById(STYLE_ID)?.remove();
        visualTransitions.removeFairyContainer();
      }
    }

    const { SidebarBoardCutout } = sidebarGeometryManager.install();
    const { HddOverlayScrollbars } = scrollbarsManager.install();

    function HddBackgroundFxHost({ enabled }) {
      React.useLayoutEffect(() => {
        if (!enabled || !document.body) return undefined;
        const host = document.createElement('div');
        host.className = 'dsh-hdd-background-host';
        host.setAttribute('data-dsh-fairy-background-host', 'true');
        host.setAttribute('aria-hidden', 'true');
        const fx = document.createElement('div');
        fx.className = 'dsh-hdd-fx';
        for (const variant of ['a', 'b', 'c']) {
          const glow = document.createElement('div');
          glow.className = `dsh-hdd-glow dsh-hdd-glow-${variant}`;
          fx.appendChild(glow);
        }
        host.appendChild(fx);
        document.body.insertBefore(host, document.body.firstElementChild);
        return () => host.remove();
      }, [enabled]);
      return null;
    }

    const useController = (controller) => React.useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
    const save = saveControllerSetting;

    function Toggle({ controller }) {
      const state = useController(controller);
      const on = state.settings.enabled;
      const theme = state.settings.theme === 'light' ? 'light' : 'dark';
      return jsxs('div', {
        className: 'dsh-fairy-toggle-group',
        role: 'group',
        'aria-label': 'H.D.D 视觉控制',
        children: [
          jsxs('button', {
            type: 'button',
            className: 'dsh-fairy-toggle',
            'data-on': String(on),
            'aria-pressed': String(on),
            'aria-label': on ? '关闭 H.D.D 视觉' : '启用 H.D.D 视觉',
            onClick: () => save(controller, 'enabled', !on),
            children: [jsx('span', { className: 'dsh-fairy-dot' }), 'H.D.D'],
          }),
          jsx('button', {
            type: 'button',
            className: 'dsh-fairy-theme-toggle',
            'data-theme': theme,
            disabled: !on,
            'aria-label': theme === 'dark' ? '切换到日间模式' : '切换到夜间模式',
            title: theme === 'dark' ? '切换到日间模式' : '切换到夜间模式',
            onClick: () => save(controller, 'theme', theme === 'dark' ? 'light' : 'dark'),
            children: jsx('span', { className: 'dsh-fairy-theme-icon', 'aria-hidden': 'true' }),
          }),
        ],
      });
    }

    const { HeroToggleHost, HeroHost, ActiveComposerPlaceholder } = heroProjectionManager.install(null, { Toggle, useController });

    function FairyMarkEye() {
      return jsxs('span', {
        className: 'dsh-fairy-mark-eye',
        'aria-hidden': 'true',
        children: ['top', 'right', 'bottom', 'left'].map((side) => jsx('span', { className: 'dsh-fairy-mark-brow', 'data-side': side }, side)),
      });
    }

    function FairyMarkCopy() {
      return jsxs('span', {
        className: 'dsh-fairy-mark-copy',
        children: [
          jsx('span', { className: 'dsh-fairy-mark-title', children: 'Fairy' }),
          jsx('span', { className: 'dsh-fairy-mark-sub', children: 'Ⅲ型总序式集成泛用人工智能' }),
        ],
      });
    }

    function FairyMark({ controller }) {
      const state = useController(controller);
      const on = state.settings.enabled;
      const markRef = React.useRef(null);
      const glitchTimers = React.useRef(new Set());
      const glitchToken = React.useRef(0);

      React.useEffect(() => () => {
        glitchToken.current += 1;
        glitchTimers.current.forEach((timer) => clearTimeout(timer));
        glitchTimers.current.clear();
        const mark = markRef.current;
        if (mark) {
          mark.removeAttribute('data-glitch');
          ['--dsh-fairy-mark-g-x', '--dsh-fairy-mark-thread-x', '--dsh-fairy-mark-thread-2-x', '--dsh-fairy-mark-thread-3-x', '--dsh-fairy-mark-s1-x', '--dsh-fairy-mark-s2-x', '--dsh-fairy-mark-s3-x'].forEach((name) => mark.style.removeProperty(name));
        }
      }, []);

      const clearGlitch = () => {
        glitchTimers.current.forEach((timer) => clearTimeout(timer));
        glitchTimers.current.clear();
        const mark = markRef.current;
        if (!mark) return;
        mark.removeAttribute('data-glitch');
        ['--dsh-fairy-mark-g-x', '--dsh-fairy-mark-thread-x', '--dsh-fairy-mark-thread-2-x', '--dsh-fairy-mark-thread-3-x', '--dsh-fairy-mark-s1-x', '--dsh-fairy-mark-s2-x', '--dsh-fairy-mark-s3-x'].forEach((name) => mark.style.removeProperty(name));
      };
      const pulseGlitch = (mode) => {
        const mark = markRef.current;
        if (!mark) return;
        const random = (min, max) => min + Math.random() * (max - min);
        const next = { '--dsh-fairy-mark-g-x': `${random(-1.2, 1.2).toFixed(2)}px` };
        if (mode === 'blocks') {
          const polarity = Math.random() < .5 ? -1 : 1;
          for (let index = 1; index <= 3; index += 1) {
            const direction = index % 2 === 0 ? polarity : -polarity;
            next[`--dsh-fairy-mark-s${index}-x`] = `${(direction * random(4.2, 6.2)).toFixed(2)}px`;
          }
        } else {
          const offset = random(-9, 9);
          next['--dsh-fairy-mark-thread-x'] = `${offset.toFixed(2)}px`;
          next['--dsh-fairy-mark-thread-2-x'] = `${(-offset * .8).toFixed(2)}px`;
          next['--dsh-fairy-mark-thread-3-x'] = `${(offset * .45).toFixed(2)}px`;
        }
        Object.entries(next).forEach(([name, value]) => mark.style.setProperty(name, value));
        mark.setAttribute('data-glitch', mode);
      };
      const triggerGlitch = () => {
        clearGlitch();
        const token = ++glitchToken.current;
        const schedule = (delay, callback) => {
          const timer = setTimeout(() => {
            glitchTimers.current.delete(timer);
            if (token === glitchToken.current) callback();
          }, delay);
          glitchTimers.current.add(timer);
        };
        // Original sequence: two thread pulses, a 28ms handoff, then two block
        // pulses followed by four thread pulses, all with 40ms spacing.
        [['threads', 0], ['threads', 40], ['blocks', 68], ['blocks', 108], ['threads', 148], ['threads', 188], ['threads', 228], ['threads', 268]].forEach(([mode, delay]) => {
          schedule(delay, () => pulseGlitch(mode));
        });
        schedule(296, clearGlitch);
      };

      return jsxs('button', {
        ref: markRef,
        type: 'button',
        className: 'dsh-fairy-mark',
        'data-enabled': String(on),
        'data-on': String(state.settings.mascotVisible),
        'aria-pressed': String(state.settings.mascotVisible),
        'aria-label': state.settings.mascotVisible ? '隐藏 Fairy 主视觉' : '显示 Fairy 主视觉',
        onPointerDown: (event) => event.stopPropagation(),
        onMouseDown: (event) => event.stopPropagation(),
        onTouchStart: (event) => event.stopPropagation(),
        onClick: (event) => {
          event.preventDefault();
          event.stopPropagation();
          const nextVisible = !state.settings.mascotVisible;
          triggerGlitch();
          save(controller, 'mascotVisible', nextVisible);
        },
        children: [
          jsx(FairyMarkEye, {}),
          jsx(FairyMarkCopy, {}),
          ...[1, 2, 3].map((index) => jsxs('span', { className: 'dsh-fairy-mark-glitch-slice', 'data-slice': String(index), 'aria-hidden': 'true', children: [jsx(FairyMarkEye, {}), jsx(FairyMarkCopy, {})] }, index)),
        ],
      });
    }
    const CHAT_SURFACE_SELECTOR = `${OFFICIAL_SELECTORS.chatFlow}, ${OFFICIAL_SELECTORS.conversationScroll}`;
    const STAGE_SURFACE_SELECTOR = OFFICIAL_SELECTORS.conversation;
    const resolveStageSurface = () => anyPhase(conversation(document));
    const hasChatSurfaceMutation = (records) => records.some((record) => (record.type === 'attributes' && record.target.matches?.(CHAT_SURFACE_SELECTOR)) || [...record.addedNodes, ...record.removedNodes].some((node) => node.nodeType === 1 && (node.matches?.(CHAT_SURFACE_SELECTOR) || node.querySelector?.(CHAT_SURFACE_SELECTOR))));
    const hasStageSurfaceMutation = (records) => records.some((record) => [...record.addedNodes, ...record.removedNodes].some((node) => node.nodeType === 1 && (node.matches?.(STAGE_SURFACE_SELECTOR) || node.querySelector?.(STAGE_SURFACE_SELECTOR))));

    // Lifecycle: Fairy mascot runtime
    // Owner: stage node
    // Contract: lifecycle-ownership.json#owners[subsystem=Fairy mascot runtime]
    function Stage({ state }) {
      const stageRef = React.useRef(null);
      const mascotOwnerRef = React.useRef(null);
      const enabled = state.settings.enabled;
      const visible = enabled && state.settings.mascotVisible;
      const visibleRef = React.useRef(visible);
      const fadeLifecycleRef = React.useRef(null);
      const contentFadeRef = React.useRef(false);
      visibleRef.current = visible;
      // 内容遮罩开关（默认关）：开启后主视觉会遮挡其下正文（生成期间新文字变淡）。
      contentFadeRef.current = state.settings.contentFade === true;

      React.useLayoutEffect(() => {
        const stageNode = stageRef.current;
        if (!stageNode) return;
        const owner = { stage: stageNode, active: true };
        mascotOwnerRef.current = owner;
        const lifecycle = claimMascotLifecycle(stageNode);
        lifecycle.add(() => {
          owner.active = false;
          if (mascotOwnerRef.current === owner) mascotOwnerRef.current = null;
          mascotRuntime?.dispose?.(owner);
        }, 'mascot-runtime:owner-dispose');
        return () => lifecycle.dispose();
      }, []);

      React.useEffect(() => {
        const stageNode = stageRef.current;
        if (!stageNode) return;
        const owner = mascotOwnerRef.current;
        if (!owner?.active) return;
        stageNode.setAttribute('data-fairy-visual-active', visible ? 'true' : 'false');
        stageNode.setAttribute('data-fairy-state', state.activity);
        if (state.settings.powerMode === 'low-power') stageNode.setAttribute('data-fairy-low-power', 'true');
        else stageNode.removeAttribute('data-fairy-low-power');
        const mascot = mascotRuntime;
        mascot?.mount?.(stageNode, owner, state.settings.mascotAnimationSpeed);
        mascot?.setVisualActive?.(visible, owner);
      }, [visible, state.activity, state.settings.powerMode, state.settings.mascotAnimationSpeed]);

      React.useLayoutEffect(() => {
        if (!enabled) return undefined;
        return scheduleMascotScale(state.settings.mascotScale);
      }, [enabled, state.settings.mascotScale]);

      // Lifecycle: stage geometry and content fade
      // Owner: stage node
      // Contract: lifecycle-ownership.json#owners[subsystem=stage geometry and content fade]
      React.useEffect(() => {
        if (!enabled) return;
        const stageNode = stageRef.current;
        if (!stageNode) return;
        const lifecycle = claimStageGeometryLifecycle(stageNode);
        let surface = null;
        let resizeObserver = null;
        let structureObserver = null;

        const syncStageGeometry = () => {
          const rect = surface?.getBoundingClientRect();
          if (!rect || rect.width < 240 || rect.height < 1) return;
          stageNode.style.left = Math.round(rect.left) + 'px';
          stageNode.style.width = Math.round(rect.width) + 'px';
        };
        const scheduleStageGeometry = () => {
          if (!lifecycle.disposed) lifecycle.scheduleFrame('stage-geometry-sync', syncStageGeometry, 'stage-geometry:sync-frame');
        };
          const bindSurface = () => {
            const nextSurface = resolveStageSurface();
            if (nextSurface === surface) return;
            lifecycle.replaceBinding('stage-surface', () => resizeObserver?.disconnect(), 'stage-geometry:surface-resize-observer');
            resizeObserver?.disconnect();
            surface = nextSurface;
          if (typeof ResizeObserver === 'function' && surface) {
            resizeObserver = new ResizeObserver(scheduleStageGeometry);
            resizeObserver.observe(surface);
          }
          scheduleStageGeometry();
        };
        const scheduleSurfaceBind = () => {
          if (!lifecycle.disposed) lifecycle.scheduleFrame('stage-surface-bind', bindSurface, 'stage-geometry:bind-surface-frame');
        };

        bindSurface();
        if (typeof MutationObserver === 'function' && document.body) {
          structureObserver = createManagedMutationObserver((records) => {
            if (hasStageSurfaceMutation(records)) scheduleSurfaceBind();
          });
          structureObserver.observe(document.body, { childList: true, subtree: true });
        }
        window.addEventListener('resize', scheduleStageGeometry, { passive: true });
        const cleanup = () => {
          resizeObserver?.disconnect();
          structureObserver?.disconnect();
          window.removeEventListener('resize', scheduleStageGeometry);
          stageNode.style.removeProperty('left');
          stageNode.style.removeProperty('width');
        };
        lifecycle.add(cleanup, 'stage-geometry:restore-surface');
        return () => lifecycle.dispose();
      }, [enabled, state.sessionId]);

      React.useEffect(() => {
        if (!enabled) return;
        const stageNode = stageRef.current;
        if (!stageNode) return;
        const lifecycle = claimContentFadeLifecycle(stageNode);
        let revealFrame = 0;
        let resizeObserver = null;
        let structureObserver = null;
        let cleanupTimer = 0;
        let observedEye = null;
        let observedSurface = null;
        let surface = null;

        const cancelFrames = () => {
          if (revealFrame) cancelAnimationFrame(revealFrame);
          revealFrame = 0;
        };
        const cancelCleanup = () => {
          if (!cleanupTimer) return;
          clearTimeout(cleanupTimer);
          cleanupTimer = 0;
        };
        const restoreSurface = () => {
          if (!surface) return;
          surface.classList.remove('dsh-fairy-content-mask', 'dsh-fairy-content-fade');
          ['--dsh-fade-x', '--dsh-fade-y', '--dsh-fade-rx', '--dsh-fade-ry', '--dsh-fade-core', '--dsh-fade-soft-1', '--dsh-fade-soft-2', '--dsh-fade-soft-3'].forEach((name) => surface.style.removeProperty(name));
          surface = null;
        };
        const clearContentFade = (delayed = false) => {
          cancelFrames();
          surface?.classList.remove('dsh-fairy-content-fade');
          if (!delayed) {
            cancelCleanup();
            restoreSurface();
            return;
          }
          if (cleanupTimer) return;
          cleanupTimer = window.setTimeout(() => {
            cleanupTimer = 0;
            if (!visibleRef.current) restoreSurface();
          }, 360);
        };
        const scheduleContentFade = () => {
          if (!lifecycle.disposed) lifecycle.scheduleFrame('content-fade-sync', applyContentFade, 'content-fade:sync-frame');
        };
        const asFadePercent = (ratio) => Math.round(ratio * 1000) / 10 + '%';
        const applyContentFade = () => {
          const eye = stageNode.querySelector('#dsh-fairy-root');
          const nextSurface = conversationScroll(conversation(document));
          if (!contentFadeRef.current) return clearContentFade();
          if (!visibleRef.current) return clearContentFade(true);
          if (!eye || !nextSurface) return clearContentFade();
          const hasActiveChatFlow = chatFlows(document).some((flow) => {
            const rect = flow.getBoundingClientRect();
            return flow.isConnected && rect.width > 0 && rect.height > 0;
          });
          if (!hasActiveChatFlow) return clearContentFade();
          cancelCleanup();
          if (surface !== nextSurface) {
            restoreSurface();
            surface = nextSurface;
            surface.classList.add('dsh-fairy-content-mask');
          }
          // The root contains SVG padding, halo and the oversized pulse layer.
          // The outer disc is the actual visible eye perimeter and is the only
          // geometry that should define the text occlusion core.
          const eyeBoundary = eye.querySelector('.dsh-fairy-outer-disc') || eye;
          const eyeRect = eyeBoundary.getBoundingClientRect();
          const eyeX = eyeRect.left + eyeRect.width * .5;
          const eyeY = eyeRect.top + eyeRect.height * .5;
          const surfaceRect = surface.getBoundingClientRect();
          const fadeFeatherX = Math.max(56, Math.min(76, eyeRect.width * .24));
          const fadeFeatherY = Math.max(46, Math.min(64, eyeRect.height * .20));
          const fadeRadiusX = Math.round(eyeRect.width * .5 + fadeFeatherX);
          const fadeRadiusY = Math.round(eyeRect.height * .5 + fadeFeatherY);
          // The fully occluded core is derived from the mascot's real rendered
          // perimeter, not from an arbitrary percentage of the outer fade. A
          // small margin keeps glyph antialiasing out from beneath the eye.
          const eyeBoundaryRatio = Math.min(.88, Math.max(
            eyeRect.width * .5 / fadeRadiusX,
            eyeRect.height * .5 / fadeRadiusY,
          ));
          const featherRatio = 1 - eyeBoundaryRatio;
          surface.style.setProperty('--dsh-fade-x', Math.round(eyeX - surfaceRect.left) + 'px');
          surface.style.setProperty('--dsh-fade-y', Math.round(eyeY - surfaceRect.top) + 'px');
          surface.style.setProperty('--dsh-fade-rx', fadeRadiusX + 'px');
          surface.style.setProperty('--dsh-fade-ry', fadeRadiusY + 'px');
          surface.style.setProperty('--dsh-fade-core', asFadePercent(eyeBoundaryRatio));
          surface.style.setProperty('--dsh-fade-soft-1', asFadePercent(eyeBoundaryRatio + featherRatio * .28));
          surface.style.setProperty('--dsh-fade-soft-2', asFadePercent(eyeBoundaryRatio + featherRatio * .58));
          surface.style.setProperty('--dsh-fade-soft-3', asFadePercent(eyeBoundaryRatio + featherRatio * .84));
          if (revealFrame) cancelAnimationFrame(revealFrame);
          revealFrame = requestAnimationFrame(() => {
            revealFrame = 0;
            if (visibleRef.current && surface?.isConnected) surface.classList.add('dsh-fairy-content-fade');
          });
          if (resizeObserver && (observedEye !== eyeBoundary || observedSurface !== surface)) {
            resizeObserver.disconnect();
            observedEye = eyeBoundary;
            observedSurface = surface;
            resizeObserver.observe(eyeBoundary);
            resizeObserver.observe(surface);
          }
        };

        if (typeof ResizeObserver === 'function') resizeObserver = new ResizeObserver(scheduleContentFade);

        if (typeof MutationObserver === 'function' && document.body) {
          structureObserver = createManagedMutationObserver((records) => {
            if (hasChatSurfaceMutation(records)) scheduleContentFade();
          });
          structureObserver.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: [OFFICIAL_ATTRIBUTES.chatFlow, OFFICIAL_ATTRIBUTES.conversationScroll] });
        }
        window.addEventListener('resize', scheduleContentFade, { passive: true });
        window.addEventListener(MASCOT_GEOMETRY_EVENT, scheduleContentFade, { passive: true });
        fadeLifecycleRef.current = (nextVisible) => {
          if (nextVisible) {
            cancelCleanup();
            scheduleContentFade();
          } else {
            clearContentFade(true);
          }
        };
        scheduleContentFade();
        const cleanup = () => {
          fadeLifecycleRef.current = null;
          cancelFrames();
          resizeObserver?.disconnect();
          structureObserver?.disconnect();
          if (cleanupTimer) clearTimeout(cleanupTimer);
          restoreSurface();
          window.removeEventListener('resize', scheduleContentFade);
          window.removeEventListener(MASCOT_GEOMETRY_EVENT, scheduleContentFade);
        };
        lifecycle.add(cleanup, 'content-fade:restore-surface');
        return () => lifecycle.dispose();
      }, [enabled, state.sessionId]);

      React.useEffect(() => {
        fadeLifecycleRef.current?.(visible);
      }, [visible]);

        return jsx('div', { ref: stageRef, className: 'dsh-fairy-root dsh-fairy-stage', hidden: !enabled, 'data-visible': String(visible), 'data-fairy-visual-active': visible ? 'true' : 'false', 'data-fairy-state': state.activity, 'data-fairy-low-power': state.settings.powerMode === 'low-power' ? 'true' : undefined, 'aria-hidden': 'true' });
    }
    // The shell overlay survives sidebar column changes. Keeping the visual host here
    // preserves the original mascot DOM and its animation phase while the sidebar folds.
    function StageHost({ controller }) {
      const state = useController(controller);
      React.useLayoutEffect(() => {
        const lifecycle = claimSingleton(document, 'stage-host', createLifecycleScope('stage-host'));
        injectStyles();
        lifecycle.add(semanticMarkersManager.install(), 'stage-host:semantic-markers');
        lifecycle.add(mountComposerDock(controller), 'stage-host:composer-dock');
        return () => lifecycle.dispose();
      }, [controller]);
      return jsxs(React.Fragment, { children: [jsx(HddBackgroundFxHost, { enabled: state.settings.enabled }), jsx(SidebarBoardCutout, { enabled: state.settings.enabled }), jsx(HddOverlayScrollbars, { enabled: state.settings.enabled }), jsx(Stage, { state }), jsx(HeroHost, { controller }), jsx(ActiveComposerPlaceholder, { controller }), jsx(HeroToggleHost, { controller }), jsx(BrandHost, { controller }), jsx(PowerHost, { controller })] });
    }

    // Lifecycle: brand and power geometry
    // Owner: React host node
    // Contract: lifecycle-ownership.json#owners[subsystem=brand and power geometry]
    function BrandHost({ controller }) {
      const state = useController(controller);
      const hostRef = React.useRef(null);
      const enabled = state.settings.enabled;
      const [positioned, setPositioned] = React.useState(false);

      React.useEffect(() => {
        const host = hostRef.current;
        if (!host || !enabled) {
          setPositioned(false);
          return;
        }
        const lifecycle = claimBrandSidebarGeometry(host);
        let brand = null;
        let resizeObserver = null;
        let structureObserver = null;

        const syncBrandGeometry = () => {
          const next = sidebar(document)?.querySelector('[data-dsh-fairy-brand-anchor="true"]') || null;
          if (next !== brand) {
            lifecycle.replaceBinding('brand-node', () => resizeObserver?.disconnect(), 'brand-geometry:node-resize-observer');
            resizeObserver?.disconnect();
            brand = next;
            if (typeof ResizeObserver === 'function' && brand) {
              resizeObserver = new ResizeObserver(scheduleBrandGeometry);
              resizeObserver.observe(brand);
              if (brand.parentElement) resizeObserver.observe(brand.parentElement);
            }
          }
          if (!brand) {
            setPositioned(false);
            return;
          }
          const rect = brand.getBoundingClientRect();
          if (rect.width < 1 || rect.height < 1) {
            setPositioned(false);
            return;
          }
          host.style.left = Math.round(rect.left) + 'px';
          host.style.top = Math.round(rect.top + rect.height * .5 - 21) + 'px';
          setPositioned(true);
        };
        const scheduleBrandGeometry = () => {
          if (!lifecycle.disposed) lifecycle.scheduleFrame('brand-geometry-sync', syncBrandGeometry, 'brand-geometry:sync-frame');
        };

        syncBrandGeometry();
        if (typeof MutationObserver === 'function' && document.body) {
          structureObserver = createManagedMutationObserver((records) => {
            if (mutationTouchesSurface(records, `${OFFICIAL_SELECTORS.sidebar}, ${OFFICIAL_SELECTORS.sidebarBrandMark}, ${OFFICIAL_SELECTORS.newSession}`, ['aria-label', 'data-dsh-fairy-brand-anchor'])) scheduleBrandGeometry();
          });
          structureObserver.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-label', 'data-dsh-fairy-brand-anchor'] });
        }
        window.addEventListener('resize', scheduleBrandGeometry, { passive: true });
        const cleanup = () => {
          resizeObserver?.disconnect();
          structureObserver?.disconnect();
          window.removeEventListener('resize', scheduleBrandGeometry);
          host.style.removeProperty('left');
          host.style.removeProperty('top');
        };
        lifecycle.add(cleanup, 'brand-geometry:restore-host');
        return () => lifecycle.dispose();
      }, [enabled]);

      return jsx('div', { ref: hostRef, className: 'dsh-fairy-brand-host', 'data-positioned': String(positioned), hidden: !enabled || !positioned, children: jsx(FairyMark, { controller }) });
    }

    function PowerToggle({ controller }) {
      const state = useController(controller);
      const on = state.settings.powerMode === 'low-power';
      return jsxs('button', {
        type: 'button',
        className: 'dsh-fairy-power-toggle',
        'data-on': String(on),
        'aria-pressed': String(on),
        'aria-label': on ? '关闭省电模式' : '开启省电模式',
        onClick: () => save(controller, 'powerMode', on ? 'normal' : 'low-power'),
        children: [jsx('span', { className: 'dsh-fairy-power-dot' }), on ? '省电模式' : '普通模式'],
      });
    }

    function PowerHost({ controller }) {
      const state = useController(controller);
      const hostRef = React.useRef(null);
      const [positioned, setPositioned] = React.useState(false);
      const enabled = state.settings.enabled;

      React.useLayoutEffect(() => {
        const host = hostRef.current;
        if (!host || !enabled) {
          setPositioned(false);
          return;
        }
        const lifecycle = claimPowerModeGeometry(host);
        let balance = null;
        let conversation = null;
        let resizeObserver = null;
        let structureObserver = null;

        const syncPowerGeometry = () => {
          const nextBalance = balanceAction(document);
          const nextConversation = resolveStageSurface();
          if (nextBalance !== balance || nextConversation !== conversation) {
            resizeObserver?.disconnect();
            balance = nextBalance;
            conversation = nextConversation;
            if (typeof ResizeObserver === 'function') {
              resizeObserver = new ResizeObserver(schedulePowerGeometry);
              if (balance) resizeObserver.observe(balance);
              if (conversation) resizeObserver.observe(conversation);
            }
          }
          if (!balance || !conversation) return setPositioned(false);
          const balanceRect = balance.getBoundingClientRect();
          const conversationRect = conversation.getBoundingClientRect();
          const dailyRow = balance.children[1];
          const amountRow = balance.children[2];
          if (!dailyRow || !amountRow) return setPositioned(false);
          const rectUnion = (nodes) => {
            const rects = nodes.map((node) => node?.getBoundingClientRect()).filter((rect) => rect && rect.width > 0 && rect.height > 0);
            if (!rects.length) return null;
            const left = Math.min(...rects.map((rect) => rect.left));
            const top = Math.min(...rects.map((rect) => rect.top));
            const right = Math.max(...rects.map((rect) => rect.right));
            const bottom = Math.max(...rects.map((rect) => rect.bottom));
            return { left, top, right, bottom, width: right - left, height: bottom - top };
          };
          const dailyRect = rectUnion([...dailyRow.children]) || rectUnion([dailyRow]);
          const amountRect = amountRow.getBoundingClientRect();
          if (!dailyRect || amountRect.width <= 0 || amountRect.height <= 0) return setPositioned(false);
          const left = Math.round(dailyRect.left + (dailyRect.width - POWER_TOGGLE_WIDTH) / 2);
          const top = Math.round(amountRect.top + (amountRect.height - POWER_TOGGLE_HEIGHT) / 2);
          const fitsExpandedSidebar = balanceRect.width >= 180 && left >= balanceRect.left + 8 && left + POWER_TOGGLE_WIDTH <= balanceRect.right - 4 && left + POWER_TOGGLE_WIDTH <= conversationRect.left - 4 && top >= balanceRect.top + 4 && top + POWER_TOGGLE_HEIGHT <= balanceRect.bottom - 4;
          if (!fitsExpandedSidebar || balanceRect.height < 26) return setPositioned(false);
          host.style.left = left + 'px';
          host.style.top = top + 'px';
          setPositioned(true);
        };
        const schedulePowerGeometry = () => {
          if (!lifecycle.disposed) lifecycle.scheduleFrame('power-geometry-sync', syncPowerGeometry, 'power-geometry:sync-frame');
        };

        syncPowerGeometry();
        if (typeof MutationObserver === 'function' && document.body) {
          structureObserver = createManagedMutationObserver((records) => {
            if (mutationTouchesSurface(records, `${OFFICIAL_SELECTORS.sidebar}, ${OFFICIAL_SELECTORS.conversation}, ${OFFICIAL_SELECTORS.balance}`)) schedulePowerGeometry();
          });
          structureObserver.observe(document.body, { childList: true, subtree: true });
        }
        window.addEventListener('resize', schedulePowerGeometry, { passive: true });
        const cleanup = () => {
          resizeObserver?.disconnect();
          structureObserver?.disconnect();
          window.removeEventListener('resize', schedulePowerGeometry);
          host.style.removeProperty('left');
          host.style.removeProperty('top');
        };
        lifecycle.add(cleanup, 'power-geometry:restore-host');
        return () => lifecycle.dispose();
      }, [enabled]);

      return jsx('div', { ref: hostRef, className: 'dsh-fairy-power-host', hidden: !enabled || !positioned, children: jsx(PowerToggle, { controller }) });
    }

    function useHddVisualMode() {
      const readMode = () => document.documentElement?.hasAttribute('data-dsh-fairy-visual') === true;
      const observerManager = getDomObserverManager(document);
      React.useEffect(() => {
        if (readMode()) observerManager.resume();
        else observerManager.suspend();
      });
      return React.useSyncExternalStore((notify) => {
        if (typeof MutationObserver !== 'function' || !document.documentElement) return () => {};
        const observer = createManagedMutationObserver(notify);
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-dsh-fairy-visual'] });
        return () => observer.disconnect();
      }, readMode, readMode);
    }

    function SessionMetricsControl() {
      const [open, setOpen] = React.useState(false);
      const [, setRevision] = React.useState(0);
      const buttonRef = React.useRef(null);
      const panelRef = React.useRef(null);
      const hdd = useHddVisualMode();
      const readStats = () => conversationComposerDock()?.textContent?.trim().replace(/\s+/g, ' ') || '';
      const stats = readStats();
      const statItems = stats.split(/\s*\|\s*/).map((item) => item.trim()).filter(Boolean);
      React.useEffect(() => {
        if (!hdd) return undefined;
        const source = conversationComposerDock();
        if (!source || typeof MutationObserver !== 'function') return undefined;
        const observer = createManagedMutationObserver(() => setRevision((value) => value + 1));
        observer.observe(source, { childList: true, subtree: true, characterData: true });
        return () => observer.disconnect();
      }, [hdd]);
      React.useEffect(() => {
        if (!open) return undefined;
        const onPointerDown = (event) => {
          if (buttonRef.current?.contains(event.target) || panelRef.current?.contains(event.target)) return;
          setOpen(false);
        };
        const onKeyDown = (event) => {
          if (event.key === 'Escape') {
            setOpen(false);
            buttonRef.current?.focus();
          }
        };
        document.addEventListener('pointerdown', onPointerDown, true);
        document.addEventListener('keydown', onKeyDown);
        return () => {
          document.removeEventListener('pointerdown', onPointerDown, true);
          document.removeEventListener('keydown', onKeyDown);
        };
      }, [open]);
      if (!hdd) return null;
      const panelId = 'dsh-fairy-session-metrics-panel';
      return jsxs('span', { className: 'dsh-fairy-session-metrics', children: [
        jsx('button', { ref: buttonRef, type: 'button', className: 'dsh-fairy-session-metrics-button', 'aria-expanded': open, 'aria-controls': panelId, onClick: () => setOpen((value) => !value), children: '统计' }),
        open ? jsx('div', { ref: panelRef, id: panelId, className: 'dsh-fairy-session-metrics-panel', role: 'dialog', 'aria-label': '会话统计', children: statItems.length ? statItems.map((item, index) => jsx('div', { className: 'dsh-fairy-session-metrics-item', children: item }, `${index}:${item}`)) : '暂无会话统计' }) : null,
      ] });
    }

    /** 归一化提问件：真源是 fairy-contracts/client-ask-kit.cjs，构建时内联。 */
    const askKit = createAskKit({ React, jsx, jsxs, primitives: uiPrimitives });

    /** 本卡提问的视觉字段（写回 `fairy-visual`）与身份字段（写回 `fairy-identity`）。 */
    const VISUAL_FIELDS = ['enabled', 'theme', 'mascotVisible', 'powerMode', 'contentFade'];
    const IDENTITY_TEXT_FIELDS = ['customName', 'secondAssistant'];
    const IDENTITY_MODE_OPTIONS = [
      { value: 'ling', label: '铃' },
      { value: 'zhe', label: '哲' },
      { value: 'custom', label: '自定义' },
    ];

    /** 家庭成员的线上形态：顿号/逗号分隔、最多 12 项（与逐键写盘时一致）。 */
    const parseHousehold = (text) => String(text ?? '').split(/[、,，]/).map((value) => value.trim()).filter(Boolean).slice(0, 12);
    const sameHousehold = (left, right) => left.length === right.length && left.every((value, index) => value === right[index]);

    /** 两处命名空间在卡片里的稳定形态：草稿只覆盖其中的几个字段。 */
    const askShape = (visual, identity) => ({
      enabled: visual.enabled === true,
      theme: visual.theme === 'light' ? 'light' : 'dark',
      mascotVisible: visual.mascotVisible === true,
      powerMode: visual.powerMode === 'low-power' ? 'low-power' : 'normal',
      contentFade: visual.contentFade === true,
      mode: identity.mode || 'ling',
      customName: typeof identity.customName === 'string' ? identity.customName : '',
      secondAssistant: typeof identity.secondAssistant === 'string' ? identity.secondAssistant : '',
      household: Array.isArray(identity.household) ? identity.household.join('、') : '',
    });

    /** 草稿里相对当前值真改过的字段：只有这些会被写盘。 */
    function changedFields(draft, current) {
      const visual = VISUAL_FIELDS.filter((field) => draft[field] !== undefined && draft[field] !== current[field]).map((field) => [field, draft[field]]);
      const identity = [];
      if (draft.mode !== undefined && draft.mode !== current.mode) identity.push(['mode', draft.mode]);
      for (const field of IDENTITY_TEXT_FIELDS) {
        if (draft[field] !== undefined && draft[field] !== current[field]) identity.push([field, draft[field]]);
      }
      if (draft.household !== undefined && !sameHousehold(parseHousehold(draft.household), parseHousehold(current.household))) {
        identity.push(['household', parseHousehold(draft.household)]);
      }
      return { visual, identity };
    }

    /** 写盘失败先留诊断再抛出，交给提问件把原因写进状态行。 */
    const writeSetting = (scope, field, value) => setControllerSetting(scope, field, value).catch((error) => {
      settingError(field, error);
      throw error;
    });

    function Settings({ controller, identitySettings }) {
      // 组件作用域里的绑定：即便将来有别的机制往这个 bundle 里再塞一份套件，
      // 也不会在工厂顶层撞名。
      const { ASK_TEXT, AskSection, AskRow, AskText, AskSelect, AskToggle, AskActions, useAskForm } = askKit;
      const state = useController(controller);
      // Keep a cached value for the host settings bridge. Some host versions
      // return a fresh snapshot wrapper on every read; passing that directly to
      // useSyncExternalStore makes React treat every render as a change and can
      // abort the settings section render entirely. The visual Controller above
      // already follows the same stable-subscription pattern.
      const readIdentity = () => identitySettings.getSnapshot()?.value || {};
      const [identityValue, setIdentityValue] = React.useState(readIdentity);
      React.useEffect(() => {
        const refresh = () => setIdentityValue(readIdentity());
        refresh();
        return identitySettings.subscribe(refresh);
      }, [identitySettings]);
      // 主机设置桥用 `writable: false` 声明只读会话；字段缺失时按可写处理，
      // 免得整张卡被误判成只读。
      const writable = identitySettings.getSnapshot()?.writable !== false;
      const live = askShape(state.settings, identityValue);
      // 读写都以“现读一次”为准：挂载后才到达的主机值与会话头那个 H.D.D 开关
      // 都不经过草稿，草稿只负责用户改过的那几个字段。
      const readCurrent = () => askShape(controller.getSnapshot().settings, readIdentity());
      const form = useAskForm({
        load: readCurrent,
        save: async (draft) => {
          const { visual, identity } = changedFields(draft, readCurrent());
          if (!visual.length && !identity.length) return { changed: false };
          for (const [field, value] of visual) await writeSetting(controller, field, value);
          for (const [field, value] of identity) await writeSetting(identitySettings, field, value);
          return { changed: true };
        },
      });
      const value = (key) => (form.draft[key] === undefined ? live[key] : form.draft[key]);
      /** 失败已经进了状态行与诊断，这里只挡住重复抛出的未处理拒绝。 */
      const submit = () => { form.submit().catch(() => {}); };
      /** 文本行失焦即落盘；草稿与当前值一致时不空跑一条状态文案。 */
      const flush = () => {
        const { visual, identity } = changedFields(form.draft, readCurrent());
        if (form.busy === null && (visual.length || identity.length)) submit();
      };
      const customMode = value('mode') === 'custom';
      return jsxs(AskSection, {
        title: 'HDD 视觉与 Fairy 身份',
        children: [
          jsx(AskToggle, { id: 'dsh-fairy-visual-enabled', label: '启用 HDD 视觉', checked: value('enabled'), disabled: !writable, onChange: (next) => form.change('enabled', next) }, 'enabled'),
          jsx(AskToggle, { id: 'dsh-fairy-visual-theme', label: 'HDD 日间模式', checked: value('theme') === 'light', disabled: !writable, onChange: (next) => form.change('theme', next ? 'light' : 'dark') }, 'theme'),
          jsx(AskToggle, { id: 'dsh-fairy-visual-mascot', label: '显示 Fairy 主视觉', checked: value('mascotVisible'), disabled: !writable, onChange: (next) => form.change('mascotVisible', next) }, 'mascot'),
          jsx(AskToggle, { id: 'dsh-fairy-visual-power', label: '低功耗模式', checked: value('powerMode') === 'low-power', disabled: !writable, onChange: (next) => form.change('powerMode', next ? 'low-power' : 'normal') }, 'power'),
          jsx(AskToggle, { id: 'dsh-fairy-visual-content-fade', label: '内容遮罩', hint: '开启时主视觉会遮住其下的正文（生成期间新文字会变淡）；关闭后正文始终可读。', checked: value('contentFade'), disabled: !writable, onChange: (next) => form.change('contentFade', next) }, 'contentFade'),
          jsx(AskRow, { id: 'dsh-fairy-identity-mode', label: 'Fairy 当前将我识别为：', children: jsx(AskSelect, { id: 'dsh-fairy-identity-mode', value: value('mode'), options: IDENTITY_MODE_OPTIONS, disabled: !writable, onChange: (next) => form.change('mode', next) }) }, 'mode'),
          jsx('div', {
            onBlur: flush,
            children: customMode ? [
              jsx(AskRow, { id: 'dsh-fairy-identity-custom-name', label: '自定义称呼：', children: jsx(AskText, { id: 'dsh-fairy-identity-custom-name', value: value('customName'), disabled: !writable, onChange: (next) => form.change('customName', next.slice(0, 40)) }) }, 'customName'),
              jsx(AskRow, { id: 'dsh-fairy-identity-second-assistant', label: '第二助手（可选）：', children: jsx(AskText, { id: 'dsh-fairy-identity-second-assistant', value: value('secondAssistant'), disabled: !writable, onChange: (next) => form.change('secondAssistant', next.slice(0, 40)) }) }, 'secondAssistant'),
              jsx(AskRow, { id: 'dsh-fairy-identity-household', label: '家庭成员（可选，逗号分隔）：', children: jsx(AskText, { id: 'dsh-fairy-identity-household', value: value('household'), disabled: !writable, onChange: (next) => form.change('household', next.slice(0, 240)) }) }, 'household'),
            ] : null,
          }, 'custom'),
          jsx(AskActions, { busy: form.busy, status: writable ? form.status : ASK_TEXT.readOnly, primary: ASK_TEXT.save, onPrimary: submit, writable }, 'actions'),
        ],
      });
    }

function apply(ctx) {
      return diagnostics.guard('apply', () => {
      const settings = ctx.settingsScope.bind({ namespace: SETTINGS_NAMESPACE });
      const identitySettings = ctx.settingsScope.bind({ namespace: IDENTITY_SETTINGS_NAMESPACE });
      syncDocumentMode(settings.getSnapshot());
      injectStyles();
      const selectionGuard = createSelectionGuard({
        selector: [
          OFFICIAL_SELECTORS.sidebarResizeHandle,
          '.dsh-fairy-composer-resizer',
          '.dsh-history-overlay-scrollbar-thumb',
        ].join(','),
      });
      ctx.effect(() => () => selectionGuard.dispose(), 'dsh-fairy-visual selection guard');
      const controller = new Controller(settings, ctx.sessions);
      if (typeof window !== 'undefined' && typeof process !== 'undefined' && process.env?.NODE_ENV === 'development') {
        window.__fairyVisualLifecycle = {
          inspectController: () => controller.lifecycle?.inspect?.() || [],
        };
      }
      ctx.effect(() => () => controller.dispose(), 'dsh-fairy-visual controller');
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'dsh-fairy-visual-stage', order: 10 }, () => jsx(StageHost, { controller })));
      ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({ name: 'conversation.session.header.utilities', id: 'dsh-fairy-session-metrics', order: 80 }, () => jsx(SessionMetricsControl, {})));
      ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({ name: 'conversation.session.header.utilities', id: 'dsh-fairy-visual-toggle', order: 90 }, () => jsx(Toggle, { controller })));
      ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'dsh-fairy-visual', order: 45, label: () => 'HDD 视觉与 Fairy 身份' }, () => jsx(Settings, { controller, identitySettings })));
      }, { surface: 'client' });
    }

    module.exports = { apply, inject: ['slots', 'sessions', 'settingsScope'], name: 'dsh-fairy-visual' };
