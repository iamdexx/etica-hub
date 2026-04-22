/**
 * Helpers for driving the explorer's contract interaction UI.
 *
 * The "read/write" tab on `/explorer/address/[addr]` needs three things
 * this module provides:
 *   - Split a verified contract's ABI into read (view/pure) and write
 *     function entries, ignoring constructor / fallback / receive / event
 *     / error entries.
 *   - Parse a string the user typed in a form field into the JS value
 *     viem expects for that Solidity type (uint, int, address, bool,
 *     bytes, bytesN, string, and JSON arrays / tuples).
 *   - Stringify an RPC result back into something a pre-wrap `<pre>` can
 *     render without losing type information (bigint → decimal, address
 *     → checksum, nested → JSON).
 *
 * Kept framework-agnostic so a unit test can import it without pulling
 * in wagmi / React. The actual UI layer lives in
 * `components/explorer/ContractInteractionView.tsx`.
 */
import { getAddress, isAddress, type Abi, type AbiFunction } from 'viem';

/**
 * Narrow helper so consumers can render read vs write tabs without
 * re-filtering the raw ABI everywhere.
 */
export interface ClassifiedAbi {
  reads: AbiFunction[];
  writes: AbiFunction[];
}

/**
 * Returns only the function entries of an ABI, split into read (view /
 * pure) and write (nonpayable / payable) buckets. The original
 * declaration order is preserved within each bucket so the UI mirrors
 * the order in the source file — matches etherscan's convention.
 *
 * Non-function entries (events, errors, constructor, fallback, receive)
 * are dropped entirely — the UI doesn't expose them.
 */
export function classifyAbi(abi: Abi): ClassifiedAbi {
  const reads: AbiFunction[] = [];
  const writes: AbiFunction[] = [];
  for (const entry of abi) {
    if (entry.type !== 'function') continue;
    const fn = entry as AbiFunction;
    if (fn.stateMutability === 'view' || fn.stateMutability === 'pure') {
      reads.push(fn);
    } else {
      // Default to "write" for anything non-view / non-pure. Includes
      // `nonpayable`, `payable`, and any ABI missing `stateMutability`
      // (legacy/deprecated but still present in some manifests).
      writes.push(fn);
    }
  }
  return { reads, writes };
}

/**
 * Parses a single user-supplied string into the JS value viem expects
 * for `args[i]` when the corresponding ABI input has Solidity type
 * `solidityType`. Throws a human-readable `Error` on any parse failure
 * — callers should catch and surface the message next to the input.
 *
 * Supported types:
 *   - `address`           : checksummed address
 *   - `bool`              : true / false (case insensitive)
 *   - `uintN` / `intN`    : bigint (accepts decimal or 0x-prefixed hex)
 *   - `bytes`             : 0x-prefixed hex string
 *   - `bytesN` (N 1..32)  : 0x-prefixed hex of exact length
 *   - `string`            : passthrough
 *   - `T[]` / `T[N]`      : JSON array; each element parsed recursively
 *                           with its element type
 *   - tuples (`(a,b,…)`)  : JSON array in declaration order; each
 *                           element parsed with its component type
 *                           (uses `components` field in the ABI)
 *
 * An empty string on any non-`string` type is rejected — we don't
 * silently coerce to zero because that hides user mistakes.
 */
