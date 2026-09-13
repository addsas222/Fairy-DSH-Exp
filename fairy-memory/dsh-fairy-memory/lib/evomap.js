/**
 * EvoMap A2A - Layer 1 only: recover-or-register a node and hand the user a
 * claim URL. This module implements exactly the flow in
 * https://evomap.ai/skill.md (GEP-A2A v1.0.0) and nothing past it:
 *
 *  - It runs only when a person explicitly asks for it (the CLI subcommand),
 *    because that document is reference material and reading it authorises
 *    nothing.
 *  - Credentials live in `~/.evomap/` with owner-only permissions. The secret is
 *    never printed, never logged, and never written into this repository; the
 *    only value shown to a human is the public `node_id` and the `claim_url`.
 *  - Heartbeats (Layer 2b), credential persistence in agent memory (Layer 2a),
 *    and task operations (Layer 3) each need their own user request, so they are
 *    deliberately absent here.
 *
 * @module dsh-fairy-memory/evomap
 */
import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const EVOMAP_HUB = 'https://evomap.ai';
export const EVOMAP_PROTOCOL_VERSION = '1.0.0';
const DEFAULT_AGENT_NAME = 'Fairy DSH Agent';
const TIMEOUT_MS = 20_000;

/** `~/.evomap` is the documented canonical location on every platform. */
export function evomapHome() {
  return join(homedir(), '.evomap');
}

function credentialsFromEnv() {
  const id = String(process.env.EVOMAP_NODE_ID || '').trim();
  const secret = String(process.env.EVOMAP_NODE_SECRET || '').trim();
  return { id: /^node_[A-Za-z0-9_-]+$/.test(id) ? id : '', secret: /^[0-9a-f]{64}$/i.test(secret) ? secret : '' };
}

async function readIfExists(file) {
  try {
    return (await readFile(file, 'utf8')).trim();
  } catch {
    return '';
  }
}

/**
 * Step 1.1, the cheap half: the canonical files first, then the documented
 * environment variables. Only a complete pair counts - a partial match is not
 * an identity, and the private storage of other agents is not this module's to
 * scan.
 */
export async function recoverIdentity() {
  const directory = evomapHome();
  const id = await readIfExists(join(directory, 'node_id'));
  const secret = await readIfExists(join(directory, 'node_secret'));
  if (/^node_[A-Za-z0-9_-]+$/.test(id) && /^[0-9a-f]{64}$/i.test(secret)) {
    return { found: true, source: 'file', id, secret };
  }
  const environment = credentialsFromEnv();
  if (environment.id && environment.secret) return { found: true, source: 'env', id: environment.id, secret: environment.secret };
  return { found: false, source: null, id: id || environment.id || '', secret: '' };
}

/** Owner-only storage: the secret is private state, not configuration. */
export async function storeIdentity({ id, secret }) {
  const directory = evomapHome();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700).catch(() => {});
  const write = async (name, value) => {
    const file = join(directory, name);
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, `${value}\n`, { encoding: 'utf8', mode: 0o600 });
    await chmod(temporary, 0o600).catch(() => {});
    await rename(temporary, file);
  };
  await write('node_id', id);
  await write('node_secret', secret);
  return directory;
}

function messageId() {
  return `msg_${Date.now()}_${createHash('sha256').update(`${Math.random()}`).digest('hex').slice(0, 4)}`;
}

/** One A2A envelope; `sender_id` is omitted on the very first hello. */
function envelope({ nodeId, secret, payload }) {
  const body = {
    protocol: 'gep-a2a',
    protocol_version: EVOMAP_PROTOCOL_VERSION,
    message_type: 'hello',
    message_id: messageId(),
    timestamp: new Date().toISOString(),
    payload,
  };
  if (nodeId) body.sender_id = nodeId;
  const headers = { 'content-type': 'application/json' };
  if (secret) headers.authorization = `Bearer ${secret}`;
  return { body, headers };
}

function unwrap(payload) {
  return payload && typeof payload === 'object' && payload.payload && typeof payload.payload === 'object' ? payload.payload : payload;
}

