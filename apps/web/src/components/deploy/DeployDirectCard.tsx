'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  BaseError,
  UserRejectedRequestError,
  encodeDeployData,
  formatUnits,
  getAddress,
  parseUnits,
  type Abi,
  type Address,
  type Hex,
} from 'viem';
import {
  useAccount,
  useChainId,
  useConnect,
  useDisconnect,
  usePublicClient,
  useSwitchChain,
  useWalletClient,
} from 'wagmi';
import { eticaMainnet } from '@etica-hub/shared/chains';
import {
  DEPLOYMENTS,
  EXTERNAL_ADDRESSES,
  TREASURY_ADDRESS,
  USDC_WARP_ROUTE,
} from '@etica-hub/shared/addresses';
import {
  directFactoryArtifact,
  directHarvesterAdapterArtifact,
  directRouterArtifact,
} from '@/lib/direct-deploy-artifacts';

/**
 * Stepwise deployer for the EticaSwap Direct venue. Every step is one wallet
 * signature; progress (deployed addresses) is kept in localStorage so a page
 * reload mid-flow resumes where it stopped.
 *
 * Order:
 *   1. EticaDirectFactory(feeToSetter = owner, stETX, minStEtx = 40,000)
 *   2. EticaDirectRouter(factory, WEGAZ)
 *   3. DirectSwapHarvesterAdapter(owner, factory, hubRouter, ETX, stETX, farms, treasury)
 *   4. factory.setWhitelist(router) / setWhitelist(harvester) / setWhitelist(dead)
 *   5. factory.setFeeTo(harvester)
 *   6. factory.setFeeTiers([40k,100k,250k,500k], [300,150,50,10])
 *   7. factory.createPair(WEGAZ, USDC.e) / createPair(ETI, USDC.e)
 *   8. approve USDC.e + ETI, addLiquidityEGAZ / addLiquidity at the hub price, LP → dead
 */

const ZERO = '0x0000000000000000000000000000000000000000' as const;
const DEAD = '0x000000000000000000000000000000000000dEaD' as const;
const STORAGE_KEY = 'eticahub.deploy-direct.v1';
const LAUNCH_MIN_STETX = parseUnits('40000', 18);
/** Wallet expected to run the Seeder role; null = any wallet (a warning shows on mismatch). */
const EXPECTED_SEEDER: Address | null = null;
const OPERATOR_STEPS: StepKey[] = [
  'deployFactory',
  'deployRouter',
  'deployHarvester',
  'whitelistRouter',
  'whitelistHarvester',
  'whitelistDead',
  'setFeeTo',
  'setFeeTiers',
  'createPairWegaz',
  'createPairEti',
];
const SEED_STEPS: StepKey[] = ['approveUsdce', 'approveEti', 'seedWegaz', 'seedEti'];
type Role = 'operator' | 'seeder';
const LAUNCH_TIERS: readonly [bigint[], number[]] = [
  [
    parseUnits('40000', 18),
    parseUnits('100000', 18),
    parseUnits('250000', 18),
    parseUnits('500000', 18),
  ],
  [300, 150, 50, 10],
];

