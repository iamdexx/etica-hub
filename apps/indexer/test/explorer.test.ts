import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import type { Log } from 'viem';

import {
  appendSyncs,
  appendTransfers,
  loadCursor,
  partitionPath,
  ROLLOVER_THRESHOLD_BYTES,
  saveCursor,
  shardPath,
} from '../src/explorer/io';
import { decodeSync, decodeTransfer } from '../src/explorer/scan';
import { SYNC_TOPIC0, TRANSFER_TOPIC0, type IndexCursor } from '../src/explorer/types';

function mkdir(): string {
  return mkdtempSync(join(tmpdir(), 'explorer-index-test-'));
}

function readJsonl(path: string): string {
  return gunzipSync(readFileSync(path)).toString('utf8');
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
  it('bucketizes by UTC day and defaults to shard 0 gzip', () => {
    expect(partitionPath('transfers', 0)).toBe('transfers/1970/01/01.jsonl.gz');
    expect(partitionPath('transfers', 1700006400)).toBe(
      'transfers/2023/11/15.jsonl.gz',
    );
  });

  it('shardPath uses a numeric suffix for shards past 0', () => {
    expect(shardPath('transfers', '2023/11/15', 0)).toBe(
      'transfers/2023/11/15.jsonl.gz',
    );
    expect(shardPath('transfers', '2023/11/15', 3)).toBe(
      'transfers/2023/11/15.3.jsonl.gz',
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
  it('writes one gzipped line per row, partitioned by day', () => {
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
    const p1 = join(dir, 'transfers/2023/11/15.jsonl.gz');
    const p2 = join(dir, 'transfers/2023/11/16.jsonl.gz');
    expect(existsSync(p1)).toBe(true);
    expect(existsSync(p2)).toBe(true);
    expect(readJsonl(p1).trim().split('\n')).toHaveLength(2);
    expect(readJsonl(p2).trim().split('\n')).toHaveLength(1);
  });

  it('appends to an existing shard 0 without overwriting', () => {
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
    const p = join(dir, 'syncs/2023/11/15.jsonl.gz');
    expect(readJsonl(p).trim().split('\n')).toHaveLength(2);
  });

  it('is a no-op for empty input', () => {
    const dir = mkdir();
    appendTransfers(dir, []);
    appendSyncs(dir, []);
    expect(existsSync(join(dir, 'transfers'))).toBe(false);
  });

  it('migrates a legacy .jsonl partition into shard 0 on first write', () => {
    const dir = mkdir();
    const ts = 1700006400; // 2023-11-15
    const legacy = join(dir, 'syncs/2023/11/15.jsonl');
    const gzipped = join(dir, 'syncs/2023/11/15.jsonl.gz');
    mkdirSync(dirname(legacy), { recursive: true });
    writeFileSync(
      legacy,
      `${JSON.stringify({
        block: 1,
        ts,
        tx: '0x00',
        logIndex: 0,
        pair: ADDR('aa'),
        reserve0: '1',
        reserve1: '2',
      })}\n`,
    );
    appendSyncs(dir, [
      {
        block: 2,
        ts,
        tx: '0x01',
        logIndex: 1,
        pair: ADDR('aa'),
        reserve0: '3',
        reserve1: '4',
      },
    ]);
    expect(existsSync(legacy)).toBe(false);
    expect(existsSync(gzipped)).toBe(true);
    const lines = readJsonl(gzipped).trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).tx).toBe('0x00');
    expect(JSON.parse(lines[1]!).tx).toBe('0x01');
  });

  it('rolls over to shard 1 once shard 0 crosses the threshold', () => {
    const dir = mkdir();
    const ts = 1700006400; // 2023-11-15
    const shard0 = join(dir, 'transfers/2023/11/15.jsonl.gz');
    const shard1 = join(dir, 'transfers/2023/11/15.1.jsonl.gz');
    mkdirSync(dirname(shard0), { recursive: true });
    // Fabricate a shard 0 that already exceeds ROLLOVER_THRESHOLD_BYTES
    // on disk. We gzip random-ish JSONL of the right size so the file
    // is both gunzip-valid and over-threshold, mirroring what a real
    // indexer would produce after accumulating millions of rows.
    const filler = JSON.stringify({
      block: 0,
      ts,
      tx: '0xfiller',
      logIndex: 0,
      token: ADDR('ff'),
      from: ADDR('aa'),
      to: ADDR('bb'),
      value: '1',
    });
    // Use uncompressible content so gzip size ~= raw size; easiest
    // way is to bypass compression semantics by pre-gzipping a big
    // raw payload and then padding the file directly.
    const rawJsonl = `${filler}\n`.repeat(64);
    writeFileSync(shard0, gzipSync(rawJsonl));
    // Now pad the shard 0 file on disk so its size crosses the
    // threshold. Readers don't validate the gzip tail, but the writer
    // only looks at `statSync(path).size`, which is what drives the
    // rollover decision.
    const padding = Buffer.alloc(ROLLOVER_THRESHOLD_BYTES);
    writeFileSync(shard0, Buffer.concat([readFileSync(shard0), padding]));
    expect(statSync(shard0).size).toBeGreaterThanOrEqual(ROLLOVER_THRESHOLD_BYTES);

    appendTransfers(dir, [
      {
        block: 1,
        ts,
        tx: '0x01',
        logIndex: 0,
        token: ADDR('aa'),
        from: ADDR('b1'),
        to: ADDR('b2'),
        value: '1',
      },
    ]);

    // Shard 0 is unchanged and shard 1 carries the new row alone.
    expect(existsSync(shard1)).toBe(true);
    const shard1Lines = readJsonl(shard1).trim().split('\n');
    expect(shard1Lines).toHaveLength(1);
    expect(JSON.parse(shard1Lines[0]!).tx).toBe('0x01');

    // A subsequent write lands in shard 1 (still below threshold),
    // never touches shard 0.
    appendTransfers(dir, [
      {
        block: 2,
        ts,
        tx: '0x02',
        logIndex: 0,
        token: ADDR('aa'),
        from: ADDR('b3'),
        to: ADDR('b4'),
        value: '1',
      },
    ]);
    const shard1After = readJsonl(shard1).trim().split('\n');
    expect(shard1After).toHaveLength(2);
    expect(JSON.parse(shard1After[1]!).tx).toBe('0x02');
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
    (log as unknown as { topics: string[] }).topics = [
      TRANSFER_TOPIC0 as string,
    ];
    expect(decodeTransfer(log, 0)).toBeNull();
  });
});

describe('decodeSync', () => {
  it('parses a V2 Sync event', () => {
    const log = {
      blockNumber: 10n,
      logIndex: 1,
      transactionHash: '0xdef' as `0x${string}`,
      address: ADDR('cafe'),
      topics: [SYNC_TOPIC0 as `0x${string}`],
      data: (`0x${(1_000n).toString(16).padStart(64, '0')}${(2_000n).toString(16).padStart(64, '0')}`) as `0x${string}`,
      removed: false,
    } as unknown as Log;
    const row = decodeSync(log, 1700000000);
    expect(row).not.toBeNull();
    expect(row!.pair).toMatch(/^0x[0-9a-f]{40}$/);
    expect(row!.reserve0).toBe('1000');
    expect(row!.reserve1).toBe('2000');
  });
});
