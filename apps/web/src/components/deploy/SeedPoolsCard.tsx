'use client';

import { useMemo, useState } from 'react';
import {
  BaseError,
  UserRejectedRequestError,
  isAddress,
  parseEther,
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
import { EXTERNAL_ADDRESSES } from '@etica-hub/shared/addresses';

const DEFAULT_ETI: Address = EXTERNAL_ADDRESSES[61803].eti;
const ZERO: Address = '0x0000000000000000000000000000000000000000';

const ERC20_ABI: Abi = [
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'value', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
];

const ROUTER_ABI: Abi = [
  {
    type: 'function',
    name: 'addLiquidity',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'tokenA', type: 'address' },
      { name: 'tokenB', type: 'address' },
      { name: 'amountADesired', type: 'uint256' },
      { name: 'amountBDesired', type: 'uint256' },
      { name: 'amountAMin', type: 'uint256' },
      { name: 'amountBMin', type: 'uint256' },
      { name: 'to', type: 'address' },
      { name: 'deadline', type: 'uint256' },
    ],
    outputs: [
      { name: 'amountA', type: 'uint256' },
      { name: 'amountB', type: 'uint256' },
      { name: 'liquidity', type: 'uint256' },
    ],
  },
  {
    type: 'function',
    name: 'addLiquidityEGAZ',
    stateMutability: 'payable',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'amountTokenDesired', type: 'uint256' },
      { name: 'amountTokenMin', type: 'uint256' },
      { name: 'amountEGAZMin', type: 'uint256' },
      { name: 'to', type: 'address' },
      { name: 'deadline', type: 'uint256' },
    ],
    outputs: [
      { name: 'amountToken', type: 'uint256' },
      { name: 'amountEGAZ', type: 'uint256' },
      { name: 'liquidity', type: 'uint256' },
    ],
  },
];

type StepStatus = 'idle' | 'signing' | 'pending' | 'confirmed' | 'error';

type StepState = {
  status: StepStatus;
  txHash?: Hex;
  error?: string;
};

const initial: StepState = { status: 'idle' };

type StepKey = 'approveEti' | 'approveEtx' | 'seedEti' | 'seedEgaz';

function shortError(err: unknown): string {
  if (err instanceof UserRejectedRequestError) return 'Rejected in wallet.';
  if (err instanceof BaseError) return err.shortMessage ?? err.message;
  if (err instanceof Error) return err.message;
  return 'Unknown error';
}

type StepDisplay = {
  key: StepKey;
  label: string;
  description: string;
};

const STEPS: StepDisplay[] = [
  {
    key: 'approveEti',
    label: '1. Approve ETI to router',
    description: 'One-time allowance so the router can pull your ETI into the pool.',
  },
  {
    key: 'approveEtx',
    label: '2. Approve ETX to router',
    description:
      'One-time allowance covering ETX spent on BOTH pools (ETI side + EGAZ side) plus a 20,000 ETX buffer the router forwards to the factory as the pair-creation fee (10k ETX per new pair, waived while feeTo is unset).',
  },
  {
    key: 'seedEti',
    label: '3. Seed ETI/ETX pool',
    description:
      'Calls router.addLiquidity(ETI, ETX, …). Opens the pair and mints LP tokens to you.',
  },
  {
    key: 'seedEgaz',
    label: '4. Seed EGAZ/ETX pool',
    description:
      'Calls router.addLiquidityEGAZ(ETX, …) with your EGAZ attached as msg.value.',
  },
];

