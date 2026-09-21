const React = require('react');
const { jsx, jsxs } = require('react/jsx-runtime');
const { createAskKit } = require('../../../../fairy-contracts/client-ask-kit.cjs');
const uiPrimitives = require('@deepseek-ai/dsh-client-ui-primitives');
const { PALETTES, MASCOT_POSITIONS, MASCOT_POSITION_LABELS } = require('./constants.js');
const { SPEED_STOPS } = require('./settings-normalizer.cjs');
const { setControllerSetting, settingError } = require('./settings-write.js');

/** 归一化提问件：真源是 fairy-contracts/client-ask-kit.cjs，构建时内联。 */
const askKit = createAskKit({ React, jsx, jsxs, primitives: uiPrimitives });

const useController = (controller) => React.useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);

/** 设置卡拆成三张后各自负责的字段：视觉两组写回 `fairy-visual`，身份字段写回 `fairy-identity`。 */
const VISUAL_CARD_FIELDS = ['enabled', 'theme', 'powerMode', 'contentFade', 'palette'];
const MASCOT_CARD_FIELDS = ['mascotVisible', 'mascotPosition', 'mascotPositionMode', 'mascotScale', 'mascotAnimationSpeed'];
const IDENTITY_CARD_FIELDS = ['mode', 'customName', 'secondAssistant', 'household'];
const VISUAL_FIELDS = [...VISUAL_CARD_FIELDS, ...MASCOT_CARD_FIELDS];
const IDENTITY_TEXT_FIELDS = ['customName', 'secondAssistant'];
const IDENTITY_MODE_OPTIONS = [
  { value: 'ling', label: '铃' },
  { value: 'zhe', label: '哲' },
  { value: 'custom', label: '自定义' },
];
/** 眼睛大小的可选档位（存储仍是 0.55–1 连续值；卡片把任意存量值吸附到最近档）。 */
const MASCOT_SCALE_STOPS = Object.freeze([0.55, 0.7, 0.85, 1]);
const nearestScaleStop = (value) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 1;
  return MASCOT_SCALE_STOPS.reduce((best, stop) => (Math.abs(stop - numeric) < Math.abs(best - numeric) ? stop : best), MASCOT_SCALE_STOPS[0]);
};
const PALETTE_OPTIONS = [
  { value: 'hdd', label: '岩（默认）' },
  { value: 'ink', label: '墨' },
  { value: 'ember', label: '炭' },
];
const MASCOT_POSITION_OPTIONS = MASCOT_POSITIONS.map((anchor) => ({ value: anchor, label: MASCOT_POSITION_LABELS[anchor] }));
const MASCOT_POSITION_MODE_OPTIONS = [
  { value: 'static', label: '静态（固定锚点）' },
  { value: 'dynamic', label: '动态（空载居中 · 思考移到右中）' },
];
const MASCOT_SCALE_OPTIONS = MASCOT_SCALE_STOPS.map((stop) => ({ value: String(stop), label: `${Math.round(stop * 100)}%${stop === 1 ? '（默认）' : ''}` }));
const MASCOT_SPEED_OPTIONS = SPEED_STOPS.map((rate) => ({ value: String(rate), label: `${rate}×${rate === 1 ? '（默认）' : ''}` }));

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
  palette: PALETTES.includes(visual.palette) ? visual.palette : 'hdd',
  mascotPosition: MASCOT_POSITIONS.includes(visual.mascotPosition) ? visual.mascotPosition : 'center',
  mascotPositionMode: visual.mascotPositionMode === 'dynamic' ? 'dynamic' : 'static',
  mascotScale: nearestScaleStop(visual.mascotScale),
  mascotAnimationSpeed: SPEED_STOPS.includes(visual.mascotAnimationSpeed) ? visual.mascotAnimationSpeed : 1,
  mode: identity.mode || 'ling',
  customName: typeof identity.customName === 'string' ? identity.customName : '',
  secondAssistant: typeof identity.secondAssistant === 'string' ? identity.secondAssistant : '',
  household: Array.isArray(identity.household) ? identity.household.join('、') : '',
});

