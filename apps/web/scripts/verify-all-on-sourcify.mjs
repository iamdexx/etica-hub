#!/usr/bin/env node
/*
 * Bulk Sourcify status check for every contract in DEPLOYMENTS[61803].
 *
 * Reads addresses straight from packages/shared/src/addresses.ts and queries
 * https://sourcify.dev/server/v2/contract/{chainId}/{address} per address.
 * Prints a status table and exits non-zero if any contract is unverified —
 * suitable for wiring into a CI periodic check.
 *
 * Usage:
 *   node apps/web/scripts/verify-all-on-sourcify.mjs
 *
 * To verify a contract that comes back unverified, see
 * docs/SOURCIFY_VERIFICATION.md.
 */
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const ADDRESSES_TS = resolve(REPO_ROOT, 'packages/shared/src/addresses.ts');

const CHAIN_ID = 61803;
const SOURCIFY_BASE = 'https://sourcify.dev/server';

// Friendly labels for each addresses.ts key. Anything not in this map is
// reported under its raw key name.
const LABELS = {
  etx: 'ETX',
  wegaz: 'WEGAZ',
  swapFactory: 'EticaSwapFactory',
  swapRouter: 'EticaSwapRouter',
  permit2: 'Permit2',
  dutchReactor: 'DutchOrderReactor',
  etxFeeController: 'EticaProtocolFeeController',
  orderRegistry: 'OrderRegistry',
  stakedETX: 'StakedETX',
  treasuryHarvester: 'TreasuryHarvester',
  etxFarms: 'ETXFarms',
  eticaStableSwap: 'EticaStableSwap',
  liquidityTimelock10y: 'LiquidityTimelock10y',
  stableSwapHarvesterAdapter: 'StableSwapHarvesterAdapter',
  eticaResearchMarkets: 'EticaResearchMarkets',
};

// Keys we explicitly do not verify (placeholders, unset, etc.).
const SKIP_KEYS = new Set(['researchSubscription']);

const ZERO_ADDR = '0x0000000000000000000000000000000000000000';

function parseDeployments(source, chainId) {
  // Parse the addresses.ts DEPLOYMENTS block:
  //   export const DEPLOYMENTS: ... = {
  //     <chainId>: { key: '0x...', ... }
  //   }
  // We don't want a full TS parser dependency — a focused regex anchored to
  // the DEPLOYMENTS export keeps the script standalone and avoids matching
  // unrelated <chainId> blocks (e.g. LEGACY_ADDRESSES).
  const deploymentsIdx = source.indexOf('DEPLOYMENTS');
  if (deploymentsIdx < 0) {
    throw new Error('could not find DEPLOYMENTS export in addresses.ts');
  }
  const blockRe = new RegExp(`${chainId}\\s*:\\s*\\{([\\s\\S]*?)\\}`, 'm');
  const block = source.slice(deploymentsIdx).match(blockRe);
  if (!block) {
    throw new Error(`could not find DEPLOYMENTS[${chainId}] block in addresses.ts`);
  }
  const entries = [];
  const entryRe = /(\w+)\s*:\s*'(0x[0-9a-fA-F]{40})'/g;
  let m;
  while ((m = entryRe.exec(block[1])) !== null) {
    entries.push({key: m[1], address: m[2]});
  }
  return entries;
}

async function sourcifyStatus(address) {
  const url = `${SOURCIFY_BASE}/v2/contract/${CHAIN_ID}/${address}`;
  const res = await fetch(url);
  if (res.status === 404) return 'unverified';
  if (!res.ok) return `http_${res.status}`;
  const body = await res.json();
  return body?.match ?? 'unverified';
}

function pad(s, width) {
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

async function main() {
  const source = readFileSync(ADDRESSES_TS, 'utf8');
  const entries = parseDeployments(source, CHAIN_ID);

  let unverifiedCount = 0;

  console.log(`Sourcify status for DEPLOYMENTS[${CHAIN_ID}]`);
  console.log('='.repeat(80));
  console.log(`${pad('Contract', 30)} ${pad('Address', 44)} Status`);
  console.log('-'.repeat(80));

  for (const {key, address} of entries) {
    if (SKIP_KEYS.has(key)) continue;
    if (address === ZERO_ADDR) continue;
    const label = LABELS[key] ?? key;
    let status;
    try {
      status = await sourcifyStatus(address);
    } catch (err) {
      status = `error:${err.message}`;
    }
    const ok = status === 'exact_match' || status === 'match';
    if (!ok) unverifiedCount += 1;
    const tag = ok ? '\u2713' : '\u2717';
    console.log(`${pad(label, 30)} ${pad(address, 44)} ${tag} ${status}`);
  }

  console.log('-'.repeat(80));
  if (unverifiedCount === 0) {
    console.log('All contracts verified.');
    process.exit(0);
  } else {
    console.log(`${unverifiedCount} contract(s) unverified. See docs/SOURCIFY_VERIFICATION.md.`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
