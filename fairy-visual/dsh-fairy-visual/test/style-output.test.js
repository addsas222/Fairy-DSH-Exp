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
    assert.equal(Buffer.byteLength(style.textContent), 140564);
    assert.equal(createHash('sha256').update(style.textContent).digest('hex'), '073fd9f620f244056a69be04823a98a529c04b81d0e9c018afcd9d10d4fb8998');
    injectStyles();
    assert.equal(nodes.size, 1);
  } finally {
    globalThis.document = originalDocument;
  }
});