/** 草稿里相对当前值真改过的字段：只有这些会被写盘。`fields` 限定本卡负责的键。 */
function changedFields(draft, current, fields) {
  const wanted = (field) => !fields || fields.includes(field);
  const visual = VISUAL_FIELDS.filter((field) => wanted(field) && draft[field] !== undefined && draft[field] !== current[field]).map((field) => [field, draft[field]]);
  const identity = [];
  if (wanted('mode') && draft.mode !== undefined && draft.mode !== current.mode) identity.push(['mode', draft.mode]);
  for (const field of IDENTITY_TEXT_FIELDS) {
    if (wanted(field) && draft[field] !== undefined && draft[field] !== current[field]) identity.push([field, draft[field]]);
  }
  if (wanted('household') && draft.household !== undefined && !sameHousehold(parseHousehold(draft.household), parseHousehold(current.household))) {
    identity.push(['household', parseHousehold(draft.household)]);
  }
  return { visual, identity };
}

/** 写盘失败先留诊断再抛出，交给提问件把原因写进状态行。 */
const writeSetting = (scope, field, value) => setControllerSetting(scope, field, value).catch((error) => {
  settingError(field, error);
  throw error;
});

/** 主机身份设置桥的缓存订阅：三张设置卡共用同一套读法。 */
function useIdentityBridge(identitySettings) {
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
  return { identityValue, readIdentity };
}

/** 三张设置卡共用一套表单机：读全量形状，保存时只写本卡字段组里真改过的键。 */
function useCardForm({ controller, identitySettings, fields }) {
  const { useAskForm } = askKit;
  const state = useController(controller);
  const { identityValue, readIdentity } = useIdentityBridge(identitySettings);
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
      const { visual, identity } = changedFields(draft, readCurrent(), fields);
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
    const { visual, identity } = changedFields(form.draft, readCurrent(), fields);
    if (form.busy === null && (visual.length || identity.length)) submit();
  };
  return { form, value, writable, submit, flush };
}

/** 「HDD 视觉」卡：整套界面皮肤的开关与呈现（启用/日间/低功耗/内容遮罩/调色盘）。 */
function VisualSection({ controller, identitySettings }) {
  // 组件作用域里的绑定：即便将来有别的机制往这个 bundle 里再塞一份套件，
  // 也不会在工厂顶层撞名。
  const { ASK_TEXT, AskSection, AskRow, AskSelect, AskToggle, AskActions } = askKit;
  const { form, value, writable, submit } = useCardForm({ controller, identitySettings, fields: VISUAL_CARD_FIELDS });
  return jsxs(AskSection, {
    title: 'HDD 视觉',
    description: ['HDD 视觉是整套界面皮肤。大眼睛的站位、大小与动画速度在「大眼睛主视觉」卡。'],
    children: [
      jsx(AskToggle, { id: 'dsh-fairy-visual-enabled', label: '启用 HDD 视觉', checked: value('enabled'), disabled: !writable, onChange: (next) => form.change('enabled', next) }, 'enabled'),
      jsx(AskToggle, { id: 'dsh-fairy-visual-theme', label: 'HDD 日间模式', checked: value('theme') === 'light', disabled: !writable, onChange: (next) => form.change('theme', next ? 'light' : 'dark') }, 'theme'),
      jsx(AskToggle, { id: 'dsh-fairy-visual-power', label: '低功耗模式', checked: value('powerMode') === 'low-power', disabled: !writable, onChange: (next) => form.change('powerMode', next ? 'low-power' : 'normal') }, 'power'),
      jsx(AskToggle, { id: 'dsh-fairy-visual-content-fade', label: '内容遮罩', hint: '开启时主视觉会遮住其下的正文（生成期间新文字会变淡）；关闭后正文始终可读。', checked: value('contentFade'), disabled: !writable, onChange: (next) => form.change('contentFade', next) }, 'contentFade'),
      jsx(AskRow, { id: 'dsh-fairy-visual-palette', label: '皮肤（调色盘）：', hint: '岩=现值默认；墨=冷灰蓝；炭=暖炭。', children: jsx(AskSelect, { id: 'dsh-fairy-visual-palette', value: value('palette'), options: PALETTE_OPTIONS, disabled: !writable, onChange: (next) => form.change('palette', next) }) }, 'palette'),
      jsx(AskActions, { busy: form.busy, status: writable ? form.status : ASK_TEXT.readOnly, primary: ASK_TEXT.save, onPrimary: submit, writable }, 'actions'),
    ],
  });
}

