import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_MAX_RETRIES,
  DEFAULT_MODEL,
  DEFAULT_TIMEOUT_MS,
  apiKeyPresence,
  configSummary,
  describeApiKeyPresence,
  parseDotEnv,
  readTypeSafeConfig,
} from '../lib/config.js';

const FAKE_KEY = 'ts_live_0123456789abcdef';

test('默认值：官方端点、jev-latest、30s 超时、2 次重试', () => {
  const config = readTypeSafeConfig({ env: {}, dotenv: {} });
  assert.equal(config.model, DEFAULT_MODEL);
  assert.equal(config.model, 'jev-latest');
  assert.equal(config.endpoint, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(config.timeoutMs, DEFAULT_TIMEOUT_MS);
  assert.equal(config.maxRetries, DEFAULT_MAX_RETRIES);
  assert.equal(config.apiKey, '');
});

test('优先级：显式覆盖 > 进程环境变量 > .env', () => {
  const sources = { dotenv: { TYPESAFE_API_KEY: 'from-dotenv', TYPESAFE_MODEL: 'model-from-dotenv' } };
  assert.equal(readTypeSafeConfig({ ...sources, env: { TYPESAFE_API_KEY: 'from-env' } }).apiKey, 'from-env');
  assert.equal(readTypeSafeConfig({ ...sources, env: {} }).apiKey, 'from-dotenv');
  const overrides = readTypeSafeConfig({ ...sources, env: { TYPESAFE_API_KEY: 'from-env' }, overrides: { apiKey: 'from-override' } });
  assert.equal(overrides.apiKey, 'from-override');
  assert.equal(readTypeSafeConfig({ env: { TYPESAFE_MODEL: 'jev-next' }, dotenv: { TYPESAFE_MODEL: 'ignored' } }).model, 'jev-next');
});

test('模型名：TYPESAFE_MODEL 优先，回退官方 JS SDK 的 TYPESAFE_DEFAULT_MODEL', () => {
  assert.equal(readTypeSafeConfig({ env: { TYPESAFE_DEFAULT_MODEL: 'jev-legacy' } }).model, 'jev-legacy');
  assert.equal(readTypeSafeConfig({ env: { TYPESAFE_MODEL: 'jev-next', TYPESAFE_DEFAULT_MODEL: 'jev-legacy' } }).model, 'jev-next');
});

test('非法数值退回默认值，0 是合法值（0 重试 / 不设超时）', () => {
  assert.equal(readTypeSafeConfig({ env: { TYPESAFE_TIMEOUT_MS: 'abc' } }).timeoutMs, DEFAULT_TIMEOUT_MS);
  assert.equal(readTypeSafeConfig({ env: { TYPESAFE_MAX_RETRIES: '-1' } }).maxRetries, DEFAULT_MAX_RETRIES);
  assert.equal(readTypeSafeConfig({ env: { TYPESAFE_MAX_RETRIES: '0' } }).maxRetries, 0);
  assert.equal(readTypeSafeConfig({ env: { TYPESAFE_TIMEOUT_MS: '0' } }).timeoutMs, 0);
  assert.equal(readTypeSafeConfig({ env: { TYPESAFE_TIMEOUT_MS: '99999999' } }).timeoutMs, DEFAULT_TIMEOUT_MS);
});

test('baseUrl 允许自建代理，末尾斜杠被归一化', () => {
  const config = readTypeSafeConfig({ env: { TYPESAFE_BASE_URL: 'https://typesafe.internal/' } });
  assert.equal(config.baseUrl, 'https://typesafe.internal');
  assert.equal(config.endpoint, 'https://typesafe.internal/v1/systemone');
});

test('.env 解析：注释、export 前缀、成对引号、值里的等号', () => {
  const parsed = parseDotEnv([
    '# 注释整行',
    '',
    'TYPESAFE_API_KEY="ts_live_0123456789abcdef"',
    "export TYPESAFE_MODEL='jev-latest'",
    'TYPESAFE_BASE_URL=https://api.example.com/?a=1',
    'NOT A PAIR',
    'EMPTY=',
  ].join('\n'));
  assert.deepEqual(parsed, {
    TYPESAFE_API_KEY: FAKE_KEY,
    TYPESAFE_MODEL: 'jev-latest',
    TYPESAFE_BASE_URL: 'https://api.example.com/?a=1',
    EMPTY: '',
  });
});

test('检查 KEY 只报存在/不存在，摘要里绝不含 KEY 原文', () => {
  assert.equal(apiKeyPresence(FAKE_KEY), '存在');
  assert.equal(apiKeyPresence('   '), '不存在');
  assert.equal(apiKeyPresence(undefined), '不存在');
  const present = readTypeSafeConfig({ env: { TYPESAFE_API_KEY: `  ${FAKE_KEY}  ` } });
  assert.equal(describeApiKeyPresence(present), '存在');
  assert.equal(present.apiKey, FAKE_KEY, 'KEY 本身要做 trim');
  assert.equal(describeApiKeyPresence(readTypeSafeConfig({ env: {} })), '不存在');

  const summary = configSummary(present);
  assert.equal(summary.apiKey, '存在');
  assert.equal(summary.apiKeyEnv, 'TYPESAFE_API_KEY');
  assert.equal(JSON.stringify(summary).includes(FAKE_KEY), false, '摘要不得携带 KEY 原文');
});
