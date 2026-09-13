#!/usr/bin/env node
/*
 * Ponytail 冗余审计：技能根 + 插件行。零依赖，Node >= 20。
 * 输出（ponytail-audit 格式）：<tag> <what>. <replacement>. [path]
 * ponytail: 技能发现为单层扫描（技能包内子目录不递归）、YAML 只读扁平键，更深的子树/嵌套映射属升级路径。
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

const SIMILARITY_THRESHOLD = 0.6;
const STOPWORDS = new Set(['a', 'the', 'and', 'or', 'to', 'of', 'in', 'for', 'with', 'you', 'your', 'is', 'are', 'this', 'that', '的', '了', '和', '与', '或', '在', '是', '你', '您的', '一个']);
const CJK_RUN = /[\u4e00-\u9fff]+/g;

function repoRelative(target) {
  return (relative(process.cwd(), target) || '.').split(sep).join('/');
}

function unquote(value) {
  const text = String(value ?? '').trim();
  const quoted = text.length > 1 && ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")));
  return quoted ? text.slice(1, -1) : text;
}

function listDirs(root) {
  try {
    return readdirSync(root, { withFileTypes: true }).map((entry) => entry.name).sort();
  } catch {
    return [];
  }
}

function isDir(target) {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function readText(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/** 扁平 frontmatter 读取器：只认 `---` 块内的 `key: value`。 */
function readFrontmatter(text) {
  const lines = text.split(/\r?\n/);
  if ((lines[0] || '').trim() !== '---') return null;
  const data = {};
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].trim() === '---') return data;
    const match = lines[index].match(/^([A-Za-z0-9_.-]+):\s*(.*)$/);
    if (match) data[match[1]] = unquote(match[2]);
  }
  return null;
}

/** 小写化 + 非字母数字切分 + 停用词过滤；中文保留 bigram。 */
function tokenize(text) {
  const tokens = new Set();
  const lower = String(text ?? '').toLowerCase();
  for (const run of lower.match(CJK_RUN) || []) {
    if (run.length === 1) tokens.add(run);
    else for (let index = 0; index < run.length - 1; index += 1) tokens.add(run.slice(index, index + 2));
  }
  for (const word of lower.split(/[^a-z0-9]+/)) if (word && !STOPWORDS.has(word)) tokens.add(word);
  for (const stopword of STOPWORDS) tokens.delete(stopword);
  return tokens;
}

function jaccard(left, right) {
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared / (left.size + right.size - shared);
}

function skillFrom(file, fallbackName) {
  const frontmatter = readFrontmatter(readText(file));
  return { name: (frontmatter && frontmatter.name) || fallbackName, description: (frontmatter && frontmatter.description) || '', path: file };
}

/** 单层扫描：技能目录（含 SKILL.md）或带 frontmatter 的扁平 *.md。 */
function discoverSkills(roots) {
  const skills = [];
  for (const root of roots) {
    for (const entry of listDirs(root)) {
      const full = join(root, entry);
      if (isDir(full)) {
        if (existsSync(join(full, 'SKILL.md'))) skills.push(skillFrom(join(full, 'SKILL.md'), entry));
      } else if (entry.toLowerCase().endsWith('.md') && readFrontmatter(readText(full))) {
        skills.push(skillFrom(full, basename(entry, '.md')));
      }
    }
  }
  return skills;
}

function auditSkills(skills) {
  const findings = [];
  const byName = new Map();
  for (const skill of skills) byName.set(skill.name, [...(byName.get(skill.name) || []), skill]);
  for (const [name, group] of byName) {
    for (const duplicate of group.slice(1)) {
      findings.push({ tag: 'duplicate', what: `skill "${name}" duplicates the copy at ${repoRelative(group[0].path)}`, replacement: 'keep the canonical copy and delete this one', path: repoRelative(duplicate.path) });
    }
  }
  const vectors = skills.map((skill) => ({ skill, tokens: tokenize(`${skill.name} ${skill.description}`) }));
  for (let left = 0; left < vectors.length; left += 1) {
    for (let right = left + 1; right < vectors.length; right += 1) {
      const score = jaccard(vectors[left].tokens, vectors[right].tokens);
      if (score < SIMILARITY_THRESHOLD) continue;
      findings.push({ tag: 'merge', what: `skills "${vectors[left].skill.name}" and "${vectors[right].skill.name}" overlap (jaccard ${score.toFixed(2)})`, replacement: 'merge them into one skill', path: repoRelative(vectors[left].skill.path), score: Number(score.toFixed(2)) });
    }
  }
  for (const skill of skills) {
    if (skill.description.trim()) continue;
    findings.push({ tag: 'shrink', what: `skill "${skill.name}" has no description`, replacement: 'add a one-line description to its frontmatter', path: repoRelative(skill.path) });
  }
  return findings;
}

