const {
  OFFICIAL_ATTRIBUTES,
  composerInputDock,
  inputScroll,
  sendButton,
  contextControl,
  voiceControl,
  commandControl,
  accessControl,
  modelControl,
  planChip,
  reasoningControl,
  modelAndReasoningShareNode,
  workspaceControl,
} = require('./dom-adapter.js');
const { attachmentSlot, attachmentRail } = require('./composer-attachments.js');

const COMPOSER_ATTR = 'data-dsh-fairy-composer-dock';
const MARKER_ATTRS = [
  COMPOSER_ATTR,
  'data-dsh-fairy-composer-row',
  'data-dsh-fairy-composer-tools',
  'data-dsh-fairy-composer-trailing',
  'data-dsh-fairy-composer-accessory',
  'data-dsh-fairy-composer-attachments',
  'data-dsh-fairy-composer-attachments-active',
  'data-dsh-fairy-composer-bar-root',
  'data-dsh-fairy-composer-bar-host',
  'data-dsh-fairy-composer-stack',
  'data-dsh-fairy-composer-workspace',
  'data-dsh-fairy-composer-chrome',
  'data-dsh-fairy-composer-send-control',
  'data-dsh-fairy-composer-context-control',
  'data-dsh-fairy-composer-output-control',
  'data-dsh-fairy-composer-voice-control',
  'data-dsh-fairy-composer-model-control',
  'data-dsh-fairy-composer-native-model-control',
  'data-dsh-fairy-composer-reasoning-control',
  'data-dsh-fairy-composer-command-control',
  'data-dsh-fairy-composer-access-control',
  'data-dsh-fairy-composer-workspace-control',
  'data-dsh-fairy-composer-mode-control',
];

function clearMarker(node, name) {
  if (node?.isConnected) node.removeAttribute(name);
}