const ERC20_ABI = [
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [{ type: 'address' }, { type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
] as const satisfies Abi;

const HUB_FACTORY_ABI = [
  {
    type: 'function',
    name: 'getPair',
    stateMutability: 'view',
    inputs: [{ type: 'address' }, { type: 'address' }],
    outputs: [{ type: 'address' }],
  },
] as const;
const HUB_PAIR_ABI = [
  {
    type: 'function',
    name: 'token0',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'getReserves',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint112' }, { type: 'uint112' }, { type: 'uint32' }],
  },
] as const;
type StepStatus = 'idle' | 'signing' | 'pending' | 'confirmed' | 'error';
type StepState = { status: StepStatus; txHash?: Hex; error?: string };
const initial: StepState = { status: 'idle' };

type StepKey =
  | 'deployFactory'
  | 'deployRouter'
  | 'deployHarvester'
  | 'whitelistRouter'
  | 'whitelistHarvester'
  | 'whitelistDead'
  | 'setFeeTo'
  | 'setFeeTiers'
  | 'createPairWegaz'
  | 'createPairEti'
  | 'approveUsdce'
  | 'approveEti'
  | 'seedWegaz'
  | 'seedEti';

const STEP_ORDER: StepKey[] = [
  'deployFactory',
  'deployRouter',
  'deployHarvester',
  'whitelistRouter',
  'whitelistHarvester',
  'whitelistDead',
  'setFeeTo',
  'setFeeTiers',
  'createPairWegaz',
  'createPairEti',
  'approveUsdce',
  'approveEti',
  'seedWegaz',
  'seedEti',
];

const STEP_LABELS: Record<StepKey, { label: string; description: string }> = {
  deployFactory: {
    label: 'Deploy EticaDirectFactory',
    description: 'feeToSetter = owner below, stETX gate token, minStEtx = 40,000.',
  },
  deployRouter: {
    label: 'Deploy EticaDirectRouter',
    description: 'V2-style router bound to the new factory and WEGAZ.',
  },
  deployHarvester: {
    label: 'Deploy DirectSwapHarvesterAdapter',
    description:
      'feeTo of the factory: burns fee LP, swaps to ETX on the hub router, splits 10/10/40/40 (stETX / farms / POL burned into the pair / treasury).',
  },
  whitelistRouter: {
    label: 'Whitelist router',
    description:
      'Lets the router act as swap/mint recipient for intermediate hops and EGAZ unwraps.',
  },
  whitelistHarvester: {
    label: 'Whitelist harvester',
    description: 'Lets the harvester receive the burned fee-LP legs.',
  },
  whitelistDead: {
    label: 'Whitelist dead address',
    description: 'So seed LP can be minted straight to 0x…dEaD (permanently locked POL).',
  },
  setFeeTo: {
    label: 'factory.setFeeTo(harvester)',
    description: 'Protocol fee LP accrues to the harvester from the first swap.',
  },
  setFeeTiers: {
    label: 'factory.setFeeTiers',
    description: '40k → 3.00%, 100k → 1.50%, 250k → 0.50%, 500k+ → 0.10% (base 3.00%).',
  },
  createPairWegaz: {
    label: 'createPair(WEGAZ, USDC.e)',
    description: 'Opens the EGAZ/USDC.e direct pair (emits V2 PairCreated for indexers).',
  },
  createPairEti: {
    label: 'createPair(ETI, USDC.e)',
    description: 'Opens the ETI/USDC.e direct pair.',
  },
  approveUsdce: {
    label: 'Approve USDC.e',
    description: 'Allowance covering both seeds.',
  },
  approveEti: {
    label: 'Approve ETI',
    description: 'Allowance for the ETI seed.',
  },
  seedWegaz: {
    label: 'Seed EGAZ/USDC.e',
    description: 'router.addLiquidityEGAZ(USDC.e, …) with EGAZ attached; LP → dead.',
  },
  seedEti: {
    label: 'Seed ETI/USDC.e',
    description: 'router.addLiquidity(ETI, USDC.e, …); LP → dead.',
  },
};

type Deployed = { factory?: Address; router?: Address; harvester?: Address };

function shortError(err: unknown): string {
  if (err instanceof UserRejectedRequestError) return 'Rejected in wallet.';
  if (err instanceof BaseError) return err.shortMessage ?? err.message;
  if (err instanceof Error) return err.message;
  return 'Unknown error';
}

function parseAddr(s: string): Address | null {
  try {
    const a = getAddress(s.trim());
    return a === ZERO ? null : a;
  } catch {
    return null;
  }
}

function loadDeployed(): Deployed {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Deployed) : {};
  } catch {
    return {};
  }
}

