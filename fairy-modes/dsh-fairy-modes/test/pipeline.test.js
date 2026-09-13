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
  assert.deepEqual(applied, ['explore'], 'the explore station is its own read-only mode');
  assert.equal(state.mode, 'explore');
  assert.equal(result.stage, 'explore', 'the report names the station it moved to');
  assert.match(result.report, /阶段：探查/);
  assert.match(result.report, /\/plan/, 'opening the official plan gate is spelled out');
});

test('leaving the explore station points at the official exit tool while plan is on', async () => {
  const { tool, exec, applied } = harness({ mode: 'explore', planActive: true });
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

test('entering the explore station opens the official plan gate when it resolves', async () => {
  const state = { mode: 'roleplay', planActive: false };
  const gate = [];
  const service = { loggedMode: () => state.mode, set: (_agent, value) => { state.mode = value; return 'committed'; }, ctx: {} };
  const tool = createModePipelineTool({
    service,
    readPlan: () => ({ active: state.planActive }),
    resolvePlanMode: () => ({ set: (_agent, active) => { gate.push(active); state.planActive = active; return 'committed'; } }),
  });
  const result = await tool.execute({ action: 'enter', stage: 'explore' }, { agent: { session: {} } });
  assert.deepEqual(gate, [true], 'the gate is opened for the caller');
  assert.equal(state.mode, 'explore', 'and the read-only station is recorded on the fairy side');
  assert.equal(result.stage, 'explore');
  assert.equal(result.advanced, true);
});

test('a queued plan entry and an unresolvable gate are both reported honestly', async () => {
  const queued = harness({ mode: 'roleplay' });
  const queuedTool = createModePipelineTool({
    service: { loggedMode: () => 'roleplay', set: () => 'committed', ctx: {} },
    readPlan: () => ({ active: false }),
    resolvePlanMode: () => ({ set: () => 'queued' }),
  });
  const queuedResult = await queuedTool.execute({ action: 'enter', stage: 'explore' }, queued.exec);
  assert.match(queuedResult.report, /排队|生效/, 'a queued entry is not reported as done');

  const bare = harness({ mode: 'roleplay' });
  const bareResult = await bare.tool.execute({ action: 'enter', stage: 'explore' }, bare.exec);
  assert.match(bareResult.report, /\/plan/, 'without a controller the user is told how to open the gate');
});

test('leaving the explore station never closes the official gate for the user', async () => {
  const state = { mode: 'explore', planActive: true };
  const gate = [];
  const tool = createModePipelineTool({
    service: { loggedMode: () => state.mode, set: (_agent, value) => { state.mode = value; return 'committed'; }, ctx: {} },
    readPlan: () => ({ active: state.planActive }),
    resolvePlanMode: () => ({ set: (_agent, active) => { gate.push(active); return 'committed'; } }),
  });
  const result = await tool.execute({ action: 'advance' }, { agent: { session: {} } });
  assert.deepEqual(gate, [], 'only exit_plan_mode closes the gate');
  assert.equal(result.stage, 'ptc');
  assert.match(result.report, /exit_plan_mode/);
});

test('advanced follows the real switch outcome, not the presence of notes', async () => {
  const tool = createModePipelineTool({
    service: { loggedMode: () => 'roleplay', set: () => 'noop', ctx: {} },
    readPlan: () => ({ active: false }),
  });
  const noop = await tool.execute({ action: 'advance' }, { agent: { session: {} } });
  assert.equal(noop.advanced, false, 'a noop switch is not an advance');
  const status = await tool.execute({ action: 'status' }, { agent: { session: {} } });
  assert.equal(status.advanced, false, 'status never reports an advance');
});
