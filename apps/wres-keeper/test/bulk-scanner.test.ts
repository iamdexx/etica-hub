import { describe, expect, it, vi } from 'vitest';
import { scanEntireCollection } from '../src/bulk-scanner.js';
import type { Hex } from '../src/types.js';
import { makeLogger } from './fakes.js';

const TRON_RECIPIENT = '0x2222222222222222222222222222222222222222' as Hex;
const PAYOUT_WALLET = '0x3333333333333333333333333333333333333333' as Hex;
const CONTRACT = '0x1111111111111111111111111111111111111111' as `0x${string}`;

vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>();
  return {
    ...actual,
    createPublicClient: vi.fn(() => ({
      readContract: vi.fn(async ({ functionName, args }: { functionName: string; args?: unknown[] }) => {
        if (functionName === 'totalSupply') return 3n;
        if (functionName === 'tokenByIndex') {
          const idx = (args as bigint[])[0];
          return idx + 10n; // tokenIds: 10, 11, 12
        }
        return 0n;
      }),
      getBlockNumber: vi.fn(async () => 100n),
      getLogs: vi.fn(async () => []),
    })),
  };
});

describe('scanEntireCollection', () => {
  it('returns registrations for all tokens via Enumerable', async () => {
    const log = makeLogger();
    const registrations = await scanEntireCollection({
      rpcUrl: 'http://localhost:8545',
      contractAddress: CONTRACT,
      tronRecipient: TRON_RECIPIENT,
      payoutWallet: PAYOUT_WALLET,
      log,
    });

    expect(registrations).toHaveLength(3);
    expect(registrations[0]?.resTokenId).toBe(10n);
    expect(registrations[1]?.resTokenId).toBe(11n);
    expect(registrations[2]?.resTokenId).toBe(12n);
    expect(registrations[0]?.tronRecipient).toBe(TRON_RECIPIENT);
    expect(registrations[0]?.payoutWallet).toBe(PAYOUT_WALLET);
    expect(log.infos.join('\n')).toMatch(/3 token\(s\) scanned/);
  });
});
