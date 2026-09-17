// features/quality/harness-internals.feature 中 schema / 空扫描面场景的 step 定义。
//
// 这些步骤直接调用 scripts/checks/lib/schema.mjs 的校验器与真实的检查脚本子进程，
// 目的是覆盖"配置写错时才会走到的分支"——它们平时不响，但一旦配置出错就是唯一的报错来源。
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateAgainstSchema } from '../../scripts/checks/lib/schema.mjs';
import { createFixtureRepo } from '../../scripts/checks/lib/fixture-repo.mjs';
import { run } from '../../scripts/checks/lib/runtime.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 把 `count=1 name="ab" items=[]` 这样的一行解析成一个对象（够用即可，勿当通用解析器）。 */
function parsePairs(text) {
  const obj = {};
  for (const token of text.match(/(\w[\w-]*)=(?:"[^"]*"|\[[^\]]*\]|[^\s]+)/g) || []) {
    const eq = token.indexOf('=');
    const key = token.slice(0, eq);
    const raw = token.slice(eq + 1);
    if (raw.startsWith('"')) obj[key] = raw.slice(1, -1);
    else if (raw.startsWith('[')) {
      const inner = raw.slice(1, -1).trim();
      obj[key] = inner === '' ? [] : inner.split(',').map((v) => (Number.isNaN(Number(v)) ? v.replace(/^"|"$/g, '') : Number(v)));
    } else obj[key] = Number.isNaN(Number(raw)) ? raw : Number(raw);
  }
  return obj;
}

export const steps = {
  '一份用 oneOf 描述取值的 schema': (world) => {
    world.schemaDoc = {
      oneOf: [
        { type: 'object', required: ['value'], properties: { value: { type: 'number' } }, additionalProperties: true },
        { type: 'object', required: ['other'], properties: { other: { type: 'string' } }, additionalProperties: true },
      ],
    };
    world.schemaErrors = validateAgainstSchema({ value: 'demo', other: 'x' }, world.schemaDoc, 'demo');
  },
  'schema 校验值 {string} 报出 {string}': (world, value, needle) => {
    // 只给 value（既不是数字、也没有第二个分支要求的 other）→ 恰好命中 0 个分支 → 应报 oneOf 错误
    const errors = validateAgainstSchema({ value }, world.schemaDoc, 'demo');
    assert.ok(errors.join(' | ').includes(needle), `错误是：${errors.join(' | ')}`);
  },
  '一份带数值、长度与元素个数约束的 schema': (world) => {
    world.schemaDoc = {
      type: 'object',
      properties: {
        count: { type: 'number', minimum: 10 },
        name: { type: 'string', maxLength: 1 },
        items: { type: 'array', minItems: 1 },
      },
    };
    world.schemaErrors = validateAgainstSchema({ count: 1, name: 'ab', items: [] }, world.schemaDoc, 'demo');
  },
  'schema 校验对象 count={int} name={string} items=[] 报出 {string}': (world, count, name, needle) => {
    const errors = validateAgainstSchema({ count, name, items: [] }, world.schemaDoc, 'demo');
    assert.ok(errors.join(' | ').includes(needle), `错误是：${errors.join(' | ')}`);
  },
  '一份带 uniqueItems 与 patternProperties 的 schema': (world) => {
    world.schemaDoc = {
      type: 'object',
      properties: { list: { type: 'array', uniqueItems: true } },
      patternProperties: { '^x-': { type: 'number' } },
      additionalProperties: false,
    };
  },
  'schema 校验对象 list={word} x-num={word} 报出 {string}': (world, listRaw, xnumRaw, needle) => {
    const errors = validateAgainstSchema(parsePairs(`list=${listRaw} x-num=${xnumRaw}`), world.schemaDoc, 'demo');
    assert.ok(errors.join(' | ').includes(needle), `错误是：${errors.join(' | ')}`);
  },
  '一份引用了不存在 $defs 条目的 schema': (world) => {
    world.schemaDoc = { type: 'object', properties: { a: { $ref: '#/$defs/missing' } } };
    world.schemaThrown = null;
    try {
      validateAgainstSchema({ a: 1 }, world.schemaDoc, 'demo');
    } catch (error) {
      world.schemaThrown = error;
    }
  },
  'schema 校验应该抛出包含 {string} 的错误': (world, needle) => {
    assert.ok(world.schemaThrown, '没有抛错');
    assert.ok(String(world.schemaThrown.message).includes(needle), `错误是：${world.schemaThrown.message}`);
  },
  '一份 additionalProperties 为 true 的 schema': (world) => {
    world.schemaDoc = { type: 'object', properties: { known: { type: 'number' } }, additionalProperties: true };
  },
  'schema 校验对象 extra={int} 没有错误': (world, value) => {
    const errors = validateAgainstSchema({ extra: value }, world.schemaDoc, 'demo');
    assert.deepEqual(errors, [], `不该有错误：${errors.join(' | ')}`);
  },
  '一个根目录下没有匹配文件的夹具仓库': (world) => {
    world.emptyFixture = createFixtureRepo({ schemaFrom: REPO_ROOT, name: 'empty-scan' });
  },
  '夹具仓库里的 format 检查脚本应该以内部错误退出': async (world) => {
    const fixture = world.emptyFixture;
    // 扫描面为空（空仓库没有跟踪文件）时必须报**内部错误**，而不是"0 个文件、0 个违规"的假通过
    const result = await run(process.execPath, [
      path.join(REPO_ROOT, 'scripts', 'checks', 'format.mjs'),
      '--check', path.join(REPO_ROOT, '.agent', 'checks', 'format.yaml'),
      '--repo', fixture.dir,
      '--report-dir', path.join(fixture.dir, 'reports'),
    ], { cwd: REPO_ROOT, timeoutMs: 120_000 });
    assert.equal(result.code, 2, `退出码应为 2（内部错误），实际 ${result.code}\n${result.stdout}\n${result.stderr}`);
    assert.ok(/没有可扫描|扫描面为空|找不到任何/.test(result.stdout + result.stderr), `错误信息里应说明扫描面为空：${result.stdout}${result.stderr}`);
    fixture.cleanup();
  },
};

export default steps;
