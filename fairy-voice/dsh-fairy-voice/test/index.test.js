import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';
import { createFairyVoiceHandlers, markdownToSpeechText, normalizeSpeechText, splitSpeechSentences, writePrivateJson } from '../lib/index.js';

function requestWithJson(value) {
  const request = new EventEmitter();
  request[Symbol.asyncIterator] = async function* () {
    yield Buffer.from(JSON.stringify(value));
  };
  return request;
}

function responseDouble() {
  const response = new EventEmitter();
  response.statusCode = 200;
  response.headersSent = false;
  response.writableEnded = false;
  response.destroyed = false;
  response.setHeader = () => {};
  response.write = () => { response.headersSent = true; return true; };
  response.end = () => { response.writableEnded = true; };
  response.destroy = () => { response.destroyed = true; };
  return response;
}

function jsonResponse(value, ok = true) {
  return {
    ok,
    async json() { return value; },
  };
}

function capturingResponse() {
  const response = responseDouble();
  response.payload = null;
  response.end = (body) => { response.payload = body === undefined ? null : String(body); response.writableEnded = true; };
  return response;
}

/** The shipped speech-text pipeline with a counting markdown parser. */
async function loadingSpeechTextModule() {
  const source = (await readFile(new URL('../lib/index.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  const start = source.indexOf('const SPEECH_BLOCKS');
  const end = source.indexOf('function sendJson(res, status, value)');
  assert.ok(start >= 0 && end > start, 'speech text pipeline is missing');
  const module = { exports: {} };
  const parses = { count: 0 };
  const countingFromMarkdown = (...args) => { parses.count += 1; return fromMarkdown(...args); };
  new Function('module', 'exports', 'fromMarkdown', 'gfm', 'gfmFromMarkdown', 'normalizeSpeechText',
    `${source.slice(start, end).replace(/^export /gm, '')}\nmodule.exports = { markdownToSpeechText, speechTextFromMarkdownAst };`,
  )(module, module.exports, countingFromMarkdown, gfm, gfmFromMarkdown, normalizeSpeechText);
  return { ...module.exports, parses };
}

test('markdown speech extraction removes code and image content', () => {
  assert.equal(markdownToSpeechText('结论 **已完成**。\n\n```js\nignore()\n```'), '结论 已完成。');
});

test('private JSON writes are atomic, unique, and permission-restricted', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fairy-private-json-'));
  try {
    const file = join(directory, 'config.json');
    await Promise.all([
      writePrivateJson(file, { version: 1, value: 'first' }),
      writePrivateJson(file, { version: 1, value: 'second' }),
    ]);
    const value = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(value.version, 1);
    assert.ok(['first', 'second'].includes(value.value));
    // Windows has no POSIX permission bits: chmod there only toggles the
    // read-only flag, so 0o600 is not expressible and cannot be asserted.
    if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.deepEqual((await readdir(directory)).filter((name) => name.endsWith('.tmp')), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('markdown speech extraction preserves prose-block pauses', () => {
  assert.equal(markdownToSpeechText('第一项没有标点\n\n第二项也没有标点'), '第一项没有标点；第二项也没有标点；');
  assert.equal(markdownToSpeechText('- 状态已同步\n- 等待下一步'), '状态已同步；等待下一步；');
  assert.equal(markdownToSpeechText('已经结束。\n\n下一段'), '已经结束。下一段；');
});

test('speech normalization expands symbols and units conservatively', () => {
  assert.equal(normalizeSpeechText('Ⅲ——25°C，成功率 50%，日期 2024/08/17。'), '三，二十五摄氏度，成功率 百分之五十，日期 2024年08月17日。');
  assert.equal(normalizeSpeechText('x ≤ 3，A/B……'), 'x 小于等于 3，A/B……');
});

test('speech normalization handles advanced numeric and technical forms', () => {
  assert.equal(normalizeSpeechText('2026-08-17 14:30:05，1/2，3:1，10-20，¥1,234.50，3m²。'), '2026年08月17日 十四点三十分五秒，二分之一，三比一，十到二十，一千二百三十四点五零元，三平方米。');
  assert.equal(normalizeSpeechText('CPU API https://example.com a@b.com，α+β≈∞。'), '中央处理器 接口 链接 邮箱地址，阿尔法加贝塔约等于无穷大。');
});

test('speech normalization makes standalone decimal points explicit', () => {
  assert.equal(normalizeSpeechText('圆周率约为 3.1415926。记住 3.14 即可。'), '圆周率约为 三点一四一五九二六。记住 三点一四 即可。');
  assert.equal(normalizeSpeechText('误差 -.5，温度 -3.1415°C。'), '误差 负零点五，温度 负三点一四一五摄氏度。');
  assert.equal(normalizeSpeechText('版本 v3.1415。文件 build.2026 不改写。'), '版本 v3.1415。文件 build.2026 不改写。');
});

test('speech normalization strengthens Chinese and English colon pauses', () => {
  assert.equal(normalizeSpeechText('注意：这是英文 Note: Fairy::正在处理。'), '注意；这是英文 Note；Fairy；正在处理。');
  assert.equal(normalizeSpeechText('时间 14:30，比例 3:1，网址 https://fairy.example/a:b。'), '时间 十四点三十分，比例 三比一，网址 链接');
  assert.equal(normalizeSpeechText(normalizeSpeechText('注意：Note: Fairy。')), '注意；Note；Fairy。');
});

test('speech sentence splitting preserves numeric and ellipsis structure', () => {
  assert.deepEqual(splitSpeechSentences('数值 3.14，下一句。'), ['数值 三点一四，下一句。']);
  assert.deepEqual(splitSpeechSentences('……我在。主人已到位。'), ['……我在。', '主人已到位。']);
  assert.deepEqual(splitSpeechSentences('第一句；第二句！第三句？'), ['第一句；', '第二句!', '第三句?']);
  assert.deepEqual(splitSpeechSentences('？！……！！！'), ['?……!']);
});

test('long replies are split into playable batches', () => {
  const text = Array.from({ length: 24 }, (_, index) => `第${index + 1}句，Fairy正在处理这条信息。`).join('');
  const sentences = splitSpeechSentences(text);
  assert.equal(sentences.length, 24);
  assert.ok(sentences.every((sentence) => sentence.length <= 40));
});

test('empty replies do not schedule speech', () => {
  assert.deepEqual(splitSpeechSentences('   '), []);
});

test('status treats a non-2xx Fairy response as unavailable', async () => {
  const handlers = createFairyVoiceHandlers({ fetchImpl: async () => ({ ok: false, status: 500 }) });
  const response = responseDouble();
  await handlers.status({}, response);
  assert.equal(response.statusCode, 200);
  assert.equal(response.writableEnded, true);
});

test('closed downstream responses are never written to', async () => {
  const handlers = createFairyVoiceHandlers({ fetchImpl: async () => ({ ok: false, status: 500 }) });
  const response = responseDouble();
  response.destroyed = true;
  response.setHeader = () => { throw new Error('write to closed response'); };
  await handlers.status({}, response);
  assert.equal(response.writableEnded, false);
});

test('tts closes a partially written PCM response instead of appending JSON', async () => {
  const handlers = createFairyVoiceHandlers({
    fetchImpl: async () => ({
      ok: true,
      headers: { get: () => 'audio/raw' },
      body: {
        async *[Symbol.asyncIterator]() {
          yield Buffer.from([0, 0]);
          throw new Error('upstream disconnected');
        },
      },
    }),
  });
  const response = responseDouble();
  await handlers.tts(requestWithJson({ text: '测试' }), response);
  assert.equal(response.destroyed, true);
  assert.equal(response.writableEnded, false);
});

test('client disconnect aborts the still-open upstream PCM request', async () => {
  let upstreamSignal;
  const handlers = createFairyVoiceHandlers({
    fetchImpl: (_url, options) => new Promise((_resolve, reject) => {
      upstreamSignal = options.signal;
      options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }),
  });
  const request = requestWithJson({ text: '测试' });
  const response = responseDouble();
  const task = handlers.tts(request, response);
  await new Promise((resolve) => setImmediate(resolve));
  request.emit('aborted');
  await task;
  assert.equal(upstreamSignal.aborted, true);
});

test('plugin disposal aborts every active synthesis request', async () => {
  let upstreamSignal;
  const handlers = createFairyVoiceHandlers({
    fetchImpl: (_url, options) => new Promise((_resolve, reject) => {
      upstreamSignal = options.signal;
      options.signal.addEventListener('abort', () => reject(new Error('disposed')), { once: true });
    }),
  });
  const task = handlers.tts(requestWithJson({ text: '测试' }), responseDouble());
  await new Promise((resolve) => setImmediate(resolve));
  handlers.dispose();
  await task;
  assert.equal(upstreamSignal.aborted, true);
  assert.equal(upstreamSignal.reason, 'disposed');
});

test('newest synthesis request supersedes the prior shared-pipeline request', async () => {
  let firstSignal;
  let calls = 0;
  const handlers = createFairyVoiceHandlers({
    fetchImpl: (_url, options) => {
      calls += 1;
      if (calls === 1) {
        firstSignal = options.signal;
        return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('superseded')), { once: true }));
      }
      return Promise.resolve({
        ok: true,
        headers: { get: () => 'audio/raw' },
        body: { async *[Symbol.asyncIterator]() { yield Buffer.from([0, 0]); } },
      });
    },
  });
  const first = handlers.tts(requestWithJson({ text: '第一条' }), responseDouble());
  await new Promise((resolve) => setImmediate(resolve));
  const secondResponse = responseDouble();
  await handlers.tts(requestWithJson({ text: '第二条' }), secondResponse);
  await first;
  assert.equal(firstSignal.aborted, true);
  assert.equal(secondResponse.writableEnded, true);
});

test('local synthesis uses a restrained fragment pause for continuous speech', async () => {
  let request;
  const handlers = createFairyVoiceHandlers({
    fetchImpl: (_url, options) => {
      request = JSON.parse(options.body);
      return Promise.resolve({ ok: true, headers: { get: () => 'audio/raw' }, body: { async *[Symbol.asyncIterator]() { yield Buffer.from([0, 0]); } } });
    },
  });
  await handlers.tts(requestWithJson({ text: '连续播放检查。' }), responseDouble());
  assert.equal(request.fragment_interval, 0.14);
  assert.equal(request.streaming_mode, 1);
});

test('voice brain uses only the fixed non-thinking Flash model for long final-answer briefs', async () => {
  let request;
  const handlers = createFairyVoiceHandlers({
    readConfig: async () => ({ apiKey: 'sk-test-voice-brain-key-123456' }),
    fetchImpl: async (_url, options) => {
      request = { url: _url, options, body: JSON.parse(options.body) };
      return jsonResponse({ choices: [{ message: { content: '结论已经确认，接下来按建议执行即可。' } }] });
    },
  });
  const response = responseDouble();
  const longAnswer = '最终回答：' + '这是一段需要压缩的结论。'.repeat(40);
  await handlers.voiceBrief(requestWithJson({ markdown: longAnswer }), response);
  assert.equal(response.writableEnded, true);
  assert.equal(request.url, 'https://api.deepseek.com/chat/completions');
  assert.equal(request.body.model, 'deepseek-v4-flash');
  assert.equal(request.body.max_tokens, 400);
  assert.deepEqual(request.body.thinking, { type: 'disabled' });
  assert.equal(request.body.messages.at(-1).content.includes('默认控制在 80 到 180'), true);
  assert.equal(request.body.messages.some((message) => message.content.includes('搜索过程')), false);
  assert.equal(request.body.messages.at(-1).content.includes('这是一段需要压缩的结论'), true);
  assert.equal(request.body.messages.at(-1).content.includes('```'), false);
});

test('voice brain locally enforces the concise brief limit', async () => {
  const handlers = createFairyVoiceHandlers({
    readConfig: async () => ({ apiKey: 'sk-test-voice-brain-key-123456' }),
    fetchImpl: async () => jsonResponse({ choices: [{ message: { content: '这是过长的朗读内容。'.repeat(80) } }] }),
  });
  const response = responseDouble();
  let payload = '';
  response.end = (value) => { payload = String(value || ''); response.writableEnded = true; };
  await handlers.voiceBrief(requestWithJson({ markdown: '原始最终回答。'.repeat(50) }), response);
  const brief = JSON.parse(payload).brief;
  assert.ok(Array.from(brief).length <= 260);
});

test('voice brain does not call cloud when no key is configured', async () => {
  let calls = 0;
  const handlers = createFairyVoiceHandlers({ readConfig: async () => ({ apiKey: '' }), fetchImpl: async () => { calls += 1; return jsonResponse({}); } });
  const response = responseDouble();
  await handlers.voiceBrief(requestWithJson({ markdown: '一段足够长的最终回答。'.repeat(40) }), response);
  assert.equal(calls, 0);
  assert.equal(response.statusCode, 422);
});

test('voice brain status never exposes the API key', async () => {
  const handlers = createFairyVoiceHandlers({ readConfig: async () => ({ apiKey: 'sk-secret-voice-brain-key-123456' }) });
  const response = responseDouble();
  let payload = '';
  response.end = (value) => { payload = String(value || ''); response.writableEnded = true; };
  await handlers.voiceBrainStatus({}, response);
  assert.equal(payload.includes('sk-secret'), false);
  assert.deepEqual(JSON.parse(payload), { configured: true, model: 'deepseek-v4-flash' });
});

test('plain prose skips the markdown parser without changing the speech text', async () => {
  const { markdownToSpeechText: pipeline, speechTextFromMarkdownAst, parses } = await loadingSpeechTextModule();
  const astOnly = (markdown) => normalizeSpeechText(speechTextFromMarkdownAst(String(markdown || '')));
  const samples = [
    '第一段没有标记，包含数字 12.5 与单位 300 ms。\n第二行仍在同一段。\n\n第二段：AI / GPU，范围 10-20。',
    '单行纯文本',
    '带空格的段落  \n硬换行\n\n结束。',
    '段落没有终止符\n\n下一段。',
    // CommonMark counts a whitespace-only line as a blank line, and CRLF is
    // two line endings for the parser: both must keep the段落 boundary.
    'a\n \nb',
    'a\r\n\r\nb',
    '含制表符的空行\n\t\n下一段。',
    '多个空行\n\n\n\n收尾。',
    'a\r\nb\r\n\r\nc',
    '   缩进代码块',
    '实体 &amp; 与 &lt;tag&gt;',
    '数学 a < b 与 x > y',
    'issue #12 与 @user',
    '---',
    '- - -',
    '***',
    'a--b 与 3-4 与 --flag',
    '# 标题\n\n正文',
    '- 列表项\n- 第二项',
    '1. 有序\n2. 列表',
    '| a | b |\n| - | - |',
    '> 引用',
    '```js\ncode();\n```',
    '行内 `code` 文本',
    '[链接](https://example.com)',
    '**加粗** 与 _下划线_',
    '~~删除~~',
    '段落\n====\n',
    '<div>html</div>',
    '脚注[^1]',
    '',
  ];
  for (const sample of samples) {
    assert.equal(pipeline(sample), astOnly(sample), `speech text drifted for ${JSON.stringify(sample.slice(0, 40))}`);
  }
  // The shortcut has to be real, not just equivalent: prose must not reach the
  // parser, and anything markdown-shaped must.
  parses.count = 0;
  pipeline('纯文本没有控制符。\n\n第二段。');
  assert.equal(parses.count, 0);
  pipeline('# 标题');
  assert.equal(parses.count, 1);
});

test('sentence splitting accepts already-normalized text', () => {
  const prepared = markdownToSpeechText('结论 **已完成**。\n\n第二段包含 3.14 与 API 与 2024-05-06。');
  // Idempotence is what makes the shortcut safe, so assert it directly.
  assert.equal(normalizeSpeechText(prepared), prepared);
  assert.deepEqual(splitSpeechSentences(prepared, { normalized: true }), splitSpeechSentences(prepared));
});

test('an oversized text body is reported as a client error', async () => {
  const handlers = createFairyVoiceHandlers();
  const ttsResponse = capturingResponse();
  await handlers.tts(requestWithJson({ text: 'x'.repeat(25_000) }), ttsResponse);
  // The cap is enforced while reading the body, before any provider runs:
  // calling that a local service failure would hide the caller's mistake.
  assert.equal(ttsResponse.statusCode, 400);
  assert.deepEqual(JSON.parse(ttsResponse.payload), { error: { code: 'text-too-large', message: 'Text must not exceed 500 characters.' } });

  const briefResponse = capturingResponse();
  await handlers.voiceBrief(requestWithJson({ markdown: 'x'.repeat(150_000) }), briefResponse);
  assert.equal(briefResponse.statusCode, 400);
  assert.deepEqual(JSON.parse(briefResponse.payload), { error: { code: 'voice-brief-input-too-large', message: '最终回答过长，已使用原文朗读。' } });
});

test('server handlers use explicit speech, provider, and transport boundaries', async () => {
  const [source, pcmForward, localSovits, voiceBriefFallback] = await Promise.all([
    readFile(new URL('../lib/index.js', import.meta.url), 'utf8'),
    readFile(new URL('../lib/server/pcm-forward.js', import.meta.url), 'utf8'),
    readFile(new URL('../lib/providers/local-sovits.js', import.meta.url), 'utf8'),
    readFile(new URL('../lib/server/voice-brief-fallback.js', import.meta.url), 'utf8'),
  ]);
  assert.match(source, /function createSentencePreparation\(/);
  assert.match(source, /from '\.\/providers\/index\.js'/);
  assert.match(source, /from '\.\/server\/pcm-forward\.js'/);
  assert.match(source, /from '\.\/server\/voice-brief-fallback\.js'/);
  assert.match(pcmForward, /export function createPcmStreamHandler\(/);
  assert.match(localSovits, /export function createLocalTtsTransport\(/);
  assert.match(localSovits, /export function createLocalSovitsProvider\(/);
  assert.match(localSovits, /http:\/\/127\.0\.0\.1:9880/);
  assert.match(voiceBriefFallback, /export function createVoiceBrainServerBoundary\(/);
  assert.match(source, /const sentencePreparation = createSentencePreparation\(\)/);
  assert.match(source, /const pcmStreamHandler = createPcmStreamHandler\(\)/);
  assert.match(source, /providers = createProviderRegistry\(\{ fetchImpl \}\)/);
  assert.match(source, /settings = createVoiceSettingsBoundary\(\)/);
  assert.match(source, /const \{ id: providerId, provider, config \} = providers\.resolve\(settings\.read\(\)\)/);
  assert.match(source, /const voiceBrainBoundary = createVoiceBrainServerBoundary\(/);
});
