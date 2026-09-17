// 检查项 gherkin：真实的行为用例运行器（零依赖，自解析 .feature + 执行 step 定义）。
//
// 仓库没有 cucumber（也没打算引依赖），但"没有框架"不等于"不能跑 Gherkin"：Gherkin 的语法
// 很小，运行语义也明确。本运行器实现真实的执行闭环：
//   - 解析 features/**/*.feature：Feature / Background / Scenario / Scenario Outline + Examples /
//     步骤关键字（Given/When/Then/And/But/*）/ 标签 / `#` 注释；
//   - 加载 features/steps/*.mjs 的 step 定义（默认导出 `{ steps: { '具体文本' | /正则/: fn } }`），
//     正则捕获组按顺序作为参数传入；步骤内可用 `world` 承载场景内共享状态；
//   - 每个场景用全新的 world 执行 Background → 场景步骤；Scenario Outline 每个 Examples 行各算一个场景；
//   - 未匹配到定义的步骤记 undefined；定义为 { pending: true }（或抛 Pending）记 pending；
//     同一文本匹配到多条定义记 ambiguous——三者都算门禁失败（B.md：pending/undefined=0）。
// 这是"配置驱动 + 可扩展"的一个真实例子：新增行为用例只改 features/，不需要动主入口。
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  ensureDir, finish, globToRegExp, listFiles, parseCli, pct, readCheckConfig,
} from './lib/runtime.mjs';

class PendingError extends Error {}

const STEP_KEYWORDS = ['Given', 'When', 'Then', 'And', 'But', '*'];

function matchGlob(glob, rel) {
  return globToRegExp(glob).test(rel);
}

function parseFeature(text, filename) {
  const lines = text.split(/\r?\n/);
  const feature = {
    name: filename, file: filename, tags: [], description: [], background: [], scenarios: [], errors: [],
  };
  let current = null;
  let mode = null; // 'feature' | 'background' | 'scenario' | 'examples'
  // 注意：Feature 级标签要在解析完之后继承给所有场景（`@skip` 常写在 Feature 上）
  let featureTagBuffer = [];
  let scenarioTagBuffer = [];
  let exampleHeaders = null;

  const stepOf = (line) => {
    const match = /^\s*(\*|Given|When|Then|And|But)\s+(.*)$/.exec(line);
    return match ? { keyword: match[1], text: match[2].trim(), line: line } : null;
  };

  lines.forEach((raw, index) => {
    const lineNumber = index + 1;
    const line = raw.replace(/\s+$/, '');
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) return;
    if (trimmed.startsWith('@')) {
      const tags = trimmed.split(/\s+/).filter(Boolean);
      if (mode === 'scenario' || (current && !current.steps)) scenarioTagBuffer.push(...tags);
      else featureTagBuffer.push(...tags);
      return;
    }
    if (/^Feature:/.test(trimmed)) {
      feature.name = trimmed.replace(/^Feature:\s*/, '').trim() || filename;
      feature.tags = [...featureTagBuffer];
      featureTagBuffer = [];
      mode = 'feature';
      if (!feature.scenarios.length) feature.description = [];
      return;
    }
    if (/^Background:/.test(trimmed)) {
      current = { type: 'background', steps: [] };
      feature.background = current.steps;
      mode = 'background';
      return;
    }
    if (/^Scenario Outline:/.test(trimmed) || /^Scenario Template:/.test(trimmed)) {
      current = {
        type: 'outline',
        name: trimmed.replace(/^Scenario (Outline|Template):\s*/, '').trim(),
        tags: [...scenarioTagBuffer],
        steps: [],
        examples: [],
        line: lineNumber,
      };
      feature.scenarios.push(current);
      scenarioTagBuffer = [];
      mode = 'scenario';
      exampleHeaders = null;
      return;
    }
    if (/^Scenario:/.test(trimmed)) {
      current = {
        type: 'scenario',
        name: trimmed.replace(/^Scenario:\s*/, '').trim(),
        tags: [...scenarioTagBuffer],
        steps: [],
        line: lineNumber,
      };
      feature.scenarios.push(current);
      scenarioTagBuffer = [];
      mode = 'scenario';
      return;
    }
    if (/^Examples:/.test(trimmed)) {
      if (!current || current.type !== 'outline') {
        feature.errors.push(`第 ${lineNumber} 行：Examples 只能跟在 Scenario Outline 之后`);
        return;
      }
      mode = 'examples';
      exampleHeaders = null;
      return;
    }
    if (mode === 'examples') {
      if (!trimmed.startsWith('|')) {
        feature.errors.push(`第 ${lineNumber} 行：Examples 表格行必须以 | 开头`);
        return;
      }
      const cells = trimmed.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
      if (!exampleHeaders) {
        exampleHeaders = cells;
        current.examples.headers = cells;
        return;
      }
      const row = {};
      cells.forEach((cell, i) => { row[exampleHeaders[i] || `col${i}`] = cell; });
      current.examples.push(row);
      return;
    }
    const step = stepOf(line);
    if (step) {
      if (!current || mode === 'feature') {
        // Feature 下的首个步骤：视为隐式 Background（与常见写法兼容）
        current = { type: 'background', steps: [] };
        feature.background = current.steps;
        mode = 'background';
      }
      current.steps.push(step);
      return;
    }
    if (mode === 'scenario' && current && !current.steps.length) {
      current.description = current.description || [];
      current.description.push(trimmed);
      return;
    }
    feature.description.push(trimmed);
  });

  // Feature 级标签继承：场景标签 = 场景自身标签 + Feature 标签
  for (const scenario of feature.scenarios) {
    scenario.tags = [...new Set([...(feature.tags || []), ...(scenario.tags || [])])];
  }
  if (!feature.scenarios.length) feature.errors.push('没有任何 Scenario');
  if (scenarioTagBuffer.length) feature.errors.push('标签没有挂在任何 Scenario 上');
  return feature;
}