export function SeedPoolsCard() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();
  const { connectors, connect, status: connectStatus } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain, isPending: switching } = useSwitchChain();

  const onMainnet = chainId === eticaMainnet.id;

  const [routerInput, setRouterInput] = useState<string>('');
  const [etxInput, setEtxInput] = useState<string>('');
  const [etiInput, setEtiInput] = useState<string>(DEFAULT_ETI);

  // Amounts in whole-token units (human-friendly). Defaults match the locked
  // "equalize both pools at $2.89/side" plan: $1K FDV, 100M ETX supply, ETX
  // price $0.00001, 77.75 ETI @ $0.0372, 761 EGAZ @ $0.0038 (NonKYC
  // reference prices). Each pool: ~289,230 ETX matched against the hub
  // token's USD value on the other side. Override any field before seeding
  // if your on-chain balances differ.
  const [etiAmount, setEtiAmount] = useState<string>('77.75');
  const [etxForEti, setEtxForEti] = useState<string>('289230');
  const [egazAmount, setEgazAmount] = useState<string>('761');
  const [etxForEgaz, setEtxForEgaz] = useState<string>('289230');

  const router = useMemo<Address | null>(
    () => (isAddress(routerInput.trim()) ? (routerInput.trim() as Address) : null),
    [routerInput],
  );
  const etx = useMemo<Address | null>(
    () => (isAddress(etxInput.trim()) ? (etxInput.trim() as Address) : null),
    [etxInput],
  );
  const eti = useMemo<Address | null>(
    () => (isAddress(etiInput.trim()) ? (etiInput.trim() as Address) : null),
    [etiInput],
  );

  const parsed = useMemo(() => {
    try {
      return {
        ok: true as const,
        etiAmount: parseEther(etiAmount || '0'),
        etxForEti: parseEther(etxForEti || '0'),
        egazAmount: parseEther(egazAmount || '0'),
        etxForEgaz: parseEther(etxForEgaz || '0'),
      };
    } catch (e) {
      return { ok: false as const, error: (e as Error).message };
    }
  }, [etiAmount, etxForEti, egazAmount, etxForEgaz]);

  // Each brand-new pair costs 10k ETX in createPair fees, forwarded by the
  // router. We seed TWO pools, so budget 20k ETX on top of the LP amounts.
  // Harmless if the treasury (feeTo) isn't wired yet — the factory just
  // skips the fee and the unused allowance stays with the user.
  const PAIR_CREATION_FEE_BUFFER = parseEther('20000');
  const etxApprovalTotal = parsed.ok
    ? parsed.etxForEti + parsed.etxForEgaz + PAIR_CREATION_FEE_BUFFER
    : 0n;

  const [steps, setSteps] = useState<Record<StepKey, StepState>>({
    approveEti: initial,
    approveEtx: initial,
    seedEti: initial,
    seedEgaz: initial,
  });

  const inputsValid = Boolean(router && etx && eti && parsed.ok);

  async function runWrite(
    key: StepKey,
    writeArgs: {
      to: Address;
      abi: Abi;
      functionName: string;
      args: readonly unknown[];
      value?: bigint;
    },
  ) {
    if (!walletClient || !publicClient || !address) return;
    setSteps((s) => ({ ...s, [key]: { status: 'signing' } }));
    let txHash: Hex;
    try {
      txHash = await walletClient.writeContract({
        account: address,
        address: writeArgs.to,
        abi: writeArgs.abi,
        functionName: writeArgs.functionName,
        args: writeArgs.args,
        value: writeArgs.value,
      });
    } catch (err) {
      setSteps((s) => ({ ...s, [key]: { status: 'error', error: shortError(err) } }));
      return;
    }

    setSteps((s) => ({ ...s, [key]: { status: 'pending', txHash } }));
    try {
      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
      if (receipt.status !== 'success') {
        setSteps((s) => ({
          ...s,
          [key]: { status: 'error', txHash, error: 'Transaction reverted on-chain' },
        }));
        return;
      }
      setSteps((s) => ({ ...s, [key]: { status: 'confirmed', txHash } }));
    } catch (err) {
      setSteps((s) => ({
        ...s,
        [key]: { status: 'error', txHash, error: shortError(err) },
      }));
    }
  }

  async function runStep(key: StepKey) {
    if (!inputsValid || !router || !etx || !eti || !parsed.ok || !address) return;
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 60 * 30);

    if (key === 'approveEti') {
      await runWrite(key, {
        to: eti,
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [router, parsed.etiAmount],
      });
      return;
    }

    if (key === 'approveEtx') {
      await runWrite(key, {
        to: etx,
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [router, etxApprovalTotal],
      });
      return;
    }

    if (key === 'seedEti') {
      await runWrite(key, {
        to: router,
        abi: ROUTER_ABI,
        functionName: 'addLiquidity',
        args: [
          eti,
          etx,
          parsed.etiAmount,
          parsed.etxForEti,
          0n,
          0n,
          address,
          deadline,
        ],
      });
      return;
    }

    if (key === 'seedEgaz') {
      await runWrite(key, {
        to: router,
        abi: ROUTER_ABI,
        functionName: 'addLiquidityEGAZ',
        args: [etx, parsed.etxForEgaz, 0n, 0n, address, deadline],
        value: parsed.egazAmount,
      });
      return;
    }
  }

  const injectedConnector = connectors.find((c) => c.id === 'injected') ?? connectors[0];
  const canRun = isConnected && onMainnet && inputsValid && Boolean(walletClient);

  return (
    <div className="space-y-6">
      <section className="rounded-xl border border-white/10 bg-white/5 p-5">
        <h2 className="mb-3 text-lg font-semibold">What this does</h2>
        <ol className="list-decimal space-y-1 pl-5 text-sm text-white/70">
          <li>Approves ETI + ETX allowances to the router.</li>
          <li>
            Seeds the <span className="font-mono">ETI/ETX</span> pool via{' '}
            <span className="font-mono">router.addLiquidity</span>.
          </li>
          <li>
            Seeds the <span className="font-mono">EGAZ/ETX</span> pool via{' '}
            <span className="font-mono">router.addLiquidityEGAZ</span> (EGAZ is wrapped into WEGAZ
            inside the router).
          </li>
          <li>
            LP tokens for both pools are minted to <span className="font-mono">your</span>{' '}
            connected wallet.
          </li>
        </ol>
      </section>

      <section className="rounded-xl border border-white/10 bg-white/5 p-5">
        <h2 className="mb-3 text-lg font-semibold">Prerequisites</h2>
        <ul className="list-disc space-y-1 pl-5 text-sm text-white/70">
          <li>
            ETX already deployed via <a className="text-emerald-400 underline" href="/deploy/etx">/deploy/etx</a>.
            Paste its address below.
          </li>
          <li>
            EticaSwap router already deployed via <a className="text-emerald-400 underline" href="/deploy/swap">/deploy/swap</a>.
            Paste its address below.
          </li>
          <li>Connected wallet holds at least the ETI, ETX, and EGAZ amounts shown below.</li>
          <li>~0.01 EGAZ extra for gas across the 4 transactions.</li>
        </ul>
      </section>

      <section className="rounded-xl border border-white/10 bg-white/5 p-5">
        <h2 className="mb-4 text-lg font-semibold">Wallet</h2>
        {!isConnected && (
          <button
            onClick={() => injectedConnector && connect({ connector: injectedConnector })}
            disabled={!injectedConnector || connectStatus === 'pending'}
            className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-black hover:bg-emerald-400 disabled:opacity-50"
          >
            {connectStatus === 'pending' ? 'Connecting…' : 'Connect MetaMask'}
          </button>
        )}
        {isConnected && (
          <div className="space-y-3 text-sm">
            <div className="font-mono text-white/80 break-all">{address}</div>
            <div>
              Chain:{' '}
              <span className={onMainnet ? 'text-emerald-400' : 'text-amber-400'}>
                {onMainnet ? 'Etica Mainnet (61803)' : `Wrong network (${chainId})`}
              </span>
            </div>
            {!onMainnet && (
              <button
                onClick={() => switchChain({ chainId: eticaMainnet.id })}
                disabled={switching}
                className="rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-medium text-black hover:bg-amber-400 disabled:opacity-50"
              >
                {switching ? 'Switching…' : 'Switch to Etica Mainnet'}
              </button>
            )}
            <button
              onClick={() => disconnect()}
              className="ml-2 rounded-lg border border-white/20 px-3 py-1.5 text-xs font-medium text-white/70 hover:bg-white/10"
            >
              Disconnect
            </button>
          </div>
        )}
      </section>

      <section className="rounded-xl border border-white/10 bg-white/5 p-5 space-y-4">
        <h2 className="text-lg font-semibold">Contract addresses</h2>
        <AddressField
          label="Router (EticaSwapRouter)"
          value={routerInput}
          onChange={setRouterInput}
          valid={Boolean(router)}
          placeholder="0x… (from /deploy/swap)"
        />
        <AddressField
          label="ETX token"
          value={etxInput}
          onChange={setEtxInput}
          valid={Boolean(etx)}
          placeholder="0x… (from /deploy/etx)"
        />
        <AddressField
          label="ETI token"
          value={etiInput}
          onChange={setEtiInput}
          valid={Boolean(eti)}
          placeholder="0x…"
        />
        <p className="text-xs text-white/50">
          ETI defaults to the mainnet Etica core address ({DEFAULT_ETI}). Override only if you
          know what you&apos;re doing.
        </p>
      </section>

      <section className="rounded-xl border border-white/10 bg-white/5 p-5 space-y-4">
        <h2 className="text-lg font-semibold">Pool amounts</h2>
        <p className="text-xs text-white/60">
          Amounts are in whole tokens (18 decimals). Defaults below target a $1,000 FDV on 100M
          ETX supply at ~$0.037 ETI / ~$0.0038 EGAZ, with ~$2.89 of value on each side of each
          pool (77.75 ETI / 761 EGAZ / 289,230 ETX per pool). Override if your wallet holdings
          differ.
        </p>
        <div className="grid gap-4 md:grid-cols-2">
          <AmountField label="ETI into ETI/ETX pool" value={etiAmount} onChange={setEtiAmount} />
          <AmountField label="ETX into ETI/ETX pool" value={etxForEti} onChange={setEtxForEti} />
          <AmountField
            label="EGAZ into EGAZ/ETX pool"
            value={egazAmount}
            onChange={setEgazAmount}
            hint="Attached as msg.value — wallet spends native EGAZ."
          />
          <AmountField
            label="ETX into EGAZ/ETX pool"
            value={etxForEgaz}
            onChange={setEtxForEgaz}
          />
        </div>
        {!parsed.ok && (
          <div className="text-xs text-red-400">Amounts must be numeric.</div>
        )}
        {parsed.ok && (
          <div className="text-xs text-white/50">
            Combined ETX approval: <span className="font-mono">{etxForEti}</span> +{' '}
            <span className="font-mono">{etxForEgaz}</span> +{' '}
            <span className="font-mono">20,000</span> (2 &times; 10k pair-creation fee) ={' '}
            <span className="font-mono">
              {(Number(etxForEti) + Number(etxForEgaz) + 20_000).toLocaleString()}
            </span>{' '}
            ETX
          </div>
        )}
      </section>

      <section className="space-y-4">
        {STEPS.map((step) => {
          const state = steps[step.key];
          const busy = state.status === 'signing' || state.status === 'pending';
          return (
            <div key={step.key} className="rounded-xl border border-white/10 bg-white/5 p-5">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h3 className="font-semibold">{step.label}</h3>
                  <p className="mt-1 text-sm text-white/60">{step.description}</p>
                </div>
                <button
                  onClick={() => runStep(step.key)}
                  disabled={!canRun || busy || state.status === 'confirmed'}
                  className="shrink-0 rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-black hover:bg-emerald-400 disabled:opacity-40"
                >
                  {state.status === 'confirmed'
                    ? 'Done'
                    : state.status === 'signing'
                      ? 'Confirm in wallet…'
                      : state.status === 'pending'
                        ? 'Confirming…'
                        : 'Run'}
                </button>
              </div>

              {state.status === 'error' && state.error && (
                <div className="mt-3 rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-300">
                  {state.error}
                </div>
              )}
              {state.txHash && (
                <div className="mt-3 text-xs text-white/60">
                  Tx:{' '}
                  <a
                    href={`https://eticascan.org/tx/${state.txHash}`}
                    target="_blank"
                    rel="noreferrer"
                    className="font-mono text-emerald-400 hover:underline"
                  >
                    {state.txHash}
                  </a>
                </div>
              )}
            </div>
          );
        })}
      </section>

      {steps.seedEti.status === 'confirmed' && steps.seedEgaz.status === 'confirmed' && (
        <section className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-5 text-sm">
          <h3 className="mb-2 font-semibold text-emerald-300">Pools live</h3>
          <p className="text-white/80">
            Both ETI/ETX and EGAZ/ETX pools are open. ETX is officially tradable on EticaHub.
            Next: announce the launch, update <span className="font-mono">packages/shared/src/addresses.ts</span>{' '}
            with the deployed ETX / router / factory addresses, and keep an eye on the first
            swaps.
          </p>
        </section>
      )}
    </div>
  );
}

function AddressField(props: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  valid: boolean;
  placeholder?: string;
}) {
  return (
    <div>
      <label className="mb-1 block text-sm font-medium text-white/80">{props.label}</label>
      <input
        type="text"
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        spellCheck={false}
        className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 font-mono text-sm outline-none focus:border-emerald-500"
        placeholder={props.placeholder}
      />
      {props.value && !props.valid && (
        <div className="mt-1 text-xs text-red-400">Not a valid address.</div>
      )}
    </div>
  );
}

function AmountField(props: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  hint?: string;
}) {
  return (
    <div>
      <label className="mb-1 block text-sm font-medium text-white/80">{props.label}</label>
      <input
        type="text"
        inputMode="decimal"
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        spellCheck={false}
        className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 font-mono text-sm outline-none focus:border-emerald-500"
      />
      {props.hint && <div className="mt-1 text-xs text-white/50">{props.hint}</div>}
    </div>
  );
}

// Silence unused import ZERO if a future edit drops the default; keeps the
// file minimally robust to change.
void ZERO;
