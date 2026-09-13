/**
 * Host half of dsh-fairy-modes: the HTTP bridge the browser chip calls.
 *
 * The mode service itself is realm-private (a preset mounts
 * `dsh-fairy-modes` inside `isolate: { fairyMode: true }`), so this row resolves
 * the session's Agent and then asks `ctx.agentPresets.serviceFor(agent,
 * 'fairyMode')` for that agent's own instance — the read addressing
 * `dsh-agent-presets` exists for exactly this caller.
 *
 * Endpoints:
 * - `POST /fairy-modes/set`   `{ sessionId, mode }` → `{ ok: true, mode }`
 * - `GET  /fairy-modes/state?sessionId=` → `{ ok: true, mode, plan }`
 *
 * @module dsh-fairy-modes/bridge
 */

import { createFairyDiagnostics } from 'dsh-fairy-contracts/diagnostics';
import { normalizeFairyMode } from './contract.js';

const diagnostics = createFairyDiagnostics('dsh-fairy-modes/bridge');

/** Session identity that resolves no live Agent (unknown, or a subagent session). */
const UNRESOLVABLE = 422;

/** The mode service is not mounted for this session's preset. */
const UNMOUNTED = 503;

function sendJson(res, status, value) {
  if (res.destroyed || res.writableEnded) return false;
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(value));
  return true;
}

async function readJson(req, maxBytes = 64_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new Error('payload-too-large');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('invalid-json');
  }
}

/**
 * Read the official plan projection the chip displays beside the fairy mode.
 * `plan` stays official state (dsh-plan-mode owns it); this only mirrors its
 * documented unit state into the projection's own wire view.
 *
 * @param ctx - host context.
 * @param session - the session to read.
 * @returns `{ active, pending }`, or null while plan mode is not composed.
 */
function planState(ctx, session) {
  const projections = ctx.get('sessionProjections');
  if (projections === undefined) return null;
  try {
    const state = projections.stateOf(session, 'plan');
    if (state === undefined) return null;
    const wanted = state.running == null ? state.wanted : state.running.wanted;
    return { active: state.active === true, pending: wanted != null && wanted !== state.active };
  } catch (error) {
    diagnostics.warn('plan-state', {}, error);
    return null;
  }
}

/**
 * Build the two route handlers. Each one answers the same three failures the
 * chip renders: a bad request, an unresolvable session, and a deployment that
 * mounts no mode service for it.
 *
 * @param ctx - host context carrying `agents`/`sessionController` and `agentPresets`.
 * @returns Handlers plus their disposal.
 */
export function createFairyModesBridge(ctx) {
  /**
   * Resolve the live Agent for a session identity. A live agent is read
   * directly; a cold identity goes through the session controller's resolver
   * when the deployment composes one.
   */
  async function resolveAgent(sessionId) {
    const agents = ctx.get('agents');
    const live = agents?.get?.(sessionId);
    if (live?.session !== undefined) return { agent: live };
    const sessions = ctx.get('sessionController');
    if (typeof sessions?.resolveAgent !== 'function') return {};
    try {
      const result = await sessions.resolveAgent(sessionId);
      if (result?.agent !== undefined) return { agent: result.agent };
      diagnostics.warn('resolve-agent', { sessionId, reason: result?.error?.code ?? 'no-agent' });
      return {};
    } catch (error) {
      diagnostics.warn('resolve-agent', { sessionId }, error);
      return {};
    }
  }

  /** The session's realm-private mode service, or the reason it is unreachable. */
  function serviceFor(agent) {
    const presets = ctx.get('agentPresets');
    if (presets === undefined) {
      return { error: '本部署未组合 dsh-agent-presets：会话模式服务不可达。' };
    }
    const service = presets.serviceFor?.(agent, 'fairyMode');
    if (service === undefined) {
      return { error: '该会话的 preset 未挂载 dsh-fairy-modes：模式服务不可用。' };
    }
    return { service };
  }

  /** Shared intake: sessionId → agent → mode service. */
  async function resolve(sessionId) {
    if (typeof sessionId !== 'string' || sessionId.trim() === '') {
      return { status: UNRESOLVABLE, error: '请求缺少 sessionId。' };
    }
    const { agent } = await resolveAgent(sessionId);
    if (agent === undefined) {
      return { status: UNRESOLVABLE, error: `无法为会话 "${sessionId}" 解析出活动 Agent（会话不存在或属于子代理路由）。` };
    }
    const { service, error } = serviceFor(agent);
    if (service === undefined) return { status: UNMOUNTED, error };
    return { agent, service };
  }

  return {
    set: async (req, res) => {
      if (req.method !== undefined && req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'POST only.' });
        return;
      }
      let body;
      try {
        body = await readJson(req);
      } catch (error) {
        sendJson(res, 400, { ok: false, error: error?.message === 'payload-too-large' ? '请求体过大。' : '请求体不是合法 JSON。' });
        return;
      }
      const mode = normalizeFairyMode(body?.mode);
      if (mode === undefined) {
        sendJson(res, 400, { ok: false, error: 'mode 必须是 off、ptc 或 create。' });
        return;
      }
      const resolved = await resolve(body?.sessionId);
      if (resolved.service === undefined) {
        sendJson(res, resolved.status, { ok: false, error: resolved.error });
        return;
      }
      try {
        resolved.service.set(resolved.agent, mode);
      } catch (error) {
        diagnostics.warn('set', { sessionId: body?.sessionId, mode }, error);
        sendJson(res, 500, { ok: false, error: `切换模式失败：${String(error?.message ?? error)}` });
        return;
      }
      sendJson(res, 200, { ok: true, mode });
    },

    state: async (req, res) => {
      const sessionId = new URL(req.url ?? '/', 'http://localhost').searchParams.get('sessionId') ?? undefined;
      const resolved = await resolve(sessionId);
      if (resolved.service === undefined) {
        sendJson(res, resolved.status, { ok: false, error: resolved.error });
        return;
      }
      const { mode } = resolved.service.get(resolved.agent);
      sendJson(res, 200, { ok: true, mode, plan: planState(ctx, resolved.agent.session) });
    },
  };
}

/**
 * Mount the host half: the two chip endpoints under the web server.
 *
 * @param ctx - host context.
 */
export function apply(ctx) {
  return diagnostics.guard('apply', () => {
    const bridge = createFairyModesBridge(ctx);
    ctx.inject(['webServer'], (ws) => ws.effect(() => {
      const unregisterSet = ws.webServer.register({ kind: 'exact', path: '/fairy-modes/set', handler: bridge.set });
      const unregisterState = ws.webServer.register({ kind: 'exact', path: '/fairy-modes/state', handler: bridge.state });
      return () => {
        unregisterSet?.();
        unregisterState?.();
      };
    }));
  }, { surface: 'host' });
}
