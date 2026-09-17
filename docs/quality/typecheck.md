# 检查项 typecheck（TypeScript 类型检查，**当前未启用**）

- **id**：`typecheck`　**阶段**：`static`　**类型**：`typecheck`　**脚本**：`scripts/checks/typecheck.mjs`
- **enabled**：`false`（`enabled_reason` 见 `.agent/checks/typecheck.yaml`）

## 为什么未启用（如实说明）

- 仓库里**没有 `tsconfig.json`**，也没有任何包声明 `typescript` 依赖；
- 唯一的 TS 输入是两个包的 `tsdown.config.ts` 与 `fairy-contracts/types.d.ts`，其正确性目前由
  各包的构建/契约测试间接覆盖（例如"嵌入的客户端 bundle 逐字节一致"这类断言）；
- 因此本仓**做不了真实的类型检查**。写一条恒过的命令是最坏的选择（装饰门禁），所以显式关闭，
  并在本文件写清启用步骤。

## 脚本是真实实现（不是占位）

`scripts/checks/typecheck.mjs` 已实现完整逻辑：找出带 `tsconfig.json` 的包 → 在包内找本地编译器
（`node_modules/typescript/bin/tsc`，其次 `.bin/tsc`）→ 跑 `tsc --noEmit -p tsconfig.json` 并记录
每个工程的退出码。找不到 `tsconfig.json` 时它 **exit 2 并打印原因**（绝不静默通过）。

## 启用步骤

1. 选一个包（例如 `fairy-visual/dsh-fairy-visual`）落地 `tsconfig.json`；`allowJs` + `checkJs`
   可以做渐进式 JS 类型检查，不必先改写成 TS。
2. 在该包安装编译器：`(cd <包> && pnpm add -D typescript)`——这会改该包的 `package.json` 与
   lockfile，需要该包所有者同意（本质量体系不改任何包目录）。
3. 把 `.agent/checks/typecheck.yaml` 的 `enabled` 改成 `true`，必要时在 `scope.package_globs`
   里收窄范围。
4. 跑 `node scripts/verify.mjs --only typecheck` 确认真实报错/通过。

## 阈值（threshold）

- `errors` = 0、`pass_rate`（工程维度）——**启用后**生效。
