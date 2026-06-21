import { describe, expect, it } from 'vitest';
import { executePlan } from '../src/executor.js';
import type { WresKeeperConfig } from '../src/config.js';
import type { Hex, KeeperPlan } from '../src/types.js';
import { makeEticaClient, makeLogger, makeTronClient } from './fakes.js';

const RECIPIENT = '0x2222222222222222222222222222222222222222' as Hex;
const PAYOUT = '0x3333333333333333333333333333333333333333' as Hex;

function baseConfig(over: Partial<WresKeeperConfig> = {}): WresKeeperConfig {
  return {
    eticaRpcUrl: 'http://etica',
    eticaChainId: 61803,
    etrx: null,
    etx: null,
    dexRouter: null,
    tronRpcUrl: 'http://tron',
    wrappedResMiner: null,
    trxReserve: null,
    tronFeeLimitSun: 150_000_000,
    keeperTronPrivateKey: null,
    keeperEticaPrivateKey: null,
    initialFrontSun: 0n,
    minPayoutSun: 1n,
    reserveTopUpBps: 100,
    keeperOpsBps: 100,
    maxSlippageBps: 100,
    scanLookbackBlocks: 5_000,
    pollIntervalMs: 60_000,
    dryRun: false,
    telegramBotToken: null,
    telegramChatId: null,
    ...over,
  };
}

const emptyPlan = (): KeeperPlan => ({ entries: [], payouts: [] });

describe('executePlan — dry-run', () => {
  it('broadcasts nothing but counts intended actions', async () => {
    const etica = makeEticaClient();
    const tron = makeTronClient({ frontable: 10_000_000n });
    const plan: KeeperPlan = {
      entries: [{ resTokenId: 1n, tronRecipient: RECIPIENT, payoutWallet: PAYOUT, initialFrontSun: 500_000n }],
      payouts: [
        {
          tokenId: 9n,
          payoutWallet: PAYOUT,
          claimableSun: 1_000_000n,
          split: { reserveTopUpSun: 10_000n, keeperOpsSun: 10_000n, payoutSun: 980_000n },
        },
      ],
    };

    const report = await executePlan(plan, {
      config: baseConfig({ dryRun: true }),
      etica,
      tron,
      log: makeLogger(),
    });

    expect(report).toEqual({ minted: 1, fronted: 0, paid: 1, skipped: 0 });
    expect(tron.mintTwin).not.toHaveBeenCalled();
    expect(tron.claimForPayout).not.toHaveBeenCalled();
    expect(etica.mintEtrx).not.toHaveBeenCalled();
  });
});

describe('executePlan — entries', () => {
  it('mints then fronts when the reserve budget covers it', async () => {
    const tron = makeTronClient({ frontable: 10_000_000n, mintTokenId: 5n });
    const report = await executePlan(
      {
        entries: [{ resTokenId: 1n, tronRecipient: RECIPIENT, payoutWallet: PAYOUT, initialFrontSun: 500_000n }],
        payouts: [],
      },
      { config: baseConfig(), etica: makeEticaClient(), tron, log: makeLogger() },
    );

    expect(tron.mintTwin).toHaveBeenCalledWith(RECIPIENT, PAYOUT, 1n);
    expect(tron.frontUpgrade).toHaveBeenCalledWith(5n, 500_000n);
    expect(report.minted).toBe(1);
    expect(report.fronted).toBe(1);
  });

  it('mints but skips fronting when the reserve budget is too thin', async () => {
    const tron = makeTronClient({ frontable: 100_000n }); // < 500k requested
    const log = makeLogger();
    const report = await executePlan(
      {
        entries: [{ resTokenId: 1n, tronRecipient: RECIPIENT, payoutWallet: PAYOUT, initialFrontSun: 500_000n }],
        payouts: [],
      },
      { config: baseConfig(), etica: makeEticaClient(), tron, log },
    );

    expect(tron.mintTwin).toHaveBeenCalledOnce();
    expect(tron.frontUpgrade).not.toHaveBeenCalled();
    expect(report.fronted).toBe(0);
    expect(log.warns.join('\n')).toMatch(/skipping frontUpgrade/);
  });

  it('debits the shared budget so a second entry cannot over-front', async () => {
    const tron = makeTronClient({ frontable: 700_000n });
    const report = await executePlan(
      {
        entries: [
          { resTokenId: 1n, tronRecipient: RECIPIENT, payoutWallet: PAYOUT, initialFrontSun: 500_000n },
          { resTokenId: 2n, tronRecipient: RECIPIENT, payoutWallet: PAYOUT, initialFrontSun: 500_000n },
        ],
        payouts: [],
      },
      { config: baseConfig(), etica: makeEticaClient(), tron, log: makeLogger() },
    );

    expect(report.minted).toBe(2);
    expect(report.fronted).toBe(1); // only the first fits in 700k
    expect(tron.frontUpgrade).toHaveBeenCalledTimes(1);
  });
});

