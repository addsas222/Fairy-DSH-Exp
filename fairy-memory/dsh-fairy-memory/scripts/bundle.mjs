#!/usr/bin/env node
/**
 * Deterministic build: every file under src/ is emitted to lib/ at the same
 * relative path, so `lib/**` is a build output and the build contract's
 * "outputs must not be older than the manifest" check has something to check.
 *
 * The host half is a 1:1 copy (the family does the same with
 * `cp src/index.js lib/index.js`). The client bundle is currently emitted
 * verbatim as well; when it grows past one file it should switch to the
 * tsdown config the sibling packages use (browser-dock / fairy-visual), with
 * `alwaysBundle` pulling in dsh-fairy-contracts instead of an embedded copy.
 */
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const sourceRoot = join(root, 'src');
const outputRoot = join(root, 'lib');

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
  await writeFile(temporary, await readFile(file));
  await rename(temporary, destination);
  emitted += 1;
}
process.stdout.write(`dsh-fairy-memory: emitted ${emitted} files to lib/\n`);
