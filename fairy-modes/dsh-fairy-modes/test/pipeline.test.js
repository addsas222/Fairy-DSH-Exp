import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FAIRY_PIPELINE_STAGES,
  nextPipelineStage,
  pipelineStageOf,
} from '../lib/contract.js';
import { PIPELINE_SECTION_TEXT, createModePipelineTool } from '../lib/pipeline.js';

/** 假的服务 + 假的 plan 投影：流水线只依赖这两个读数。 */
function harness({ mode = 'roleplay', planActive = false } = {}) {
  const state = { mode, planActive };
  const applied = [];
  const service = {
    get mode() { return state.mode; },
    apply: applied,
    loggedMode: () => state.mode,
    set: (_agent, value) => { applied.push(value); state.mode = value; return 'committed'; },
    ctx: {},
  };
  const tool = createModePipelineTool({ service, readPlan: () => ({ active: state.planActive }) });
  const exec = { agent: { session: { id: 's1' } } };
  return { state, applied, tool, exec };
}

test('the stage is the plan projection when plan mode is on, the fairy mode otherwise', () => {
  assert.equal(pipelineStageOf({ planActive: true, mode: 'roleplay' }), 'explore');
  assert.equal(pipelineStageOf({ planActive: true, mode: 'ptc' }), 'explore');
  assert.equal(pipelineStageOf({ planActive: false, mode: 'create' }), 'create');
  assert.equal(pipelineStageOf({ planActive: false, mode: 'off' }), 'off');
  assert.equal(pipelineStageOf({ planActive: false, mode: 'nonsense' }), 'off');
});

test('the pipeline is a ring, and the idle state re-enters at roleplay', () => {
  assert.deepEqual(FAIRY_PIPELINE_STAGES, ['roleplay', 'explore', 'ptc', 'create']);
  assert.equal(nextPipelineStage('roleplay'), 'explore');
  assert.equal(nextPipelineStage('explore'), 'ptc');
  assert.equal(nextPipelineStage('ptc'), 'create');
  assert.equal(nextPipelineStage('create'), 'roleplay');
  assert.equal(nextPipelineStage('off'), 'roleplay');
  assert.equal(nextPipelineStage('nonsense'), 'roleplay', 'an unknown station starts the ring over');
});

test('the section text explains every station and the create-stage duties', () => {
  for (const label of ['扮演', '探查', '建造', '创造']) assert.ok(PIPELINE_SECTION_TEXT.includes(label), `missing ${label}`);
  assert.match(PIPELINE_SECTION_TEXT, /skill-audit\.js/);
  assert.match(PIPELINE_SECTION_TEXT, /合并或删除/);
  assert.match(PIPELINE_SECTION_TEXT, /以用户为准/);
});

test('status reports the current stage and never writes', async () => {
  const { tool, exec, applied } = harness({ mode: 'ptc' });
  const result = await tool.execute({ action: 'status' }, exec);
  assert.equal(result.stage, 'ptc');
  assert.equal(result.mode, 'ptc');
  assert.equal(result.planActive, false);
  assert.match(result.report, /阶段：建造/);
  assert.match(result.report, /下一步：创造/);
  assert.deepEqual(applied, [], 'status must not switch anything');
});

test('advance moves one station and reports the target, not the stale read', async () => {
  const { tool, exec, applied, state } = harness({ mode: 'roleplay' });
  const result = await tool.execute({ action: 'advance' }, exec);
  assert.deepEqual(applied, ['off'], 'the explore station runs the default agent mode');
  assert.equal(state.mode, 'off');
  assert.equal(result.stage, 'explore', 'the report names the station it moved to');
  assert.match(result.report, /阶段：探查/);
  assert.match(result.report, /\/plan/, 'opening the official plan gate is spelled out');
});

test('leaving the explore station points at the official exit tool while plan is on', async () => {
  const { tool, exec, applied } = harness({ mode: 'off', planActive: true });
  const result = await tool.execute({ action: 'advance' }, exec);
  assert.deepEqual(applied, ['ptc']);
  assert.equal(result.stage, 'ptc');
  assert.match(result.report, /exit_plan_mode/);
});

test('enter takes an explicit station and finish returns to roleplay', async () => {
  const first = harness({ mode: 'roleplay' });
  assert.equal((await first.tool.execute({ action: 'enter', stage: 'create' }, first.exec)).stage, 'create');
  assert.deepEqual(first.applied, ['create']);
  const second = harness({ mode: 'create' });
  const done = await second.tool.execute({ action: 'finish' }, second.exec);
  assert.deepEqual(second.applied, ['roleplay']);
  assert.equal(done.stage, 'roleplay');
});

test('advancing from the idle state enters the pipeline at roleplay', async () => {
  const { tool, exec, applied } = harness({ mode: 'off' });
  const result = await tool.execute({ action: 'advance' }, exec);
  assert.deepEqual(applied, ['roleplay']);
  assert.equal(result.stage, 'roleplay');
});

test('bad input fails loudly with INVALID_ARGS', async () => {
  const { tool, exec } = harness();
  await assert.rejects(() => tool.execute({ action: 'jump' }, exec), (error) => error.code === 'INVALID_ARGS');
  await assert.rejects(() => tool.execute({ action: 'enter', stage: 'nowhere' }, exec), (error) => error.code === 'INVALID_ARGS');
  await assert.rejects(() => tool.execute({ action: 'enter' }, exec), (error) => error.code === 'INVALID_ARGS');
  await assert.rejects(() => tool.execute({ action: 'status' }, undefined), (error) => error.code === 'INVALID_ARGS');
});

test('the tool declares its shape for the registry', () => {
  const { tool } = harness();
  assert.equal(tool.name, 'mode_pipeline');
  assert.equal(typeof tool.execute, 'function');
  assert.equal(typeof tool.output.render, 'function');
  assert.equal(tool.isConcurrencySafe(), false, 'switching a session mode is not concurrency safe');
  assert.deepEqual(tool.parameters.required, ['action']);
});