/**
 * 把 `{string}` / `{int}` / `{word}` / `{float}` 占位符转成正则（与常见 Gherkin 步骤库写法一致）。
 * 做法：先把占位符换成哨兵字符，再整体转义，最后把哨兵换回捕获组——直接边转义边替换很容易
 * 把 `{` 转义错（第一版就栽在这里：`\{string\}` 永远匹配不上）。
 */
function matcherToRegex(text) {
  const sentinels = text
    .replace(/\{string\}/g, '\u0000S\u0000')
    .replace(/\{int\}/g, '\u0000I\u0000')
    .replace(/\{float\}/g, '\u0000F\u0000')
    .replace(/\{word\}/g, '\u0000W\u0000');
  const escaped = sentinels.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // 注意：占位符必须换成**带捕获组**的模式——第一版忘了括号，于是步骤收不到参数、
  // 断言全部以 "undefined" 失败（同一步骤文本却仍然"匹配成功"）。这里补上，并在下面做自检。
  const source = escaped
    .replace(/\u0000S\u0000/g, '"([^"]*)"')
    .replace(/\u0000I\u0000/g, '(-?\\d+)')
    .replace(/\u0000F\u0000/g, '(-?\\d+(?:\\.\\d+)?)')
    .replace(/\u0000W\u0000/g, '(\\S+)')
    .replace(/ /g, '\\s+');
  return new RegExp(`^${source}$`);
}

