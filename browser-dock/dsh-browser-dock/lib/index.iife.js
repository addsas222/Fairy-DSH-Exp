window.__ModuleLoader__.load({
  id: 'dsh-browser-dock',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    return void 0, 
(function() {

//#region \0rolldown/runtime.js
	var __commonJSMin = (cb, mod) => () => (mod || (cb((mod = { exports: {} }).exports, mod), cb = null), mod.exports);

//#endregion
//#region ../../fairy-contracts/client-diagnostics.cjs
	var require_client_diagnostics = /* @__PURE__ */ __commonJSMin(((exports, module) => {
		const FAIRY_LOG_PREFIX = "DSH_FAIRY_LOG";
		const SENSITIVE_KEY = /authorization|credential|password|secret|token|api[_-]?key|cookie/i;
		function sanitize(value, key = "", depth = 0) {
			if (SENSITIVE_KEY.test(key)) return "[redacted]";
			if (value == null || typeof value === "boolean" || typeof value === "number") return value;
			if (typeof value === "string") return value.length > 320 ? `${value.slice(0, 320)}…` : value;
			if (depth >= 2) return "[truncated]";
			if (Array.isArray(value)) return value.slice(0, 12).map((item) => sanitize(item, "", depth + 1));
			if (typeof value === "object") return Object.fromEntries(Object.entries(value).slice(0, 24).map(([name, item]) => [name, sanitize(item, name, depth + 1)]));
			return String(value);
		}
		function createFairyDiagnostics(moduleName, sink = console) {
			const recentErrors = /* @__PURE__ */ new Map();
			const clock = () => typeof performance === "object" && performance?.now ? performance.now() : Date.now();
			const emit = (level, operation, event, context = {}, error, durationMs) => {
				const normalizedError = error ? {
					name: String(error.name || "Error"),
					code: error.code == null ? void 0 : String(error.code),
					message: String(error.message || error).slice(0, 320)
				} : void 0;
				if (normalizedError) {
					const signature = `${operation}:${normalizedError.code || normalizedError.message}`;
					const now = Date.now();
					if (now - (recentErrors.get(signature) || 0) < 6e4) return null;
					recentErrors.set(signature, now);
				}
				const record = {
					schema: 1,
					timestamp: (/* @__PURE__ */ new Date()).toISOString(),
					level,
					module: moduleName,
					operation,
					event,
					context: sanitize(context),
					...normalizedError ? { error: normalizedError } : {},
					...Number.isFinite(durationMs) ? { duration_ms: Number(durationMs.toFixed(3)) } : {}
				};
				(level === "error" ? sink.error : level === "warn" ? sink.warn : sink.info || sink.log).call(sink, `${FAIRY_LOG_PREFIX} ${JSON.stringify(record)}`);
				return record;
			};
			const start = () => clock();
			const metric = (operation, startedAt, context = {}, options = {}) => {
				const duration = clock() - startedAt;
				return duration < (options.thresholdMs || 0) ? null : emit("info", operation, "metric", context, void 0, duration);
			};
			const guard = (operation, callback, context = {}) => {
				const startedAt = start();
				try {
					const result = callback();
					metric(operation, startedAt, {
						...context,
						outcome: "success"
					});
					return result;
				} catch (error) {
					emit("error", operation, "failure", context, error);
					metric(operation, startedAt, {
						...context,
						outcome: "failure"
					});
					throw error;
				}
			};
			return {
				start,
				metric,
				guard,
				info: (operation, context) => emit("info", operation, "event", context),
				warn: (operation, context, error) => emit("warn", operation, "failure", context, error),
				error: (operation, error, context) => emit("error", operation, "failure", context, error)
			};
		}
		module.exports = {
			FAIRY_LOG_PREFIX,
			createFairyDiagnostics
		};
	}));

//#endregion
//#region src/client/index.js
	var require_client = /* @__PURE__ */ __commonJSMin(((exports) => {
		const React = require("react");
		const { jsx, jsxs } = require("react/jsx-runtime");
		const { createFairyDiagnostics } = require_client_diagnostics();
		const diagnostics = createFairyDiagnostics("dsh-browser-dock");
		const FALLBACK_POLL_MS = 800;
		const MIN_WIDTH = 200;
		const MIN_HEIGHT = 112.5;
		const DEFAULT_WIDTH = 240;
		const DEFAULT_ASPECT_RATIO = 16 / 9;
		const DEFAULT_HEIGHT = DEFAULT_WIDTH / DEFAULT_ASPECT_RATIO;
		const STYLE_ID = "dsh-browser-dock-style";
		function control(token, action, value = {}) {
			const startedAt = diagnostics.start();
			return fetch("/browser-dock/control", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					token,
					action,
					...value
				})
			}).then((response) => {
				diagnostics.metric("control.request", startedAt, {
					action,
					status: response.status
				});
				return response;
			}, (error) => {
				diagnostics.error("control.request", error, { action });
				diagnostics.metric("control.request", startedAt, {
					action,
					outcome: "failure"
				});
				throw error;
			});
		}
		function injectStyle() {
			document.getElementById(STYLE_ID)?.remove();
			const style = document.createElement("style");
			style.id = STYLE_ID;
			style.setAttribute("data-plugin", "dsh-browser-dock");
			style.textContent = `
    .dsh-browser-dock{position:fixed;top:64px;right:18px;width:min(240px,calc(100vw - 36px));height:min(180px,calc(100vh - 96px));min-width:${MIN_WIDTH}px;min-height:${MIN_HEIGHT}px;max-width:calc(100vw - 36px);max-height:calc(100vh - 82px);z-index:76;display:flex;flex-direction:column;overflow:hidden;resize:none;border:1px solid var(--dsw-alias-border-l2,rgba(120,130,145,.28));border-radius:14px;background:#fff;color:#17202b;box-shadow:0 18px 48px rgba(15,23,42,.22),0 3px 12px rgba(15,23,42,.12);font:12px/1.35 ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;isolation:isolate}
    .dsh-browser-dock::before{content:"";position:absolute;z-index:2;inset:0 0 auto;height:32px;background:linear-gradient(180deg,rgba(68,76,86,.13) 0%,rgba(68,76,86,.035) 58%,rgba(68,76,86,0) 100%);-webkit-backdrop-filter:blur(2px);backdrop-filter:blur(2px);-webkit-mask-image:linear-gradient(180deg,#000 0%,rgba(0,0,0,.82) 42%,transparent 100%);mask-image:linear-gradient(180deg,#000 0%,rgba(0,0,0,.82) 42%,transparent 100%);pointer-events:none}
    .dsh-browser-dock[data-frame-ready="false"]{visibility:hidden}
    .dsh-browser-dock[data-minimized="true"]{width:240px!important;height:42px!important;min-height:42px;resize:none}
    .dsh-browser-dock__chrome{position:absolute;z-index:4;inset:3px 3px auto 3px;display:flex;align-items:center;gap:7px;pointer-events:none;user-select:none}
    .dsh-browser-dock[data-minimized="true"] .dsh-browser-dock__chrome{inset:3px}
    .dsh-browser-dock__identity{min-width:0;flex:1;display:flex;align-items:center;height:27px;padding:0 3px 0 9px;pointer-events:auto;filter:drop-shadow(0 1px 1px rgba(255,255,255,.9)) drop-shadow(0 1px 2px rgba(15,23,42,.3))}
    .dsh-browser-dock__title{min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:650;font-size:12px}
    .dsh-browser-dock__actions{display:flex;gap:2px;pointer-events:auto;filter:drop-shadow(0 1px 1px rgba(255,255,255,.9)) drop-shadow(0 1px 2px rgba(15,23,42,.3))}.dsh-browser-dock__button{width:27px;height:27px;padding:0;border:0;border-radius:7px;background:transparent;color:inherit;cursor:pointer;font-size:14px;display:grid;place-items:center}.dsh-browser-dock__button:hover{background:color-mix(in srgb,var(--dsw-alias-bg-layer-1,#fff) 55%,transparent)}.dsh-browser-dock__button[aria-pressed="true"]{color:#2563eb}
    .dsh-browser-dock__tabs{position:absolute;z-index:3;top:38px;left:7px;right:7px;height:24px;display:flex;gap:4px;padding:2px;overflow-x:auto;box-sizing:border-box;filter:drop-shadow(0 1px 1px rgba(255,255,255,.9)) drop-shadow(0 1px 2px rgba(15,23,42,.3))}.dsh-browser-dock__tab{max-width:150px;min-width:56px;padding:2px 7px;border-radius:5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#52606d}.dsh-browser-dock__tab[data-current="true"]{color:#17202b;font-weight:600}
    .dsh-browser-dock__viewport{position:relative;min-height:0;flex:1;background:#f2f3f5;display:grid;place-items:center;overflow:hidden}.dsh-browser-dock__frame{width:100%;height:100%;object-fit:cover;display:block}
    .dsh-browser-dock__handoff{position:absolute;right:10px;bottom:10px;padding:7px 10px;border:1px solid rgba(59,130,246,.35);border-radius:8px;background:rgba(255,255,255,.94);color:#1d4ed8;box-shadow:0 3px 12px rgba(15,23,42,.14);cursor:pointer;font-weight:650}.dsh-browser-dock__handoff:disabled{opacity:.55;cursor:default}
    .dsh-browser-dock__resize{position:absolute;z-index:5;left:0;bottom:0;width:20px;height:20px;cursor:sw-resize;touch-action:none;user-select:none;border:0;background:transparent;border-bottom-left-radius:13px}
    .dsh-browser-dock__resize::before{content:"";position:absolute;left:3px;bottom:3px;width:10px;height:10px;background:linear-gradient(45deg,transparent 0 39%,var(--dsw-alias-border-l1,rgba(82,96,112,.52)) 40% 48%,transparent 49% 66%,var(--dsw-alias-border-l1,rgba(82,96,112,.52)) 67% 75%,transparent 76%);pointer-events:none}
    .dsh-browser-dock__resize:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#3b82f6);outline-offset:-3px}
    @media(max-width:700px){.dsh-browser-dock{top:58px;right:10px;max-width:calc(100vw - 20px);min-width:${MIN_WIDTH}px}}
  `;
			document.head.appendChild(style);
			return () => style.remove();
		}
		function clamp(value, minimum, maximum) {
			return Math.min(maximum, Math.max(minimum, value));
		}
		function createBottomLeftResize(event, setSize, aspectRatio) {
			if (event.button !== 0) return () => {};
			const handle = event.currentTarget;
			const dock = handle.closest(".dsh-browser-dock");
			if (!dock) return () => {};
			event.preventDefault();
			const pointerId = event.pointerId;
			const startBox = dock.getBoundingClientRect();
			const startX = event.clientX;
			const startY = event.clientY;
			const rightInset = Math.max(0, window.innerWidth - startBox.right);
			const maxWidth = Math.max(MIN_WIDTH, window.innerWidth - rightInset - 18);
			const maxHeight = Math.max(MIN_HEIGHT, window.innerHeight - startBox.top - 18);
			const ratio = Number.isFinite(aspectRatio) && aspectRatio > 0 ? aspectRatio : DEFAULT_ASPECT_RATIO;
			const proportionalMinWidth = Math.max(MIN_WIDTH, MIN_HEIGHT * ratio);
			const proportionalMaxWidth = Math.max(proportionalMinWidth, Math.min(maxWidth, maxHeight * ratio));
			let active = true;
			const move = (moveEvent) => {
				if (!active || moveEvent.pointerId !== pointerId) return;
				moveEvent.preventDefault();
				const fromHorizontal = startBox.width + startX - moveEvent.clientX;
				const fromVertical = (startBox.height + moveEvent.clientY - startY) * ratio;
				const width = clamp(Math.abs(fromHorizontal - startBox.width) >= Math.abs(fromVertical - startBox.width) ? fromHorizontal : fromVertical, proportionalMinWidth, proportionalMaxWidth);
				setSize({
					width,
					height: width / ratio
				});
			};
			const finish = (finishEvent) => {
				if (!active || finishEvent?.pointerId != null && finishEvent.pointerId !== pointerId) return;
				active = false;
				window.removeEventListener("pointermove", move);
				window.removeEventListener("pointerup", finish);
				window.removeEventListener("pointercancel", finish);
				window.removeEventListener("blur", finish);
				if (handle.hasPointerCapture?.(pointerId)) handle.releasePointerCapture(pointerId);
			};
			handle.setPointerCapture?.(pointerId);
			window.addEventListener("pointermove", move, { passive: false });
			window.addEventListener("pointerup", finish);
			window.addEventListener("pointercancel", finish);
			window.addEventListener("blur", finish);
			return finish;
		}
		function useBrowserState() {
			const [state, setState] = React.useState({
				active: false,
				revision: 0,
				status: "idle"
			});
			React.useEffect(() => {
				let alive = true;
				let timer = 0;
				let controller = null;
				let events = null;
				let fallback = false;
				let pending = false;
				const clearTimer = () => {
					if (timer) clearTimeout(timer);
					timer = 0;
				};
				const scheduleFallback = () => {
					clearTimer();
					if (alive && fallback && document.visibilityState !== "hidden") timer = window.setTimeout(load, FALLBACK_POLL_MS);
				};
				const load = async () => {
					clearTimer();
					if (!alive || document.visibilityState === "hidden") return;
					if (controller) {
						pending = true;
						return;
					}
					const request = new AbortController();
					const startedAt = diagnostics.start();
					controller = request;
					try {
						const response = await fetch("/browser-dock/state", {
							cache: "no-store",
							signal: request.signal
						});
						if (!response.ok) throw new Error(`HTTP ${response.status}`);
						const next = await response.json();
						if (alive) setState(next);
					} catch (error) {
						if (alive && error.name !== "AbortError") {
							diagnostics.warn("state.request", { fallback }, error);
							setState((current) => ({
								...current,
								status: "error",
								error: error.message
							}));
						}
					} finally {
						diagnostics.metric("state.request", startedAt, { fallback }, { thresholdMs: 100 });
						if (controller !== request) return;
						controller = null;
						if (pending) {
							pending = false;
							load();
						} else scheduleFallback();
					}
				};
				const enableFallback = () => {
					events?.close();
					events = null;
					if (!alive || fallback) return;
					fallback = true;
					if (!controller && !timer && document.visibilityState !== "hidden") load();
				};
				const connectEvents = () => {
					fallback = false;
					if (typeof EventSource === "undefined") return enableFallback();
					try {
						events = new EventSource("/browser-dock/events");
						events.addEventListener("state", () => {
							load();
						});
						events.onerror = enableFallback;
					} catch {
						enableFallback();
					}
				};
				const resume = () => {
					if (!alive || document.visibilityState === "hidden") return;
					connectEvents();
					load();
				};
				const suspend = () => {
					clearTimer();
					events?.close();
					events = null;
					controller?.abort();
					controller = null;
					pending = false;
				};
				const onVisibility = () => document.visibilityState === "hidden" ? suspend() : resume();
				document.addEventListener("visibilitychange", onVisibility);
				resume();
				return () => {
					alive = false;
					suspend();
					document.removeEventListener("visibilitychange", onVisibility);
				};
			}, []);
			return state;
		}
		function BrowserDock({ sessions }) {
			const state = useBrowserState();
			const [size, setSize] = React.useState({
				width: DEFAULT_WIDTH,
				height: DEFAULT_HEIGHT
			});
			const [minimized, setMinimized] = React.useState(false);
			const [pinned, setPinned] = React.useState(false);
			const [hiddenRevision, setHiddenRevision] = React.useState(-1);
			const [handoffPending, setHandoffPending] = React.useState(false);
			const [presentedFrameRevision, setPresentedFrameRevision] = React.useState(-1);
			const sessionRef = React.useRef(sessions.list.getSnapshot().current);
			const boundRef = React.useRef(null);
			const lastFrameRef = React.useRef(0);
			const resizeCleanupRef = React.useRef(null);
			const aspectRatioRef = React.useRef(DEFAULT_ASPECT_RATIO);
			React.useEffect(() => () => resizeCleanupRef.current?.(), []);
			React.useEffect(() => sessions.list.subscribe(() => {
				const next = sessions.list.getSnapshot().current;
				const previous = sessionRef.current;
				sessionRef.current = next;
				if (previous !== next && boundRef.current) {
					control(state.token, "close", {
						ownerSessionId: boundRef.current,
						reason: "session-switch"
					});
					boundRef.current = null;
				}
			}), [sessions, state.token]);
			React.useEffect(() => {
				if (!state.active) {
					boundRef.current = null;
					return;
				}
				const sessionId = sessions.list.getSnapshot().current;
				if (typeof sessionId === "string" && state.ownerSessionId == null && boundRef.current !== sessionId) {
					boundRef.current = sessionId;
					control(state.token, "bind", { sessionId });
				} else if (typeof state.ownerSessionId === "string") boundRef.current = state.ownerSessionId;
			}, [
				sessions,
				state.active,
				state.ownerSessionId,
				state.token
			]);
			React.useEffect(() => {
				if (state.frameRevision === lastFrameRef.current) return;
				lastFrameRef.current = state.frameRevision;
				setHiddenRevision(-1);
				if (!pinned) setMinimized(false);
			}, [state.frameRevision, pinned]);
			const title = typeof state.title === "string" ? state.title.trim() : "";
			if (!state.active || !state.frameRevision || !title || hiddenRevision === state.revision) return null;
			const close = () => {
				setHiddenRevision(state.revision);
				control(state.token, "close", {
					ownerSessionId: boundRef.current,
					reason: "user-close"
				});
			};
			const takeover = async () => {
				if (handoffPending) return;
				setHandoffPending(true);
				try {
					const response = await control(state.token, "takeover", { revision: state.revision });
					if (!response.ok) throw new Error(`HTTP ${response.status}`);
				} finally {
					setHandoffPending(false);
				}
			};
			const tabs = Array.isArray(state.tabs) ? state.tabs : [];
			const statusText = state.loading ? "正在加载" : state.status === "error" ? "加载失败" : "已更新";
			const beginResize = (event) => {
				resizeCleanupRef.current?.();
				resizeCleanupRef.current = createBottomLeftResize(event, setSize, aspectRatioRef.current);
			};
			const resizeWithKeyboard = (event) => {
				const delta = event.shiftKey ? 32 : 16;
				if (![
					"ArrowLeft",
					"ArrowRight",
					"ArrowUp",
					"ArrowDown"
				].includes(event.key)) return;
				event.preventDefault();
				const ratio = aspectRatioRef.current;
				const direction = event.key === "ArrowLeft" || event.key === "ArrowDown" ? 1 : -1;
				const maxWidth = Math.min(window.innerWidth - 36, (window.innerHeight - 82) * ratio);
				setSize((current) => {
					const width = clamp(current.width + direction * delta, Math.max(MIN_WIDTH, MIN_HEIGHT * ratio), maxWidth);
					return {
						width,
						height: width / ratio
					};
				});
			};
			const fitFrameRatio = (event) => {
				const image = event.currentTarget;
				const loadedRevision = Number(new URL(image.currentSrc || image.src, document.baseURI).searchParams.get("revision"));
				if (!Number.isSafeInteger(loadedRevision) || loadedRevision !== state.frameRevision) return;
				if (!image.naturalWidth || !image.naturalHeight) return;
				const ratio = image.naturalWidth / image.naturalHeight;
				if (!Number.isFinite(ratio) || ratio <= 0) return;
				aspectRatioRef.current = ratio;
				setPresentedFrameRevision(loadedRevision);
				setSize((current) => {
					const maxWidth = Math.min(window.innerWidth - 36, (window.innerHeight - 82) * ratio);
					const width = clamp(current.width, Math.max(MIN_WIDTH, MIN_HEIGHT * ratio), maxWidth);
					return {
						width,
						height: width / ratio
					};
				});
			};
			return jsxs("section", {
				className: "dsh-browser-dock",
				"data-minimized": minimized ? "true" : "false",
				"data-loading": state.loading ? "true" : "false",
				"data-status": state.status || "idle",
				"data-pinned": pinned ? "true" : "false",
				"data-frame-ready": presentedFrameRevision === state.frameRevision ? "true" : "false",
				role: "complementary",
				"aria-label": `浏览器预览：${title}，${statusText}`,
				style: minimized ? void 0 : {
					width: size.width,
					height: size.height
				},
				children: [
					jsxs("header", {
						className: "dsh-browser-dock__chrome",
						children: [jsxs("span", {
							className: "dsh-browser-dock__identity",
							children: [jsx("span", {
								className: "dsh-browser-dock__title",
								title,
								children: title
							})]
						}), jsxs("span", {
							className: "dsh-browser-dock__actions",
							children: [
								jsx("button", {
									type: "button",
									className: "dsh-browser-dock__button",
									title: pinned ? "取消固定" : "固定当前大小和折叠状态",
									"aria-label": pinned ? "取消固定浏览器 Dock" : "固定浏览器 Dock",
									"aria-pressed": pinned,
									onClick: () => setPinned((value) => !value),
									children: "⌖"
								}),
								jsx("button", {
									type: "button",
									className: "dsh-browser-dock__button",
									title: minimized ? "展开" : "最小化",
									"aria-label": minimized ? "展开浏览器 Dock" : "最小化浏览器 Dock",
									onClick: () => setMinimized((value) => !value),
									children: minimized ? "□" : "—"
								}),
								jsx("button", {
									type: "button",
									className: "dsh-browser-dock__button",
									title: "关闭浏览器",
									"aria-label": "关闭浏览器 Dock 和浏览器",
									onClick: close,
									children: "×"
								})
							]
						})]
					}),
					!minimized && tabs.length > 1 ? jsx("nav", {
						className: "dsh-browser-dock__tabs",
						"aria-label": "浏览器标签页",
						children: tabs.map((tab) => jsx("span", {
							className: "dsh-browser-dock__tab",
							"data-current": tab.current ? "true" : "false",
							title: tab.title || "未命名",
							children: tab.title || `标签 ${tab.index + 1}`
						}, tab.index))
					}) : null,
					!minimized ? jsxs("div", {
						className: "dsh-browser-dock__viewport",
						children: [state.frameRevision ? jsx("img", {
							className: "dsh-browser-dock__frame",
							src: `/browser-dock/frame?revision=${state.frameRevision}`,
							alt: `当前页面画面：${title}`,
							onLoad: fitFrameRatio
						}) : null, state.takeoverAvailable && !state.takeoverConsumed ? jsx("button", {
							type: "button",
							className: "dsh-browser-dock__handoff",
							disabled: handoffPending,
							onClick: () => void takeover(),
							children: handoffPending ? "正在移交…" : "在外部浏览器接管一次"
						}) : null]
					}) : null,
					!minimized ? jsx("div", {
						className: "dsh-browser-dock__resize",
						role: "separator",
						tabIndex: 0,
						"aria-label": "从左下角调整浏览器 Dock 大小",
						"aria-orientation": "vertical",
						onPointerDown: beginResize,
						onKeyDown: resizeWithKeyboard
					}) : null
				]
			});
		}
		const inject = ["slots", "sessions"];
		function apply(ctx) {
			return diagnostics.guard("apply", () => {
				ctx.effect(() => injectStyle(), "dsh-browser-dock style lifecycle");
				ctx.slots.inject("shell.overlay", () => ctx.slots.register({
					name: "shell.overlay",
					id: "dsh-browser-dock",
					order: 90
				}, () => jsx(BrowserDock, { sessions: ctx.sessions })));
			}, { surface: "client" });
		}
		exports.apply = apply;
		exports.inject = inject;
	}));

//#endregion
return require_client();

})();
  },
});