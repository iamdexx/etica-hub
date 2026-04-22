import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PublicClient } from 'viem';
import {
  formatTokenAmount,
  loadAddressTokenTransfers,
  resolveTokenInfos,
  scanAddressTokenTransfers,
  uniqueAddressesFromTransfers,
  type TokenTransfer,
} from '../src/lib/token';
import * as explorerIndex from '../src/lib/explorerIndex';

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

// ------------------------------------------------------------------ //
// scanAddressTokenTransfers
// ------------------------------------------------------------------ //
// The per-address Transfer-log scanner is the backbone of the "Token
// transfers" section on /explorer/address/[addr]. It issues two
// parallel getLogs calls (outbound + inbound) and must de-dupe on
// (txHash, logIndex), sort newest-first, and bail cleanly when the RPC
// errors. Tests fake a PublicClient via a minimal mock that only
// implements getLogs.
describe('scanAddressTokenTransfers', () => {
  const VIEWER = '0x1111111111111111111111111111111111111111' as const;
  const OTHER = '0x2222222222222222222222222222222222222222' as const;
  const TOKEN_A = '0xAAaAaaAaaAaaAAaaAAAaaaAAAAAaaaAaAAaAAaaA' as const;

  // Shape viem returns from `getLogs({ event, args })` — args are already
  // decoded. We fake the same shape.
  function log(opts: {
    blockNumber: bigint;
    logIndex: number;
    from: string;
    to: string;
    value: bigint;
    token: string;
    txHash: string;
  }) {
    return {
      address: opts.token,
      args: { from: opts.from, to: opts.to, value: opts.value },
      blockNumber: opts.blockNumber,
      transactionHash: opts.txHash,
      logIndex: opts.logIndex,
    };
  }

  function mockClient(outboundLogs: unknown[], inboundLogs: unknown[]) {
    return {
      getLogs: vi
        .fn()
        .mockImplementationOnce(() => Promise.resolve(outboundLogs))
        .mockImplementationOnce(() => Promise.resolve(inboundLogs)),
    } as unknown as PublicClient;
  }

  it('merges outbound + inbound logs, sorts newest-first, and decodes fields', async () => {
    const outbound = [
      log({
        blockNumber: 100n,
        logIndex: 0,
        from: VIEWER,
        to: OTHER,
        value: 1000n,
        token: TOKEN_A,
        txHash: '0xaaaa',
      }),
    ];
    const inbound = [
      log({
        blockNumber: 200n,
        logIndex: 0,
        from: OTHER,
        to: VIEWER,
        value: 2000n,
        token: TOKEN_A,
        txHash: '0xbbbb',
      }),
    ];
    const client = mockClient(outbound, inbound);
    const out = await scanAddressTokenTransfers(client, VIEWER, 300n);
    expect(out).toHaveLength(2);
    // Newest first — block 200 before block 100.
    expect(out[0]!.blockNumber).toBe(200n);
    expect(out[1]!.blockNumber).toBe(100n);
    expect(out[0]!.value).toBe(2000n);
    expect(out[0]!.from.toLowerCase()).toBe(OTHER.toLowerCase());
    expect(out[0]!.to.toLowerCase()).toBe(VIEWER.toLowerCase());
  });

  it('de-duplicates a log that appears in both result sets', async () => {
    // A self-transfer (viewer → viewer) matches both the outbound filter
    // (from=viewer) and the inbound filter (to=viewer); without dedup
    // we'd emit two identical entries.
    const l = log({
      blockNumber: 50n,
      logIndex: 3,
      from: VIEWER,
      to: VIEWER,
      value: 7n,
      token: TOKEN_A,
      txHash: '0xcafe',
    });
    const client = mockClient([l], [l]);
    const out = await scanAddressTokenTransfers(client, VIEWER, 100n);
    expect(out).toHaveLength(1);
    expect(out[0]!.value).toBe(7n);
  });

  it('returns an empty array when the RPC rejects', async () => {
    const client = {
      getLogs: vi.fn().mockRejectedValue(new Error('boom')),
    } as unknown as PublicClient;
    const out = await scanAddressTokenTransfers(client, VIEWER, 100n);
    expect(out).toEqual([]);
  });

  it('skips logs missing any of (from, to, value)', async () => {
    const malformed = {
      address: TOKEN_A,
      args: { from: VIEWER }, // no `to`, no `value`
      blockNumber: 10n,
      transactionHash: '0xdead',
      logIndex: 0,
    };
    const client = mockClient([malformed], []);
    const out = await scanAddressTokenTransfers(client, VIEWER, 100n);
    expect(out).toEqual([]);
  });
});

