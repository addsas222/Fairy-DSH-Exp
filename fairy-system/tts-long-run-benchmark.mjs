#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const iterations = Number.parseInt(process.env.DSH_TTS_BENCH_ITERATIONS || '50', 10);
const warmups = Number.parseInt(process.env.DSH_TTS_BENCH_WARMUPS || '3', 10);
const endpoint = process.env.DSH_TTS_BENCH_URL || 'http://127.0.0.1:3080/fairy-voice/tts';
const testText = process.env.DSH_TTS_BENCH_TEXT || '系统检查完成。';
const outputDir = join(dirname(fileURLToPath(import.meta.url)), 'benchmarks');
const date = new Date().toISOString().slice(0, 10);
const jsonFile = join(outputDir, `tts-long-run-${date}.json`);
const markdownFile = join(outputDir, `tts-long-run-${date}.md`);
const benchmarkStartedAt = new Date().toISOString();

if (!Number.isInteger(iterations) || iterations < 10) throw new Error('DSH_TTS_BENCH_ITERATIONS must be an integer of at least 10');
if (!Number.isInteger(warmups) || warmups < 0) throw new Error('DSH_TTS_BENCH_WARMUPS must be a non-negative integer');

function servicePid() {
  const output = execFileSync('pgrep', ['-f', 'api_v2.py -a 127.0.0.1 -p 9880'], { encoding: 'utf8' }).trim();
  const pids = output.split(/\s+/).filter(Boolean).map(Number).filter(Number.isInteger);
  if (pids.length !== 1) throw new Error(`expected exactly one local TTS service, found ${pids.length}`);
  return pids[0];
}

function rssKiB(pid) {
  const value = Number.parseInt(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim(), 10);
  if (!Number.isFinite(value)) throw new Error(`could not read RSS for PID ${pid}`);
  return value;
}

function physicalFootprintKiB(pid) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-tts-footprint-'));
  const output = join(directory, 'footprint.json');
  try {
    execFileSync('footprint', ['-p', String(pid), '-j', output], { stdio: 'ignore' });
    const report = JSON.parse(readFileSync(output, 'utf8'));
    const process = report.processes?.find((entry) => entry.pid === pid);
    const bytes = process?.auxiliary?.phys_footprint ?? process?.footprint;
    if (!Number.isFinite(bytes)) throw new Error(`could not read physical footprint for PID ${pid}`);
    return Math.round(bytes / 1024);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * fraction) - 1];
}

function median(values) {
  return percentile(values, 0.5);
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function regressionSlope(values) {
  const xMean = (values.length - 1) / 2;
  const yMean = mean(values);
  let numerator = 0;
  let denominator = 0;
  values.forEach((value, index) => {
    numerator += (index - xMean) * (value - yMean);
    denominator += (index - xMean) ** 2;
  });
  return denominator ? numerator / denominator : 0;
}

async function synthesize() {
  const started = performance.now();
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: testText }),
  });
  if (!response.ok) throw new Error(`TTS returned HTTP ${response.status}`);
  if (!response.body) throw new Error('TTS returned no response stream');
  const reader = response.body.getReader();
  const first = await reader.read();
  const firstByteMs = performance.now() - started;
  let bytes = first.value?.byteLength || 0;
  while (!first.done) {
    const chunk = await reader.read();
    if (chunk.done) break;
    bytes += chunk.value?.byteLength || 0;
  }
  if (bytes === 0) throw new Error('TTS returned empty audio');
  return { firstByteMs, totalMs: performance.now() - started, bytes };
}

const pid = servicePid();
process.stdout.write(`TTS benchmark: PID ${pid}; ${warmups} warmups + ${iterations} measured requests\n`);
for (let index = 0; index < warmups; index += 1) {
  await synthesize();
  process.stdout.write(`warmup ${index + 1}/${warmups}\n`);
}

const baselineRssKiB = rssKiB(pid);
// RSS alone is not a leak signal on macOS: after idle memory pressure, model
// pages can be swapped out and then become resident again during inference.
// Physical footprint includes those swapped pages, so it distinguishes page-in
// reheating from genuine process growth without perturbing request latency.
const baselinePhysicalFootprintKiB = physicalFootprintKiB(pid);
const samples = [];
for (let index = 0; index < iterations; index += 1) {
  const result = await synthesize();
  const sample = { iteration: index + 1, ...result, rssKiB: rssKiB(pid) };
  samples.push(sample);
  process.stdout.write(`${sample.iteration}/${iterations} first=${sample.firstByteMs.toFixed(1)}ms total=${sample.totalMs.toFixed(1)}ms rss=${(sample.rssKiB / 1024).toFixed(1)}MiB\n`);
}

