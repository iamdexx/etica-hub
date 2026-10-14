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

const HUB_ROUTER_ABI = [
  {
    type: 'function',
    name: 'getAmountsOut',
    stateMutability: 'view',
    inputs: [
      { name: 'amountIn', type: 'uint256' },
      { name: 'path', type: 'address[]' },
    ],
    outputs: [{ name: 'amounts', type: 'uint256[]' }],
  },
] as const satisfies Abi;

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

export function DeployDirectCard() {
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
  };

  const [ownerInput, setOwnerInput] = useState<string>(TREASURY_ADDRESS);
  const [usdPerSide, setUsdPerSide] = useState<string>('10');
  const [deployed, setDeployed] = useState<Deployed>({});
  const [steps, setSteps] = useState<Record<StepKey, StepState>>(
    () => Object.fromEntries(STEP_ORDER.map((k) => [k, initial])) as Record<StepKey, StepState>,
  );
  const [quote, setQuote] = useState<{ egaz: bigint; eti: bigint } | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);

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
  const usdcePerSide = useMemo(() => {
    try {
      const v = parseUnits(usdPerSide.trim() || '0', USDC_WARP_ROUTE.decimals);
      return v > 0n ? v : null;
    } catch {
      return null;
    }
  }, [usdPerSide]);

  // Hub-price quote: what the public router gives for `usdcePerSide` via ETX,
  // so both direct pairs open at exactly the hub price (no arb gap at birth).
  useEffect(() => {
    if (!publicClient || !onMainnet || !usdcePerSide) {
      setQuote(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const [egazPath, etiPath] = await Promise.all([
          publicClient.readContract({
            address: tokens.hubRouter,
            abi: HUB_ROUTER_ABI,
            functionName: 'getAmountsOut',
            args: [usdcePerSide, [tokens.usdce, tokens.etx, tokens.wegaz]],
          }),
          publicClient.readContract({
            address: tokens.hubRouter,
            abi: HUB_ROUTER_ABI,
            functionName: 'getAmountsOut',
            args: [usdcePerSide, [tokens.usdce, tokens.etx, tokens.eti]],
          }),
        ]);
        if (cancelled) return;
        setQuote({ egaz: egazPath[2], eti: etiPath[2] });
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
    tokens.hubRouter,
    tokens.usdce,
    tokens.etx,
    tokens.wegaz,
    tokens.eti,
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
    if (!walletClient || !address || !owner || !onMainnet) return;
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
          deploy(directFactoryArtifact, [owner, tokens.stEtx, LAUNCH_MIN_STETX]),
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
            owner,
            factory,
            tokens.hubRouter,
            tokens.etx,
            tokens.stEtx,
            tokens.farms,
            owner,
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
        if (!router || !usdcePerSide) return;
        await send(key, () =>
          write(tokens.usdce, ERC20_ABI, 'approve', [router, usdcePerSide * 2n]),
        );
        return;
      case 'approveEti':
        if (!router || !quote) return;
        await send(key, () => write(tokens.eti, ERC20_ABI, 'approve', [router, quote.eti]));
        return;
      case 'seedWegaz':
        if (!router || !usdcePerSide || !quote) return;
        await send(key, () =>
          write(
            router,
            directRouterArtifact.abi,
            'addLiquidityEGAZ',
            [tokens.usdce, usdcePerSide, usdcePerSide, quote.egaz, DEAD, deadline],
            quote.egaz,
          ),
        );
        return;
      case 'seedEti':
        if (!router || !usdcePerSide || !quote) return;
        await send(key, () =>
          write(router, directRouterArtifact.abi, 'addLiquidity', [
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
    if (!isConnected || !walletClient || !owner || !onMainnet) return false;
    const { factory, router, harvester } = deployed;
    const idx = STEP_ORDER.indexOf(key);
    const prior = STEP_ORDER.slice(0, idx);
    // Deploy steps are satisfied by a known address (fresh or pre-wired);
    // every other step must have confirmed in this browser.
    const priorDone = prior.every((k) =>
      k === 'deployFactory'
        ? Boolean(factory)
        : k === 'deployRouter'
          ? Boolean(router)
          : k === 'deployHarvester'
            ? Boolean(harvester)
            : steps[k].status === 'confirmed',
    );
    if (!priorDone) return false;
    if (key === 'deployFactory' && factory) return false;
    if (key === 'deployRouter' && router) return false;
    if (key === 'deployHarvester' && harvester) return false;
    if (
      ['approveUsdce', 'approveEti', 'seedWegaz', 'seedEti'].includes(key) &&
      (!quote || !usdcePerSide)
    ) {
      return false;
    }
    const st = steps[key].status;
    return st === 'idle' || st === 'error';
  }

  const injectedConnector = connectors.find((c) => c.id === 'injected') ?? connectors[0];
  const allDone =
    STEP_ORDER.every((k) => steps[k].status === 'confirmed') ||
    (Boolean(deployed.factory && deployed.router && deployed.harvester) &&
      STEP_ORDER.slice(3).every((k) => steps[k].status === 'confirmed'));

  return (
    <div className="space-y-6">
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
          Each pair is seeded with this much USDC.e plus the matching EGAZ / ETI at the current hub
          price (quoted live from the public router via ETX), so the direct pools open exactly in
          line with the hub. LP goes to the dead address.
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
            {address && owner && address.toLowerCase() !== owner.toLowerCase() && (
              <p className="text-xs text-amber-300/80">
                Connected wallet is not the owner above: the setter steps (whitelist, feeTo, tiers,
                createPair) will revert unless signed by the owner.
              </p>
            )}
          </div>
        )}
      </section>

      <section className="rounded-xl border border-white/[0.07] bg-white/[0.035] p-5">
        <h2 className="mb-4 text-lg font-semibold">Steps</h2>
        <ol className="space-y-3">
          {STEP_ORDER.map((key, i) => {
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
                    {String(i + 1).padStart(2, '0')}
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

      {deployed.factory && deployed.router && deployed.harvester && (
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
            Then: register the factory with GeckoTerminal, enable the direct-harvest keeper, and add
            the “Direct route (stETX)” toggle on /swap.
          </p>
        </section>
      )}
    </div>
  );
}
