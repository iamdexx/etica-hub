#!/usr/bin/env node
/**
 * Extracts abi + bytecode for the EticaSwap Direct venue contracts from the
 * forge build output and writes the JSON consumed by /deploy/direct.
 *
 *   (cd packages/contracts && forge build)
 *   node packages/contracts/script/extract-direct-artifacts.mjs
 *
 * Output: apps/web/src/lib/direct-deploy-artifacts.json
 */
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const out = resolve(repoRoot, 'packages/contracts/out');

const sources = {
  directFactory: resolve(out, 'EticaDirectFactory.sol/EticaDirectFactory.json'),
  directRouter: resolve(out, 'EticaDirectRouter.sol/EticaDirectRouter.json'),
  directHarvesterAdapter: resolve(
    out,
    'DirectSwapHarvesterAdapter.sol/DirectSwapHarvesterAdapter.json',
  ),
};

const result = {};
for (const [name, path] of Object.entries(sources)) {
  try {
    statSync(path);
  } catch {
    console.error(`missing artifact for ${name}: ${path} — run forge build first`);
    process.exit(1);
  }
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  const bytecode = raw.bytecode?.object;
  if (!bytecode || !raw.abi) {
    console.error(`artifact at ${path} is missing bytecode or abi`);
    process.exit(1);
  }
  result[name] = { abi: raw.abi, bytecode };
  console.log(`${name}: abi=${raw.abi.length} entries, bytecode=${bytecode.length} chars`);
}

const dest = resolve(repoRoot, 'apps/web/src/lib/direct-deploy-artifacts.json');
writeFileSync(dest, JSON.stringify(result));
console.log(`wrote ${dest}`);
