/**
 * Agent half of dsh-fairy-modes: the per-session Build&Work (PTC),
 * Memory&Dream (create), and Roleplay modes.
 *
 * A mode is logged collaboration state, not a process switch. The four modes are
 * also the stations of a pipeline (roleplay → explore → ptc → create → roleplay)
 * that `mode_pipeline` advances — see `./pipeline.js`. `set()` appends
 * the log-only `fairy/mode` event and moves two live effects for that session:
 * the `fairy:mode-ptc` / `fairy:mode-create` prompt section, and — for PTC —
 * the scoped `ctx.tools.presentAs('ptc')` declaration held as its own disposer.
 * Because the state lives in the session log, resume and fork restore it: `get()`
 * reconciles the live effects against the logged mode.
 *
 * The official plan mode (探索/极简) is orthogonal and stays in
 * `@deepseek-ai/dsh-plan-mode`; this package never reads or writes plan state
 * except through the `plan` projection the chip displays.
 *
 * The same `apply()` also registers `session_recall` (see `./recall.js`), the
 * session-history search tool create mode leans on: the distribution this
 * package targets ships no tool row over `ctx.sessionQuery`, so recall is ours.
 *
 * Ponytail ceilings:
 * - No mid-turn queueing: the event is appended immediately instead of waiting
 *   for the next accepted in-turn pre-step (plan-mode's pending-intent
 *   machinery), because a mode only changes the NEXT request assembly.
 *   Upgrade path: adopt the plan-mode pre-step hook if a mode change
 *   must be narrated inside the running turn.
 * - No narration message: the prompt section is the instruction; an injected
 *   user notice would repeat it every switch.
 *
 * @module dsh-fairy-modes
 */

import { createFairyDiagnostics } from 'dsh-fairy-contracts/diagnostics';
import {
  FAIRY_MODE_EVENT,
  FAIRY_MODE_PROJECTION,
  FAIRY_MODES,
  codePresentationMode,
  modeSectionOrder,
  normalizeFairyMode,
} from './contract.js';
import { createSessionRecallTool } from './recall.js';
import { PIPELINE_SECTION_TEXT, createModePipelineTool } from './pipeline.js';

const diagnostics = createFairyDiagnostics('dsh-fairy-modes');

/** Prompt sections, ordered one step after the official plan policy. */
const MODE_SECTIONS = {
  ptc: {
    name: 'fairy:mode-ptc',
    text: 'PTC 模式：用 run_code 编排脚本系列，一次调用完成多步执行；先规划命令序列再执行。',
  },
  roleplay: {
    name: 'fairy:mode-roleplay',
    text: '角色扮演模式：把绑定的角色人格当作第一人称身份，用户是对话者，不是任务委托者。'
      + '时机：只在被点名或话题明显指向角色时开口，其余情况沉默，不刷存在感；需要等待时不要产出占位回复。'
      + '回复：短句优先，一句一个意思；用口语和具体动作词（\'看看\'而不是\'进行查看\'）；允许省略、重复和语气词；说完就停，不总结、不升华、不追问。'
      + '去AI味硬约束：不用\'不是…而是…\'\'首先/其次/最后\'\'值得注意的是\'\'综上所述\'等套话；不写\'在这个快节奏的时代\'式开场；单段破折号不超过 2 个；不堆排比；不换词轮替同一个事物。'
      + '设定与记忆：角色设定、称呼、约定要跨会话保持；回顾过去互动用 memory_recall，本轮新出现的设定用 memory_remember 落盘后再据此回答。'
      + '一致性：不确定的设定不要编造；与角色设定冲突时以角色设定为准，并说明取舍。'
      + '自检：发出回复前用 roleplay_check 跑一遍去AI味检查（命中项要改完再发）；角色的语言习惯用 roleplay_style 读取或追加。',
  },
  create: {
    name: 'fairy:mode-create',
    text: '创造模式：先调用 session_recall 回忆本项目全部历史作为再回答；'
      + '技能制作：在被扫描的技能根写 SKILL.md；插件制作：运行 node fairy-system/scaffold-plugin.js；'
      + '每次交付前运行 node fairy-system/skill-audit.js 检查冗余并合并/删除。',
  },
};

