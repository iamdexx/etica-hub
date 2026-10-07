import { describe, it, expect } from 'vitest';
import { parseEther, parseUnits } from 'viem';
import { DEPLOYMENTS, USDC_WARP_ROUTE, eticaMainnet } from '@etica-hub/shared';

import { DEAD_ADDRESS, ETHEREUM_MAILBOX, FLASHBOTS_PROTECT_RPC, PUBLIC_ETHEREUM_RPCS, loadBridgeSeedConfig } from '../src/bridge-seed/config.js';
import {
  affordableBridgeAmount,
  etxRequired,
  marketUsdPerEtx,
  poolUsdPerEtx,
  priceDeviationBps,
  withSlippage,
} from '../src/bridge-seed/plan.js';

const KEY = ('0x' + '11'.repeat(32)) as `0x${string}`;
const base = { HARVEST_PRIVATE_KEY: KEY, BRIDGE_SEED_ETX_AMOUNT: '5000' };

describe('loadBridgeSeedConfig', () => {
  it('pins every contract address in code and reads only amounts/anchors from env', () => {
    const c = loadBridgeSeedConfig({ ...base, BRIDGE_SEED_USDC_AMOUNT: '20', BRIDGE_SEED_EGAZ_USD: '0.0142' });
    expect(c.dryRun).toBe(false);
    expect(c.etxAmount).toBe(parseEther('5000'));
    expect(c.usdcAmount).toBe(parseUnits('20', 6));
    expect(c.egazUsd).toBe(parseEther('0.0142'));
    expect(c.maxPriceDeviationBps).toBe(300);
    expect(c.ethereum.usdc).toBe(USDC_WARP_ROUTE.collateralToken);
    expect(c.ethereum.warpRouter).toBe(USDC_WARP_ROUTE.collateralRouter);
    expect(c.ethereum.mailbox).toBe(ETHEREUM_MAILBOX);
    expect(c.ethereum.writeRpcUrl).toBe(FLASHBOTS_PROTECT_RPC);
    expect(c.ethereum.rpcUrls).toEqual([...PUBLIC_ETHEREUM_RPCS]);
    expect(c.etica.usdce).toBe(USDC_WARP_ROUTE.syntheticToken);
    expect(c.etica.etx).toBe(DEPLOYMENTS[eticaMainnet.id].etx);
    expect(c.etica.swapRouter).toBe(DEPLOYMENTS[eticaMainnet.id].swapRouter);
    expect(c.etica.swapFactory).toBe(DEPLOYMENTS[eticaMainnet.id].swapFactory);
    expect(DEAD_ADDRESS).toBe('0x000000000000000000000000000000000000dEaD');
  });

  it('defaults to bridging everything and skipping the price check when no USDC amount / anchor is set', () => {
    const c = loadBridgeSeedConfig(base);
    expect(c.usdcAmount).toBeNull();
    expect(c.egazUsd).toBeNull();
    expect(c.mintTimeoutMs).toBe(2_400_000);
  });

  it('is a dry run without a key, or when the flag says so', () => {
    expect(loadBridgeSeedConfig({ BRIDGE_SEED_ETX_AMOUNT: '1' }).dryRun).toBe(true);
    expect(loadBridgeSeedConfig({ ...base, BRIDGE_SEED_DRY_RUN: 'true' }).dryRun).toBe(true);
  });

  it('requires a positive ETX amount and rejects zero / malformed amounts', () => {
    expect(() => loadBridgeSeedConfig({ HARVEST_PRIVATE_KEY: KEY })).toThrow('BRIDGE_SEED_ETX_AMOUNT');
    expect(() => loadBridgeSeedConfig({ ...base, BRIDGE_SEED_ETX_AMOUNT: '0' })).toThrow('BRIDGE_SEED_ETX_AMOUNT');
    expect(() => loadBridgeSeedConfig({ ...base, BRIDGE_SEED_USDC_AMOUNT: '0' })).toThrow('BRIDGE_SEED_USDC_AMOUNT');
    expect(() => loadBridgeSeedConfig({ ...base, BRIDGE_SEED_USDC_AMOUNT: '1e3' })).toThrow('decimal');
    expect(() => loadBridgeSeedConfig({ ...base, BRIDGE_SEED_EGAZ_USD: '0' })).toThrow('BRIDGE_SEED_EGAZ_USD');
    expect(() => loadBridgeSeedConfig({ ...base, BRIDGE_SEED_MAX_PRICE_DEVIATION_BPS: '0' })).toThrow('MAX_PRICE_DEVIATION');
  });

  it('only lets a local fork override the mailbox or skip Flashbots, and never mixes a fork with mainnet endpoints', () => {
    expect(() => loadBridgeSeedConfig({ ...base, BRIDGE_SEED_ETHEREUM_MAILBOX: ETHEREUM_MAILBOX })).toThrow('local fork');
    const fork = loadBridgeSeedConfig({
      ...base,
      BRIDGE_SEED_ETHEREUM_RPC_URL: 'http://127.0.0.1:8551',
      BRIDGE_SEED_ETHEREUM_MAILBOX: '0x00000000000000000000000000000000000000aa',
    });
    expect(fork.ethereum.rpcUrls).toEqual(['http://127.0.0.1:8551']);
    expect(fork.ethereum.writeRpcUrl).toBe('http://127.0.0.1:8551');
    expect(fork.ethereum.mailbox).toBe('0x00000000000000000000000000000000000000aa');
    const mixed = loadBridgeSeedConfig({ ...base, BRIDGE_SEED_ETHEREUM_RPC_URL: 'https://eth.example' });
    expect(mixed.ethereum.rpcUrls).toEqual(['https://eth.example', ...PUBLIC_ETHEREUM_RPCS]);
    expect(mixed.ethereum.writeRpcUrl).toBe(FLASHBOTS_PROTECT_RPC);
  });
});

