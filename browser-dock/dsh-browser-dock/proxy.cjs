#!/usr/bin/env node
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { createFairyDiagnostics } = require('dsh-fairy-contracts/client-diagnostics');
const diagnostics = createFairyDiagnostics('dsh-browser-dock');

process.on('uncaughtExceptionMonitor', (error, origin) => {
  diagnostics.error('proxy.top-level', error, { origin });
});

const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const runtimeDir = path.join(dshHome, 'browser-dock');

/**
 * libuv asserts that the watched directory and the names Windows reports share
 * a prefix (`fs-event.c`, `!_wcsnicmp(filename, dir, dirlen)`). A short (8.3)
 * component in `DSH_HOME` - `C:\Users\ADMINI~1\...`, `RUNNER~1` on CI - breaks
 * that assumption and the assertion aborts this proxy process, leaving the dock
 * frozen with an orphaned browser child.
 */
function canonicalDir(dir) {
  try {
    return fs.realpathSync.native(dir);
  } catch {
    return dir;
  }
}
const stateFile = path.join(runtimeDir, 'state.json');
const legacyFrameFile = path.join(runtimeDir, 'frame.jpg');
const commandFile = path.join(runtimeDir, 'command.json');
const commandFileName = path.basename(commandFile);
const commandRescanMs = 5_000;
const playwrightCommand = path.join(dshHome, 'profiles', 'web', 'node_modules', '.bin', 'playwright-mcp');
const profileFlagIndex = process.argv.indexOf('--user-data-dir');
const userDataDir = profileFlagIndex >= 0 ? process.argv[profileFlagIndex + 1] : path.join(dshHome, 'playwright-profile');
const captureActions = new Set([
  'browser_navigate', 'browser_navigate_back', 'browser_click', 'browser_type',
  'browser_fill_form', 'browser_press_key', 'browser_select_option', 'browser_drag',
  'browser_drop', 'browser_file_upload', 'browser_handle_dialog', 'browser_resize',
  'browser_tabs', 'browser_wait_for', 'browser_run_code_unsafe', 'browser_evaluate',
  'browser_snapshot', 'browser_take_screenshot', 'browser_hover',
]);
const humanPattern = /(?:captcha|验证码|人机验证|verify (?:that )?you are human|sign[ -]?in|log[ -]?in|登录|two[ -]?factor|2fa|authentication code)/i;

/* A detached spawn emits its failures as an `error` event. With no listener that
 * event is rethrown as an uncaught exception and takes the whole proxy (and the
 * MCP session riding on it) down - a handoff that could not find a browser would
 * kill the dock instead of reporting. Every detached spawn goes through here, so
 * the failure stays a diagnostic. */
function spawnDetached(event, command, args, options = {}) {
  const child = spawn(command, args, { detached: true, stdio: 'ignore', ...options });
  child.on('error', (error) => diagnostics.warn(event, { platform: process.platform }, error));
  child.unref();
  return child;
}

fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
try { fs.chmodSync(runtimeDir, 0o700); } catch {}

let revision = 0;
let frameRevision = 0;
let state = inactiveState();
let internalSequence = 0;
let captureRequested = false;
let captureRunning = false;
let captureHint = '';
let closed = false;
let commandSignature = '';
const internalIdPrefix = `dsh-browser-dock:${process.pid}:`;
const clientCalls = new Map();
const internalCalls = new Map();

function inactiveState(extra = {}) {
  return {
    active: false,
    loading: false,
    status: 'idle',
    url: '',
    title: '',
    tabs: [],
    currentTab: -1,
    frameRevision,
    takeoverAvailable: false,
    takeoverConsumed: false,
    ownerSessionId: null,
    error: null,
    updatedAt: Date.now(),
    ...extra,
  };
}

function atomicWrite(file, data, mode = 0o600) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, data, { mode });
  fs.renameSync(temporary, file);
  try { fs.chmodSync(file, mode); } catch {}
}

function frameFile(revisionValue) {
  return path.join(runtimeDir, `frame-${revisionValue}.jpg`);
}