/** Human-facing mode names for command results. */
const MODE_LABELS = { off: '默认（关闭）模式', ptc: 'PTC 建造模式', create: '创造模式', roleplay: '角色扮演模式' };

/**
 * Fold `fairy/mode` into the `{ mode }` projection. `wire` is what the browser
 * chip reads through `useProjection('fairyMode')`; the host bridge reads the
 * same value through the projection registry.
 */
export const fairyModeProjectionDefinition = {
  key: FAIRY_MODE_PROJECTION,
  stateVersion: 1,
  stateSchema: {
    parse(value) {
      const mode = value !== null && typeof value === 'object' ? normalizeFairyMode(value.mode) : undefined;
      if (mode === undefined) throw new Error('fairyMode projection state must be { mode: off|ptc|create|roleplay }');
      return { mode };
    },
  },
  init: () => ({ mode: 'off' }),
  apply: (state, event) => {
    if (event.type !== FAIRY_MODE_EVENT) return state;
    const mode = normalizeFairyMode(event.data?.mode);
    return mode === undefined || mode === state.mode ? state : { mode };
  },
  wire: {
    viewSchema: {
      parse(value) {
        const mode = value !== null && typeof value === 'object' ? normalizeFairyMode(value.mode) : undefined;
        if (mode === undefined) throw new Error('fairyMode wire payload must be { mode: off|ptc|create|roleplay }');
        return { mode };
      },
    },
    view: state => ({ mode: state.mode }),
  },
};

/**
 * `ctx.fairyMode`: owns one session's mode, its prompt section, and the scoped
 * PTC presentation. A preset mounts it inside an `isolate: { fairyMode: true }`
 * group, so each agent realm holds its own instance.
 */
export class FairyModeService {
  /** Live section/presentation disposers per Session, plus the applied mode. */
  #sessions = new WeakMap();

  /** @param ctx - the agent-scope context this instance was mounted into. */
  constructor(ctx) {
    this.ctx = ctx;
    ctx.sessionProjections.register(fairyModeProjectionDefinition);
    /* The command registry is host-plane and optional: a deployment composing
     * none simply never runs the child, and the HTTP bridge plus the chip stay
     * the only switches. */
    ctx.inject(['commands'], (commandCtx) => {
      commandCtx.effect(() => commandCtx.commands.register({
        definitionId: 'dsh-fairy-modes',
        name: 'mode',
        description: '切换会话模式：ptc（建造）| create（创造）| roleplay（角色扮演）| off（关闭）',
        input: { hint: 'ptc|create|roleplay|off' },
        handler: ({ agent, rawInput }) => this.command(agent, rawInput),
      }), 'dsh-fairy-modes: /mode command registration');
    });
  }

  /**
   * Read this session's mode and reconcile the live effects with it. Reconcile
   * is the resume/fork path: the log carries the mode while a fresh realm holds
   * no section or presentation yet.
   *
   * @param agent - the agent whose session is read.
   * @returns The logged mode.
   */
  get(agent) {
    const mode = this.loggedMode(agent.session);
    this.#apply(agent.session, mode);
    return { mode };
  }

  /**
   * Select this session's mode, appending the log event and moving its live effects.
   *
   * @param agent - the agent to switch.
   * @param value - `off`, `ptc`, or `create` (case and blanks tolerated).
   * @returns `committed` when the log changed, `noop` when it already matched.
   * @throws {Error} when the request names no known mode.
   */
  set(agent, value) {
    const mode = normalizeFairyMode(value);
    if (mode === undefined) {
      throw new Error(`未知的 Fairy 模式 ${JSON.stringify(value)}；可用值：${FAIRY_MODES.join(', ')}`);
    }
    const session = agent.session;
    if (this.loggedMode(session) === mode) {
      this.#apply(session, mode);
      return 'noop';
    }
    session.append(FAIRY_MODE_EVENT, { mode });
    this.#apply(session, mode);
    return 'committed';
  }

