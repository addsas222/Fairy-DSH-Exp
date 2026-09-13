import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/* The embedded-diagnostics boundaries are LF literals; a CRLF checkout would
 * make them unmatchable, so the platform's line ending is normalized away. */
const normalize = (value) => value.replace(/\r\n/g, '\n');
const source = normalize(fs.readFileSync(path.join(root, 'lib', 'client.js'), 'utf8'));
const canonicalClientDiagnostics = normalize(fs.readFileSync(path.resolve(root, '..', '..', 'fairy-contracts', 'client-diagnostics.cjs'), 'utf8'));

function embeddedClientDiagnostics(value) {
  const begin = '// DSH_FAIRY_CLIENT_DIAGNOSTICS_BEGIN\n';
  const end = '// DSH_FAIRY_CLIENT_DIAGNOSTICS_END';
  const start = value.indexOf(begin);
  const finish = value.indexOf(end, start + begin.length);
  assert.ok(start >= 0 && finish > start, 'embedded client diagnostics boundaries should exist');
  return value.slice(start + begin.length, finish);
}

test('embeds the canonical client diagnostics byte for byte', () => {
  assert.equal(embeddedClientDiagnostics(source), canonicalClientDiagnostics);
});

test('owns only the official fresh-session startup flow', () => {
  assert.match(source, /sessions\.clear\(\)/);
  assert.match(source, /workspaces\.startSession\(\)/);
  assert.match(source, /baselinesReady/);
  assert.match(source, /workspaces\.list\.subscribe\(startWhenReady\)/);
  assert.match(source, /function createWorkspaceStarter\(workspaces\)/);
  assert.match(source, /starter\.startOrSubscribe\(\)/);
  assert.match(source, /return \(\) => starter\.dispose\(\)/);
  assert.doesNotMatch(source, /fairy-visual|fairy-voice|localStorage|sessionStorage|querySelector/);
  assert.match(source, /STARTUP_RESET_ATTR/);
  assert.match(source, /root\.hasAttribute\(STARTUP_RESET_ATTR\)/);
  assert.match(source, /root\.setAttribute\(STARTUP_RESET_ATTR, 'true'\)/);
  assert.match(source, /root\.removeAttribute\(STARTUP_RESET_ATTR\)/);
  assert.match(source, /DSH_FAIRY_LOG/);
  assert.match(source, /session\.clear-restored/);
  assert.match(source, /session\.start-fresh/);
  assert.match(source, /started = true;\s*unsubscribe\?\.\(\)/s);
  assert.equal((source.match(/sessions\.clear\(\)/g) || []).length, 1);
  assert.equal((source.match(/workspaces\.startSession\(\)/g) || []).length, 1);
});

test('duplicate startup module application keeps one reset and one baseline subscription', () => {
  let definition;
  const attributes = new Set();
  const document = { documentElement: {
    hasAttribute: (name) => attributes.has(name),
    setAttribute: (name) => attributes.add(name),
    removeAttribute: (name) => attributes.delete(name),
  } };
  vm.runInNewContext(source, { window: { __ModuleLoader__: { load(value) { definition = value; } } }, document, console });
  const plugin = definition.factory();
  let clears = 0;
  let starts = 0;
  let subscribed = 0;
  let unsubscribed = 0;
  let snapshot = { baselinesReady: false, recentWorkspaceId: 'workspace-1' };
  let notify;
  const cleanups = [];
  const ctx = {
    sessions: { clear() { clears += 1; } },
    workspaces: { list: {
      getSnapshot: () => snapshot,
      subscribe(listener) { subscribed += 1; notify = listener; return () => { unsubscribed += 1; }; },
    }, startSession() { starts += 1; } },
    effect(factory) { cleanups.push(factory()); },
  };
  plugin.apply(ctx);
  plugin.apply(ctx);
  assert.equal(clears, 1);
  assert.equal(subscribed, 1);
  snapshot = { ...snapshot, baselinesReady: true };
  notify();
  assert.equal(starts, 1);
  assert.equal(unsubscribed, 1);
  cleanups.forEach((cleanup) => cleanup());
});
