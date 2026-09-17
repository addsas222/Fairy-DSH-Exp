import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  FairyModeService, apply, fairyModeProjectionDefinition,
} from '../lib/index.js';
import { readMode } from '../lib/store.js';

/* The mirror resolves `$DSH_HOME/fairy-modes/modes.json` per call, so pointing
 * DSH_HOME at a fresh temp dir per test keeps every assertion isolated and
 * leaves the developer's real home untouched. */
const ORIGINAL_HOME = process.env.DSH_HOME;
let mirrorHome;
test.beforeEach(() => {
  mirrorHome = mkdtempSync(join(tmpdir(), 'fairy-modes-test-'));
  process.env.DSH_HOME = mirrorHome;
});
test.afterEach(() => {
  if (ORIGINAL_HOME === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = ORIGINAL_HOME;
  rmSync(mirrorHome, { recursive: true, force: true });
});

/** A session double: the log plus the append the engine writes through. */
function fakeSession(id = 'session-1') {
  const log = [];
  return {
    id,
    log,
    append(type, data) {
      log.push({ type, seq: log.length, time: 0, data });
    },
  };
}

/**
 * Minimal host context for the agent half: the three injected services, their
 * captured registrations, and one `presentAs` scope that behaves like the
 * official one (a second declaration throws).
 */
function fakeHost({ presentAsConflicts = false, getSectionOrder } = {}) {
  const sections = new Map();
  const provided = new Map();
  const calls = { presentAs: [], releases: 0, commands: null, tools: [] };
  let presentation = null;

  const ctx = {
    provide(name, value) {
      provided.set(name, value);
      return () => provided.delete(name);
    },
    get: (name) => provided.get(name),
    on() {},
    effect(factory) {
      const cleanup = factory();
      return () => cleanup?.();
    },
    inject(deps, callback) {
      if (deps.includes('commands')) {
        callback({
          effect: (factory) => factory(),
          commands: {
            register(definition) {
              calls.commands = definition;
              return () => { calls.commands = null; };
            },
          },
        });
      }
      if (deps.includes('sessionQuery')) {
        callback({
          effect: (factory) => factory(),
          tools: ctx.tools,
          // A composed engine with the index open; recall's own tests cover the
          // degraded paths.
          sessionQuery: { searchSessions: async () => ({ items: [] }) },
        });
      }
      return null;
    },
    sessionProjections: {
      definition: null,
      register(definition) {
        this.definition = definition;
        return () => { this.definition = null; };
      },
      stateOf(session, key) {
        if (this.definition === null || this.definition.key !== key) return undefined;
        let state = this.definition.init();
        for (const event of session.log) state = this.definition.apply(state, event);
        return state;
      },
    },
    systemPrompt: {
      sections,
      // 0.1.1 has no getSectionOrder; 0.1.2+ passes one to select the `ptc` cohort.
      ...(getSectionOrder === undefined ? {} : { getSectionOrder }),
      section(definition) {
        if (sections.has(definition.name)) throw new Error(`duplicate prompt section ${definition.name}`);
        sections.set(definition.name, definition);
        return () => sections.delete(definition.name);
      },
    },
    tools: {
      register(definition) {
        calls.tools.push(definition);
        return () => {
          const at = calls.tools.indexOf(definition);
          if (at >= 0) calls.tools.splice(at, 1);
        };
      },
      presentAs(mode) {
        calls.presentAs.push(mode);
        if (presentAsConflicts || presentation !== null) {
          throw new Error(`tools.presentAs("${mode}") conflicts with a presentation already declared for this scope`);
        }
        presentation = mode;
        return () => {
          if (presentation !== mode) return;
          presentation = null;
          calls.releases += 1;
        };
      },
    },
  };

  return { ctx, sections, calls, presentationOf: () => presentation };
}

function mount(options) {
  const host = fakeHost(options);
  apply(host.ctx);
  const session = fakeSession();
  const agent = { session };
  return { ...host, session, agent, service: host.ctx.get('fairyMode') };
}

test('publishes the mode service and the projection unit', () => {
  const { ctx, service } = mount();
  assert.ok(service instanceof FairyModeService);
  assert.equal(typeof service.get, 'function');
  assert.equal(typeof service.set, 'function');
  assert.equal(ctx.sessionProjections.definition, fairyModeProjectionDefinition);
  assert.equal(fairyModeProjectionDefinition.key, 'fairyMode');
  assert.equal(fairyModeProjectionDefinition.stateVersion, 1);
});

test('registers the recall tool in every mode for a stable tool catalog', () => {
  const { calls, service, agent } = mount();
  assert.deepEqual(calls.tools.map(tool => tool.name), ['mode_pipeline', 'session_recall']);
  const registered = calls.tools[0];
  service.set(agent, 'create');
  service.set(agent, 'ptc');
  service.set(agent, 'off');
  assert.equal(calls.tools.length, 2, 'mode switches never touch the tool catalog');
  assert.equal(calls.tools[0], registered);
});

test('set records the mode in the mirror and never writes the log', () => {
  const { service, agent, session } = mount();
  assert.equal(service.set(agent, 'ptc'), 'committed');
  assert.equal(readMode('session-1'), 'ptc');
  assert.equal(session.log.length, 0, 'an out-of-vocabulary event must never enter the log');

  assert.equal(service.set(agent, 'create'), 'committed');
  assert.equal(readMode('session-1'), 'create');
  assert.equal(session.log.length, 0);

  // The legacy projection unit survives as the read-only compatibility path
  // for logs written before the mirror: applying it by hand still folds.
  const folded = fairyModeProjectionDefinition.apply(
    fairyModeProjectionDefinition.init(),
    { type: 'fairy/mode', data: { mode: 'create' } },
  );
  assert.deepEqual(folded, { mode: 'create' });
  assert.deepEqual(fairyModeProjectionDefinition.wire.view(folded), { mode: 'create' });

  // A log with no mode folds to off, and an unknown payload never moves it.
  assert.deepEqual(fairyModeProjectionDefinition.init(), { mode: 'off' });
  assert.deepEqual(
    fairyModeProjectionDefinition.apply({ mode: 'ptc' }, { type: 'fairy/mode', data: { mode: 'bogus' } }),
    { mode: 'ptc' },
  );
});

test('ptc drives the scoped presentation and the prompt section, and off restores both', () => {
  const { service, agent, sections, calls, presentationOf } = mount();
  assert.equal(service.set(agent, 'ptc'), 'committed');
  assert.deepEqual(calls.presentAs, ['code']);
  assert.equal(presentationOf(), 'code');
  assert.deepEqual([...sections.keys()], ['fairy:pipeline', 'fairy:mode-ptc']);
  // 51 = one step after the official plan:policy section (order 50), which is
  // the literal this harness cohort expects; getSectionOrder does not exist here.
  // 0.1.1 cohort: plan:policy sits at literal order 50, the value is `code`.
  assert.equal(sections.get('fairy:mode-ptc').order, 51);
  assert.match(sections.get('fairy:mode-ptc').text, /run_code/);

  // Switching modes moves the presentation to whoever should hold it.
  assert.equal(service.set(agent, 'create'), 'committed');
  assert.equal(presentationOf(), null);
  assert.equal(calls.releases, 1);
  assert.deepEqual([...sections.keys()], ['fairy:pipeline', 'fairy:mode-create']);
  assert.match(sections.get('fairy:mode-create').text, /session_recall/);
  assert.doesNotMatch(sections.get('fairy:mode-create').text, /session_search/);
  assert.match(sections.get('fairy:mode-create').text, /skill-audit\.js/);

  assert.equal(service.set(agent, 'off'), 'committed');
  // 流水线说明段落在每种模式下都在场：模式切换只换模式段落。
  assert.deepEqual([...sections.keys()], ['fairy:pipeline']);
  assert.equal(presentationOf(), null);
  assert.equal(calls.releases, 1);
  assert.deepEqual(service.get(agent), { mode: 'off' });
});

test('a scope that already declared a presentation still records the mode', () => {
  const { service, agent, sections, presentationOf } = mount({ presentAsConflicts: true });
  assert.equal(service.set(agent, 'ptc'), 'committed');
  assert.equal(presentationOf(), null);
  assert.equal(service.loggedMode(agent.session), 'ptc');
  assert.deepEqual([...sections.keys()], ['fairy:pipeline', 'fairy:mode-ptc']);
});

test('repeat selection is a noop and never duplicates mirror or section entries', () => {
  const { service, agent, session, sections } = mount();
  service.set(agent, 'ptc');
  assert.equal(service.set(agent, 'ptc'), 'noop');
  assert.equal(readMode('session-1'), 'ptc');
  assert.equal(session.log.length, 0, 'noop leaves the log alone');
  assert.equal(sections.size, 2, '流水线段落 + 当前模式段落');
  assert.equal(service.set(agent, 'off'), 'committed');
  assert.equal(service.set(agent, 'off'), 'noop');
  assert.equal(readMode('session-1'), 'off');
  assert.equal(session.log.length, 0);
});

test('get() reconciles a legacy log-carried mode (sessions written before the mirror)', () => {
  const { service, agent, session, sections, presentationOf } = mount();
  // A resumed pre-mirror log already holds the mode while the realm holds no effect.
  session.append('fairy/mode', { mode: 'ptc' });
  assert.deepEqual(service.get(agent), { mode: 'ptc' });
  assert.equal(presentationOf(), 'code');
  assert.deepEqual([...sections.keys()], ['fairy:pipeline', 'fairy:mode-ptc']);
  // Re-reading is idempotent.
  const registered = sections.get('fairy:mode-ptc');
  assert.deepEqual(service.get(agent), { mode: 'ptc' });
  assert.equal(sections.get('fairy:mode-ptc'), registered);
});

test('a fresh service instance reads the mode back from the mirror (restart)', () => {
  const first = mount();
  assert.equal(first.service.set(first.agent, 'ptc'), 'committed');
  // A new realm over the same home and session id: nothing in memory, the
  // mirror file is the only carrier.
  const second = mount();
  assert.deepEqual(second.service.get(second.agent), { mode: 'ptc' });
  assert.equal(second.presentationOf(), 'code', 'the live effects reconcile from the mirror');
  assert.deepEqual([...second.sections.keys()], ['fairy:pipeline', 'fairy:mode-ptc']);
});

test('an unknown mode is rejected without touching the log', () => {
  const { service, agent, session } = mount();
  assert.throws(() => service.set(agent, 'fast'), /未知的 Fairy 模式 "fast"/);
  assert.equal(session.log.length, 0);
  assert.deepEqual(service.get(agent), { mode: 'off' });
});

test('/mode parses ptc|create|off and reports usage otherwise', () => {
  const { service, agent, session, calls } = mount();
  assert.ok(calls.commands !== null, 'the command child registers /mode');
  assert.equal(calls.commands.name, 'mode');

  assert.deepEqual(service.command(agent, 'ptc'), { kind: 'success', text: '已切换到PTC 建造模式。' });
  assert.equal(readMode('session-1'), 'ptc');
  assert.deepEqual(service.command(agent, ' create '), { kind: 'success', text: '已切换到创造模式。' });
  assert.equal(readMode('session-1'), 'create');
  assert.deepEqual(service.command(agent, 'off'), { kind: 'success', text: '已切换到默认（关闭）模式。' });
  assert.equal(readMode('session-1'), 'off');
  assert.deepEqual(service.command(agent, ''), { kind: 'error', text: '用法：/mode explore|ptc|create|roleplay|off' });
  assert.deepEqual(service.command(agent, 'nope'), { kind: 'error', text: '未知模式 "nope"；可用：explore、ptc、create、roleplay、off。' });
  assert.equal(session.log.length, 0, 'the log stays clean across /mode');

  // The handler the registry holds is the same body, and says so when the
  // selected mode is already in force.
  assert.deepEqual(calls.commands.handler({ agent, rawInput: 'ptc' }), {
    kind: 'success', text: '已切换到PTC 建造模式。',
  });
  assert.deepEqual(calls.commands.handler({ agent, rawInput: 'ptc' }), {
    kind: 'success', text: '当前已是PTC 建造模式。',
  });
  assert.deepEqual(service.command(undefined, 'ptc'), {
    kind: 'error', text: '/mode 需要一个会话：当前调用没有 agent。',
  });
});

test('the 0.1.2+ cohort gets the ptc presentation value and the 501 order', () => {
  const { service, agent, sections, calls, presentationOf } = mount({ getSectionOrder: (name) => (name === 'PLAN_POLICY' ? 500 : 0) });
  assert.equal(service.set(agent, 'ptc'), 'committed');
  assert.deepEqual(calls.presentAs, ['ptc']);
  assert.equal(presentationOf(), 'ptc');
  assert.equal(sections.get('fairy:mode-ptc').order, 501);
});

test('the mounted pipeline tool resolves the official plan controller by name', async () => {
  const { ctx, agent, calls, session } = mount();
  const gate = [];
  let asked = null;
  // 解析器在调用时才读 ctx，所以挂载后替换 get() 就能覆盖按名寻址那一步。
  ctx.get = (name) => {
    asked = name;
    return name === 'agentPresets'
      ? { serviceFor: (_agent, serviceName) => (serviceName === 'planMode' ? { set: (_a, active) => { gate.push(active); return 'committed'; } } : undefined) }
      : undefined;
  };
  const tool = calls.tools.find((entry) => entry.name === 'mode_pipeline');
  assert.ok(tool, 'mode_pipeline is registered at mount');
  const result = await tool.execute({ action: 'enter', stage: 'explore' }, { agent });
  assert.equal(asked, 'agentPresets', 'the resolver asks the preset registry');
  assert.deepEqual(gate, [true], 'the official plan gate is opened through the resolver');
  assert.equal(result.stage, 'explore');
  assert.equal(readMode('session-1'), 'explore', 'and the read-only station is mirrored');
  assert.equal(session.log.length, 0, 'the station switch stays out of the log');
});
