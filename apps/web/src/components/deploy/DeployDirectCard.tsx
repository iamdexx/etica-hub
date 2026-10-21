'use client';

import { useEffect, useMemo, useState, useRef } from 'react';
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
  encodeFunctionData,
  formatEther,
} from 'viem';
import { capGasPrice } from '@/lib/legacyTx';
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
  BRIDGE_ROLES,
  DEPLOYMENTS,
  EXTERNAL_ADDRESSES,
  TREASURY_ADDRESS,
  USDC_WARP_ROUTE,
} from '@etica-hub/shared/addresses';
import {
  directFactoryArtifact,
  directHarvesterAdapterArtifact,
  directMetaPairArtifact,
  directMetaPairDeployerArtifact,
  directRouterArtifact,
  unanimousMultisigArtifact,
} from '@/lib/direct-deploy-artifacts';

/**
 * Stepwise deployer for the EticaSwap Direct venue (hub windows). Every step
 * is one wallet signature; deployed addresses are kept in localStorage so a
 * reload resumes, and configuration steps are re-derived from chain.
 *
 * Operator (treasury):
 *   factory → window deployer → router → harvester → setMetaPairDeployer →
 *   whitelist router / harvester / seeder → setFeeTo(harvester) → setFeeTiers →
 *   harvester.setTreasuryToken(USDC.e) → createMetaPair ×2 → setGuardian → setUnpauser ×2 →
 *   deploy 2-of-2 multisig → setFeeToSetter(multisig) → harvester.transferOwnership(multisig)
 * Seeder (whitelisted wallet):
 *   wrap EGAZ → send USDC.e + WEGAZ to the EGAZ window → mint → send USDC.e + ETI
 *   to the ETI window → mint. The window turns the tokens into hub LP it can
 *   never withdraw; shares go to the dead address.
 */

const ZERO = '0x0000000000000000000000000000000000000000' as const;
const DEAD = '0x000000000000000000000000000000000000dEaD' as const;
const STORAGE_KEY = 'eticahub.deploy-direct.v2';
const LAUNCH_MIN_STETX = parseUnits('40000', 18);
/** Second multisig signer; also the default seeder. */
const SECOND_SIGNER: Address = '0x98d057B8fD9eA2256CbaeDc2d33A5e59af9c2051';
const LAUNCH_TIERS: readonly [bigint[], number[]] = [
  [
    parseUnits('40000', 18),
    parseUnits('100000', 18),
    parseUnits('250000', 18),
    parseUnits('500000', 18),
  ],
  [300, 150, 50, 10],
];

type Role = 'operator' | 'seeder' | 'handoff';
type StepKey =
  | 'deployFactory'
  | 'deployDeployer'
  | 'deployRouter'
  | 'deployHarvester'
  | 'setDeployer'
  | 'whitelistRouter'
  | 'whitelistHarvester'
  | 'whitelistSeeder'
  | 'setFeeTo'
  | 'setFeeTiers'
  | 'setTreasuryToken'
  | 'createWindowWegaz'
  | 'createWindowEti'
  | 'setGuardian'
  | 'setUnpauserOwner'
  | 'setUnpauserSigner'
  | 'setHarvesterKeeper'
  | 'deployMultisig'
  | 'setFeeToSetter'
  | 'transferHarvester'
  | 'wrapEgaz'
  | 'sendUsdceWegaz'
  | 'sendWegaz'
  | 'mintWegaz'
  | 'sendUsdceEti'
  | 'sendEti'
  | 'mintEti';

const SETUP_STEPS: StepKey[] = [
  'deployFactory',
  'deployDeployer',
  'deployRouter',
  'deployHarvester',
  'setDeployer',
  'whitelistRouter',
  'whitelistHarvester',
  'whitelistSeeder',
  'setFeeTo',
  'setFeeTiers',
  'setTreasuryToken',
  'createWindowWegaz',
  'createWindowEti',
  'setGuardian',
  'setUnpauserOwner',
  'setUnpauserSigner',
];
const HANDOFF_STEPS: StepKey[] = [
  'deployMultisig',
  'setFeeToSetter',
  'transferHarvester',
  'setHarvesterKeeper',
];
const OPERATOR_STEPS: StepKey[] = [...SETUP_STEPS, ...HANDOFF_STEPS];
const SEED_STEPS: StepKey[] = [
  'wrapEgaz',
  'sendUsdceWegaz',
  'sendWegaz',
  'mintWegaz',
  'sendUsdceEti',
  'sendEti',
  'mintEti',
];
const STEP_ORDER: StepKey[] = [...OPERATOR_STEPS, ...SEED_STEPS];

const ERC20_ABI = [
  {
    type: 'function',
    name: 'transfer',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
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
  { type: 'function', name: 'deposit', stateMutability: 'payable', inputs: [], outputs: [] },
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
const KEEPER_ABI = [
  {
    type: 'function',
    name: 'keepers',
    stateMutability: 'view',
    inputs: [{ name: '', type: 'address' }],
    outputs: [{ type: 'bool' }],
  },
  {
    type: 'function',
    name: 'setKeeper',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'keeper', type: 'address' },
      { name: 'allowed', type: 'bool' },
    ],
    outputs: [],
  },
] as const;
const MULTISIG_ABI = [
  {
    type: 'function',
    name: 'proposalCount',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'proposal',
    stateMutability: 'view',
    inputs: [{ name: 'id', type: 'uint256' }],
    outputs: [
      {
        type: 'tuple',
        components: [
          { name: 'target', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'data', type: 'bytes' },
          { name: 'confirmations', type: 'uint256' },
          { name: 'executed', type: 'bool' },
          { name: 'cancelled', type: 'bool' },
        ],
      },
    ],
  },
  {
    type: 'function',
    name: 'confirmed',
    stateMutability: 'view',
    inputs: [
      { name: 'id', type: 'uint256' },
      { name: 'owner', type: 'address' },
    ],
    outputs: [{ type: 'bool' }],
  },
  {
    type: 'function',
    name: 'propose',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'target', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'data', type: 'bytes' },
    ],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'confirm',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'id', type: 'uint256' }],
    outputs: [],
  },
] as const;
const OWNABLE_ABI = [
  {
    type: 'function',
    name: 'owner',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'transferOwnership',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'newOwner', type: 'address' }],
    outputs: [],
  },
] as const;

type StepStatus = 'idle' | 'signing' | 'pending' | 'confirmed' | 'error';
type StepState = { status: StepStatus; txHash?: Hex; error?: string };
const initial: StepState = { status: 'idle' };

