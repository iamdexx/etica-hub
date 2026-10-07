import { describe, it, expect } from 'vitest';
import { parseEther, parseUnits, type PublicClient } from 'viem';
import { DEPLOYMENTS, eticaMainnet } from '@etica-hub/shared';

import {
  loadBridgeGasConfig,
  loadGasDropConfig,
  ETHEREUM_MAILBOX,
  ETHEREUM_USDC,
  FLASHBOTS_PROTECT_RPC,
  PUBLIC_ETHEREUM_RPCS,
  UNISWAP_V2_ROUTER,
} from '../src/bridge-gas/config.js';
import {
  claimAmount,
  decideLeg,
  nativeNeeded,
  planSurplusSwap,
  priceImpactBps,
  surplusAmount,
} from '../src/bridge-gas/plan.js';
import { bytes32ToAddress, planGasDrops, type InboundTransfer } from '../src/bridge-gas/gas-drop.js';
import { planSurplusChunk } from '../src/bridge-gas/run.js';

const KEY = ('0x' + '11'.repeat(32)) as `0x${string}`;
const FEE = '0x00000000000000000000000000000000000000f1';
const USDCE = '0x00000000000000000000000000000000000000e1';
const ETH_RPC = 'https://eth.example';

const t = {
  minNative: parseEther('0.05'),
  targetNative: parseEther('0.15'),
  minStable: parseUnits('1', 6),
  maxSlippageBps: 300,
  reserveStable: parseUnits('50', 6),
  minSweep: parseUnits('10', 6),
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

  it('defaults Ethereum reads to the public RPC rotation and requires a sane threshold ordering', () => {
    const eth = loadBridgeGasConfig({}).legs[0]!;
    expect(eth.rpcUrls).toEqual([...PUBLIC_ETHEREUM_RPCS]);
    expect(eth.rpcUrl).toBe(PUBLIC_ETHEREUM_RPCS[0]);
    expect(eth.writeRpcUrl).toBe(FLASHBOTS_PROTECT_RPC);
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
    // 5% is the ceiling: a sandwich can never take more than that of a swap.
    expect(() =>
      loadBridgeGasConfig({ BRIDGE_GAS_ETHEREUM_RPC_URL: ETH_RPC, BRIDGE_GAS_MAX_SLIPPAGE_BPS: '501' }),
    ).toThrow('SLIPPAGE');
    expect(loadBridgeGasConfig({ BRIDGE_GAS_ETHEREUM_RPC_URL: ETH_RPC }).maxSlippageBps).toBe(150);
  });

  it('pins the surplus destinations: Ethereum bridges via the canonical mailbox, Etica swaps to EGAZ for the keeper', () => {
    const cfg = loadBridgeGasConfig({
      BRIDGE_GAS_ETHEREUM_RPC_URL: ETH_RPC,
      BRIDGE_GAS_TREASURY: '0x000000000000000000000000000000000000dEaD',
      BRIDGE_GAS_ETHEREUM_WARP_ROUTER: '0x00000000000000000000000000000000000000a1',
    });
    expect(cfg).not.toHaveProperty('treasury');
    expect(cfg.ethereumMailbox).toBe(ETHEREUM_MAILBOX);
    const [eth, etica] = cfg.legs;
    expect(eth!.surplus).toEqual({ kind: 'bridge-to-etica', warpRouter: '0x00000000000000000000000000000000000000a1' });
    expect(etica!.surplus).toEqual({ kind: 'swap-to-native', maxChunk: parseUnits('250', 6) });
    expect(
      loadBridgeGasConfig({ BRIDGE_GAS_ETHEREUM_RPC_URL: ETH_RPC, BRIDGE_GAS_ETICA_MAX_SURPLUS_SWAP: '40' }).legs[1]!.surplus,
    ).toEqual({ kind: 'swap-to-native', maxChunk: parseUnits('40', 6) });
  });

  it('only lets a local fork override the Ethereum mailbox', () => {
    const fake = '0x00000000000000000000000000000000000000ab';
    expect(() =>
      loadBridgeGasConfig({ BRIDGE_GAS_ETHEREUM_RPC_URL: ETH_RPC, BRIDGE_GAS_ETHEREUM_MAILBOX: fake }),
    ).toThrow('local fork');
    const cfg = loadBridgeGasConfig({ BRIDGE_GAS_ETHEREUM_RPC_URL: 'http://127.0.0.1:8548', BRIDGE_GAS_ETHEREUM_MAILBOX: fake });
    expect(cfg.ethereumMailbox).toBe(fake);
  });

  it('pins the swap router, wrapped-native and path in code regardless of environment', () => {
    const hostile = '0x000000000000000000000000000000000000dEaD';
    const cfg = loadBridgeGasConfig({
      BRIDGE_GAS_ETHEREUM_RPC_URL: ETH_RPC,
      BRIDGE_GAS_ETICA_STABLE: USDCE,
      BRIDGE_GAS_ETICA_FEE_CONTRACT: FEE,
      BRIDGE_GAS_ETHEREUM_ROUTER: hostile,
      BRIDGE_GAS_ETHEREUM_WRAPPED_NATIVE: hostile,
      BRIDGE_GAS_ETICA_ROUTER: hostile,
      BRIDGE_GAS_ETICA_WRAPPED_NATIVE: hostile,
    });
    for (const leg of cfg.legs) {
      expect(leg.router).not.toBe(hostile);
      expect(leg.wrappedNative).not.toBe(hostile);
      expect(leg.path).not.toContain(hostile);
      expect(leg.path[leg.path.length - 1]).toBe(leg.wrappedNative);
    }
  });

  it('sends Ethereum transactions through Flashbots Protect by default and reads through the configured RPC', () => {
    const cfg = loadBridgeGasConfig({ BRIDGE_GAS_ETHEREUM_RPC_URL: ETH_RPC });
    const [eth, etica] = cfg.legs;
    expect(eth!.rpcUrl).toBe(ETH_RPC);
    expect(eth!.writeRpcUrl).toBe(FLASHBOTS_PROTECT_RPC);
    expect(etica!.writeRpcUrl).toBe(etica!.rpcUrl);
    const forked = loadBridgeGasConfig({
      BRIDGE_GAS_ETHEREUM_RPC_URL: ETH_RPC,
      BRIDGE_GAS_ETHEREUM_WRITE_RPC_URL: 'http://127.0.0.1:8548',
    });
    expect(forked.legs[0]!.writeRpcUrl).toBe('http://127.0.0.1:8548');
    expect(() =>
      loadBridgeGasConfig({ BRIDGE_GAS_ETHEREUM_RPC_URL: ETH_RPC, BRIDGE_GAS_ETHEREUM_WRITE_RPC_URL: 'ws://x' }),
    ).toThrow('http(s)');
  });

  it('reads fail over from the configured endpoint(s) to the public rotation, except on a fork', () => {
    const one = loadBridgeGasConfig({ BRIDGE_GAS_ETHEREUM_RPC_URL: ETH_RPC }).legs[0]!;
    expect(one.rpcUrls).toEqual([ETH_RPC, ...PUBLIC_ETHEREUM_RPCS]);

    const many = loadBridgeGasConfig({
      BRIDGE_GAS_ETHEREUM_RPC_URL: ` ${ETH_RPC}, https://b.example ,${PUBLIC_ETHEREUM_RPCS[0]}`,
    }).legs[0]!;
    expect(many.rpcUrls).toEqual([ETH_RPC, 'https://b.example', ...PUBLIC_ETHEREUM_RPCS]);
    expect(many.rpcUrl).toBe(ETH_RPC);

    // A local fork must never be mixed with mainnet endpoints.
    const fork = loadBridgeGasConfig({ BRIDGE_GAS_ETHEREUM_RPC_URL: 'http://127.0.0.1:8548' }).legs[0]!;
    expect(fork.rpcUrls).toEqual(['http://127.0.0.1:8548']);

    const etica = loadBridgeGasConfig({ HARVEST_RPC_URL: 'https://etica.example' }).legs[1]!;
    expect(etica.rpcUrls[0]).toBe('https://etica.example');
    expect(etica.rpcUrls).toEqual(expect.arrayContaining(eticaMainnet.rpcUrls.default.http));

    expect(() => loadBridgeGasConfig({ BRIDGE_GAS_ETHEREUM_RPC_URL: `${ETH_RPC},ws://x` })).toThrow('http(s)');
  });

  it('rejects a mailbox override unless every Ethereum endpoint is a loopback fork', () => {
    const fake = '0x00000000000000000000000000000000000000ab';
    expect(() =>
      loadBridgeGasConfig({
        BRIDGE_GAS_ETHEREUM_RPC_URL: `http://127.0.0.1:8548,${ETH_RPC}`,
        BRIDGE_GAS_ETHEREUM_MAILBOX: fake,
      }),
    ).toThrow('local fork');
  });

  it('defaults a 500-stable float on both legs; Etica claims stay cheap', () => {
    const [eth, etica] = loadBridgeGasConfig({ BRIDGE_GAS_ETHEREUM_RPC_URL: ETH_RPC }).legs;
    expect(eth!.minStable).toBe(parseUnits('200', 6));
    expect(eth!.reserveStable).toBe(parseUnits('500', 6));
    expect(etica!.minStable).toBe(parseUnits('5', 6));
    expect(etica!.reserveStable).toBe(parseUnits('500', 6));
    expect(() =>
      loadBridgeGasConfig({ BRIDGE_GAS_ETHEREUM_RPC_URL: ETH_RPC, BRIDGE_GAS_ETICA_MIN_SWEEP: '0' }),
    ).toThrow('MIN_SWEEP');
  });
});

