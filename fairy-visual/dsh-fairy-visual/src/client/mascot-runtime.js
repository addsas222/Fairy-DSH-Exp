const { createManagedMutationObserver } = require('./dom-observer-manager.js');
const { CSS, PULSE_SVG, HALO_SVG, SVG } = require('./mascot-assets.js');
const { createMascotMotionClock } = require('./mascot-motion-clock.js');
const { createMascotEventScheduler } = require('./mascot-event-scheduler.js');
const { SPEED_EVENT } = require('./mascot-animation-speed-control.js');

function createMascotRuntime() {
	let mascotRuntime = null;
		(function fairyVisualRuntime() {
			/*
			 * Fairy mascot runtime: mount ownership, state transitions, animation timing,
			 * and lifecycle cleanup. Static CSS and SVG templates live in mascot-assets.js.
			 *
			 * Visual model, from outside to inside:
			 * 1. Blue outer disc and thin white rim.
			 * 2. Rotating dark four-corner shape: Fairy's lashes / eyelids.
			 * 3. White disc: sclera.
			 * 4. Gray-blue, thin white, blue, and dark circles: eyeball layers.
			 * 5. White circle near the lower-right: highlight attached to the blue eyeball layer.
			 *
			 * Motion model:
			 * - Lashes rotate clockwise at constant speed.
			 * - Eye layers continuously contract and expand from the inside outward.
			 * - Glitches alternate between horizontal threads and five displaced horizontal blocks.
			 */
			if (typeof document === "undefined") return;

			/* The host is supplied by Harness; this ID belongs only to Fairy's child node. */
			const ROOT_ID = "dsh-fairy-root";
			const HOST_SELECTOR = ".dsh-fairy-stage";
			const STYLE_ID = "dsh-fairy-mascot-style";
				let root = null;
				let mountedHost = null;
				let mountedOwner = null;
				let mountGeneration = 0;
				let hostObserver = null;
				let observedHost = null;
			let glitchTimer = null;
			let animationRate = 1;
			let speedListener = null;
			let eyeFlickerTimer = null;
			let eyeFlickerToken = 0;
			let glitchToken = 0;
			let stateTransitionTimer = null;
				let stateTransitionToken = 0;
			let appliedState = null;
			let signalElement = null;
			let scleraElement = null;
			let layerThreeElements = [];
			let layerTwoElements = [];
			let layerOneElements = [];
			let imageElement = null;
			let thinkingClipShape = null;
			let comfortingClipShape = null;
			let noiseElement = null;
			let displacementElement = null;
			let blockSliceRects = [];
				let motionQuery = null;
				let motionOwner = null;
				let motionGeneration = 0;
			const motionClock = createMascotMotionClock();
			const eventScheduler = createMascotEventScheduler();
			let visualSuspended = false;
			/* The host can announce its active state before the slot has a DOM node.
			 * Keep that request separate from the first mounted frame so startup takes
			 * the same resume path as an explicit HDD re-enable. */
			let requestedVisualActive = false;
				function isLifecycleVisible() {
					return document.visibilityState !== "hidden";
				}
				let lifecycleVisible = isLifecycleVisible();
				function isCurrentMount(owner, generation, stage) {
					return Boolean(
						owner &&
						owner.active !== false &&
						mountedOwner === owner &&
						mountGeneration === generation &&
						(!stage || mountedHost === stage),
					);
				}

				function isValidOwner(owner, stage) {
					return Boolean(owner && owner.active !== false && owner.stage === stage);
				}

				function unbindMotionListener() {
					if (motionQuery && motionChangeListener) {
						if (typeof motionQuery.removeEventListener === "function") motionQuery.removeEventListener("change", motionChangeListener);
						else if (typeof motionQuery.removeListener === "function") motionQuery.removeListener(motionChangeListener);
					}
					motionQuery = null;
					motionChangeListener = null;
					motionOwner = null;
					motionGeneration = 0;
				}

				function cancelLifecycleResume() {
					if (lifecycleResumeFrame) cancelAnimationFrame(lifecycleResumeFrame);
					lifecycleResumeFrame = 0;
					lifecycleToken += 1;
				}

				/* A new owner or root invalidates every callback created by the old mount. */
			function invalidateMountResources() {
					stopGlitch();
					cancelLifecycleResume();
					hostObserver?.disconnect();
					hostObserver = null;
					observedHost = null;
					unbindMotionListener();
					unbindLifecycleListeners();
					if (speedListener) window.removeEventListener(SPEED_EVENT, speedListener);
					speedListener = null;
					mountGeneration += 1;
				}

				let visualActiveInitialized = false;
			let lifecycleResumeFrame = 0;
			let motionFrame = 0;
			let lifecycleToken = 0;
			let motionChangeListener = null;
				let lifecycleVisibilityListener = null;
			let lifecyclePageHideListener = null;
				let lifecyclePageShowListener = null;
				let lifecycleListenerOwner = null;
				let lifecycleListenerGeneration = 0;
			/* Modes alternate so both effects are guaranteed to appear during observation. */
			let lastGlitchMode = Math.random() < .5 ? "threads" : "blocks";
			const FAULT_TIMING = Object.freeze({
				threads: Object.freeze({ pulses: 4, gapMin: 30, gapMax: 42, fadeMin: 34, fadeMax: 76 }),
				blocks: Object.freeze({ gapMin: 56, gapMax: 104, fadeMin: 48, fadeMax: 96 }),
			});

				function randomBetween(min, max) {
					return min + Math.random() * (max - min);
				}

				/* Cache the small, fixed SVG surface once per mount. Fault pulses can then
				 * update attributes directly without repeating selector walks. */
			function cacheVisualNodes() {
				signalElement = root ? root.querySelector(".dsh-fairy-signal") : null;
				scleraElement = root ? root.querySelector(".dsh-fairy-sclera") : null;
				imageElement = root ? root.querySelector(".dsh-fairy-image") : null;
				thinkingClipShape = root ? root.querySelector(".dsh-fairy-thinking-clip-shape") : null;
				comfortingClipShape = root ? root.querySelector(".dsh-fairy-comforting-clip-shape") : null;
				noiseElement = root ? root.querySelector("#dsh-fairy-noise") : null;
				displacementElement = root ? root.querySelector("#dsh-fairy-displace") : null;
				blockSliceRects = root ? Array.from(root.querySelectorAll("[id^=dsh-fairy-slice-] rect")) : [];
				layerThreeElements = root ? Array.from(root.querySelectorAll(".dsh-fairy-layer-three")) : [];
				layerTwoElements = root ? Array.from(root.querySelectorAll(".dsh-fairy-layer-two")) : [];
				layerOneElements = root ? Array.from(root.querySelectorAll(".dsh-fairy-layer-one")) : [];
				/* The browser must not create a second playback clock for any continuously
				 * breathing layer. Their transforms are committed by renderMotionFrame(). */
					[scleraElement,
					...layerThreeElements, ...layerTwoElements, ...layerOneElements].forEach((element) => {
						if (element) element.style.animation = "none";
					});
				[thinkingClipShape, comfortingClipShape].forEach((element) => {
					if (element) element.style.animation = "none";
				});
			}

			/* One normalized phase is the only animation state owned by JavaScript. */
			function currentEyeMotionPhase() { return motionClock.phase(); }

			/* The concentric eye layers must never own separate browser timelines. The
			 * renderer below evaluates the original cubic-bezier keyframes from one
			 * normalized phase and commits every transform in the same animation frame. */
			function easeEyePhase(value) {
				const x = Math.max(0, Math.min(1, value));
				let low = 0;
				let high = 1;
				for (let i = 0; i < 12; i += 1) {
					const t = (low + high) / 2;
					const xValue = 3 * (1 - t) * (1 - t) * t * .72 + 3 * (1 - t) * t * t * .28 + t * t * t;
					if (xValue < x) low = t;
					else high = t;
				}
				const t = (low + high) / 2;
				return 3 * (1 - t) * t * t + t * t * t;
			}
			function readEyeProgress(phase) {
			const cyclePhase = ((phase % 1) + 1) % 1;
			return easeEyePhase(cyclePhase <= .5 ? cyclePhase * 2 : 2 - cyclePhase * 2);
			}
			function normalizeMotionTargets(value) {
				return Array.isArray(value) ? value : value ? [value] : [];
			}
			function renderMotionFrame() {
				if (!root || visualSuspended) return;
				const phase = currentEyeMotionPhase();
				const layers = [
					[scleraElement, .985, .91, 0],
					[layerThreeElements, 1, .90, 45],
					[layerTwoElements, 1, .87, 90],
					[layerOneElements, 1, .85, 180],
				];
				layers.forEach(([elements, from, to, leadMs]) => {
					const targets = normalizeMotionTargets(elements);
					if (!targets.length) return;
					const progress = readEyeProgress(phase + leadMs / 1440);
					const transform = "scale(" + (from + (to - from) * progress).toFixed(6) + ")";
					targets.forEach((element) => { element.style.transform = transform; });
				});
				const state = root.getAttribute("data-state");
				const clip = state === "thinking" ? thinkingClipShape : state === "comforting" ? comfortingClipShape : null;
				[thinkingClipShape, comfortingClipShape].forEach((element) => {
					if (element && element !== clip) element.style.transform = "";
				});
				if (clip) {
					const clipProgress = readEyeProgress(phase);
					clip.style.willChange = "transform";
					clip.style.transform = state === "thinking"
						? "translateY(" + (14.5 + clipProgress).toFixed(6) + "px) scaleY(" + (.55 + .45 * clipProgress).toFixed(6) + ")"
						: "translateY(" + (-4 + 8 * clipProgress).toFixed(6) + "px)";
				}
			}
			function startMotionLoop() {
				if (motionFrame || visualSuspended || !root) return;
				const tick = () => {
					motionFrame = 0;
					if (!root || visualSuspended) return;
					renderMotionFrame();
					motionFrame = requestAnimationFrame(tick);
				};
				renderMotionFrame();
				motionFrame = requestAnimationFrame(tick);
			}

			function stopMotionLoop() {
				if (motionFrame) cancelAnimationFrame(motionFrame);
				motionFrame = 0;
			}

			function alignEyeLayersToClock() {
				renderMotionFrame();
			}

			function pauseClipAnimation(shape) {
				if (!shape) return;
				/* Freeze the inactive path before assigning the next master-clock frame. */
				shape.style.animationDelay = "0s";
				shape.style.animationPlayState = "paused";
				shape.style.willChange = "auto";
			}

			function synchronizeActiveClipPhase(nextState) {
				if (!root) return;
				/* All continuous layers and the active clip are rendered from the same phase. */
				alignEyeLayersToClock();
				pauseClipAnimation(thinkingClipShape);
				pauseClipAnimation(comfortingClipShape);
				if (nextState !== "normal" && !(motionQuery && motionQuery.matches)) renderMotionFrame();
			}

			/* Build five mildly uneven blocks. Weights are constrained to avoid extreme sizes. */
			function setBlockLayout() {
				const weights = [];
				let weightTotal = 0;
				for (let i = 0; i < 5; i += 1) {
					const weight = randomBetween(.9, 1.1);
					weights.push(weight);
					weightTotal += weight;
				}

				let y = 12;
				for (let i = 0; i < 5; i += 1) {
					const rect = blockSliceRects[i] || (root && root.querySelector("#dsh-fairy-slice-" + (i + 1) + " rect"));
					if (!rect) continue;
					const height = i === 4 ? 148 - y : 136 * weights[i] / weightTotal;
					rect.setAttribute("y", y.toFixed(1));
					rect.setAttribute("height", height.toFixed(1));
					y += height;
				}
			}

			/* Removing the attribute restores the untouched normal visual immediately. */
			function clearGlitchVisual() {
				if (!root) return;
				const signal = signalElement || root.querySelector(".dsh-fairy-signal");
				if (!signal) return;
				signal.removeAttribute("data-glitch");
				["--dsh-g-x", "--dsh-g-skew", "--dsh-g-bright", "--dsh-g-contrast", "--dsh-g-s1-x", "--dsh-g-s2-x", "--dsh-g-s3-x", "--dsh-g-s4-x", "--dsh-g-s5-x"].forEach(function (name) {
					signal.style.removeProperty(name);
				});
			}

			function stopEyeFlicker() {
				eyeFlickerToken += 1;
				eventScheduler.cancel('flicker');
				eyeFlickerTimer = null;
				if (imageElement) imageElement.removeAttribute("data-flicker");
				if (imageElement) ["--dsh-fairy-flicker-duration", "--dsh-fairy-flicker-opacity-1", "--dsh-fairy-flicker-opacity-mid", "--dsh-fairy-flicker-opacity-2"].forEach(function (name) { imageElement.style.removeProperty(name); });
			}

			function scheduleEyeFlicker(owner, generation) {
				if (!isCurrentMount(owner, generation) || eventScheduler.has('flicker') || !root || root.getAttribute("data-state") !== "normal" || root.hasAttribute("data-low-power") || visualSuspended || (motionQuery && motionQuery.matches)) return;
				const token = eyeFlickerToken;
				eyeFlickerTimer = eventScheduler.schedule('flicker', function () {
					eyeFlickerTimer = null;
					if (!isCurrentMount(owner, generation) || token !== eyeFlickerToken || !root || root.getAttribute("data-state") !== "normal" || root.hasAttribute("data-low-power") || visualSuspended || (motionQuery && motionQuery.matches)) return;
					if (!imageElement) imageElement = root.querySelector(".dsh-fairy-image");
					if (!imageElement) return;
					const duration = randomBetween(155, 255);
					imageElement.style.setProperty("--dsh-fairy-flicker-duration", duration.toFixed(0) + "ms");
					imageElement.style.setProperty("--dsh-fairy-flicker-opacity-1", randomBetween(.026, .048).toFixed(3));
					imageElement.style.setProperty("--dsh-fairy-flicker-opacity-mid", randomBetween(.006, .016).toFixed(3));
					imageElement.style.setProperty("--dsh-fairy-flicker-opacity-2", randomBetween(.018, .040).toFixed(3));
					imageElement.setAttribute("data-flicker", "true");
					eyeFlickerTimer = eventScheduler.schedule('flicker', function () {
						eyeFlickerTimer = null;
						if (imageElement) imageElement.removeAttribute("data-flicker");
						if (token === eyeFlickerToken) scheduleEyeFlicker(owner, generation);
					}, duration);
				}, randomBetween(1750, 3600) / animationRate);
			}

			/*
			 * SVG <use> block clones can advance their nested CSS animations on
			 * slightly different timelines. Capture one angle before exposing the
			 * clones, then share its phase so every lash copy is identical.
			 */
			function lockLashFrame(signal) {
				const corners = signal && signal.querySelector(".dsh-fairy-image .dsh-fairy-corners");
				if (!signal || !corners) return;
				const transform = window.getComputedStyle(corners).transform;
				let angle = 0;
				const match = transform && transform.match(/^matrix\(([^)]+)\)$/);
				if (match) {
					const values = match[1].split(",");
					const a = parseFloat(values[0]);
					const b = parseFloat(values[1]);
					if (Number.isFinite(a) && Number.isFinite(b)) angle = Math.atan2(b, a) * 180 / Math.PI;
				}
				const normalized = (angle + 360) % 360;
				signal.style.setProperty("--dsh-lash-angle", normalized.toFixed(3) + "deg");
				signal.style.setProperty("--dsh-lash-delay", (-normalized / 360 * 15).toFixed(4) + "s");
			}

			/*
			 * Generate one short randomized pulse.
			 * threads: vertically varying noise displaces pixels only along the horizontal axis.
			 * blocks: five adjacent clips move left/right with alternating polarity.
			 */
			function setGlitchPulse(signal, mode, isTransition) {
				const style = signal.style;
				style.setProperty("--dsh-g-x", randomBetween(isTransition ? -1.6 : -.9, isTransition ? 1.6 : .9).toFixed(2) + "px");
				style.setProperty("--dsh-g-skew", randomBetween(isTransition ? -.32 : -.24, isTransition ? .32 : .24).toFixed(2) + "deg");
				style.setProperty("--dsh-g-bright", randomBetween(isTransition ? 1.06 : 1.02, isTransition ? 1.18 : 1.14).toFixed(2));
				style.setProperty("--dsh-g-contrast", randomBetween(isTransition ? 1.08 : 1.02, isTransition ? 1.22 : 1.16).toFixed(2));

				const noise = noiseElement;
				const displacement = displacementElement;
				if (mode === "threads") {
					/* Turbulence generation is the costliest fault primitive. A short burst
					 * already jitters via the signal variables above, so generate one noise field
					 * at its first frame and reuse it for the remaining 24-48ms pulses. */
					const beginsThreadBurst = signal.getAttribute("data-glitch") !== "threads";
					if (beginsThreadBurst && noise) {
						noise.setAttribute("seed", String(Math.floor(randomBetween(1, 999))));
						noise.setAttribute("baseFrequency", randomBetween(.004, .011).toFixed(3) + " " + randomBetween(isTransition ? .78 : .65, isTransition ? 1.18 : 1).toFixed(2));
					}
					if (beginsThreadBurst && displacement) displacement.setAttribute("scale", randomBetween(isTransition ? 30 : 17, isTransition ? 46 : 29).toFixed(1));
				} else {
					/* Lock the rotating lashes once per block event; rewriting the delay on
					 * every short pulse would restart the CSS animation timeline. */
					if (!signal.hasAttribute("data-glitch")) lockLashFrame(signal);
					const slicePolarity = Math.random() < .5 ? -1 : 1;
					const sliceStrength = randomBetween(isTransition ? 4.2 : 1.4, isTransition ? 6.8 : 3);
					for (let i = 1; i <= 5; i += 1) {
						const direction = i % 2 === 0 ? slicePolarity : -slicePolarity;
						const offset = direction * (sliceStrength + randomBetween(-.35, .35));
						style.setProperty("--dsh-g-s" + i + "-x", offset.toFixed(2) + "px");
					}
				}
				signal.setAttribute("data-glitch", mode);
			}

			/* Match the preview's two-burst transition: a short threaded tear followed by
			 * a longer blocks-and-threads burst. The target expression is already committed
			 * before this starts, so the original visual is retained without old-state flash. */
			function playStateTransition(nextState, owner, generation) {
				if (!isCurrentMount(owner, generation) || !root || visualSuspended || (motionQuery && motionQuery.matches)) return;
				stopGlitch();
				const signal = signalElement || root.querySelector(".dsh-fairy-signal");
				if (!signal) return;
				const token = ++stateTransitionToken;
				root.setAttribute("data-transition-target", nextState);

				function runBurst(pulseCount, blockPulseCount, keepVisual, onComplete) {
					let pulseIndex = 0;
					root.setAttribute("data-transition-glitch", "true");
					function pulse() {
						if (!isCurrentMount(owner, generation) || token !== stateTransitionToken || (motionQuery && motionQuery.matches)) {
							return;
						}
						if (pulseIndex < blockPulseCount) {
							if (pulseIndex === 0) setBlockLayout();
							setGlitchPulse(signal, "blocks", true);
						} else {
							setGlitchPulse(signal, "threads", true);
						}
						pulseIndex += 1;
						if (pulseIndex < pulseCount) {
							stateTransitionTimer = eventScheduler.schedule('transition', pulse, 40);
							return;
						}
						stateTransitionTimer = eventScheduler.schedule('transition', function () {
							if (!isCurrentMount(owner, generation) || token !== stateTransitionToken) return;
							stateTransitionTimer = null;
							if (!keepVisual) {
								root.removeAttribute("data-transition-glitch");
								clearGlitchVisual();
							}
							onComplete();
						}, 28);
					}
					pulse();
				}

				runBurst(2, 0, true, function () {
					if (!isCurrentMount(owner, generation) || token !== stateTransitionToken || (motionQuery && motionQuery.matches)) return;
					runBurst(6, 2, false, function () {
						if (!isCurrentMount(owner, generation) || token !== stateTransitionToken) return;
						root.removeAttribute("data-transition-target");
						scheduleGlitch(owner, generation);
						scheduleEyeFlicker(owner, generation);
					});
				});
			}

			/* Schedule the next event after 2.3-4.6 seconds, then emit several short pulses. */
				function armGlitchTimer(callback, delay) {
					let timer = null;
					timer = eventScheduler.schedule('glitch', function () {
						/* A stale callback must never clear a timer owned by a newer mount. */
						if (glitchTimer === timer) glitchTimer = null;
						callback();
					}, delay);
					glitchTimer = timer;
					return timer;
				}

				function scheduleGlitch(owner, generation) {
				if (!isCurrentMount(owner, generation) || eventScheduler.has('glitch') || !root || visualSuspended || (motionQuery && motionQuery.matches)) return;
				const token = glitchToken;
				armGlitchTimer(function () {
					if (!isCurrentMount(owner, generation) || token !== glitchToken || !root || visualSuspended || (motionQuery && motionQuery.matches)) return;
						const signal = signalElement || root.querySelector(".dsh-fairy-signal");
					if (!signal) return;
					const mode = lastGlitchMode === "threads" ? "blocks" : "threads";
					lastGlitchMode = mode;
					if (mode === "blocks") setBlockLayout();
					/* Threads remain brief. Each block event doubles its original 1-2 pulse window. */
					/* Threads are intentionally given a longer readable window than the
					 * block fault: three to four short pulses, followed by a slightly
					 * longer fade, keeps the tear visible without making it persistent. */
					const pulseCount = mode === "threads" ? FAULT_TIMING.threads.pulses : 2 * (1 + Math.floor(Math.random() * 2));
					let pulseIndex = 0;

					function pulse() {
						if (!isCurrentMount(owner, generation) || token !== glitchToken || visualSuspended || (motionQuery && motionQuery.matches)) {
							return;
						}
						setGlitchPulse(signal, mode);
						pulseIndex += 1;
						if (pulseIndex < pulseCount) {
							const timing = FAULT_TIMING[mode];
							armGlitchTimer(pulse, randomBetween(timing.gapMin, timing.gapMax));
						} else {
							armGlitchTimer(function () {
								if (!isCurrentMount(owner, generation) || token !== glitchToken) return;
								clearGlitchVisual();
								scheduleGlitch(owner, generation);
							}, mode === "threads" ? randomBetween(FAULT_TIMING.threads.fadeMin, FAULT_TIMING.threads.fadeMax) : randomBetween(FAULT_TIMING.blocks.fadeMin, FAULT_TIMING.blocks.fadeMax));
						}
					}

					pulse();
				}, randomBetween(2300, 4600) / animationRate);
			}

			/* Invalidating the token also cancels callbacks already queued by an older event. */
				function stopGlitch() {
					glitchToken += 1;
				stateTransitionToken += 1;
				eventScheduler.cancel('glitch');
				eventScheduler.cancel('transition');
				glitchTimer = null;
				stateTransitionTimer = null;
				if (root) root.removeAttribute("data-transition-glitch");
						if (root) root.removeAttribute("data-transition-target");
						clearGlitchVisual();
						stopEyeFlicker();
			}

				/* Reduced-motion changes stop both CSS motion and JavaScript-driven glitches. */
			function ensureGlitchScheduler(owner, generation) {
						if (!isCurrentMount(owner, generation)) return;
						if (motionQuery && (motionOwner !== owner || motionGeneration !== generation)) unbindMotionListener();
						if (!motionQuery && typeof window !== "undefined" && typeof window.matchMedia === "function") {
						motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
						motionOwner = owner;
						motionGeneration = generation;
						motionChangeListener = function () {
							if (!isCurrentMount(owner, generation)) return;
							if (motionQuery.matches) {
								stopGlitch();
								synchronizeActiveClipPhase("normal");
							} else {
								synchronizeActiveClipPhase(root && root.getAttribute("data-state"));
								scheduleGlitch(owner, generation);
						}
					};
					if (typeof motionQuery.addEventListener === "function") motionQuery.addEventListener("change", motionChangeListener);
					else if (typeof motionQuery.addListener === "function") motionQuery.addListener(motionChangeListener);
				}
				if (visualSuspended || (motionQuery && motionQuery.matches)) {
					synchronizeActiveClipPhase("normal");
					return;
				}
					scheduleGlitch(owner, generation);
					scheduleEyeFlicker(owner, generation);
			}
			/* Styles may be removed by the host application, so mounting always rechecks them. */
			function ensureStyle() {
				if (document.getElementById(STYLE_ID)) return;
				const style = document.createElement("style");
				style.id = STYLE_ID;
				style.setAttribute("data-plugin", "dsh-fairy-visual");
				style.textContent = CSS;
				(document.head || document.documentElement).appendChild(style);
			}
				function setAnimationRate(nextRate) {
					const numericRate = typeof nextRate === "string" ? Number(nextRate) : nextRate;
					const rate = numericRate === .7 || numericRate === 1.5 ? numericRate : 1;
					const changed = rate !== animationRate;
				if (changed) motionClock.setRate(rate);
				animationRate = rate;
				if (!root) return;
				root.setAttribute("data-dsh-fairy-animation-rate", String(rate));
				root.style.setProperty("--dsh-fairy-steady-rate", String(rate));
				/* Keep the pulse-ring motion itself unchanged; only its idle portion
				 * contracts/expands with the selected cadence. */
				root.style.setProperty("--dsh-fairy-pulse-cycle", (1.44 + 2.56 / rate) + "s");
				if (changed) {
					alignEyeLayersToClock();
					/* Thinking/comfort clips are independent CSS animations and must be
					 * re-anchored at the same boundary as the eye layers. */
					synchronizeActiveClipPhase(root.getAttribute("data-state"));
				}
				/* A rate change is a new cadence boundary. Do not leave already queued
				 * glitch/flicker timers running on the old cadence. Transition bursts are
				 * allowed to finish; steady-state schedules restart immediately. */
				if (changed && !root.hasAttribute("data-transition-glitch") && !visualSuspended) {
					stopGlitch();
					if (root.getAttribute("data-state") === "normal") {
						scheduleGlitch(mountedOwner, mountGeneration);
						scheduleEyeFlicker(mountedOwner, mountGeneration);
					}
				}
			}
			function bindSpeedListener() {
				if (speedListener) return;
				speedListener = function (event) { setAnimationRate(event?.detail?.rate); };
				window.addEventListener(SPEED_EVENT, speedListener);
			}
			/* Build once; MutationObserver will reconnect this same node if the host removes it. */
			function build() {
				root = document.createElement("div");
				root.id = ROOT_ID;
				root.setAttribute("data-dsh-fairy-mascot-root", "true");
				root.setAttribute("aria-hidden", "true");
				root.innerHTML = '<div class="dsh-fairy-float">' + HALO_SVG + PULSE_SVG + SVG + "</div>";
				return root;
			}
			/* Commits the visual state after the harness has committed its matching host state.
			 * Repeated state notifications are ignored; a real change cancels its predecessor. */
				function applyVisualState(nextState, playTransition, owner, generation) {
				if (!isCurrentMount(owner, generation) || !root) return;
					const normalized = nextState === "comforting" ? "comforting" : nextState === "thinking" ? "thinking" : "normal";
				if (appliedState === normalized && root.getAttribute("data-state") === normalized) {
					if (!visualSuspended) ensureGlitchScheduler(owner, generation);
					return;
				}
				const stateChanged = appliedState !== null && appliedState !== normalized;
				root.setAttribute("data-state", normalized);
					appliedState = normalized;
					if (visualSuspended) return;
				synchronizeActiveClipPhase(normalized);
				if (stateChanged && playTransition !== false) playStateTransition(normalized, owner, generation);
				else ensureGlitchScheduler(owner, generation);
			}
			function setVisualActive(active, owner, generation = mountGeneration) {
				if (!isCurrentMount(owner, generation)) return;
				requestedVisualActive = active === true;
				const nextActive = requestedVisualActive && lifecycleVisible;
				if (!root) {
					visualSuspended = !nextActive;
					return;
				}
				if (!nextActive) {
					stopMotionLoop();
					motionClock.pause();
					visualSuspended = true;
					lifecycleToken += 1;
					if (lifecycleResumeFrame) cancelAnimationFrame(lifecycleResumeFrame);
					lifecycleResumeFrame = 0;
					stopGlitch();
					root.setAttribute("data-visual-suspended", "true");
					return;
				}
				const shouldResume = !visualActiveInitialized || visualSuspended || root.hasAttribute("data-visual-suspended");
				visualActiveInitialized = true;
				if (!shouldResume) return;
				visualSuspended = false;
				motionClock.resume();
				root.removeAttribute("data-visual-suspended");
				startMotionLoop();
				const token = ++lifecycleToken;
				lifecycleResumeFrame = requestAnimationFrame(function () {
					if (!isCurrentMount(owner, generation) || token !== lifecycleToken || visualSuspended || !root) return;
					lifecycleResumeFrame = 0;
					synchronizeActiveClipPhase(root.getAttribute("data-state"));
					startMotionLoop();
					ensureGlitchScheduler(owner, generation);
				});
			}
			function bindLifecycleListeners(owner, generation) {
				if (lifecycleVisibilityListener && lifecycleListenerOwner === owner && lifecycleListenerGeneration === generation) return;
				unbindLifecycleListeners();
				lifecycleListenerOwner = owner;
				lifecycleListenerGeneration = generation;
				lifecycleVisibilityListener = function () {
					if (!isCurrentMount(owner, generation)) return;
					lifecycleVisible = isLifecycleVisible();
					setVisualActive(requestedVisualActive, owner, generation);
				};
				lifecyclePageHideListener = function () {
					if (!isCurrentMount(owner, generation)) return;
					lifecycleVisible = false;
					setVisualActive(requestedVisualActive, owner, generation);
				};
				lifecyclePageShowListener = function () {
					if (!isCurrentMount(owner, generation)) return;
					lifecycleVisible = isLifecycleVisible();
					setVisualActive(requestedVisualActive, owner, generation);
				};
				document.addEventListener("visibilitychange", lifecycleVisibilityListener);
				window.addEventListener("pagehide", lifecyclePageHideListener);
				window.addEventListener("pageshow", lifecyclePageShowListener);
				}
			function unbindLifecycleListeners() {
				if (!lifecycleVisibilityListener) return;
				document.removeEventListener("visibilitychange", lifecycleVisibilityListener);
				window.removeEventListener("pagehide", lifecyclePageHideListener);
				window.removeEventListener("pageshow", lifecyclePageShowListener);
				lifecycleVisibilityListener = null;
				lifecyclePageHideListener = null;
				lifecyclePageShowListener = null;
				lifecycleListenerOwner = null;
				lifecycleListenerGeneration = 0;
			}
				/* The visual never falls back to document.body: only the official shell-overlay
				 * stage may own it, so application boot cannot flash a temporary second eye. */
				function mount(stageNode, owner, persistedRate) {
					if (!document.body) return;
					const stage = stageNode || owner?.stage;
					if (!isValidOwner(owner, stage) || stage.isConnected === false || (typeof stage.matches === "function" && !stage.matches(HOST_SELECTOR))) return;
					/* A later Stage must take ownership before it can bind any resource. */
					if (mountedOwner && mountedOwner !== owner) dispose(mountedOwner);
					if (mountedOwner !== owner || mountedHost !== stage) {
						mountedOwner = owner;
						mountedHost = stage;
						mountGeneration += 1;
					}
					const stageRoot = stage.id !== ROOT_ID ? stage.querySelector("#" + ROOT_ID) : null;
					const previousRoot = root;
					const rootWasReparented = Boolean(root && root.parentNode !== stage);
					const nextRoot = stageRoot || root || build();
					if ((previousRoot && nextRoot !== previousRoot) || rootWasReparented) {
						invalidateMountResources();
					}
					root = nextRoot;
					root.setAttribute("data-dsh-fairy-mascot-root", "true");
					if (root.parentNode !== stage) {
						stage.appendChild(root);
						motionClock.reset();
						visualActiveInitialized = false;
					}
					if (root !== previousRoot) visualActiveInitialized = false;
					const generation = mountGeneration;
					bindLifecycleListeners(owner, generation);
					lifecycleVisible = isLifecycleVisible();
					ensureStyle();
					bindSpeedListener();
					cacheVisualNodes();
					setAnimationRate(persistedRate === undefined ? animationRate : persistedRate);
					setVisualActive(stage.getAttribute("data-fairy-visual-active") === "true", owner, generation);
					const requestedState = stage.getAttribute("data-fairy-state");
					/* Low-power mode is host-controlled and never changes Fairy's expression state. */
					if (stage.getAttribute("data-fairy-low-power") === "true") root.setAttribute("data-low-power", "");
					else root.removeAttribute("data-low-power");
					applyVisualState(requestedState, true, owner, generation);
					if (!visualSuspended) startMotionLoop();

					if (stage !== observedHost || !hostObserver) {
						if (hostObserver) hostObserver.disconnect();
						observedHost = stage;
						if (typeof MutationObserver !== "undefined") {
							const observedGeneration = generation;
							hostObserver = createManagedMutationObserver(function () {
								if (isCurrentMount(owner, observedGeneration, stage)) mount(stage, owner);
							});
							hostObserver.observe(stage, { childList: true });
						}
					}
				}

				function dispose(owner) {
					if (owner && mountedOwner !== owner) return;
					if (mountedOwner) mountedOwner.active = false;
					invalidateMountResources();
					stopMotionLoop();
					mountedOwner = null;
					mountedHost = null;
					root?.remove();
					root = null;
					cacheVisualNodes();
					appliedState = null;
					motionClock.pause();
					visualSuspended = true;
					requestedVisualActive = false;
					lifecycleVisible = true;
					visualActiveInitialized = false;
					document.getElementById(STYLE_ID)?.remove();
				}
			mascotRuntime = { mount: mount, setVisualActive: setVisualActive, ownsHost: (owner) => mountedOwner === owner || mountedHost === owner, ownsOwner: (owner) => mountedOwner === owner, activeTimerCount: () => eventScheduler.activeCount(), dispose: dispose }; })();
	return mascotRuntime;
}
module.exports = { createMascotRuntime };