describe('seed arithmetic', () => {
  it('bridges what fits after the fee quoted at the full balance', () => {
    // 20.373671 USDC, 50 bps fee quoted at the full balance = 0.101868
    expect(affordableBridgeAmount(20_373_671n, 101_868n)).toBe(20_271_803n);
    expect(affordableBridgeAmount(50n, 100n)).toBe(0n);
  });

  it('adds the pair-creation fee only when this call opens the pair and the fee is actually charged', () => {
    const etx = parseEther('5000');
    const fee = parseEther('10000');
    expect(etxRequired(etx, { exists: false, creationFee: fee, feeToSet: true, routerTrusted: false })).toBe(etx + fee);
    expect(etxRequired(etx, { exists: true, creationFee: fee, feeToSet: true, routerTrusted: false })).toBe(etx);
    expect(etxRequired(etx, { exists: false, creationFee: fee, feeToSet: false, routerTrusted: false })).toBe(etx);
    expect(etxRequired(etx, { exists: false, creationFee: fee, feeToSet: true, routerTrusted: true })).toBe(etx);
    expect(etxRequired(etx, { exists: false, creationFee: 0n, feeToSet: true, routerTrusted: false })).toBe(etx);
  });

  it('compares the seed price with the ETX/WEGAZ-implied price in bps', () => {
    // 20.27 USDC.e vs 5000 ETX = 0.004054 USD/ETX
    const pool = poolUsdPerEtx(20_271_803n, 6, parseEther('5000'));
    expect(pool).toBe(4_054_360_600_000_000n);
    // 1 ETX = 0.2841 WEGAZ, EGAZ = $0.01428818 -> 0.0040593 USD/ETX
    const market = marketUsdPerEtx(parseEther('0.284103604094028628'), parseEther('0.01428818'));
    expect(market).toBe(4_059_323_433_944_217n);
    expect(priceDeviationBps(pool, market)).toBe(12n);
    expect(priceDeviationBps(market * 2n, market)).toBe(10_000n);
    expect(priceDeviationBps(pool, 0n)).toBeNull();
    expect(poolUsdPerEtx(1n, 6, 0n)).toBe(0n);
  });

  it('applies liquidity slippage in bps', () => {
    expect(withSlippage(10_000n, 50)).toBe(9_950n);
    expect(withSlippage(10_000n, 0)).toBe(10_000n);
  });
});
