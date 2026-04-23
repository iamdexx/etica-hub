#!/usr/bin/env node
/**
 * Build Sourcify-compatible metadata bundles for each deployed EticaHub
 * production contract.
 *
 * For each (address, artifactPath) mapping below, this script produces:
 *
 *   docs/submissions/sourcify-bundle/<address>/
 *     metadata.json       — the solc compiler metadata (verbatim rawMetadata)
 *     sources/<path>.sol  — every source referenced by metadata.sources
 *     README.md           — contract summary + upload instructions
 *
 * Run after `forge build` on both packages/contracts and
 * packages/trading-contracts so the artifacts are fresh.
 *
 * Usage:
 *   node scripts/build-sourcify-bundle.mjs
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const WEB_ROOT = resolve(__dirname, '..');
const REPO_ROOT = resolve(WEB_ROOT, '../..');
const CONTRACTS_ROOT = resolve(REPO_ROOT, 'packages/contracts');
const TRADING_ROOT = resolve(REPO_ROOT, 'packages/trading-contracts');
const BUNDLE_ROOT = resolve(REPO_ROOT, 'docs/submissions/sourcify-bundle');

/**
 * Each entry describes one deployed contract:
 *   address        — mainnet address (EIP-55 checksum)
 *   artifact       — forge artifact path (relative to REPO_ROOT)
 *   contractsRoot  — package root used to resolve metadata.sources paths
 *   name           — display name for the bundle README
 *   summary        — one-liner for the README
 */
const CONTRACTS = [
  {
    address: '0x232fb2B87CAce92B2438054A7eB79B4081E3E11a',
    artifact: 'packages/contracts/out/WEGAZ.sol/WEGAZ.json',
    contractsRoot: CONTRACTS_ROOT,
    name: 'WEGAZ',
    summary: 'Wrapped EGAZ (ERC-20 wrapping of the native coin).',
  },
  {
    address: '0xa5A1Bc6307b0b87989B8456D4b35F88a68650044',
    artifact: 'packages/contracts/out/ETXToken.sol/ETXToken.json',
    contractsRoot: CONTRACTS_ROOT,
    name: 'ETXToken',
    summary: 'EticaHub governance / reward token (ERC-20).',
  },
  {
    address: '0xfc8dE5A5087c8825AA54E2C57B3FFe0e23784bc3',
    artifact: 'packages/contracts/out/EticaSwapFactory.sol/EticaSwapFactory.json',
    contractsRoot: CONTRACTS_ROOT,
    name: 'EticaSwapFactory',
    summary: 'EticaSwap V2 factory — permissionless ETX-hub pair creation.',
  },
  {
    address: '0xaefbf3fB975657a4C71ea0Fb644B4afE5F555723',
    artifact: 'packages/contracts/out/EticaSwapRouter.sol/EticaSwapRouter.json',
    contractsRoot: CONTRACTS_ROOT,
    name: 'EticaSwapRouter',
    summary: 'EticaSwap V2 router — swaps + addLiquidity/removeLiquidity.',
  },
  {
    address: '0x75d81d03a98CD9195593b8963aF17E13fAa70334',
    artifact: 'packages/contracts/out/StakedETX.sol/StakedETX.json',
    contractsRoot: CONTRACTS_ROOT,
    name: 'StakedETX',
    summary: 'ERC-4626 liquid-staking vault for ETX (stETX).',
  },
  {
    address: '0xB9b36258642D94823A6d6059c5a7B54c441BC7E9',
    artifact: 'packages/contracts/out/ETXFarms.sol/ETXFarms.json',
    contractsRoot: CONTRACTS_ROOT,
    name: 'ETXFarms',
    summary: 'MasterChef-style LP staking — ETX emissions for EticaSwap LPs.',
  },
  {
    address: '0xE2fc7EAcEB0146560bfcf46CC5B167df60E970B8',
    artifact: 'packages/trading-contracts/out/DutchOrderReactor.sol/DutchOrderReactor.json',
    contractsRoot: TRADING_ROOT,
    name: 'DutchOrderReactor',
    summary: 'UniswapX Dutch-order reactor — MEV-protected limit-order settlement.',
  },
  {
    address: '0xB9a4FbfC4cA598Be18e09bb9C0Cf19e4a1A4350a',
    artifact:
      'packages/trading-contracts/out/EticaProtocolFeeController.sol/EticaProtocolFeeController.json',
    contractsRoot: TRADING_ROOT,
    name: 'EticaProtocolFeeController',
    summary: 'ETX-denominated protocol-fee controller for the Dutch reactor.',
  },
  {
    address: '0xA6f3e48Cf31DcE3a8d36659f5bC6a61785c404a9',
    artifact: 'packages/trading-contracts/out/OrderRegistry.sol/OrderRegistry.json',
    contractsRoot: TRADING_ROOT,
    name: 'OrderRegistry',
    summary: 'On-chain open-order registry read by the keeper and /trade/orders UI.',
  },
];

function ensureDir(p) {
  mkdirSync(p, { recursive: true });
}

