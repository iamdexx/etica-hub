import { describe, it, expect } from 'vitest';
import { parseEther, parseUnits } from 'viem';

import { loadBridgeGasConfig, ETHEREUM_USDC, UNISWAP_V2_ROUTER } from '../src/bridge-gas/config.js';
import { claimAmount, decideLeg, nativeNeeded, priceImpactBps } from '../src/bridge-gas/plan.js';

const KEY = ('0x' + '11'.repeat(32)) as `0x${string}`;
const FEE = '0x00000000000000000000000000000000000000f1';
const USDCE = '0x00000000000000000000000000000000000000e1';
const ETH_RPC = 'https://eth.example';

const t = {
  minNative: parseEther('0.05'),
  targetNative: parseEther('0.15'),
  minStable: parseUnits('1', 6),
  maxSlippageBps: 300,
};

function snap(over: Partial<Parameters<typeof decideLeg>[0]> = {}) {
  return {
    nativeBalance: parseEther('0.01'),
    feeContractBalance: parseUnits('120', 6),
    walletStable: 0n,
    keeperOwnsFeeContract: true,
    ...over,
  };
}

// 0.14 ETH for 380 USDC, marginal 1 USDC -> 0.000370 ETH (so ~0.5% impact)
const quote = {
  amountIn: parseUnits('380', 6),
  amountOut: parseEther('0.14'),
  probeIn: parseUnits('1', 6),
  probeOut: parseEther('0.00037'),
};

describe('loadBridgeGasConfig', () => {
  it('builds both legs from the harvest signer and marks Etica unconfigured until USDC.e exists', () => {
    const cfg = loadBridgeGasConfig({ HARVEST_PRIVATE_KEY: KEY, BRIDGE_GAS_ETHEREUM_RPC_URL: ETH_RPC });
    expect(cfg.dryRun).toBe(false);
    expect(cfg.legs.map((l) => l.name)).toEqual(['ethereum', 'etica']);
    const [eth, etica] = cfg.legs;
    expect(eth!.stable).toBe(ETHEREUM_USDC);
    expect(eth!.router).toBe(UNISWAP_V2_ROUTER);
    expect(eth!.feeContract).toBeNull();
    expect(etica!.stable).toBeNull();
    expect(etica!.path).toEqual([]);
  });

  it('routes USDC.e through ETX to WEGAZ once configured', () => {
    const cfg = loadBridgeGasConfig({
      BRIDGE_GAS_ETHEREUM_RPC_URL: ETH_RPC,
      BRIDGE_GAS_ETICA_STABLE: USDCE,
      BRIDGE_GAS_ETICA_FEE_CONTRACT: FEE,
    });
    const etica = cfg.legs[1]!;
    expect(etica.path).toHaveLength(3);
    expect(etica.path[0]).toBe(USDCE);
    expect(etica.path[2]).toBe(etica.wrappedNative);
    expect(etica.feeContract).toBe(FEE);
    expect(cfg.dryRun).toBe(true);
  });

  it('requires an Ethereum RPC and a sane threshold ordering', () => {
    expect(() => loadBridgeGasConfig({})).toThrow('BRIDGE_GAS_ETHEREUM_RPC_URL');
    expect(() =>
      loadBridgeGasConfig({
        BRIDGE_GAS_ETHEREUM_RPC_URL: ETH_RPC,
        BRIDGE_GAS_ETHEREUM_MIN_NATIVE: '1',
        BRIDGE_GAS_ETHEREUM_TARGET_NATIVE: '0.5',
      }),
    ).toThrow('TARGET_NATIVE');
    expect(() =>
      loadBridgeGasConfig({ BRIDGE_GAS_ETHEREUM_RPC_URL: ETH_RPC, BRIDGE_GAS_MAX_SLIPPAGE_BPS: '5000' }),
    ).toThrow('SLIPPAGE');
  });
});

describe('claimAmount / nativeNeeded', () => {
  it('sweeps the fee contract only when the keeper owns it and it holds at least minStable', () => {
    expect(claimAmount(snap(), t)).toBe(parseUnits('120', 6));
    expect(claimAmount(snap({ keeperOwnsFeeContract: false }), t)).toBe(0n);
    expect(claimAmount(snap({ feeContractBalance: parseUnits('0.5', 6) }), t)).toBe(0n);
  });

  it('tops up to target only when under the minimum', () => {
    expect(nativeNeeded(snap({ nativeBalance: parseEther('0.05') }), t)).toBe(0n);
    expect(nativeNeeded(snap({ nativeBalance: parseEther('0.01') }), t)).toBe(parseEther('0.14'));
  });
});

describe('priceImpactBps', () => {
  it('is zero when the swap fills at the marginal price', () => {
    expect(priceImpactBps({ ...quote, amountOut: parseEther('0.1406') })).toBe(0n);
  });

  it('measures the shortfall against the marginal price', () => {
    // marginal would give 380 * 0.00037 = 0.1406; 0.14 is ~43 bps worse
    expect(priceImpactBps(quote)).toBe(42n);
  });
});

describe('decideLeg', () => {
  it('idles with a sweep when gas is healthy', () => {
    const d = decideLeg(snap({ nativeBalance: parseEther('1') }), t, null);
    expect(d).toEqual({ action: 'idle', reason: 'gas above minimum', claim: parseUnits('120', 6) });
  });

  it('swaps the quoted amount when fees cover it', () => {
    const d = decideLeg(snap({ feeContractBalance: parseUnits('1000', 6) }), t, quote);
    expect(d.action).toBe('swap');
    if (d.action !== 'swap') return;
    expect(d.amountIn).toBe(quote.amountIn);
    expect(d.minOut).toBe((quote.amountOut * 9700n) / 10000n);
    expect(d.claim).toBe(parseUnits('1000', 6));
  });

  it('spends everything available when fees do not cover the full top-up', () => {
    const d = decideLeg(snap({ feeContractBalance: parseUnits('100', 6), walletStable: parseUnits('20', 6) }), t, quote);
    expect(d.action).toBe('swap');
    if (d.action !== 'swap') return;
    expect(d.amountIn).toBe(parseUnits('120', 6));
    // pro-rata expected out, less slippage
    const expected = (parseUnits('120', 6) * quote.amountOut) / quote.amountIn;
    expect(d.minOut).toBe((expected * 9700n) / 10000n);
  });

  it('blocks instead of swapping into a thin pool', () => {
    const thin = { ...quote, amountOut: parseEther('0.10') }; // ~29% impact
    const d = decideLeg(snap(), t, thin);
    expect(d.action).toBe('blocked');
    if (d.action === 'blocked') expect(d.reason).toMatch(/price impact/);
  });

  it('blocks when nothing has accrued yet, and when the router cannot quote', () => {
    expect(decideLeg(snap({ feeContractBalance: 0n }), t, quote).action).toBe('blocked');
    expect(decideLeg(snap(), t, null)).toMatchObject({ action: 'blocked', reason: 'router returned no quote' });
  });

  it('never counts an unsweepable fee balance as spendable', () => {
    const d = decideLeg(snap({ keeperOwnsFeeContract: false, walletStable: 0n }), t, quote);
    expect(d.action).toBe('blocked');
  });
});
