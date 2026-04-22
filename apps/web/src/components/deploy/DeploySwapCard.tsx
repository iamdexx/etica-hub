'use client';

import { useMemo, useState } from 'react';
import {
  BaseError,
  UserRejectedRequestError,
  isAddress,
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
  factoryArtifact,
  routerArtifact,
  wegazArtifact,
} from '@/lib/deploy-artifacts';

const DEFAULT_TREASURY: Address = '0xB2B4bC9d02970A55efF64C2D84c622c87967C19D';

type DeployState = {
  status: 'idle' | 'signing' | 'pending' | 'confirmed' | 'error';
  txHash?: Hex;
  address?: Address;
  error?: string;
};

const initial: DeployState = { status: 'idle' };

type StepKey = 'wegaz' | 'factory' | 'router';

type StepConfig = {
  key: StepKey;
  label: string;
  description: string;
  abi: Abi;
  bytecode: Hex;
  args: (ctx: { treasury: Address; etx?: Address; wegaz?: Address; factory?: Address }) =>
    | { ready: true; args: readonly unknown[] }
    | { ready: false; missing: string };
};

const STEPS: StepConfig[] = [
  {
    key: 'wegaz',
    label: '1. Deploy Wrapped EGAZ',
    description:
      'ERC-20 wrapper for the native EGAZ gas token. Deploys first — no dependencies. (Contract symbol on-chain: WEGAZ.)',
    abi: wegazArtifact.abi,
    bytecode: wegazArtifact.bytecode,
    args: () => ({ ready: true, args: [] }),
  },
  {
    key: 'factory',
    label: '2. Deploy EticaSwapFactory',
    description:
      'Uniswap V2 factory with your treasury as feeToSetter and ETX locked in as the hub token. Every pair must include ETX — except contracts you whitelist via setTrustedCreator (the launchpad).',
    abi: factoryArtifact.abi,
    bytecode: factoryArtifact.bytecode,
    args: ({ treasury, etx }) => {
      if (!etx) return { ready: false, missing: 'ETX address' };
      return { ready: true, args: [treasury, etx] };
    },
  },
  {
    key: 'router',
    label: '3. Deploy EticaSwapRouter',
    description:
      'Uniswap V2 router wired to the factory and the wrapped-EGAZ contract. This is the entry point the swap UI talks to.',
    abi: routerArtifact.abi,
    bytecode: routerArtifact.bytecode,
    args: ({ wegaz, factory }) => {
      if (!factory) return { ready: false, missing: 'factory' };
      if (!wegaz) return { ready: false, missing: 'wegaz' };
      return { ready: true, args: [factory, wegaz] };
    },
  },
];

function shortError(err: unknown): string {
  if (err instanceof UserRejectedRequestError) return 'Rejected in wallet.';
  if (err instanceof BaseError) return err.shortMessage ?? err.message;
  if (err instanceof Error) return err.message;
  return 'Unknown error';
}