function removeFrameFiles(keepNewest = 0) {
  let frames = [];
  try {
    frames = fs.readdirSync(runtimeDir)
      .map((name) => ({ name, revision: Number(name.match(/^frame-(\d+)\.jpg$/)?.[1]) }))
      .filter((entry) => Number.isSafeInteger(entry.revision))
      .sort((left, right) => right.revision - left.revision);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  for (const entry of frames.slice(keepNewest)) {
    try { fs.unlinkSync(path.join(runtimeDir, entry.name)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  try { fs.unlinkSync(legacyFrameFile); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

function publish(patch = {}) {
  revision += 1;
  state = { ...state, ...patch, revision, updatedAt: Date.now() };
  atomicWrite(stateFile, JSON.stringify(state));
}

function removeRuntimeFiles() {
  removeFrameFiles();
  for (const file of [stateFile, commandFile]) {
    try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') diagnostics.error('proxy.cleanup', error, { file: path.basename(file) }); }
  }
}

function key(id) {
  return `${typeof id}:${JSON.stringify(id)}`;
}

function sendToServer(message) {
  if (!child.stdin.destroyed && child.stdin.writable) {
    try { child.stdin.write(`${JSON.stringify(message)}\n`); }
    catch (error) { diagnostics.warn('proxy.child.write', {}, error); }
  }
}

function internalCall(name, args) {
  return new Promise((resolve, reject) => {
    const id = `${internalIdPrefix}${++internalSequence}`;
    const timeout = setTimeout(() => {
      internalCalls.delete(key(id));
      reject(new Error(`${name} timed out`));
    }, 12_000);
    internalCalls.set(key(id), {
      resolve: (message) => { clearTimeout(timeout); resolve(message); },
      reject: (error) => { clearTimeout(timeout); reject(error); },
      timeout,
    });
    sendToServer({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
  });
}

function textContent(message) {
  return (message?.result?.content || [])
    .filter((block) => block?.type === 'text')
    .map((block) => block.text || '')
    .join('\n');
}

function parseTabs(message) {
  const text = textContent(message);
  const tabs = [];
  for (const line of text.split('\n')) {
    const match = line.match(/^-\s+(\d+):(?:(\s+\(current\)))?\s+\[(.*)\]\((.*)\)(?:\s+\[crashed\])?$/);
    if (!match) continue;
    tabs.push({ index: Number(match[1]), current: Boolean(match[2]), title: match[3], url: match[4] });
  }
  return tabs;
}

function pageFromText(text) {
  const url = text.match(/^- Page URL:\s*(.+)$/m)?.[1]?.trim();
  const title = text.match(/^- Page Title:\s*(.+)$/m)?.[1]?.trim();
  return { url, title };
}

function cleanText(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function searchText(url) {
  try {
    const parsed = new URL(url);
    for (const key of ['q', 'query', 'wd', 'word', 'search_query']) {
      const value = cleanText(parsed.searchParams.get(key));
      if (value) return value;
    }
  } catch {}
  return '';
}

function displayTitle(url, title) {
  const query = searchText(url);
  if (query) return query;
  const value = cleanText(title);
  return /^(?:about:blank|blank page|new tab|new page|untitled|新标签页|空白页)$/i.test(value) ? '' : value;
}

function isPresentablePage(url, title) {
  const value = cleanText(url).toLowerCase();
  if (!value || value === 'about:blank' || value.startsWith('chrome://newtab') || value.startsWith('edge://newtab')) return false;
  return Boolean(displayTitle(url, title));
}

function requestCapture(hint = '') {
  captureRequested = true;
  captureHint = `${captureHint}\n${hint}`.slice(-16_000);
  if (!captureRunning) void drainCapture();
}

async function drainCapture() {
  captureRunning = true;
  while (captureRequested && !closed) {
    const startedAt = diagnostics.start();
    captureRequested = false;
    const hint = captureHint;
    captureHint = '';
    try {
      const tabsMessage = await internalCall('browser_tabs', { action: 'list' });
      const tabs = parseTabs(tabsMessage);
      if (!tabs.length) {
        removeFrameFiles();
        publish(inactiveState());
        continue;
      }
      const current = tabs.find((tab) => tab.current) || tabs[0];
      const screenshot = await internalCall('browser_take_screenshot', { type: 'jpeg', scale: 'css' });
      const image = (screenshot?.result?.content || []).find((block) => block?.type === 'image' && typeof block.data === 'string');
      if (!image) throw new Error('Playwright returned no screenshot image');
      const screenshotPage = pageFromText(textContent(screenshot));
      const url = screenshotPage.url || current.url || '';
      const title = displayTitle(url, screenshotPage.title || current.title || '');
      if (!isPresentablePage(url, title)) {
        removeFrameFiles();
        frameRevision += 1;
        publish(inactiveState({ status: 'waiting', frameRevision }));
        continue;
      }
      frameRevision += 1;
      atomicWrite(frameFile(frameRevision), Buffer.from(image.data, 'base64'));
      removeFrameFiles(4);
      const displayTabs = tabs
        .map((tab) => ({ ...tab, title: displayTitle(tab.url, tab.title) }))
        .filter((tab) => isPresentablePage(tab.url, tab.title));
      const needsHuman = humanPattern.test(`${hint}\n${textContent(tabsMessage)}\n${textContent(screenshot)}`);
      publish({
        active: true,
        loading: false,
        status: 'ready',
        url,
        title,
        tabs: displayTabs,
        currentTab: current.index,
        frameRevision,
        takeoverAvailable: needsHuman,
        takeoverConsumed: needsHuman ? state.takeoverConsumed : false,
        error: null,
      });
    } catch (error) {
      diagnostics.error('proxy.capture', error, { active: state.active });
      if (state.active && state.frameRevision > 0 && fs.existsSync(frameFile(state.frameRevision))) {
        publish({ loading: false, status: 'error', error: error.message });
      } else {
        publish(inactiveState({ status: 'error', error: error.message, frameRevision }));
      }
    } finally {
      diagnostics.metric('proxy.capture', startedAt, { active: state.active });
    }
  }
  captureRunning = false;
}

async function closeBrowser(reason = 'closed') {
  captureRequested = false;
  try { await internalCall('browser_close', {}); } catch {}
  removeFrameFiles();
  frameRevision += 1;
  publish(inactiveState({ status: reason, frameRevision }));
}

/* Windows has no `/usr/bin/open`, and a spawn failure used to be silent: the
 * dock reported "handoff" while nothing opened. `start` is the platform's
 * launcher, and the executable after it selects which browser takes over (empty
 * = the system default). The browser is configurable because the takeover
 * command is not always the browser MCP is driving: this host has no Chrome, so
 * the instance selects `msedge` through DSH_FAIRY_HANDOFF_BROWSER.
 *
 * The user-data-dir is dropped on Windows on purpose: handing off to a browser
 * already running with the same directory just focuses that window and ignores
 * the URL, which reads as "takeover did nothing". No data is lost - the MCP
 * session's own cookies live in the headless profile the user-data-dir points
 * at, and the handoff exists to move the *page* to a visible window. */
function handoffCommand(url) {
  if (process.platform !== 'win32') {
    return { command: '/usr/bin/open', args: ['-na', 'Google Chrome', '--args', `--user-data-dir=${userDataDir}`, '--new-window', url] };
  }
  /* Windows: `start` through a hand-built command line (`windowsVerbatimArguments`)
   * because two mechanisms measured on this host break every simpler form:
   *
   *   1. A URL containing `&` (any query string) is split by cmd: `cmd /c start ""
   *      <url>` answers `'b' is not recognized as an internal or external
   *      command` and the browser only receives the part before the `&`. Node's
   *      win32 quoting does not escape `&` for cmd, so the URL is quoted here.
   *   2. An unquoted browser path containing a space (`C:\Program Files (x86)\
   *      Microsoft\Edge\Application\msedge.exe`) is swallowed by `start`'s
   *      window-title slot - it becomes the title and nothing launches. The
   *      browser is therefore quoted too, and the empty title slot stays first.
   *
   * The user-data-dir is passed on both platforms: takeover exists to keep the
   * session, and a measurement after closeBrowser() showed a visible browser
   * reusing that profile (window stayed up, session data still present). */
  const browser = process.env.DSH_FAIRY_HANDOFF_BROWSER || '';
  return {
    command: process.env.ComSpec || 'cmd.exe',
    args: ['/d', '/s', '/c', `start "" ${browser ? `"${browser}" ` : ''}"${url}" --new-window "--user-data-dir=${userDataDir}"`],
    options: { windowsVerbatimArguments: true },
  };
}

async function externalTakeover(command) {
  if (!state.active || !state.takeoverAvailable || state.takeoverConsumed || command.revision !== state.revision) return;
  const url = state.url || 'about:blank';
  publish({ loading: true, status: 'handoff', takeoverConsumed: true });
  await closeBrowser('handoff');
  const handoff = handoffCommand(url);
  spawnDetached('proxy.takeover.spawn', handoff.command, handoff.args, handoff.options);
}

async function handleCommand(command) {
  if (!command || typeof command !== 'object') return;
  if (command.action === 'bind' && state.active && state.ownerSessionId == null && typeof command.sessionId === 'string') {
    publish({ ownerSessionId: command.sessionId });
    return;
  }
  if (command.action === 'close') {
    if (command.ownerSessionId && state.ownerSessionId && command.ownerSessionId !== state.ownerSessionId) return;
    await closeBrowser(command.reason || 'closed');
    return;
  }
  if (command.action === 'takeover') await externalTakeover(command);
}

function pollCommands() {
  let stat;
  try { stat = fs.statSync(commandFile); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  const signature = `${stat.mtimeMs}:${stat.size}`;
  if (signature === commandSignature) return;
  commandSignature = signature;
  try {
    const command = JSON.parse(fs.readFileSync(commandFile, 'utf8'));
    try { fs.unlinkSync(commandFile); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    commandSignature = '';
    void handleCommand(command).catch((error) => diagnostics.error('proxy.control.command', error, { action: command.action || 'unknown' }));
  }
  catch (error) { diagnostics.warn('proxy.control.parse', {}, error); }
}

removeRuntimeFiles();
publish(inactiveState());

/* npm writes three shims into `.bin`: an extension-less POSIX shell script plus
 * `.cmd`/`.ps1` for Windows. Windows cannot execute the extension-less one, so
 * the platform's own shim is launched instead - with a missing browser start
 * the dock stayed silent with no error to read. */
function resolveLauncher(target) {
  const candidates = process.platform === 'win32'
    ? [`${target}.cmd`, `${target}.exe`, `${target}.bat`, target]
    : [target];
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    // `.cmd`/`.bat` are scripts for the command interpreter, not executable
    // images, and Node refuses to spawn them without a shell.
    return /[.](?:cmd|bat)$/i.test(candidate)
      ? { command: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', candidate], candidates }
      : { command: candidate, args: [], candidates };
  }
  return { command: target, args: [], candidates };
}

const launcher = resolveLauncher(playwrightCommand);
const child = spawn(launcher.command, [...launcher.args, ...process.argv.slice(2)], { stdio: ['pipe', 'pipe', 'pipe'] });
/* A missing/unspawnable playwright shim emits `error`; with no listener Node
 * rethrows it and the whole proxy dies with a bare stack - the dock then sits
 * frozen with no state file to read and no diagnostic naming the launcher.
 * Report which candidate was resolved, then shut down through the same path a
 * dead child uses so the MCP session sees a clean end instead of a hangup. */
child.on('error', (error) => {
  diagnostics.warn('proxy.child.spawn', { command: launcher.command, candidates: launcher.candidates }, error);
  shutdown('child-spawn', 'SIGTERM');
});
child.stderr.pipe(process.stderr);

const clientInput = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
clientInput.on('line', (line) => {
  let message;
  try { message = JSON.parse(line); } catch { child.stdin.write(`${line}\n`); return; }
  if (message?.method === 'tools/call' && message.id !== undefined) {
    const name = message.params?.name;
    clientCalls.set(key(message.id), name);
    if (captureActions.has(name)) {
      if (state.active && state.frameRevision > 0 && fs.existsSync(frameFile(state.frameRevision))) {
        publish({ loading: true, status: 'loading', error: null });
      } else {
        publish(inactiveState({ loading: true, status: 'starting', frameRevision }));
      }
    }
  }
  sendToServer(message);
});

readline.createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => {
  let message;
  try { message = JSON.parse(line); } catch { process.stdout.write(`${line}\n`); return; }
  const internal = message.id === undefined ? null : internalCalls.get(key(message.id));
  if (internal) {
    internalCalls.delete(key(message.id));
    internal.resolve(message);
    return;
  }
  // A timed-out internal call can still receive a late server response. Its
  // private ID must never escape onto the client-facing JSON-RPC stream.
  if (typeof message.id === 'string' && message.id.startsWith(internalIdPrefix)) return;
  process.stdout.write(`${line}\n`);
  if (message.id === undefined) return;
  const callKey = key(message.id);
  const name = clientCalls.get(callKey);
  clientCalls.delete(callKey);
  if (name === 'browser_close') {
    try { removeFrameFiles(); } catch {}
    frameRevision += 1;
    publish(inactiveState({ status: 'closed', frameRevision }));
  } else if (captureActions.has(name)) {
    const hint = textContent(message);
    requestCapture(hint);
  }
});

const checkCommands = () => {
  try { pollCommands(); } catch (error) { diagnostics.error('proxy.control.poll', error, {}); }
};

let commandWatcher = null;
try {
  // Commands are atomically renamed into the stable runtime directory. Use
  // directory events for normal low-latency delivery and keep only a slow
  // reconciliation timer for platforms that can drop filesystem events.
  commandWatcher = fs.watch(canonicalDir(runtimeDir), (event, filename) => {
    if ((event === 'change' || event === 'rename') && String(filename || '') === commandFileName) checkCommands();
  });
  commandWatcher.on('error', (error) => {
    diagnostics.warn('proxy.control.watch', { fallback_rescan_ms: commandRescanMs }, error);
    commandWatcher?.close();
    commandWatcher = null;
  });
} catch (error) {
  diagnostics.warn('proxy.control.watch', { fallback_rescan_ms: commandRescanMs }, error);
}
const commandTimer = setInterval(checkCommands, commandRescanMs);
commandTimer.unref?.();

/* `reason` is what the MCP calls see and what makes a shutdown diagnosable;
 * `signal` must still be a real signal name because it is handed to
 * `child.kill` (`child-spawn` as a signal throws ERR_UNKNOWN_SIGNAL). */
function shutdown(reason, signal = reason) {
  if (closed) return;
  closed = true;
  clearInterval(commandTimer);
  commandWatcher?.close();
  commandWatcher = null;
  for (const call of internalCalls.values()) {
    clearTimeout(call.timeout);
    call.reject(Object.assign(new Error(`Browser Dock shutting down (${reason})`), { code: 'proxy-shutdown' }));
  }
  internalCalls.clear();
  clientCalls.clear();
  removeRuntimeFiles();
  if (!child.killed) child.kill(signal);
  setTimeout(() => process.exit(0), 250);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
clientInput.on('close', () => shutdown('SIGTERM'));
process.on('exit', removeRuntimeFiles);
child.on('exit', (code, signal) => {
  closed = true;
  clearInterval(commandTimer);
  commandWatcher?.close();
  commandWatcher = null;
  for (const call of internalCalls.values()) {
    clearTimeout(call.timeout);
    call.reject(Object.assign(new Error('Playwright process exited'), { code: 'proxy-child-exited' }));
  }
  internalCalls.clear();
  clientCalls.clear();
  removeRuntimeFiles();
  process.exit(code ?? (signal ? 1 : 0));
});
