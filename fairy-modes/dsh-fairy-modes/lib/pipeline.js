/**
 * 模式流水线：把「扮演 → 探查 → 建造 → 创造 → 回到扮演」这条调度链做成一个
 * 模型可调用的工具，并给出一段始终在场的说明段落。
 *
 * 为什么是工具而不是自动切换：阶段推进的判据是「任务是否真的需要动手」，
 * 只有模型和用户知道；把推进权交给 `mode_pipeline` 让每一步都可解释、可回退，
 * 也避免了按事件硬猜（例如看到 run_code 就跳阶段）。真正确定性的部分——阶段
 * 对应哪个模式、下一阶段是谁——放在 `./contract.js` 里，纯函数、可单测。
 *
 * @module dsh-fairy-modes/pipeline
 */
import {
  FAIRY_PIPELINE_STAGES,
  PIPELINE_STAGE_LABELS,
  PIPELINE_STAGE_STATE,
  nextPipelineStage,
  pipelineStageOf,
} from './contract.js';

const TOOL_TIMEOUT_MS = 10_000;

/** 始终在场的流水线说明：每个阶段做什么、什么时候推进。 */
export const PIPELINE_SECTION_TEXT = [
  '模式流水线（会话调度）：默认是空闲（off，未进流水线）——用户只是在闲聊或调戏角色时，',
  '先 enter stage="roleplay" 进入扮演；出现需要真正动手的任务时再按顺序推进，每一步只做本阶段该做的事，不要在阶段之间来回跳。',
  '1. 扮演 → 探查：调用 mode_pipeline advance。探查阶段只读不写：看代码、查记忆、',
  '   写出方案与风险，等用户确认；建议同时用 /plan 打开官方 plan 模式的审批闸门。',
  '2. 探查 → 建造：方案确认后 advance（若官方 plan 模式还开着，先 exit_plan_mode 提交审批，批准后回到这里 advance）。用 run_code 把实施编成脚本系列，一次调用完成多步。',
  '3. 建造 → 创造：做完 advance。先 session_recall 回忆本项目全部历史，再写或改 skill 与插件，',
  '   最后跑 node fairy-system/skill-audit.js 检查冗余，并按结论合并或删除冗余条目。',
  '4. 创造 → 扮演：收尾后 advance 回到扮演，把结论压成角色会说的话。',
  '用户直接指定阶段时以用户为准；用户只关心聊天时停在扮演，不要主动进入后面的阶段。',
].join('\n');

/**
 * `mode_pipeline`：读取或推进会话所处的流水线阶段。
 *
 * @param options.service - `ctx.fairyMode`（会话模式服务）。
 * @param options.readPlan - 读官方 `plan` 投影；默认走会话投影注册表，未组合 plan-mode 时返回 null。
 * @returns 原始 `ToolDefinition`（`ctx.tools.register()` 直接可用）。
 */
