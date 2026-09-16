import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { injectStyles } from '../src/client/style.js';

test('emits the approved scoped CSS byte sequence', () => {
  const originalDocument = globalThis.document;
  const nodes = new Map();
  globalThis.document = {
    getElementById: (id) => nodes.get(id) || null,
    createElement: () => ({ id: '', textContent: '', setAttribute() {} }),
    head: { appendChild: (node) => nodes.set(node.id, node) },
    documentElement: null,
  };

  try {
    injectStyles();
    const [style] = nodes.values();
    assert.equal(Buffer.byteLength(style.textContent), 143693);
    assert.equal(createHash('sha256').update(style.textContent).digest('hex'), 'a5e4651270933dbb0b634b2e21d744cb7a5184f4211cf7e1e521b7e30bbac011');
    injectStyles();
    assert.equal(nodes.size, 1);
  } finally {
    globalThis.document = originalDocument;
  }
});