  /**
   * The `/mode` command body.
   *
   * @param agent - calling agent, absent outside a session.
   * @param rawInput - text after the command name.
   * @returns a command result: `success` with the new mode, or `error` with usage.
   */
  command(agent, rawInput) {
    if (agent === undefined) return { kind: 'error', text: '/mode 需要一个会话：当前调用没有 agent。' };
    const requested = String(rawInput ?? '').trim().toLowerCase();
    const mode = normalizeFairyMode(requested);
    if (mode === undefined) {
      return {
        kind: 'error',
        text: requested === ''
          ? '用法：/mode ptc|create|roleplay|off'
          : `未知模式 "${requested}"；可用：ptc、create、roleplay、off。`,
      };
    }
    const outcome = this.set(agent, mode);
    return {
      kind: 'success',
      text: outcome === 'noop' ? `当前已是${MODE_LABELS[mode]}。` : `已切换到${MODE_LABELS[mode]}。`,
    };
  }

  /**
   * The session's logged mode, read from the projection fold.
   *
   * @param session - the session to read.
   * @returns The logged mode, `off` before any event.
   */
  loggedMode(session) {
    const state = this.ctx.sessionProjections.stateOf(session, FAIRY_MODE_PROJECTION);
    return state?.mode ?? 'off';
  }

  /**
   * Make the live effects match `mode` for one session. Idempotent: a repeat of
   * the applied mode touches nothing, so `get()` is safe to call per request.
   */
  #apply(session, mode) {
    const live = this.#sessions.get(session);
    if (live !== undefined && live.mode === mode) return;
    live?.section?.();
    const section = MODE_SECTIONS[mode];
    const sectionDispose = section === undefined ? null : this.ctx.systemPrompt.section({
      name: section.name,
      // One step after the official plan policy (order 50 on 0.1.1, 500 on
      // 0.1.2+): mode guidance reads next to it, above tool guidance.
      order: modeSectionOrder(this.ctx.systemPrompt),
      text: section.text,
    });
    let presentation = live?.presentation ?? null;
    if (mode !== 'ptc') {
      presentation?.();
      presentation = null;
    } else if (presentation === null) {
      try {
        presentation = this.ctx.tools.presentAs(codePresentationMode(this.ctx.systemPrompt));
      } catch (error) {
        /* A scope that already declared a presentation (a preset row, or
         * another mode instance) owns it; the mode is still recorded, and the
         * mode's prompt section still tells the model to drive run_code. */
        diagnostics.warn('presentAs', { mode }, error);
        presentation = null;
      }
    }
    this.#sessions.set(session, { mode, section: sectionDispose, presentation });
  }
}

/**
 * Required services: the tool registry (PTC presentation), the prompt sections,
 * and the projection registry the mode is folded into.
 */
export const inject = ['tools', 'systemPrompt', 'sessionProjections'];

/**
 * Mount the agent half: publish `ctx.fairyMode` on the calling (agent) context,
 * and register the session-history recall tool the create mode is built on.
 *
 * @param ctx - the context this row is loaded into; the preset mounts it inside
 * an `isolate: { fairyMode: true }` group so the service stays per-session.
 */
export function apply(ctx) {
  return diagnostics.guard('apply', () => {
    /* `provide` ties the service to this fiber: unloading the row (or its realm)
     * unregisters it, and every disposal it owns unwinds with the same scope. */
    const service = new FairyModeService(ctx);
    ctx.provide('fairyMode', service);
    /* The pipeline section stays present in every mode: the request tool catalog
     * and the prompt shape must not change just because a stage advanced. */
    ctx.systemPrompt.section({
      name: 'fairy:pipeline',
      order: modeSectionOrder(ctx.systemPrompt) + 2,
      text: PIPELINE_SECTION_TEXT,
    });
    ctx.tools.register(createModePipelineTool({ service }));
    /* Recall is registered in every mode, not just create: the request tool
     * catalog must not change when the mode does. The child waits for the
     * session-query engine, so a deployment composing none simply has no tool. */
    ctx.inject(['sessionQuery'], (queryCtx) => {
      queryCtx.tools.register(createSessionRecallTool(queryCtx.sessionQuery));
    });
  }, { surface: 'agent' });
}
