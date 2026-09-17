# Fairy DSH

DSH（DeepSeek Harness）插件集合：把人格、语音、模式流水线、搜索枢纽、长期记忆、角色扮演、视觉舞台、浏览器 Dock 等能力做成可独立安装的包，并随仓库提供 `fairy-full` / `fairy-lite` 两个 agent 预设。

## 包一览

| 包 | 作用 |
| --- | --- |
| `fairy-persona/` | 人格包引擎：人格文档 + 调色属性 + 语音绑定热切换 |
| `fairy-modes/` | 模式引擎与四站流水线（扮演 → 探查 → 建造 → 创造） |
| `fairy-roleplay/` | 角色扮演：去 AI 味检查器 + 风格库 |
| `fairy-voice/` | TTS / STT provider 注册表 |
| `fairy-search/` | 搜索枢纽：deepseek / exa / perplexity / 自定义路由 |
| `fairy-memory/` | 长期记忆：GBrain 主用，mem0 / HTTP / 本地 Markdown 备选 |
| `fairy-visual/` | 视觉舞台：HDD 视觉、Fairy 主视觉、皮肤与创作工坊入口 |
| `fairy-eval/` | TypeSafe 结构化文本评估（Noul / Choice / Score） |
| `browser-dock/` | 浏览器 Dock（宿主插件 + 独立代理进程） |
| `balance-meter/` | 余额指示 |
| `fairy-startup/` | 启动动作（恢复会话选择、按工作区就绪开新会话） |
| `fairy-contracts/` | 跨插件契约与诊断边界 |

## 安装

```sh
git clone https://github.com/addsas222/Fairy-DSH-Exp.git fairy-dsh && cd fairy-dsh
./scripts/deploy-live.sh --home "$HOME/.dsh"
```

Windows 上以 `sh scripts/deploy-live.sh …` 运行；原地开发回路（不落 live 布局）见 `scripts/test-isolated.sh`。

## 文档

- 部署、验证、排障与硬约束：`AGENTS.md`
- 各包用法：包内 `README.md`

## 许可

原创代码与文档按 Apache License 2.0 发布（见 `LICENSE` 与 `NOTICE`）；第三方依赖、致谢与版权边界见 `THIRD_PARTY_NOTICES.md`。
