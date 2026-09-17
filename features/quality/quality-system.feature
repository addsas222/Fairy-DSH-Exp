# language: zh-CN
# 质量体系自身的行为用例（真实执行：step 定义调用主入口的 lib API，不是打桩）。
#
# 这些用例回答的是"扩展闭环到底成不成立"：
#   - 新增 .agent/checks/<id>.yaml + 脚本 → 主入口自动发现（主入口零硬编码）
#   - 配置写错 → 明确报错，而不是静默跳过
#   - 阈值未满足 → 该项判失败（阈值真实生效）
#   - 平台命令选择 → Windows 走 windows_command（跨平台约定真实生效）
#   - allow_failure / on_missing 的降级语义
#
# 运行：node scripts/verify.mjs --only gherkin（或 node scripts/checks/gherkin.mjs ...）

Feature: 质量体系主入口的配置驱动扩展闭环
  主入口只读配置、自动发现检查项、按阶段执行并汇总门禁。
  任何人新增检查项只需要加配置文件与脚本，不需要改主入口。

  Background:
    Given 一个临时质量夹具仓库

  Scenario: 新增检查项文件后主入口自动发现并真实执行
    When 我向夹具仓库新增检查项 "demo-ok" 输出指标 ok=1 并退出码 0
    And 我运行夹具仓库的主入口
    Then 主入口发现的检查项数量是 1
    And 检查项 "demo-ok" 的状态是 passed
    And 检查项 "demo-ok" 的退出码是 0
    And 门禁状态是 pass
    And 夹具仓库生成了报告文件

  Scenario: 检查项失败时门禁判失败
    When 我向夹具仓库新增检查项 "demo-fail" 输出指标 ok=0 并退出码 1
    And 我运行夹具仓库的主入口
    Then 检查项 "demo-fail" 的状态是 failed
    And 门禁状态是 fail

  Scenario: 阈值未满足时即使脚本成功也判失败
    When 我向夹具仓库新增检查项 "demo-threshold" 输出指标 ok=1 并退出码 0 且阈值要求 ok 至少 2
    And 我运行夹具仓库的主入口
    Then 检查项 "demo-threshold" 的状态是 failed
    And 门禁状态是 fail

  Scenario: 配置缺字段时主入口报配置错误而不是静默跳过
    When 我向夹具仓库新增一个缺 windows_command 的检查项 "demo-broken"
    And 我运行夹具仓库的主入口
    Then 主入口报告配置错误 1 条

  Scenario: allow_failure 把失败降级为警告
    When 我向夹具仓库新增检查项 "demo-allowed" 输出指标 ok=0 并退出码 1 且标记 allow_failure
    And 我运行夹具仓库的主入口
    Then 检查项 "demo-allowed" 的状态是 failed
    And 门禁状态是 pass

  Scenario: 声明平台不支持时该项记 unsupported（是决定，不是失败也不是侥幸）
    When 我向夹具仓库新增检查项 "demo-platform" 声明当前平台不支持
    And 我运行夹具仓库的主入口
    Then 检查项 "demo-platform" 的状态是 unsupported
    And 门禁状态是 pass

  Scenario: 模板文件本身就是可解析的检查项配置
    When 我用模板渲染一个检查项 "demo-template" 并加入夹具仓库
    Then 主入口能解析模板检查项 "demo-template"