describe('executePlan — payouts', () => {
  it('runs claim -> topUp -> mint -> approve -> quote -> swap with slippage floor', async () => {
    const tron = makeTronClient({ claimAmountSun: 1_000_000n });
    const etica = makeEticaClient({ quoteOut: 1_000_000_000_000_000_000n });
    const report = await executePlan(
      {
        entries: [],
        payouts: [
          {
            tokenId: 9n,
            payoutWallet: PAYOUT,
            claimableSun: 1_000_000n,
            split: { reserveTopUpSun: 10_000n, keeperOpsSun: 10_000n, payoutSun: 980_000n },
          },
        ],
      },
      { config: baseConfig(), etica, tron, log: makeLogger() },
    );

    expect(tron.claimForPayout).toHaveBeenCalledWith(9n);
    expect(tron.topUp).toHaveBeenCalledWith(10_000n); // 1% of 1 TRX
    // 980k SUN -> 0.98 eTRX (18dp) — 1% reserve + 1% keeper ops deducted
    expect(etica.mintEtrx).toHaveBeenCalledWith('0xKEEPER0000000000000000000000000000000001', 980_000_000_000_000_000n);
    expect(etica.approveEtrx).toHaveBeenCalledWith(980_000_000_000_000_000n);
    // minOut = quote * (10000-100)/10000 = 0.99 * quote
    expect(etica.swapEtrxForEtx).toHaveBeenCalledWith(
      980_000_000_000_000_000n,
      990_000_000_000_000_000n,
      PAYOUT,
    );
    expect(report.paid).toBe(1);
  });

  it('re-derives the split from the actually-claimed amount', async () => {
    const tron = makeTronClient({ claimAmountSun: 2_000_000n }); // differs from planned snapshot
    const etica = makeEticaClient();
    await executePlan(
      {
        entries: [],
        payouts: [
          {
            tokenId: 9n,
            payoutWallet: PAYOUT,
            claimableSun: 1_000_000n, // stale
            split: { reserveTopUpSun: 10_000n, keeperOpsSun: 10_000n, payoutSun: 980_000n },
          },
        ],
      },
      { config: baseConfig(), etica, tron, log: makeLogger() },
    );
    expect(tron.topUp).toHaveBeenCalledWith(20_000n); // 1% of the real 2 TRX
  });
});

describe('executePlan — error isolation', () => {
  it('isolates a failing item and keeps going (counts skipped)', async () => {
    const tron = makeTronClient();
    tron.mintTwin.mockRejectedValueOnce(new Error('rpc down'));
    const log = makeLogger();
    const report = await executePlan(
      {
        entries: [
          { resTokenId: 1n, tronRecipient: RECIPIENT, payoutWallet: PAYOUT, initialFrontSun: 0n },
          { resTokenId: 2n, tronRecipient: RECIPIENT, payoutWallet: PAYOUT, initialFrontSun: 0n },
        ],
        payouts: [],
      },
      { config: baseConfig(), etica: makeEticaClient(), tron, log },
    );
    expect(report.minted).toBe(1);
    expect(report.skipped).toBe(1);
    expect(log.errors.join('\n')).toMatch(/entry resTokenId=1 failed: rpc down/);
  });

  it('does nothing on an empty plan', async () => {
    const tron = makeTronClient();
    const etica = makeEticaClient();
    const report = await executePlan(emptyPlan(), { config: baseConfig(), etica, tron, log: makeLogger() });
    expect(report).toEqual({ minted: 0, fronted: 0, paid: 0, skipped: 0 });
    expect(tron.frontableNow).not.toHaveBeenCalled();
  });
});