describe('loadGasDropConfig', () => {
  it('is on by default with bounded parameters and can be switched off', () => {
    const cfg = loadGasDropConfig({});
    expect(cfg).not.toBeNull();
    expect(cfg!.amount).toBe(parseEther('2'));
    expect(cfg!.threshold).toBe(parseEther('0.5'));
    expect(cfg!.minTransfer).toBe(parseUnits('20', 6));
    expect(cfg!.maxPerRun).toBe(25);
    expect(loadGasDropConfig({ BRIDGE_GAS_DROP_ENABLED: 'false' })).toBeNull();
    expect(() => loadGasDropConfig({ BRIDGE_GAS_DROP_MAX_PER_RUN: '1000' })).toThrow('MAX_PER_RUN');
    expect(() => loadGasDropConfig({ BRIDGE_GAS_DROP_THRESHOLD: '5' })).toThrow('THRESHOLD');
    expect(() => loadGasDropConfig({ BRIDGE_GAS_DROP_LOOKBACK_BLOCKS: '99999' })).toThrow('LOOKBACK');
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

describe('surplusAmount', () => {
  it('releases only the excess over the reserve, and only above the minimum', () => {
    expect(surplusAmount(snap(), t, parseUnits('120', 6), 0n, false)).toBe(parseUnits('70', 6));
    expect(surplusAmount(snap(), t, parseUnits('55', 6), 0n, false)).toBe(0n); // 5 excess < minSweep
    expect(surplusAmount(snap(), t, parseUnits('40', 6), 0n, false)).toBe(0n); // below reserve
  });

  it('deducts what the swap spends and holds everything while a swap is blocked', () => {
    expect(surplusAmount(snap(), t, parseUnits('120', 6), parseUnits('30', 6), false)).toBe(parseUnits('40', 6));
    expect(surplusAmount(snap(), t, parseUnits('120', 6), 0n, true)).toBe(0n);
  });
});

describe('planSurplusSwap', () => {
  // 100 USDC.e -> 37 EGAZ, marginal 1 USDC.e -> 0.372 EGAZ (~0.5% impact)
  const q = (amountIn: bigint) => ({ amountIn, amountOut: parseEther('37'), probeIn: parseUnits('1', 6), probeOut: parseEther('0.372') });
  const min = parseUnits('5', 6);
  const chunk = parseUnits('100', 6);

  it('swaps at most the chunk, keeps the EGAZ (no target), with slippage on the minimum', () => {
    const { plan, blocked } = planSurplusSwap(parseUnits('1000', 6), chunk, min, q(chunk), 150);
    expect(blocked).toBeNull();
    expect(plan).toEqual({ amountIn: chunk, minOut: (parseEther('37') * 9850n) / 10000n, nativeNeeded: 0n });
    // a surplus under the chunk is swapped whole
    expect(planSurplusSwap(parseUnits('60', 6), chunk, min, q(parseUnits('60', 6)), 150).plan!.amountIn).toBe(parseUnits('60', 6));
  });

  it('holds the surplus when the chunk is dust, the quote is missing / stale, or impact exceeds the ceiling', () => {
    expect(planSurplusSwap(parseUnits('2', 6), chunk, min, q(parseUnits('2', 6)), 150).blocked).toMatch(/below minimum/);
    expect(planSurplusSwap(chunk, chunk, min, null, 150).blocked).toBe('router returned no quote');
    expect(planSurplusSwap(chunk, chunk, min, q(parseUnits('90', 6)), 150).blocked).toBe('router returned no quote');
    const thin = planSurplusSwap(chunk, chunk, min, { ...q(chunk), amountOut: parseEther('30') }, 150);
    expect(thin.plan).toBeNull();
    expect(thin.blocked).toMatch(/price impact/);
    expect(planSurplusSwap(0n, chunk, min, null, 150)).toEqual({ plan: null, blocked: null });
  });
});

describe('decideLeg', () => {
  it('claims and releases the surplus when gas is healthy', () => {
    const d = decideLeg(snap({ nativeBalance: parseEther('1') }), t, null);
    expect(d.swap).toBeNull();
    expect(d.blocked).toBeNull();
    expect(d.claim).toBe(parseUnits('120', 6));
    expect(d.surplus).toBe(parseUnits('70', 6));
  });

  it('swaps the quoted amount when fees cover it, then releases what is left over the reserve', () => {
    const d = decideLeg(snap({ feeContractBalance: parseUnits('1000', 6) }), t, quote);
    expect(d.swap).not.toBeNull();
    expect(d.swap!.amountIn).toBe(quote.amountIn);
    expect(d.swap!.minOut).toBe((quote.amountOut * 9700n) / 10000n);
    expect(d.claim).toBe(parseUnits('1000', 6));
    expect(d.surplus).toBe(parseUnits('1000', 6) - quote.amountIn - t.reserveStable);
  });

  it('spends everything available when fees do not cover the full top-up and releases nothing', () => {
    const d = decideLeg(snap({ feeContractBalance: parseUnits('100', 6), walletStable: parseUnits('20', 6) }), t, quote);
    expect(d.swap!.amountIn).toBe(parseUnits('120', 6));
    const expected = (parseUnits('120', 6) * quote.amountOut) / quote.amountIn;
    expect(d.swap!.minOut).toBe((expected * 9700n) / 10000n);
    expect(d.surplus).toBe(0n);
  });

  it('blocks instead of swapping into a thin pool, and keeps the stable instead of releasing it', () => {
    const thin = { ...quote, amountOut: parseEther('0.10') }; // ~29% impact
    const d = decideLeg(snap({ feeContractBalance: parseUnits('1000', 6) }), t, thin);
    expect(d.swap).toBeNull();
    expect(d.blocked).toMatch(/price impact/);
    expect(d.claim).toBe(parseUnits('1000', 6));
    expect(d.surplus).toBe(0n);
  });

  it('blocks when nothing has accrued yet, and when the router cannot quote', () => {
    expect(decideLeg(snap({ feeContractBalance: 0n }), t, quote).blocked).toMatch(/not accrued/);
    expect(decideLeg(snap(), t, null).blocked).toBe('router returned no quote');
  });

  it('never counts an unsweepable fee balance as spendable', () => {
    const d = decideLeg(snap({ keeperOwnsFeeContract: false, walletStable: 0n }), t, quote);
    expect(d.claim).toBe(0n);
    expect(d.swap).toBeNull();
    expect(d.blocked).not.toBeNull();
  });
});

describe('gas drop planning', () => {
  const KEEPER = '0x00000000000000000000000000000000000000ee' as const;
  const A = '0x00000000000000000000000000000000000000a1' as const;
  const B = '0x00000000000000000000000000000000000000b2' as const;
  const C = '0x00000000000000000000000000000000000000c3' as const;
  const cfg = {
    amount: parseEther('2'),
    threshold: parseEther('0.5'),
    minTransfer: parseUnits('20', 6),
    maxPerRun: 2,
    lookbackBlocks: 600n,
  };
  const tx = (recipient: `0x${string}`, amount: string, n = 1n): InboundTransfer => ({
    recipient,
    amount: parseUnits(amount, 6),
    blockNumber: n,
    txHash: '0x01',
  });

  it('decodes only left-padded EVM recipients', () => {
    expect(bytes32ToAddress(('0x' + '00'.repeat(12) + 'a1'.repeat(20)) as `0x${string}`)).toBe('0x' + 'a1'.repeat(20));
    expect(bytes32ToAddress(('0x' + 'ff' + '00'.repeat(11) + 'a1'.repeat(20)) as `0x${string}`)).toBeNull();
    expect(bytes32ToAddress('0x1234')).toBeNull();
  });

  it('funds fresh recipients once, skipping funded wallets, dust transfers, the keeper and repeats', () => {
    const balances = new Map<string, bigint>([
      [A, 0n],
      [B, parseEther('3')],
      [C, parseEther('0.1')],
      [KEEPER, parseEther('100')],
    ]);
    const plan = planGasDrops(
      [tx(A, '100'), tx(A, '100', 2n), tx(B, '100'), tx(C, '5'), tx(KEEPER, '1000')],
      balances,
      KEEPER,
      parseEther('100'),
      parseEther('20'),
      cfg,
    );
    expect(plan.drops).toEqual([A]);
    expect(plan.skipped.map((s) => s.reason)).toEqual([
      'already has gas',
      'transfer 5000000 below minimum',
      'not a user wallet',
    ]);
  });

  it('respects the per-run cap and never drops the keeper below its own gas floor', () => {
    const many = [A, B, C].map((r) => tx(r, '50'));
    const zero = new Map<string, bigint>([A, B, C].map((r) => [r, 0n] as const));
    expect(planGasDrops(many, zero, KEEPER, parseEther('100'), parseEther('20'), cfg).drops).toEqual([A, B]);
    // 23 EGAZ with a 20 floor: budget for one 2 EGAZ drop only
    const tight = planGasDrops(many, zero, KEEPER, parseEther('23'), parseEther('20'), cfg);
    expect(tight.drops).toEqual([A]);
    expect(tight.skipped.map((s) => s.reason)).toContain('keeper would fall below its gas floor');
    expect(planGasDrops(many, new Map(), KEEPER, parseEther('100'), parseEther('20'), cfg).drops).toEqual([]);
  });
});

describe('planSurplusChunk', () => {
  const leg = loadBridgeGasConfig({
    BRIDGE_GAS_ETHEREUM_RPC_URL: ETH_RPC,
    BRIDGE_GAS_ETICA_STABLE: USDCE,
    BRIDGE_GAS_ETICA_MIN_SWEEP: '5',
  }).legs[1]!;
  // marginal 1 USDC.e -> 0.372 EGAZ; anything above 5 USDC.e moves the pool 5%, 5 itself only 1%
  const client = {
    readContract: async ({ args }: { args: readonly [bigint, readonly `0x${string}`[]] }) => {
      const amountIn = args[0];
      const impactBps = amountIn > parseUnits('5', 6) ? 500n : 100n;
      const out = (((amountIn * parseEther('0.372')) / parseUnits('1', 6)) * (10000n - impactBps)) / 10000n;
      return [amountIn, 0n, out];
    },
  } as unknown as PublicClient;

  it('falls back to the minimum sweep when halving would skip it', async () => {
    const { plan, blocked } = await planSurplusChunk(client, leg, parseUnits('8', 6), 150);
    expect(blocked).toBeNull();
    expect(plan!.amountIn).toBe(parseUnits('5', 6));
  });

  it('holds without quoting when the whole surplus is under the minimum', async () => {
    const { plan, blocked } = await planSurplusChunk(client, leg, parseUnits('4', 6), 150);
    expect(plan).toBeNull();
    expect(blocked).toBe('surplus chunk below minimum');
  });

  it('rejects a per-run swap cap below the minimum sweep', () => {
    expect(() =>
      loadBridgeGasConfig({ BRIDGE_GAS_ETHEREUM_RPC_URL: ETH_RPC, BRIDGE_GAS_ETICA_MAX_SURPLUS_SWAP: '3' }),
    ).toThrow(/MAX_SURPLUS_SWAP must be at least/);
  });
});
