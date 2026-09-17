# language: zh-CN
# 主入口内部行为用例（错误路径 / 边界 / 工具层）。
#
# 这些用例直接驱动 scripts/verify.mjs 与 scripts/checks/lib/*.mjs 的**真实函数**（进程内，不打桩），
# 目的是把"配置写错、前提缺失、阈值越界、依赖未满足、注释与流式语法"这些**错误分支**也变成被断言
# 的行为——否则覆盖率里这些分支永远是未覆盖，等于没人知道它们是否真的会报错。

Feature: 主入口的错误路径与工具层行为
  配置驱动体系的错误分支必须可断言：写错配置要报错、前提缺失要有明确终态、
  阈值越界要判失败、工具层的解析要按 YAML 语义工作。

  Scenario: YAML 解析器按语义处理流式集合、块标量与转义
    Given 一段包含流式集合与块标量的 YAML
    Then YAML 解析出的 flow 序列是 "failed,error,timeout"
    And YAML 解析出的块标量包含 "第二行"
    And YAML 解析出的转义字符串等于 带 "引号" 的值

  Scenario: YAML 解析器遇到不支持的结构会明确报错
    Given 一段使用了锚点别名的 YAML
    Then 解析 YAML 应该抛出包含 "不支持锚点" 的错误

  Scenario: YAML 解析器遇到缩进错误会带上行号报错
    Given 一段缩进错误的 YAML
    Then 解析 YAML 应该抛出包含 "多余的缩进" 的错误

  Scenario: schema 校验能报出未知字段与类型错误
    Given 一份含未知字段与错误类型的检查项配置
    Then schema 校验应该报出 "未知字段" 与 "类型应为"

  Scenario: 未知模板变量会让命令解析失败而不是留空
    Given 一个夹具检查项，其命令里写了不存在的模板变量
    Then 命令解析应该抛出包含 "未知模板变量" 的错误

  Scenario: 前提缺失的可选检查项记 skipped 并给出手动命令
    Given 一个夹具检查项，声明了不存在的工具前提
    When 我运行夹具仓库的主入口
    Then 检查项 "demo-prereq" 的状态是 skipped
    And 检查项 "demo-prereq" 附带了手动命令

  Scenario: 前提缺失的必填检查项记 blocked 并让门禁失败
    Given 一个必填的夹具检查项，声明了不存在的工具前提
    When 我运行夹具仓库的主入口
    Then 检查项 "demo-blocked" 的状态是 blocked
    And 门禁状态是 fail

  Scenario: 显式 on_missing skip 的必填项只记警告
    Given 一个必填的夹具检查项，声明了不存在的工具前提，并显式写 on_missing skip
    When 我运行夹具仓库的主入口
    Then 检查项 "demo-onskip" 的状态是 skipped
    And 门禁状态是 pass

  Scenario: 依赖的另一检查项失败时，可选项记 skipped
    Given 一个夹具检查项 "demo-base" 会失败
    And 一个可选的夹具检查项 "demo-dep" 依赖 "demo-base"
    When 我运行夹具仓库的主入口
    Then 检查项 "demo-dep" 的状态是 skipped
    And 检查项 "demo-base" 的状态是 failed

  Scenario: 检查项超时被判 timeout 而不是一直挂着
    Given 一个超时的夹具检查项 "demo-timeout"
    When 我运行夹具仓库的主入口
    Then 检查项 "demo-timeout" 的状态是 timeout
    And 门禁状态是 fail

  Scenario: 环境变量前提缺失时必填项记 blocked 并让门禁失败
    Given 一个夹具检查项 "demo-env" 要求环境变量 "FAIRY_QUALITY_DEMO_ENV"
    When 我运行夹具仓库的主入口
    Then 检查项 "demo-env" 的状态是 blocked
    And 门禁状态是 fail

  Scenario: 路径前提缺失时可选项记 skipped
    Given 一个可选的夹具检查项 "demo-path" 要求存在路径 "does/not/exist"
    When 我运行夹具仓库的主入口
    Then 检查项 "demo-path" 的状态是 skipped
    And 门禁状态是 pass

  Scenario: 启用项少于门禁下限时门禁失败
    Given 一份把 min_enabled_checks 设为 3 的夹具配置
    And 一个夹具检查项 "demo-single" 会通过
    When 我运行夹具仓库的主入口
    Then 门禁状态是 fail
    And 门禁失败原因包含 "少于门禁下限"

  Scenario: 未启用项多于门禁上限时门禁失败
    Given 一份把 max_disabled_checks 设为 0 的夹具配置
    And 一个未启用的夹具检查项 "demo-off"（带启用原因）
    When 我运行夹具仓库的主入口
    Then 门禁状态是 fail
    And 门禁失败原因包含 "多于门禁上限"

  Scenario: 只跑部分检查项时会警告未执行的必填项
    Given 一个夹具检查项 "demo-a" 会通过
    And 一个夹具检查项 "demo-b" 会通过
    When 我只运行夹具仓库的检查项 "demo-a"
    Then 门禁状态是 pass
    And 门禁警告里出现 "demo-b"
    And 报告里 "demo-b" 的状态是 skipped

  Scenario: 报告 JSON 保留真实命令与阈值明细
    Given 一个夹具检查项 "demo-report" 输出指标 ok=1 并退出码 0 且阈值要求 ok 至少 1
    When 我运行夹具仓库的主入口
    Then 报告里 "demo-report" 的命令包含 "demo-report.mjs"
    And 报告里 "demo-report" 的阈值明细非空

  Scenario: TAP 解析器统计通过、失败与跳过
    Given 一段包含通过、失败与跳过用例的 TAP 文本
    Then TAP 汇总的通过数是 2
    And TAP 汇总的失败数是 1
    And TAP 的失败用例名包含 "should fail"

  Scenario: glob 匹配器把双星当跨目录通配
    Then glob "features/**/*.feature" 匹配 "features/quality/a.feature"
    And glob "features/**/*.feature" 匹配 "features/a.feature"
    And glob "features/*.feature" 不匹配 "features/quality/a.feature"

  Scenario: 阈值判定支持 min、max 与可选指标
    Given 一份阈值要求 ok 至少 2 且 failed 至多 0 且可选项 optional_metric 缺失
    Then 指标 ok=1 的阈值判定失败
    And 指标 failed=0 的阈值判定通过
    And 可选项缺失不算失败

  # 下面这组场景专门覆盖 schema 校验器与检查脚本的**非主路径分支**：它们平时不响，
  # 但一旦配置写错就是唯一的报错来源，必须被断言过（否则等于没人验证过）。

  Scenario: schema 的 oneOf 分支（取值必须恰好命中一个）
    Given 一份用 oneOf 描述取值的 schema
    Then schema 校验值 "demo" 报出 "oneOf"

  Scenario: schema 的数值、长度与元素个数约束分支
    Given 一份带数值、长度与元素个数约束的 schema
    Then schema 校验对象 count=1 name="ab" items=[] 报出 "小于最小值"
    And schema 校验对象 count=1 name="ab" items=[] 报出 "长度大于"
    And schema 校验对象 count=1 name="ab" items=[] 报出 "元素少于"

  Scenario: schema 的 uniqueItems 与 patternProperties 分支
    Given 一份带 uniqueItems 与 patternProperties 的 schema
    Then schema 校验对象 list=[1,1] x-num="abc" 报出 "存在重复元素"
    And schema 校验对象 list=[1,1] x-num="abc" 报出 "类型应为 number"

  Scenario: schema 的 $ref 指向不存在的定义时明确报错
    Given 一份引用了不存在 $defs 条目的 schema
    Then schema 校验应该抛出包含 "引用目标不存在" 的错误

  Scenario: additionalProperties 为 true 时允许未知字段
    Given 一份 additionalProperties 为 true 的 schema
    Then schema 校验对象 extra=1 没有错误

  Scenario: 检查脚本在扫描面为空时报错而不是"空过"
    Given 一个根目录下没有匹配文件的夹具仓库
    Then 夹具仓库里的 format 检查脚本应该以内部错误退出
