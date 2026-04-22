import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PublicClient } from 'viem';
import {
  formatTokenAmount,
  loadTokenRecentTransfers,
  resolveTokenInfos,
  scanAddressTokenTransfers,
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

// ------------------------------------------------------------------ //
// loadTokenRecentTransfers
// ------------------------------------------------------------------ //
// Indexer-backed variant of the per-token transfer window. Must:
//   - Fall back to the RPC-only scan when the indexer's cursor file
//     is missing (data branch not yet populated).
//   - Merge indexed rows + RPC tail rows, newest-first, deduped on
//     (txHash, logIndex).
//   - Only RPC-scan `cursor+1..head` when the indexer is available.
describe('loadTokenRecentTransfers', () => {
  const TOKEN = '0xAAaAaaAaaAaaAAaaAAAaaaAAAAAaaaAaAAaAAaaA' as const;
  const ALICE = '0x1111111111111111111111111111111111111111' as const;
  const BOB = '0x2222222222222222222222222222222222222222' as const;

  const ORIG_FETCH = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = ORIG_FETCH;
  });

  function rpcLog(opts: {
    blockNumber: bigint;
    logIndex: number;
    from: string;
    to: string;
    value: bigint;
    txHash: string;
  }) {
    return {
      address: TOKEN,
      args: { from: opts.from, to: opts.to, value: opts.value },
      blockNumber: opts.blockNumber,
      transactionHash: opts.txHash,
      logIndex: opts.logIndex,
    };
  }

  it('falls back to RPC-only scan when the indexer cursor is missing', async () => {
    globalThis.fetch = (async () =>
      ({ ok: false, status: 404 }) as Response) as typeof fetch;

    const logs = [
      rpcLog({
        blockNumber: 100n,
        logIndex: 0,
        from: ALICE,
        to: BOB,
        value: 1n,
        txHash: '0xaaaa',
      }),
    ];
    const client = {
      getLogs: vi.fn().mockResolvedValue(logs),
    } as unknown as PublicClient;

    const out = await loadTokenRecentTransfers(client, TOKEN, 200n);
    expect(out).toHaveLength(1);
    expect(out[0]!.blockNumber).toBe(100n);
    // Cursor unavailable → scan uses the default RPC window, one getLogs
    // call targeted at TOKEN (no fan-out into from/to filters — per-token
    // scan uses `{address, event}`).
    expect((client.getLogs as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(1);
  });

  it('merges indexed history with RPC tail, newest-first, deduped', async () => {
    const cursor = {
      lastBlock: 100,
      chainId: 61803,
      updatedAt: '2025-11-15T12:00:00Z',
      runs: 1,
      cumulative: { transfers: 1, syncs: 0 },
    };
    // One indexed row for TOKEN at block 50, one for a different token
    // (must be filtered out).
    const indexedRows = [
      {
        block: 50,
        ts: 1700000000,
        tx: '0xidx',
        logIndex: 2,
        token: TOKEN.toLowerCase(),
        from: ALICE.toLowerCase(),
        to: BOB.toLowerCase(),
        value: '5',
      },
      {
        block: 60,
        ts: 1700000100,
        tx: '0xelse',
        logIndex: 0,
        token: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
        from: ALICE.toLowerCase(),
        to: BOB.toLowerCase(),
        value: '99',
      },
    ];
    const body = indexedRows.map((r) => JSON.stringify(r)).join('\n') + '\n';

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/cursor.json')) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify(cursor),
          json: async () => cursor,
        } as Response;
      }
      if (url.endsWith('.jsonl')) {
        return {
          ok: true,
          status: 200,
          text: async () => body,
        } as Response;
      }
      // gz and any other suffixed shard: 404.
      return { ok: false, status: 404 } as Response;
    }) as typeof fetch;

    // RPC tail returns a newer row at block 150 (past the cursor).
    const rpcTail = [
      rpcLog({
        blockNumber: 150n,
        logIndex: 0,
        from: BOB,
        to: ALICE,
        value: 9n,
        txHash: '0xrpc',
      }),
    ];
    const client = {
      getLogs: vi.fn().mockResolvedValue(rpcTail),
    } as unknown as PublicClient;

    const out = await loadTokenRecentTransfers(client, TOKEN, 200n);
    // Two rows total: the RPC-tail row (block 150) and the indexed row
    // (block 50). The cross-token row at block 60 must be filtered out.
    expect(out).toHaveLength(2);
    expect(out[0]!.blockNumber).toBe(150n); // newest first
    expect(out[1]!.blockNumber).toBe(50n);
    expect(out[1]!.value).toBe(5n);
  });
});
