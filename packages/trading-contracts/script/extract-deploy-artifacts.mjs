#!/usr/bin/env node
/**
 * Extracts abi + bytecode for the trading stack contracts from their forge
 * build artifacts and writes a single JSON consumed by apps/web.
 *
 * Sources:
 *   Permit2                      ← packages/contracts/lib/permit2/out         (solc 0.8.17, via_ir)
 *   DutchOrderReactor            ← packages/trading-contracts/out             (solc 0.8.29)
 *   EticaProtocolFeeController   ← packages/trading-contracts/out             (solc 0.8.29)
 *
 * Build both Foundry projects first:
 *   (cd packages/contracts/lib/permit2 && forge build)
 *   (cd packages/trading-contracts    && forge build)
 *
 * Then run:
 *   node packages/trading-contracts/script/extract-deploy-artifacts.mjs
 *
 * Output:
 *   apps/web/src/lib/trading-deploy-artifacts.json
 */
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');

const sources = {
  permit2: resolve(repoRoot, 'packages/contracts/lib/permit2/out/Permit2.sol/Permit2.json'),
  reactor: resolve(repoRoot, 'packages/trading-contracts/out/DutchOrderReactor.sol/DutchOrderReactor.json'),
  feeController: resolve(
    repoRoot,
    'packages/trading-contracts/out/EticaProtocolFeeController.sol/EticaProtocolFeeController.json',
  ),
};

const out = {};
for (const [name, path] of Object.entries(sources)) {
  try {
    statSync(path);
  } catch {
    console.error(`missing artifact for ${name}: ${path}`);
    console.error(`did you run forge build in both foundry projects?`);
    process.exit(1);
  }
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  const bytecode = raw.bytecode?.object;
  const abi = raw.abi;
  if (!bytecode || !abi) {
    console.error(`artifact at ${path} is missing bytecode or abi`);
    process.exit(1);
  }
  out[name] = { abi, bytecode };
  console.log(`${name}: abi=${abi.length} entries, bytecode=${bytecode.length} chars`);
}

const dest = resolve(repoRoot, 'apps/web/src/lib/trading-deploy-artifacts.json');
writeFileSync(dest, JSON.stringify(out));
console.log(`wrote ${dest}`);
