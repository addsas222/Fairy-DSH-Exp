# 检查项 integration（跨包/镜像集成与 fairy-system 套件）

- **id**：`integration`　**阶段**：`verify`　**类型**：`integration`　**脚本**：`scripts/checks/integration.mjs`
- **required**：是（`allow_failure: true`：外部制品依赖的失败降级为警告）

## 机制

按 `.agent/checks/integration.yaml` 的 `scope.subchecks` 逐个跑真实命令，**前提不同就分开判定**：

| 子检查 | 命令 | 前提 |
| --- | --- | --- |
| `image-manifest-self-test` | `node fairy-system/image-manifest.js --self-test` | 无（离线可跑） |
| `skill-audit-self-test` | `node fairy-system/skill-audit.js --self-test` | 无 |
| `scaffold-plugin-self-test` | `node fairy-system/scaffold-plugin.js --self-test` | 无 |
| `verify-build` | `node fairy-system/verify-build.js` | 已部署且装齐包的 `DSH_HOME` |
| `fairy-system-suite` | `node --test fairy-system/test/*.test.js` | `DSH_HOME` + `DSH_OFFICIAL_PACKAGE` + `DSH_OFFICIAL_RUNTIME` |

前提缺失的子检查记 `skipped` 并打印**真实手动命令**；依赖 home 的子检查遇到"部署不完整"
（ENOENT/缺包）也记 `skipped`（属环境前提，不是代码失败）——否则换台机器就是一片红，下一个人就会去删检查。

## 阈值（threshold）

- `failed` = 0（门禁，`allow_failure` 使其降级为警告）
- `passed`/`skipped`/`subchecks` 只作观测；跳过的子检查一定会出现在报告的"跳过/阻塞"一节

## 复现与产物

```sh
node scripts/verify.mjs --only integration
DSH_HOME=<装齐的 home> node fairy-system/verify-build.js
```

产物：`reports/artifacts/integration.json`（逐子检查：命令、退出码、耗时、输出尾部、跳过原因与手动命令）。