/** 扁平插件行读取器：列表项 `- id: X` 之后的 `name:` / `disabled:` 行。 */
function readPluginRows(text, file) {
  const rows = [];
  let current = null;
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].replace(/#.*$/, '');
    const idMatch = line.match(/^\s*-\s+id:\s*(.+?)\s*$/);
    if (idMatch) {
      current = { id: unquote(idMatch[1]), name: '', disabled: false, path: file, line: index + 1 };
      rows.push(current);
      continue;
    }
    if (!current) continue;
    const nameMatch = line.match(/^\s+name:\s*(.+?)\s*$/);
    if (nameMatch) current.name = unquote(nameMatch[1]);
    const disabledMatch = line.match(/^\s+disabled:\s*(.+?)\s*$/);
    if (disabledMatch) current.disabled = /^(true|yes|1)$/i.test(unquote(disabledMatch[1]));
  }
  return rows;
}

function auditPlugins(rows) {
  const findings = [];
  const byId = new Map();
  for (const row of rows) byId.set(row.id, [...(byId.get(row.id) || []), row]);
  for (const [id, group] of byId) {
    for (const duplicate of group.slice(1)) {
      findings.push({ tag: 'duplicate', what: `plugin id "${id}" duplicates the row at ${repoRelative(group[0].path)}:${group[0].line}`, replacement: 'keep one row and delete the rest', path: repoRelative(duplicate.path) });
    }
  }
  const byName = new Map();
  for (const row of rows) {
    if (!row.name) continue;
    byName.set(row.name, [...(byName.get(row.name) || []), row]);
  }
  for (const [name, group] of byName) {
    const ids = [...new Set(group.map((row) => row.id))];
    if (ids.length < 2) continue;
    findings.push({ tag: 'merge', what: `plugin name "${name}" is served by ids ${ids.map((id) => `"${id}"`).join(' and ')}`, replacement: 'pick one plugin and delete the other', path: repoRelative(group[0].path) });
  }
  for (const row of rows) {
    if (row.disabled) findings.push({ tag: 'delete', what: `plugin row "${row.id}" is disabled`, replacement: 'delete the row or re-enable it', path: repoRelative(row.path) });
  }
  return findings;
}

function defaultRoots(cwd) {
  const presets = join(cwd, '.agent-presets');
  return [
    ...listDirs(presets).map((entry) => join(presets, entry, 'skills')),
    join(cwd, '.dsh', 'skills'),
    join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'skills'),
  ];
}

function run(options) {
  const cwd = options.cwd || process.cwd();
  const roots = (options.roots?.length ? options.roots : defaultRoots(cwd))
    .map((root) => resolve(cwd, root))
    .filter((root, index, all) => all.indexOf(root) === index && isDir(root));
  const rows = (options.plugins || []).map((file) => resolve(cwd, file)).flatMap((file) => readPluginRows(readText(file), file));
  rows.sort((left, right) => (left.path === right.path ? left.line - right.line : left.path.localeCompare(right.path)));
  return { roots, findings: [...auditSkills(discoverSkills(roots)), ...auditPlugins(rows)] };
}

function report(findings) {
  const count = (tag) => findings.filter((finding) => finding.tag === tag).length;
  const lines = findings.map((finding) => `${finding.tag} ${finding.what}. ${finding.replacement}. [${finding.path}]`);
  return [...lines, `net: ${findings.length} findings (${count('duplicate')} duplicates, ${count('merge')} merge candidates).`];
}

