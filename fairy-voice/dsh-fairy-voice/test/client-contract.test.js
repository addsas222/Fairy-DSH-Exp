import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const clientPath = new URL('../lib/client.js', import.meta.url);
const source = await readFile(clientPath, 'utf8');
const serverSource = await readFile(new URL('../lib/index.js', import.meta.url), 'utf8');
const canonicalClientDiagnostics = await readFile(new URL('../../../fairy-contracts/client-diagnostics.cjs', import.meta.url), 'utf8');
const canonicalClientDom = await readFile(new URL('../../../fairy-contracts/client-dom.cjs', import.meta.url), 'utf8');

function embeddedClientDiagnostics(value) {
  const begin = '// DSH_FAIRY_CLIENT_DIAGNOSTICS_BEGIN';
  const end = '// DSH_FAIRY_CLIENT_DIAGNOSTICS_END';
  const marker = value.indexOf(begin);
  // Locate the block body by scanning past the marker's own line break so a
  // CRLF checkout compares the same bytes as an LF checkout.
  const start = marker < 0 ? -1 : value.indexOf('\n', marker) + 1;
  const finish = value.indexOf(end, start);
  assert.ok(start > 0 && finish > start, 'embedded client diagnostics boundaries should exist');
  return value.slice(start, finish);
}

function embeddedClientDom(value) {
  const begin = '// DSH_FAIRY_CLIENT_DOM_BEGIN';
  const end = '// DSH_FAIRY_CLIENT_DOM_END';
  const marker = value.indexOf(begin);
  const start = marker < 0 ? -1 : value.indexOf('\n', marker) + 1;
  const finish = value.indexOf(end, start);
  assert.ok(start > 0 && finish > start, 'embedded client DOM contracts boundaries should exist');
  return value.slice(start, finish);
}

test('embeds the canonical client diagnostics byte for byte', () => {
  assert.equal(embeddedClientDiagnostics(source), canonicalClientDiagnostics);
});

test('request scopes own abort, timeout cleanup, and idempotent cancellation', () => {
  assert.equal(source.includes('function createVoiceRequestScope()'), true);
  assert.equal(source.includes("prepareScope.current?.cancel('client-aborted')"), true);
  assert.equal(source.includes('requestScope.timeout(resolve, 1500)'), true);
  assert.equal(serverSource.includes('function createVoiceRequestScope()'), true);
  assert.equal(serverSource.includes("scope.timeout(() => scope.cancel('timeout'), TTS_TIMEOUT_MS)"), true);
  assert.equal(serverSource.includes("scope.cancel('request-complete')"), true);
});