function resolveSource(relPath, contractsRoot) {
  // Forge records paths relative to the package root (`src/...`, `lib/...`).
  const candidates = [join(contractsRoot, relPath)];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  throw new Error(
    `Could not resolve source "${relPath}" under "${contractsRoot}". ` +
      `Tried: ${candidates.join(', ')}`,
  );
}

function writeBundleReadme(entry, meta, outDir) {
  const solc = meta.compiler?.version ?? 'unknown';
  const optRuns = meta.settings?.optimizer?.runs ?? 'unknown';
  const evmVersion = meta.settings?.evmVersion ?? 'unknown';
  const target = Object.entries(meta.settings?.compilationTarget ?? {})[0] ?? ['?', '?'];
  const [targetFile, targetName] = target;

  const body = `# ${entry.name}

**Address:** \`${entry.address}\`
**Summary:** ${entry.summary}

## Compilation settings

- **Solc:** \`${solc}\`
- **Optimizer:** enabled, \`${optRuns}\` runs
- **EVM version:** \`${evmVersion}\`
- **Compilation target:** \`${targetFile}:${targetName}\`

## Sourcify upload

1. Open https://sourcify.dev/#/verifier once chain 61803 is supported (tracking in https://github.com/argotorg/sourcify/pull/2755 / https://github.com/sourcifyeth/sourcify-chains/pull/XXX).
2. Select **Chain:** Etica Mainnet (id 61803).
3. Enter **Address:** \`${entry.address}\`.
4. Drop the files in this bundle directory into the uploader:
   - \`metadata.json\`
   - every \`.sol\` under \`sources/\`
5. Sourcify will recompile using the metadata settings and compare against the on-chain deployed bytecode.

Expected match level: **exact** or **partial** depending on whether the metadata hash embedded in the deployed bytecode matches this metadata.json's IPFS hash. A partial match still marks the contract as verified with source code on https://repo.sourcify.dev.
`;
  writeFileSync(join(outDir, 'README.md'), body);
}

function buildBundle(entry) {
  const artifactPath = resolve(REPO_ROOT, entry.artifact);
  if (!existsSync(artifactPath)) {
    throw new Error(
      `Artifact not found: ${artifactPath}. Run 'forge build' in the ` +
        'containing package first.',
    );
  }

  const artifact = JSON.parse(readFileSync(artifactPath, 'utf8'));
  const raw = artifact.rawMetadata;
  if (typeof raw !== 'string') {
    throw new Error(`Artifact ${artifactPath} has no rawMetadata field.`);
  }
  const meta = JSON.parse(raw);

  const outDir = resolve(BUNDLE_ROOT, entry.address.toLowerCase());
  const sourcesDir = join(outDir, 'sources');
  ensureDir(sourcesDir);

  writeFileSync(join(outDir, 'metadata.json'), raw);

  let copied = 0;
  for (const relPath of Object.keys(meta.sources ?? {})) {
    const srcPath = resolveSource(relPath, entry.contractsRoot);
    const dstPath = join(sourcesDir, relPath);
    ensureDir(dirname(dstPath));
    writeFileSync(dstPath, readFileSync(srcPath));
    copied++;
  }

  writeBundleReadme(entry, meta, outDir);

  return { entry, meta, copied, outDir };
}

function main() {
  ensureDir(BUNDLE_ROOT);
  const results = [];
  for (const entry of CONTRACTS) {
    try {
      const r = buildBundle(entry);
      results.push(r);
      console.log(
        `[ok] ${r.entry.name.padEnd(28)} ${r.entry.address}  ${r.copied.toString().padStart(3)} sources`,
      );
    } catch (err) {
      console.error(`[error] ${entry.name} (${entry.address}): ${err.message}`);
      process.exitCode = 1;
    }
  }

  // Top-level README
  const toc = results
    .map(
      (r) =>
        `- [${r.entry.name}](./${r.entry.address.toLowerCase()}/README.md) — \`${r.entry.address}\``,
    )
    .join('\n');

  const topReadme = `# Sourcify verification bundles — EticaHub mainnet (chain 61803)

Each subdirectory here is a self-contained Sourcify upload bundle for one deployed EticaHub contract:

${toc}

## How to verify

1. Wait for chain 61803 support to land in Sourcify (tracking: https://github.com/argotorg/sourcify/pull/2755 and https://github.com/sourcifyeth/sourcify-chains).
2. Open https://sourcify.dev/#/verifier.
3. Pick **Etica Mainnet** as the chain.
4. Enter the contract address.
5. Drag the entire bundle directory into the upload area. The \`metadata.json\` + the \`sources/\` tree together give Sourcify everything needed to recompile and compare against the on-chain bytecode.

## Regenerating

Bundles are produced by \`apps/web/scripts/build-sourcify-bundle.mjs\` from each forge artifact. To refresh:

\`\`\`bash
cd packages/contracts && forge build
cd ../trading-contracts && forge build
cd ../../apps/web && node scripts/build-sourcify-bundle.mjs
\`\`\`

Bundle output is deterministic given the same sources + compiler settings.
`;
  writeFileSync(join(BUNDLE_ROOT, 'README.md'), topReadme);
  console.log(`\nWrote ${results.length} bundles → ${BUNDLE_ROOT}`);
}

main();