// Projects semantic ownership onto the official composer nodes. It never
// creates a second interactive control or changes the runtime's event flow.
function markControls(card) {
  if (!card) return () => {};
  const owned = [];
  const mark = (node, name) => {
    if (!node) return;
    node.setAttribute(name, 'true');
    owned.push([node, name]);
  };
  const scroll = inputScroll(card);
  const send = sendButton(card);
  const row = [...card.children].find((node) => node !== scroll && node.contains?.(send));
  const tools = row?.children?.[0] || null;
  const trailing = row?.children?.[1] || null;
  mark(row, 'data-dsh-fairy-composer-row');
  mark(tools, 'data-dsh-fairy-composer-tools');
  mark(trailing, 'data-dsh-fairy-composer-trailing');
  const attachments = attachmentSlot(card);
  mark(attachments, 'data-dsh-fairy-composer-attachments');
  if (attachmentRail(attachments)) mark(card, 'data-dsh-fairy-composer-attachments-active');
  [...card.children]
    .filter((node) => node !== scroll && node !== row && node !== attachments)
    .forEach((node) => mark(node, 'data-dsh-fairy-composer-accessory'));

  const contextTarget = contextControl(card);
  if (send && trailing) {
    [...trailing.children].forEach((node) => {
      if (contextTarget && node.contains?.(contextTarget)) return;
      mark(node, node.contains?.(send) ? 'data-dsh-fairy-composer-send-control' : 'data-dsh-fairy-composer-output-control');
    });
  } else if (send) {
    mark(send, 'data-dsh-fairy-composer-send-control');
  }
  if (contextTarget) {
    let contextOwner = contextTarget.parentElement;
    while (contextOwner && contextOwner !== trailing && getComputedStyle(contextOwner).display === 'contents') contextOwner = contextOwner.parentElement;
    mark(contextOwner || contextTarget, 'data-dsh-fairy-composer-context-control');
  }
  const voiceTarget = voiceControl(tools);
  if (voiceTarget && tools) mark(voiceTarget, 'data-dsh-fairy-composer-voice-control');
  mark(commandControl(tools), 'data-dsh-fairy-composer-command-control');

  const accessTarget = accessControl(tools);
  let accessOwner = accessTarget;
  while (accessOwner?.parentElement && accessOwner.parentElement !== tools) accessOwner = accessOwner.parentElement;
  mark(accessOwner, 'data-dsh-fairy-composer-access-control');

  const modelTarget = modelControl(card);
  const mergedModelReasoning = modelAndReasoningShareNode(card);
  if (modelTarget && trailing && !mergedModelReasoning) {
    let modelOwner = modelTarget.parentElement;
    let modelShell = null;
    while (modelOwner && modelOwner !== trailing) {
      if (!modelShell && getComputedStyle(modelOwner).display !== 'contents') modelShell = modelOwner;
      modelOwner = modelOwner.parentElement;
    }
    if (modelShell) {
      mark(modelShell, 'data-dsh-fairy-composer-model-control');
      mark(modelShell, 'data-dsh-fairy-composer-native-model-control');
    }
  }

  const reasoningTarget = reasoningControl(card);
  if (reasoningTarget) {
    let reasoningOwner = reasoningTarget.parentElement;
    while (reasoningOwner && reasoningOwner !== card && getComputedStyle(reasoningOwner).display === 'contents') reasoningOwner = reasoningOwner.parentElement;
    if (reasoningOwner && reasoningOwner !== card) mark(reasoningOwner, 'data-dsh-fairy-composer-reasoning-control');
  }

  const barRoot = card.parentElement;
  mark(barRoot, 'data-dsh-fairy-composer-bar-root');
  const seat = card.closest('[' + OFFICIAL_ATTRIBUTES.composerSeat + ']');
  // 计划模式标识（官方 dsh-client-ui-plan 的 Plan chip）：默认走 state-warn 主题（白底橙字），
  // 在 HDD 深色里与其它芯片风格不一致；出现时才调整（OPTIONAL 能力）。
  const planTarget = planChip(seat) || planChip(card);
  if (planTarget) mark(planTarget, 'data-dsh-fairy-composer-plan-control');
  const workspaceButton = workspaceControl(seat);
  let stack = barRoot?.parentElement || null;
  while (stack && stack !== seat && !(stack.children.length > 1 && (!workspaceButton || stack.contains(workspaceButton)))) stack = stack.parentElement;
  if (stack && stack !== seat) {
    mark(stack, 'data-dsh-fairy-composer-stack');
    let barHost = barRoot;
    while (barHost.parentElement && barHost.parentElement !== stack) barHost = barHost.parentElement;
    mark(barHost, 'data-dsh-fairy-composer-bar-host');
    let workspaceRow = workspaceButton;
    while (workspaceRow?.parentElement && workspaceRow.parentElement !== stack) workspaceRow = workspaceRow.parentElement;
    // The chrome pass hides the official composer skin Fairy replaces. The
    // input dock is not chrome: the todo and queue strips live there, so
    // hiding it (display:none) removes them from the seat entirely.
    [...stack.children].filter((node) => node !== barHost && node !== workspaceRow && !node.matches?.(composerInputDock)).forEach((node) => mark(node, 'data-dsh-fairy-composer-chrome'));
    mark(workspaceRow, 'data-dsh-fairy-composer-workspace');
    mark(workspaceButton, 'data-dsh-fairy-composer-workspace-control');
    const modeButton = workspaceRow
      ? [...workspaceRow.querySelectorAll('button')].find((button) => button !== workspaceButton)
      : null;
    let modeOwner = modeButton;
    let modeAncestor = modeButton?.parentElement;
    while (modeAncestor && modeAncestor !== workspaceRow) {
      if (getComputedStyle(modeAncestor).display !== 'contents') modeOwner = modeAncestor;
      modeAncestor = modeAncestor.parentElement;
    }
    mark(modeOwner, 'data-dsh-fairy-composer-mode-control');
  }
  return () => owned.forEach(([node, name]) => clearMarker(node, name));
}

module.exports = { COMPOSER_ATTR, MARKER_ATTRS, clearMarker, markControls };