async function hello({ fetchImpl, nodeId, secret, payload, signal }) {
  const { body, headers } = envelope({ nodeId, secret, payload });
  let response;
  try {
    response = await fetchImpl(`${EVOMAP_HUB}/a2a/hello`, { method: 'POST', headers, body: JSON.stringify(body), signal });
  } catch (error) {
    return { kind: 'unreachable', detail: error?.message || 'network error' };
  }
  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  const value = unwrap(data);
  if (response.status === 403) return { kind: 'invalid-secret', detail: value?.error || value?.code || 'node_secret_invalid' };
  if (!response.ok) return { kind: 'unreachable', detail: `HTTP ${response.status}` };
  if (value?.claimed === true) return { kind: 'claimed', nodeId: value.owner_user_id ? undefined : undefined, owner: value.owner_user_id ?? null, value };
  if (value?.claim_url) return { kind: value.claimed === false ? 'unbound' : 'registered', value };
  return { kind: 'unknown', value };
}

/**
 * Layer 1 end to end. `name` defaults to a neutral alias (the claim page can
 * rename it), and a fresh registration stores the issued secret immediately -
 * never in the reply the caller prints.
 */
export async function joinEvoMap({ name = '', model = '', fetchImpl = fetch, signal, now = () => Date.now() } = {}) {
  void now;
  const recovered = await recoverIdentity();
  if (recovered.found) {
    const probe = await hello({ fetchImpl, nodeId: recovered.id, secret: recovered.secret, payload: {}, signal });
    if (probe.kind === 'claimed') {
      return { status: 'already-bound', nodeId: recovered.id, source: recovered.source, note: '这个节点已绑定到 EvoMap 账号，无需重新注册。' };
    }
    if (probe.kind === 'unbound') {
      return { status: 'claim-required', nodeId: recovered.id, source: recovered.source, claimUrl: probe.value.claim_url, note: '发现了已存在但尚未绑定的节点；打开链接即可绑定，私钥仍在本地存储中。' };
    }
    if (probe.kind === 'invalid-secret') {
      return { status: 'invalid-secret', nodeId: recovered.id, source: recovered.source, note: '本地保存的 node_secret 无效。轮换密钥需要你明确同意（本命令不会自动轮换）；也可在 EvoMap 账号页重发密钥后再重试。', detail: probe.detail };
    }
    return { status: 'unreachable', nodeId: recovered.id, source: recovered.source, note: 'EvoMap Hub 当前不可达；本地凭据已保留，未做任何清理。', detail: probe.detail };
  }

  const registration = await hello({
    fetchImpl,
    payload: {
      capabilities: {},
      model: String(model || '').trim() || 'unknown',
      name: (String(name || '').trim() || DEFAULT_AGENT_NAME).slice(0, 32),
      env_fingerprint: { platform: process.platform, arch: process.arch },
    },
    signal,
  });
  if (registration.kind !== 'registered') {
    return {
      status: registration.kind === 'unreachable' ? 'unreachable' : 'failed',
      note: registration.kind === 'unreachable' ? 'EvoMap Hub 当前不可达，未注册。' : 'EvoMap 未返回可用的注册结果。',
      detail: registration.detail ?? null,
    };
  }
  const value = registration.value;
  const nodeId = value.your_node_id;
  const secret = value.node_secret;
  if (typeof nodeId !== 'string' || typeof secret !== 'string') {
    return { status: 'failed', note: 'EvoMap 的响应里缺少 node_id 或 node_secret，未保存任何凭据。' };
  }
  const directory = await storeIdentity({ id: nodeId, secret });
  return {
    status: 'registered',
    nodeId,
    claimUrl: value.claim_url ?? null,
    claimCode: value.claim_code ?? null,
    heartbeatIntervalMs: Number.isFinite(value.heartbeat_interval_ms) ? value.heartbeat_interval_ms : null,
    storedAt: directory,
    note: '新节点已注册，凭据以仅本人可读的权限保存在本地；把它绑定到你的账号即可。',
  };
}

/** Read-only local view: never touches the network, never prints the secret. */
export async function evoMapStatus() {
  const recovered = await recoverIdentity();
  return {
    configured: recovered.found,
    nodeId: recovered.found || recovered.id ? recovered.id : null,
    source: recovered.source,
    directory: evomapHome(),
    heartbeat: 'not-running',
    note: recovered.found
      ? '已找到本地凭据；"join" 会先探测其状态再决定是否需要注册。'
      : '本地没有凭据；"join" 会注册一个新节点并给出绑定链接。心跳（stay online）与任务操作需要你另外明确要求。',
  };
}

/** Timeout wrapper so a hung hub cannot hold the CLI open forever. */
export function withTimeout(task, timeoutMs = TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('timeout'), timeoutMs);
  return task(controller.signal).finally(() => clearTimeout(timer));
}
