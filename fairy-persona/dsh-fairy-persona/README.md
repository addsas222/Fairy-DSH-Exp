# dsh-fairy-persona

Fairy 人格引擎（双面孔插件）：把「人格包」目录变成可切换的部署人格，并把语音绑定原子地广播给 `dsh-fairy-voice`。

## 人格包格式

人格包 = 一个目录，至少包含 `persona.yml` 与它引用的文档：

```yaml
# persona.yml
id: fairy              # 必填；^[a-z0-9-]+$，也是目录安全 id
name: Fairy            # 可选；缺省用 id
description: 内置人格    # 可选；设置卡下拉与列表展示
prompt: prompt.md      # 必填；相对包目录，必须存在于包目录内
tone: tone.json        # 可选；相对包目录，JSON
voice:                 # 可选；切换人格时同步给 fairy-voice
  provider: openai     # local-sovits | openai | browser | custom-http
  baseURL: http://127.0.0.1:9880
  model: fairy-v4
  voice: fairy
```

- `persona.yml` 由本包内建的最小 YAML 读取器解析：顶层 `key: value`，加一层缩进块（`voice`），`#` 开头为注释，值一律按字符串处理。列表、锚点、多行标量、行内注释均不支持——包需要的语法超出该子集时，再引入完整 YAML 解析器是升级路径。
- `voice` 块中除 `provider` 外的键整体作为 `config` 透传，persona 不解释任何 provider 私有键，也不 import voice 的 schema。
- 扫描根：`$DSH_HOME/personas/`（缺省 `~/.dsh/personas/`）与仓库 `persona-packs/`（仓库根取 `DSH_FAIRY_REPO_ROOT`，缺省为包目录向上三级）。先扫到的同名 id 胜出，因此用户包覆盖内置包。
- 坏包（`persona.yml` 读不到/解析失败、id 非法、`prompt` 缺失或指向包目录之外）只写 `diagnostics.warn` 并跳过，绝不影响其他包或插件加载；目录里没有 `persona.yml` 视为「不是包」，静默跳过。

## 契约

### 设置命名空间 `fairy-persona`

| 键 | 类型 | 缺省 | 含义 |
| --- | --- | --- | --- |
| `version` | number | `1` | schema 版本 |
| `active` | string | `''` | 当前人格包 id；`''` = 不启用人格包 |

### 主机事件 `fairy-persona/change`

在插件自己的 ctx 上 emit，`fairy-voice` 用 `ctx.on('fairy-persona/change', …)` 订阅；persona 从不 import voice。

```js
{ packId: 'fairy', voice: { provider: 'openai', config: { baseURL, model, voice } } }
{ packId: 'greet', voice: null }   // 该包未声明 voice 块：不绑定
{ packId: '',      voice: null }   // 清空人格
```

事件在「section 换装 → `settings.active` 落盘」之后发出；插件启动时若 `active` 指向存在的包，会重新应用该包并同样广播一次（重启保持人格与音色）。

### 主机服务 `fairyPersona`

`ctx.fairyPersona`：`list()` → 公开描述符数组；`active()` → 当前包 id；`select(id)` → `{ok, active}`（`''` 表示清空，未知 id 抛 `persona-not-found`，非法 id 抛 `persona-invalid-id`）；`preview(id)` → `{promptHead, tone}`。

### HTTP 端点

| 方法 | 路径 | 请求 | 响应 |
| --- | --- | --- | --- |
| GET | `/fairy-persona/list` | — | `{packs:[{id,name,description?}], active}` |
| POST | `/fairy-persona/select` | `{id}` | `{ok:true, active}`；未知 id → 404，非法 id → 422，坏 JSON → 400 |
| POST | `/fairy-persona/preview` | `{id}` | `{promptHead, tone}`（`promptHead` 为该包文档前 500 字，`tone` 缺失或不可解析时为 `null`） |

失败体统一为 `{ok:false, error:{code,message}}`。

### 客户端

- 设置卡：`settings.section`，`id: 'fairy-persona'`，`order: 25`，label「人格」——包下拉（含「不使用人格包」）、切换按钮、调色与人格文档开头预览、当前人格指示。
- 会话头 chip：`conversation.session.header.utilities`，`id: 'fairy-persona-chip'`，`order: 30`——显示当前人格名；未启用人格包时不渲染。设置面板没有对外的打开句柄，因此 chip 只做提示（tooltip「在设置→人格中切换」）。
- 两个面孔共用本包 `/fairy-persona/*` 作为唯一状态源，并用 window 事件 `fairy-persona-changed`（`detail: {packId, name}`）对外广播切换；`active` 是主机侧状态（对全部署生效），不是浏览器偏好，因此客户端不读写设置镜像。

## 体系上的取舍

`ponytail: 主机面全局人格作用域。` prompt registry 的 `deployment:persona-prefix` 名字在全局层由 registry 自己持有，主机面再注册同名 section 会因层内重名而抛错；因此主机面挂载退回到插件自有名字 `fairy:persona-prefix`（同一 order、同一渲染位置），并在诊断里记一条 `persona.section.shadow`。真正「替换部署配置的人格文本」以及**按会话**人格，需要在 agent 作用域内挂载——那时同名覆盖是合法的，本文件的换装逻辑不变，只换挂载上下文。部署若显式配置了 `personaSuffix`，在回退路径下不会被遮蔽。

`ponytail: 每次 list/select/preview 重新扫描磁盘。` 没人手写缓存失效逻辑，代价是每个请求读一遍包目录（几十 KB 级）。包规模变大或出现高频轮询时，再加基于 mtime 的缓存。

## 开发

```bash
pnpm install --ignore-scripts
pnpm test        # node --test test/*.test.js
```

测试夹具在 `test/fixtures/`（用户根 + 仓库根，含故意损坏的包），覆盖：YAML 子集解析、坏包跳过与告警、同名覆盖、section 换装与释放、设置落盘、事件负载、清空、未知/非法 id、HTTP 状态码、启动恢复。
