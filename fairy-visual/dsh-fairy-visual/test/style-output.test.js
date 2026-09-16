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
    assert.equal(Buffer.byteLength(style.textContent), 135012);
    assert.equal(createHash('sha256').update(style.textContent).digest('hex'), '7d44ed23fa2f459d50cbddd9cc92ed905833ea66f83d5e8044228b8c4da1185c');
    injectStyles();
    assert.equal(nodes.size, 1);
  } finally {
    globalThis.document = originalDocument;
  }
});
