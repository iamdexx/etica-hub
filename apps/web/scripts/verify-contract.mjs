#!/usr/bin/env node
/**
 * Verify a deployed contract against its forge artifact and write a
 * manifest to `apps/web/public/verified/<address>.json`.
 *
 * Usage:
 *   node scripts/verify-contract.mjs \
 *     --address 0xa5A1Bc6307b0b87989B8456D4b35F88a68650044 \
 *     --artifact ../../packages/contracts/out/ETXToken.sol/ETXToken.json \
 *     --contracts-root ../../packages/contracts
 *
 * The artifact must be produced by `forge build` with
 * `bytecode_hash = "none"` (see foundry.toml). The script:
 *   1. Reads the artifact and extracts abi + deployedBytecode + metadata.
 *   2. Fetches the on-chain runtime bytecode from the Etica mainnet RPC.
 *   3. Compares them with immutable-reference masking. If neither an
 *      exact match nor a post-mask match, exits non-zero.
 *   4. Reads each source file referenced by the artifact (paths are
 *      relative to `--contracts-root`; lib/* paths resolve transparently).
 *   5. Emits a JSON manifest next to the verified directory.
 *
 * Pure Node (ESM) with no build step — runs from a cold clone given the
 * workspace's existing `viem` dep.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, join, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, http, defineChain } from 'viem';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const WEB_ROOT = resolve(__dirname, '..');

const ETICA_MAINNET = defineChain({
  id: 61803,
  name: 'Etica',
  nativeCurrency: { name: 'EGAZ', symbol: 'EGAZ', decimals: 18 },
  rpcUrls: {
    default: {
      http: [
        'https://eticamainnet.eticascan.org',
        'https://eticamainnet.eticaprotocol.org',
        'https://61803.rpc.thirdweb.com',
      ],
    },
  },
});

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k.startsWith('--')) {
      const name = k.slice(2);
      const v = argv[i + 1];
      args[name] = v;
      i++;
    }
  }
  return args;
}

function strip0x(hex) {
  return hex.startsWith('0x') ? hex.slice(2) : hex;
}

function maskImmutables(onchainHex, immutableReferences) {
  const bytes = Buffer.from(strip0x(onchainHex), 'hex');
  for (const refs of Object.values(immutableReferences ?? {})) {
    for (const ref of refs) {
      bytes.fill(0, ref.start, ref.start + ref.length);
    }
  }
  return bytes.toString('hex');
}

function stripMetadataHash(hex) {
  if (hex.length < 4) return hex;
  const cborLen = parseInt(hex.slice(-4), 16);
  if (isNaN(cborLen) || cborLen <= 0 || cborLen > 0x200) return hex;
  const totalHex = (2 + cborLen) * 2;
  if (hex.length <= totalHex) return hex;
  const tailStart = hex.length - totalHex;
  if (hex[tailStart] !== 'a') return hex;
  return hex.slice(0, tailStart);
}

function compareBytecode(onchainHex, compiledHex, immutableReferences) {
  const on = strip0x(onchainHex).toLowerCase();
  const compiled = strip0x(compiledHex).toLowerCase();
  if (on === compiled) return 'exact';
  if (immutableReferences) {
    const masked = maskImmutables(on, immutableReferences);
    if (masked === compiled) return 'with-immutables';
  }
  const onStripped = stripMetadataHash(on);
  const compiledStripped = stripMetadataHash(compiled);
  if (onStripped === compiledStripped) return 'with-metadata-hash';
  if (immutableReferences) {
    const maskedStripped = maskImmutables(onStripped, immutableReferences);
    if (maskedStripped === compiledStripped) return 'with-metadata-hash';
  }
  return null;
}

/**
 * Resolve a source path from the artifact's metadata.sources keys to an
 * absolute disk path. Forge typically emits paths relative to the
 * project root (e.g. `src/etx/ETXToken.sol`) or library-relative paths
 * (`lib/openzeppelin-contracts/contracts/token/ERC20/ERC20.sol`).
 *
 * We try the contracts-root directly, then the workspace root in case
 * the artifact came from a sibling package with a shared source tree.
 */