const STEP_LABELS: Record<StepKey, { label: string; description: string }> = {
  deployFactory: {
    label: 'Deploy EticaDirectFactory',
    description:
      'feeToSetter = owner below (hand-off to the 2-of-2 is the last step), stETX gate, minStEtx = 40,000.',
  },
  deployDeployer: {
    label: 'Deploy EticaDirectMetaPairDeployer',
    description: 'Holds the window creation code (keeps the factory under the 24 KB limit).',
  },
  deployRouter: {
    label: 'Deploy EticaDirectRouter',
    description: 'V2-style router bound to the new factory and WEGAZ (quotes, feeBpsFor).',
  },
  deployHarvester: {
    label: 'Deploy DirectSwapHarvesterAdapter',
    description:
      'feeTo of the factory: collects window fees, splits 10/10/40/40 (stETX / farms / POL back into the windows / treasury in USDC.e).',
  },
  setDeployer: {
    label: 'factory.setMetaPairDeployer',
    description: 'Lets createMetaPair open windows.',
  },
  whitelistRouter: {
    label: 'Whitelist router',
    description: 'Router may act as swap recipient for intermediate hops.',
  },
  whitelistHarvester: {
    label: 'Whitelist harvester',
    description: 'Harvester deposits the 40% POL slice into the windows (mint is whitelist-only).',
  },
  whitelistSeeder: {
    label: 'Whitelist seeder',
    description:
      'The wallet below may deposit into the windows. Nobody else can; nobody can ever withdraw.',
  },
  setFeeTo: {
    label: 'factory.setFeeTo(harvester)',
    description: 'Window fees accrue to the harvester from the first swap.',
  },
  setFeeTiers: {
    label: 'factory.setFeeTiers',
    description: '40k → 3.00%, 100k → 1.50%, 250k → 0.50%, 500k+ → 0.10% (base 3.00%).',
  },
  setTreasuryToken: {
    label: 'harvester.setTreasuryToken(USDC.e)',
    description: 'The treasury’s 40% is paid in USDC.e instead of ETX.',
  },
  createWindowWegaz: {
    label: 'createMetaPair(EGAZ, USDC.e)',
    description:
      'Opens the EGAZ/USDC.e window over the EGAZ/ETX + USDC.e/ETX hub pools (emits V2 PairCreated).',
  },
  createWindowEti: {
    label: 'createMetaPair(ETI, USDC.e)',
    description: 'Opens the ETI/USDC.e window over the ETI/ETX + USDC.e/ETX hub pools.',
  },
  setGuardian: {
    label: 'factory.setGuardian',
    description:
      'Pause-only key for the direct-watcher (can stop swaps, nothing else). Leave blank to skip.',
  },
  setUnpauserOwner: {
    label: 'factory.setUnpauser(owner)',
    description:
      'Lets the owner wallet lift a pause on its own (1-of-2 resume); every other change stays 2-of-2.',
  },
  setUnpauserSigner: {
    label: 'factory.setUnpauser(second signer)',
    description: 'Same for the second signer, so either of you can unfreeze swaps alone.',
  },
  setHarvesterKeeper: {
    label: 'harvester.setKeeper(keeper wallet, true) via the 2-of-2',
    description:
      'Lets the direct-harvest cron (same key as the watcher) sell accrued fees to ETX and split them. Owner-only: once the harvester belongs to the multisig, the first signer proposes it here and the second signer opens this same page and confirms (which executes it).',
  },
  deployMultisig: {
    label: 'Deploy 2-of-2 UnanimousMultisig',
    description:
      'Owners: the treasury and the second signer. Every admin change needs both; one “no” means no change.',
  },
  setFeeToSetter: {
    label: 'factory.setFeeToSetter(multisig)',
    description:
      'From here on tiers, whitelist, guardian, unpause and retire/replace need both signatures.',
  },
  transferHarvester: {
    label: 'harvester.transferOwnership(multisig)',
    description: 'Split, sinks, treasury token and rescue move to the multisig too.',
  },
  wrapEgaz: {
    label: 'Wrap EGAZ for the pool',
    description: 'Deposits the EGAZ for the EGAZ window into its ERC-20 pool form.',
  },
  sendUsdceWegaz: {
    label: 'Send USDC.e to the EGAZ/USDC.e window',
    description: 'Plain transfer; the window holds it only until mint.',
  },
  sendWegaz: { label: 'Send EGAZ to the EGAZ/USDC.e window', description: 'Plain transfer (pool form).' },
  mintWegaz: {
    label: 'EGAZ/USDC.e window: mint',
    description:
      'Turns the two balances into EGAZ/ETX + USDC.e/ETX hub LP, locked forever; shares → dead.',
  },
  sendUsdceEti: { label: 'Send USDC.e to the ETI/USDC.e window', description: 'Plain transfer.' },
  sendEti: { label: 'Send ETI to the ETI/USDC.e window', description: 'Plain transfer.' },
  mintEti: {
    label: 'ETI/USDC.e window: mint',
    description:
      'Turns the two balances into ETI/ETX + USDC.e/ETX hub LP, locked forever; shares → dead.',
  },
};

type Deployed = {
  factory?: Address;
  deployer?: Address;
  router?: Address;
  harvester?: Address;
  multisig?: Address;
};
type Windows = { wegaz?: Address; eti?: Address };

