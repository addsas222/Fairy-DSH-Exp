# 检查项 <id>（<title>）

- **id**：`<id>`　**阶段**：`<stage>`　**类型**：`<type>`　**脚本**：`scripts/checks/<id>.mjs`
- **required**：<是/否（allow_failure 的情况也要写清）>

## 机制（它到底做什么，怎么算失败）

（写清楚：读什么输入、怎么判定、为什么这么判。不要只写"跑某命令"，要写命令产出什么、
失败长什么样。）

## 阈值（threshold）

- `<metric>` = <阈值>（门禁）
- 其它指标只作观测

## 前提与安装

- 前提：`<tool/env/path/check>`（缺什么会怎样：required 项记 blocked / 可选项记 skipped）
- 安装：`requires[].install` 的条目 → `scripts/install.ps1` / `install.sh`（生成，勿手改）

## 复现与产物

```sh
node scripts/verify.mjs --only <id>
node scripts/checks/<id>.mjs --check .agent/checks/<id>.yaml --repo . --report-dir reports
```

产物：`reports/artifacts/<id>.json`（机器可读明细）、`reports/artifacts/<id>.log`（完整 stdout/stderr）。

## 未启用时（enabled: false）

（写清：为什么本仓现在做不了真实检查、启用需要哪些前置、谁来做。禁止写"以后再说"。）
