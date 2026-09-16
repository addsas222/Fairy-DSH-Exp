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
    assert.equal(Buffer.byteLength(style.textContent), 135589);
    assert.equal(createHash('sha256').update(style.textContent).digest('hex'), '73348963d974a2427dedf6b756f5e39dc9831c3310e2baad0a622f6477c5f2df');
    injectStyles();
    assert.equal(nodes.size, 1);
  } finally {
    globalThis.document = originalDocument;
  }
});