function resolveSourcePath(relPath, contractsRoot) {
  // Defense-in-depth: a hostile artifact could list `metadata.sources`
  // keys like `../../etc/passwd`. Resolve each candidate and require it
  // to live inside `contractsRoot`. The script is dev-time only and
  // only reads our own `forge build` output, but the manifest it writes
  // is published to the public site, so a rogue artifact could otherwise
  // cause us to publish arbitrary CI-worker file contents.
  const rootResolved = resolve(contractsRoot);
  const rootPrefix = rootResolved + sep;
  const candidates = [
    join(contractsRoot, relPath),
    // Handle solc remappings that resolve to a different on-disk layout
    // (e.g. `@openzeppelin/contracts/…` after remapping → `lib/…`).
    join(contractsRoot, 'src', relPath),
  ];
  for (const p of candidates) {
    const pResolved = resolve(p);
    if (pResolved !== rootResolved && !pResolved.startsWith(rootPrefix)) {
      throw new Error(
        `Source path "${relPath}" resolves outside contracts root ` +
          `"${rootResolved}" (got "${pResolved}"). Refusing to read.`,
      );
    }
    if (existsSync(pResolved)) return pResolved;
  }
  throw new Error(
    `Could not resolve source path "${relPath}" under contracts root "${contractsRoot}". ` +
      `Tried: ${candidates.join(', ')}`,
  );
}

async function main() {
  const args = parseArgs(process.argv);
  const address = args.address;
  const artifactPath = args.artifact;
  const contractsRoot = resolve(WEB_ROOT, args['contracts-root'] ?? '../../packages/contracts');
  const notes = args.notes;

  if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
    console.error('--address is required and must be a 20-byte hex address');
    process.exit(1);
  }
  if (!artifactPath) {
    console.error('--artifact is required (path to forge artifact JSON)');
    process.exit(1);
  }

  const artifact = JSON.parse(readFileSync(resolve(WEB_ROOT, artifactPath), 'utf-8'));
  const compiledBc = artifact?.deployedBytecode?.object;
  const immutableRefs = artifact?.deployedBytecode?.immutableReferences ?? null;
  const abi = artifact?.abi;
  const metadata = artifact?.metadata;

  if (!compiledBc || !abi || !metadata) {
    console.error(
      'Artifact missing required fields (deployedBytecode / abi / metadata). ' +
        "Build with foundry and bytecode_hash = 'none' first.",
    );
    process.exit(1);
  }

  console.log(`[verify] fetching on-chain bytecode for ${address}…`);
  const client = createPublicClient({ chain: ETICA_MAINNET, transport: http() });
  const onchain = await client.getBytecode({ address });
  if (!onchain || onchain === '0x') {
    console.error(`No bytecode at ${address} — not a contract account.`);
    process.exit(1);
  }

  const match = compareBytecode(onchain, compiledBc, immutableRefs);
  if (!match) {
    console.error(
      `Bytecode mismatch. The on-chain code at ${address} does not match the provided artifact, ` +
        'even after immutable masking. Either the wrong artifact was supplied, the compiler ' +
        'settings differ from the deploy (optimizer runs / evm version / solc version), or the ' +
        'contract was deployed from different source.',
    );
    process.exit(2);
  }
  console.log(`[verify] bytecode match: ${match}`);

  const compilerVersion = metadata.compiler?.version ?? 'unknown';
  const settings = metadata.settings ?? {};
  const optimizer = settings.optimizer ?? { enabled: false, runs: 200 };
  const evmVersion = settings.evmVersion ?? 'paris';
  const contractName =
    (settings.compilationTarget && Object.values(settings.compilationTarget)[0]) ||
    artifact.id ||
    'Contract';

  const sources = {};
  const metaSources = metadata.sources ?? {};
  for (const relPath of Object.keys(metaSources)) {
    try {
      const absPath = resolveSourcePath(relPath, contractsRoot);
      const content = readFileSync(absPath, 'utf-8');
      sources[relPath] = { content };
    } catch (e) {
      console.warn(`[verify] warning: skipping source "${relPath}" — ${e.message}`);
    }
  }

  const manifest = {
    address,
    name: contractName,
    compilerVersion,
    optimizer: { enabled: !!optimizer.enabled, runs: optimizer.runs ?? 200 },
    evmVersion,
    sources,
    abi,
    verifiedAt: new Date().toISOString(),
    bytecodeMatch: match,
    ...(notes ? { notes } : {}),
  };

  const outDir = join(WEB_ROOT, 'public', 'verified');
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, `${address.toLowerCase()}.json`);
  writeFileSync(outFile, JSON.stringify(manifest, null, 2));
  console.log(`[verify] wrote ${outFile}`);
  console.log(
    `[verify] done. ${Object.keys(sources).length} source files, ` +
      `${abi.length} abi entries, match=${match}.`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