test('slot registration has one replacement owner and an explicit disposer', () => {
  assert.match(source, /function injectVoiceSlot\(ctx, name, definition, component\)/);
  assert.equal(source.includes('const releaseRegistration = () =>'), true);
  assert.match(source, /const dispose = disposeRegistration;/);
  assert.match(source, /return releaseRegistration;/);
  assert.match(source, /const slotDisposers = \[/);
  assert.match(source, /dsh-fairy-voice slot registrations/);
});

test('playback commands and state updates are session-scoped', () => {
  assert.match(source, /if \(detail\.sessionKey !== sessionKey\) return;/);
  assert.match(source, /detail: \{ messageId: final\.id, markdown: final\.markdown, sessionKey, auto: true \}/);
  assert.match(source, /detail: \{ sessionKey, messageId: message\.id, markdown: message\.markdown \}/);
  assert.match(source, /dispatchVoiceState\(\{ status: 'error', messageId, error: error\?\.message \|\| 'Speech preparation failed\.', sessionKey \}\)/);
});

test('cancellation invalidates both preparation and active playback', () => {
  assert.match(source, /const cancelPlayback = React\.useCallback\(\(\) => \{\s*lifecycleEpoch\.current \+= 1;\s*activeIntent\.current = null;\s*prepareController\.current\?\.abort\(\);\s*prepareController\.current = null;[\s\S]*?stop\(\);/s);
  assert.match(source, /const isCurrentRequest = \(\) => \{[\s\S]*?lifecycleEpoch\.current === requestEpoch && !controller\.signal\.aborted[\s\S]*?currentSelection\.key === sessionKey && currentSelection\.epoch === selectionEpoch;/);
  assert.match(source, /if \(!isCurrentRequest\(\)\) return;/);
  assert.match(source, /window\.addEventListener\('pagehide', cancelPlayback\)/);
  assert.match(source, /document\.addEventListener\('visibilitychange', cancelWhenHidden\)/);
});

test('active DSH session selection synchronously invalidates every stale voice generation', () => {
  assert.match(source, /function createActiveSessionStore\(sessions\)/);
  assert.match(source, /let activeSessionStore = null/);
  assert.match(source, /const activeSessions = activeSessionStore \|\| emptyActiveSessionStore/);
  assert.match(source, /sessions\?\.list\?\.getSnapshot\?\.\(\)\.current/);
  assert.match(source, /snapshot = \{ key, epoch: snapshot\.epoch \+ 1 \}/);
  assert.match(source, /React\.useSyncExternalStore\(activeSessions\.subscribe, activeSessions\.getSnapshot, activeSessions\.getSnapshot\)/);
  assert.match(source, /return activeSessions\.subscribe\(\(\) => \{\s*if \(activeSessions\.getSnapshot\(\)\.key !== sessionKey\) cancelPlayback\(\);/s);
  assert.match(source, /if \(detail\.sessionKey !== sessionKey \|\| selection\.key !== sessionKey\) return;/);
  assert.match(source, /selection\.key !== sessionKey \|\| selection\.epoch !== activeSelection\.epoch/);
  assert.match(source, /autoRead: autoRead && sessionActive/);
  assert.match(source, /return \{ apply, inject: \['slots', 'sessions'\] \}/);
  assert.doesNotMatch(source, /VoiceControllerSlot/);
});

test('message buttons replay authoritative per-session playback state after remounting', () => {
  assert.match(source, /const voiceStateBySession = new Map\(\)/);
  assert.match(source, /voiceStateBySession\.set\(scoped\.sessionKey, scoped\)/);
  assert.match(source, /const MAX_TRACKED_SESSION_STATES = 32/);
  assert.match(source, /function pruneOldSessions\(\)/);
  assert.match(source, /state\.lastAccess = Date\.now\(\)/);
  assert.match(source, /entries\.sort\(\(a, b\) =>/);
  assert.match(source, /state\?\.dispose\?\.\(\)/);
  assert.match(source, /activeSessionStore\?\.getSnapshot\?\.\(\)\.key/);
  assert.match(source, /clearVoiceSessionStates\(\)/);
  assert.match(source, /const \[state, setState\] = React\.useState\(\(\) => readVoiceState\(sessionKey\)\)/);
  assert.match(source, /React\.useLayoutEffect\(\(\) => \{\s*setState\(readVoiceState\(sessionKey\)\);/s);
  assert.equal((source.match(/new CustomEvent\(EVENT_STATE/g) || []).length, 1);
});

test('LRU keeps at most 32 session states, protects the active session, and disposes evictions', async () => {
  const vm = await import('node:vm');
  const start = source.indexOf('    function idleVoiceState(sessionKey) {');
  const end = source.indexOf('    function createActiveSessionStore(sessions) {', start);
  assert.ok(start >= 0 && end > start, 'voice-state LRU source should be available');
  const disposed = [];
  let now = 0;
  const sandbox = {
    Date: { now: () => now },
    CustomEvent: class CustomEvent { constructor(type, options) { this.type = type; this.detail = options.detail; } },
    EVENT_STATE: 'voice-state',
    MAX_TRACKED_SESSION_STATES: 32,
    activeSessionStore: { getSnapshot: () => ({ key: 'session-0' }) },
    disposed,
    window: { dispatchEvent() {} },
  };
  vm.runInNewContext(`
    const voiceStateBySession = new Map();
    function reportAudioLifecycleFailure() {}
    ${source.slice(start, end)}
    globalThis.voiceLru = {
      dispatchVoiceState,
      readVoiceState,
      size: () => voiceStateBySession.size,
      has: (key) => voiceStateBySession.has(key),
    };
  `, sandbox);

  for (let index = 0; index < 40; index += 1) {
    now += 1;
    sandbox.voiceLru.dispatchVoiceState({
      sessionKey: `session-${index}`,
      status: index === 0 ? 'playing' : 'idle',
      dispose: () => disposed.push(`session-${index}`),
    });
  }
  assert.equal(sandbox.voiceLru.size(), 32);
  assert.equal(sandbox.voiceLru.has('session-0'), true);
  assert.deepEqual(disposed, Array.from({ length: 8 }, (_, index) => `session-${index + 1}`));

  now += 1;
  sandbox.voiceLru.readVoiceState('session-9');
  now += 1;
  sandbox.voiceLru.dispatchVoiceState({ sessionKey: 'session-40', status: 'idle', dispose: () => disposed.push('session-40') });
  assert.equal(sandbox.voiceLru.has('session-9'), true);
  assert.equal(sandbox.voiceLru.has('session-10'), false);
  assert.equal(sandbox.voiceLru.size(), 32);

  // One state publication per minute models eight hours of continuous use;
  // retained state remains bounded instead of growing with session count.
  for (let minute = 0; minute < 8 * 60; minute += 1) {
    now += 60_000;
    sandbox.voiceLru.dispatchVoiceState({ sessionKey: `long-run-${minute}`, status: 'idle' });
    assert.ok(sandbox.voiceLru.size() <= 32);
  }
  assert.equal(sandbox.voiceLru.has('session-0'), true);
  assert.equal(sandbox.voiceLru.size(), 32);
});

test('automatic playback retains retry ownership after preempting prior audio', () => {
  assert.match(source, /cancelPlayback\(\);\s*const id = String\(messageId \|\| ''\);\s*if \(automatic && id\) \{[\s\S]*?autoMessageIds\.current\.add\(id\);\s*activeAutoMessageId\.current = id;/s);
  assert.match(source, /const autoReadRef = React\.useRef\(autoRead\);\s*autoReadRef\.current = autoRead;/s);
  assert.match(source, /!autoReadRef\.current \|\| !isCurrentRequest\(\)/);
});

test('idle Web Audio rendering is suspended after final playback', () => {
  assert.match(source, /current\.context\.suspend\(\)\.catch\(\(error\) => reportAudioLifecycleFailure\('suspend', error\)\)/);
  assert.match(source, /const primeAudio = React\.useCallback\(async[\s\S]*?suspendWhenIdle\(context\)/);
  assert.match(source, /primeAudio\(volume\)\.then\(\(\) => \{/);
  assert.match(source, /await primeAudio\(volumeRef\.current\)/);
  // The play listener must not depend on volume: a slider change would tear the
  // effect down and its cleanup aborts the request that is speaking.
  assert.doesNotMatch(source, /primeAudio, sessionKey, volume\]\)/);
  assert.match(source, /const volumeRef = React\.useRef\(volume\);/);
  assert.match(source, /const play = React\.useCallback\(async[\s\S]*?await unlockAudio\(volume\)/);
  assert.match(source, /const requestedWork = work\.current;[\s\S]*?await unlockAudio\(volume\);[\s\S]*?if \(work\.current !== requestedWork \|\| requestedWork\.stopped\) return false;/);
});

test('classifies audio cleanup failures without silent catches', () => {
  assert.match(source, /function reportAudioLifecycleFailure\(operation, error\)/);
  assert.match(source, /InvalidStateError/);
  assert.doesNotMatch(source, /catch \{\}/);
  assert.doesNotMatch(source, /\.catch\(\(\) => \{\}\)/);
});

test('voice controller renders without unresolved hook-scope references', async () => {
  const vm = await import('node:vm');
  let moduleDefinition;
  const effects = [];
  const slots = new Map();
  const React = {
    useState(initial) {
      return [typeof initial === 'function' ? initial() : initial, () => {}];
    },
    useRef(initial) { return { current: initial }; },
    useCallback(callback) { return callback; },
    useEffect(callback) { effects.push(callback); },
    useLayoutEffect(callback) { effects.push(callback); },
    useSyncExternalStore(_subscribe, getSnapshot) { return getSnapshot(); },
  };
  const jsxRuntime = {
    jsx(type, props) { return { type, props: props || {} }; },
    jsxs(type, props) { return { type, props: props || {} }; },
  };
  const context = vm.createContext({
    AbortController,
    CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
    Map,
    Promise,
    Set,
    URL,
    clearTimeout,
    console,
    document: {
      documentElement: { hasAttribute: (name) => name === 'data-dsh-fairy-visual' },
      getElementById: () => ({}), addEventListener() {}, removeEventListener() {}, visibilityState: 'visible'
    },
    fetch: async () => ({ ok: true, json: async () => ({ available: true }), body: null }),
    localStorage: { getItem: () => null, setItem() {} },
    setTimeout,
    window: {
      __ModuleLoader__: { load(definition) { moduleDefinition = definition; } },
      addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
    },
  });
  vm.runInContext(source, context, { filename: 'dsh-fairy-voice/client.js' });
  const plugin = moduleDefinition.factory((id) => {
    if (id === 'react') return React;
    if (id === 'react/jsx-runtime') return jsxRuntime;
    if (id === '@deepseek-ai/dsh-client-ui-primitives') {
      return { Tooltip: 'Tooltip', IconPauseOutline16: 'Pause', IconPlayOutline16: 'Play', IconStopFill16: 'Stop' };
    }
    throw new Error(`unexpected module: ${id}`);
  });
  const sessionSnapshot = { current: 'empty-chat' };
  plugin.apply({
    effect() {},
    sessions: { list: { getSnapshot: () => sessionSnapshot, subscribe: () => () => {} } },
    slots: {
      inject(_name, register) { register(); },
      register(definition, component) { slots.set(definition.id, component); },
    },
  });
  const wrapper = slots.get('fairy-voice-controller');
  const element = wrapper({ sessionId: 'empty-chat', useSession: (selector) => selector({}) });
  assert.doesNotThrow(() => element.type(element.props));
});

test('keeps the composer voice controls in the official left input slot', () => {
  assert.match(source, /injectVoiceSlot\(ctx, 'conversation\.input\.left'/);
  assert.match(source, /name: 'conversation\.input\.left', id: 'fairy-voice-controller', order: 40/);
  assert.doesNotMatch(source, /ctx\.slots\.inject\('conversation\.input\.right'/);
});

test('only mounts the composer voice controller while HDD visual mode is active', () => {
  assert.match(source, /function useHddVisualMode\(\)/);
  assert.match(source, /document\.documentElement\?\.hasAttribute\('data-dsh-fairy-visual'\) === true/);
  assert.match(source, /new MutationObserver\(notify\)/);
  assert.match(source, /attributeFilter: \['data-dsh-fairy-visual'\]/);
  assert.match(source, /return \(\) => observer\.disconnect\(\)/);
  const scopedController = source.slice(source.indexOf('function SessionScopedVoiceController'), source.indexOf('function MessageAction'));
  assert.match(scopedController, /const hddVisualMode = useHddVisualMode\(\);/);
  // Closed by default; the engine card can lift the gate so the controls stay
  // reachable when the visual layer is off.
  assert.match(scopedController, /const alwaysControls = useAlwaysShowControls\(\);/);
  assert.match(scopedController, /if \(!hddVisualMode && !alwaysControls\) return null;/);
  assert.doesNotMatch(scopedController, /display:\s*none/);
});

test('server retains cancellation through the complete upstream PCM stream', async () => {
  const [server, localSovits] = await Promise.all([
    readFile(new URL('../lib/index.js', import.meta.url), 'utf8'),
    readFile(new URL('../lib/providers/local-sovits.js', import.meta.url), 'utf8'),
  ]);
  assert.match(localSovits, /function openLocalStream\(/);
  assert.match(localSovits, /signal: controller\.signal/);
  assert.match(localSovits, /const release = \(\) => \{[\s\S]*?parentSignal\?\.removeEventListener\('abort', onAbort\)/);
  assert.match(server, /activeTtsController\?\.abort\('superseded'\)/);
  assert.match(server, /releaseUpstream\?\.\(\)/);
  assert.match(server, /dispose: \(\) => \{[\s\S]*?controller\.abort\('disposed'\)/);
});

test('streaming playback reserves enough CPU-inference headroom', () => {
  assert.match(source, /PLAYBACK_PREBUFFER_SECONDS = 0\.65/);
  assert.match(source, /PLAYBACK_MAX_SCHEDULED_SECONDS = 4\.8/);
  assert.match(source, /PLAYBACK_MIN_BUFFER_SECONDS = 0\.08/);
  assert.match(source, /context\.currentTime \+ PLAYBACK_PREBUFFER_SECONDS/);
  assert.match(source, /await waitForQueueCapacity\(\);/);
  assert.match(source, /if \(!final && playableLength < PLAYBACK_MIN_BUFFER_BYTES\)/);
  assert.doesNotMatch(source, /if \(final && playableLength < PLAYBACK_MIN_BUFFER_BYTES\) return;/);
  assert.match(source, /PLAYBACK_SCHEDULE_LEAD_SECONDS/);
});

test('a host engine failing mid-read hands the remaining groups to system speech', () => {
  assert.match(source, /let playedGroups = 0;/);
  assert.match(source, /playedGroups \+= 1;/);
  assert.match(source, /const remaining = sentences\.slice\(playedGroups \* PLAYBACK_GROUP_SIZE\);/);
  assert.match(source, /const finished = await playSystem\(messageId, remaining, volume\);/);
});

test('system speech keeps long utterances alive in Blink and always releases its timer', () => {
  assert.match(source, /BROWSER_SPEECH_BUMP_MS = 6_000/);
  assert.match(source, /Chrome\|Chromium\|Edg/);
  assert.match(source, /synth\.pause\(\); synth\.resume\(\);/);
  assert.match(source, /const stopBump = \(\) => \{ if \(bump !== null\) \{ clearInterval\(bump\); bump = null; \} \};/);
  assert.match(source, /if \(current\.stopped\) \{ stopBump\(\); resolve\(false\); return; \}/);
});

test('browser engines synthesize locally with the shared scheduler and degrade to system speech', () => {
  assert.match(source, /const LOCAL_ENGINE_IDS = \['kokoro-web', 'kitten-web', 'piper-web'\]/);
  assert.match(source, /function isLocalEngine\(id\) \{/);
  assert.match(source, /KokoroTTS\.from_pretrained\(config\.modelId/);
  // One piper session per read: init() downloads once, every group reuses it.
  assert.match(source, /const opened = new api\.TtsSession\(\{ voiceId: config\.voiceId \}\);/);
  assert.match(source, /handle\.session\.predict\(text\)/);
  assert.match(source, /await context\.decodeAudioData\(await blob\.arrayBuffer\(\)\)/);
  assert.match(source, /await playLocalEngine\(engine, messageId, sentences, volumeRef\.current\)/);
  assert.match(source, /localEngineConfig\(settingsValue, engineId\)/);
  assert.match(source, /createWebAudioScheduler\(\{ current, getNextStart: \(\) => nextStart \}\)/);
});

test('browser engines are pinned, single-threaded, and can be mirrored', () => {
  // Exact versions: the repo pins every dependency, and a floating major would
  // drift behind the CDN without touching this repo.
  assert.match(source, /kokoro-js@1\.2\.1\/\+esm/);
  // KittenTTS-Nano：第二个浏览器内引擎（模型来自 HF，引擎自管 onnxruntime）。
  assert.match(source, /kitten-tts-js@0\.1\.2\/\+esm/);
  assert.match(source, /KittenTTS\.from_pretrained\(config\.modelId\)/);
  assert.match(source, /handle\.kind === 'kokoro' \|\| handle\.kind === 'kitten'/);
  assert.match(source, /@realtimex\/piper-tts-web@1\.1\.1\/\+esm/);
  // No SharedArrayBuffer on harness pages: hold the thread count at 1 for the
  // window in which an engine sizes its pool (piper reads it in init()).
  assert.match(source, /Object\.defineProperty\(navigator, 'hardwareConcurrency', \{ configurable: true, get: \(\) => 1 \}\)/);
  assert.match(source, /delete navigator\.hardwareConcurrency;/);
  assert.match(source, /withSingleThreadHint\(/);
  // Model/voice mirror: only HuggingFace hosts are rewritten, only while a
  // load or synthesis call is in flight.
  assert.match(source, /const MIRROR_HOSTS = /);
  assert.match(source, /withResourceMirror\(config\.resourceBase, /);
  // Two forks ship a dead onnxruntime base (cdnjs 1.18.0 lacks the 1.19+
  // threaded loader); fail with that base named instead of degrading silently.
  assert.match(source, /ort-wasm-simd-threaded\.mjs/);
  assert.match(source, /引擎的 onnxruntime 基址不可用/);
  assert.match(source, /if \(mirrorDepth === 0 && unmaskedFetch\) \{/);
});

test('empty PCM responses cannot be reported as successful playback', () => {
  assert.match(source, /let receivedSamples = 0/);
  assert.match(source, /receivedSamples \+= sampleCount/);
  assert.match(source, /Fairy returned empty audio/);
});

test('automatic playback only begins after a fresh user turn and cannot lose a final answer while state settles', () => {
  assert.match(source, /SESSION_BASELINE_SETTLE_MS = 1250/);
  assert.match(source, /FINAL_PLAYBACK_SETTLE_MS = 900/);
  assert.match(source, /for \(const message of snapshot\.found\) seen\.current\.add\(message\.id\);/);
  assert.match(source, /if \(snapshot\.userSeq > current\.lastUserSeq\) \{\s*current\.lastUserSeq = snapshot\.userSeq;\s*current\.armedUserSeq = snapshot\.userSeq;\s*cancelPlayback\(\);/s);
  assert.match(source, /if \(current\.armedUserSeq !== snapshot\.userSeq\) return;/);
  assert.match(source, /const autoRetryTimers = React\.useRef\(new Map\(\)\)/);
  assert.match(source, /const autoRetryCounts = React\.useRef\(new Map\(\)\)/);
  assert.match(source, /autoMessageIds\.current\.has\(id\)/);
  assert.match(source, /retry: count \+ 1/);
  assert.match(source, /const candidate = \[\.\.\.snapshot\.currentTurnFinals\]\.reverse\(\)\.find\(\(message\) => !seen\.current\.has\(message\.id\) && !autoMessageIds\.current\.has\(message\.id\)\);/);
  assert.match(source, /current\.pendingFinal = \{ \.\.\.candidate, userSeq: snapshot\.userSeq \}/);
  assert.match(source, /turnLocation\?\.status !== 'closed'/);
  assert.match(source, /turnLocation\.data\?\.get\?\.\('turn-tail'\)\?\.closing/);
  assert.doesNotMatch(source, /latest\.activity\?\.running && current\.finalWaits/);
  assert.doesNotMatch(source, /seen\.current\.add\(final\.id\);\s*autoMessageIds\.current\.add\(final\.id\);/s);
  assert.match(source, /seen\.current\.add\(id\);\s*autoMessageIds\.current\.add\(id\);/s);
  assert.match(source, /const stillAuthoritative = latest\.currentTurnFinals\.some\(\(message\) => message\.id === final\.id\)/);
});

test('final auto-read is owned by the official closed-turn tail, not settled assistant steps', () => {
  assert.match(source, /const currentTurnFinals = \[\];/);
  assert.match(source, /const timeline = chat\?\.timeline;/);
  assert.match(source, /for \(const turnNumber of timeline\?\.turnOrder \|\| \[\]\)/);
  assert.match(source, /if \(turnLocation\?\.status !== 'closed'\) continue;/);
  assert.match(source, /const closing = turnLocation\.data\?\.get\?\.\('turn-tail'\)\?\.closing;/);
  assert.match(source, /currentTurnFinals\.push\(\{/);
  assert.doesNotMatch(source, /const candidate = \[\.\.\.snapshot\.found\]\.reverse\(\)/);
  assert.doesNotMatch(source, /FINAL_PLAYBACK_MAX_WAITS/);
});

test('message actions use the DSH-provided session id', () => {
  assert.match(source, /function MessageAction\(\{ messageId, sessionId \}\)/);
  assert.match(source, /const sessionKey = String\(sessionId \?\? activeSessionStore\?\.getSnapshot\(\)\.key \?\? 'empty-chat'\);/);
});

test('message actions reuse one indexed timeline projection per session', () => {
  assert.match(source, /const voiceTimelineStore = createVoiceTimelineStore\(\)/);
  assert.match(source, /messagesById: new Map\(found\.map/);
  assert.match(source, /voiceTimelineStore\.set\(snapshot\)/);
  assert.match(source, /conversation\.messagesById\.get\(String\(messageId\)\)/);
  const actionSource = source.slice(source.indexOf('function MessageAction'), source.indexOf('function apply'));
  assert.doesNotMatch(actionSource, /useSession\(readVoiceTimeline\)|\.found\.find\(/);
});

test('shares one bounded availability request across the controller and all message actions', () => {
  assert.match(source, /const AVAILABILITY_TTL_MS = 30_000/);
  assert.match(source, /const availabilityStore = \{/);
  assert.match(source, /if \(availabilityRequest\) return availabilityRequest/);
  assert.match(source, /if \(availabilityRequest === request\) availabilityRequest = null/);
  assert.match(source, /const availability = React\.useSyncExternalStore\(availabilityStore\.subscribe/);
  const actionSource = source.slice(source.indexOf('function MessageAction'), source.indexOf('function apply'));
  assert.doesNotMatch(actionSource, /getAvailability\(|EVENT_AVAILABILITY/);
  assert.match(source, /disposeAvailability\(\)/);
});

test('releases one-time gesture listeners and plugin-owned styles', () => {
  assert.match(source, /if \(audioReady\) return undefined/);
  assert.match(source, /\[audioReady, primeAudio, volume\]/);
  assert.match(source, /style\.setAttribute\('data-plugin', 'dsh-fairy-voice'\)/);
  assert.match(source, /document\.getElementById\(VOICE_STYLE_ID\)\?\.remove\(\)/);
});

test('speech input ships a mic control, a browser path, and a host upload path', () => {
  assert.match(source, /'data-dsh-fairy-mic-control': 'true'/);
  assert.match(source, /'data-dsh-fairy-mic-state': speech\.error \? 'error' : speech\.status/);
  assert.match(source, /function startBrowserSpeech\(lang\) \{/);
  assert.match(source, /function startRecordedSpeech\(lang\) \{/);
  assert.match(source, /MediaRecorder/);
  assert.match(source, /fetch\(`\$\{STT_ENDPOINT}\/stt`/);
  assert.match(source, /'x-fairy-language': lang/);
  // Insertion prefers the composer's public action face (the draft machine's
  // owner), falls back to the first-party slash channel, and refuses rather
  // than writing the DOM behind the state machine's back.
  assert.match(source, /inputActions\.setDraft\(`\$\{draft}\$\{separator}\$\{text}`\)/);
  assert.match(source, /cordisCtx\.bail\('slash\/input-insert-text', \{ text: `\$\{separator}\$\{text}`, span \}\)/);
  assert.doesNotMatch(source, /stt\.insert-fallback/);
  assert.doesNotMatch(source, /Object\.getOwnPropertyDescriptor\(prototype, 'value'\)/);
  // The live draft (store subscription) is what gets extended, not the render prop.
  assert.match(source, /const liveInput = typeof useInput === 'function' \? useInput\(\(snapshot\) => snapshot\) : input;/);
});

test('speech input offers online and local routes', () => {
  // Descriptors: browser-local Whisper plus two online adapters ride the same
  // registry the settings card already renders.
  assert.match(source, /id: 'whisper-web'/);
  assert.match(source, /id: 'deepgram'/);
  assert.match(source, /id: 'azure'/);
  assert.match(source, /key: 'whisperWeb'/);
  assert.match(source, /@huggingface\/transformers@3\.8\.1\/\+esm/);
  // Routing: the local engine never uploads; host providers keep the recorder
  // plus upload path.
  assert.match(source, /const provider = sttProviderId\(sttSettings\);/);
  assert.match(source, /provider === 'whisper-web'/);
  assert.match(source, /startLocalWhisperSpeech\(sttSettings\)/);
  // Capture is separate from transport, and the clip is resampled to the
  // 16 kHz mono float array Whisper expects.
  assert.match(source, /async function openRecorder\(\) \{/);
  assert.match(source, /async function startRecordedSpeech\(lang\) \{\r?\n      const clip = await openRecorder\(\);/);
  assert.match(source, /new OfflineAudioContext\(1, 16000, 16000\)/);
  // The local engine reuses the TTS guards instead of inventing its own.
  assert.match(source, /pipeline\('automatic-speech-recognition', config\.modelId/);
  assert.match(source, /withResourceMirror\(config\.resourceBase, \(\) => withSingleThreadHint\(/);
  assert.match(source, /WHISPER_LANGUAGES\[value\] \|\| value/);
  // A browser without SpeechRecognition must be pointed at a route that works
  // there — the local engine needs no key.
  assert.match(source, /请改用 Whisper 本地（浏览器内，免密钥）、在线 Deepgram\/Azure 或自定义 HTTP 提供方/);
  // The language header follows the selected provider's own field.
  assert.match(source, /provider === 'deepgram' \? providers\.deepgram\?\.language/);
  assert.match(source, /provider === 'azure' \? providers\.azure\?\.locale/);
  // First local run downloads the model; the mic tooltip says so.
  assert.match(source, /speech\.provider === 'whisper-web' \? '本地识别中（首次会下载模型）…' : '正在转写…'/);
});

test('the speech language header resolves the selected provider\'s own field', () => {
  // Execute the shipped source instead of a copy: the header must carry what
  // the card shows, or the host would override it with the browser default.
  const definitions = [source.match(/    function sttProviderId\(config\) \{[\s\S]*?\n    \}/)[0], source.match(/    function sttLanguage\(config\) \{[\s\S]*?\n    \}/)[0]]
  const sttLanguage = new Function(`${definitions.join('\n')}\nreturn sttLanguage;`)();
  const settings = (provider, fields) => ({ provider, providers: fields });
  assert.equal(sttLanguage(settings('deepgram', { deepgram: { language: 'ja' }, browser: { lang: 'zh-CN' } })), 'ja');
  assert.equal(sttLanguage(settings('azure', { azure: { locale: 'en-US' }, browser: { lang: 'zh-CN' } })), 'en-US');
  assert.equal(sttLanguage(settings('openai', { openai: { language: 'ko' }, browser: { lang: 'zh-CN' } })), 'ko');
  assert.equal(sttLanguage(settings('browser', { browser: { lang: 'de' } })), 'de');
  // An untouched field still yields a usable default instead of an empty header.
  assert.equal(sttLanguage(settings('deepgram', { deepgram: { language: '  ' } })), 'zh-CN');
  assert.equal(sttLanguage(undefined), 'zh-CN');
});

test('a second microphone press during startup cancels instead of orphaning a stream', () => {
  assert.match(source, /if \(speechStarting\.current\) \{ speechCancelRequested\.current = true; return; \}/);
  assert.match(source, /if \(speechCancelRequested\.current\) \{ session\.cancel\?\.\(\); setSpeech\(\{ status: 'idle', error: null \}\); return; \}/);
  assert.match(source, /speechCancelRequested\.current = true;\r?\n        speechRef\.current\?\.cancel\?\.\(\);/);
});

test('the brief threshold reads the same value the card shows', () => {
  // Execute the shipped reader against stub storage: a fresh install must keep
  // the default instead of silently enabling "brief every answer", while an
  // explicitly stored 0 stays meaningful.
  const body = source.match(/    function readStoredBriefThreshold\(\) \{[\s\S]*?\r?\n    \}/)[0];
  // The defaults come from the bundle itself, so this cannot drift from them.
  const key = source.match(/const SETTINGS_BRIEF_THRESHOLD = '([^']+)'/)[1];
  const fallback = Number(source.match(/const VOICE_BRIEF_THRESHOLD = (\d+)/)[1]);
  const storage = new Map();
  const reader = new Function('localStorage', 'SETTINGS_BRIEF_THRESHOLD', 'VOICE_BRIEF_THRESHOLD',
    `${body}\nreturn readStoredBriefThreshold;`)(
    { getItem: (name) => (storage.has(name) ? storage.get(name) : null) }, key, fallback);
  assert.equal(reader(), fallback);
  storage.set(key, '0');
  assert.equal(reader(), 0);
  storage.set(key, '120');
  assert.equal(reader(), 120);
  storage.set(key, 'oops');
  assert.equal(reader(), fallback);
});

test('the 语音输入 settings card owns provider, fields, and availability', () => {
  assert.match(source, /id: 'fairy-voice-stt', order: 32, label: \(\) => '语音输入'/);
  assert.match(source, /'data-dsh-fairy-stt-provider': 'true'/);
  assert.match(source, /'data-dsh-fairy-stt-field': field\.name/);
  assert.match(source, /'data-dsh-fairy-stt-available': entry\.id/);
  assert.match(source, /localTtsTransport\.saveSttConfig\(\{ provider, providers: \{ \[option\.key\]: draft \} \}\)/);
});

test('the engine card可以试听、可放行常驻控件，简报阈值可调', () => {
  assert.match(source, /'data-dsh-fairy-audition': 'true'/);
  assert.match(source, /await speakSampleWithSystem\(\)/);
  assert.match(source, /pcmBytesToSamples\(new Uint8Array\(await response\.arrayBuffer\(\)\)\), sampleRate\)/);
  assert.match(source, /'data-dsh-fairy-always-controls': 'true'/);
  assert.match(source, /'data-dsh-fairy-brief-threshold': 'true'/);
  assert.match(source, /briefThreshold\.value = next;/);
});

test('speech rate is user-controlled and drives every engine', () => {
  assert.match(source, /SETTINGS_RATE = 'dsh\.fairyVoice\.rate\.v1'/);
  assert.match(source, /const SPEECH_RATE_MIN = 0\.5;/);
  assert.match(source, /const SPEECH_RATE_MAX = 2;/);
  assert.match(source, /localStorage\.setItem\(SETTINGS_RATE, String\(rate\)\)/);
  assert.match(source, /'data-dsh-fairy-rate-input': 'true'/);
  // Web Audio: buffer.duration is rate-independent, so the shared timeline
  // divides by the rate instead of trusting the buffer length.
  assert.match(source, /source\.playbackRate\.value = rate;/);
  assert.match(source, /nextStart = startAt \+ buffer\.duration \/ rate;/);
  // System speech reads the live rate for every utterance.
  assert.match(source, /utterance\.rate = rateRef\.current;/);
});

test('voice controls use a compact icon toggle and custom volume slider', () => {
  assert.equal(embeddedClientDom(source), canonicalClientDom);
  assert.match(source, /function ensureVoiceControlStyles\(\)/);
  assert.match(source, /className: 'dsh-fairy-voice-controls'/);
  assert.match(source, /\[FAIRY_VOICE_CONTROL_ATTRIBUTE\]: 'true'/);
  assert.match(source, /className: 'dsh-fairy-voice-auto'/);
  assert.match(source, /className: 'dsh-fairy-voice-volume'/);
  assert.match(source, /IconPauseOutline16/);
  assert.doesNotMatch(source, /children: '本地 Fairy'/);
});

test('voice controls use restrained semantic contrast in both themes', () => {
  assert.match(source, /dsh-fairy-voice-volume::-webkit-slider-runnable-track\{[^}]*var\(--dsw-alias-label-secondary\)/);
  assert.match(source, /dsh-fairy-voice-volume::-webkit-slider-thumb\{[^}]*background:var\(--dsw-alias-label-secondary\)/);
  assert.match(source, /dsh-fairy-voice-auto\[data-on="true"\]\{background:color-mix\(in srgb,var\(--dsw-alias-label-secondary\) 12%,transparent\);color:var\(--dsw-alias-label-secondary\)/);
  assert.doesNotMatch(source, /body\.dsh-hdd-on \.dsh-fairy-voice-(?:auto|volume)/);
});

test('voice brain only derives reports from actual DSH activity metadata', () => {
  assert.match(source, /function readVoiceTimeline\(snapshot\)/);
  assert.match(source, /function collectRunningTools\(block, activeTools/);
  assert.doesNotMatch(source, /node\?\.kind === 'tool-call' && node\.data\?\.root/);
  assert.match(source, /snapshot\?\.chat\?\.legacy\?\.runningCalls/);
  assert.match(source, /function isSearchTool\(name\)/);
  assert.match(source, /activeTools\.some\(\(tool\) => isSearchTool\(tool\.name\)\)/);
  assert.doesNotMatch(source, /reasoning.*searching|searching.*reasoning/i);
});

test('queues the newest status report until the current report finishes', () => {
  assert.match(source, /const pendingStatus = React\.useRef\(null\)/);
  assert.match(source, /pendingStatus\.current = \{ \.\.\.detail, sessionKey \}/);
  assert.match(source, /if \(kind === 'final'\) \{\s*pendingStatus\.current = null/s);
  assert.match(source, /if \(\['idle', 'error'\]\.includes\(detail\.status\)\) drainPendingStatus\(\);/);
  assert.match(source, /window\.dispatchEvent\(new CustomEvent\(EVENT_PLAY, \{ detail: queued \}\)\)/);
});

test('voice brain keeps long-turn status reports sparse, continuous, and cancellable', () => {
  assert.match(source, /VOICE_REPORT_DELAY_MS = 4500/);
  assert.match(source, /VOICE_REPORT_COOLDOWN_MS = 15000/);
  assert.doesNotMatch(source, /VOICE_REPORT_MAX_PER_TURN/);
  assert.match(source, /if \(policy\.timer\) return;/);
  assert.match(source, /if \(live\.phase === phase && live\.silencedTurn !== reportUserSeq\) \{/);
  assert.doesNotMatch(source, /seenPhases\.has\(phase\)/);
  assert.match(source, /schedule\(VOICE_REPORT_COOLDOWN_MS\)/);
  assert.match(source, /kind: 'status', priority: 10, sessionKey/);
  assert.match(source, /window\.addEventListener\('pagehide', clearTimer\)/);
  assert.match(source, /detail\.stop && detail\.kind === 'status'/);
});

test('final answers preempt status synthesis and playback', () => {
  assert.match(source, /const kind = detail\.kind === 'status' \? 'status' : 'final';/);
  assert.match(source, /if \(kind === 'status'\) \{[\s\S]*?if \(activeIntent\.current\?\.priority >= priority \|\| prepareController\.current\) \{[\s\S]*?pendingStatus\.current/s);
  assert.match(source, /if \(kind === 'final'\) \{\s*[\s\S]*?cancelPlayback\(\);/);
  assert.match(source, /activeIntent\.current = null;\s*prepareController\.current\?\.abort\(\);/s);
});

test('only long final answers use the optional local voice-brief bridge', () => {
  assert.match(source, /const VOICE_BRIEF_THRESHOLD = 260/);
  assert.match(source, /kind === 'final' && voiceBrainConfigured\.current/);
  assert.match(source, /createVoiceBrief\(markdown, controller\.signal\)/);
  assert.match(source, /VoiceBrainSection/);
  assert.match(source, /function requestVoiceBrainConfig\(payload\)/);
  assert.match(source, /无法连接本地语音简报服务。请重新加载 DSH 后重试。/);
  assert.match(source, /settings\.section/);
  assert.match(source, /deepseek-v4-flash/);
  assert.match(source, /The visible answer is already authoritative/);
});

test('smooths PCM fragment edges and fades scheduled sources before stopping', () => {
  assert.match(source, /const PCM_EDGE_RAMP_SAMPLES = Math\.round\(PCM_SAMPLE_RATE \* 0\.005\)/);
  assert.match(source, /function applyPcmEdgeRamp\(samples\)/);
  assert.match(source, /samples\[index\] \*= ratio/);
  assert.match(source, /samples\[samples\.length - 1 - index\] \*= ratio/);
  assert.match(source, /linearRampToValueAtTime\(0, now \+ STOP_FADE_SECONDS\)/);
  assert.match(source, /source\.stop\(now === null \? undefined : now \+ STOP_FADE_SECONDS\)/);
  assert.match(source, /if \(played !== true\) retryAutomatic\(\);/);
});

test('voice client boundaries remain separated and scheduler is used by playback', () => {
  assert.match(source, /function createSessionTimelineStore\(/);
  assert.match(source, /function createVoiceTimelineStore\(/);
  assert.match(source, /function createLocalTtsTransport\(/);
  assert.match(source, /function createPcmStreamHandler\(/);
  assert.match(source, /function createWebAudioScheduler\(/);
  assert.match(source, /const scheduler = createWebAudioScheduler\(/);
  assert.match(source, /const \{ waitForPlayback, waitForQueueCapacity \} = scheduler/);
  assert.match(source, /function createAutoReadPolicy\(/);
  assert.match(source, /const samples = buffer\.getChannelData\(0\);\s*pcmStreamHandler\.decodeInto\(bytes, samples\);\s*applyPcmEdgeRamp\(samples\);/s);
  assert.doesNotMatch(source, /new Float32Array\(bytes\.length/);
  assert.doesNotMatch(source, /function legacy(?:Prepare|GetAvailability|GetVoiceBrainStatus|CreateVoiceBrief|RequestVoiceBrainConfig)/);
});

// Harness for the playback boundary: boots the real client bundle against a
// stateful React double, a fake server, and a fake audio stack.
async function bootPlaybackClient({ fetchDouble, onBuffer }) {
  const vm = await import('node:vm');
  const calls = [];
  const spoken = [];
  const listeners = new Map();
  const hooks = [];
  let cursor = 0;
  let active = null;
  const React = {
    useState(initial) {
      const index = cursor; cursor += 1;
      if (!(index in hooks)) hooks[index] = { value: typeof initial === 'function' ? initial() : initial };
      return [hooks[index].value, (next) => {
        // Late async work from a component that no longer owns these hooks
        // (as React ignores setState on unmounted components).
        if (!(index in hooks)) return;
        hooks[index].value = typeof next === 'function' ? next(hooks[index].value) : next;
        if (active) active.rerender();
      }];
    },
    useRef(initial) { const index = cursor; cursor += 1; if (!(index in hooks)) hooks[index] = { value: { current: initial } }; return hooks[index].value; },
    useCallback(callback) { const index = cursor; cursor += 1; if (!(index in hooks)) hooks[index] = { value: callback }; return hooks[index].value; },
    useEffect(callback) { const index = cursor; cursor += 1; if (!(index in hooks)) hooks[index] = { value: callback() }; },
    useLayoutEffect(callback) { this.useEffect(callback); },
    useMemo(callback) { return callback(); },
    useSyncExternalStore(_subscribe, getSnapshot) { return getSnapshot(); },
  };
  // One active component at a time: mounting a new one takes over hook storage,
  // which is enough for these single-screen harnesses.
  const mount = (Component, props) => {
    const handle = { draw: () => { cursor = 0; return Component(props); }, rerender() { handle.tree = handle.draw(); }, tree: null };
    hooks.length = 0;
    // A state update raised during the first draw is stored, not re-entrant:
    // the component is mounted after that draw returns.
    active = null;
    handle.tree = handle.draw();
    active = handle;
    return handle;
  };
  class AudioContextDouble {
    constructor() { this.state = 'running'; this.currentTime = 0; this.destination = {}; }
    createGain() { return { gain: { value: 1, cancelScheduledValues() {}, setValueAtTime() {}, linearRampToValueAtTime() {}, setTargetAtTime() {} }, connect() {}, disconnect() {} }; }
    createBuffer(_channels, length, rate) { onBuffer(rate, length); return { duration: 0.1, length, getChannelData: () => new Float32Array(length) }; }
    createBufferSource() { return { buffer: null, playbackRate: { value: 1 }, connect() {}, disconnect() {}, start() {}, stop() {}, onended: null }; }
    async resume() { this.state = 'running'; }
    async suspend() { this.state = 'suspended'; }
    async close() { this.state = 'closed'; }
  }
  const windowDouble = {
    AudioContext: AudioContextDouble,
    speechSynthesis: {
      getVoices: () => [{ lang: 'zh-CN' }],
      speak: (utterance) => { spoken.push(utterance); setTimeout(() => utterance.onend?.(), 0); },
      cancel() {},
    },
    addEventListener(type, listener) { listeners.set(type, [...(listeners.get(type) || []), listener]); },
    removeEventListener() {},
    dispatchEvent(event) { return Promise.all((listeners.get(event.type) || []).map((listener) => listener(event))); },
  };
  let moduleDefinition;
  const slots = new Map();
  const context = vm.createContext({
    AbortController, Map, Promise, Set, URL, clearTimeout, setTimeout, console,
    CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
    SpeechSynthesisUtterance: class SpeechSynthesisUtterance { constructor(text) { this.text = text; } },
    document: {
      documentElement: { hasAttribute: (name) => name === 'data-dsh-fairy-visual', appendChild() {} },
      getElementById: () => null,
      createElement: () => ({ setAttribute() {}, appendChild() {}, textContent: '' }),
      addEventListener() {}, removeEventListener() {}, visibilityState: 'visible',
    },
    fetch: async (url, options = {}) => { calls.push(`${options.method || 'GET'} ${url}`); return fetchDouble(url, options); },
    localStorage: { getItem: () => null, setItem() {} },
    window: { ...windowDouble, __ModuleLoader__: { load(definition) { moduleDefinition = definition; } } },
  });
  vm.runInContext(source, context, { filename: 'dsh-fairy-voice/client.js' });
  moduleDefinition.factory((id) => {
    if (id === 'react') return React;
    if (id === 'react/jsx-runtime') return { jsx: (type, props) => ({ type, props: props || {} }), jsxs: (type, props) => ({ type, props: props || {} }) };
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return { Tooltip: 'Tooltip', IconPauseOutline16: 'P', IconPlayOutline16: 'P', IconStopFill16: 'S' };
    throw new Error(`unexpected module: ${id}`);
  }).apply({
    effect() {},
    sessions: { list: { getSnapshot: () => ({ current: 'empty-chat' }), subscribe: () => () => {} } },
    slots: { inject(_name, register) { register(); }, register(definition, component) { slots.set(definition.id, component); } },
  });
  const wrapper = slots.get('fairy-voice-controller');
  const element = wrapper({ sessionId: 'empty-chat', useSession: (selector) => selector({}) });
  const instance = mount(element.type, element.props);
  return { calls, spoken, windowDouble, instance, slots, mount };
}

const settleVoiceClient = () => new Promise((resolve) => setTimeout(resolve, 5));

test('a client-side provider answer falls back to browser speech at rate 1.0', async () => {
  const booted = await bootPlaybackClient({
    onBuffer: () => {},
    fetchDouble: async (url) => {
      const json = (value, status = 200, ok = true) => ({ ok, status, json: async () => value });
      if (url.endsWith('/status')) return json({ available: true, reason: null, provider: 'local-sovits' });
      if (url.endsWith('/brain/status')) return json({ configured: false, model: 'deepseek-v4-flash' });
      if (url.endsWith('/prepare')) return json({ sentences: ['你好，主人。', '这是第二句。'] });
      if (url.endsWith('/tts')) return json({ error: { code: 'client-side', message: '浏览器端朗读' } }, 409, false);
      throw new Error(`unexpected fetch ${url}`);
    },
  });
  await settleVoiceClient();
  await settleVoiceClient();
  await booted.windowDouble.dispatchEvent({ type: 'fairy-voice-play', detail: { sessionKey: 'empty-chat', messageId: 'm1', markdown: '一段回答。' } });
  for (let tick = 0; tick < 6; tick += 1) await settleVoiceClient();
  assert.ok(booted.calls.includes('POST /fairy-voice/tts'), `expected a synthesis attempt: ${booted.calls.join(' | ')}`);
  assert.equal(booted.spoken.length, 2);
  assert.equal(booted.spoken[0].text, '你好，主人。');
  assert.equal(booted.spoken[0].rate, 1.0);
  assert.equal(booted.spoken[0].volume, 1);
  assert.equal(booted.spoken[0].lang, 'zh-CN');
  await booted.windowDouble.dispatchEvent({ type: 'fairy-voice-play', detail: { sessionKey: 'empty-chat', stop: true } });
});

test('a host engine dying mid-read hands the remaining sentences to system speech', async () => {
  const calls = { tts: 0 };
  const booted = await bootPlaybackClient({
    onBuffer: () => {},
    fetchDouble: async (url) => {
      const json = (value, status = 200, ok = true) => ({ ok, status, json: async () => value });
      if (url.endsWith('/status')) return json({ available: true, reason: null, provider: 'openai' });
      if (url.endsWith('/brain/status')) return json({ configured: false, model: 'deepseek-v4-flash' });
      if (url.endsWith('/prepare')) return json({ sentences: ['一。', '二。', '三。', '四。', '五。'] });
      if (url.endsWith('/tts')) {
        calls.tts += 1;
        // First group streams, second group fails: the read must continue in
        // the browser for the sentences the host never produced.
        if (calls.tts > 1) return { ok: false, status: 502, headers: { get: () => null }, json: async () => ({ error: { code: 'provider-failed', message: '语音服务未能生成音频。' } }) };
        const samples = new Uint8Array(6400);
        let consumed = false;
        return {
          ok: true,
          status: 200,
          headers: { get: (name) => name.toLowerCase() === 'content-type' ? 'audio/pcm' : null },
          body: { getReader: () => ({ read: async () => (consumed ? { done: true } : ((consumed = true), { done: false, value: samples })), releaseLock() {} }) },
        };
      }
      throw new Error(`unexpected fetch ${url}`);
    },
  });
  await settleVoiceClient();
  await settleVoiceClient();
  const triggered = booted.windowDouble.dispatchEvent({ type: 'fairy-voice-play', detail: { sessionKey: 'empty-chat', messageId: 'm9', markdown: '一。二。三。四。五。' } }).catch(() => {});
  for (let tick = 0; tick < 12; tick += 1) await settleVoiceClient();
  assert.equal(calls.tts, 2, 'both groups were requested from the host engine');
  assert.equal(booted.spoken.length, 1, 'the untouched remainder is spoken in the browser');
  assert.equal(booted.spoken[0].text, '五。');
  await triggered;
});

test('PCM playback schedules buffers at the sample rate the host declares', async () => {
  const rates = [];
  const booted = await bootPlaybackClient({
    onBuffer: (rate) => rates.push(rate),
    fetchDouble: async (url) => {
      const json = (value, status = 200, ok = true) => ({ ok, status, json: async () => value });
      if (url.endsWith('/status')) return json({ available: true, reason: null, provider: 'openai' });
      if (url.endsWith('/brain/status')) return json({ configured: false, model: 'deepseek-v4-flash' });
      if (url.endsWith('/prepare')) return json({ sentences: ['一段回答。'] });
      if (url.endsWith('/tts')) {
        const samples = new Uint8Array(6400);
        let consumed = false;
        return {
          ok: true,
          status: 200,
          headers: { get: (name) => name.toLowerCase() === 'content-type' ? 'audio/pcm' : name.toLowerCase() === 'x-fairy-sample-rate' ? '24000' : null },
          body: { getReader: () => ({ read: async () => (consumed ? { done: true } : ((consumed = true), { done: false, value: samples })), releaseLock() {} }) },
        };
      }
      throw new Error(`unexpected fetch ${url}`);
    },
  });
  await settleVoiceClient();
  await settleVoiceClient();
  // Do not await the trigger: playback stays live until the stop below.
  const triggered = booted.windowDouble.dispatchEvent({ type: 'fairy-voice-play', detail: { sessionKey: 'empty-chat', messageId: 'm2', markdown: '一段回答。' } }).catch(() => {});
  for (let tick = 0; tick < 6; tick += 1) await settleVoiceClient();
  assert.equal(booted.spoken.length, 0, 'PCM playback must not use browser speech');
  assert.ok(rates.length >= 1, `expected scheduled buffers, got ${rates.length}`);
  assert.deepEqual([...new Set(rates)], [24_000]);
  await booted.windowDouble.dispatchEvent({ type: 'fairy-voice-play', detail: { sessionKey: 'empty-chat', stop: true } });
  await triggered;
});

test('the 语音引擎 settings card seeds drafts, switches provider, and saves that section', async () => {
  let stored = {
    provider: 'local-sovits',
    providers: {
      localSovits: { baseURL: 'http://127.0.0.1:9880', referenceAudioPath: 'C:/ref.wav', referencePromptPath: 'C:/ref.txt' },
      openai: { baseURL: 'https://api.openai.com/v1', apiKey: '***', model: 'tts-1', voice: 'alloy' },
      elevenlabsWs: { baseUrl: 'wss://api.elevenlabs.io', apiKey: '***', voiceId: 'voice-1', modelId: 'eleven_multilingual_v2', outputFormat: 'pcm_32000' },
      kokoroWeb: { moduleUrl: 'https://cdn.jsdelivr.net/npm/kokoro-js@1/+esm', modelId: 'onnx-community/Kokoro-82M-v1.0-ONNX', dtype: 'q8', device: 'wasm', voice: 'af_heart' },
      kittenWeb: { moduleUrl: 'https://cdn.jsdelivr.net/npm/kitten-tts-js@0/+esm', modelId: 'KittenML/kitten-tts-nano-0.8', voice: 'Bella' },
      piperWeb: { moduleUrl: 'https://cdn.jsdelivr.net/npm/@mintplex-labs/piper-tts-web@1/+esm', voiceId: 'en_US-hfc_female-medium' },
      customHttp: { url: '', method: 'POST', headersJson: '{}', bodyTemplate: '{"text":"{{text}}"}' },
    },
  };
  const booted = await bootPlaybackClient({
    onBuffer: () => {},
    fetchDouble: async (url, options = {}) => {
      const json = (value, status = 200, ok = true) => ({ ok, status, json: async () => value });
      if (url.endsWith('/provider-config') && (options.method || 'GET') === 'GET') return json(stored);
      if (url.endsWith('/provider-config')) {
        const body = JSON.parse(options.body);
        stored = { ...stored, ...body, providers: { ...stored.providers, ...(body.providers || {}) } };
        return json(stored);
      }
      if (url.endsWith('/providers')) {
        return json([
          { id: 'local-sovits', available: true },
          { id: 'openai', available: false, reason: '未配置 OpenAI API Key。' },
          { id: 'elevenlabs-ws', available: false, reason: '未配置 ElevenLabs API Key。' },
          { id: 'kokoro-web', available: true },
          { id: 'piper-web', available: true },
          { id: 'browser', available: true },
          { id: 'custom-http', available: false, reason: '未配置自定义语音服务地址。' },
        ]);
      }
      if (url.endsWith('/status')) return json({ available: true, reason: null, provider: 'local-sovits' });
      if (url.endsWith('/brain/status')) return json({ configured: false, model: 'deepseek-v4-flash' });
      throw new Error(`unexpected fetch ${url}`);
    },
  });
  await settleVoiceClient();

  const walk = (node, visit) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach((child) => walk(child, visit)); return; }
    if (!node.props) return;
    visit(node);
    walk(node.props.children, visit);
  };
  const find = (tree, predicate) => {
    let found = null;
    walk(tree, (node) => { if (!found && predicate(node)) found = node; });
    return found;
  };

  const card = booted.mount(booted.slots.get('fairy-voice-engine'), {});
  await settleVoiceClient();
  await settleVoiceClient();
  let tree = card.tree;

  const select = find(tree, (node) => node.type === 'select');
  assert.equal(select.props.value, 'local-sovits');
  assert.equal(find(tree, (node) => node.type === 'input' && node.props['data-dsh-fairy-engine-field'] === 'baseURL').props.value, 'http://127.0.0.1:9880');
  assert.equal(find(tree, (node) => node.props['data-dsh-fairy-engine-available'] === 'openai').props.children, '不可用 · 未配置 OpenAI API Key。');
  assert.equal(find(tree, (node) => node.props['data-dsh-fairy-engine-available'] === 'browser').props.children, '可用');

  select.props.onChange({ target: { value: 'openai' } });
  tree = card.tree;
  const apiKeyField = find(tree, (node) => node.type === 'input' && node.props['data-dsh-fairy-engine-field'] === 'apiKey');
  assert.equal(apiKeyField.props.type, 'password');
  assert.equal(apiKeyField.props.value, '***', 'a stored key must come back masked');
  find(tree, (node) => node.type === 'input' && node.props['data-dsh-fairy-engine-field'] === 'model').props.onChange({ target: { value: 'gpt-4o-mini-tts' } });
  await find(card.tree, (node) => node.type === 'button' && node.props.children === '保存').props.onClick();
  for (let tick = 0; tick < 4; tick += 1) await settleVoiceClient();

  const post = booted.calls.find((call) => call === 'POST /fairy-voice/provider-config');
  assert.ok(post, `expected a config write: ${booted.calls.join(' | ')}`);
  assert.equal(stored.provider, 'openai');
  assert.equal(stored.providers.openai.model, 'gpt-4o-mini-tts');
  assert.equal(stored.providers.openai.apiKey, '***', 'an untouched masked key must be preserved');

  // The card offers the WebSocket vendor and both browser engines, and shows
  // availability for each without a round trip to the engine itself.
  select.props.onChange({ target: { value: 'kokoro-web' } });
  for (let tick = 0; tick < 2; tick += 1) await settleVoiceClient();
  tree = card.tree;
  const engineIds = find(tree, (node) => node.type === 'select');
  // Spread into this realm: the bundle runs in a vm, and cross-realm arrays
  // never compare equal to host arrays under deepStrictEqual.
  assert.deepEqual(
    [...engineIds.props.children.filter((child) => child?.props?.value).map((child) => child.props.value)],
    ['local-sovits', 'openai', 'custom-http', 'elevenlabs-ws', 'kitten-web', 'kokoro-web', 'piper-web', 'browser'],
  );
  assert.equal(find(tree, (node) => node.props['data-dsh-fairy-engine-available'] === 'kokoro-web').props.children, '可用');
  assert.equal(find(tree, (node) => node.props['data-dsh-fairy-engine-available'] === 'elevenlabs-ws').props.children, '不可用 · 未配置 ElevenLabs API Key。');
  assert.equal(find(tree, (node) => node.type === 'input' && node.props['data-dsh-fairy-engine-field'] === 'moduleUrl').props.value, 'https://cdn.jsdelivr.net/npm/kokoro-js@1/+esm');
  select.props.onChange({ target: { value: 'piper-web' } });
  for (let tick = 0; tick < 2; tick += 1) await settleVoiceClient();
  tree = card.tree;
  assert.equal(find(tree, (node) => node.type === 'input' && node.props['data-dsh-fairy-engine-field'] === 'voiceId').props.value, 'en_US-hfc_female-medium');
});
