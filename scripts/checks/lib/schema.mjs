// JSON Schema（draft-07 子集）校验器（零依赖）。
//
// 用途：`.agent/quality.schema.json` 必须**真实生效**，否则它就是一份装饰文档。
// 主入口用它在执行前校验 .agent/quality.yaml 与每个 .agent/checks/*.yaml；
// 配置文件写错时得到带 JSON 路径的明确报错，而不是运行到一半才炸。
//
// 支持的关键字（质量配置用到的全部）：$ref（仅文档内 #/$defs/... 与 #/definitions/...）、
// type（含数组形式）、required、properties、additionalProperties（bool 或 schema）、
// items、enum、const、pattern、minimum、maximum、minLength、maxLength、minItems、
// uniqueItems、oneOf、anyOf、allOf、not、patternProperties、default 忽略。
// 不支持：外部 $ref、$dynamicRef、if/then/else、dependentSchemas、format 语义校验。

export class SchemaError extends Error {
  constructor(errors) {
    super(errors.map((e) => `${e.path || '<root>'}: ${e.message}`).join('; '));
    this.name = 'SchemaError';
    this.errors = errors;
  }
}

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function matchesType(value, type) {
  switch (type) {
    case 'object': return typeOf(value) === 'object';
    case 'array': return Array.isArray(value);
    case 'integer': return Number.isInteger(value);
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'string': return typeof value === 'string';
    case 'boolean': return typeof value === 'boolean';
    case 'null': return value === null;
    default: return true;
  }
}

function resolveRef(ref, root) {
  if (!ref.startsWith('#/')) throw new SchemaError([{ path: ref, message: '只支持文档内 #/ 引用' }]);
  const parts = ref.slice(2).split('/').map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'));
  let node = root;
  for (const part of parts) {
    if (node === undefined || node === null) break;
    node = node[part];
  }
  if (node === undefined) throw new SchemaError([{ path: ref, message: '引用目标不存在' }]);
  return node;
}

function validateNode(value, schema, root, path, errors, depth = 0) {
  if (depth > 40) return;
  if (schema === true || schema === undefined) return;
  if (schema === false) {
    errors.push({ path, message: '该值被 schema 禁止' });
    return;
  }
  if (schema.$ref) {
    validateNode(value, resolveRef(schema.$ref, root), root, path, errors, depth + 1);
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => matchesType(value, t))) {
      errors.push({ path, message: `类型应为 ${types.join('|')}，实际是 ${typeOf(value)}` });
      return;
    }
  }
  if (schema.const !== undefined && value !== schema.const) {
    errors.push({ path, message: `必须等于 ${JSON.stringify(schema.const)}` });
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push({ path, message: `取值必须是 ${schema.enum.map((v) => JSON.stringify(v)).join(' / ')} 之一` });
  }
  if (schema.not && (() => {
    const local = [];
    validateNode(value, schema.not, root, path, local, depth + 1);
    return local.length === 0;
  })()) {
    errors.push({ path, message: '命中了 schema 的 not 分支' });
  }
  if (schema.oneOf) {
    const matched = schema.oneOf.filter((sub) => {
      const local = [];
      validateNode(value, sub, root, path, local, depth + 1);
      return local.length === 0;
    });
    if (matched.length !== 1) {
      errors.push({ path, message: `oneOf 需要恰好命中 1 个分支，实际 ${matched.length} 个` });
    }
  }
  if (schema.anyOf) {
    const matched = schema.anyOf.some((sub) => {
      const local = [];
      validateNode(value, sub, root, path, local, depth + 1);
      return local.length === 0;
    });
    if (!matched) errors.push({ path, message: 'anyOf 没有任何分支匹配' });
  }
  if (schema.allOf) {
    for (const sub of schema.allOf) validateNode(value, sub, root, path, errors, depth + 1);
  }
  if (typeof value === 'string') {
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      errors.push({ path, message: `不匹配 pattern ${schema.pattern}` });
    }
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push({ path, message: `长度小于 ${schema.minLength}` });
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push({ path, message: `长度大于 ${schema.maxLength}` });
    }
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push({ path, message: `小于最小值 ${schema.minimum}` });
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push({ path, message: `大于最大值 ${schema.maximum}` });
    }
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push({ path, message: `元素少于 ${schema.minItems} 个` });
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push({ path, message: `元素多于 ${schema.maxItems} 个` });
    }
    if (schema.uniqueItems) {
      const seen = new Set();
      for (const item of value) {
        const key = JSON.stringify(item);
        if (seen.has(key)) errors.push({ path, message: `存在重复元素 ${key}` });
        seen.add(key);
      }
    }
    if (schema.items) {
      value.forEach((item, i) => validateNode(item, schema.items, root, `${path}[${i}]`, errors, depth + 1));
    }
  }
  if (value && typeOf(value) === 'object') {
    for (const key of schema.required || []) {
      if (!(key in value)) errors.push({ path, message: `缺少必填字段 ${key}` });
    }
    const props = schema.properties || {};
    for (const [key, sub] of Object.entries(props)) {
      if (key in value) validateNode(value[key], sub, root, `${path}.${key}`, errors, depth + 1);
    }
    for (const [pattern, sub] of Object.entries(schema.patternProperties || {})) {
      for (const [key, val] of Object.entries(value)) {
        if (new RegExp(pattern).test(key)) validateNode(val, sub, root, `${path}.${key}`, errors, depth + 1);
      }
    }
    if (schema.additionalProperties !== undefined) {
      for (const key of Object.keys(value)) {
        if (key in props) continue;
        if (Object.keys(schema.patternProperties || {}).some((p) => new RegExp(p).test(key))) continue;
        if (schema.additionalProperties === false) {
          errors.push({ path: `${path}.${key}`, message: '未知字段（schema 未声明）' });
        } else if (typeof schema.additionalProperties === 'object') {
          validateNode(value[key], schema.additionalProperties, root, `${path}.${key}`, errors, depth + 1);
        }
      }
    }
  }
}

/**
 * 校验一个值。
 * @param value 待校验的值
 * @param schema 生效的子 schema（可以是文档里的某个 $defs 片段）
 * @param path 错误信息里的起始路径
 * @param rootSchema `$ref` 的解析根（通常是整份 schema 文档）；缺省时用 schema 自身
 * @returns {string[]} 人类可读的错误列表（空数组 = 通过）
 */
export function validateAgainstSchema(value, schema, path = '$', rootSchema = schema) {
  const errors = [];
  validateNode(value, schema, rootSchema, path, errors);
  return errors.map((e) => `${e.path}: ${e.message}`);
}
