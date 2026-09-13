# dsh-fairy-search

Fairy 的搜索引擎中枢与设置面板。双面插件：

- **宿主**（`lib/index.js`）向 `ctx.web` 注册一个元搜索提供方 `fairy-search-hub`，每次请求按当前设置路由到所选引擎，并暴露两个控制端点。
- **客户端**（`lib/client.js`）在「设置 → 搜索引擎」卡片里选择引擎、填写密钥、一键测试，并说明 MCP 服务器的接入方式。

模型侧仍然使用官方 `web_search` 工具与其结果卡片，本插件不重建结果展示，也不注册任何会话头部条目。

## 引擎路由

| 设置值 | 引擎 | 传输 | 可用条件 |
| --- | --- | --- | --- |
| `deepseek-official` | 官方 DeepSeek（服务端 `web_search` 工具） | `POST https://api.deepseek.com/anthropic/v1/messages`，模型 `deepseek-v4-flash` | 环境变量 `DEEPSEEK_API_KEY` 或设置中的 `deepseek.apiKey` |
| `exa` | Exa | `POST https://api.exa.ai/search` | `exa.apiKey` |
| `perplexity` | Perplexity（`sonar`） | `POST https://api.perplexity.ai/chat/completions` | `perplexity.apiKey` |
| `custom` | 自定义 OpenAI 兼容服务 | `POST {custom.baseURL}/chat/completions`，模型 `gpt-4o-mini`，纯提示词检索 | `custom.baseURL` 是合法的 http(s) 地址（本地服务可无密钥） |

前三者直接复用官方实现 `@deepseek-ai/dsh-web-search-deepseek` / `-exa` / `-perplexity`（线上格式与 `WEB_*` 错误码与独立插件完全一致）；只有 `custom` 由本包实现，答案里的 Markdown 链接与裸 URL 会被提取为来源。

`custom` 的边界（刻意保留）：只走 OpenAI 形态的纯提示词请求，不发 `tools`、模型固定 —— 任意网关不一定实现 `web_search`，按网关定制请求模板是升级路径。

## 设置（命名空间 `fairy-search`）

```json
{
  "version": 1,
  "provider": "deepseek-official",
  "deepseek": { "apiKey": "" },
  "exa": { "apiKey": "" },
  "perplexity": { "apiKey": "" },
  "custom": { "baseURL": "https://your-gateway.example.com/v1", "apiKey": "" }
}
```

- `provider` 取 `deepseek-official` / `exa` / `perplexity` / `custom`，非法值回退到 `deepseek-official`。
- 四个密钥字段都是 `role('secret')`：任何读取面（含浏览器镜像）都不会回显，卡片只写不读，状态用下面的布尔端点表示。
- `deepseek.apiKey` 是可选覆盖；留空时读 `DEEPSEEK_API_KEY` 环境变量。
- 修改对**下一次**搜索生效，无需重启。

## HTTP 端点

| 方法 | 路径 | 请求 | 响应 |
| --- | --- | --- | --- |
| `POST` | `/fairy-search/test` | `{ provider? }`（省略则用当前设置） | `{ ok: true, latencyMs, sources: [{ title, url }] }` 或 `{ ok: false, error }` |
| `GET` | `/fairy-search/state` | — | `{ provider, configured: { deepseek, exa, perplexity, custom } }` |

- 测试用固定查询 `DeepSeek`，宿主侧 15 秒超时（超时映射为「搜索请求超时（15 秒）。」）；请求格式错误或未知引擎返回 HTTP 400，引擎自身失败返回 HTTP 200 + `ok:false`，便于卡片内联展示。
- `state` 只返回布尔值，永不返回密钥；失败信息与诊断日志都会把已配置的密钥替换为 `[redacted]`。

## 客户端槽位

| 槽位 | id | order | 内容 |
| --- | --- | --- | --- |
| `settings.section` | `fairy-search` | 28 | 引擎下拉、各引擎状态点、密钥/地址输入、保存、测试、MCP 接入说明（`<details>`） |

## MCP 服务器接入

MCP 服务器是 loader 级插件条目，不在本卡片内添加；写进 profile 的 `cordis.patch.yml` 顶层数组后重启即可：

```yaml
- insert:
    - id: mcp-context7
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: context7
        transport: stdio
        command: npx
        args: ['-y', '@upstash/context7-mcp']

    - id: mcp-tavily
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: tavily
        transport: stdio
        command: npx
        args: ['-y', 'tavily-mcp']
        env:
          TAVILY_API_KEY: 'tvly-...'
```

搜索引擎与 MCP 是两层：搜索引擎提供官方 `web_search` 工具，MCP 服务器提供额外检索工具，两者互不影响。

## profile 集成提示

本插件注册的提供方 id 是 `fairy-search-hub`。若 profile 里同时还有其它可用（`available()`）的搜索提供方，`ctx.web` 会以 `WEB_PROVIDER_AMBIGUOUS` 拒绝自动选择 —— 需要在 web 服务的配置中固定 `searchProvider: fairy-search-hub`。

## 开发

```bash
pnpm install --ignore-scripts
pnpm test
```
