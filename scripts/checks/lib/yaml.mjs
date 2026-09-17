// YAML 子集解析器（零依赖）。
//
// 为什么自己写：本仓库的每个包各自带锁文件、CI 不装根级依赖，质量体系又要求
// 「主入口不硬编码检查项」——检查项配置必须是数据（.agent/checks/*.yaml）。引一个
// YAML 依赖意味着要动某个包的依赖树或引入根级工程（硬约束禁止），所以这里实现
// 质量配置**实际用到**的那部分 YAML：
//
//   支持：块映射、块序列（含 `- key: value` 内联首键）、流式 `[...]` / `{...}`、
//         单/双引号标量（含转义）、布尔/null/数字、`|`/`>` 块标量（含 `-`/`+` 修饰）、
//         `#` 注释、逐行定位的报错。
//   不支持（故意）：锚点/别名、多文档、复杂键、折叠标量的跨行缩进推断、时间戳类型。
//         遇到 `&`/`*`/`<<` 开头的值会明确报错而不是静默猜。
//
// 解析失败抛 YamlError（带文件名与行号），质量体系据此把配置错误报成 error 而不是
// 静默跳过检查项。

export class YamlError extends Error {
  constructor(message, filename, line) {
    super(`${filename}:${line}: ${message}`);
    this.name = 'YamlError';
    this.filename = filename;
    this.line = line;
  }
}

const ESCAPES = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', 0: '\0', b: '\b', f: '\f' };

function stripComment(text) {
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (quote === '"' && ch === '\\') { i += 1; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    // `#` 只有在行首或前面是空白时才是注释（与 YAML 规范一致：a#b 是普通字符）
    if (ch === '#' && (i === 0 || /\s/.test(text[i - 1]))) return text.slice(0, i);
  }
  return text;
}

function tokenize(text, filename) {
  const rawLines = text.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/);
  const tokens = [];
  for (let i = 0; i < rawLines.length; i += 1) {
    const raw = rawLines[i];
    const line = i + 1;
    if (/^[ \t]*$/.test(raw)) continue;
    const indentMatch = /^[ ]*/.exec(raw);
    const indent = indentMatch[0].length;
    const afterIndent = raw.slice(indent);
    if (afterIndent.startsWith('\t')) throw new YamlError('缩进不允许使用制表符', filename, line);
    const content = stripComment(afterIndent).replace(/[ ]+$/, '');
    if (content === '') continue;
    const stripped = content.trimStart();
    if (stripped.startsWith('&') || stripped.startsWith('*') || stripped.startsWith('<<')) {
      throw new YamlError(`不支持锚点/别名/合并键（值以 ${stripped[0]} 开头）`, filename, line);
    }
    tokens.push({ indent, content, line, raw: rawLines[i] });
  }
  return tokens;
}

function unquote(text, filename, line) {
  const quote = text[0];
  if (text[text.length - 1] !== quote || text.length < 2) {
    throw new YamlError(`引号未闭合：${text}`, filename, line);
  }
  const body = text.slice(1, -1);
  if (quote === "'") return body.replace(/''/g, "'");
  let out = '';
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch !== '\\') { out += ch; continue; }
    const next = body[i + 1];
    if (next === undefined) throw new YamlError('转义序列不完整', filename, line);
    if (next === 'u') {
      const hex = body.slice(i + 2, i + 6);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new YamlError(`\\u 转义需要 4 位十六进制：${hex}`, filename, line);
      out += String.fromCharCode(parseInt(hex, 16));
      i += 5;
      continue;
    }
    if (!(next in ESCAPES)) throw new YamlError(`不支持的转义 \\${next}`, filename, line);
    out += ESCAPES[next];
    i += 1;
  }
  return out;
}