const firstBytes = samples.map((sample) => sample.firstByteMs);
const totals = samples.map((sample) => sample.totalMs);
const rss = samples.map((sample) => sample.rssKiB);
const finalPhysicalFootprintKiB = physicalFootprintKiB(pid);
const windowSize = Math.min(10, Math.floor(samples.length / 2));
const firstWindow = samples.slice(0, windowSize);
const lastWindow = samples.slice(-windowSize);
const summary = {
  pid,
  endpoint,
  startedAt: benchmarkStartedAt,
  warmups,
  iterations,
  testText,
  failures: 0,
  latencyMs: {
    firstByteMedian: median(firstBytes),
    firstByteP95: percentile(firstBytes, 0.95),
    totalMedian: median(totals),
    totalP95: percentile(totals, 0.95),
    firstWindowMedian: median(firstWindow.map((sample) => sample.totalMs)),
    lastWindowMedian: median(lastWindow.map((sample) => sample.totalMs)),
  },
  memoryKiB: {
    baseline: baselineRssKiB,
    final: rss.at(-1),
    peak: Math.max(...rss),
    delta: rss.at(-1) - baselineRssKiB,
    regressionSlopePerRequest: regressionSlope(rss),
    physicalFootprintBaseline: baselinePhysicalFootprintKiB,
    physicalFootprintFinal: finalPhysicalFootprintKiB,
    physicalFootprintDelta: finalPhysicalFootprintKiB - baselinePhysicalFootprintKiB,
  },
};
const latencyRatio = summary.latencyMs.lastWindowMedian / summary.latencyMs.firstWindowMedian;
const optimizationRecommended = summary.memoryKiB.physicalFootprintDelta > 128 * 1024
  || latencyRatio > 1.25
  || summary.latencyMs.totalP95 > 2_000;
summary.decision = {
  optimizationRecommended,
  criteria: 'recommend when physical footprint grows >128 MiB, last-window median degrades >25%, or total p95 exceeds 2 s; RSS is diagnostic only because swapped model pages can become resident again',
  lastToFirstLatencyRatio: latencyRatio,
};

mkdirSync(outputDir, { recursive: true });
writeFileSync(jsonFile, `${JSON.stringify({ summary, samples }, null, 2)}\n`);
writeFileSync(markdownFile, [
  `# TTS long-run benchmark — ${date}`,
  '',
  `- Workload: ${warmups} warmups + ${iterations} sequential measured requests; fixed ${JSON.stringify(testText)} input`,
  `- First byte: median ${summary.latencyMs.firstByteMedian.toFixed(1)} ms; p95 ${summary.latencyMs.firstByteP95.toFixed(1)} ms`,
  `- Total: median ${summary.latencyMs.totalMedian.toFixed(1)} ms; p95 ${summary.latencyMs.totalP95.toFixed(1)} ms`,
  `- Window drift: first ${windowSize} median ${summary.latencyMs.firstWindowMedian.toFixed(1)} ms; last ${windowSize} median ${summary.latencyMs.lastWindowMedian.toFixed(1)} ms; ratio ${latencyRatio.toFixed(3)}`,
  `- TTS RSS: baseline ${(summary.memoryKiB.baseline / 1024).toFixed(1)} MiB; final ${(summary.memoryKiB.final / 1024).toFixed(1)} MiB; peak ${(summary.memoryKiB.peak / 1024).toFixed(1)} MiB; delta ${(summary.memoryKiB.delta / 1024).toFixed(1)} MiB`,
  `- RSS slope (diagnostic only): ${(summary.memoryKiB.regressionSlopePerRequest / 1024).toFixed(3)} MiB/request`,
  `- Physical footprint: baseline ${(summary.memoryKiB.physicalFootprintBaseline / 1024).toFixed(1)} MiB; final ${(summary.memoryKiB.physicalFootprintFinal / 1024).toFixed(1)} MiB; delta ${(summary.memoryKiB.physicalFootprintDelta / 1024).toFixed(1)} MiB`,
  `- Failures: ${summary.failures}`,
  `- Decision: ${optimizationRecommended ? 'optimization recommended' : 'no optimization indicated by this run'}`,
  `- Decision rule: ${summary.decision.criteria}`,
  '',
].join('\n'));
process.stdout.write(`Result: ${optimizationRecommended ? 'optimization recommended' : 'no optimization indicated'}\n${jsonFile}\n${markdownFile}\n`);
