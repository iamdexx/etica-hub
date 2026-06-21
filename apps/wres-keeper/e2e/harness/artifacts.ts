/**
 * Build-artifact loader for the harness.
 *
 * EVM contracts (mocks + the real RESLockVault/ETRX) are read from their Foundry
 * `out/` dirs. The TRON contracts (WrappedRESMiner, TrxReserve) are read from
 * vendored copies under `e2e/vendor/tron/` — see each file's `_provenance`.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Abi } from 'viem';

const here = dirname(fileURLToPath(import.meta.url));
/** apps/wres-keeper */
const keeperRoot = resolve(here, '..', '..');
/** repo root (etica-hub) */
const repoRoot = resolve(keeperRoot, '..', '..');

export interface Artifact {
  abi: Abi;
  /** 0x-prefixed creation bytecode. */
  bytecode: `0x${string}`;
  /** Raw creation bytecode WITHOUT the 0x prefix (tronweb wants this form). */
  bytecodeRaw: string;
}

function load(path: string): Artifact {
  const json = JSON.parse(readFileSync(path, 'utf8')) as {
    abi: Abi;
    bytecode: string | { object: string };
  };
  const raw = typeof json.bytecode === 'string' ? json.bytecode : json.bytecode.object;
  const bytecodeRaw = raw.replace(/^0x/, '');
  return { abi: json.abi, bytecode: `0x${bytecodeRaw}`, bytecodeRaw };
}

const mocksOut = resolve(keeperRoot, 'e2e/contracts/out/Mocks.sol');
const contractsOut = resolve(repoRoot, 'packages/contracts/out');
const tronVendor = resolve(keeperRoot, 'e2e/vendor/tron');

// EVM-side (deployed to anvil)
export const MockRESNFT = () => load(resolve(mocksOut, 'MockRESNFT.json'));
export const MockETX = () => load(resolve(mocksOut, 'MockETX.json'));
export const MockDexRouter = () => load(resolve(mocksOut, 'MockDexRouter.json'));
export const RESLockVault = () => load(resolve(contractsOut, 'RESLockVault.sol/RESLockVault.json'));
export const ETRX = () => load(resolve(contractsOut, 'ETRX.sol/ETRX.json'));

// TRON-side (deployed to the java-tron node)
export const MockCoreReactor = () => load(resolve(mocksOut, 'MockCoreReactor.json'));
export const WrappedRESMiner = () => load(resolve(tronVendor, 'WrappedRESMiner.json'));
export const TrxReserve = () => load(resolve(tronVendor, 'TrxReserve.json'));
