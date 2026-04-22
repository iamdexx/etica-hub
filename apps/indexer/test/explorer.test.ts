import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Log } from 'viem';

import {
  appendSyncs,
  appendTransfers,
  loadCursor,
  partitionPath,
  saveCursor,
} from '../src/explorer/io';
import { decodeSync, decodeTransfer } from '../src/explorer/scan';
import { SYNC_TOPIC0, TRANSFER_TOPIC0, type IndexCursor } from '../src/explorer/types';

function mkdir(): string {
  return mkdtempSync(join(tmpdir(), 'explorer-index-test-'));
}

const ADDR = (hex: string): `0x${string}` =>
  `0x${hex.padStart(40, '0')}` as `0x${string}`;

const TOPIC_ADDR = (hex: string): `0x${string}` =>
  `0x${hex.padStart(64, '0')}` as `0x${string}`;

const TRANSFER_LOG = (opts: {
  block?: bigint;
  logIndex?: number;
  token?: `0x${string}`;
  from?: `0x${string}`;
  to?: `0x${string}`;
  value?: bigint;
  tx?: `0x${string}`;
}): Log =>
  ({
    blockNumber: opts.block ?? 100n,
    logIndex: opts.logIndex ?? 0,
    transactionHash: opts.tx ?? ('0xabc' as `0x${string}`),
    address: opts.token ?? ADDR('feed'),
    topics: [
      TRANSFER_TOPIC0 as `0x${string}`,
      TOPIC_ADDR((opts.from ?? ADDR('aa')).slice(2)),
      TOPIC_ADDR((opts.to ?? ADDR('bb')).slice(2)),
    ],
    data: `0x${(opts.value ?? 1_000_000n).toString(16).padStart(64, '0')}` as `0x${string}`,
    removed: false,
  }) as unknown as Log;

describe('partitionPath', () => {
  it('bucketizes by UTC day', () => {
    expect(partitionPath('transfers', 0)).toBe('transfers/1970/01/01.jsonl');
    expect(partitionPath('transfers', 1700006400)).toBe(
      'transfers/2023/11/15.jsonl',
    );
  });
});

describe('cursor IO', () => {
  it('round-trips through save + load', () => {
    const dir = mkdir();
    const cursor: IndexCursor = {
      lastBlock: 12345,
      chainId: 61803,
      updatedAt: '2025-01-01T00:00:00.000Z',
      runs: 3,
      cumulative: { transfers: 42, syncs: 7 },
    };
    saveCursor(dir, cursor);
    expect(loadCursor(dir)).toEqual(cursor);
  });

  it('returns null when no cursor has been saved', () => {
    expect(loadCursor(mkdir())).toBeNull();
  });
});

describe('appendRows', () => {
  it('writes one line per row, partitioned by day', () => {
    const dir = mkdir();
    const day1 = 1700006400; // 2023-11-15
    const day2 = day1 + 86_400;
    appendTransfers(dir, [
      {
        block: 1,
        ts: day1,
        tx: '0x01',
        logIndex: 0,
        token: ADDR('aa'),
        from: ADDR('b1'),
        to: ADDR('b2'),
        value: '1',
      },
      {
        block: 2,
        ts: day1,
        tx: '0x02',
        logIndex: 0,
        token: ADDR('aa'),
        from: ADDR('b1'),
        to: ADDR('b3'),
        value: '2',
      },
      {
        block: 3,
        ts: day2,
        tx: '0x03',
        logIndex: 0,
        token: ADDR('aa'),
        from: ADDR('b1'),
        to: ADDR('b4'),
        value: '3',
      },
    ]);
    const p1 = join(dir, 'transfers/2023/11/15.jsonl');
    const p2 = join(dir, 'transfers/2023/11/16.jsonl');
    expect(existsSync(p1)).toBe(true);
    expect(existsSync(p2)).toBe(true);
    expect(readFileSync(p1, 'utf8').trim().split('\n')).toHaveLength(2);
    expect(readFileSync(p2, 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it('appends to an existing partition without overwriting', () => {
    const dir = mkdir();
    const ts = 1700006400;
    const base = {
      block: 1,
      ts,
      tx: '0x00',
      logIndex: 0,
      pair: ADDR('aa'),
      reserve0: '1',
      reserve1: '2',
    };
    appendSyncs(dir, [base]);
    appendSyncs(dir, [{ ...base, logIndex: 1 }]);
    const p = join(dir, 'syncs/2023/11/15.jsonl');
    expect(readFileSync(p, 'utf8').trim().split('\n')).toHaveLength(2);
  });

  it('is a no-op for empty input', () => {
    const dir = mkdir();
    appendTransfers(dir, []);
    appendSyncs(dir, []);
    expect(existsSync(join(dir, 'transfers'))).toBe(false);
  });
});

describe('decodeTransfer', () => {
  it('parses a canonical ERC-20 transfer', () => {
    const row = decodeTransfer(
      TRANSFER_LOG({
        block: 42n,
        logIndex: 3,
        token: ADDR('feed'),
        from: ADDR('a1'),
        to: ADDR('a2'),
        value: 1_500_000_000_000_000_000n,
      }),
      1700000000,
    );
    expect(row).not.toBeNull();
    expect(row!.block).toBe(42);
    expect(row!.ts).toBe(1700000000);
    expect(row!.logIndex).toBe(3);
    expect(row!.value).toBe('1500000000000000000');
    expect(row!.from).toMatch(/^0x[0-9a-f]{40}$/);
  });

  it('rejects logs with non-transfer topic0', () => {
    const log = TRANSFER_LOG({});
    (log as unknown as { topics: string[] }).topics[0] = '0xdead';
    expect(decodeTransfer(log, 0)).toBeNull();
  });

  it('rejects logs missing indexed params (ERC-721 mint edge cases)', () => {
    const log = TRANSFER_LOG({});
    (log as unknown as { topics: unknown[] }).topics = [TRANSFER_TOPIC0];
    expect(decodeTransfer(log, 0)).toBeNull();
  });

  it('rejects logs with non-uint256 data (ERC-1155 et al)', () => {
    const log = TRANSFER_LOG({});
    (log as unknown as { data: string }).data = `0x${'00'.repeat(128)}`;
    expect(decodeTransfer(log, 0)).toBeNull();
  });
});

describe('decodeSync', () => {
  function SYNC_LOG(r0: bigint, r1: bigint): Log {
    return {
      blockNumber: 50n,
      logIndex: 1,
      transactionHash: '0xdef' as `0x${string}`,
      address: ADDR('beef'),
      topics: [SYNC_TOPIC0 as `0x${string}`],
      data: `0x${r0.toString(16).padStart(64, '0')}${r1.toString(16).padStart(64, '0')}` as `0x${string}`,
      removed: false,
    } as unknown as Log;
  }

  it('parses reserves as decimal strings', () => {
    const row = decodeSync(SYNC_LOG(1n << 100n, 12345n), 1700000000);
    expect(row).not.toBeNull();
    expect(row!.reserve0).toBe((1n << 100n).toString());
    expect(row!.reserve1).toBe('12345');
    expect(row!.pair).toMatch(/^0x[0-9a-f]{40}$/);
  });

  it('rejects logs with wrong topic', () => {
    const log = SYNC_LOG(1n, 2n);
    (log as unknown as { topics: string[] }).topics[0] = '0x00';
    expect(decodeSync(log, 0)).toBeNull();
  });
});
