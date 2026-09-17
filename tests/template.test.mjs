// 测试模板：复制到包内的 test/ 目录（<包>/test/<name>.test.js）即可被 quality 的 unit/coverage 自动带上。
// 说明：根级 tests/ 目录不被自动发现（unit 只跑各包内 test/；质量体系自身的行为验证走 features/ 的 Gherkin）。
import assert from 'node:assert/strict';
import test from 'node:test';

test('模板：断言可观察行为，而不是实现细节', () => {
  // 好的断言：输入 → 输出、边界、错误路径、状态迁移
  assert.equal(1 + 1, 2);
});

test('模板：错误路径也要有断言', () => {
  assert.throws(() => {
    throw new Error('expected');
  }, /expected/);
});