/** 「大眼睛主视觉」卡：Fairy 大眼睛的显示、站位、大小与动画速度。 */
function MascotSection({ controller, identitySettings }) {
  const { ASK_TEXT, AskSection, AskRow, AskSelect, AskToggle, AskActions } = askKit;
  const { form, value, writable, submit } = useCardForm({ controller, identitySettings, fields: MASCOT_CARD_FIELDS });
  return jsxs(AskSection, {
    title: '大眼睛主视觉',
    description: ['Fairy 的大眼睛主视觉。启用 HDD 视觉与皮肤调色在「HDD 视觉」卡。'],
    children: [
      jsx(AskToggle, { id: 'dsh-fairy-visual-mascot', label: '显示 Fairy 主视觉', checked: value('mascotVisible'), disabled: !writable, onChange: (next) => form.change('mascotVisible', next) }, 'mascot'),
      jsx(AskRow, { id: 'dsh-fairy-mascot-position', label: '大眼睛位置：', children: jsx(AskSelect, { id: 'dsh-fairy-mascot-position', value: value('mascotPosition'), options: MASCOT_POSITION_OPTIONS, disabled: !writable, onChange: (next) => form.change('mascotPosition', next) }) }, 'mascotPosition'),
      jsx(AskRow, { id: 'dsh-fairy-mascot-position-mode', label: '大眼站位模式：', hint: '动态=空载居中，思考时移到右中；静态=始终用上方固定位置。', children: jsx(AskSelect, { id: 'dsh-fairy-mascot-position-mode', value: value('mascotPositionMode'), options: MASCOT_POSITION_MODE_OPTIONS, disabled: !writable, onChange: (next) => form.change('mascotPositionMode', next) }) }, 'mascotPositionMode'),
      jsx(AskRow, { id: 'dsh-fairy-mascot-scale', label: '大眼睛大小：', children: jsx(AskSelect, { id: 'dsh-fairy-mascot-scale', value: String(value('mascotScale')), options: MASCOT_SCALE_OPTIONS, disabled: !writable, onChange: (next) => form.change('mascotScale', Number(next)) }) }, 'mascotScale'),
      jsx(AskRow, { id: 'dsh-fairy-mascot-speed', label: '大眼睛动画速度：', children: jsx(AskSelect, { id: 'dsh-fairy-mascot-speed', value: String(value('mascotAnimationSpeed')), options: MASCOT_SPEED_OPTIONS, disabled: !writable, onChange: (next) => form.change('mascotAnimationSpeed', Number(next)) }) }, 'mascotAnimationSpeed'),
      jsx(AskActions, { busy: form.busy, status: writable ? form.status : ASK_TEXT.readOnly, primary: ASK_TEXT.save, onPrimary: submit, writable }, 'actions'),
    ],
  });
}

/** 「Fairy 身份」卡：Fairy 如何识别主人（称呼模式 + 自定义身份信息），写 `fairy-identity` 命名空间。 */
function IdentitySection({ controller, identitySettings }) {
  const { ASK_TEXT, AskSection, AskRow, AskText, AskSelect, AskActions } = askKit;
  const { form, value, writable, submit, flush } = useCardForm({ controller, identitySettings, fields: IDENTITY_CARD_FIELDS });
  const customMode = value('mode') === 'custom';
  return jsxs(AskSection, {
    title: 'Fairy 身份',
    description: ['Fairy 如何识别你。选「自定义」后可写自定义称呼、第二助手与家庭成员。'],
    children: [
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

module.exports = { VisualSection, MascotSection, IdentitySection };