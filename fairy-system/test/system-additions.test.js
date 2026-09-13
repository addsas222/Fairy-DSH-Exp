import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const scripts = {
  'skill-audit.js': fileURLToPath(new URL('../skill-audit.js', import.meta.url)),
  'scaffold-plugin.js': fileURLToPath(new URL('../scaffold-plugin.js', import.meta.url)),
};

function selfTest(name) {
  const result = spawnSync(process.execPath, [scripts[name], '--self-test'], { encoding: 'utf8' });
  assert.equal(result.status, 0, `${name} --self-test exited ${result.status}:\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

for (const name of Object.keys(scripts)) {
  test(`${name} self-test passes as a subprocess`, () => {
    assert.match(selfTest(name), /self-test passed/);
  });
}
