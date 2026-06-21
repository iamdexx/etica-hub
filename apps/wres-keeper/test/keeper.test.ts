import { describe, expect, it } from 'vitest';
import { runTick, type Keeper } from '../src/keeper.js';
import type { WresKeeperConfig } from '../src/config.js';
import type { Hex, Registration, TwinRecord } from '../src/types.js';
import { makeEticaClient, makeLogger, makeTronClient } from './fakes.js';

function config(over: Partial<WresKeeperConfig> = {}): WresKeeperConfig {
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
    minPayoutSun: 1_000_000n,
    reserveTopUpBps: 100,
    keeperOpsBps: 100,
    maxSlippageBps: 100,
    scanLookbackBlocks: 5_000,
    pollIntervalMs: 60_000,
    dryRun: true,
    ...over,
    telegramBotToken: null,
    telegramChatId: null,
  };
}

describe('runTick', () => {
  it('returns an empty report and executes nothing on an idle tick', async () => {
    const tron = makeTronClient();
    const etica = makeEticaClient();
    const keeper: Keeper = { config: config(), etica, tron, log: makeLogger() };

    const report = await runTick(keeper);
    expect(report).toEqual({ minted: 0, fronted: 0, paid: 0, skipped: 0 });
    expect(tron.mintTwin).not.toHaveBeenCalled();
  });

  it('observes -> plans -> executes a full pass (dry-run)', async () => {
    const reg: Registration = {
      resTokenId: 1n,
      tronRecipient: '0x2222222222222222222222222222222222222222' as Hex,
      payoutWallet: '0x3333333333333333333333333333333333333333' as Hex,
    };
    const twin: TwinRecord = {
      tokenId: 7n,
      resTokenId: 2n,
      payoutWallet: '0x3333333333333333333333333333333333333333' as Hex,
      pendingSun: 5_000_000n,
    };

    const etica = makeEticaClient({ registrations: [reg] });
    const tron = makeTronClient({
      observation: { mintedByResTokenId: new Map([['2', 7n]]), twins: [twin] },
    });

    const report = await runTick({ config: config(), etica, tron, log: makeLogger() });
    // 1 new registration to mint, 1 twin above threshold to pay
    expect(report.minted).toBe(1);
    expect(report.paid).toBe(1);
    // dry-run: nothing actually broadcast
    expect(tron.mintTwin).not.toHaveBeenCalled();
  });
});
