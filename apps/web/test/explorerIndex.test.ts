import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchIndexedAddressTransfers,
  fetchIndexedCursor,
  fetchIndexedPairSyncs,
  parseJsonl,
  recentPartitionKeys,
  type IndexedCursor,
  type IndexedTransferRow,
  type IndexedSyncRow,
} from '../src/lib/explorerIndex';

const ORIG_FETCH = globalThis.fetch;

function mockFetch(handler: (url: string) => { ok: boolean; body: string }) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    const { ok, body } = handler(url);
    return {
      ok,
      status: ok ? 200 : 404,
      text: async () => body,
      json: async () => JSON.parse(body),
    } as Response;
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = ORIG_FETCH;
  vi.useRealTimers();
});

describe('recentPartitionKeys', () => {
  it('walks backwards N days in UTC', () => {
    const keys = recentPartitionKeys(new Date('2025-11-15T00:00:00Z'), 3);
    expect(keys).toEqual(['2025/11/15', '2025/11/14', '2025/11/13']);
  });

  it('crosses month boundaries correctly', () => {
    const keys = recentPartitionKeys(new Date('2025-12-02T00:00:00Z'), 4);
    expect(keys).toEqual(['2025/12/02', '2025/12/01', '2025/11/30', '2025/11/29']);
  });
});

describe('parseJsonl', () => {
  it('parses line-delimited JSON', () => {
    const body = '{"a":1}\n{"a":2}\n{"a":3}\n';
    expect(parseJsonl<{ a: number }>(body)).toEqual([{ a: 1 }, { a: 2 }, { a: 3 }]);
  });

  it('skips malformed lines without bailing', () => {
    const body = '{"a":1}\nthis is not json\n{"a":2}\n';
    expect(parseJsonl<{ a: number }>(body)).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('tolerates trailing blank lines and empty input', () => {
    expect(parseJsonl('\n\n')).toEqual([]);
    expect(parseJsonl('')).toEqual([]);
  });
});

describe('fetchIndexedCursor', () => {
  it('returns null when the cursor file is absent', async () => {
    mockFetch(() => ({ ok: false, body: '' }));
    expect(await fetchIndexedCursor()).toBeNull();
  });

  it('returns the parsed cursor when present', async () => {
    const cursor: IndexedCursor = {
      lastBlock: 123,
      chainId: 61803,
      updatedAt: '2025-01-01T00:00:00.000Z',
      runs: 1,
      cumulative: { transfers: 10, syncs: 2 },
    };
    mockFetch(() => ({ ok: true, body: JSON.stringify(cursor) }));
    expect(await fetchIndexedCursor()).toEqual(cursor);
  });

  it('swallows fetch errors and returns null', async () => {
    globalThis.fetch = (() => {
      throw new Error('network blew up');
    }) as unknown as typeof fetch;
    expect(await fetchIndexedCursor()).toBeNull();
  });
});

describe('fetchIndexedAddressTransfers', () => {
  const ADDR = '0x1111111111111111111111111111111111111111';
  const OTHER = '0x2222222222222222222222222222222222222222';

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-11-15T12:00:00Z'));
  });

  function row(over: Partial<IndexedTransferRow>): IndexedTransferRow {
    return {
      block: 1,
      ts: 1700000000,
      tx: '0xtx',
      logIndex: 0,
      token: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      from: OTHER,
      to: OTHER,
      value: '1',
      ...over,
    };
  }

  it('returns null when the data branch is not yet populated', async () => {
    mockFetch(() => ({ ok: false, body: '' }));
    expect(await fetchIndexedAddressTransfers({ address: ADDR })).toBeNull();
  });

  it('filters rows by from or to match, newest first', async () => {
    const cursor: IndexedCursor = {
      lastBlock: 10,
      chainId: 61803,
      updatedAt: '2025-11-15T12:00:00Z',
      runs: 1,
      cumulative: { transfers: 5, syncs: 0 },
    };
    const today = [
      row({ block: 10, logIndex: 1, tx: '0xa', from: ADDR }),
      row({ block: 10, logIndex: 0, tx: '0xb', to: ADDR }),
      row({ block: 9, tx: '0xc', from: OTHER, to: OTHER }),
    ];
    const yesterday = [row({ block: 5, tx: '0xd', to: ADDR })];

    mockFetch((url) => {
      if (url.endsWith('/cursor.json')) {
        return { ok: true, body: JSON.stringify(cursor) };
      }
      if (url.endsWith('/transfers/2025/11/15.jsonl')) {
        return { ok: true, body: today.map((r) => JSON.stringify(r)).join('\n') };
      }
      if (url.endsWith('/transfers/2025/11/14.jsonl')) {
        return {
          ok: true,
          body: yesterday.map((r) => JSON.stringify(r)).join('\n'),
        };
      }
      return { ok: false, body: '' };
    });

    const result = await fetchIndexedAddressTransfers({ address: ADDR, days: 2 });
    expect(result).not.toBeNull();
    expect(result!.rows.map((r) => r.tx)).toEqual(['0xa', '0xb', '0xd']);
  });

  it('applies the limit after sorting', async () => {
    const cursor: IndexedCursor = {
      lastBlock: 5,
      chainId: 61803,
      updatedAt: '2025-11-15T00:00:00Z',
      runs: 1,
      cumulative: { transfers: 5, syncs: 0 },
    };
    const rows = [
      row({ block: 5, tx: '0xa', from: ADDR }),
      row({ block: 4, tx: '0xb', from: ADDR }),
      row({ block: 3, tx: '0xc', from: ADDR }),
    ];
    mockFetch((url) => {
      if (url.endsWith('/cursor.json')) return { ok: true, body: JSON.stringify(cursor) };
      if (url.endsWith('/transfers/2025/11/15.jsonl')) {
        return { ok: true, body: rows.map((r) => JSON.stringify(r)).join('\n') };
      }
      return { ok: false, body: '' };
    });
    const res = await fetchIndexedAddressTransfers({
      address: ADDR,
      days: 1,
      limit: 2,
    });
    expect(res!.rows.map((r) => r.tx)).toEqual(['0xa', '0xb']);
  });
});