export function DeployDirectCard({ role }: { role: Role }) {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();
  const { connectors, connect, status: connectStatus } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain, isPending: switching } = useSwitchChain();

  const onMainnet = chainId === eticaMainnet.id;
  const d = DEPLOYMENTS[eticaMainnet.id];
  const tokens = {
    etx: d.etx,
    wegaz: d.wegaz,
    eti: EXTERNAL_ADDRESSES[eticaMainnet.id].eti,
    usdce: USDC_WARP_ROUTE.syntheticToken,
    stEtx: d.stakedETX,
    farms: d.etxFarms,
    hubRouter: d.swapRouter,
    hubFactory: d.swapFactory,
  };

  const [ownerInput, setOwnerInput] = useState<string>(TREASURY_ADDRESS);
  const [usdPerSide, setUsdPerSide] = useState<string>('10');
  const [routerInput, setRouterInput] = useState<string>('');
  const [pairsReady, setPairsReady] = useState<boolean>(false);
  const [balances, setBalances] = useState<{ usdce: bigint; eti: bigint; egaz: bigint } | null>(
    null,
  );
  const [deployed, setDeployed] = useState<Deployed>({});
  const [steps, setSteps] = useState<Record<StepKey, StepState>>(
    () => Object.fromEntries(STEP_ORDER.map((k) => [k, initial])) as Record<StepKey, StepState>,
  );
  const [quote, setQuote] = useState<{ egaz: bigint; eti: bigint } | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);

  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const r = q.get('router');
    if (r) setRouterInput(r);
  }, []);

  useEffect(() => {
    const stored = loadDeployed();
    setDeployed({
      factory: d.directFactory !== ZERO ? d.directFactory : stored.factory,
      router: d.directRouter !== ZERO ? d.directRouter : stored.router,
      harvester: d.directHarvesterAdapter !== ZERO ? d.directHarvesterAdapter : stored.harvester,
    });
  }, [d.directFactory, d.directRouter, d.directHarvesterAdapter]);

  function remember(next: Deployed) {
    setDeployed(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* storage unavailable: addresses still shown on screen */
    }
  }

  const owner = useMemo(() => parseAddr(ownerInput), [ownerInput]);
  const seedRouter = useMemo(
    () => deployed.router ?? parseAddr(routerInput),
    [deployed.router, routerInput],
  );

  // Seeder role may run in a different browser than the operator: resolve the
  // factory from the router and confirm both curated pairs exist on-chain.
  useEffect(() => {
    if (!publicClient || !onMainnet || !seedRouter) {
      setPairsReady(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const fac = (await publicClient.readContract({
          address: seedRouter,
          abi: directRouterArtifact.abi,
          functionName: 'factory',
        })) as Address;
        const [p0, p1] = (await Promise.all([
          publicClient.readContract({
            address: fac,
            abi: directFactoryArtifact.abi,
            functionName: 'getPair',
            args: [tokens.wegaz, tokens.usdce],
          }),
          publicClient.readContract({
            address: fac,
            abi: directFactoryArtifact.abi,
            functionName: 'getPair',
            args: [tokens.eti, tokens.usdce],
          }),
        ])) as [Address, Address];
        if (!cancelled) setPairsReady(p0 !== ZERO && p1 !== ZERO);
      } catch {
        if (!cancelled) setPairsReady(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    publicClient,
    onMainnet,
    seedRouter,
    tokens.wegaz,
    tokens.eti,
    tokens.usdce,
    steps.createPairWegaz.status,
    steps.createPairEti.status,
  ]);

  useEffect(() => {
    if (!publicClient || !onMainnet || !address) {
      setBalances(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const [usdce, eti, egaz] = await Promise.all([
          publicClient.readContract({
            address: tokens.usdce,
            abi: ERC20_ABI,
            functionName: 'balanceOf',
            args: [address],
          }),
          publicClient.readContract({
            address: tokens.eti,
            abi: ERC20_ABI,
            functionName: 'balanceOf',
            args: [address],
          }),
          publicClient.getBalance({ address }),
        ]);
        if (!cancelled) setBalances({ usdce, eti, egaz });
      } catch {
        if (!cancelled) setBalances(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    publicClient,
    onMainnet,
    address,
    tokens.usdce,
    tokens.eti,
    steps.seedWegaz.status,
    steps.seedEti.status,
  ]);
  const usdcePerSide = useMemo(() => {
    try {
      const v = parseUnits(usdPerSide.trim() || '0', USDC_WARP_ROUTE.decimals);
      return v > 0n ? v : null;
    } catch {
      return null;
    }
  }, [usdPerSide]);

  // Hub spot price from the public pools' reserves (USDC.e/ETX × ETX/WEGAZ|ETI),
  // so both direct pairs open at exactly the hub mid price — a fee-inclusive
  // router quote would skew the ratio and hand the locked LP to arbitrage.
  useEffect(() => {
    if (!publicClient || !onMainnet || !usdcePerSide) {
      setQuote(null);
      return;
    }
    let cancelled = false;
    const reservesOf = async (a: Address, b: Address): Promise<[bigint, bigint]> => {
      const pair = (await publicClient.readContract({
        address: tokens.hubFactory,
        abi: HUB_FACTORY_ABI,
        functionName: 'getPair',
        args: [a, b],
      })) as Address;
      if (pair === ZERO) throw new Error('hub pair missing');
      const [token0, [r0, r1]] = await Promise.all([
        publicClient.readContract({ address: pair, abi: HUB_PAIR_ABI, functionName: 'token0' }),
        publicClient.readContract({
          address: pair,
          abi: HUB_PAIR_ABI,
          functionName: 'getReserves',
        }),
      ]);
      if (r0 === 0n || r1 === 0n) throw new Error('hub pair empty');
      return token0.toLowerCase() === a.toLowerCase() ? [r0, r1] : [r1, r0];
    };
    (async () => {
      try {
        const [[rUsdce, rEtxA], [rEtxB, rWegaz], [rEtxC, rEti]] = await Promise.all([
          reservesOf(tokens.usdce, tokens.etx),
          reservesOf(tokens.etx, tokens.wegaz),
          reservesOf(tokens.etx, tokens.eti),
        ]);
        if (cancelled) return;
        const etxValue = usdcePerSide * rEtxA; // scaled by rUsdce
        setQuote({
          egaz: (etxValue * rWegaz) / (rUsdce * rEtxB),
          eti: (etxValue * rEti) / (rUsdce * rEtxC),
        });
        setQuoteError(null);
      } catch (err) {
        if (cancelled) return;
        setQuote(null);
        setQuoteError(shortError(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    publicClient,
    onMainnet,
    usdcePerSide,
    tokens.hubFactory,
    tokens.usdce,
    tokens.etx,
    tokens.wegaz,
    tokens.eti,
  ]);

  // Setup steps re-derive from chain so a reload (or a second browser) resumes
  // instead of replaying whitelist/feeTo/createPair txs that would revert.
  const { factory: knownFactory, router: knownRouter, harvester: knownHarvester } = deployed;
  useEffect(() => {
    if (!publicClient || !onMainnet || !knownFactory) return;
    let cancelled = false;
    (async () => {
      try {
        const fac = { address: knownFactory, abi: directFactoryArtifact.abi } as const;
        const read = (functionName: string, args: readonly unknown[] = []) =>
          publicClient.readContract({ ...fac, functionName, args });
        const [wlRouter, wlHarv, wlDead, feeTo, tierCount, pWegaz, pEti] = (await Promise.all([
          knownRouter ? read('whitelist', [knownRouter]) : false,
          knownHarvester ? read('whitelist', [knownHarvester]) : false,
          read('whitelist', [DEAD]),
          read('feeTo'),
          read('feeTierCount'),
          read('getPair', [tokens.wegaz, tokens.usdce]),
          read('getPair', [tokens.eti, tokens.usdce]),
        ])) as [boolean, boolean, boolean, Address, bigint, Address, Address];
        if (cancelled) return;
        const done: Partial<Record<StepKey, boolean>> = {
          whitelistRouter: wlRouter,
          whitelistHarvester: wlHarv,
          whitelistDead: wlDead,
          setFeeTo:
            knownHarvester !== undefined && feeTo.toLowerCase() === knownHarvester.toLowerCase(),
          setFeeTiers: tierCount >= BigInt(LAUNCH_TIERS[0].length),
          createPairWegaz: pWegaz !== ZERO,
          createPairEti: pEti !== ZERO,
        };
        setSteps((s) => {
          let next = s;
          for (const [k, ok] of Object.entries(done) as [StepKey, boolean][]) {
            if (ok && s[k].status !== 'confirmed') next = { ...next, [k]: { status: 'confirmed' } };
          }
          return next;
        });
      } catch {
        /* keep local state; buttons stay available */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    publicClient,
    onMainnet,
    knownFactory,
    knownRouter,
    knownHarvester,
    tokens.wegaz,
    tokens.eti,
    tokens.usdce,
  ]);

  // Approvals track the live allowance: a bigger seed (or a reload) re-arms
  // the approve step instead of leaving the seed tx to revert.
  useEffect(() => {
    if (!publicClient || !onMainnet || !address || !seedRouter || !usdcePerSide || !quote) return;
    let cancelled = false;
    (async () => {
      try {
        const [aUsdce, aEti] = await Promise.all([
          publicClient.readContract({
            address: tokens.usdce,
            abi: ERC20_ABI,
            functionName: 'allowance',
            args: [address, seedRouter],
          }),
          publicClient.readContract({
            address: tokens.eti,
            abi: ERC20_ABI,
            functionName: 'allowance',
            args: [address, seedRouter],
          }),
        ]);
        if (cancelled) return;
        const want: Record<'approveUsdce' | 'approveEti', boolean> = {
          approveUsdce: aUsdce >= usdcePerSide * 2n,
          approveEti: aEti >= quote.eti,
        };
        setSteps((s) => {
          let next = s;
          for (const [k, ok] of Object.entries(want) as [StepKey, boolean][]) {
            const st = s[k].status;
            if (st === 'signing' || st === 'pending') continue;
            if (ok && st !== 'confirmed') next = { ...next, [k]: { status: 'confirmed' } };
            if (!ok && st === 'confirmed') next = { ...next, [k]: initial };
          }
          return next;
        });
      } catch {
        /* allowance unreadable: leave local state */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    publicClient,
    onMainnet,
    address,
    seedRouter,
    usdcePerSide,
    quote,
    tokens.usdce,
    tokens.eti,
    steps.approveUsdce.status,
    steps.approveEti.status,
    steps.seedWegaz.status,
    steps.seedEti.status,
  ]);

  async function send(key: StepKey, fn: () => Promise<Hex>): Promise<Address | undefined> {
    if (!publicClient) return undefined;
    setSteps((s) => ({ ...s, [key]: { status: 'signing' } }));
    let txHash: Hex;
    try {
      txHash = await fn();
    } catch (err) {
      setSteps((s) => ({ ...s, [key]: { status: 'error', error: shortError(err) } }));
      return undefined;
    }
    setSteps((s) => ({ ...s, [key]: { status: 'pending', txHash } }));
    try {
      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
      if (receipt.status !== 'success') {
        setSteps((s) => ({
          ...s,
          [key]: { status: 'error', txHash, error: 'Transaction reverted on-chain' },
        }));
        return undefined;
      }
      setSteps((s) => ({ ...s, [key]: { status: 'confirmed', txHash } }));
      return (receipt.contractAddress ?? undefined) as Address | undefined;
    } catch (err) {
      setSteps((s) => ({ ...s, [key]: { status: 'error', txHash, error: shortError(err) } }));
      return undefined;
    }
  }

  async function runStep(key: StepKey) {
    if (!walletClient || !address || !onMainnet) return;
    if (!owner && !SEED_STEPS.includes(key)) return;
    const ownerOrDead = owner ?? DEAD;
    const wc = walletClient;
    const account = address;
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 60 * 30);
    const { factory, router, harvester } = deployed;

    const deploy = (artifact: { abi: Abi; bytecode: Hex }, args: readonly unknown[]) =>
      wc.sendTransaction({
        account,
        data: encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode, args }),
      });
    const write = (
      to: Address,
      abi: Abi,
      functionName: string,
      args: readonly unknown[],
      value?: bigint,
    ) => wc.writeContract({ account, address: to, abi, functionName, args, value });

    switch (key) {
      case 'deployFactory': {
        const a = await send(key, () =>
          deploy(directFactoryArtifact, [ownerOrDead, tokens.stEtx, LAUNCH_MIN_STETX]),
        );
        if (a) remember({ ...deployed, factory: a });
        return;
      }
      case 'deployRouter': {
        if (!factory) return;
        const a = await send(key, () => deploy(directRouterArtifact, [factory, tokens.wegaz]));
        if (a) remember({ ...deployed, router: a });
        return;
      }
      case 'deployHarvester': {
        if (!factory) return;
        const a = await send(key, () =>
          deploy(directHarvesterAdapterArtifact, [
            ownerOrDead,
            factory,
            tokens.hubRouter,
            tokens.etx,
            tokens.stEtx,
            tokens.farms,
            ownerOrDead,
          ]),
        );
        if (a) remember({ ...deployed, harvester: a });
        return;
      }
      case 'whitelistRouter':
        if (!factory || !router) return;
        await send(key, () =>
          write(factory, directFactoryArtifact.abi, 'setWhitelist', [router, true]),
        );
        return;
      case 'whitelistHarvester':
        if (!factory || !harvester) return;
        await send(key, () =>
          write(factory, directFactoryArtifact.abi, 'setWhitelist', [harvester, true]),
        );
        return;
      case 'whitelistDead':
        if (!factory) return;
        await send(key, () =>
          write(factory, directFactoryArtifact.abi, 'setWhitelist', [DEAD, true]),
        );
        return;
      case 'setFeeTo':
        if (!factory || !harvester) return;
        await send(key, () => write(factory, directFactoryArtifact.abi, 'setFeeTo', [harvester]));
        return;
      case 'setFeeTiers':
        if (!factory) return;
        await send(key, () =>
          write(factory, directFactoryArtifact.abi, 'setFeeTiers', [
            LAUNCH_TIERS[0],
            LAUNCH_TIERS[1],
          ]),
        );
        return;
      case 'createPairWegaz':
        if (!factory) return;
        await send(key, () =>
          write(factory, directFactoryArtifact.abi, 'createPair', [tokens.wegaz, tokens.usdce]),
        );
        return;
      case 'createPairEti':
        if (!factory) return;
        await send(key, () =>
          write(factory, directFactoryArtifact.abi, 'createPair', [tokens.eti, tokens.usdce]),
        );
        return;
      case 'approveUsdce':
        if (!seedRouter || !usdcePerSide) return;
        await send(key, () =>
          write(tokens.usdce, ERC20_ABI, 'approve', [seedRouter, usdcePerSide * 2n]),
        );
        return;
      case 'approveEti':
        if (!seedRouter || !quote) return;
        await send(key, () => write(tokens.eti, ERC20_ABI, 'approve', [seedRouter, quote.eti]));
        return;
      case 'seedWegaz':
        if (!seedRouter || !usdcePerSide || !quote) return;
        await send(key, () =>
          write(
            seedRouter,
            directRouterArtifact.abi,
            'addLiquidityEGAZ',
            [tokens.usdce, usdcePerSide, usdcePerSide, quote.egaz, DEAD, deadline],
            quote.egaz,
          ),
        );
        return;
      case 'seedEti':
        if (!seedRouter || !usdcePerSide || !quote) return;
        await send(key, () =>
          write(seedRouter, directRouterArtifact.abi, 'addLiquidity', [
            tokens.eti,
            tokens.usdce,
            quote.eti,
            usdcePerSide,
            quote.eti,
            usdcePerSide,
            DEAD,
            deadline,
          ]),
        );
        return;
    }
  }

  function ready(key: StepKey): boolean {
    if (!isConnected || !walletClient || !onMainnet) return false;
    const st = steps[key].status;
    if (st !== 'idle' && st !== 'error') return false;
    if (SEED_STEPS.includes(key)) {
      if (!seedRouter || !pairsReady || !quote || !usdcePerSide) return false;
      const prior = SEED_STEPS.slice(0, SEED_STEPS.indexOf(key));
      return prior.every((k) => steps[k].status === 'confirmed');
    }
    if (!owner) return false;
    const { factory, router, harvester } = deployed;
    if (key === 'deployFactory' && factory) return false;
    if (key === 'deployRouter' && router) return false;
    if (key === 'deployHarvester' && harvester) return false;
    // Deploy steps are satisfied by a known address (fresh or pre-wired);
    // every other step must have confirmed in this browser.
    const prior = OPERATOR_STEPS.slice(0, OPERATOR_STEPS.indexOf(key));
    return prior.every((k) =>
      k === 'deployFactory'
        ? Boolean(factory)
        : k === 'deployRouter'
          ? Boolean(router)
          : k === 'deployHarvester'
            ? Boolean(harvester)
            : steps[k].status === 'confirmed',
    );
  }

  const visibleSteps = role === 'operator' ? OPERATOR_STEPS : SEED_STEPS;
  const fmt = (v: bigint, dec: number, max = 4) =>
    Number(formatUnits(v, dec)).toLocaleString(undefined, { maximumFractionDigits: max });
  const need =
    quote && usdcePerSide ? { usdce: usdcePerSide * 2n, eti: quote.eti, egaz: quote.egaz } : null;
  const short =
    need && balances
      ? {
          usdce: balances.usdce < need.usdce,
          eti: balances.eti < need.eti,
          egaz: balances.egaz < need.egaz,
        }
      : null;
  const seederMismatch =
    EXPECTED_SEEDER !== null &&
    address !== undefined &&
    address.toLowerCase() !== EXPECTED_SEEDER.toLowerCase();

  const injectedConnector = connectors.find((c) => c.id === 'injected') ?? connectors[0];
  const allDone =
    STEP_ORDER.every((k) => steps[k].status === 'confirmed') ||
    (Boolean(deployed.factory && deployed.router && deployed.harvester) &&
      STEP_ORDER.slice(3).every((k) => steps[k].status === 'confirmed'));

  return (
    <div className="space-y-6">
      {role === 'seeder' && (
        <section className="rounded-xl border border-white/[0.07] bg-white/[0.035] p-5">
          <h2 className="mb-3 text-lg font-semibold">Seed plan</h2>
          <p className="text-sm text-white/70">
            Four signatures from your wallet: approve USDC.e, approve ETI, then add{' '}
            <span className="font-mono">{usdPerSide}</span> USDC.e + the matching EGAZ to the
            EGAZ/USDC.e pair and <span className="font-mono">{usdPerSide}</span> USDC.e + the
            matching ETI to the ETI/USDC.e pair. Amounts are prefilled at the live hub price; the LP
            is minted to the dead address (permanently locked).
          </p>
          <div className="mt-3 grid gap-1 text-xs sm:grid-cols-3">
            {(
              [
                ['USDC.e', need?.usdce, balances?.usdce, USDC_WARP_ROUTE.decimals, short?.usdce],
                ['EGAZ', need?.egaz, balances?.egaz, 18, short?.egaz],
                ['ETI', need?.eti, balances?.eti, 18, short?.eti],
              ] as const
            ).map(([sym, n, have, dec, isShort]) => (
              <div
                key={sym}
                className={`rounded-md border p-2 ${isShort ? 'border-rose-400/40 bg-rose-500/10' : 'border-white/[0.07]'}`}
              >
                <div className="text-white/50">{sym}</div>
                <div className="font-mono">
                  need {n !== undefined ? fmt(n, dec) : '…'}
                  {sym === 'EGAZ' ? ' + gas' : ''}
                </div>
                <div className="font-mono text-white/60">
                  have {have !== undefined ? fmt(have, dec) : address ? '…' : '—'}
                </div>
              </div>
            ))}
          </div>
          {quoteError && (
            <p className="mt-2 text-xs text-amber-300/80">Hub quote failed: {quoteError}</p>
          )}
          {seedRouter && !pairsReady && (
            <p className="mt-2 text-xs text-amber-300/80">
              Direct pairs are not open yet on this router — the operator has to finish steps 1–10
              first.
            </p>
          )}
          {!deployed.router && (
            <label className="mt-4 block text-sm text-white/70">
              Direct router address
              <input
                type="text"
                className="mt-1 w-full rounded-md border border-white/[0.07] bg-black/20 px-3 py-2 font-mono text-xs text-white placeholder:text-white/30"
                value={routerInput}
                onChange={(e) => setRouterInput(e.target.value)}
                placeholder="0x… (from the operator, or ?router= in the URL)"
                spellCheck={false}
              />
            </label>
          )}
        </section>
      )}

      {role === 'operator' && (
        <section className="rounded-xl border border-white/[0.07] bg-white/[0.035] p-5">
          <h2 className="mb-4 text-lg font-semibold">Parameters</h2>
          <label className="block text-sm text-white/70">
            Owner / feeToSetter / treasury sink
            <input
              type="text"
              className="mt-1 w-full rounded-md border border-white/[0.07] bg-black/20 px-3 py-2 font-mono text-xs text-white placeholder:text-white/30"
              value={ownerInput}
              onChange={(e) => setOwnerInput(e.target.value)}
              placeholder="0x…"
              spellCheck={false}
            />
          </label>
          <p className="mt-1 text-xs text-white/50">
            Defaults to the treasury. Controls the gate (
            <span className="font-mono">setMinStEtx</span>
            ), the fee ladder, whitelist and <span className="font-mono">feeTo</span>; receives the
            40% treasury slice of harvests.
          </p>
          <label className="mt-4 block text-sm text-white/70">
            USDC.e per pair side
            <input
              type="text"
              inputMode="decimal"
              className="mt-1 w-40 rounded-md border border-white/[0.07] bg-black/20 px-3 py-2 font-mono text-xs text-white"
              value={usdPerSide}
              onChange={(e) => setUsdPerSide(e.target.value)}
            />
          </label>
          <p className="mt-1 text-xs text-white/50">
            Each pair is seeded with this much USDC.e plus the matching EGAZ / ETI at the current
            hub price (quoted live from the public router via ETX), so the direct pools open exactly
            in line with the hub. LP goes to the dead address.
          </p>
          <div className="mt-3 grid gap-1 text-xs text-white/70 sm:grid-cols-2">
            <div>
              EGAZ side:{' '}
              <span className="font-mono">
                {quote
                  ? Number(formatUnits(quote.egaz, 18)).toLocaleString(undefined, {
                      maximumFractionDigits: 4,
                    })
                  : '…'}
              </span>
            </div>
            <div>
              ETI side:{' '}
              <span className="font-mono">
                {quote
                  ? Number(formatUnits(quote.eti, 18)).toLocaleString(undefined, {
                      maximumFractionDigits: 4,
                    })
                  : '…'}
              </span>
            </div>
          </div>
          {quoteError && (
            <p className="mt-2 text-xs text-amber-300/80">Hub quote failed: {quoteError}</p>
          )}
          <dl className="mt-4 grid gap-1 text-xs text-white/50 sm:grid-cols-2">
            {(
              [
                ['stETX (gate)', tokens.stEtx],
                ['WEGAZ', tokens.wegaz],
                ['ETI', tokens.eti],
                ['USDC.e', tokens.usdce],
                ['ETX', tokens.etx],
                ['Hub router', tokens.hubRouter],
                ['Farms sink', tokens.farms],
              ] as const
            ).map(([k, v]) => (
              <div key={k} className="flex gap-2">
                <dt className="shrink-0">{k}</dt>
                <dd className="truncate font-mono">{v}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      <section className="rounded-xl border border-white/[0.07] bg-white/[0.035] p-5">
        <h2 className="mb-4 text-lg font-semibold">Wallet</h2>
        {!isConnected ? (
          <button
            type="button"
            className="rounded-md bg-emerald-500/90 px-4 py-2 text-sm font-medium text-black transition hover:bg-emerald-400 disabled:opacity-40"
            onClick={() => injectedConnector && connect({ connector: injectedConnector })}
            disabled={connectStatus === 'pending' || !injectedConnector}
          >
            {connectStatus === 'pending' ? 'Connecting…' : 'Connect Wallet'}
          </button>
        ) : (
          <div className="space-y-3 text-sm">
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-white/60">Connected:</span>
              <span className="font-mono break-all">{address}</span>
              <button
                type="button"
                className="ml-auto rounded-md border border-white/15 px-3 py-1 text-xs text-white/70 hover:bg-white/[0.035]"
                onClick={() => disconnect()}
              >
                Disconnect
              </button>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-white/60">Chain:</span>
              <span className="font-mono">{chainId}</span>
              {!onMainnet && (
                <button
                  type="button"
                  className="rounded-md bg-amber-400/90 px-3 py-1 text-xs font-medium text-black hover:bg-amber-300"
                  onClick={() => switchChain({ chainId: eticaMainnet.id })}
                  disabled={switching}
                >
                  {switching ? 'Switching…' : 'Switch to Etica Mainnet'}
                </button>
              )}
            </div>
            {seederMismatch && (
              <p className="text-xs text-amber-300/80">
                This is not the wallet expected to seed the pools (
                <span className="font-mono">{EXPECTED_SEEDER}</span>).
              </p>
            )}
            {role === 'operator' &&
              address &&
              owner &&
              address.toLowerCase() !== owner.toLowerCase() && (
                <p className="text-xs text-amber-300/80">
                  Connected wallet is not the owner above: the setter steps (whitelist, feeTo,
                  tiers, createPair) will revert unless signed by the owner.
                </p>
              )}
          </div>
        )}
      </section>

      <section className="rounded-xl border border-white/[0.07] bg-white/[0.035] p-5">
        <h2 className="mb-4 text-lg font-semibold">Steps</h2>
        <ol className="space-y-3">
          {visibleSteps.map((key, i) => {
            const st = steps[key];
            const addr =
              key === 'deployFactory'
                ? deployed.factory
                : key === 'deployRouter'
                  ? deployed.router
                  : key === 'deployHarvester'
                    ? deployed.harvester
                    : undefined;
            const done = st.status === 'confirmed' || Boolean(addr);
            return (
              <li
                key={key}
                className={`rounded-md border p-3 ${done ? 'border-emerald-400/30 bg-emerald-500/5' : 'border-white/[0.07]'}`}
              >
                <div className="flex flex-wrap items-center gap-3">
                  <span className="font-mono text-xs text-white/40">
                    {String(STEP_ORDER.indexOf(key) + 1).padStart(2, '0')}
                  </span>
                  <span className="text-sm font-medium">{STEP_LABELS[key].label}</span>
                  <button
                    type="button"
                    className="ml-auto rounded-md bg-emerald-500/90 px-3 py-1 text-xs font-medium text-black transition hover:bg-emerald-400 disabled:opacity-30"
                    onClick={() => runStep(key)}
                    disabled={!ready(key)}
                  >
                    {st.status === 'signing'
                      ? 'Sign in wallet…'
                      : st.status === 'pending'
                        ? 'Confirming…'
                        : done
                          ? 'Done'
                          : st.status === 'error'
                            ? 'Retry'
                            : 'Sign'}
                  </button>
                </div>
                <p className="mt-1 text-xs text-white/50">{STEP_LABELS[key].description}</p>
                {addr && (
                  <p className="mt-1 text-xs text-emerald-200/80">
                    <span className="font-mono break-all">{addr}</span>
                  </p>
                )}
                {st.txHash && (
                  <p className="mt-1 text-xs text-white/40">
                    Tx: <span className="font-mono break-all">{st.txHash}</span>
                  </p>
                )}
                {st.status === 'error' && st.error && (
                  <p className="mt-2 rounded-md border border-rose-400/30 bg-rose-500/10 p-2 text-xs text-rose-200">
                    {st.error}
                  </p>
                )}
              </li>
            );
          })}
        </ol>
      </section>

      {role === 'seeder' && SEED_STEPS.every((k) => steps[k].status === 'confirmed') && (
        <section className="rounded-xl border border-emerald-400/30 bg-emerald-500/10 p-5 text-sm text-emerald-200">
          Both direct pairs are seeded and the LP is locked at the dead address. You&apos;re done.
        </section>
      )}

      {role === 'operator' && deployed.factory && deployed.router && deployed.harvester && (
        <section className="rounded-xl border border-emerald-400/30 bg-emerald-500/10 p-5 text-sm">
          <h2 className="mb-2 text-lg font-semibold text-emerald-200">
            {allDone ? 'Venue live' : 'Contracts deployed'}
          </h2>
          <p className="text-emerald-200/80">
            Paste into <span className="font-mono">packages/shared/src/addresses.ts</span> under{' '}
            <span className="font-mono">DEPLOYMENTS[61803]</span>:
          </p>
          <pre className="mt-2 overflow-x-auto rounded-md bg-black/30 p-3 font-mono text-xs text-emerald-100">
            {`directFactory: '${deployed.factory}',\ndirectRouter: '${deployed.router}',\ndirectHarvesterAdapter: '${deployed.harvester}',`}
          </pre>
          <p className="mt-2 text-xs text-emerald-200/70">
            Seeder link (send to whoever funds the pools):{' '}
            <a
              className="font-mono underline"
              href={`/deploy/direct/seed?router=${deployed.router}`}
            >
              /deploy/direct/seed?router={deployed.router}
            </a>
          </p>
          <p className="mt-2 text-xs text-emerald-200/70">
            Then: register the factory with GeckoTerminal, enable the direct-harvest keeper, and add
            the “Direct route (stETX)” toggle on /swap.
          </p>
        </section>
      )}
    </div>
  );
}
