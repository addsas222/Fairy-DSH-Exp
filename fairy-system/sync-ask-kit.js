#!/usr/bin/env node
/**
 * 把归一化提问件内联进手写 bundle。
 *
 * 客户端 bundle 只能 require shell 的冻结模块表（react、react/jsx-runtime、
 * `@deepseek-ai/dsh-client-ui-primitives`…），**不能**跨 bundle require 别的
 * 插件，所以共享代码有两条路：
 *
 *   - 有 `src/` 的包：直接 `require('../../../../fairy-contracts/client-ask-kit.cjs')`，
 *     构建时自然内联。
 *   - 手写 `lib/client.js` 的包：由本脚本把 `fairy-contracts/client-ask-kit.cjs`
 *     的内容原样插进标记区，`--check` 用来在门禁里查漂移。
 *
 * 真源永远只有 `fairy-contracts/client-ask-kit.cjs`；bundle 里的那块是生成物。
 *
 * 用法：
 *   node fairy-system/sync-ask-kit.js            # 全部手写包：写入
 *   node fairy-system/sync-ask-kit.js --check    # 只校验，漂移则退出码 1
 *   node fairy-system/sync-ask-kit.js <包相对路径> [--check]
 *
 * @module fairy-system/sync-ask-kit
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const SOURCE = join(REPO, 'fairy-contracts', 'client-ask-kit.cjs');
const START = '// >>> fairy-ask-kit (generated from fairy-contracts/client-ask-kit.cjs — 不要手改，跑 node fairy-system/sync-ask-kit.js)';
const END = '// <<< fairy-ask-kit';

/**
 * 手写 bundle 的包（有 `src/` 的包直接 require，不在此列）。
 * 只列**真的向用户提问**的包：没有提问件的包塞进去就是死代码，
 * 下面的 assertSurvives 会当场拦下。
 */
export const INLINED_PACKAGES = [
  'fairy-modes/dsh-fairy-modes',
  'fairy-persona/dsh-fairy-persona',
  'fairy-roleplay/dsh-fairy-roleplay',
  'fairy-search/dsh-fairy-search',
  'fairy-voice/dsh-fairy-voice',
];

/**
 * 把源文件包进标记区。
 *
 * bundle 的工厂里既没有 `module.exports`，也不该让 `ASK_STYLE`/`ASK_TEXT`
 * 这类名字摊到工厂顶层（卡自己的解构会撞名报 SyntaxError）。所以包一层 IIFE，
 * 只在工厂里留 `fairyAskKit` 一个绑定，再由随块给出的一行解构提供常用名字。
 *
 * @param source - `client-ask-kit.cjs` 的完整内容。
 * @returns 可插入 bundle 的文本块。
 */
export function blockOf(source) {
  const body = source
    .replace(/\s+$/, '')
    .replace(/^module\.exports = \{([^}]*)\};\s*$/m, 'return {$1};');
  const wrapped = [
    'const fairyAskKit = (() => {',
    ...body.split('\n').map((line) => (line === '' ? '' : `  ${line}`)),
    '})();',
    '',
    'const { createAskKit, ASK_TEXT, ASK_STYLE, describeError } = fairyAskKit;',
  ].join('\n');
  return `${START}\n${wrapped}\n${END}\n`;
}

/**
 * 用真源替换 bundle 里的标记区；没有标记区就插在工厂函数之前。
 * @param bundle - `lib/client.js` 的内容。
 * @param block - {@link blockOf} 的产物。
 * @returns 新内容。
 */
export function applyBlock(bundle, block) {
  const start = bundle.indexOf(START);
  if (start >= 0) {
    const end = bundle.indexOf(END, start);
    if (end < 0) throw new Error('ask kit block has a start marker without an end marker');
    return bundle.slice(0, start) + block + bundle.slice(end + END.length + 1);
  }
  const anchor = bundle.indexOf('const React = require(');
  if (anchor < 0) throw new Error('client bundle has neither an ask-kit block nor a React require anchor');
  return bundle.slice(0, anchor) + block + '\n' + bundle.slice(anchor);
}

function main() {
  const args = process.argv.slice(2);
  const check = args.includes('--check');
  const explicit = args.filter((arg) => !arg.startsWith('--'));
  // 显式点名也不许越界：有 src/ 的包（fairy-visual / fairy-memory / browser-dock）
  // 靠自己的构建内联，塞第二份套件会在下次构建时被抹掉，还会让 --check 说谎。
  const outOfScope = explicit.filter((pkg) => !INLINED_PACKAGES.includes(pkg));
  if (outOfScope.length > 0) {
    console.error(`✗ 这些包不走内联（有 src/ 的包请重跑自己的 bundle 命令）：${outOfScope.join(', ')}`);
    process.exit(1);
  }
  const packages = explicit.length > 0 ? explicit : INLINED_PACKAGES;
  if (!existsSync(SOURCE)) throw new Error(`ask kit source is missing: ${SOURCE}`);
  const block = blockOf(readFileSync(SOURCE, 'utf8'));
  const drifted = [];
  const written = [];
  const missing = [];
  for (const pkg of packages) {
    const file = join(REPO, pkg, 'lib', 'client.js');
    if (!existsSync(file)) { missing.push(pkg); continue; }
    const bundle = readFileSync(file, 'utf8');
    const stripped = bundle.replace(START + '[\s\S]*?' + END, '');
    if (!/createAskKit|ASK_TEXT/.test(stripped)) throw new Error(`${pkg} 的 bundle 没有用到提问件：不要内联，从 INLINED_PACKAGES 里拿掉`);
    const next = applyBlock(bundle, block);
    if (next === bundle) { continue; }
    if (check) { drifted.push(pkg); continue; }
    writeFileSync(file, next);
    written.push(pkg);
  }
  if (missing.length > 0) console.log(`· 跳过（无 lib/client.js）：${missing.join(', ')}`);
  if (drifted.length > 0) {
    console.error(`✗ 提问件漂移：${drifted.join(', ')} —— 跑 node fairy-system/sync-ask-kit.js 重新内联`);
    process.exit(1);
  }
  if (check) console.log(`✓ 提问件与真源一致（${packages.length - missing.length} 个 bundle）`);
  else console.log(written.length === 0 ? '· 已是最新' : `✓ 已内联：${written.join(', ')}`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