export function parseArg(
  solidityType: string,
  raw: string,
  components?: ReadonlyArray<{ type: string; components?: unknown }>,
): unknown {
  const trimmed = raw.trim();

  // Arrays: `T[]` or `T[N]`. Element type is whatever's left after
  // stripping the trailing `[...]`. Works for nested arrays via
  // recursion.
  const arrayMatch = solidityType.match(/^(.+)\[(\d*)\]$/);
  if (arrayMatch) {
    const elemType = arrayMatch[1];
    const fixedLen = arrayMatch[2] ? Number(arrayMatch[2]) : undefined;
    if (!trimmed) throw new Error('expected a JSON array');
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error('invalid JSON array');
    }
    if (!Array.isArray(parsed)) throw new Error('expected a JSON array');
    if (fixedLen != null && parsed.length !== fixedLen) {
      throw new Error(`expected ${fixedLen} elements, got ${parsed.length}`);
    }
    return parsed.map((v, i) => {
      // JSON primitives → re-stringify so parseArg sees the same
      // raw-text surface it would get from a form input.
      const asRaw = typeof v === 'string' ? v : JSON.stringify(v);
      try {
        return parseArg(elemType, asRaw, components);
      } catch (err) {
        throw new Error(
          `element ${i}: ${err instanceof Error ? err.message : 'invalid'}`,
        );
      }
    });
  }

  // Tuple: `tuple` (with `components`) or explicit `(...)` form.
  if (solidityType === 'tuple') {
    if (!components) throw new Error('tuple missing components');
    if (!trimmed) throw new Error('expected a JSON array');
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error('invalid JSON tuple');
    }
    if (!Array.isArray(parsed)) {
      throw new Error('expected a JSON array for tuple');
    }
    if (parsed.length !== components.length) {
      throw new Error(
        `expected ${components.length} tuple fields, got ${parsed.length}`,
      );
    }
    return parsed.map((v, i) => {
      const c = components[i] as { type: string; components?: unknown };
      const asRaw = typeof v === 'string' ? v : JSON.stringify(v);
      try {
        return parseArg(
          c.type,
          asRaw,
          c.components as
            | ReadonlyArray<{ type: string; components?: unknown }>
            | undefined,
        );
      } catch (err) {
        throw new Error(
          `field ${i}: ${err instanceof Error ? err.message : 'invalid'}`,
        );
      }
    });
  }

  if (solidityType === 'address') {
    if (!trimmed) throw new Error('expected an address');
    if (!isAddress(trimmed, { strict: false })) {
      throw new Error('invalid address');
    }
    return getAddress(trimmed);
  }

  if (solidityType === 'bool') {
    const t = trimmed.toLowerCase();
    if (t === 'true' || t === '1') return true;
    if (t === 'false' || t === '0') return false;
    throw new Error('expected true/false');
  }

  if (solidityType === 'string') {
    // Allow legitimately empty strings — that's a valid Solidity value.
    return raw;
  }

  if (solidityType === 'bytes') {
    if (!trimmed) throw new Error('expected 0x-hex bytes');
    if (!/^0x([0-9a-fA-F]{2})*$/.test(trimmed)) {
      throw new Error('expected 0x-prefixed even-length hex');
    }
    return trimmed as `0x${string}`;
  }

  const bytesNMatch = solidityType.match(/^bytes(\d+)$/);
  if (bytesNMatch) {
    const n = Number(bytesNMatch[1]);
    if (n < 1 || n > 32) throw new Error('bytesN: N must be 1..32');
    if (!/^0x[0-9a-fA-F]+$/.test(trimmed)) {
      throw new Error('expected 0x-prefixed hex');
    }
    const expectedChars = 2 + n * 2;
    if (trimmed.length !== expectedChars) {
      throw new Error(`expected exactly ${n} bytes (${expectedChars - 2} hex chars)`);
    }
    return trimmed as `0x${string}`;
  }

  const intMatch = solidityType.match(/^(u?)int(\d*)$/);
  if (intMatch) {
    const signed = intMatch[1] === '';
    const bitsRaw = intMatch[2];
    const bits = bitsRaw ? Number(bitsRaw) : 256;
    if (bits < 8 || bits > 256 || bits % 8 !== 0) {
      throw new Error('int/uint: bit-width must be multiple of 8 in 8..256');
    }
    if (!trimmed) throw new Error('expected a number');
    let value: bigint;
    try {
      value = trimmed.startsWith('0x') || trimmed.startsWith('-0x')
        ? bigintFromHex(trimmed)
        : BigInt(trimmed);
    } catch {
      throw new Error('invalid integer');
    }
    if (!signed && value < 0n) throw new Error('uint cannot be negative');
    const upper = signed ? 1n << BigInt(bits - 1) : 1n << BigInt(bits);
    const lower = signed ? -(1n << BigInt(bits - 1)) : 0n;
    if (value >= upper || value < lower) {
      throw new Error(`value out of ${solidityType} range`);
    }
    return value;
  }

  throw new Error(`unsupported Solidity type: ${solidityType}`);
}

function bigintFromHex(s: string): bigint {
  if (s.startsWith('-0x')) return -BigInt('0x' + s.slice(3));
  return BigInt(s);
}

/**
 * Renders an RPC result into a string suitable for a `<pre>` block.
 *
 * - `bigint` → decimal (no scientific notation, no precision loss)
 * - `address` → checksummed (detects 20-byte hex strings)
 * - `0x…` hex → kept as-is
 * - `boolean` / `number` / `string` → `String(x)`
 * - arrays / objects → JSON.stringify with bigint handled via replacer,
 *   indented 2 spaces for readability
 * - `null` / `undefined` → empty string (viem returns `undefined` for
 *   zero-output function calls; showing `"undefined"` is noise)
 */
export function stringifyResult(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string') {
    // Probable address? Re-checksum so the UI shows canonical form.
    if (/^0x[0-9a-fA-F]{40}$/.test(value)) {
      try {
        return getAddress(value);
      } catch {
        return value;
      }
    }
    return value;
  }
  if (typeof value === 'boolean' || typeof value === 'number') {
    return String(value);
  }
  return JSON.stringify(
    value,
    (_k, v) => (typeof v === 'bigint' ? v.toString() : v),
    2,
  );
}