function shortError(err: unknown): string {
  if (err instanceof UserRejectedRequestError) return 'Rejected in wallet.';
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let cur: unknown = err;
  while (cur && typeof cur === 'object' && !seen.has(cur)) {
    seen.add(cur);
    const e = cur as {
      message?: string;
      details?: string;
      code?: unknown;
      data?: unknown;
      cause?: unknown;
    };
    for (const v of [e.message, e.details]) {
      if (typeof v === 'string' && v && !parts.some((x) => x.includes(v))) parts.push(v);
    }
    if (e.code !== undefined) parts.push(`code ${String(e.code)}`);
    if (e.data !== undefined) {
      try {
        parts.push(`data ${typeof e.data === 'string' ? e.data : JSON.stringify(e.data)}`);
      } catch {
        /* unserialisable data */
      }
    }
    cur = e.cause;
  }
  if (parts.length) return parts.join(' | ');
  return err instanceof BaseError ? (err.shortMessage ?? err.message) : 'Unknown error';
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

const deployedIn = (dep: Deployed, k: StepKey): Address | undefined =>
  k === 'deployFactory'
    ? dep.factory
    : k === 'deployDeployer'
      ? dep.deployer
      : k === 'deployRouter'
        ? dep.router
        : k === 'deployHarvester'
          ? dep.harvester
          : k === 'deployMultisig'
            ? dep.multisig
            : undefined;

const same = (a?: Address | null, b?: Address | null) =>
  Boolean(a && b && a.toLowerCase() === b.toLowerCase());

export function DeployDirectCard({ role }: { role: Role }) {
  const { address, isConnected, chain: walletChain } = useAccount();
  const chainId = useChainId();
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();
  const [walletRpc, setWalletRpc] = useState<string>('');
  const { connectors, connect, status: connectStatus } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain, isPending: switching } = useSwitchChain();

  const onMainnet = chainId === eticaMainnet.id;

  // Asks the wallet's own RPC (not the app's) for the head block and the
  // signer's balance: a wallet that cannot answer these cannot broadcast either.
  useEffect(() => {
    if (!walletClient || !address) {
      setWalletRpc('');
      return;
    }
    let cancelled = false;
    setWalletRpc('checking…');
    (async () => {
      try {
        const req = walletClient.request as (args: {
          method: string;
          params?: unknown[];
        }) => Promise<unknown>;
        const [block, bal] = await Promise.all([
          req({ method: 'eth_blockNumber' }),
          req({ method: 'eth_getBalance', params: [address, 'latest'] }),
        ]);
        if (!cancelled)
          setWalletRpc(
            `ok · block ${Number(block as string)} · ${Number(formatEther(BigInt(bal as string))).toFixed(2)} ${walletChain?.nativeCurrency.symbol ?? 'native'}`,
          );
      } catch (err) {
        if (!cancelled) setWalletRpc(`FAILED: ${shortError(err)}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [walletClient, address, chainId, walletChain]);
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
  const [seederInput, setSeederInput] = useState<string>(SECOND_SIGNER);
  const [signerInput, setSignerInput] = useState<string>(SECOND_SIGNER);
  const [guardianInput, setGuardianInput] = useState<string>(BRIDGE_ROLES.keeper);
  const [usdPerSide, setUsdPerSide] = useState<string>('10');
  const [factoryInput, setFactoryInput] = useState<string>('');
  const [editAddrs, setEditAddrs] = useState(false);
  const [running, setRunning] = useState(false);
  const deployedRef = useRef<Deployed>({});
  const okRef = useRef(false);
  const [windows, setWindows] = useState<Windows>({});
  const [balances, setBalances] = useState<{
    usdce: bigint;
    eti: bigint;
    egaz: bigint;
    wegaz: bigint;
    allowed: boolean;
  } | null>(null);
  const [deployed, setDeployed] = useState<Deployed>({});
  useEffect(() => {
    deployedRef.current = deployed;
  }, [deployed]);
  const [steps, setSteps] = useState<Record<StepKey, StepState>>(
    () => Object.fromEntries(STEP_ORDER.map((k) => [k, initial])) as Record<StepKey, StepState>,
  );
  const stepsRef = useRef(steps);
  useEffect(() => {
    stepsRef.current = steps;
  }, [steps]);
  const [quote, setQuote] = useState<{ egaz: bigint; eti: bigint } | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);

  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const f = q.get('factory');
    if (f) setFactoryInput(f);
  }, []);
  useEffect(() => {
    if (role === 'handoff' && deployed.factory) setFactoryInput(deployed.factory);
  }, [role, deployed.factory]);

  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const fromUrl = (k: string) => parseAddr(q.get(k) ?? '') ?? undefined;
    const urlFactory = fromUrl('factory');
    const stored = loadDeployed();
    const saved: Deployed =
      urlFactory && stored.factory && !same(urlFactory, stored.factory) ? {} : stored;
    const pick = (live: Address, url?: Address, savedAddr?: Address) =>
      live !== ZERO ? live : (url ?? savedAddr);
    setDeployed({
      factory: pick(d.directFactory, urlFactory, saved.factory),
      deployer: pick(d.directMetaPairDeployer, undefined, saved.deployer),
      router: pick(d.directRouter, undefined, saved.router),
      harvester: pick(d.directHarvesterAdapter, fromUrl('harvester'), saved.harvester),
      multisig: pick(d.directAdmin, undefined, saved.multisig),
    });
  }, [
    d.directFactory,
    d.directMetaPairDeployer,
    d.directRouter,
    d.directHarvesterAdapter,
    d.directAdmin,
  ]);

  function remember(next: Deployed) {
    deployedRef.current = next;
    setDeployed(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* storage unavailable: addresses still shown on screen */
    }
  }

  const owner = useMemo(() => parseAddr(ownerInput), [ownerInput]);
  const seeder = useMemo(() => parseAddr(seederInput), [seederInput]);
  const signer = useMemo(() => parseAddr(signerInput), [signerInput]);
  const guardian = useMemo(() => parseAddr(guardianInput), [guardianInput]);
  const factoryAddr = useMemo(
    () => deployed.factory ?? parseAddr(factoryInput),
    [deployed.factory, factoryInput],
  );

  const usdcePerSide = useMemo(() => {
    try {
      const v = parseUnits(usdPerSide.trim() || '0', USDC_WARP_ROUTE.decimals);
      return v > 0n ? v : null;
    } catch {
      return null;
    }
  }, [usdPerSide]);

  // Windows resolve from the factory registry so the seeder (another browser)
  // and the resume logic share one source of truth.
  useEffect(() => {
    if (!publicClient || !onMainnet || !factoryAddr) {
      setWindows({});
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const [p0, p1] = (await Promise.all([
          publicClient.readContract({
            address: factoryAddr,
            abi: directFactoryArtifact.abi,
            functionName: 'getPair',
            args: [tokens.wegaz, tokens.usdce],
          }),
          publicClient.readContract({
            address: factoryAddr,
            abi: directFactoryArtifact.abi,
            functionName: 'getPair',
            args: [tokens.eti, tokens.usdce],
          }),
        ])) as [Address, Address];
        if (!cancelled)
          setWindows({ wegaz: p0 === ZERO ? undefined : p0, eti: p1 === ZERO ? undefined : p1 });
      } catch {
        if (!cancelled) setWindows({});
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    publicClient,
    onMainnet,
    factoryAddr,
    tokens.wegaz,
    tokens.eti,
    tokens.usdce,
    steps.createWindowWegaz.status,
    steps.createWindowEti.status,
  ]);

  useEffect(() => {
    if (!publicClient || !onMainnet || !address) {
      setBalances(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const bal = (token: Address) =>
          publicClient.readContract({
            address: token,
            abi: ERC20_ABI,
            functionName: 'balanceOf',
            args: [address],
          });
        const [usdce, eti, wegaz, egaz, allowed] = await Promise.all([
          bal(tokens.usdce),
          bal(tokens.eti),
          bal(tokens.wegaz),
          publicClient.getBalance({ address }),
          factoryAddr
            ? (publicClient.readContract({
                address: factoryAddr,
                abi: directFactoryArtifact.abi,
                functionName: 'whitelist',
                args: [address],
              }) as Promise<boolean>)
            : Promise.resolve(false),
        ]);
        if (!cancelled) setBalances({ usdce, eti, egaz, wegaz, allowed });
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
    factoryAddr,
    tokens.usdce,
    tokens.eti,
    tokens.wegaz,
    steps.wrapEgaz.status,
    steps.sendUsdceWegaz.status,
    steps.sendWegaz.status,
    steps.sendUsdceEti.status,
    steps.sendEti.status,
    steps.whitelistSeeder.status,
  ]);

  // Hub spot price from the public pools' reserves (USDC.e/ETX × ETX/WEGAZ|ETI).
  // Each window leg is deposited independently, so this only keeps the two
  // sides of a window roughly equal in value; nothing is at stake if it drifts.
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

  // Operator setup steps re-derive from chain so a reload resumes instead of
  // replaying txs that would revert.
  const {
    factory: knownFactory,
    deployer: knownDeployer,
    router: knownRouter,
    harvester: knownHarvester,
    multisig: knownMultisig,
  } = deployed;
  useEffect(() => {
    if (role === 'seeder' || !publicClient || !onMainnet || !knownFactory) return;
    let cancelled = false;
    (async () => {
      try {
        const fac = { address: knownFactory, abi: directFactoryArtifact.abi } as const;
        const read = (functionName: string, args: readonly unknown[] = []) =>
          publicClient.readContract({ ...fac, functionName, args });
        const harv = knownHarvester
          ? ({ address: knownHarvester, abi: directHarvesterAdapterArtifact.abi } as const)
          : null;
        const [
          metaDeployer,
          wlRouter,
          wlHarv,
          wlSeeder,
          feeTo,
          tierCount,
          pWegaz,
          pEti,
          g,
          upOwner,
          upSigner,
          setter,
          tTok,
          hOwner,
          hKeeper,
        ] = (await Promise.all([
          read('metaPairDeployer'),
          knownRouter ? read('whitelist', [knownRouter]) : false,
          knownHarvester ? read('whitelist', [knownHarvester]) : false,
          seeder ? read('whitelist', [seeder]) : false,
          read('feeTo'),
          read('feeTierCount'),
          read('getPair', [tokens.wegaz, tokens.usdce]),
          read('getPair', [tokens.eti, tokens.usdce]),
          read('guardian'),
          owner ? read('unpausers', [owner]) : false,
          signer ? read('unpausers', [signer]) : false,
          read('feeToSetter'),
          harv ? publicClient.readContract({ ...harv, functionName: 'treasuryToken' }) : ZERO,
          harv
            ? publicClient.readContract({ ...harv, abi: OWNABLE_ABI, functionName: 'owner' })
            : ZERO,
          harv
            ? publicClient.readContract({
                ...harv,
                abi: KEEPER_ABI,
                functionName: 'keepers',
                args: [BRIDGE_ROLES.keeper],
              })
            : false,
        ])) as [
          Address,
          boolean,
          boolean,
          boolean,
          Address,
          bigint,
          Address,
          Address,
          Address,
          boolean,
          boolean,
          Address,
          Address,
          Address,
          boolean,
        ];
        if (cancelled) return;
        if ((!knownDeployer && metaDeployer !== ZERO) || (!knownHarvester && feeTo !== ZERO)) {
          setDeployed((prev) => {
            const next = {
              ...prev,
              deployer: prev.deployer ?? (metaDeployer !== ZERO ? metaDeployer : undefined),
              harvester: prev.harvester ?? (feeTo !== ZERO ? feeTo : undefined),
            };
            try {
              window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
            } catch {
              /* storage unavailable */
            }
            return next;
          });
        }
        const done: Partial<Record<StepKey, boolean>> = {
          setDeployer: same(metaDeployer, knownDeployer),
          whitelistRouter: wlRouter,
          whitelistHarvester: wlHarv,
          whitelistSeeder: wlSeeder,
          setFeeTo: same(feeTo, knownHarvester),
          setFeeTiers: tierCount >= BigInt(LAUNCH_TIERS[0].length),
          setTreasuryToken: same(tTok, tokens.usdce),
          createWindowWegaz: pWegaz !== ZERO,
          createWindowEti: pEti !== ZERO,
          setGuardian: guardian ? same(g, guardian) : g !== ZERO,
          setUnpauserOwner: upOwner,
          setUnpauserSigner: upSigner,
          deployMultisig: Boolean(knownMultisig) || (setter !== ZERO && !same(setter, owner)),
          setFeeToSetter: same(setter, knownMultisig) || (setter !== ZERO && !same(setter, owner)),
          transferHarvester: hOwner !== ZERO && !same(hOwner, owner),
          setHarvesterKeeper: hKeeper,
        };
        if (!knownMultisig && setter !== ZERO && !same(setter, owner)) {
          setDeployed((prev) => {
            const next = { ...prev, multisig: prev.multisig ?? setter };
            try {
              window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
            } catch {
              /* storage unavailable */
            }
            return next;
          });
        }
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
    role,
    publicClient,
    onMainnet,
    knownFactory,
    knownDeployer,
    knownRouter,
    knownHarvester,
    knownMultisig,
    seeder,
    tokens.wegaz,
    tokens.eti,
    tokens.usdce,
    owner,
    signer,
    guardian,
  ]);

  // Seeder steps re-derive from the windows: tokens already sitting on a window
  // count as sent; a window with hub LP counts as fully seeded.
  const need = useMemo(
    () =>
      quote && usdcePerSide ? { usdce: usdcePerSide * 2n, eti: quote.eti, egaz: quote.egaz } : null,
    [quote, usdcePerSide],
  );
  useEffect(() => {
    if (role !== 'seeder' || !publicClient || !onMainnet || !quote || !usdcePerSide) return;
    const { wegaz: wA, eti: wB } = windows;
    if (!wA || !wB) return;
    let cancelled = false;
    (async () => {
      try {
        const bal = (token: Address, who: Address) =>
          publicClient.readContract({
            address: token,
            abi: ERC20_ABI,
            functionName: 'balanceOf',
            args: [who],
          });
        const lp = (w: Address) =>
          publicClient.readContract({
            address: w,
            abi: directMetaPairArtifact.abi,
            functionName: 'hubLiquidity',
          }) as Promise<[bigint, bigint]>;
        const [uA, gA, uB, eB, [lpA0, lpA1], [lpB0, lpB1], myWegaz] = await Promise.all([
          bal(tokens.usdce, wA),
          bal(tokens.wegaz, wA),
          bal(tokens.usdce, wB),
          bal(tokens.eti, wB),
          lp(wA),
          lp(wB),
          address ? bal(tokens.wegaz, address) : Promise.resolve(0n),
        ]);
        if (cancelled) return;
        const seededA = lpA0 > 0n && lpA1 > 0n;
        const seededB = lpB0 > 0n && lpB1 > 0n;
        const done: Partial<Record<StepKey, boolean>> = {
          wrapEgaz: seededA || myWegaz >= quote.egaz || gA >= quote.egaz,
          sendUsdceWegaz: seededA || uA >= usdcePerSide,
          sendWegaz: seededA || gA >= quote.egaz,
          mintWegaz: seededA,
          sendUsdceEti: seededB || uB >= usdcePerSide,
          sendEti: seededB || eB >= quote.eti,
          mintEti: seededB,
        };
        setSteps((s) => {
          let next = s;
          for (const [k, ok] of Object.entries(done) as [StepKey, boolean][]) {
            const st = s[k].status;
            if (st === 'signing' || st === 'pending') continue;
            if (ok && st !== 'confirmed') next = { ...next, [k]: { status: 'confirmed' } };
          }
          return next;
        });
      } catch {
        /* leave local state */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    role,
    publicClient,
    onMainnet,
    address,
    windows,
    quote,
    usdcePerSide,
    tokens.usdce,
    tokens.wegaz,
    tokens.eti,
    steps.wrapEgaz.status,
    steps.sendUsdceWegaz.status,
    steps.sendWegaz.status,
    steps.mintWegaz.status,
    steps.sendUsdceEti.status,
    steps.sendEti.status,
    steps.mintEti.status,
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
      okRef.current = true;
      return (receipt.contractAddress ?? undefined) as Address | undefined;
    } catch (err) {
      setSteps((s) => ({ ...s, [key]: { status: 'error', txHash, error: shortError(err) } }));
      return undefined;
    }
  }

  async function runStep(key: StepKey): Promise<boolean> {
    okRef.current = false;
    if (!walletClient || !address || !onMainnet) return false;
    const wc = walletClient;
    const account = address;
    const { factory, deployer, router, harvester, multisig } = deployedRef.current;

    // Etica reports baseFeePerGas = 0, which trips some wallets' EIP-1559 fee
    // builder on contract creation ("internal error"); estimate here and send
    // legacy-priced txs so the wallet only has to sign.
    const fees = async (tx: { to?: Address; data: Hex; value?: bigint }) => {
      if (!publicClient) return {};
      const [gas, gasPrice] = await Promise.all([
        publicClient.estimateGas({ account, ...tx }),
        publicClient.getGasPrice(),
      ]);
      const gasLimit = (gas * 13n) / 10n;
      return { gas: gasLimit, gasPrice: capGasPrice(gasLimit, gasPrice), type: 'legacy' as const };
    };
    const deploy = async (artifact: { abi: Abi; bytecode: Hex }, args: readonly unknown[]) => {
      const data = encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode, args });
      return wc.sendTransaction({ account, data, ...(await fees({ data })) });
    };
    const write = async (
      to: Address,
      abi: Abi,
      functionName: string,
      args: readonly unknown[],
      value?: bigint,
    ) => {
      const data = encodeFunctionData({ abi, functionName, args });
      return wc.writeContract({
        account,
        address: to,
        abi,
        functionName,
        args,
        value,
        ...(await fees({ to, data, value })),
      });
    };
    const fac = (functionName: string, args: readonly unknown[]) =>
      factory
        ? write(factory, directFactoryArtifact.abi, functionName, args)
        : Promise.reject(new Error('no factory'));

    switch (key) {
      case 'deployFactory': {
        if (!owner) return false;
        const a = await send(key, () =>
          deploy(directFactoryArtifact, [owner, tokens.stEtx, LAUNCH_MIN_STETX]),
        );
        if (a) remember({ ...deployedRef.current, factory: a });
        return okRef.current;
      }
      case 'deployDeployer': {
        const a = await send(key, () => deploy(directMetaPairDeployerArtifact, []));
        if (a) remember({ ...deployedRef.current, deployer: a });
        return okRef.current;
      }
      case 'deployRouter': {
        if (!factory) return false;
        const a = await send(key, () => deploy(directRouterArtifact, [factory, tokens.wegaz]));
        if (a) remember({ ...deployedRef.current, router: a });
        return okRef.current;
      }
      case 'deployHarvester': {
        if (!factory || !owner) return false;
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
        if (a) remember({ ...deployedRef.current, harvester: a });
        return okRef.current;
      }
      case 'setDeployer':
        if (!deployer) return false;
        await send(key, () => fac('setMetaPairDeployer', [deployer]));
        return okRef.current;
      case 'whitelistRouter':
        if (!router) return false;
        await send(key, () => fac('setWhitelist', [router, true]));
        return okRef.current;
      case 'whitelistHarvester':
        if (!harvester) return false;
        await send(key, () => fac('setWhitelist', [harvester, true]));
        return okRef.current;
      case 'whitelistSeeder':
        if (!seeder) return false;
        await send(key, () => fac('setWhitelist', [seeder, true]));
        return okRef.current;
      case 'setFeeTo':
        if (!harvester) return false;
        await send(key, () => fac('setFeeTo', [harvester]));
        return okRef.current;
      case 'setFeeTiers':
        await send(key, () => fac('setFeeTiers', [LAUNCH_TIERS[0], LAUNCH_TIERS[1]]));
        return okRef.current;
      case 'setTreasuryToken':
        if (!harvester) return false;
        await send(key, () =>
          write(harvester, directHarvesterAdapterArtifact.abi, 'setTreasuryToken', [tokens.usdce]),
        );
        return okRef.current;
      case 'createWindowWegaz':
        await send(key, () =>
          fac('createMetaPair', [tokens.wegaz, tokens.usdce, tokens.hubRouter]),
        );
        return okRef.current;
      case 'createWindowEti':
        await send(key, () => fac('createMetaPair', [tokens.eti, tokens.usdce, tokens.hubRouter]));
        return okRef.current;
      case 'setGuardian':
        if (!guardian) return false;
        await send(key, () => fac('setGuardian', [guardian]));
        return okRef.current;
      case 'setUnpauserOwner':
        if (!owner) return false;
        await send(key, () => fac('setUnpauser', [owner, true]));
        return okRef.current;
      case 'setUnpauserSigner':
        if (!signer) return false;
        await send(key, () => fac('setUnpauser', [signer, true]));
        return okRef.current;
      case 'setHarvesterKeeper': {
        if (!harvester || !publicClient) return false;
        const hOwner = (await publicClient.readContract({
          address: harvester,
          abi: OWNABLE_ABI,
          functionName: 'owner',
        })) as Address;
        if (same(hOwner, account)) {
          await send(key, () =>
            write(harvester, KEEPER_ABI, 'setKeeper', [BRIDGE_ROLES.keeper, true]),
          );
          return okRef.current;
        }
        const data = encodeFunctionData({
          abi: KEEPER_ABI,
          functionName: 'setKeeper',
          args: [BRIDGE_ROLES.keeper, true],
        });
        const ms = { address: hOwner, abi: MULTISIG_ABI } as const;
        const count = (await publicClient.readContract({
          ...ms,
          functionName: 'proposalCount',
        })) as bigint;
        let pending: bigint | null = null;
        for (let i = count; i > 0n; i--) {
          const id = i - 1n;
          const p = (await publicClient.readContract({
            ...ms,
            functionName: 'proposal',
            args: [id],
          })) as { target: Address; data: Hex; executed: boolean; cancelled: boolean };
          if (
            !p.executed &&
            !p.cancelled &&
            same(p.target, harvester) &&
            p.data.toLowerCase() === data.toLowerCase()
          ) {
            pending = id;
            break;
          }
        }
        if (pending === null) {
          await send(key, () => write(hOwner, MULTISIG_ABI, 'propose', [harvester, 0n, data]));
          return okRef.current;
        }
        const mine = (await publicClient.readContract({
          ...ms,
          functionName: 'confirmed',
          args: [pending, account],
        })) as boolean;
        if (mine) {
          setSteps((s) => ({
            ...s,
            [key]: {
              status: 'error',
              error: `Proposal #${pending} is waiting for the other signer: open this page from their wallet and click again.`,
            },
          }));
          return false;
        }
        await send(key, () => write(hOwner, MULTISIG_ABI, 'confirm', [pending]));
        return okRef.current;
      }
      case 'deployMultisig': {
        if (!owner || !signer || same(owner, signer)) return false;
        const a = await send(key, () => deploy(unanimousMultisigArtifact, [[owner, signer]]));
        if (a) remember({ ...deployedRef.current, multisig: a });
        return okRef.current;
      }
      case 'setFeeToSetter':
        if (!multisig) return false;
        await send(key, () => fac('setFeeToSetter', [multisig]));
        return okRef.current;
      case 'transferHarvester':
        if (!harvester || !multisig) return false;
        await send(key, () => write(harvester, OWNABLE_ABI, 'transferOwnership', [multisig]));
        return okRef.current;
      case 'wrapEgaz':
        if (!quote) return false;
        await send(key, () => write(tokens.wegaz, ERC20_ABI, 'deposit', [], quote.egaz));
        return okRef.current;
      case 'sendUsdceWegaz':
        if (!windows.wegaz || !usdcePerSide) return false;
        await send(key, () =>
          write(tokens.usdce, ERC20_ABI, 'transfer', [windows.wegaz, usdcePerSide]),
        );
        return okRef.current;
      case 'sendWegaz':
        if (!windows.wegaz || !quote) return false;
        await send(key, () =>
          write(tokens.wegaz, ERC20_ABI, 'transfer', [windows.wegaz, quote.egaz]),
        );
        return okRef.current;
      case 'mintWegaz':
        if (!windows.wegaz) return false;
        await send(key, () =>
          write(windows.wegaz as Address, directMetaPairArtifact.abi, 'mint', [DEAD]),
        );
        return okRef.current;
      case 'sendUsdceEti':
        if (!windows.eti || !usdcePerSide) return false;
        await send(key, () =>
          write(tokens.usdce, ERC20_ABI, 'transfer', [windows.eti, usdcePerSide]),
        );
        return okRef.current;
      case 'sendEti':
        if (!windows.eti || !quote) return false;
        await send(key, () => write(tokens.eti, ERC20_ABI, 'transfer', [windows.eti, quote.eti]));
        return okRef.current;
      case 'mintEti':
        if (!windows.eti) return false;
        await send(key, () =>
          write(windows.eti as Address, directMetaPairArtifact.abi, 'mint', [DEAD]),
        );
        return okRef.current;
    }
    return okRef.current;
  }

  const deployedFor = (k: StepKey) => deployedIn(deployed, k);
  const isDone = (k: StepKey) => steps[k].status === 'confirmed' || Boolean(deployedFor(k));
  const isDoneNow = (k: StepKey) =>
    stepsRef.current[k].status === 'confirmed' || Boolean(deployedIn(deployedRef.current, k));

  function ready(key: StepKey): boolean {
    if (!isConnected || !walletClient || !onMainnet) return false;
    const st = steps[key].status;
    if (st !== 'idle' && st !== 'error') return false;
    if (SEED_STEPS.includes(key)) {
      if (!windows.wegaz || !windows.eti || !quote || !usdcePerSide || !balances?.allowed)
        return false;
      return SEED_STEPS.slice(0, SEED_STEPS.indexOf(key)).every(isDone);
    }
    if (!owner) return false;
    if (deployedFor(key)) return false;
    if (key === 'whitelistSeeder' && !seeder) return false;
    if (key === 'setGuardian' && !guardian) return false;
    if (key === 'setUnpauserSigner' && !signer) return false;
    if (key === 'deployMultisig' && (!signer || same(owner, signer))) return false;
    if (HANDOFF_STEPS.includes(key)) {
      const base =
        role === 'handoff'
          ? Boolean(knownFactory && knownHarvester)
          : SETUP_STEPS.every((k) => k === 'setGuardian' || isDone(k));
      return base && HANDOFF_STEPS.slice(0, HANDOFF_STEPS.indexOf(key)).every(isDone);
    }
    return SETUP_STEPS.slice(0, SETUP_STEPS.indexOf(key)).every(
      (k) => k === 'setGuardian' || isDone(k),
    );
  }

  const visibleSteps =
    role === 'operator' ? SETUP_STEPS : role === 'handoff' ? HANDOFF_STEPS : SEED_STEPS;
  const optional = (k: StepKey) => k === 'setGuardian' && !guardian;
  const remaining = visibleSteps.filter((k) => !isDone(k) && !optional(k));
  const nextKey = remaining[0];
  const canRunAll = !running && nextKey !== undefined && ready(nextKey);

  async function runAll() {
    if (!canRunAll) return;
    setRunning(true);
    try {
      for (const key of remaining) {
        if (isDoneNow(key)) continue;
        const ok = await runStep(key);
        if (!ok) break;
      }
    } finally {
      setRunning(false);
    }
  }
  const fmt = (v: bigint, dec: number, max = 4) =>
    Number(formatUnits(v, dec)).toLocaleString(undefined, { maximumFractionDigits: max });
  const short =
    need && balances
      ? {
          usdce: balances.usdce < need.usdce,
          eti: balances.eti < need.eti,
          egaz: balances.egaz + balances.wegaz < need.egaz,
        }
      : null;

  const injectedConnector = connectors.find((c) => c.id === 'injected') ?? connectors[0];
  const setupDone = SETUP_STEPS.every((k) => k === 'setGuardian' || isDone(k));
  const handoffDone = HANDOFF_STEPS.every(isDone);
  const seeded = SEED_STEPS.every(isDone);

  const input =
    'mt-1 w-full rounded-md border border-white/[0.07] bg-black/20 px-3 py-2 font-mono text-xs text-white placeholder:text-white/30';

  return (
    <div className="space-y-6">
      {role === 'seeder' && (
        <section className="rounded-xl border border-white/[0.07] bg-white/[0.035] p-5">
          <h2 className="mb-3 text-lg font-semibold">Seed plan</h2>
          <p className="text-sm text-white/70">
            Seven signatures from your wallet: wrap EGAZ, then for each window send{' '}
            <span className="font-mono">{usdPerSide}</span> USDC.e plus the matching EGAZ / ETI and
            call <span className="font-mono">mint</span>. The window converts both into hub LP
            (EGAZ/ETX, ETI/ETX, USDC.e/ETX) that it can never withdraw; the accounting shares go to
            the dead address. Amounts are prefilled at the live hub price.
          </p>
          <div className="mt-3 grid gap-1 text-xs sm:grid-cols-3">
            {(
              [
                ['USDC.e', need?.usdce, balances?.usdce, USDC_WARP_ROUTE.decimals, short?.usdce],
                [
                  'EGAZ',
                  need?.egaz,
                  balances ? balances.egaz + balances.wegaz : undefined,
                  18,
                  short?.egaz,
                ],
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
          {factoryAddr && (!windows.wegaz || !windows.eti) && (
            <p className="mt-2 text-xs text-amber-300/80">
              The windows are not open yet on this factory; the operator has to finish setup first.
            </p>
          )}
          {factoryAddr && address && balances && !balances.allowed && (
            <p className="mt-2 text-xs text-amber-300/80">
              This wallet is not whitelisted on the factory yet (operator step “Whitelist seeder”);
              mint would revert.
            </p>
          )}
          {!deployed.factory && (
            <label className="mt-4 block text-sm text-white/70">
              Direct factory address
              <input
                type="text"
                className={input}
                value={factoryInput}
                onChange={(e) => setFactoryInput(e.target.value)}
                placeholder="0x… (from the operator, or ?factory= in the URL)"
                spellCheck={false}
              />
            </label>
          )}
        </section>
      )}

      {role !== 'seeder' && (
        <section className="rounded-xl border border-white/[0.07] bg-white/[0.035] p-5">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-lg font-semibold">Addresses</h2>
            <button
              type="button"
              className="rounded-md border border-white/15 px-3 py-1 text-xs text-white/70 hover:bg-white/[0.035]"
              onClick={() => setEditAddrs((v) => !v)}
            >
              {editAddrs ? 'Done' : 'Edit'}
            </button>
          </div>
          <p className="mb-3 text-xs text-white/50">
            All prefilled.{' '}
            {role === 'operator'
              ? 'Every step below is signed by the treasury.'
              : 'Both steps below are signed by the treasury.'}{' '}
            Nothing here needs typing unless an address changed.
          </p>
          {editAddrs ? (
            <>
              <label className="block text-sm text-white/70">
                Treasury (launch owner, harvester owner, treasury sink)
                <input
                  type="text"
                  className={input}
                  value={ownerInput}
                  onChange={(e) => setOwnerInput(e.target.value)}
                  spellCheck={false}
                />
              </label>
              <label className="mt-4 block text-sm text-white/70">
                Second multisig signer (also gets the solo-unpause right)
                <input
                  type="text"
                  className={input}
                  value={signerInput}
                  onChange={(e) => setSignerInput(e.target.value)}
                  spellCheck={false}
                />
              </label>
              {role === 'operator' && (
                <>
                  <label className="mt-4 block text-sm text-white/70">
                    Seeder wallet (whitelisted to deposit into the windows)
                    <input
                      type="text"
                      className={input}
                      value={seederInput}
                      onChange={(e) => setSeederInput(e.target.value)}
                      spellCheck={false}
                    />
                  </label>
                  <label className="mt-4 block text-sm text-white/70">
                    Guardian (keeper wallet; pause-only)
                    <input
                      type="text"
                      className={input}
                      value={guardianInput}
                      onChange={(e) => setGuardianInput(e.target.value)}
                      placeholder="0x… leave blank to skip setGuardian"
                      spellCheck={false}
                    />
                  </label>
                </>
              )}
            </>
          ) : (
            <dl className="grid gap-1 text-xs sm:grid-cols-[auto_1fr]">
              {(
                [
                  ['Treasury (signs everything)', owner ?? ownerInput],
                  ['Second signer (Ulmo)', signer ?? signerInput],
                  ...(role === 'operator'
                    ? ([
                        ['Seeder', seeder ?? seederInput],
                        ['Guardian (keeper, pause-only)', (guardian ?? guardianInput) || 'none'],
                      ] as const)
                    : ([
                        ['Factory', knownFactory ?? 'not found'],
                        ['Harvester', knownHarvester ?? 'not found'],
                        ['Multisig', knownMultisig ?? 'not deployed yet'],
                      ] as const)),
                ] as const
              ).map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="text-white/50 sm:pr-4">{k}</dt>
                  <dd className="truncate font-mono text-white/80">{v}</dd>
                </div>
              ))}
            </dl>
          )}
          {role === 'handoff' && (
            <label className="mt-4 block text-sm text-white/70">
              Direct factory address
              <input
                type="text"
                className={input}
                value={factoryInput}
                onChange={(e) => {
                  setFactoryInput(e.target.value);
                  const a = parseAddr(e.target.value);
                  if (same(a, deployed.factory)) return;
                  setDeployed(a ? { factory: a } : {});
                  setSteps((prev) => {
                    const next = { ...prev };
                    for (const k of HANDOFF_STEPS) next[k] = initial;
                    return next;
                  });
                }}
                placeholder="0x… (from the deploy page, or ?factory= in the URL)"
                spellCheck={false}
              />
            </label>
          )}
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
            </div>
            {walletRpc && (
              <div className="flex items-start gap-3 text-xs">
                <span className="shrink-0 text-white/60">Wallet RPC:</span>
                <span
                  className={`break-all font-mono ${walletRpc.startsWith('FAILED') ? 'text-red-300' : 'text-white/80'}`}
                >
                  {walletRpc}
                </span>
              </div>
            )}
            <div className="flex items-center gap-3">
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
            {role !== 'seeder' && address && owner && !same(address, owner) && (
              <p className="text-xs text-amber-300/80">
                Connected wallet is not the owner above: the setter steps will revert unless signed
                by the owner.
              </p>
            )}
          </div>
        )}
      </section>

      <section className="rounded-xl border border-white/[0.07] bg-white/[0.035] p-5">
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <h2 className="text-lg font-semibold">Steps</h2>
          <button
            type="button"
            className="ml-auto rounded-md bg-emerald-500/90 px-4 py-2 text-sm font-semibold text-black transition hover:bg-emerald-400 disabled:opacity-30"
            onClick={() => void runAll()}
            disabled={!canRunAll}
          >
            {running
              ? `Running… approve each popup (${remaining.length} left)`
              : remaining.length === 0
                ? 'All done'
                : role === 'operator'
                  ? `Launch everything (${remaining.length} signatures)`
                  : role === 'handoff'
                    ? `Hand off to the 2-of-2 (${remaining.length} signatures)`
                    : `Seed both windows (${remaining.length} signatures)`}
          </button>
        </div>
        <p className="mb-3 text-xs text-white/50">
          One click runs every remaining step in order; your wallet asks you to approve each
          transaction. If one fails it stops there and the step shows the error; fix it and click
          again to continue, or sign a single step below.
        </p>
        <ol className="space-y-3">
          {visibleSteps.map((key) => {
            const st = steps[key];
            const addr = deployedFor(key);
            const done = isDone(key);
            return (
              <li key={key}>
                <div
                  className={`rounded-md border p-3 ${done ? 'border-emerald-400/30 bg-emerald-500/5' : 'border-white/[0.07]'}`}
                >
                  <div className="flex flex-wrap items-center gap-3">
                    <span className="font-mono text-xs text-white/40">
                      {String(visibleSteps.indexOf(key) + 1).padStart(2, '0')}
                    </span>
                    <span className="text-sm font-medium">{STEP_LABELS[key].label}</span>
                    <button
                      type="button"
                      className="ml-auto rounded-md bg-emerald-500/90 px-3 py-1 text-xs font-medium text-black transition hover:bg-emerald-400 disabled:opacity-30"
                      onClick={() => void runStep(key)}
                      disabled={running || !ready(key)}
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
                  {(key === 'createWindowWegaz' || key === 'createWindowEti') &&
                    (key === 'createWindowWegaz' ? windows.wegaz : windows.eti) && (
                      <p className="mt-1 text-xs text-emerald-200/80">
                        <span className="font-mono break-all">
                          {key === 'createWindowWegaz' ? windows.wegaz : windows.eti}
                        </span>
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
                </div>
              </li>
            );
          })}
        </ol>
      </section>

      {role === 'seeder' && seeded && (
        <section className="rounded-xl border border-emerald-400/30 bg-emerald-500/10 p-5 text-sm text-emerald-200">
          Both windows are backed by hub LP and the shares sit at the dead address. You&apos;re
          done.
        </section>
      )}

      {role !== 'seeder' && deployed.factory && deployed.harvester && (
        <section className="rounded-xl border border-emerald-400/30 bg-emerald-500/10 p-5 text-sm">
          <h2 className="mb-2 text-lg font-semibold text-emerald-200">
            {handoffDone
              ? 'Venue live, admin on the 2-of-2, harvest keeper set'
              : setupDone
                ? 'Venue configured'
                : 'Contracts deployed'}
          </h2>
          <p className="text-emerald-200/80">
            Paste into <span className="font-mono">packages/shared/src/addresses.ts</span> under{' '}
            <span className="font-mono">DEPLOYMENTS[61803]</span>:
          </p>
          <pre className="mt-2 overflow-x-auto rounded-md bg-black/30 p-3 font-mono text-xs text-emerald-100">
            {`directFactory: '${deployed.factory}',\ndirectMetaPairDeployer: '${deployed.deployer ?? ZERO}',\ndirectRouter: '${deployed.router}',\ndirectHarvesterAdapter: '${deployed.harvester}',\ndirectAdmin: '${deployed.multisig ?? ZERO}',`}
          </pre>
          {role === 'operator' && (
            <>
              <p className="mt-2 text-xs text-emerald-200/70">
                Send this link to the seeder (his page reads the windows from the factory):{' '}
                <a
                  className="font-mono underline"
                  href={`https://eticahub.com/deploy/direct/seed?factory=${deployed.factory}`}
                >
                  https://eticahub.com/deploy/direct/seed?factory={deployed.factory}
                </a>
              </p>
              <p className="mt-2 text-xs text-emerald-200/70">
                When you want admin on the 2-of-2 (treasury signs, after seeding):{' '}
                <a
                  className="font-mono underline"
                  href={`https://eticahub.com/deploy/direct/handoff?factory=${deployed.factory}&harvester=${deployed.harvester}`}
                >
                  https://eticahub.com/deploy/direct/handoff?factory={deployed.factory}
                  &amp;harvester={deployed.harvester}
                </a>
              </p>
            </>
          )}
          <p className="mt-2 text-xs text-emerald-200/70">
            Then: fill <span className="font-mono">apps/direct-watcher/expected.json</span> with
            these addresses (the keeper key already signs for the guardian), dispatch the
            direct-watcher workflow once, verify source on the explorer, and ask GeckoTerminal to
            index the windows.
          </p>
        </section>
      )}
    </div>
  );
}