export function createModePipelineTool({ service, readPlan, resolvePlanMode } = {}) {
  /**
   * 官方 plan 控制器：由 agent-presets 按名解析（与桥面取 fairyMode 同一手法）。
   * 取不到就退回“让用户 /plan”，流水线其余部分不受影响。
   */
  // ponytail: 按名探测 plan 控制器（与桥面同一手法），拿不到就退回提示用户 /plan；
  // 升级路径：harness 给出跨 realm 的正式入口后改为显式依赖。
  const planController = (agent) => {
    if (typeof resolvePlanMode !== 'function') return undefined;
    try {
      const controller = resolvePlanMode(agent);
      return typeof controller?.set === 'function' ? controller : undefined;
    } catch {
      return undefined;
    }
  };
  const planState = (session) => {
    if (typeof readPlan === 'function') return readPlan(session);
    try {
      return service?.ctx?.sessionProjections?.stateOf(session, 'plan') ?? null;
    } catch {
      /* plan-mode 没被组合：流水线在探查阶段仍然可用，只是没有官方审批闸门。 */
      return null;
    }
  };
  const currentStage = (session) => pipelineStageOf({
    planActive: planState(session)?.active === true,
    mode: service.loggedMode(session),
  });
  const applyStage = (agent, stage) => {
    const target = PIPELINE_STAGE_STATE[stage];
    const planActive = planState(agent.session)?.active === true;
    // 闸门还没过就不切站：官方 plan 模式仍在时，保持只读的探查站，等
    // exit_plan_mode 批准之后由下一次 advance 正常切换。否则模式已切成目标站、
    // 附注却让人「批准后再 advance」，会把模型从建造推成创造。
    if (!target.plan && planActive) {
      return { outcome: 'blocked', notes: ['plan 模式还开着：方案定稿后用官方 exit_plan_mode 提交审批；批准后重新发起这次调用即可切换（本工具不会替你跳站）。'] };
    }
    const outcome = service.set(agent, target.mode);
    const notes = [];
    if (target.plan && !planActive) {
      const controller = planController(agent);
      if (controller !== undefined) {
        try {
          const planOutcome = controller.set(agent, true);
          if (planOutcome !== 'committed') {
            notes.push('官方 plan 模式已排队开启，从下一步开始生效（审批闸门随之可用）。');
          }
        } catch (error) {
          notes.push(`自动开启官方 plan 模式失败（${String(error?.message ?? error)}）：让用户在输入框输入 /plan 手动打开。`);
        }
      } else {
        notes.push('探查阶段的审批闸门来自官方 plan 模式，本次没能自动开启：让用户在输入框输入 /plan（或点会话头 chip 的「探查·极简」）即可打开。');
      }
    }
    return { outcome, notes };
  };
  const describe = (agent, stage, action, { notes = [], advanced = false } = {}) => {
    const session = agent.session;
    const mode = service.loggedMode(session);
    const planActive = planState(session)?.active === true;
    const lines = [
      `阶段：${PIPELINE_STAGE_LABELS[stage] ?? stage}（fairyMode=${mode}，plan=${planActive ? '开' : '关'}）。`,
      `下一步：${PIPELINE_STAGE_LABELS[nextPipelineStage(stage)] ?? nextPipelineStage(stage)}（用 mode_pipeline advance 推进）。`,
    ];
    return { action, stage, mode, planActive, advanced, report: [...lines, ...notes].join('\n') };
  };
  return {
    name: 'mode_pipeline',
    description: 'Read or advance the session mode pipeline: roleplay → explore → ptc → create → roleplay. '
      + 'action=status reports the current stage; action=advance moves one stage forward; '
      + 'action=enter takes an explicit stage; action=finish returns to roleplay. '
      + 'Use it when the conversation turns from roleplay into real work (or back), not for every message.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'status | advance | enter | finish。' },
        stage: { type: 'string', description: `enter 时的目标阶段：${FAIRY_PIPELINE_STAGES.join(' | ')}。` },
      },
      required: ['action'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string' },
          stage: { type: 'string' },
          mode: { type: 'string' },
          planActive: { type: 'boolean' },
          advanced: { type: 'boolean' },
          report: { type: 'string' },
        },
        required: ['stage', 'report'],
      },
      render: (_args, value) => [{ type: 'text', text: value.report }],
    },
    timeoutMs: TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const agent = exec?.agent;
      if (agent === undefined) {
        const error = new Error('mode_pipeline requires a calling agent (no session to switch)');
        error.code = 'INVALID_ARGS';
        throw error;
      }
      const action = typeof args?.action === 'string' ? args.action.trim().toLowerCase() : '';
      const stage = currentStage(agent.session);
      if (action === 'status') return describe(agent, stage, 'status');
      // 切站成功按目标站回报（投影要到下一次 pre-step 才追上，回读会得到上一阶段）；
      // 被闸门挡住则按当前站回报，否则报告头会把没发生的事写成既成事实。
      const rendered = (outcome, target) => (outcome === 'blocked' ? stage : target);
      const advanced = (outcome) => outcome === 'committed' || outcome === 'queued';
      if (action === 'advance') {
        const target = nextPipelineStage(stage);
        const { outcome, notes } = applyStage(agent, target);
        return describe(agent, rendered(outcome, target), 'advance', { notes, advanced: advanced(outcome) });
      }
      if (action === 'finish') {
        const { outcome, notes } = applyStage(agent, 'roleplay');
        return describe(agent, rendered(outcome, 'roleplay'), 'finish', { notes, advanced: advanced(outcome) });
      }
      if (action === 'enter') {
        const wanted = typeof args?.stage === 'string' ? args.stage.trim().toLowerCase() : '';
        if (!FAIRY_PIPELINE_STAGES.includes(wanted)) {
          const error = new Error(`mode_pipeline stage must be one of ${FAIRY_PIPELINE_STAGES.join(', ')}`);
          error.code = 'INVALID_ARGS';
          throw error;
        }
        const { outcome, notes } = applyStage(agent, wanted);
        return describe(agent, rendered(outcome, wanted), 'enter', { notes, advanced: advanced(outcome) });
      }
      const error = new Error("mode_pipeline action must be 'status', 'advance', 'enter' or 'finish'");
      error.code = 'INVALID_ARGS';
      throw error;
    },
  };
}
