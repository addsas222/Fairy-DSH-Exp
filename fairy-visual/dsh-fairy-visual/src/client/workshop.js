const React = require('react');
const { jsx, jsxs } = require('react/jsx-runtime');
const { createAskKit } = require('../../../../fairy-contracts/client-ask-kit.cjs');
const uiPrimitives = require('@deepseek-ai/dsh-client-ui-primitives');

/** 创作工坊：设计 DSH UI 的工作台入口；状态来自宿主只读端点 /fairy-visual/workshop。 */
const WORKSHOP_BRIEF = [
  '用「创作工坊」流程设计 DSH UI：',
  '1) 先读现有实现与设计约束（fairy-visual 的样式令牌与控件族）；',
  '2) 用 pen.dev（.pen 设计稿）、花叔Design（HTML 高保真原型）与 OpenDesign 各出一个方向；',
  '3) 三个方向给我选，选定后落成 fairy-visual 改动并在本实例验证。',
].join('\n');

const askKit = createAskKit({ React, jsx, jsxs, primitives: uiPrimitives });

/** MCP 行的四种状态由宿主算：没接 / 接了但写下的路径已失效（换盘、重装）/ 正常 / 未知。 */
function describeMcp(mcp) {
  if (!mcp?.wired) return { ok: false, text: 'MCP：未接入——重跑一键安装器即会自动补上（scripts/install.mjs）' };
  if (mcp.installed === false) {
    return { ok: false, text: `MCP：已接入但记录的路径已失效——重跑一键安装器重新指向当前安装（${mcp.recorded?.split('\\').pop() ?? '旧路径'}）` };
  }
  if (mcp.installed === true) return { ok: true, text: 'MCP：已接入 web profile（用前：Pen 在运行且打开着 .pen）' };
  return { ok: true, text: 'MCP：已接入 web profile（路径未记录，无法核对是否失效）' };
}

function Workshop() {
  const { ASK_TEXT, AskSection, AskResult, AskActions } = askKit;
  const [status, setStatus] = React.useState(null);
  const [copyStatus, setCopyStatus] = React.useState('');
  React.useEffect(() => {
    let cancelled = false;
    fetch('/fairy-visual/workshop', { headers: { Accept: 'application/json' } })
      .then((response) => response.json())
      .then((value) => { if (!cancelled) setStatus(value); })
      .catch((error) => { if (!cancelled) setStatus({ ok: false, error: String(error?.message || error) }); });
    return () => { cancelled = true; };
  }, []);
  const copyBrief = () => {
    const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : null;
    if (!clipboard?.writeText) {
      setCopyStatus('复制失败：当前浏览器未放行剪贴板。');
      return;
    }
    clipboard.writeText(WORKSHOP_BRIEF).then(
      () => setCopyStatus('设计指令已复制——粘进会话即可开工。'),
      (error) => setCopyStatus(`复制失败：${error?.message || error}`),
    );
  };
  const rows = [];
  if (status === null) {
    rows.push(jsx(AskResult, { ok: true, text: ASK_TEXT.loading }, 'workshop-loading'));
  } else if (status.ok === false) {
    rows.push(jsx(AskResult, { ok: false, text: `读取失败：${status.error || '未知错误'}` }, 'workshop-error'));
  } else {
    const skills = Array.isArray(status.skills) ? status.skills : [];
    const penInstalled = Boolean(status.pen?.installed);
    rows.push(jsx(AskResult, { ok: penInstalled, text: penInstalled ? `pen.dev：已安装（${status.pen.path}）` : 'pen.dev：未安装——先到 pen.dev 官网安装' }, 'workshop-pen'));
    const mcp = describeMcp(status.mcp);
    rows.push(jsx(AskResult, { ok: mcp.ok, text: mcp.text }, 'workshop-mcp'));
    rows.push(jsx(AskResult, { ok: skills.includes('huashu-design'), text: `设计技能：${skills.length ? skills.join('、') : '技能槽位为空'}` }, 'workshop-skills'));
  }
  return jsxs(AskSection, {
    title: '创作工坊',
    description: ['用 OpenDesign、花叔Design 与 pen.dev 设计 DSH UI；设计会话由 Fairy 本体驱动，MCP 只是笔刷。'],
    children: [
      ...rows,
      jsx(AskActions, { busy: null, status: copyStatus, primary: '复制设计指令', onPrimary: copyBrief, writable: true }, 'workshop-actions'),
    ],
  });
}

module.exports = { Workshop, WORKSHOP_BRIEF };