async function loadSteps(stepsRoot, globs) {
  const definitions = [];
  const files = fs.existsSync(stepsRoot)
    ? listFiles(stepsRoot, { extensions: ['.mjs', '.js'] })
    : [];
  for (const file of files) {
    const rel = path.relative(stepsRoot, file).split(path.sep).join('/');
    if (globs && !globs.some((glob) => matchGlob(glob, rel))) continue;
    const module = await import(pathToFileURL(file).href);
    const exported = module.default && module.default.steps ? module.default.steps : (module.steps || module.default);
    if (!exported || typeof exported !== 'object') continue;
    for (const [matcher, handler] of Object.entries(exported)) {
      const isRegExp = matcher.startsWith('/') && matcher.lastIndexOf('/') > 0;
      let regex = null;
      let text = matcher;
      if (isRegExp) {
        const lastSlash = matcher.lastIndexOf('/');
        regex = new RegExp(matcher.slice(1, lastSlash), matcher.slice(lastSlash + 1));
      } else if (/\{(string|int|word|float)\}/.test(matcher)) {
        regex = matcherToRegex(matcher);
        // 自检：占位符数量必须等于捕获组数量（忘了括号 = 步骤收不到参数，却仍会"匹配成功"）
        const placeholders = (matcher.match(/\{(string|int|word|float)\}/g) || []).length;
        const groupCount = (regex.source.match(/\((?!\?)/g) || []).length;
        if (groupCount !== placeholders) {
          process.stdout.write(`   ! 步骤定义「${matcher}」有 ${placeholders} 个占位符但只生成了 ${groupCount} 个捕获组（${path.relative(stepsRoot, file)}）：步骤会收不到参数\n`);
        }
      }
      definitions.push({
        file: path.relative(stepsRoot, file).split(path.sep).join('/'),
        text,
        regex,
        handler: typeof handler === 'function' ? handler : handler.handler,
        pending: typeof handler === 'object' && handler && handler.pending === true,
      });
    }
  }
  return definitions;
}

function coerceArg(value) {
  if (/^-?\d+$/.test(value)) return Number(value);
  return value.replace(/^"|"$/g, '');
}

function findDefinition(definitions, stepText) {
  const matches = [];
  for (const definition of definitions) {
    if (definition.regex) {
      const match = definition.regex.exec(stepText);
      if (match) matches.push({ definition, args: match.slice(1).map(coerceArg) });
    } else if (definition.text === stepText) {
      matches.push({ definition, args: [] });
    }
  }
  return matches;
}

function interpolate(text, row) {
  return text.replace(/<([^>]+)>/g, (match, key) => (key in row ? row[key] : match));
}

async function main() {
  const args = parseCli();
  const repo = path.resolve(args.repo || process.cwd());
  const check = readCheckConfig(args.check);
  const reportDir = args['report-dir'] || path.join(repo, 'reports');
  const artifactPath = args.artifact || path.join(reportDir, 'artifacts', 'gherkin.json');
  const scope = check.scope || {};
  const featureGlobs = scope.feature_globs || ['**/*.feature'];
  const stepsGlobs = scope.steps_globs || ['**/*.mjs'];
  const featuresRoot = path.resolve(repo, scope.features_dir || 'features');
  const stepsRoot = path.resolve(repo, scope.steps_dir || 'features/steps');
  const quiet = Boolean(args.quiet);

  if (!fs.existsSync(featuresRoot)) {
    process.stdout.write(`gherkin：特性目录不存在：${featuresRoot}\n`);
    process.exit(2);
  }
  const featureFiles = listFiles(featuresRoot, { extensions: ['.feature'] })
    .filter((file) => featureGlobs.some((glob) => matchGlob(glob, path.relative(featuresRoot, file).split(path.sep).join('/'))));
  const definitions = await loadSteps(stepsRoot, stepsGlobs);

  if (!featureFiles.length) {
    process.stdout.write('gherkin 内部错误：特性目录下没有任何 .feature 文件（扫描面为空）——不接受假通过\n');
    process.exit(2);
  }
  const parsed = featureFiles.map((file) => parseFeature(fs.readFileSync(file, 'utf8'), path.relative(repo, file).split(path.sep).join('/')));
  const syntaxErrors = [];
  for (const feature of parsed) for (const error of feature.errors) syntaxErrors.push(`${feature.file}：${error}`);

  const results = [];
  let passed = 0;
  let failed = 0;
  let pending = 0;
  let undefinedSteps = 0;
  let ambiguous = 0;
  let skippedByTag = 0;
  const skipTag = scope.skip_tag || '@skip';

  for (const feature of parsed) {
    for (const scenario of feature.scenarios) {
      if ((scenario.tags || []).includes(skipTag)) {
        skippedByTag += 1;
        results.push({ feature: feature.file, scenario: scenario.name, status: 'skipped', note: `${skipTag} 标签` });
        continue;
      }
      const rows = scenario.type === 'outline' ? (scenario.examples || []) : [null];
      if (scenario.type === 'outline' && !rows.length) {
        syntaxErrors.push(`${feature.file}：Scenario Outline「${scenario.name}」没有 Examples 行`);
        continue;
      }
      for (const row of rows) {
        const world = {};
        const scenarioName = row ? `${scenario.name} [${(scenario.examples.headers || []).map((h) => row[h]).join(' | ')}]` : scenario.name;
        const steps = [...(feature.background || []), ...scenario.steps];
        let status = 'passed';
        let failure = null;
        for (const step of steps) {
          const text = row ? interpolate(step.text, row) : step.text;
          const matches = findDefinition(definitions, text);
          if (!matches.length) {
            status = 'undefined';
            undefinedSteps += 1;
            failure = `${step.keyword} ${text} —— 没有匹配的 step 定义`;
            break;
          }
          if (matches.length > 1) {
            status = 'ambiguous';
            ambiguous += 1;
            failure = `${step.keyword} ${text} —— 匹配到 ${matches.length} 条定义（${matches.map((m) => m.definition.file).join(', ')}）`;
            break;
          }
          const { definition, args: stepArgs } = matches[0];
          if (definition.pending) {
            status = 'pending';
            pending += 1;
            failure = `${step.keyword} ${text} —— 步骤标记为 pending（${definition.file}）`;
            break;
          }
          try {
            await definition.handler(world, ...stepArgs);
          } catch (error) {
            if (error instanceof PendingError || (error && error.name === 'PendingError')) {
              status = 'pending';
              pending += 1;
              failure = `${step.keyword} ${text} —— ${error.message}`;
              break;
            }
            status = 'failed';
            failed += 1;
            failure = `${step.keyword} ${text} —— ${error && error.stack ? error.stack.split('\n')[0] : error}`;
            break;
          }
        }
        if (status === 'passed') passed += 1;
        if (status === 'failed' && !quiet) process.stdout.write(`   ✖ ${feature.file} :: ${scenarioName}\n      ${failure}\n`);
        results.push({
          feature: feature.file, scenario: scenarioName, status, note: failure,
        });
      }
    }
  }

  const scenariosWithStatus = results.filter((r) => r.status !== 'skipped');
  const artifact = {
    generated_at: new Date().toISOString(),
    repo,
    features: parsed.map((f) => ({ file: f.file, name: f.name, scenarios: f.scenarios.length, tags: f.tags })),
    step_definitions: definitions.map((d) => ({ file: d.file, matcher: d.text, pending: d.pending })),
    results,
    syntax_errors: syntaxErrors,
  };
  ensureDir(path.dirname(artifactPath));
  const ok = failed === 0 && pending === 0 && undefinedSteps === 0 && ambiguous === 0 && syntaxErrors.length === 0;
  process.stdout.write(`gherkin：特性 ${parsed.length} 个，场景 ${scenariosWithStatus.length} 个（通过 ${passed} / 失败 ${failed} / pending ${pending} / undefined ${undefinedSteps} / ambiguous ${ambiguous}）；跳过 ${skippedByTag}；step 定义 ${definitions.length} 条\n`);
  for (const error of syntaxErrors) process.stdout.write(`   ✖ 语法：${error}\n`);
  finish({
    ok,
    metrics: {
      features: parsed.length,
      scenarios: scenariosWithStatus.length,
      passed,
      failed,
      pending,
      undefined_steps: undefinedSteps,
      ambiguous,
      skipped: skippedByTag,
      pass_rate: pct(passed, scenariosWithStatus.length),
      syntax_errors: syntaxErrors.length,
    },
    artifactPath,
    artifact,
    failureNote: 'Gherkin 门禁：failed=0、pending=0、undefined=0（缺定义的步骤必须补 step 定义，而不是删用例）。',
  });
}

main().catch((error) => {
  process.stdout.write(`gherkin 内部错误：${error && error.stack ? error.stack : error}\n`);
  process.exit(2);
});
