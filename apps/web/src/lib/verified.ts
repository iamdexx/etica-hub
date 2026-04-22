import fs from 'node:fs';
import path from 'node:path';
import type { Abi } from 'viem';

/**
 * Canonical schema for a verified-contract manifest stored at
 * `apps/web/public/verified/<lowercased-address>.json`.
 *
 * This is the explorer-facing view of an Etherscan-style "verified source"
 * record. It is intentionally minimal — the full forge artifact has far
 * more than we need, and bloating every manifest slows page loads.
 *
 * Fields mirror what a user expects to see on the contract tab:
 *   - `name`: the contract's user-facing name (e.g. `EticaHub`)
 *   - `compilerVersion`: e.g. `v0.8.26+commit.8a97fa7a`
 *   - `optimizer`: `{ enabled, runs }` as passed to solc
 *   - `evmVersion`: target EVM (Paris / Shanghai / Cancun …)
 *   - `sources`: map from source-file path → { content }.
 *     Paths are kept as-is from the solc input (e.g. `src/etx/ETXToken.sol`
 *     or `lib/openzeppelin-contracts/contracts/token/ERC20/ERC20.sol`).
 *   - `abi`: full ABI. Drives the read/write tab in a later PR.
 *   - `verifiedAt`: ISO timestamp of when the manifest was produced.
 *   - `bytecodeMatch`: bytecode-comparison strength. From strongest to
 *     weakest:
 *       `exact`              — identical byte-for-byte
 *       `with-immutables`    — match after masking `immutableReferences`
 *       `with-metadata-hash` — match after stripping CBOR metadata tail
 *                              (+ immutable masking). This is the
 *                              etherscan-standard "verified with metadata"
 *                              level — indicates the source tree compiles
 *                              to the same bytecode modulo build-host
 *                              paths.
 *     Anything weaker than that shouldn't get a manifest at all.
 */
export interface VerifiedContract {
  address: `0x${string}`;
  name: string;
  compilerVersion: string;
  optimizer: { enabled: boolean; runs: number };
  evmVersion: string;
  sources: Record<string, { content: string }>;
  abi: Abi;
  verifiedAt: string;
  bytecodeMatch: 'exact' | 'with-immutables' | 'with-metadata-hash';
  /**
   * Optional human-authored context — e.g. "pair template, cloned by the
   * factory so its address is zero on-chain; verified against the
   * factory's stored init-code hash". Rendered as a short paragraph at
   * the top of the source tab.
   */
  notes?: string;
}

/**
 * Directory where verified manifests live. Resolved from the web app's
 * root at build/runtime. Kept inside `public/` so the raw JSON is also
 * fetchable by clients if they ever want to consume it directly.
 */
const VERIFIED_DIR = path.join(process.cwd(), 'public', 'verified');

/**
 * In-memory cache keyed by lowercased address. Verified manifests are
 * immutable between deploys, so caching them for the lifetime of the
 * process is fine and saves repeated fs reads on hot pages.
 */
const cache = new Map<string, VerifiedContract | null>();

/**
 * Load the verified-contract manifest for an address, or `null` if the
 * address has no manifest. Case-insensitive.
 *
 * This is a server-only helper — it touches `fs`. Don't call it from
 * client components.
 */
export function loadVerified(
  address: string | null | undefined,
): VerifiedContract | null {
  if (!address) return null;
  const key = address.toLowerCase();
  if (cache.has(key)) return cache.get(key) ?? null;

  const file = path.join(VERIFIED_DIR, `${key}.json`);
  let result: VerifiedContract | null = null;
  try {
    if (fs.existsSync(file)) {
      const raw = fs.readFileSync(file, 'utf-8');
      const parsed = JSON.parse(raw) as VerifiedContract;
      // Be defensive — a malformed manifest shouldn't crash the page,
      // it should just be treated as "not verified".
      if (isValidManifest(parsed)) {
        result = parsed;
      }
    }
  } catch {
    // Swallow — same story as above.
    result = null;
  }
  cache.set(key, result);
  return result;
}