function scalarOrValue(text, filename, line) {
  const value = text.trim();
  if (/^(&|\*|<<|!)/.test(value)) {
    throw new YamlError(`不支持锚点/别名/标签/合并键：${value}`, filename, line);
  }
  if (value === '' || value === '~' || value === 'null' || value === 'Null' || value === 'NULL') return null;
  if (value === 'true' || value === 'True' || value === 'TRUE') return true;
  if (value === 'false' || value === 'False' || value === 'FALSE') return false;
  if (value.startsWith('"') || value.startsWith("'")) return unquote(value, filename, line);
  if (value.startsWith('[') || value.startsWith('{')) return parseFlow(value, filename, line);
  if (/^[+-]?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/.test(value)) return Number(value);
  return value;
}

// 流式集合：只支持一层嵌套与扁平标量（配置里够用），`[a, b]` / `{a: 1, b: 2}`。
function parseFlow(text, filename, line) {
  let i = 0;
  function skipWs() { while (i < text.length && /\s/.test(text[i])) i += 1; }
  function parseValue() {
    skipWs();
    const ch = text[i];
    if (ch === '[') {
      i += 1;
      const arr = [];
      skipWs();
      if (text[i] === ']') { i += 1; return arr; }
      for (;;) {
        arr.push(parseValue());
        skipWs();
        if (text[i] === ',') { i += 1; continue; }
        if (text[i] === ']') { i += 1; return arr; }
        throw new YamlError(`流式序列语法错误（位置 ${i}）：${text}`, filename, line);
      }
    }
    if (ch === '{') {
      i += 1;
      const obj = {};
      skipWs();
      if (text[i] === '}') { i += 1; return obj; }
      for (;;) {
        skipWs();
        const keyStart = i;
        while (i < text.length && !':,}'.includes(text[i])) i += 1;
        const key = text.slice(keyStart, i).trim().replace(/^['"]|['"]$/g, '');
        if (text[i] !== ':') throw new YamlError(`流式映射语法错误（位置 ${i}）：${text}`, filename, line);
        i += 1;
        obj[key] = parseValue();
        skipWs();
        if (text[i] === ',') { i += 1; continue; }
        if (text[i] === '}') { i += 1; return obj; }
        throw new YamlError(`流式映射语法错误（位置 ${i}）：${text}`, filename, line);
      }
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      let j = i + 1;
      while (j < text.length) {
        if (quote === '"' && text[j] === '\\') { j += 2; continue; }
        if (text[j] === quote) {
          if (quote === "'" && text[j + 1] === "'") { j += 2; continue; }
          break;
        }
        j += 1;
      }
      if (j >= text.length) throw new YamlError(`流式标量引号未闭合：${text}`, filename, line);
      const raw = text.slice(i, j + 1);
      i = j + 1;
      return unquote(raw, filename, line);
    }
    const start = i;
    while (i < text.length && !',]}'.includes(text[i])) i += 1;
    return scalarOrValue(text.slice(start, i), filename, line);
  }
  const result = parseValue();
  skipWs();
  if (i !== text.length) throw new YamlError(`流式值后有多余内容：${text.slice(i)}`, filename, line);
  return result;
}

function isMappingLine(content) {
  // 裸 `key:` 或 `key: value`；key 不含空格（含空格的键必须加引号）
  return /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s#:[{,}]+):(\s|$)/.test(content);
}

function splitKey(content, filename, line) {
  const match = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s:]+):[ ]?/.exec(content);
  if (!match) throw new YamlError(`无法解析键：${content}`, filename, line);
  const key = match[1].startsWith('"') || match[1].startsWith("'")
    ? unquote(match[1], filename, line)
    : match[1];
  return { key, rest: content.slice(match[0].length) };
}

function parseBlockScalar(tokens, index, header, filename) {
  const style = header[0];
  const chomp = header.slice(1);
  const parts = [];
  let i = index + 1;
  let blockIndent = null;
  for (; i < tokens.length; i += 1) {
    const tok = tokens[i];
    if (blockIndent === null) blockIndent = tok.indent;
    if (tok.indent < blockIndent) break;
    parts.push(tok.raw.slice(blockIndent));
  }
  // 空行信息在 tokenize 里被丢掉了，块标量里的空行按“段落”近似：不重建空行，
  // 但按 `>`（折叠）与 `|`（保留换行）区分——质量配置里的块标量都是短说明文本。
  let text = style === '>' ? parts.join(' ') : parts.join('\n');
  if (chomp !== '-' && parts.length > 0) text += '\n';
  if (chomp === '+') text += '\n';
  return { value: text, next: i };
}