describe('fetchIndexedPairSyncs', () => {
  const PAIR = '0x3333333333333333333333333333333333333333';

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-11-15T12:00:00Z'));
  });

  it('returns null when cursor missing', async () => {
    mockFetch(() => ({ ok: false, body: '' }));
    expect(await fetchIndexedPairSyncs(PAIR, 1)).toBeNull();
  });

  it('filters sync rows by pair and sorts ascending', async () => {
    const cursor: IndexedCursor = {
      lastBlock: 10,
      chainId: 61803,
      updatedAt: '2025-11-15T12:00:00Z',
      runs: 1,
      cumulative: { transfers: 0, syncs: 5 },
    };
    const rows: IndexedSyncRow[] = [
      {
        block: 9,
        ts: 1,
        tx: '0xa',
        logIndex: 2,
        pair: PAIR,
        reserve0: '100',
        reserve1: '200',
      },
      {
        block: 10,
        ts: 2,
        tx: '0xb',
        logIndex: 0,
        pair: PAIR,
        reserve0: '101',
        reserve1: '199',
      },
      {
        block: 10,
        ts: 2,
        tx: '0xc',
        logIndex: 5,
        pair: '0x9999999999999999999999999999999999999999',
        reserve0: '999',
        reserve1: '999',
      },
    ];
    mockFetch((url) => {
      if (url.endsWith('/cursor.json')) return { ok: true, body: JSON.stringify(cursor) };
      if (url.endsWith('/syncs/2025/11/15.jsonl')) {
        return { ok: true, body: rows.map((r) => JSON.stringify(r)).join('\n') };
      }
      return { ok: false, body: '' };
    });
    const res = await fetchIndexedPairSyncs(PAIR, 1);
    expect(res!.rows.map((r) => r.tx)).toEqual(['0xa', '0xb']);
  });
});
