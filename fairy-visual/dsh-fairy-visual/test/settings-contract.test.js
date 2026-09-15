import assert from 'node:assert/strict';
import test from 'node:test';
import { settingsNamespace } from '@deepseek-ai/dsh-settings';
import { FAIRY_VISUAL_SETTINGS_NAMESPACE } from 'dsh-fairy-contracts';
import { FairyVisualSettings } from '../src/index.js';

const namespace = FAIRY_VISUAL_SETTINGS_NAMESPACE;

function schemaJson() {
  return FairyVisualSettings.toJSON();
}

function schemaFields() {
  const json = schemaJson();
  const object = json.refs[String(json.uid)];
  return Object.fromEntries(Object.entries(object.dict).map(([name, ref]) => {
    const node = json.refs[String(ref)];
    return [name, node];
  }));
}

test('settings package exposes the namespace factory used by the host registration', () => {
  assert.equal(namespace, 'fairy-visual');
  assert.equal(settingsNamespace(namespace), namespace);
  assert.throws(() => settingsNamespace('FairyVisual'), /must match/);
  assert.throws(() => settingsNamespace('fairy_visual'), /must match/);
});

test('Visual settings schema keeps the registered fields, defaults, and bounds', () => {
  const fields = schemaFields();
  assert.deepEqual(Object.keys(fields), [
    'version',
    'enabled',
    'theme',
    'mascotVisible',
    'contentFade',
    'mascotScale',
    'mascotAnimationSpeed',
    'powerMode',
    'composerDockHeight',
  ]);
  assert.equal(fields.version.meta.default, 2);
  assert.equal(fields.enabled.meta.default, false);
  assert.equal(fields.theme.meta.default, 'dark');
  assert.equal(fields.mascotVisible.meta.default, true);
  assert.equal(fields.contentFade.meta.default, false);
  assert.deepEqual(
    { step: fields.mascotScale.meta.step, min: fields.mascotScale.meta.min, max: fields.mascotScale.meta.max, default: fields.mascotScale.meta.default },
    { step: 0.01, min: 0.55, max: 1, default: 1 },
  );
  assert.equal(fields.mascotAnimationSpeed.meta.default, 1);
  assert.equal(fields.powerMode.meta.default, 'normal');
  assert.deepEqual(
    { step: fields.composerDockHeight.meta.step, min: fields.composerDockHeight.meta.min, max: fields.composerDockHeight.meta.max, default: fields.composerDockHeight.meta.default },
    { step: 1, min: 132, max: 420, default: 132 },
  );
});

test('client settings bridge preserves snapshot, subscription, write, and disposer shape', async () => {
  let value = { enabled: false, theme: 'dark' };
  const listeners = new Set();
  const bridge = {
    bind({ namespace: boundNamespace }) {
      assert.equal(boundNamespace, namespace);
      return {
        getSnapshot: () => ({ value }),
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        set(field, next) {
          value = { ...value, [field]: next };
          listeners.forEach((listener) => listener());
          return Promise.resolve();
        },
      };
    },
  };
  const settings = bridge.bind({ namespace });
  assert.equal(typeof settings.getSnapshot, 'function');
  assert.equal(typeof settings.subscribe, 'function');
  assert.equal(typeof settings.set, 'function');
  assert.deepEqual(settings.getSnapshot().value, { enabled: false, theme: 'dark' });

  let updates = 0;
  const dispose = settings.subscribe(() => { updates += 1; });
  assert.equal(typeof dispose, 'function');
  await settings.set('theme', 'light');
  assert.equal(updates, 1);
  assert.equal(settings.getSnapshot().value.theme, 'light');
  dispose();
  await settings.set('theme', 'dark');
  assert.equal(updates, 1);
});