function parseNode(tokens, index, minIndent, filename) {
  const first = tokens[index];
  if (first === undefined || first.indent < minIndent) return { value: null, next: index };
  // 块的真实缩进取的是**该块第一行**的缩进，而不是调用方给的期望值——
  // 否则 2 空格缩进的子块会被当成"多余的缩进"。
  const indent = first.indent;
  const isSeq = first.content === '-' || first.content.startsWith('- ');
  if (isSeq) return parseSequence(tokens, index, indent, filename);
  return parseMapping(tokens, index, indent, filename);
}

function parseSequence(tokens, index, indent, filename) {
  const items = [];
  let i = index;
  while (i < tokens.length) {
    const tok = tokens[i];
    if (tok.indent < indent) break;
    if (tok.indent > indent) throw new YamlError(`序列项缩进不一致：${tok.content}`, filename, tok.line);
    if (!(tok.content === '-' || tok.content.startsWith('- '))) break;
    const contentOffset = tok.content === '-' ? tok.content.length : 2;
    const itemIndent = tok.indent + contentOffset;
    const rest = tok.content.slice(contentOffset);
    if (rest === '') {
      const nested = parseNode(tokens, i + 1, indent + 2, filename);
      items.push(nested.value);
      i = nested.next;
      continue;
    }
    if (isMappingLine(rest) || rest.startsWith('- ') || rest === '-') {
      // 把 `- key: value` 改写成一条缩进到内容位置的映射行，复用 parseMapping
      const rewritten = tokens.slice();
      rewritten[i] = { indent: itemIndent, content: rest, line: tok.line, raw: ' '.repeat(itemIndent) + rest };
      const parsed = parseNode(rewritten, i, itemIndent, filename);
      items.push(parsed.value);
      i = parsed.next;
      continue;
    }
    items.push(scalarOrValue(rest, filename, tok.line));
    i += 1;
  }
  return { value: items, next: i };
}

function parseMapping(tokens, index, indent, filename) {
  const obj = {};
  let i = index;
  while (i < tokens.length) {
    const tok = tokens[i];
    if (tok.indent < indent) break;
    if (tok.indent > indent) throw new YamlError(`多余的缩进（键或序列项缺失）：${tok.content}`, filename, tok.line);
    if (tok.content === '-' || tok.content.startsWith('- ')) break;
    if (!isMappingLine(tok.content)) throw new YamlError(`不是合法的 key: value：${tok.content}`, filename, tok.line);
    const { key, rest } = splitKey(tok.content, filename, tok.line);
    if (rest.trimStart().startsWith('|') || rest.trimStart().startsWith('>')) {
      const header = rest.trim();
      const { value, next } = parseBlockScalar(tokens, i, header, filename);
      obj[key] = value;
      i = next;
      continue;
    }
    if (rest.trim() !== '') {
      obj[key] = scalarOrValue(rest, filename, tok.line);
      i += 1;
      continue;
    }
    const nested = parseNode(tokens, i + 1, indent + 1, filename);
    if (nested.next === i + 1) {
      obj[key] = null;
      i += 1;
      continue;
    }
    obj[key] = nested.value;
    i = nested.next;
  }
  return { value: obj, next: i };
}

export function parseYaml(text, options = {}) {
  const filename = options.filename || '<yaml>';
  if (typeof text !== 'string') throw new YamlError('输入不是字符串', filename, 1);
  const tokens = tokenize(text, filename);
  if (tokens.length === 0) return null;
  const parsed = parseNode(tokens, 0, tokens[0].indent, filename);
  if (parsed.next < tokens.length) {
    const leftover = tokens[parsed.next];
    throw new YamlError(`文件尾有多余内容：${leftover.content}`, filename, leftover.line);
  }
  return parsed.value;
}

export function parseYamlFile(fs, filePath) {
  return parseYaml(fs.readFileSync(filePath, 'utf8'), { filename: filePath });
}