function isValidManifest(m: unknown): m is VerifiedContract {
  if (!m || typeof m !== 'object') return false;
  const o = m as Record<string, unknown>;
  return (
    typeof o.address === 'string' &&
    typeof o.name === 'string' &&
    typeof o.compilerVersion === 'string' &&
    typeof o.evmVersion === 'string' &&
    typeof o.sources === 'object' &&
    o.sources !== null &&
    Array.isArray(o.abi) &&
    typeof o.verifiedAt === 'string' &&
    (o.bytecodeMatch === 'exact' ||
      o.bytecodeMatch === 'with-immutables' ||
      o.bytecodeMatch === 'with-metadata-hash')
  );
}

/**
 * Returns true iff the address has a verified manifest. Cheap — piggybacks
 * on the same fs check + cache. Use this for the "Verified" badge on
 * listing pages where we don't need the full source.
 */
export function isVerified(address: string | null | undefined): boolean {
  return loadVerified(address) != null;
}

/**
 * Strip the leading `0x` from a hex string if present, for
 * bytecode-comparison purposes.
 */
function strip0x(hex: string): string {
  return hex.startsWith('0x') ? hex.slice(2) : hex;
}

/**
 * Replace the slots specified by `immutableReferences` in `onchainHex`
 * with `0x00…00`, so the result can be compared byte-for-byte against the
 * compiled `deployedBytecode` (which has zeros in those slots at compile
 * time). Inputs and outputs are hex-encoded strings *without* the 0x
 * prefix.
 *
 * `immutableReferences` is solc's native shape: a map from AST node id to
 * an array of { start, length } byte offsets into the runtime bytecode.
 */
export function maskImmutables(
  onchainHex: string,
  immutableReferences: Record<string, Array<{ start: number; length: number }>>,
): string {
  const bytes = Buffer.from(strip0x(onchainHex), 'hex');
  for (const refs of Object.values(immutableReferences)) {
    for (const ref of refs) {
      bytes.fill(0, ref.start, ref.start + ref.length);
    }
  }
  return bytes.toString('hex');
}

/**
 * Strip the CBOR-encoded metadata tail (solc "auxdata") off a hex-encoded
 * runtime bytecode string, returning the tail-free prefix. Solc appends a
 * short CBOR map whose last two bytes are a big-endian uint16 encoding
 * the CBOR length — the tail-stripping recipe is `total = 2 + cborLen`.
 *
 * We also re-verify the tail starts with the expected CBOR map opener
 * (`0xa2…` / `0xa3…`) to avoid stripping bytes off a contract that
 * happens to have a similar-looking trailing length word. Returns the
 * original string if no plausible tail is found.
 *
 * Hex input / output is without the 0x prefix.
 */
export function stripMetadataHash(hex: string): string {
  if (hex.length < 4) return hex;
  const lenHex = hex.slice(-4);
  const cborLen = parseInt(lenHex, 16);
  if (isNaN(cborLen) || cborLen <= 0 || cborLen > 0x200) return hex;
  const totalBytes = 2 + cborLen;
  const totalHex = totalBytes * 2;
  if (hex.length <= totalHex) return hex;
  const tailStart = hex.length - totalHex;
  const firstByte = hex.slice(tailStart, tailStart + 2);
  // Valid CBOR maps start with 0xa* (major type 5 / map). If not, we've
  // stripped the wrong thing; keep the original.
  if (firstByte[0] !== 'a') return hex;
  return hex.slice(0, tailStart);
}

/**
 * Compare on-chain runtime bytecode against a forge artifact's
 * `deployedBytecode.object`, escalating through match strengths:
 *   1. byte-for-byte            → `'exact'`
 *   2. after immutable masking  → `'with-immutables'`
 *   3. after metadata-tail strip + immutable masking → `'with-metadata-hash'`
 * Returns `null` if none match.
 */
export function compareDeployedBytecode(
  onchainHex: string,
  compiledHex: string,
  immutableReferences:
    | Record<string, Array<{ start: number; length: number }>>
    | null
    | undefined,
): 'exact' | 'with-immutables' | 'with-metadata-hash' | null {
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