function writeSkill(root, dir, name, description) {
  mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`, 'utf8');
}

function selfTest() {
  const sandbox = mkdtempSync(join(tmpdir(), 'fairy-skill-audit-'));
  try {
    const rootA = join(sandbox, 'rootA', 'skills');
    const rootB = join(sandbox, 'rootB', 'skills');
    writeSkill(rootA, 'dup-one', 'shared-skill', 'collect ocean temperature readings from buoys');
    writeSkill(rootB, 'dup-two', 'shared-skill', 'render animated charts of glacier retreat');
    writeSkill(rootA, 'similar-one', 'similar-one', 'audit repository skills and plugins for redundant duplicate entries');
    writeSkill(rootB, 'similar-two', 'similar-two', 'audit repository skills and plugins for redundant duplicate entries');
    writeSkill(rootA, 'thin', 'thin-skill', '');
    writeSkill(rootB, 'unrelated', 'unrelated-skill', 'translate legal contracts between english and japanese');
    const pluginFile = join(sandbox, 'cordis.yml');
    writeFileSync(pluginFile, ['plugins:', '  - id: tool-web', '    name: web-search', '    disabled: true', '  - id: tool-web', '    name: web-search', '  - id: plan-mode', '    name: plan', '  - id: explore-mode', '    name: plan', ''].join('\n'), 'utf8');

    const { findings } = run({ cwd: sandbox, roots: [rootA, rootB], plugins: [pluginFile] });
    const searchable = (finding) => `${finding.tag} ${finding.what} ${finding.path}`;
    assert.ok(findings.some((finding) => finding.tag === 'duplicate' && finding.what.includes('shared-skill')), 'exact skill name collision must be reported as duplicate');
    const similar = findings.find((finding) => finding.tag === 'merge' && finding.what.includes('similar-one') && finding.what.includes('similar-two'));
    assert.ok(similar, 'overlapping skill descriptions must be reported as merge candidates');
    assert.ok(similar.score >= SIMILARITY_THRESHOLD, `merge score ${similar.score} must reach the threshold`);
    assert.ok(!findings.some((finding) => searchable(finding).includes('unrelated')), 'dissimilar skills must not be flagged');
    assert.ok(findings.some((finding) => finding.tag === 'shrink' && finding.what.includes('thin-skill')), 'missing description must be reported as shrink');
    assert.ok(findings.some((finding) => finding.tag === 'delete' && finding.what.includes('tool-web')), 'disabled plugin row must be reported as a delete candidate');
    assert.ok(findings.some((finding) => finding.tag === 'duplicate' && finding.what.includes('plugin id "tool-web"')), 'duplicate plugin id must be reported');
    assert.ok(findings.some((finding) => finding.tag === 'merge' && finding.what.includes('plan-mode')), 'same plugin name under different ids must be reported');
    assert.match(report(findings).at(-1), /^net: \d+ findings \(\d+ duplicates, \d+ merge candidates\)\.$/);
    process.stdout.write(`skill-audit self-test passed (${findings.length} fixture findings)\n`);
    return true;
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

function main(argv) {
  const options = { roots: [], plugins: [], json: false, selfTest: false };
  try {
    for (let index = 0; index < argv.length; index += 1) {
      const arg = argv[index];
      if (arg === '--root' || arg === '--plugins') {
        if (!argv[index + 1]) throw new Error(`${arg} needs a value`);
        options[arg === '--root' ? 'roots' : 'plugins'].push(argv[index += 1]);
      } else if (arg === '--json') options.json = true;
      else if (arg === '--self-test') options.selfTest = true;
      else throw new Error(`unknown argument: ${arg}`);
    }
  } catch (error) {
    process.stderr.write(`skill-audit: ${error.message}\n`);
    process.exitCode = 2;
    return;
  }
  if (options.selfTest) {
    try {
      if (!selfTest()) process.exitCode = 1;
    } catch (error) {
      process.stderr.write(`skill-audit self-test failed: ${error.message}\n`);
      process.exitCode = 1;
    }
    return;
  }
  const { findings } = run(options);
  process.stdout.write(options.json ? `${JSON.stringify({ findings }, null, 2)}\n` : `${report(findings).join('\n')}\n`);
}

main(process.argv.slice(2));