export function DeploySwapCard() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();
  const { connectors, connect, status: connectStatus } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain, isPending: switching } = useSwitchChain();

  const onMainnet = chainId === eticaMainnet.id;

  const [treasuryInput, setTreasuryInput] = useState<string>(DEFAULT_TREASURY);
  const treasury = useMemo<Address | null>(() => {
    const t = treasuryInput.trim();
    return isAddress(t) ? (t as Address) : null;
  }, [treasuryInput]);

  const [etxInput, setEtxInput] = useState<string>('');
  const etx = useMemo<Address | null>(() => {
    const t = etxInput.trim();
    return isAddress(t) ? (t as Address) : null;
  }, [etxInput]);

  const [deployed, setDeployed] = useState<Record<StepKey, DeployState>>({
    wegaz: initial,
    factory: initial,
    router: initial,
  });

  const addresses = useMemo(() => {
    return {
      wegaz: deployed.wegaz.address,
      factory: deployed.factory.address,
      router: deployed.router.address,
    };
  }, [deployed]);

  const allConfirmed =
    deployed.wegaz.status === 'confirmed' &&
    deployed.factory.status === 'confirmed' &&
    deployed.router.status === 'confirmed';

  async function runStep(step: StepConfig) {
    if (!walletClient || !publicClient || !address || !treasury) return;
    const argSpec = step.args({
      treasury,
      etx: etx ?? undefined,
      wegaz: addresses.wegaz,
      factory: addresses.factory,
    });
    if (!argSpec.ready) {
      setDeployed((s) => ({
        ...s,
        [step.key]: { status: 'error', error: `Deploy ${argSpec.missing} first` },
      }));
      return;
    }

    setDeployed((s) => ({ ...s, [step.key]: { status: 'signing' } }));
    let txHash: Hex;
    try {
      txHash = await walletClient.deployContract({
        abi: step.abi,
        bytecode: step.bytecode,
        args: argSpec.args,
        account: address,
      });
    } catch (err) {
      setDeployed((s) => ({ ...s, [step.key]: { status: 'error', error: shortError(err) } }));
      return;
    }

    setDeployed((s) => ({ ...s, [step.key]: { status: 'pending', txHash } }));

    try {
      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
      if (receipt.status !== 'success' || !receipt.contractAddress) {
        setDeployed((s) => ({
          ...s,
          [step.key]: {
            status: 'error',
            txHash,
            error: 'Transaction reverted on-chain',
          },
        }));
        return;
      }
      setDeployed((s) => ({
        ...s,
        [step.key]: {
          status: 'confirmed',
          txHash,
          address: receipt.contractAddress as Address,
        },
      }));
    } catch (err) {
      setDeployed((s) => ({
        ...s,
        [step.key]: { status: 'error', txHash, error: shortError(err) },
      }));
    }
  }

  const injectedConnector = connectors.find((c) => c.id === 'injected') ?? connectors[0];

  return (
    <div className="space-y-6">
      <section className="rounded-xl border border-white/10 bg-white/5 p-5">
        <h2 className="mb-3 text-lg font-semibold">Prerequisites</h2>
        <ol className="list-decimal space-y-1 pl-5 text-sm text-white/70">
          <li>MetaMask installed and unlocked.</li>
          <li>Connected to Etica Mainnet (chain id 61803). This page can add it for you.</li>
          <li>At least <span className="font-mono">~0.05 EGAZ</span> in the deploying wallet to cover gas for all 3 deploys.</li>
          <li>
            Treasury address below is the <span className="font-mono">feeToSetter</span>. Defaults to the project
            treasury; change it if you&apos;re deploying under a different owner.
          </li>
          <li>
            <span className="font-mono">ETX</span> must be deployed first (via <a href="/deploy/etx" className="underline">/deploy/etx</a>)
            and its address pasted below — the factory locks ETX in as the hub token at deploy.
          </li>
        </ol>
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

      <section className="rounded-xl border border-white/10 bg-white/5 p-5">
        <h2 className="mb-3 text-lg font-semibold">Treasury / feeToSetter</h2>
        <input
          type="text"
          value={treasuryInput}
          onChange={(e) => setTreasuryInput(e.target.value)}
          spellCheck={false}
          className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 font-mono text-sm outline-none focus:border-emerald-500"
          placeholder="0x…"
        />
        {!treasury && (
          <div className="mt-2 text-xs text-red-400">
            Not a valid address.
          </div>
        )}
      </section>

      <section className="rounded-xl border border-white/10 bg-white/5 p-5">
        <h2 className="mb-3 text-lg font-semibold">ETX token address</h2>
        <p className="mb-3 text-xs text-white/60">
          Paste the address of the deployed ETX ERC-20. The factory will lock this as the hub
          token — every pair must include ETX (except contracts whitelisted later via
          <span className="font-mono"> setTrustedCreator</span>, e.g. the launchpad).
        </p>
        <input
          type="text"
          value={etxInput}
          onChange={(e) => setEtxInput(e.target.value)}
          spellCheck={false}
          className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 font-mono text-sm outline-none focus:border-emerald-500"
          placeholder="0x…"
        />
        {etxInput.trim().length > 0 && !etx && (
          <div className="mt-2 text-xs text-red-400">
            Not a valid address.
          </div>
        )}
      </section>

      <section className="space-y-4">
        {STEPS.map((step) => {
          const state = deployed[step.key];
          const canRun = isConnected && onMainnet && Boolean(treasury) && Boolean(walletClient);
          const argSpec = step.args({
            treasury: treasury ?? DEFAULT_TREASURY,
            etx: etx ?? undefined,
            wegaz: addresses.wegaz,
            factory: addresses.factory,
          });
          const blocked = !argSpec.ready;
          const busy = state.status === 'signing' || state.status === 'pending';
          return (
            <div key={step.key} className="rounded-xl border border-white/10 bg-white/5 p-5">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h3 className="font-semibold">{step.label}</h3>
                  <p className="mt-1 text-sm text-white/60">{step.description}</p>
                </div>
                <button
                  onClick={() => runStep(step)}
                  disabled={!canRun || blocked || busy || state.status === 'confirmed'}
                  className="shrink-0 rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-black hover:bg-emerald-400 disabled:opacity-40"
                >
                  {state.status === 'confirmed'
                    ? 'Deployed'
                    : state.status === 'signing'
                      ? 'Confirm in wallet…'
                      : state.status === 'pending'
                        ? 'Mining…'
                        : blocked && argSpec.ready === false
                          ? `Needs ${argSpec.missing}`
                          : 'Deploy'}
                </button>
              </div>
              {state.txHash && (
                <div className="mt-3 text-xs">
                  <span className="text-white/50">tx:</span>{' '}
                  <a
                    className="font-mono text-emerald-400 hover:underline"
                    href={`https://eticascan.org/tx/${state.txHash}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {state.txHash}
                  </a>
                </div>
              )}
              {state.address && (
                <div className="mt-1 text-xs">
                  <span className="text-white/50">address:</span>{' '}
                  <a
                    className="font-mono text-emerald-400 hover:underline"
                    href={`https://eticascan.org/address/${state.address}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {state.address}
                  </a>
                </div>
              )}
              {state.error && (
                <div className="mt-3 rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-300">
                  {state.error}
                </div>
              )}
            </div>
          );
        })}
      </section>

      {allConfirmed && (
        <section className="rounded-xl border border-emerald-500/40 bg-emerald-500/5 p-5">
          <h2 className="mb-3 text-lg font-semibold text-emerald-300">All deployed</h2>
          <p className="mb-3 text-sm text-white/70">
            Copy this block and paste it back into the chat — I&apos;ll wire the addresses into{' '}
            <span className="font-mono">packages/shared/src/addresses.ts</span> and open a PR.
          </p>
          <pre className="overflow-x-auto rounded bg-black/60 p-3 text-xs">
            {`chainId: 61803 (Etica Mainnet)
wrappedEgaz: ${addresses.wegaz}
factory:     ${addresses.factory}
router:      ${addresses.router}
treasury/feeToSetter: ${treasury}`}
          </pre>
        </section>
      )}
    </div>
  );
}
