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
    assert.equal(Buffer.byteLength(style.textContent), 146124);
    assert.equal(createHash('sha256').update(style.textContent).digest('hex'), '94d5b69f502b749d0eb019582daf7a79b203e07ede94c4303f82efca61e10c30');
    injectStyles();
    assert.equal(nodes.size, 1);
  } finally {
    globalThis.document = originalDocument;
  }
});
