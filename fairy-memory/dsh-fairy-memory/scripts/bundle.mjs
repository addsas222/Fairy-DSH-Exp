#!/usr/bin/env node
/**
 * Deterministic build: every file under src/ is emitted to lib/ at the same
 * relative path, so `lib/**` is a build output and the build contract's
 * "outputs must not be older than the manifest" check has something to check.
 *
 * The host half is a 1:1 copy (the family does the same with
 * `cp src/index.js lib/index.js`). The client half additionally inlines every
 * `require('…/fairy-contracts/<file>.cjs')` it contains: the client bundle runs
 * against the shell's frozen module table, so a shared contract file has to be
 * part of the bundle — the same thing tsdown's `alwaysBundle` does for the
 * sibling packages (browser-dock / fairy-visual). The inlined text keeps a
 * `>>>`/`<<<` marker pair so `test/client-contract.test.js` can prove the copy
 * still matches the single source of truth byte for byte.
 */
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const sourceRoot = join(root, 'src');
const outputRoot = join(root, 'lib');

/** A shared contract file, required by relative path from a client source. */
const CONTRACT_REQUIRE = /require\((['"])((?:\.\.\/)+fairy-contracts\/[^'"]+\.cjs)\1\)/g;

const beginMarker = (name) => `// >>> fairy-contracts/${name} (inlined by scripts/bundle.mjs — 不要手改)`;
const endMarker = (name) => `// <<< fairy-contracts/${name}`;

/**
 * Replace each contract require with the contract's own module body. The
 * markers stay in the output because that is what the package test reads.
 *
 * @param code - one source file's text.
 * @param file - that file's path, the base for resolving the relative require.
 * @returns the text to emit.
 */
async function inlineContracts(code, file) {
  const matches = [...code.matchAll(CONTRACT_REQUIRE)];
  if (matches.length === 0) return code;
  let output = '';
  let cursor = 0;
  for (const match of matches) {
    const specifier = match[2];
    const name = specifier.slice(specifier.lastIndexOf('/') + 1);
    const body = await readFile(resolve(dirname(file), specifier), 'utf8');
    output += code.slice(cursor, match.index);
    output += [
      '(() => {',
      '  const module = { exports: {} };',
      beginMarker(name),
      body.replace(/\s+$/, ''),
      endMarker(name),
      '  return module.exports;',
      '})()',
    ].join('\n');
    cursor = match.index + match[0].length;
  }
  return output + code.slice(cursor);
}

async function* walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else yield path;
  }
}

let emitted = 0;
for await (const file of walk(sourceRoot)) {
  const target = join(outputRoot, relative(sourceRoot, file));
  // The client source is named index.js inside src/client/ but ships as
  // lib/client.js, which is what the manifest's exports declare.
  const destination = relative(sourceRoot, file) === join('client', 'index.js') ? join(outputRoot, 'client.js') : target;
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.tmp`;
  await writeFile(temporary, await inlineContracts(await readFile(file, 'utf8'), file));
  await rename(temporary, destination);
  emitted += 1;
}
process.stdout.write(`dsh-fairy-memory: emitted ${emitted} files to lib/\n`);