// ------------------------------------------------------------------ //
// loadAddressTokenTransfers
// ------------------------------------------------------------------ //
// Indexer-backed loader must degrade gracefully when the indexer
// returns data that survives JSONL parsing but breaks downstream
// (e.g. a bad numeric field that makes BigInt throw, or a bad
// address that makes getAddress throw). Falling back to the plain
// RPC scan keeps the address page rendering instead of 500ing.
describe('loadAddressTokenTransfers', () => {
  const VIEWER = '0x1111111111111111111111111111111111111111' as const;
  const OTHER = '0x2222222222222222222222222222222222222222' as const;
  const TOKEN_A = '0xAAaAaaAaaAaaAAaaAAAaaaAAAAAaaaAaAAaAAaaA' as const;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('falls back to the RPC scan when the indexer returns malformed rows', async () => {
    // Indexer returns a cursor + one row whose `value` field is a
    // non-numeric string. parseJsonl passes it through (it's valid
    // JSON), but `BigInt("not_a_number")` throws downstream. Without
    // the try/catch wrap, this would crash the address page.
    vi.spyOn(explorerIndex, 'fetchIndexedAddressTransfers').mockResolvedValue({
      cursor: {
        lastBlock: 50,
        chainId: 61803,
        updatedAt: '2025-01-01T00:00:00.000Z',
        runs: 1,
        cumulative: { transfers: 1, syncs: 0 },
      },
      rows: [
        {
          block: 40,
          ts: 1700000000,
          tx: '0xmalformed',
          logIndex: 0,
          token: TOKEN_A,
          from: OTHER,
          to: VIEWER,
          value: 'not_a_number',
        },
      ],
    });

    // RPC-side scan returns one row on every call so we can observe
    // that the function fell back to it rather than throwing or
    // returning []. Uses a stable mock (not Once) because the try
    // block's tail scan also calls getLogs — the fallback scan needs
    // to still have a response available when it runs.
    const rpcRow = {
      address: TOKEN_A,
      args: { from: OTHER, to: VIEWER, value: 123n },
      blockNumber: 99n,
      transactionHash: '0xrpc',
      logIndex: 1,
    };
    const client = {
      getLogs: vi.fn((args: { args?: { from?: string; to?: string } }) => {
        // Inbound filter (to=viewer) gets the row; outbound gets [].
        if (args.args?.to) return Promise.resolve([rpcRow]);
        return Promise.resolve([]);
      }),
    } as unknown as PublicClient;

    const out = await loadAddressTokenTransfers(client, VIEWER, 100n);
    expect(out).toHaveLength(1);
    expect(out[0]!.txHash).toBe('0xrpc');
    expect(out[0]!.value).toBe(123n);
  });
});

// ------------------------------------------------------------------ //
// resolveTokenInfos
// ------------------------------------------------------------------ //
// Per-page batch metadata resolver. Must de-duplicate the input set so
// the same token address never triggers two parallel probes even if it
// appears many times in the transfer list. Also must omit tokens whose
// metadata read fails (rather than propagating the exception).
describe('resolveTokenInfos', () => {
  const TOKEN_A = '0xAAaAaaAaaAaaAAaaAAAaaaAAAAAaaaAaAAaAAaaA' as const;
  const TOKEN_B = '0xBBbBbBbBbBbBBBbBbBbBBbBbbbbBbbbBbbbbBBbB' as const;

  function mockMetadataClient(responses: Record<string, unknown>) {
    return {
      readContract: vi.fn((args: { address: string; functionName: string }) => {
        const addrLower = args.address.toLowerCase();
        const tokenResponses = responses[addrLower] as
          | Record<string, unknown>
          | undefined;
        if (!tokenResponses) return Promise.reject(new Error('no such token'));
        const val = tokenResponses[args.functionName];
        if (val === undefined) return Promise.reject(new Error('no-op'));
        return Promise.resolve(val);
      }),
    } as unknown as PublicClient;
  }

  it('de-duplicates by address before probing', async () => {
    const client = mockMetadataClient({
      [TOKEN_A.toLowerCase()]: {
        name: 'Token A',
        symbol: 'AAA',
        decimals: 18,
        totalSupply: 0n,
      },
    });
    // TOKEN_A repeated 3 times — should still only issue 4 reads total
    // (name + symbol + decimals + totalSupply), not 12.
    const result = await resolveTokenInfos(client, [TOKEN_A, TOKEN_A, TOKEN_A]);
    expect(result.size).toBe(1);
    expect(result.get(TOKEN_A.toLowerCase())?.symbol).toBe('AAA');
    expect((client.readContract as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(4);
  });

  it('omits tokens whose metadata probe fails', async () => {
    const client = mockMetadataClient({
      [TOKEN_A.toLowerCase()]: {
        name: 'Token A',
        symbol: 'AAA',
        decimals: 18,
        totalSupply: 0n,
      },
      // TOKEN_B intentionally missing — probe will reject.
    });
    const result = await resolveTokenInfos(client, [TOKEN_A, TOKEN_B]);
    expect(result.size).toBe(1);
    expect(result.has(TOKEN_A.toLowerCase())).toBe(true);
    expect(result.has(TOKEN_B.toLowerCase())).toBe(false);
  });

  it('returns an empty map for an empty input', async () => {
    const client = mockMetadataClient({});
    const result = await resolveTokenInfos(client, []);
    expect(result.size).toBe(0);
  });
});
