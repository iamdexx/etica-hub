import { describe, expect, it } from 'vitest';
import {
  formatTokenAmount,
  uniqueAddressesFromTransfers,
  type TokenTransfer,
} from '../src/lib/token';

// ------------------------------------------------------------------ //
// formatTokenAmount
// ------------------------------------------------------------------ //
// Exercises the decimal-aware amount renderer. The function should
// always produce a human-readable decimal string; out-of-range decimals
// are a defensive fallback (cf. `formatEgaz`, which unconditionally
// assumes 18). We don't want a token that lies about decimals to crash
// the page or print scientific notation.
describe('formatTokenAmount', () => {
  it('formats 18-decimal amounts with up to 6 fractional digits', () => {
    // 1.234567891234 ETX → 1.234567 (trimmed to 6 digits, no trailing 0s).
    const wei = 1_234_567_891_234_567_891_234n;
    expect(formatTokenAmount(wei, 18)).toBe('1234.567891');
  });

  it('strips trailing zeros from fractional part', () => {
    // 500.000000 should render as 500, not "500.000000".
    expect(formatTokenAmount(500n * 10n ** 18n, 18)).toBe('500');
  });

  it('renders zero cleanly', () => {
    expect(formatTokenAmount(0n, 18)).toBe('0');
    expect(formatTokenAmount(0n, 6)).toBe('0');
    expect(formatTokenAmount(0n, 0)).toBe('0');
  });

  it('handles zero-decimals tokens (raw integer)', () => {
    // decimals=0 means the value IS the human amount (e.g. an NFT-ish
    // ERC-20). We should not stick a decimal point on.
    expect(formatTokenAmount(42n, 0)).toBe('42');
  });

  it('handles small decimals (e.g. USDT at 6)', () => {
    // 1.5 USDT = 1_500_000 at decimals=6.
    expect(formatTokenAmount(1_500_000n, 6)).toBe('1.5');
  });

  it('falls back to raw integer when decimals is out of ERC-20 range', () => {
    // A malformed token that claims decimals=255 — we should not try to
    // formatUnits(..., 255) (viem handles huge decimals but the result
    // is unreadable). Just print the raw integer.
    expect(formatTokenAmount(123n, 255)).toBe('123');
    expect(formatTokenAmount(123n, -1)).toBe('123');
    expect(formatTokenAmount(123n, Number.NaN)).toBe('123');
  });
});

// ------------------------------------------------------------------ //
// uniqueAddressesFromTransfers
// ------------------------------------------------------------------ //
// The "active addresses" stat on the token page is derived from the
// recent Transfer window, not from real holder balances (those would
// need an indexer). The function's job is to de-duplicate correctly
// while excluding the zero address, which represents mint/burn.
describe('uniqueAddressesFromTransfers', () => {
  const ZERO = '0x0000000000000000000000000000000000000000' as const;
  const A = '0x1111111111111111111111111111111111111111' as const;
  const B = '0x2222222222222222222222222222222222222222' as const;
  const C = '0x3333333333333333333333333333333333333333' as const;

  function transfer(from: string, to: string): TokenTransfer {
    return {
      from: from as `0x${string}`,
      to: to as `0x${string}`,
      value: 1n,
      txHash: '0xdeadbeef' as `0x${string}`,
      blockNumber: 1n,
      logIndex: 0,
    };
  }

  it('returns 0 for an empty window', () => {
    expect(uniqueAddressesFromTransfers([])).toBe(0);
  });

  it('counts both endpoints when they are non-zero', () => {
    expect(uniqueAddressesFromTransfers([transfer(A, B)])).toBe(2);
  });

  it('excludes the zero address (mint/burn)', () => {
    // Mint: ZERO → A counts only A.
    expect(uniqueAddressesFromTransfers([transfer(ZERO, A)])).toBe(1);
    // Burn: A → ZERO counts only A.
    expect(uniqueAddressesFromTransfers([transfer(A, ZERO)])).toBe(1);
  });

  it('de-duplicates across multiple transfers', () => {
    // A→B, B→C, C→A visits three unique addresses.
    const window = [transfer(A, B), transfer(B, C), transfer(C, A)];
    expect(uniqueAddressesFromTransfers(window)).toBe(3);
  });

  it('is case-insensitive on addresses', () => {
    // The lowercase and checksummed form of the same address should
    // count as one. Using explicit alternate casing here rather than
    // viem's getAddress to keep this pure.
    const upper = '0x1111111111111111111111111111111111111111';
    const mixed = '0x1111111111111111111111111111111111111111'.toUpperCase();
    // toUpperCase on an 0x-prefixed hex string also upper-cases the `0X`
    // prefix. That's fine — the function normalizes via toLowerCase.
    const w = [transfer(upper, B), transfer(B, mixed)];
    expect(uniqueAddressesFromTransfers(w)).toBe(2);
  });
});
