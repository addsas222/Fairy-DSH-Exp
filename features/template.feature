# language: zh-CN
# 行为用例模板：复制到 features/<area>/<name>.feature 后改内容，写好 features/steps/<name>-steps.mjs 的步骤定义。
# 标签 @skip 的场景不会被执行（用于模板/未完成用例；gherkin 门禁要求 pending/undefined = 0）。

@skip
Feature: 模板特性（复制我，改完删掉 @skip）
  一句话说明这个特性验证什么行为。

  Background:
    Given 一个通用前提

  Scenario: 模板场景
    When 我执行某个动作
    Then 我观察到某个结果

  Scenario Outline: 模板参数化场景（每个 Examples 行算一个场景）
    Given 输入 "<输入>"
    Then 结果应该是 "<期望>"

    Examples:
      | 输入 | 期望 |
      | a    | A    |
      | b    | B    |
